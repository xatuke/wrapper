import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * One JSON file per Slack conversation (channel thread or DM), holding the
 * pi message transcript so conversations survive restarts.
 */
export class SessionStore {
  constructor(private dir: string) {}

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private fileFor(key: string): string {
    return join(this.dir, key.replace(/[^a-zA-Z0-9_.-]/g, "_") + ".json");
  }

  /** True if a transcript exists for this conversation. */
  has(key: string): boolean {
    return existsSync(this.fileFor(key));
  }

  async load(key: string): Promise<AgentMessage[]> {
    try {
      const raw = await readFile(this.fileFor(key), "utf8");
      return JSON.parse(raw).messages ?? [];
    } catch {
      return [];
    }
  }

  async save(key: string, messages: AgentMessage[]): Promise<void> {
    const file = this.fileFor(key);
    const tmp = file + ".tmp";
    await writeFile(tmp, JSON.stringify({ v: 1, key, messages }, null, 1));
    await rename(tmp, file);
  }
}

/** Serializes turns per session so concurrent Slack events don't interleave. */
export class SessionQueue {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const tail = this.tails.get(key) ?? Promise.resolve();
    const next = tail.then(fn, fn);
    const entry: Promise<unknown> = next
      .catch(() => {})
      .then(() => {
        if (this.tails.get(key) === entry) this.tails.delete(key);
      });
    this.tails.set(key, entry);
    return next;
  }
}
