import { setTimeout as sleep } from "node:timers/promises";

export async function waitForLangfuse(baseUrl: string, timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(baseUrl.replace(/\/$/, "") + "/api/public/health");
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Langfuse not healthy after ${timeoutMs / 1000}s`);
    await sleep(3000);
  }
}
