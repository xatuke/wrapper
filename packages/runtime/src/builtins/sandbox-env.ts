import { join } from "node:path";

/**
 * Env for the code sandbox (bash/python) and MCP server subprocesses. Secrets
 * are STRIPPED so injected code/content can't read the agent's DB creds, Google
 * service-account key, Slack tokens, etc. AWS_* is dropped too — that denies the
 * IRSA web-identity token, so sandboxed code cannot reach Secrets Manager or
 * Bedrock. (Down-payment on moving creds behind a broker; see DESIGN.md.)
 */
const SECRET_ENV = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|EDGERC|_B64|PASS)/i;
const SECRET_PREFIX = /^(AWS_|CMS_|TRENDS_|LANGFUSE_|SLACK_|GOOGLE_|GEMINI_|OPENAI_|ANTHROPIC_)/i;

export function buildSandboxEnv(dataDir: string): NodeJS.ProcessEnv {
  const venvBin = join(dataDir, "venv", "bin");
  const home = join(dataDir, "code-home");
  const base: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV.test(k) || SECRET_PREFIX.test(k)) continue;
    base[k] = v;
  }
  return {
    ...base,
    HOME: home,
    PATH: `${venvBin}:${base.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
    VIRTUAL_ENV: join(dataDir, "venv"),
    MPLCONFIGDIR: "/tmp/mpl",
    PIP_CACHE_DIR: join(dataDir, ".pip-cache"),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PYTHONUNBUFFERED: "1",
  };
}
