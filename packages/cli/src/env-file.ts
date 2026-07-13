import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Minimal .env read/merge/write that preserves comments and ordering. */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

export function upsertEnvFile(file: string, updates: Record<string, string>): void {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const remaining = { ...updates };
  const next = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && m[1]! in remaining) {
      const v = remaining[m[1]!]!;
      delete remaining[m[1]!];
      return `${m[1]}=${v}`;
    }
    return line;
  });
  while (next.length > 0 && next[next.length - 1] === "") next.pop();
  for (const [k, v] of Object.entries(remaining)) next.push(`${k}=${v}`);
  writeFileSync(file, next.join("\n") + "\n", { mode: 0o600 });
}

export function removeEnvKeys(file: string, keys: string[]): void {
  if (!existsSync(file)) return;
  const drop = new Set(keys);
  const next = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      return !(m && drop.has(m[1]!));
    });
  writeFileSync(file, next.join("\n"), { mode: 0o600 });
}
