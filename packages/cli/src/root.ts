import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";

/** Walk up from cwd to the wrapper root (marked by wrapper.yaml or agents/+infra/). */
export function findRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (
      existsSync(join(dir, "wrapper.yaml")) ||
      existsSync(join(dir, "agents", "wrapper.yaml")) ||
      // fresh clone: agents/ doesn't exist yet (it's untracked), so key off
      // the framework's own tracked dirs
      (existsSync(join(dir, "packages")) && existsSync(join(dir, "infra")))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Not inside a wrapper project (no wrapper.yaml found)");
    dir = parent;
  }
}

export interface K8sConfig {
  context: string; // kubectl context name (empty = current context)
  namespace: string;
  serviceAccount: string;
  registry: string; // ECR registry host
  repoPrefix: string; // e.g. "ndtvai" → ndtvai/wrapper-runtime, ndtvai/agents/<name>
  storageClass: string;
  arch: string; // node arch to schedule on + image platform (arm64 | amd64)
  awsRegion: string;
  langfuseBaseUrl: string; // reachable from inside the cluster (include basepath)
  langfuseUiUrl?: string; // human-facing URL for links
}

export interface WrapperConfig {
  target: "local" | "k8s";
  slackTeamId?: string;
  langfuse: {
    baseUrl: string; // reachable from the host (CLI provisioning)
    orgId: string;
    // Bring-your-own Langfuse: skip the bundled compose stack entirely.
    external?: boolean;
    // URL agents reach Langfuse at from inside their containers (local target
    // only; defaults to baseUrl). K8s uses k8s.langfuseBaseUrl instead.
    containerBaseUrl?: string;
  };
  k8s?: K8sConfig;
}

const DEFAULTS: WrapperConfig = {
  target: "local",
  langfuse: { baseUrl: "http://localhost:3010", orgId: "wrapper" },
};

/**
 * wrapper.yaml can live at the repo root (machine-local, gitignored) or in
 * agents/ — the latter belongs to the user's own agents repo, making their
 * whole deployment (config + agents) restorable from one private repo.
 * Root wins when both exist.
 */
export function wrapperConfigPath(root: string): string {
  const rootFile = join(root, "wrapper.yaml");
  if (existsSync(rootFile)) return rootFile;
  const agentsFile = join(root, "agents", "wrapper.yaml");
  if (existsSync(agentsFile)) return agentsFile;
  return rootFile; // default location for a fresh `wrapper init`
}

export function loadWrapperConfig(root: string): WrapperConfig {
  const file = wrapperConfigPath(root);
  if (!existsSync(file)) return structuredClone(DEFAULTS);
  const raw = parse(readFileSync(file, "utf8")) ?? {};
  return {
    target: raw.target === "k8s" ? "k8s" : "local",
    slackTeamId: raw.slackTeamId,
    langfuse: { ...DEFAULTS.langfuse, ...(raw.langfuse ?? {}) },
    k8s: raw.k8s,
  };
}

export function requireK8s(config: WrapperConfig): K8sConfig {
  if (!config.k8s) {
    throw new Error("No k8s section in wrapper.yaml — add one or set target: local");
  }
  return config.k8s;
}

export function saveWrapperConfig(root: string, config: WrapperConfig): void {
  // Save back to wherever the config was loaded from (root or agents/).
  writeFileSync(wrapperConfigPath(root), stringify(config));
}

/** Secrets kept out of git: langfuse admin/org keys, init password. */
export interface Secrets {
  langfuseAdminApiKey?: string;
  langfuseProjectPublicKey?: string;
  langfuseProjectSecretKey?: string;
  langfuseInitEmail?: string;
  langfuseInitPassword?: string;
  [key: string]: string | undefined;
}

export function loadSecrets(root: string): Secrets {
  const file = join(root, "wrapper.secrets.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8"));
}

export function saveSecrets(root: string, secrets: Secrets): void {
  writeFileSync(join(root, "wrapper.secrets.json"), JSON.stringify(secrets, null, 2), {
    mode: 0o600,
  });
}

export function agentDir(root: string, name: string): string {
  return resolve(root, "agents", name);
}
