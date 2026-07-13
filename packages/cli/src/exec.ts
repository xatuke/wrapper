import { spawnSync, spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; allowFail?: boolean; input?: string } = {},
): RunResult {
  const res = spawnSync(cmd, args, { cwd: opts.cwd, encoding: "utf8", input: opts.input });
  if (res.error) throw res.error;
  const result = { code: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  if (result.code !== 0 && !opts.allowFail) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (exit ${result.code}):\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

/** Run inheriting stdio (for docker compose logs -f etc.). */
export function runInteractive(cmd: string, args: string[], cwd?: string): Promise<number> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, stdio: "inherit" });
    child.on("exit", (code) => resolvePromise(code ?? 1));
  });
}
