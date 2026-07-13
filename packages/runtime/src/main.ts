import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
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
import { connectMcpServers } from "./mcp.js";
import { PendingStore } from "./pending.js";

function extractText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any;
    if (m?.role === "assistant") {
      return (m.content ?? [])
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
    }
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

  const mcp = config.mcpServers.length ? await connectMcpServers(config.mcpServers, env.dataDir) : undefined;

  const tools = [...builtinTools, ...(mcp?.tools ?? []), ...(await loadTools(env.agentDir, config.tools))];
  const store = new SessionStore(join(env.dataDir, "sessions"));
  await store.init();
  const queue = new SessionQueue();
  const pending = new PendingStore(join(env.dataDir, "pending"));
  const tracer = createTracer(config.name, config.model);

  const systemPrompt = () => {
    let p = config.systemPrompt;
    if (features.has("memory")) p += memoryPromptSection(env.dataDir);
    if (features.has("cron")) p += CRON_PROMPT_SECTION;
    if (features.has("workspace")) p += WORKSPACE_PROMPT_SECTION;
    if (features.has("code")) p += CODE_PROMPT_SECTION;
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
      });

      const finish = tracer.traceTurn(agent, {
        sessionKey: opts.sessionKey,
        userId: opts.userId,
        channel: opts.channel,
        input: opts.input,
        trigger: opts.trigger,
      });

      try {
        const reply = await turnContext.run(
          { channel: opts.channel, userId: opts.userId, threadTs: opts.threadTs, trigger: opts.trigger },
          async () => {
            await agent.prompt(opts.input);
            return extractText(agent.state.messages as unknown[]);
          },
        );
        if (!opts.freshSession) await store.save(opts.sessionKey, agent.state.messages);
        await finish(reply);
        return reply;
      } catch (err) {
        await finish(`error: ${err}`);
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
