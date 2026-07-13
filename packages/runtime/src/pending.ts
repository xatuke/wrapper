import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A write-ahead record of a Slack-triggered turn that is being processed. Written
 * to the volume BEFORE the turn runs and deleted when it completes, so a pod that
 * dies mid-turn leaves the record behind — the next pod resumes it (Socket Mode
 * never redelivers the dropped event, so this is the only way to not lose it).
 */
export interface PendingTurn {
  id: string;
  sessionKey: string;
  channel: string;
  threadTs?: string;
  userId: string;
  input: string;
  placeholderChannel: string;
  placeholderTs: string;
  createdAt: string;
  attempts: number;
}

export class PendingStore {
  constructor(private dir: string) {}

  private file(id: string): string {
    return join(this.dir, id.replace(/[^a-zA-Z0-9_.-]/g, "_") + ".json");
  }

  add(t: PendingTurn): void {
    mkdirSync(this.dir, { recursive: true });
    const f = this.file(t.id);
    const tmp = f + ".tmp";
    writeFileSync(tmp, JSON.stringify(t));
    renameSync(tmp, f);
  }

  remove(id: string): void {
    try {
      rmSync(this.file(id));
    } catch {
      // already gone
    }
  }

  list(): PendingTurn[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(this.dir, f), "utf8")) as PendingTurn;
        } catch {
          return null;
        }
      })
      .filter((t): t is PendingTurn => t !== null);
  }
}
