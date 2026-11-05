# AGENTS.md — for AI coding agents working in this repo

You are in **wrapper**: a control plane for hosting Slack-facing AI agents
built on `@earendil-works/pi-agent-core`. A hosted agent = a directory of
config + tools (`agents/<name>/`); a shared runtime (`packages/runtime`) runs
it in a container; a CLI (`packages/cli`) deploys it via docker compose
(`target: local`) or Kubernetes (`target: k8s`). Traces go to Langfuse.

Your two most common jobs here, in order of likelihood:

1. **Create or modify a hosted agent for the user** → follow "Creating an
   agent" below; full reference in `docs/agents.md`.
2. **Set up / deploy wrapper itself** (locally, on a VM, or on the user's
   k8s) → follow "Deploying wrapper" below; full guides in `docs/`.

## Build & check

```bash
npm install --ignore-scripts
npm run build          # tsc for all workspaces — run after any .ts change
npm run check          # typecheck
# CLI entrypoint (no global install):
node packages/cli/dist/index.js <command>    # docs alias this as `wrapper`
```

There is no test suite. Verify changes by building and, where possible,
running the affected CLI command or a local agent.

## Map

| Path | What |
|---|---|
| `packages/runtime/src/` | agent container process: `main.ts` (turn loop), `slack.ts` (Socket Mode), `tracing.ts` (Langfuse), `sessions.ts`, `builtins/` (cron, memory, workspace tools) |
| `packages/cli/src/` | `wrapper` CLI: `commands/`, `compose.ts` + `manifests.ts` (generators — same source of truth), `k8s.ts` (deploy), `slack-app.ts` (app automation), `ui/` (web console) |
| `agents/<name>/` | hosted agents: `agent.yaml`, `prompt.md`, `tools/*.ts`, optional `Dockerfile`, gitignored `.env`. **The whole `agents/` folder is untracked by wrapper's git** — the user versions it as their own nested repo (often with `wrapper.yaml` inside); never `git add` it to wrapper's repo (it would only stage a useless gitlink) |
| `docs/` | human-facing guides — keep them in sync with code changes |
| `wrapper.yaml` | THIS deployment's config (gitignored; from `wrapper.example.yaml`). May live at `agents/wrapper.yaml` instead — versioned in the user's agents repo; root wins if both exist |
| `wrapper.secrets.json` | Langfuse keys (gitignored; written by `wrapper init`) |

Generated, never hand-edited: `docker-compose.yml`, `k8s/`, `agents/*/slack/.slack/`.

## Creating an agent (for the user)

Ask the user for: agent name (lowercase-dashes), what it should do (→ prompt),
which Slack channels, which model/provider, and what external systems tools
must reach (→ credentials needed).

```bash
wrapper agent add <name> --channels "#chan" --model anthropic/claude-sonnet-4-5
# scaffolds agents/<name>/, creates+installs its Slack app, mints tokens into
# agents/<name>/.env, writes Langfuse keys. Requires slack CLI logged in
# (`slack auth login`) and slackTeamId in wrapper.yaml.
```

Then edit:

- `agents/<name>/prompt.md` — the system prompt.
- `agents/<name>/agent.yaml` — `model` (`provider/model-id`), `channels`
  (@mention allowlist), `dmUsers` (DM allowlist — IDs/@handles/emails; empty =
  everyone), `tools` (paths), `features`
  (any of `cron`, `memory`, `workspace` — self-scheduling, persistent memory,
  file workspace).
- `agents/<name>/tools/*.ts` — default-export an `AgentTool`
  (`{name, description, parameters: Type.Object(...), async execute(_id, params)}`
  returning `{content: [{type: "text", text}], details: undefined}`).
  Copy the shape from the `tools/time.ts` every new agent is scaffolded with
  (template in `packages/cli/src/scaffold.ts`); full example in
  `docs/agents.md`. Existing agents under `agents/` are the user's — read
  them for patterns, but don't assume any particular one exists.

Rules that matter (details + rationale in `docs/agents.md`):

- Secrets only via env: `wrapper env set <name> KEY=VALUE`; multi-line files
  base64 via `wrapper env set-file <name> KEY_B64 <file>` (decode to `/tmp`,
  mode 0600). Never hardcode, never commit, never print token values.
- Tool args come from the model = untrusted: `execFile` with argv arrays, no
  string-built shell commands; validate/encode inputs.
- Prefer read-only credentials for tools — by default anyone in the Slack
  workspace can DM the bot (`dmUsers` can restrict this, but channel mentions
  are still open to all members of allowed channels), so assume every tool is
  reachable broadly.
- Extra npm packages or CLIs → agent `Dockerfile` `FROM wrapper-runtime:latest`
  (example in `docs/agents.md`); end with `USER node` (read-only rootfs,
  non-root).

Run it: `wrapper up <name>` → `/invite @<name>` in Slack. Iterate with
`wrapper logs <name> -f`; prompt/tool edits need `wrapper restart <name>`
locally or `wrapper up <name>` on k8s (files are baked into the image there);
`.env` edits need `wrapper env set … && wrapper restart …` everywhere.

## Deploying wrapper (for the user)

Ask the user: where should agents run (this machine / a VM / their k8s), and
do they already have a Langfuse deployment (or Langfuse Cloud account)?

Common to all paths: `npm install --ignore-scripts && npm run build`, copy
`wrapper.example.yaml` → `wrapper.yaml` and edit it, get the Slack team ID
(`slack auth list` after `slack auth login`), then `wrapper init --team-id T0…`.

- **Local / VM, no existing Langfuse** — `target: local`, leave `langfuse:`
  defaults; `init` starts a full self-hosted Langfuse (needs ~4 GB RAM) and
  writes its keys to `wrapper.secrets.json` automatically. Guide:
  `docs/getting-started.md`, VM specifics: `docs/deploy-vm.md`.
- **Local / VM, existing Langfuse** — `target: local` plus
  `langfuse: { external: true, baseUrl: <their URL> }` (and `containerBaseUrl`
  if containers reach it differently, e.g. `http://host.docker.internal:…`).
  Have the user create a project in their Langfuse UI, put its `pk-lf-…` /
  `sk-lf-…` into `wrapper.secrets.json` as `langfuseProjectPublicKey` /
  `langfuseProjectSecretKey` (then `agent add` wires new agents up
  automatically; existing agents: `wrapper env set <name>
  LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=…`). `init` then skips the bundled
  stack. Guide: `docs/langfuse.md`.
- **Kubernetes** — `target: k8s` + a `k8s:` block (context, namespace,
  registry, storageClass, arch — commented template in `wrapper.example.yaml`).
  k8s mode always uses the user's own Langfuse (`k8s.langfuseBaseUrl`, as
  reached from pods). `wrapper up <name>` = build → push → apply generated
  manifests → sync Secret from `.env` → rollout. AWS/EKS (ECR auto-created,
  Bedrock via IRSA): `docs/deploy-k8s-aws.md`. GCP/GKE (pre-create one
  Artifact Registry repo + `gcloud auth configure-docker`; API-key models):
  `docs/deploy-k8s-gcp.md`. What the manifests contain: `docs/k8s-manifests.md`.

## Invariants — do not break these

- **Never run the same hosted agent in two places at once** (local + k8s):
  both hold Slack Socket Mode connections and events get split.
- **Never commit or print secrets.** Gitignored: all `.env` files,
  `wrapper.secrets.json`, `wrapper.yaml`, service-account JSONs, `k8s/`,
  `docker-compose.yml`. Slack tokens are minted directly into `.env` files —
  keep it that way.
- **Never hand-edit generated files** (`docker-compose.yml`, `k8s/`) — change
  the generators (`compose.ts` / `manifests.ts`) instead; both must stay in
  sync since they read the same `agent.yaml`.
- **k8s Secrets are created imperatively** from `agents/<name>/.env` at deploy
  time — don't add Secret manifests or bake secrets into images/manifests.
- **Live kubectl patches on the ServiceAccount** (IRSA / Workload Identity
  annotations) are intentional and survive regeneration — don't "fix" the
  generator to include them.
- `replicas: 1` + `strategy: Recreate` on agent Deployments is deliberate
  (Socket Mode), not an oversight.
- **Framework git ≠ agents git.** `git pull` / commits in the wrapper root
  never include anything under `agents/` (fully ignored). When committing
  agent changes for the user, do it in *their* agents repo (usually rooted at
  `agents/`, sometimes per agent dir) — check with `git -C agents status` —
  and keep the scaffolded `.gitignore`s intact.
- When you change CLI/runtime behavior, update the matching doc in `docs/`
  (and this file if a workflow changes).
