import { rmSync } from "node:fs";
import { join } from "node:path";
import { generateCompose, serviceName } from "../compose.js";
import { upsertEnvFile } from "../env-file.js";
import { run } from "../exec.js";
import { deploymentName, generateManifests, secretName } from "../manifests.js";
import { kubectlArgs } from "../k8s.js";
import { agentDir, findRoot, loadSecrets, loadWrapperConfig, requireK8s } from "../root.js";
import { scaffoldAgent } from "../scaffold.js";
import { deleteSlackApp, ensureSlackApp, mintTokens } from "../slack-app.js";

export interface AddOptions {
  model: string;
  channels: string[];
  slack: boolean;
  langfuse: boolean;
}

export async function addCommand(name: string, opts: AddOptions): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error("Agent name must be lowercase alphanumeric with dashes");
  }
  const root = findRoot();
  const config = loadWrapperConfig(root);
  const secrets = loadSecrets(root);
  const dir = agentDir(root, name);

  scaffoldAgent(dir, { name, model: opts.model, channels: opts.channels });
  console.log(`Scaffolded agents/${name}/`);

  if (opts.slack) {
    if (!config.slackTeamId) {
      throw new Error("No slackTeamId configured — run `wrapper init --team-id T...` first");
    }
    const appId = ensureSlackApp(dir, name, config.slackTeamId);
    console.log(`Slack app created + installed: ${appId}`);
    const tokens = await mintTokens(appId, config.slackTeamId);
    upsertEnvFile(join(dir, ".env"), {
      SLACK_BOT_TOKEN: tokens.botToken,
      SLACK_APP_TOKEN: tokens.appToken,
    });
    console.log("Slack tokens written to agents/%s/.env", name);
  }

  if (opts.langfuse) {
    if (!secrets.langfuseProjectPublicKey || !secrets.langfuseProjectSecretKey) {
      throw new Error("Langfuse project keys missing — run `wrapper init` first");
    }
    // Shared project (project-management APIs are enterprise-only on OSS
    // self-host); traces are separated per agent by tag + session. To give an
    // agent its own project, create it in the UI and `wrapper env set` its keys.
    upsertEnvFile(join(dir, ".env"), {
      LANGFUSE_PUBLIC_KEY: secrets.langfuseProjectPublicKey,
      LANGFUSE_SECRET_KEY: secrets.langfuseProjectSecretKey,
    });
    console.log("Langfuse keys written (shared 'wrapper-agents' project)");
  }

  generateCompose(root);
  if (config.target === "k8s") generateManifests(root, requireK8s(config));
  console.log(`
Agent '${name}' is ready. Next steps:
  1. Make sure a provider API key is set (root .env or: wrapper env set ${name} ANTHROPIC_API_KEY=sk-...)
  2. wrapper up ${name}
  3. Invite the bot in Slack: /invite @${name}`);
}

/** Create+install the Slack app and mint tokens for an EXISTING agent. */
export async function connectSlackCommand(name: string): Promise<void> {
  const root = findRoot();
  const config = loadWrapperConfig(root);
  if (!config.slackTeamId) {
    throw new Error("No slackTeamId configured — run `wrapper init --team-id T...` first");
  }
  const dir = agentDir(root, name);
  const appId = ensureSlackApp(dir, name, config.slackTeamId);
  console.log(`Slack app created + installed: ${appId}`);
  const tokens = await mintTokens(appId, config.slackTeamId);
  upsertEnvFile(join(dir, ".env"), {
    SLACK_BOT_TOKEN: tokens.botToken,
    SLACK_APP_TOKEN: tokens.appToken,
  });
  console.log(`Slack tokens written to agents/${name}/.env — start with: wrapper up ${name}`);
}

export async function removeCommand(name: string, opts: { purge: boolean }): Promise<void> {
  const root = findRoot();
  const config = loadWrapperConfig(root);
  const dir = agentDir(root, name);

  if (config.target === "k8s") {
    const kc = requireK8s(config);
    run("kubectl", kubectlArgs(kc, "delete", "deployment", deploymentName(name),
      "secret", secretName(name), "--ignore-not-found"), { allowFail: true });
    // PVC (session history) is kept unless purging.
    if (opts.purge) {
      run("kubectl", kubectlArgs(kc, "delete", "pvc", `${deploymentName(name)}-data`,
        "--ignore-not-found"), { allowFail: true });
    }
    rmSync(join(root, "k8s", "agents", `${name}.yaml`), { force: true });
  } else {
    run(
      "docker",
      ["compose", "-f", join(root, "docker-compose.yml"), "rm", "-sf", serviceName(name)],
      { cwd: root, allowFail: true },
    );
  }
  if (config.slackTeamId) deleteSlackApp(dir, config.slackTeamId);

  if (opts.purge) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`Removed agents/${name}/ (Langfuse project kept — delete via UI if desired)`);
  } else {
    console.log(`Stopped container + deleted Slack app. Files kept in agents/${name}/ (use --purge to delete)`);
  }
  generateCompose(root);
}
