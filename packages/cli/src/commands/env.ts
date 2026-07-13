import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { readEnvFile, removeEnvKeys, upsertEnvFile } from "../env-file.js";
import { agentDir, findRoot } from "../root.js";

const SECRET_PATTERN = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|EDGERC|_B64)/i;

export function envSetCommand(agent: string, pairs: string[]): void {
  const root = findRoot();
  const updates: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx < 1) throw new Error(`Expected KEY=VALUE, got '${pair}'`);
    updates[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  upsertEnvFile(join(agentDir(root, agent), ".env"), updates);
  console.log(
    `Updated ${Object.keys(updates).join(", ")} — apply with: wrapper restart ${agent}`,
  );
}

/** Store a file's contents (base64) as an env var — for multi-line secrets like .edgerc. */
export function envSetFileCommand(agent: string, key: string, filePath: string): void {
  const root = findRoot();
  const expanded = filePath.startsWith("~/") ? join(homedir(), filePath.slice(2)) : filePath;
  const content = readFileSync(resolve(expanded));
  upsertEnvFile(join(agentDir(root, agent), ".env"), {
    [key]: content.toString("base64"),
  });
  console.log(
    `${key} set from ${filePath} (${content.length} bytes, base64) — apply with: wrapper restart ${agent}`,
  );
}

export function envUnsetCommand(agent: string, keys: string[]): void {
  const root = findRoot();
  removeEnvKeys(join(agentDir(root, agent), ".env"), keys);
  console.log(`Removed ${keys.join(", ")} — apply with: wrapper restart ${agent}`);
}

export function envListCommand(agent: string, opts: { show: boolean }): void {
  const root = findRoot();
  const env = readEnvFile(join(agentDir(root, agent), ".env"));
  if (Object.keys(env).length === 0) {
    console.log("(empty)");
    return;
  }
  for (const [k, v] of Object.entries(env)) {
    const display = !opts.show && SECRET_PATTERN.test(k) ? `${v.slice(0, 4)}…(${v.length} chars)` : v;
    console.log(`${k}=${display}`);
  }
}
