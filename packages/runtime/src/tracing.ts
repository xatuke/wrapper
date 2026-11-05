import { randomBytes } from "node:crypto";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";

/**
 * Langfuse tracing over OpenTelemetry (OTLP/HTTP JSON → /api/public/otel/v1/traces).
 *
 * Our Langfuse runs v4 with LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only, which
 * rejects the legacy /api/public/ingestion events the `langfuse` v3 SDK sends
 * (every flush got a 207 "Event type not accepted"), so nothing was recorded
 * after 2026-09-08. This exporter needs no extra dependencies.
 *
 * Trace layout: one root span per agent turn, one `generation` per model call
 * (usage + cost), one `tool` observation per tool execution.
 */

export interface TurnMeta {
  sessionKey: string;
  userId: string;
  channel: string;
  input: string;
  trigger?: string; // slack (default) | cron
}

export interface Tracer {
  /** Attach to an agent for one turn; returns a detach+flush function. */
  traceTurn(agent: Agent, meta: TurnMeta): (finalOutput: string, extra?: Record<string, unknown>) => Promise<void>;
  shutdown(): Promise<void>;
}

const nullTracer: Tracer = {
  traceTurn: () => async () => {},
  shutdown: async () => {},
};

const MAX_FIELD = Number(process.env.LANGFUSE_MAX_FIELD_CHARS ?? 8_000);
const SPANS_PER_REQUEST = 50;

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } | { arrayValue: { values: OtlpValue[] } };
type Attr = { key: string; value: OtlpValue };
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attr[];
  status: { code: number; message?: string };
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`;
const clip = (s: string) => (s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…[+${s.length - MAX_FIELD} chars]` : s);
const json = (v: unknown) => {
  try {
    return clip(typeof v === "string" ? v : JSON.stringify(v));
  } catch {
    return "[unserializable]";
  }
};
const str = (key: string, v: unknown): Attr => ({ key, value: { stringValue: String(v ?? "") } });
const int = (key: string, v: number): Attr => ({ key, value: { intValue: String(Math.round(v || 0)) } });
const strs = (key: string, vs: string[]): Attr => ({ key, value: { arrayValue: { values: vs.map((v) => ({ stringValue: v })) } } });

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

/** Drop image payloads and thinking signatures before recording messages. */
function slim(messages: unknown[]): unknown[] {
  return messages.map((m: any) => {
    if (!Array.isArray(m?.content)) return m;
    return {
      role: m.role,
      ...(m.toolName ? { toolName: m.toolName } : {}),
      content: m.content.map((b: any) =>
        b?.type === "image" ? { type: "image", omitted: true }
          : b?.type === "thinking" ? { type: "thinking", text: b.thinking ?? b.text }
          : b,
      ),
    };
  });
}

export function createTracer(agentName: string, modelStr: string): Tracer {
  const pk = process.env.LANGFUSE_PUBLIC_KEY;
  const sk = process.env.LANGFUSE_SECRET_KEY;
  const base = (process.env.LANGFUSE_BASEURL ?? process.env.LANGFUSE_BASE_URL ?? process.env.LANGFUSE_HOST ?? "").replace(/\/+$/, "");
  if (!pk || !sk || !base) {
    console.warn("[tracing] LANGFUSE_PUBLIC_KEY/SECRET_KEY/BASEURL not set — tracing disabled");
    return nullTracer;
  }
  const endpoint = `${base}/api/public/otel/v1/traces`;
  const auth = `Basic ${Buffer.from(`${pk}:${sk}`).toString("base64")}`;
  const inflight = new Set<Promise<void>>();

  async function post(spans: Span[]): Promise<void> {
    for (let i = 0; i < spans.length; i += SPANS_PER_REQUEST) {
      const body = {
        resourceSpans: [{
          resource: { attributes: [str("service.name", `wrapper-agent-${agentName}`)] },
          scopeSpans: [{ scope: { name: "wrapper-runtime", version: "0.2.0" }, spans: spans.slice(i, i + SPANS_PER_REQUEST) }],
        }],
      };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
    }
  }

  return {
    traceTurn(agent, meta) {
      const traceId = hex(16);
      const rootId = hex(8);
      const startedAt = Date.now();
      const spans: Span[] = [];
      const tools = new Map<string, { id: string; start: number; name: string; args: unknown }>();
      let callStart = startedAt;
      let seen = agent.state.messages.length; // messages already sent in earlier calls
      let calls = 0;
      // Langfuse v4 stores trace-level fields per observation, so stamp them on
      // every span — otherwise generations can't be filtered by session/user/agent.
      const tags = [agentName, `trigger:${meta.trigger ?? "slack"}`];
      const common: Attr[] = [
        str("langfuse.trace.name", `${agentName}:turn`),
        str("langfuse.session.id", meta.sessionKey),
        str("session.id", meta.sessionKey),
        str("langfuse.user.id", meta.userId),
        str("user.id", meta.userId),
        strs("langfuse.trace.tags", tags),
      ];

      const unsubscribe = agent.subscribe((event: AgentEvent) => {
        switch (event.type) {
          case "turn_start":
            callStart = Date.now();
            break;
          case "message_end": {
            const msg = event.message as any;
            if (msg?.role !== "assistant") break;
            const all = agent.state.messages as unknown[];
            // Only the messages that are new since the previous model call — the
            // full context is reconstructable and was megabytes per call.
            const end = all.lastIndexOf(msg) >= 0 ? all.lastIndexOf(msg) : all.length;
            const newInput = all.slice(seen, end);
            seen = end + 1;
            calls += 1;
            const u = msg.usage ?? {};
            const c = u.cost ?? {};
            spans.push({
              traceId, spanId: hex(8), parentSpanId: rootId, name: `llm #${calls}`, kind: 3,
              startTimeUnixNano: nanos(callStart), endTimeUnixNano: nanos(Date.now()),
              attributes: [
                ...common,
                str("langfuse.observation.type", "generation"),
                str("langfuse.observation.model.name", msg.model ?? modelStr),
                str("gen_ai.request.model", msg.model ?? modelStr),
                str("langfuse.observation.input", json(slim(newInput))),
                str("langfuse.observation.output", json(slim([msg])[0])),
                str("langfuse.observation.usage_details", JSON.stringify({
                  input: u.input ?? 0, output: u.output ?? 0,
                  cache_read_input_tokens: u.cacheRead ?? 0, cache_creation_input_tokens: u.cacheWrite ?? 0,
                })),
                str("langfuse.observation.cost_details", JSON.stringify({
                  input: c.input ?? 0, output: c.output ?? 0, cache_read: c.cacheRead ?? 0, cache_write: c.cacheWrite ?? 0, total: c.total ?? 0,
                })),
                str("langfuse.observation.metadata.stop_reason", msg.stopReason ?? ""),
                str("langfuse.observation.metadata.context_messages", String(end)),
                ...(msg.stopReason === "error" ? [str("langfuse.observation.level", "ERROR"), str("langfuse.observation.status_message", msg.errorMessage ?? "")] : []),
              ],
              status: { code: msg.stopReason === "error" ? 2 : 0 },
            });
            break;
          }
          case "tool_execution_start":
            tools.set(event.toolCallId, { id: hex(8), start: Date.now(), name: event.toolName, args: event.args });
            break;
          case "tool_execution_end": {
            const t = tools.get(event.toolCallId);
            if (!t) break;
            tools.delete(event.toolCallId);
            const out = contentToText((event.result as any)?.content);
            spans.push({
              traceId, spanId: t.id, parentSpanId: rootId, name: `tool:${t.name}`, kind: 1,
              startTimeUnixNano: nanos(t.start), endTimeUnixNano: nanos(Date.now()),
              attributes: [
                ...common,
                str("langfuse.observation.type", "tool"),
                str("langfuse.observation.input", json(t.args)),
                str("langfuse.observation.output", clip(out)),
                int("langfuse.observation.metadata.output_chars", out.length),
                ...(event.isError ? [str("langfuse.observation.level", "ERROR")] : []),
              ],
              status: { code: event.isError ? 2 : 0 },
            });
            break;
          }
        }
      });

      return async (finalOutput: string, extra?: Record<string, unknown>) => {
        unsubscribe();
        spans.push({
          traceId, spanId: rootId, name: `${agentName}:turn`, kind: 1,
          startTimeUnixNano: nanos(startedAt), endTimeUnixNano: nanos(Date.now()),
          attributes: [
            ...common,
            str("langfuse.trace.input", clip(meta.input)),
            str("langfuse.trace.output", clip(finalOutput)),
            str("langfuse.observation.input", clip(meta.input)),
            str("langfuse.observation.output", clip(finalOutput)),
            str("langfuse.trace.metadata.channel", meta.channel),
            str("langfuse.trace.metadata.model", modelStr),
            str("langfuse.trace.metadata.trigger", meta.trigger ?? "slack"),
            ...Object.entries(extra ?? {}).map(([k, v]) => str(`langfuse.trace.metadata.${k}`, typeof v === "string" ? v : JSON.stringify(v))),
          ],
          status: { code: finalOutput.startsWith("error:") ? 2 : 0 },
        });
        const p = post(spans).catch((err) => console.warn("[tracing] export failed:", err?.message ?? err));
        inflight.add(p);
        await p;
        inflight.delete(p);
      };
    },
    shutdown: async () => {
      await Promise.allSettled([...inflight]);
    },
  };
}
