import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runInteractive } from "./exec.js";
import {
  agentImage,
  agentImageDockerfile,
  deploymentName,
  generateManifests,
  runtimeImage,
  secretName,
} from "./manifests.js";
import type { K8sConfig } from "./root.js";

export function kubectlArgs(k8s: K8sConfig, ...rest: string[]): string[] {
  const args: string[] = [];
  if (k8s.context) args.push("--context", k8s.context);
  return [...args, "-n", k8s.namespace, ...rest];
}

function kubectl(k8s: K8sConfig, args: string[], opts: { allowFail?: boolean } = {}) {
  return run("kubectl", kubectlArgs(k8s, ...args), opts);
}

function isEcr(registry: string): boolean {
  return registry.includes(".amazonaws.com");
}

/** docker login for the ECR registry (idempotent, ~12h validity). Non-ECR
 * registries (e.g. GCP Artifact Registry) are assumed pre-authenticated
 * (`gcloud auth configure-docker <region>-docker.pkg.dev`). */
export function ecrLogin(k8s: K8sConfig): void {
  if (!isEcr(k8s.registry)) return;
  const pw = run("aws", ["ecr", "get-login-password", "--region", k8s.awsRegion]).stdout.trim();
  run("docker", ["login", "--username", "AWS", "--password-stdin", k8s.registry], { input: pw });
}

export function ensureEcrRepo(k8s: K8sConfig, repo: string): void {
  // ECR needs one repo per image path; other registries manage this themselves.
  if (!isEcr(k8s.registry)) return;
  const res = run(
    "aws",
    ["ecr", "describe-repositories", "--region", k8s.awsRegion, "--repository-names", repo],
    { allowFail: true },
  );
  if (res.code !== 0) {
    run("aws", ["ecr", "create-repository", "--region", k8s.awsRegion, "--repository-name", repo]);
    console.log(`created ECR repo ${repo}`);
  }
}

/** Build the shared runtime image and push it to ECR. */
export function buildAndPushRuntime(root: string, k8s: K8sConfig): void {
  const remote = runtimeImage(k8s);
  run("docker", ["build", "--platform", `linux/${k8s.arch}`, "-t", "wrapper-runtime:latest",
    "-f", "docker/runtime.Dockerfile", "."], { cwd: root });
  ensureEcrRepo(k8s, `${k8s.repoPrefix}/wrapper-runtime`);
  run("docker", ["tag", "wrapper-runtime:latest", remote]);
  run("docker", ["push", remote], { cwd: root });
}

/** Build the per-agent image (custom base if present + agent files) and push. */
export function buildAndPushAgent(root: string, k8s: K8sConfig, name: string): string {
  const hasCustom = existsSync(join(root, "agents", name, "Dockerfile"));
  if (hasCustom) {
    run("docker", ["build", "--platform", `linux/${k8s.arch}`, "-t", `wrapper-agent-${name}:build`,
      "-f", `agents/${name}/Dockerfile`, "."], { cwd: root });
  }
  const remote = agentImage(k8s, name);
  const tmp = mkdtempSync(join(tmpdir(), "wrapper-img-"));
  try {
    const df = join(tmp, "Dockerfile");
    writeFileSync(df, agentImageDockerfile(root, k8s, name));
    run("docker", ["build", "--platform", `linux/${k8s.arch}`, "-t", remote, "-f", df, "."], {
      cwd: root,
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  ensureEcrRepo(k8s, `${k8s.repoPrefix}/agents/${name}`);
  run("docker", ["push", remote], { cwd: root });
  return remote;
}

/** Create/update the agent's Secret from its local .env (source of truth). */
export function syncSecret(root: string, k8s: K8sConfig, name: string): void {
  const envFile = join(root, "agents", name, ".env");
  if (!existsSync(envFile)) throw new Error(`agents/${name}/.env not found`);
  const manifest = kubectl(k8s, [
    "create", "secret", "generic", secretName(name),
    `--from-env-file=${envFile}`,
    "--dry-run=client", "-o", "yaml",
  ]).stdout;
  const tmp = mkdtempSync(join(tmpdir(), "wrapper-secret-"));
  try {
    const file = join(tmp, "secret.yaml");
    writeFileSync(file, manifest, { mode: 0o600 });
    kubectl(k8s, ["apply", "-f", file]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function applyBase(root: string, k8s: K8sConfig): void {
  generateManifests(root, k8s);
  run("kubectl", [
    ...(k8s.context ? ["--context", k8s.context] : []),
    "apply", "-f", join(root, "k8s", "namespace.yaml"),
  ]);
}

export function applyAgent(root: string, k8s: K8sConfig, name: string): void {
  kubectl(k8s, ["apply", "-f", join(root, "k8s", "agents", `${name}.yaml`)]);
}

export function rolloutRestart(k8s: K8sConfig, name: string): void {
  kubectl(k8s, ["rollout", "restart", `deployment/${deploymentName(name)}`]);
}

export async function waitRollout(k8s: K8sConfig, name: string): Promise<void> {
  await runInteractive(
    "kubectl",
    kubectlArgs(k8s, "rollout", "status", `deployment/${deploymentName(name)}`, "--timeout=180s"),
  );
}

export function scale(k8s: K8sConfig, name: string, replicas: number): void {
  kubectl(k8s, ["scale", `deployment/${deploymentName(name)}`, `--replicas=${replicas}`], {
    allowFail: true,
  });
}

export async function logs(k8s: K8sConfig, name: string, follow: boolean): Promise<void> {
  await runInteractive(
    "kubectl",
    kubectlArgs(
      k8s,
      "logs",
      `deployment/${deploymentName(name)}`,
      "--tail", "200",
      ...(follow ? ["-f"] : []),
    ),
  );
}

export function podStatus(k8s: K8sConfig): string {
  return kubectl(
    k8s,
    ["get", "pods", "-l", "app=wrapper-agent",
      "-o", "custom-columns=AGENT:.metadata.labels.agent,STATUS:.status.phase,READY:.status.containerStatuses[0].ready,RESTARTS:.status.containerStatuses[0].restartCount,AGE:.metadata.creationTimestamp"],
    { allowFail: true },
  ).stdout.trim();
}
