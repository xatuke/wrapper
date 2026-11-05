/**
 * Cost guards for agent turns. Added after 2026-11-04, when one liza report
 * thread re-sent ~400K uncached input tokens per model call (~$840 in a day).
 *
 *  1. Prompt caching   — pi-ai 0.80.3 only adds Bedrock cache points for
 *                        Claude 3.x/4.x, so Claude 5.x ran fully uncached.
 *  2. Tool output cap  — big tool results are spilled to a workspace file and
 *                        only a preview enters the conversation.
 *  3. Prior-turn trim  — tool outputs / tool-call args from earlier turns of a
 *                        thread are shortened before every model call.
 *  4. Usage counter    — per-turn calls/tokens/cost for logs and traces only.
 *                        It never interrupts or steers a turn.
 *
 * All limits are env-tunable without a rebuild (see `num()` calls below).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Agent, AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";

const num = (name: string, dflt: number): number => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : dflt;
};

export const LIMITS = {
  /** Tool results longer than this (chars) are spilled to a file. ~7.5K tokens. */
  toolMaxChars: num("TOOL_OUTPUT_MAX_CHARS", 30_000),
  /** Preview kept in context when a result is spilled. */
  toolPreviewChars: num("TOOL_OUTPUT_PREVIEW_CHARS", 4_000),
  /** Tool results from earlier turns are cut to this many chars. */
  priorToolMaxChars: num("PRIOR_TOOL_OUTPUT_MAX_CHARS", 1_500),
  /** String tool-call arguments from earlier turns are cut to this many chars. */
  priorArgMaxChars: num("PRIOR_TOOL_ARG_MAX_CHARS", 1_000),
};

// ---------------------------------------------------------------- 1. caching

/**
 * `onPayload` hook for Bedrock Converse: put a cache point after the system
 * prompt (caches tools + system) and on the last user/tool-result message
 * (caches the conversation so far, so each tool-loop step only pays for the
 * newest messages). Skips anything that already has a cache point, so it is a
 * no-op once pi-ai learns about the model itself.
 */
export function addBedrockCachePoints(payload: unknown, model: { id?: string; name?: string; api?: string }): unknown {
  if (model?.api !== "bedrock-converse-stream") return undefined;
  const ref = `${model.id ?? ""} ${model.name ?? ""}`.toLowerCase();
  if (!ref.includes("claude") || process.env.PROMPT_CACHE === "off") return undefined;

  const p = payload as { system?: any[]; messages?: { role: string; content: any[] }[] };
  const hasCp = (blocks?: any[]) => Array.isArray(blocks) && blocks.some((b) => b && "cachePoint" in b);
  const cp = () => ({ cachePoint: { type: "default" } });

  if (Array.isArray(p.system) && p.system.length && !hasCp(p.system)) p.system.push(cp());
  const last = p.messages?.[p.messages.length - 1];
  if (last && last.role === "user" && Array.isArray(last.content) && !hasCp(last.content)) last.content.push(cp());
  return p;
}

// ------------------------------------------------------- 2. tool output cap

type Block = { type: string; text?: string; [k: string]: unknown };

const textOf = (content: Block[]) =>
  content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n");

/** Tools that already page their own output; spilling them would loop. */
const SPILL_EXEMPT = new Set(["workspace_read"]);

/**
 * `afterToolCall` hook: results over the cap are written to
 * <dataDir>/workspace/tool-output/… and replaced by a preview + pointer.
 */
export function createToolOutputCap(dataDir: string) {
  const dir = join(dataDir, "workspace", "tool-output");
  return async (ctx: { toolCall: { id: string; name: string }; result: { content: Block[] } }) => {
    const content = ctx.result?.content;
    if (!Array.isArray(content) || SPILL_EXEMPT.has(ctx.toolCall.name)) return undefined;
    const text = textOf(content);
    if (text.length <= LIMITS.toolMaxChars) return undefined;

    const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 40);
    const rel = `tool-output/${new Date().toISOString().replace(/[:.]/g, "-")}-${safe(ctx.toolCall.name)}-${safe(ctx.toolCall.id)}.txt`;
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dataDir, "workspace", rel), text);
    } catch (err) {
      console.warn(`[guards] could not spill ${ctx.toolCall.name} output:`, err);
      return {
        content: [
          ...content.filter((b) => b?.type !== "text"),
          { type: "text", text: `${text.slice(0, LIMITS.toolPreviewChars)}\n\n[output truncated from ${text.length} chars; it could not be saved — narrow the query]` },
        ] as any,
      };
    }
    const abs = join(dataDir, "workspace", rel);
    console.log(`[guards] spilled ${ctx.toolCall.name} output (${text.length} chars) -> ${rel}`);
    return {
      content: [
        ...content.filter((b) => b?.type !== "text"),
        {
          type: "text",
          text:
            `${text.slice(0, LIMITS.toolPreviewChars)}\n\n` +
            `[TRUNCATED — full output is ${text.length.toLocaleString()} chars. Saved to workspace file ` +
            `\`${rel}\` (sandbox path \`${abs}\`). Process it with python in the code sandbox, or page ` +
            `it with workspace_read offsets. Do NOT re-fetch it, and do NOT copy rows into messages ` +
            `or workspace_write — build CSV/XLSX outputs from the file in code.]`,
        },
      ] as any,
    };
  };
}

// ------------------------------------------------------ 3. prior-turn trim

const cut = (s: string, max: number, note: string) =>
  s.length <= max ? s : `${s.slice(0, max)}\n…[${note}: ${s.length - max} more chars trimmed]`;

function trimArgs(v: unknown, max: number): unknown {
  if (typeof v === "string") return cut(v, max, "earlier-turn argument");
  if (Array.isArray(v)) return v.map((x) => trimArgs(x, max));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, trimArgs(x, max)]));
  }
  return v;
}

/**
 * `transformContext` hook: messages before index `priorCount` belong to earlier
 * turns of the thread. Their tool results and tool-call arguments are shortened
 * (non-destructively — the stored session keeps the originals). Deterministic,
 * so the trimmed prefix stays cacheable for the whole turn.
 */
export function createPriorTurnTrimmer(priorCount: number) {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    if (priorCount <= 0) return messages;
    return messages.map((m: any, i) => {
      if (i >= priorCount) return m;
      if (m?.role === "toolResult" && Array.isArray(m.content)) {
        const content = m.content.map((b: Block) => {
          if (b?.type === "image") return { type: "text", text: "[image from an earlier turn omitted]" };
          if (b?.type === "text" && typeof b.text === "string") {
            return { ...b, text: cut(b.text, LIMITS.priorToolMaxChars, "earlier-turn tool output; re-run the tool if you need it") };
          }
          return b;
        });
        return { ...m, content };
      }
      if (m?.role === "assistant" && Array.isArray(m.content)) {
        const content = m.content.map((b: any) =>
          b?.type === "toolCall" ? { ...b, arguments: trimArgs(b.arguments, LIMITS.priorArgMaxChars) } : b,
        );
        return { ...m, content };
      }
      return m;
    }) as AgentMessage[];
  };
}

// --------------------------------------------------------- 4. usage counter

export interface TurnStats {
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

/** Counts model calls, tokens and cost for one turn. Observation only. */
export function watchTurnUsage(agent: Agent): { stats: TurnStats; stop: () => void } {
  const stats: TurnStats = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  const stop = agent.subscribe((event: AgentEvent) => {
    if (event.type !== "message_end") return;
    const msg = event.message as any;
    if (msg?.role !== "assistant") return;
    const u = msg.usage ?? {};
    stats.calls += 1;
    stats.input += u.input ?? 0;
    stats.output += u.output ?? 0;
    stats.cacheRead += u.cacheRead ?? 0;
    stats.cacheWrite += u.cacheWrite ?? 0;
    stats.costUsd += u.cost?.total ?? 0;
  });
  return { stats, stop };
}

export const fmtStats = (s: TurnStats) =>
  `calls=${s.calls} in=${s.input} cacheR=${s.cacheRead} cacheW=${s.cacheWrite} out=${s.output} cost=$${s.costUsd.toFixed(2)}`;
