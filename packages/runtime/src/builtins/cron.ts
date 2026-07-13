import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import parser from "cron-parser";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { turnContext } from "../turn-context.js";

export interface CronJob {
  id: string;
  schedule: string; // 5-field cron expression
  prompt: string;
  channel: string; // Slack channel/DM id the result is posted to
  description?: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: "ok" | "error";
  lastError?: string;
}

/**
 * Jobs live in one JSON file on the persistent volume. Read on every access so
 * external edits (or a second writer) are picked up; writes are atomic.
 */
export class CronStore {
  constructor(private file: string) {}

  list(): CronJob[] {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")).jobs ?? [];
    } catch {
      return [];
    }
  }

  private save(jobs: CronJob[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify({ v: 1, jobs }, null, 1));
    renameSync(tmp, this.file);
  }

  add(job: CronJob): void {
    this.save([...this.list(), job]);
  }

  remove(id: string): boolean {
    const jobs = this.list();
    const next = jobs.filter((j) => j.id !== id);
    if (next.length === jobs.length) return false;
    this.save(next);
    return true;
  }

  update(id: string, patch: Partial<CronJob>): CronJob | undefined {
    const jobs = this.list();
    const job = jobs.find((j) => j.id === id);
    if (!job) return undefined;
    Object.assign(job, patch);
    this.save(jobs);
    return job;
  }
}

export const CRON_TZ = process.env.CRON_TZ ?? "Asia/Kolkata";

function nextRuns(schedule: string, count = 2): string[] {
  const it = parser.parseExpression(schedule, { tz: CRON_TZ });
  return Array.from({ length: count }, () =>
    it.next().toDate().toLocaleString("en-IN", { timeZone: CRON_TZ, hour12: false }),
  );
}

function fmt(job: CronJob): string {
  let next = "?";
  try {
    next = nextRuns(job.schedule, 1)[0]!;
  } catch {
    // invalid schedule already stored — surface as-is
  }
  return [
    `id=${job.id} ${job.enabled ? "" : "[DISABLED] "}schedule="${job.schedule}" next=${next} channel=${job.channel}`,
    job.description ? `  desc: ${job.description}` : undefined,
    `  prompt: ${job.prompt.length > 160 ? job.prompt.slice(0, 160) + "…" : job.prompt}`,
    job.lastRunAt ? `  last run: ${job.lastRunAt} (${job.lastStatus}${job.lastError ? `: ${job.lastError.slice(0, 120)}` : ""})` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function createCronTools(store: CronStore): AgentTool[] {
  const add: AgentTool = {
    name: "cron_add",
    label: "Schedule a recurring job",
    description:
      "Schedule a recurring autonomous run of yourself. `schedule` is a 5-field cron expression " +
      `interpreted in ${CRON_TZ} (e.g. '0 9 * * *' = daily 09:00 IST, '*/30 * * * *' = every 30 min). ` +
      "When it fires you run with `prompt` (fresh conversation, all tools available) and your reply " +
      "is posted to `channel` (defaults to the channel this conversation is in; you must be a member). " +
      "In a scheduled run, reply exactly NO_POST to skip posting when there is nothing worth reporting.",
    parameters: Type.Object({
      schedule: Type.String({ description: "5-field cron expression" }),
      prompt: Type.String({ description: "the instruction you will run with when the job fires" }),
      channel: Type.Optional(Type.String({ description: "Slack channel id to post results to (default: current channel)" })),
      description: Type.Optional(Type.String({ description: "short human-readable label" })),
    }),
    async execute(_id, params: any) {
      try {
        nextRuns(params.schedule, 1);
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Invalid cron expression '${params.schedule}': ${err?.message}` }], details: undefined };
      }
      const channel = params.channel ?? turnContext.getStore()?.channel;
      if (!channel) {
        return { content: [{ type: "text" as const, text: "No channel: pass `channel` explicitly (could not infer the current one)." }], details: undefined };
      }
      const job: CronJob = {
        id: randomBytes(3).toString("hex"),
        schedule: params.schedule,
        prompt: params.prompt,
        channel,
        description: params.description,
        enabled: true,
        createdAt: new Date().toISOString(),
      };
      store.add(job);
      return {
        content: [{ type: "text" as const, text: `Scheduled ${job.id}. Next runs (${CRON_TZ}): ${nextRuns(job.schedule).join(", ")}\n${fmt(job)}` }],
        details: undefined,
      };
    },
  };

  const list: AgentTool = {
    name: "cron_list",
    label: "List scheduled jobs",
    description: "List all scheduled cron jobs with their next run time and last run status.",
    parameters: Type.Object({}),
    async execute() {
      const jobs = store.list();
      const text = jobs.length ? jobs.map(fmt).join("\n\n") : "No scheduled jobs.";
      return { content: [{ type: "text" as const, text }], details: undefined };
    },
  };

  const update: AgentTool = {
    name: "cron_update",
    label: "Update a scheduled job",
    description:
      "Update a cron job's schedule, prompt, channel, description, or enabled flag " +
      "(enabled=false pauses it without deleting).",
    parameters: Type.Object({
      id: Type.String(),
      schedule: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      channel: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params: any) {
      if (params.schedule) {
        try {
          nextRuns(params.schedule, 1);
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: `Invalid cron expression: ${err?.message}` }], details: undefined };
        }
      }
      const { id, ...patch } = params;
      const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const job = store.update(id, clean);
      return {
        content: [{ type: "text" as const, text: job ? `Updated.\n${fmt(job)}` : `No job with id ${id}.` }],
        details: undefined,
      };
    },
  };

  const remove: AgentTool = {
    name: "cron_remove",
    label: "Remove a scheduled job",
    description: "Delete a cron job by id (see cron_list).",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params: any) {
      const ok = store.remove(params.id);
      return { content: [{ type: "text" as const, text: ok ? `Removed ${params.id}.` : `No job with id ${params.id}.` }], details: undefined };
    },
  };

  return [add, list, update, remove];
}

export interface SchedulerOptions {
  store: CronStore;
  fire: (job: CronJob) => Promise<void>;
  intervalMs?: number;
}

/**
 * Minute-resolution scheduler. Occurrences that pass while the process is down
 * are skipped (next future occurrence runs). A job never double-fires: the
 * last-handled time advances before the (async) fire is launched, and per-job
 * turns are serialized by the session queue downstream.
 */
export function startCronScheduler(opts: SchedulerOptions): () => void {
  const lastHandled = new Map<string, number>();
  const startup = Date.now();

  const tick = () => {
    const now = Date.now();
    for (const job of opts.store.list()) {
      if (!job.enabled) continue;
      const floor = lastHandled.get(job.id) ?? Math.max(startup, Date.parse(job.createdAt) || startup);
      let next: number;
      try {
        next = parser.parseExpression(job.schedule, { tz: CRON_TZ, currentDate: new Date(floor) }).next().getTime();
      } catch {
        continue; // invalid schedule; visible via cron_list
      }
      if (next > now) continue;
      lastHandled.set(job.id, now);
      opts
        .fire(job)
        .then(() => opts.store.update(job.id, { lastRunAt: new Date().toISOString(), lastStatus: "ok", lastError: undefined }))
        .catch((err) => {
          console.error(`[cron] job ${job.id} failed:`, err);
          opts.store.update(job.id, { lastRunAt: new Date().toISOString(), lastStatus: "error", lastError: String(err?.message ?? err) });
        });
    }
  };

  const timer = setInterval(tick, opts.intervalMs ?? 20_000);
  return () => clearInterval(timer);
}
