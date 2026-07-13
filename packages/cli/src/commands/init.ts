import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateCompose } from "../compose.js";
import { upsertEnvFile, readEnvFile } from "../env-file.js";
import { run } from "../exec.js";
import { waitForLangfuse } from "../langfuse.js";
import {
  findRoot,
  loadSecrets,
  loadWrapperConfig,
  saveSecrets,
  saveWrapperConfig,
} from "../root.js";

const hex = (n: number) => randomBytes(n).toString("hex");

/** Shared provider keys live in agents/.env (the user's own repo territory);
 * a legacy root .env keeps working (per-agent > agents/.env > root). */
function ensureSharedEnvStub(root: string): void {
  if (existsSync(join(root, ".env")) || existsSync(join(root, "agents", ".env"))) return;
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(
    join(root, "agents", ".env"),
    "# Shared provider API keys for all agents (per-agent .env overrides these)\n" +
      "#ANTHROPIC_API_KEY=\n#OPENAI_API_KEY=\n#GEMINI_API_KEY=\n",
    { mode: 0o600 },
  );
}

export async function initCommand(opts: { teamId?: string; skipStack?: boolean }): Promise<void> {
  const root = findRoot();
  const config = loadWrapperConfig(root);
  const secrets = loadSecrets(root);

  if (opts.teamId) config.slackTeamId = opts.teamId;

  // Bring-your-own Langfuse: no stack to configure or start. Project keys are
  // supplied by the user (wrapper.secrets.json or env) — see docs/langfuse.md.
  if (config.langfuse.external) {
    ensureSharedEnvStub(root);
    generateCompose(root);
    saveWrapperConfig(root, config);
    saveSecrets(root, secrets);

    try {
      const res = await fetch(config.langfuse.baseUrl.replace(/\/$/, "") + "/api/public/health");
      console.log(`External Langfuse at ${config.langfuse.baseUrl}: ${res.ok ? "healthy" : `HTTP ${res.status}`}`);
    } catch {
      console.warn(`Warning: external Langfuse unreachable at ${config.langfuse.baseUrl} (agents may still reach it via containerBaseUrl)`);
    }
    if (!secrets.langfuseProjectPublicKey || !secrets.langfuseProjectSecretKey) {
      console.log(
        "\nNext: put your Langfuse project keys into wrapper.secrets.json\n" +
          '  ("langfuseProjectPublicKey": "pk-lf-...", "langfuseProjectSecretKey": "sk-lf-...")\n' +
          "so `wrapper agent add` can write them into each agent's .env — see docs/langfuse.md",
      );
    }
    return;
  }

  // 1. Langfuse stack env (idempotent: keep existing secrets).
  const lfEnvFile = join(root, "infra", "langfuse", ".env");
  const existing = readEnvFile(lfEnvFile);
  const lfEnv: Record<string, string> = {
    POSTGRES_PASSWORD: existing.POSTGRES_PASSWORD ?? hex(16),
    CLICKHOUSE_PASSWORD: existing.CLICKHOUSE_PASSWORD ?? hex(16),
    REDIS_AUTH: existing.REDIS_AUTH ?? hex(16),
    MINIO_ROOT_PASSWORD: existing.MINIO_ROOT_PASSWORD ?? hex(16),
    SALT: existing.SALT ?? hex(32),
    ENCRYPTION_KEY: existing.ENCRYPTION_KEY ?? hex(32),
    NEXTAUTH_SECRET: existing.NEXTAUTH_SECRET ?? hex(32),
    ADMIN_API_KEY: existing.ADMIN_API_KEY ?? `admin-${hex(24)}`,
    LANGFUSE_INIT_ORG_ID: existing.LANGFUSE_INIT_ORG_ID ?? config.langfuse.orgId,
    LANGFUSE_INIT_ORG_NAME: existing.LANGFUSE_INIT_ORG_NAME ?? config.langfuse.orgId,
    LANGFUSE_INIT_USER_EMAIL: existing.LANGFUSE_INIT_USER_EMAIL ?? "admin@wrapper.local",
    // no spaces: values are consumed by dotenv parsers AND shell-sourced
    LANGFUSE_INIT_USER_NAME: existing.LANGFUSE_INIT_USER_NAME ?? "wrapper-admin",
    LANGFUSE_INIT_USER_PASSWORD: existing.LANGFUSE_INIT_USER_PASSWORD ?? hex(12),
    // Shared project, headless-provisioned. Project management APIs are
    // enterprise-only on self-hosted Langfuse, so agents share this project and
    // are separated by tags/sessions (per-agent keys can be pasted manually).
    LANGFUSE_INIT_PROJECT_ID: existing.LANGFUSE_INIT_PROJECT_ID ?? "wrapper-agents",
    LANGFUSE_INIT_PROJECT_NAME: existing.LANGFUSE_INIT_PROJECT_NAME ?? "wrapper-agents",
    LANGFUSE_INIT_PROJECT_PUBLIC_KEY: existing.LANGFUSE_INIT_PROJECT_PUBLIC_KEY ?? `pk-lf-${hex(16)}`,
    LANGFUSE_INIT_PROJECT_SECRET_KEY: existing.LANGFUSE_INIT_PROJECT_SECRET_KEY ?? `sk-lf-${hex(16)}`,
  };
  upsertEnvFile(lfEnvFile, lfEnv);

  secrets.langfuseAdminApiKey = lfEnv.ADMIN_API_KEY;
  secrets.langfuseInitEmail = lfEnv.LANGFUSE_INIT_USER_EMAIL;
  secrets.langfuseInitPassword = lfEnv.LANGFUSE_INIT_USER_PASSWORD;
  secrets.langfuseProjectPublicKey = lfEnv.LANGFUSE_INIT_PROJECT_PUBLIC_KEY;
  secrets.langfuseProjectSecretKey = lfEnv.LANGFUSE_INIT_PROJECT_SECRET_KEY;

  // 2. agents/.env for shared provider keys.
  ensureSharedEnvStub(root);

  generateCompose(root);
  saveWrapperConfig(root, config);
  saveSecrets(root, secrets);

  if (opts.skipStack) {
    console.log("wrapper.yaml + secrets written (stack start skipped with --skip-stack)");
    return;
  }

  // 3. Bring up Langfuse and provision the org + org API key.
  console.log("Starting Langfuse stack (first run downloads several images)...");
  run("docker", ["compose", "-f", join(root, "docker-compose.yml"), "up", "-d", "--wait",
    "langfuse-web", "langfuse-worker"], { cwd: root });
  console.log("Waiting for Langfuse to become healthy...");
  await waitForLangfuse(config.langfuse.baseUrl);

  console.log(`
Langfuse UI:  ${config.langfuse.baseUrl}
  login:      ${secrets.langfuseInitEmail} / ${secrets.langfuseInitPassword}

Next: wrapper agent add <name> --channels "#some-channel"`);
}
