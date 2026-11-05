import { join } from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { loadAgentConfig, loadRuntimeEnv } from "./config.js";
import { SessionQueue, SessionStore } from "./sessions.js";
import { createTracer } from "./tracing.js";
import { loadTools } from "./tools.js";
import { startSlack } from "./slack.js";
import { turnContext } from "./turn-context.js";
import { CronStore, createCronTools, startCronScheduler, CRON_TZ } from "./builtins/cron.js";
import { createMemoryTools, memoryPromptSection } from "./builtins/memory.js";
import { createWorkspaceTools } from "./builtins/workspace.js";
import { createCodeTools } from "./builtins/code.js";
import { createSlackFileTools } from "./builtins/slack-files.js";
import { createPdfTools } from "./builtins/pdf.js";
import { createSlackMessageTools } from "./builtins/slack-message.js";
import { connectMcpServers } from "./mcp.js";
import { PendingStore } from "./pending.js";
import {
  addBedrockCachePoints,
  createPriorTurnTrimmer,
  createToolOutputCap,
  fmtStats,
  watchTurnUsage,
} from "./guards.js";

/** Last non-empty assistant text — skips assistant messages with no text blocks
 * (thinking-only after max_tokens, error messages, pure tool-call messages). */
function extractText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any;
    if (m?.role !== "assistant") continue;
    const text = (m.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}

const CRON_PROMPT_SECTION = `

## Scheduled jobs (cron)
You can schedule recurring autonomous runs of yourself with cron_add / cron_list /
cron_update / cron_remove. Schedules are 5-field cron expressions in ${CRON_TZ}.
When a job fires you run with its prompt in a fresh conversation (all tools work)
and your reply is posted to the job's Slack channel — you must be a member of it.
When YOU are in a scheduled run and there is nothing worth posting (e.g. an alert
job with no news), reply with exactly NO_POST.`;

const WORKSPACE_PROMPT_SECTION = `

## Workspace
You have a persistent file workspace (workspace_write/read/list/delete) that
survives restarts — use it for reports, extracts, and notes you build over time.`;

const PROGRESS_PROMPT_SECTION = `

## Talking while you work
\`slack_message\` posts to this conversation immediately while you keep working.
For anything that will take more than a minute or two or many tool calls, post a
one-line plan when you start, short updates at real milestones (a big pull done,
a file built), and early partial results when useful. Don't narrate every tool
call, and don't repeat your final answer — that still goes in your normal reply.
In scheduled (cron) runs, don't post progress.
People can message you while you work: their new messages appear in the
conversation marked "[New message from … while you were working]". Read them and
adjust — if they ask you to stop or wrap up, finish quickly with what you have.
They can also say "stop" to end the request immediately.`;

const CODE_PROMPT_SECTION = `

## Code sandbox
You can run bash and python (pandas/numpy/matplotlib preinstalled; \`pip install\`
more via bash) in a persistent /data/workspace sandbox. The sandbox has NO
secrets or cloud credentials — pull data with your data tools, save it to the
workspace, then analyze/plot it in code. Save charts/CSVs to the workspace and
deliver them with slack_upload.`;

async function main() {
  const env = loadRuntimeEnv();
  const config = await loadAgentConfig(env.agentDir);
  const features = new Set(config.features);

  const [providerRaw, ...idParts] = config.model.split("/");
  const model = getModel((providerRaw ?? "") as any, idParts.join("/"));
  if (!model) throw new Error(`Unknown model '${config.model}'`);

  const builtinTools: AgentTool[] = [];
  let cronStore: CronStore | undefined;
  if (features.has("cron")) {
    cronStore = new CronStore(join(env.dataDir, "cron", "jobs.json"));
    builtinTools.push(...createCronTools(cronStore));
  }
  if (features.has("memory")) builtinTools.push(...createMemoryTools(env.dataDir));
  if (features.has("workspace")) builtinTools.push(...createWorkspaceTools(env.dataDir));
  if (features.has("code")) builtinTools.push(...createCodeTools(env.dataDir));
  if (features.has("slack-files")) builtinTools.push(...createSlackFileTools(env.dataDir));
  if (features.has("pdf")) builtinTools.push(...createPdfTools(env.dataDir));
  // Always on: lets the model post progress/partial results mid-turn.
  builtinTools.push(...createSlackMessageTools());

  const mcp = config.mcpServers.length ? await connectMcpServers(config.mcpServers, env.dataDir) : undefined;

  const tools = [...builtinTools, ...(mcp?.tools ?? []), ...(await loadTools(env.agentDir, config.tools))];
  const store = new SessionStore(join(env.dataDir, "sessions"));
  await store.init();
  const queue = new SessionQueue();
  const pending = new PendingStore(join(env.dataDir, "pending"));
  const tracer = createTracer(config.name, config.model);
  const capToolOutput = createToolOutputCap(env.dataDir);

  const systemPrompt = () => {
    let p = config.systemPrompt;
    if (features.has("memory")) p += memoryPromptSection(env.dataDir);
    if (features.has("cron")) p += CRON_PROMPT_SECTION;
    if (features.has("workspace")) p += WORKSPACE_PROMPT_SECTION;
    if (features.has("code")) p += CODE_PROMPT_SECTION;
    p += PROGRESS_PROMPT_SECTION;
    return p;
  };

  console.log(
    `[runtime] agent '${config.name}' model=${config.model} features=[${[...features].join(", ")}] tools=[${tools.map((t) => t.name).join(", ")}]`,
  );

  interface TurnOptions {
    sessionKey: string;
    input: string;
    userId: string;
    channel: string;
    threadTs?: string;
    trigger?: string;
    freshSession?: boolean;
  }

  // Turns currently running, by session — so a message arriving mid-turn in
  // the same thread can stop it or be injected into it (see slack.ts).
  interface ActiveTurn {
    agent: Agent;
    injected: AgentMessage[];
    stoppedBy?: string;
  }
  const active = new Map<string, ActiveTurn>();
  const STOP_RE = /^\s*(please\s+)?(stop|cancel|abort|halt)(\s+(it|now|this|that))?\s*[.!]*\s*$/i;

  const interrupt = (sessionKey: string, text: string, userId: string) => {
    const isStop = STOP_RE.test(text);
    const turn = active.get(sessionKey);
    if (!turn) return isStop ? ("idle-stop" as const) : undefined;
    if (isStop) {
      turn.stoppedBy = userId;
      turn.agent.clearAllQueues();
      turn.agent.abort();
      console.log(`[turn] ${sessionKey} stop requested by ${userId}`);
      return "stopped" as const;
    }
    const msg = {
      role: "user",
      content: [{ type: "text", text: `[New message from <@${userId}> while you were working]\n${text}` }],
      timestamp: Date.now(),
    } as AgentMessage;
    turn.injected.push(msg);
    turn.agent.steer(msg);
    console.log(`[turn] ${sessionKey} message from ${userId} injected into running turn`);
    return "injected" as const;
  };

  // Track in-flight turns so a graceful shutdown can drain them.
  const inflight = new Set<Promise<string>>();

  const runTurn = (opts: TurnOptions): Promise<string> => {
    const p = runTurnInner(opts);
    inflight.add(p);
    void p.catch(() => {}).finally(() => inflight.delete(p));
    return p;
  };

  const runTurnInner = (opts: TurnOptions): Promise<string> =>
    queue.run(opts.sessionKey, async () => {
      const messages = opts.freshSession ? [] : await store.load(opts.sessionKey);
      const agent = new Agent({
        initialState: {
          systemPrompt: systemPrompt(),
          model,
          tools,
          messages: messages as any,
        },
        // Cost guards — see guards.ts.
        onPayload: (payload, m) => addBedrockCachePoints(payload, m as any),
        transformContext: createPriorTurnTrimmer(messages.length),
        afterToolCall: (ctx) => capToolOutput(ctx as any),
        // Deliver every message that arrived mid-turn at the next step, not one per step.
        steeringMode: "all",
      });
      const turn: ActiveTurn = { agent, injected: [] };
      if (!opts.freshSession) active.set(opts.sessionKey, turn);

      const finish = tracer.traceTurn(agent, {
        sessionKey: opts.sessionKey,
        userId: opts.userId,
        channel: opts.channel,
        input: opts.input,
        trigger: opts.trigger,
      });
      const usage = watchTurnUsage(agent);

      const startedAt = Date.now();
      try {
        const reply = await turnContext.run(
          { channel: opts.channel, userId: opts.userId, threadTs: opts.threadTs, trigger: opts.trigger },
          async () => {
            const before = agent.state.messages.length;
            await agent.prompt(opts.input);
            // A message that arrived after the model's last step was never picked
            // up — answer it now, still inside this turn and reply.
            const handled = new Set<AgentMessage>();
            for (;;) {
              if (turn.stoppedBy) break;
              const missed = turn.injected.filter((m) => !handled.has(m) && !agent.state.messages.includes(m));
              if (missed.length === 0) break;
              missed.forEach((m) => handled.add(m));
              agent.clearSteeringQueue();
              await agent.prompt(missed);
            }
            // Synchronous with the last check above, so nothing can slip in between.
            if (active.get(opts.sessionKey) === turn) active.delete(opts.sessionKey);

            // Only this turn's messages — never fall back to a previous turn's reply.
            const turnMessages = agent.state.messages.slice(before) as any[];
            const last = [...turnMessages].reverse().find((m) => m?.role === "assistant");
            if (turn.stoppedBy) {
              // Close the turn with a normal assistant message so the saved
              // thread stays well-formed and the model knows it was cut short.
              if (last) {
                const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
                agent.state.messages = [
                  ...agent.state.messages,
                  {
                    ...last,
                    content: [{ type: "text", text: `[Stopped by <@${turn.stoppedBy}> before finishing. Continue only if asked.]` }],
                    stopReason: "stop",
                    errorMessage: undefined,
                    usage: zero,
                    timestamp: Date.now(),
                  } as AgentMessage,
                ];
              }
              console.log(`[turn] ${opts.sessionKey} STOPPED by ${turn.stoppedBy} in ${Date.now() - startedAt}ms ${fmtStats(usage.stats)}`);
              return `:octagonal_sign: Stopped — <@${turn.stoppedBy}> asked me to stop. Say "continue" if you want me to pick it back up.`;
            }
            // pi does NOT throw on LLM failure: it appends an assistant message
            // with stopReason "error"/"aborted" + errorMessage and resolves.
            // Surface that as a real error instead of an empty "(no reply)".
            if (last?.stopReason === "error" || last?.stopReason === "aborted") {
              throw new Error(last.errorMessage || `model run ended with stopReason=${last.stopReason}`);
            }
            let text = extractText(turnMessages);
            if (!text) {
              text = `:warning: I completed the request but produced no reply text (stop reason: ${last?.stopReason ?? "unknown"}). Please ask again.`;
            }
            console.log(
              `[turn] ${opts.sessionKey} ok in ${Date.now() - startedAt}ms stop=${last?.stopReason ?? "?"} reply=${text.length}ch msgs=+${turnMessages.length} ${fmtStats(usage.stats)}`,
            );
            return text;
          },
        );
        usage.stop();
        if (!opts.freshSession) await store.save(opts.sessionKey, agent.state.messages);
        await finish(reply, { stats: usage.stats });
        return reply;
      } catch (err) {
        if (active.get(opts.sessionKey) === turn) active.delete(opts.sessionKey);
        usage.stop();
        console.error(`[turn] ${opts.sessionKey} FAILED in ${Date.now() - startedAt}ms ${fmtStats(usage.stats)}:`, err);
        await finish(`error: ${err}`, { stats: usage.stats });
        throw err;
      }
    });

  const slack = await startSlack(
    config,
    { botToken: env.slackBotToken, appToken: env.slackAppToken },
    (msg) =>
      runTurn({
        sessionKey: msg.sessionKey,
        input: msg.text,
        userId: msg.userId,
        channel: msg.channel,
        threadTs: msg.threadTs,
      }),
    pending,
    interrupt,
    (key) => active.has(key) || store.has(key),
  );

  // Resume turns interrupted by a previous pod's death: re-run each recorded
  // request and update its stranded "thinking…" placeholder in place.
  const resumePending = async () => {
    const items = pending.list();
    if (items.length === 0) return;
    console.log(`[resume] ${items.length} interrupted turn(s) to re-run`);
    for (const rec of items) {
      const attempts = rec.attempts ?? 0;
      if (attempts >= 3) {
        await slack.app.client.chat
          .update({ channel: rec.placeholderChannel, ts: rec.placeholderTs, text: ":warning: This request was interrupted repeatedly and dropped — please re-send it." })
          .catch(() => {});
        pending.remove(rec.id);
        continue;
      }
      pending.add({ ...rec, attempts: attempts + 1 }); // persist the attempt before trying
      try {
        const reply = await runTurn({
          sessionKey: rec.sessionKey,
          input: rec.input,
          userId: rec.userId,
          channel: rec.channel,
          threadTs: rec.threadTs,
        });
        await slack.app.client.chat
          .update({ channel: rec.placeholderChannel, ts: rec.placeholderTs, text: reply || "(no reply)" })
          .catch(() => {});
      } catch (err) {
        console.error(`[resume] ${rec.id} failed:`, err);
        await slack.app.client.chat
          .update({ channel: rec.placeholderChannel, ts: rec.placeholderTs, text: `:warning: agent error: ${err}` })
          .catch(() => {});
      }
      pending.remove(rec.id);
    }
  };
  void resumePending();

  let stopScheduler: (() => void) | undefined;
  if (cronStore) {
    stopScheduler = startCronScheduler({
      store: cronStore,
      fire: async (job) => {
        console.log(`[cron] firing job ${job.id} (${job.schedule})`);
        const reply = await runTurn({
          sessionKey: `cron-${job.id}`,
          input: job.prompt,
          userId: "cron",
          channel: job.channel,
          trigger: "cron",
          freshSession: true,
        });
        if (reply.trim() === "NO_POST") {
          console.log(`[cron] job ${job.id}: NO_POST — skipping`);
          return;
        }
        await slack.app.client.chat.postMessage({ channel: job.channel, text: reply || "(scheduled run produced no output)" });
      },
    });
    console.log(`[cron] scheduler running (tz=${CRON_TZ}, ${cronStore.list().length} job(s))`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopScheduler?.();
    // Graceful drain: let in-flight turns finish (updating their placeholders)
    // before exiting, bounded by DRAIN_MS (< the pod's termination grace period).
    // Anything still running when we exit is covered by the pending-turn resume.
    const drainMs = Number(process.env.DRAIN_MS ?? 45_000);
    console.log(`[runtime] ${signal} — draining ${inflight.size} in-flight turn(s) (up to ${drainMs / 1000}s)`);
    await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise((r) => setTimeout(r, drainMs)),
    ]);
    await mcp?.close().catch(() => {});
    await slack.stop().catch(() => {});
    await tracer.shutdown().catch(() => {});
    console.log("[runtime] shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[runtime] fatal:", err);
  process.exit(1);
});
