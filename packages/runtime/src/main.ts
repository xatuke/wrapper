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

  const tools = [...builtinTools, ...(await loadTools(env.agentDir, config.tools))];
  const store = new SessionStore(join(env.dataDir, "sessions"));
  await store.init();
  const queue = new SessionQueue();
  const tracer = createTracer(config.name, config.model);

  const systemPrompt = () => {
    let p = config.systemPrompt;
    if (features.has("memory")) p += memoryPromptSection(env.dataDir);
    if (features.has("cron")) p += CRON_PROMPT_SECTION;
    if (features.has("workspace")) p += WORKSPACE_PROMPT_SECTION;
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
    trigger?: string;
    freshSession?: boolean;
  }

  const runTurn = (opts: TurnOptions): Promise<string> =>
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
          { channel: opts.channel, userId: opts.userId, trigger: opts.trigger },
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
      }),
  );

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

  const shutdown = async (signal: string) => {
    console.log(`[runtime] ${signal} — shutting down`);
    stopScheduler?.();
    await slack.stop().catch(() => {});
    await tracer.shutdown().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[runtime] fatal:", err);
  process.exit(1);
});
