import { join } from "node:path";
import { listAgents, generateCompose, serviceName } from "../compose.js";
import { run, runInteractive } from "../exec.js";
import * as k8s from "../k8s.js";
import { findRoot, loadWrapperConfig, requireK8s } from "../root.js";

function composeArgs(root: string, ...rest: string[]): string[] {
  return ["compose", "-f", join(root, "docker-compose.yml"), ...rest];
}

function checkAgents(root: string, names: string[]): string[] {
  const known = listAgents(root);
  for (const n of names) {
    if (!known.includes(n)) throw new Error(`Unknown agent '${n}' (have: ${known.join(", ") || "none"})`);
  }
  return names.length > 0 ? names : known;
}

export async function upCommand(names: string[]): Promise<void> {
  const root = findRoot();
  const config = loadWrapperConfig(root);
  const agents = checkAgents(root, names);

  if (config.target === "k8s") {
    const kc = requireK8s(config);
    k8s.ecrLogin(kc);
    console.log("building + pushing runtime image...");
    k8s.buildAndPushRuntime(root, kc);
    k8s.applyBase(root, kc);
    for (const name of agents) {
      console.log(`building + pushing image for '${name}'...`);
      k8s.buildAndPushAgent(root, kc, name);
      k8s.syncSecret(root, kc, name);
      k8s.applyAgent(root, kc, name);
      k8s.scale(kc, name, 1);
      k8s.rolloutRestart(kc, name); // pick up :latest even if spec unchanged
      await k8s.waitRollout(kc, name);
    }
    return;
  }

  generateCompose(root);
  await runInteractive(
    "docker",
    composeArgs(root, "up", "-d", "--build", ...agents.map(serviceName)),
    root,
  );
}

export async function downCommand(names: string[]): Promise<void> {
  const root = findRoot();
  const config = loadWrapperConfig(root);

  if (config.target === "k8s") {
    const kc = requireK8s(config);
    for (const name of checkAgents(root, names)) {
      k8s.scale(kc, name, 0);
      console.log(`scaled ${name} to 0`);
    }
    return;
  }

  if (names.length === 0) {
    await runInteractive("docker", composeArgs(root, "down"), root);
    return;
  }
  await runInteractive("docker", composeArgs(root, "stop", ...checkAgents(root, names).map(serviceName)), root);
}

export async function restartCommand(names: string[]): Promise<void> {
  const root = findRoot();
  const config = loadWrapperConfig(root);

  if (config.target === "k8s") {
    const kc = requireK8s(config);
    for (const name of checkAgents(root, names)) {
      k8s.syncSecret(root, kc, name); // pick up .env changes
      k8s.rolloutRestart(kc, name);
      await k8s.waitRollout(kc, name);
    }
    return;
  }

  await runInteractive("docker", composeArgs(root, "restart", ...checkAgents(root, names).map(serviceName)), root);
}

export async function logsCommand(name: string, opts: { follow: boolean }): Promise<void> {
  const root = findRoot();
  const config = loadWrapperConfig(root);
  checkAgents(root, [name]);

  if (config.target === "k8s") {
    await k8s.logs(requireK8s(config), name, opts.follow);
    return;
  }

  const args = composeArgs(root, "logs", ...(opts.follow ? ["-f"] : ["--tail", "200"]), serviceName(name));
  await runInteractive("docker", args, root);
}

export async function statusCommand(): Promise<void> {
  const root = findRoot();
  const config = loadWrapperConfig(root);

  if (config.target === "k8s") {
    const kc = requireK8s(config);
    console.log(`target: k8s (${kc.namespace} @ ${kc.context || "current context"})\n`);
    console.log(k8s.podStatus(kc) || "(no agent pods)");
    if (kc.langfuseUiUrl) console.log(`\nLangfuse: ${kc.langfuseUiUrl}`);
    return;
  }

  const ps = run("docker", composeArgs(root, "ps", "--format", "table {{.Service}}\t{{.Status}}"), {
    cwd: root,
    allowFail: true,
  });
  console.log(ps.stdout.trim() || "(no containers running)");

  try {
    const res = await fetch(config.langfuse.baseUrl.replace(/\/$/, "") + "/api/public/health");
    console.log(`\nLangfuse: ${res.ok ? "healthy" : `unhealthy (HTTP ${res.status})`} at ${config.langfuse.baseUrl}`);
  } catch {
    console.log(`\nLangfuse: unreachable at ${config.langfuse.baseUrl}`);
  }
}
