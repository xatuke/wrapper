import { Langfuse } from "langfuse";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";

export interface TurnMeta {
  sessionKey: string;
  userId: string;
  channel: string;
  input: string;
  trigger?: string; // slack (default) | cron
}

export interface Tracer {
  /** Attach to an agent for one turn; returns a detach+flush function. */
  traceTurn(agent: Agent, meta: TurnMeta): (finalOutput: string) => Promise<void>;
  shutdown(): Promise<void>;
}

/** No-op tracer used when Langfuse env vars are absent. */
const nullTracer: Tracer = {
  traceTurn: () => async () => {},
  shutdown: async () => {},
};

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .filter((b: any) => b?.type === "text")
    .map((b: any) => b.text)
    .join("\n");
}

export function createTracer(agentName: string, modelStr: string): Tracer {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
    console.warn("[tracing] LANGFUSE_PUBLIC_KEY/SECRET_KEY not set — tracing disabled");
    return nullTracer;
  }
  // baseUrl comes from LANGFUSE_BASEURL
  const langfuse = new Langfuse();

  return {
    traceTurn(agent, meta) {
      const trace = langfuse.trace({
        name: `${agentName}:turn`,
        sessionId: meta.sessionKey,
        userId: meta.userId,
        input: meta.input,
        tags: [agentName, ...(meta.trigger ? [`trigger:${meta.trigger}`] : [])],
        metadata: { channel: meta.channel, model: modelStr, trigger: meta.trigger ?? "slack" },
      });

      const toolSpans = new Map<string, ReturnType<typeof trace.span>>();
      let contextSnapshot: unknown[] = [];

      const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
        switch (event.type) {
          case "turn_start":
            contextSnapshot = [...(agent.state.messages as unknown[])];
            break;
          case "message_end": {
            const msg = event.message as any;
            if (msg?.role !== "assistant") break;
            const usage = msg.usage ?? {};
            const cost = usage.cost ?? {};
            trace
              .generation({
                name: "llm",
                model: msg.model ?? modelStr,
                input: contextSnapshot,
                usageDetails: {
                  input: usage.input ?? 0,
                  output: usage.output ?? 0,
                  cache_read: usage.cacheRead ?? 0,
                  cache_write: usage.cacheWrite ?? 0,
                  total: usage.totalTokens ?? 0,
                },
                costDetails: {
                  input: cost.input ?? 0,
                  output: cost.output ?? 0,
                  total: cost.total ?? 0,
                },
              })
              .end({ output: msg.content });
            break;
          }
          case "tool_execution_start":
            toolSpans.set(
              event.toolCallId,
              trace.span({ name: `tool:${event.toolName}`, input: event.args }),
            );
            break;
          case "tool_execution_end": {
            const span = toolSpans.get(event.toolCallId);
            span?.end({
              output: contentToText((event.result as any)?.content),
              level: event.isError ? "ERROR" : undefined,
            });
            toolSpans.delete(event.toolCallId);
            break;
          }
        }
      });

      return async (finalOutput: string) => {
        unsubscribe();
        trace.update({ output: finalOutput });
        await langfuse.flushAsync().catch((err) => {
          console.warn("[tracing] flush failed:", err?.message ?? err);
        });
      };
    },
    shutdown: () => langfuse.shutdownAsync(),
  };
}
