import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { buildSandboxEnv } from "./sandbox-env.js";

const exec = promisify(execFile);
const MAX_CHARS = 40_000;
const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;

function clip(s: string): string {
  return s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) + `\n[TRUNCATED at ${MAX_CHARS} of ${s.length} chars]` : s;
}

/**
 * bash + python code execution in a persistent sandbox on /data. A venv
 * (--system-site-packages, so the image's pandas/numpy/matplotlib are visible)
 * is created lazily; `pip install` at runtime adds packages into it and they
 * survive restarts. The sandbox env has NO secrets (see sandbox-env.ts).
 */
export function createCodeTools(dataDir: string): AgentTool[] {
  const workdir = join(dataDir, "workspace");
  const venvDir = join(dataDir, "venv");
  const venvPython = join(venvDir, "bin", "python");
  let venvReady = false;

  async function ensureSandbox(): Promise<void> {
    mkdirSync(workdir, { recursive: true });
    mkdirSync(join(dataDir, "code-home"), { recursive: true });
    mkdirSync("/tmp/mpl", { recursive: true });
    if (venvReady || existsSync(venvPython)) {
      venvReady = true;
      return;
    }
    await exec("python3", ["-m", "venv", "--system-site-packages", venvDir], {
      env: buildSandboxEnv(dataDir),
      timeout: 120_000,
    });
    venvReady = true;
  }

  function timeout(sec?: number): number {
    if (!sec) return DEFAULT_TIMEOUT_MS;
    return Math.min(Math.max(sec, 1) * 1000, MAX_TIMEOUT_MS);
  }

  async function runResult(fn: () => Promise<{ stdout: string; stderr: string }>) {
    try {
      const { stdout, stderr } = await fn();
      const text = clip([stdout, stderr && `[stderr]\n${stderr}`].filter(Boolean).join("\n").trim() || "(no output)");
      return { content: [{ type: "text" as const, text }], details: undefined };
    } catch (err: any) {
      if (err?.killed && err?.signal === "SIGTERM") {
        return { content: [{ type: "text" as const, text: `Timed out.\n${clip([err.stdout, err.stderr].filter(Boolean).join("\n"))}` }], details: undefined };
      }
      const text = clip([err?.stdout, err?.stderr].filter(Boolean).join("\n").trim() || err?.message || "failed");
      return { content: [{ type: "text" as const, text: `exit ${err?.code ?? "?"}:\n${text}` }], details: undefined };
    }
  }

  const bash: AgentTool = {
    name: "bash",
    label: "Run bash",
    description:
      "Run a bash command in your persistent sandbox (cwd is your workspace, /data/workspace). " +
      "Use it to install packages (`pip install <pkg>` — a persistent venv is on your PATH), run " +
      "CLI tools, and manipulate files you've written. The sandbox has NO access to secrets or " +
      "cloud credentials by design — pull data with your data tools, save it to the workspace, " +
      "then process it here. Network egress is available (for pip etc.).",
    parameters: Type.Object({
      command: Type.String({ description: "bash command (run via bash -lc)" }),
      timeout_sec: Type.Optional(Type.Number({ description: "timeout in seconds (default 180, max 600)" })),
    }),
    async execute(_id, params: any) {
      await ensureSandbox();
      return runResult(() =>
        exec("bash", ["-lc", params.command], {
          cwd: workdir,
          env: buildSandboxEnv(dataDir),
          timeout: timeout(params.timeout_sec),
          maxBuffer: 16 * 1024 * 1024,
        }),
      );
    },
  };

  const python: AgentTool = {
    name: "python",
    label: "Run Python",
    description:
      "Run Python code in your persistent sandbox (pandas, numpy, matplotlib preinstalled; " +
      "`pip install` more via the bash tool). cwd is your workspace (/data/workspace) — save " +
      "charts/CSVs there with relative paths, then send them with slack_upload. The sandbox has " +
      "NO secrets/credentials; load data from files you saved, not from live connections here. " +
      "For matplotlib use a non-interactive backend (Agg) and savefig to a file.",
    parameters: Type.Object({
      code: Type.String({ description: "Python source to execute" }),
      timeout_sec: Type.Optional(Type.Number({ description: "timeout in seconds (default 180, max 600)" })),
    }),
    async execute(_id, params: any) {
      await ensureSandbox();
      const file = join(workdir, `.run-${Date.now()}.py`);
      writeFileSync(file, params.code);
      return runResult(() =>
        exec(venvPython, [file], {
          cwd: workdir,
          env: buildSandboxEnv(dataDir),
          timeout: timeout(params.timeout_sec),
          maxBuffer: 16 * 1024 * 1024,
        }),
      );
    },
  };

  return [bash, python];
}
