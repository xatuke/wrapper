# wrapper — design

A control plane for hosting, managing, and observing pi agents. Each agent is built
on `@earendil-works/pi-agent-core`, runs in its own Docker container, talks to Slack
via its own Slack app (Socket Mode), and reports traces to a self-hosted Langfuse.

## Core idea

**An agent is config + tools; everything else is a shared runtime.** Adding an agent
means writing an `agent.yaml`, optionally dropping tool modules in a folder, and
running `wrapper agent add` — not writing a new service.

## Decisions (2026-07-07)

- **Slack**: one Slack app per agent (own identity/tokens). Socket Mode — outbound
  only, no public ingress. Wrapper generates a Slack app manifest per agent so setup
  is paste-and-copy-tokens.
- **Langfuse**: self-hosted v3 stack (web, worker, postgres, clickhouse, redis, minio)
  in the wrapper compose network. **Revised 2026-07-08:** project/org management
  APIs are enterprise-only on OSS self-host (`/api/admin/*` returns 403), so all
  agents share one headless-provisioned project (`wrapper-agents`,
  LANGFUSE_INIT_PROJECT_*) and are separated by tag + session. Per-agent projects
  remain possible by creating them in the UI and `wrapper env set`-ing the keys.
- **Workloads**: conversational/API tools, code/filesystem work (must be strongly
  isolated), and scheduled/background jobs — all three supported by the runtime.

## Repo layout

```
wrapper/
├── packages/
│   ├── runtime/            # @wrapper/agent-runtime — generic agent container process
│   │   ├── main.ts         #   loads agent.yaml + tools, starts trigger sources
│   │   ├── slack.ts        #   Bolt Socket Mode; thread ↔ pi session mapping
│   │   ├── langfuse.ts     #   streamFn wrapper + agent.subscribe → traces
│   │   ├── sessions.ts     #   persist agent.state.messages per channel:thread_ts
│   │   └── triggers/       #   slack | cron | webhook
│   └── cli/                # `wrapper` CLI (control plane)
├── agents/
│   └── <name>/
│       ├── agent.yaml      # model, system prompt, channels, tools, mode, triggers
│       ├── tools/          # optional custom AgentTool modules (typebox schema + execute)
│       └── .env            # SLACK_*, LANGFUSE_*, provider keys (gitignored)
├── infra/langfuse/         # langfuse v3 compose stack
└── docker-compose.yml      # generated: one service per agent + langfuse stack
```

## What pi provides / where wrapper hooks in

- `new Agent({ initialState: { systemPrompt, model, tools } })`; tools are plain
  objects (typebox `parameters` + `execute`). Multi-provider via pi-ai, with token
  usage **and cost** on every assistant message.
- No built-in observability. Hook points wrapper uses:
  - custom `streamFn` (wrap `streamSimple`) → Langfuse *generation* per LLM call,
    with payload, response, usage, cost
  - `agent.subscribe()` → *spans* from `tool_execution_start/end`, trace lifecycle
    from `agent_start/agent_end`
- Langfuse mapping: Slack thread → session; Slack user → userId; each `prompt()`
  run → trace tagged `{agent, channel, trigger}`.
- Sessions: v1 serializes `agent.state.messages` to a per-agent volume keyed by
  `channel:thread_ts`. Agents with `mode: workspace` (code work) may later adopt
  pi's `AgentHarness` layer (JSONL session tree, compaction, shell/fs env).
- pi's `orchestrator` package is **not** used — it supervises interactive
  coding-agent CLI processes, not containers.

## agent.yaml sketch

```yaml
name: support-bot
mode: chat            # chat | workspace
model: anthropic/claude-sonnet-5
systemPrompt: ./prompt.md
channels: ["#support"]
tools: [./tools/lookup-order.ts]
triggers:
  cron:
    - schedule: "0 9 * * 1"
      prompt: "Post the weekly summary"
      channel: "#support"
resources: { memory: 1g, cpus: 1 }
```

## Isolation model (code/filesystem agents)

Tool execution happens inside the agent's container, so the container boundary is
the sandbox. Hardening for every agent, strictest defaults for `mode: workspace`:

- non-root user, `no-new-privileges`, `cap_drop: ALL`, pids/memory/CPU limits
- read-only rootfs; writable only `/workspace` (named volume) and `/tmp`
- **no host bind-mounts** for workspace agents — repos are cloned into the volume
  using a per-repo deploy key with minimal scope
- per-agent provider API keys, so a compromised agent burns only its own key
- networks: agents reach langfuse-web over an internal network; internet egress via
  the default bridge in v1, with an egress allowlist proxy as a later hardening step
- later option: gVisor (`runsc`) runtime on Linux hosts

## Triggers

- **slack** (default): mentions/messages in configured channels
- **cron** (built 2026-07-13): **agent-self-managed**, not static config. With
  `features: [cron]` in agent.yaml the runtime exposes cron_add/list/update/remove
  tools; jobs persist in `/data/cron/jobs.json` (atomic writes, re-read every
  scheduler tick). 5-field expressions, tz Asia/Kolkata (CRON_TZ env). On fire:
  fresh session `cron-<id>`, all tools available, reply posted to the job's Slack
  channel (bot must be a member); reply `NO_POST` suppresses posting (alert jobs).
  Missed occurrences during downtime are skipped. Traces tagged `trigger:cron`.
- **webhook**: a single small `gateway` service owns ingress and forwards over the
  internal network to agent containers (agents themselves stay outbound-only)

## Runtime features (agent.yaml `features:`)

Opt-in builtins, all persisted on the agent's `/data` volume:
- `cron` — see Triggers above.
- `memory` — memory_save/read/list/delete over `/data/memory/*.md`; each file's
  first line is a summary injected into the system prompt every turn.
- `workspace` — workspace_write/read/list/delete over `/data/workspace/`
  (path-sandboxed, truncated reads with offset paging).
The current Slack channel/user reach builtin tools via AsyncLocalStorage
(`turn-context.ts`) — e.g. cron_add defaults to the conversation's channel.

## Slack app automation (verified 2026-07-07 with slack-cli v4.4.0)

`wrapper agent add` fully automates Slack app creation via the Slack CLI
(`brew install --cask slack-cli`; one-time `slack auth login` per workspace):

1. Write `agents/<name>/slack/manifest.json` (socket_mode_enabled, bot scopes,
   bot_events) + `slack.json` with hook `"get-manifest": "cat manifest.json #"`
   (the trailing `#` swallows the `--source=` arg the CLI appends).
2. `slack app install --team <TEAM_ID> -E deployed --force` — creates the app
   from the manifest AND installs it, non-interactive. App ID lands in
   `.slack/apps.json`.
3. Tokens are never written to disk by the CLI. Mint them the way the CLI does:
   POST `https://slack.com/api/apps.developerInstall` with JSON body
   `{"app_id": "..."}` (omit team_id on standalone workspaces), authed with the
   CLI credential from `~/.slack/credentials.json`. Response carries
   `api_access_tokens.bot` (xoxb) and `api_access_tokens.app_level` (xapp) —
   write both straight into the agent's `.env`, never to stdout.
   (Contract confirmed in slack-cli source: `internal/api/app.go`,
   `DeveloperAppInstallResult`.)
4. Manifest changes later: `slack manifest validate` + `apps.manifest.update`.

Note: the CLI credential in `~/.slack/credentials.json` rotates (has
`refresh_token`/`exp`); refresh via `slack auth list`/any CLI call before minting.

## CLI

- `wrapper init` — scaffold, bring up Langfuse, create org + admin key
- `wrapper agent add <name>` — scaffold dir, create+install Slack app via slack-cli
  (see above), provision Langfuse project + keys, write `.env`, regenerate compose
- `wrapper up|down|restart|logs <name>` — compose shims
- `wrapper env set|list <name> [KEY=VAL]` — manage container env, offer restart
- `wrapper status` — container state, Slack connection health, last trace seen

## Deployment target: k8s (added 2026-07-09)

`wrapper.yaml` has `target: local | k8s`. Local keeps the compose flow for
developing agents on a laptop; k8s deploys to the existing EKS cluster
(`generic`, ap-south-1) where a production Langfuse already runs in the
`langfuse` namespace (served under basepath `/langfuse-web`, UI at
analytics.ndtvconvergence.com/langfuse-web). The wrapper-managed compose
Langfuse stack is only for local mode now.

Decisions:
- **Plain YAML manifests + kubectl**, generated by `manifests.ts` from
  agent.yaml (same source of truth as the compose generator). kompose was
  considered and rejected: it would translate a generated artifact and drops
  most of the security hardening.
- Per agent: Deployment (replicas=1, `strategy: Recreate` — two pods would
  split Socket Mode events), gp3 PVC for /data sessions, Secret
  `agent-<name>-env` created imperatively from agents/<name>/.env at
  apply/restart time (secret material never written to manifest files; the
  local .env stays the source of truth).
- Hardening → pod/container securityContext: runAsNonRoot 1000,
  fsGroup 1000 (PVC ownership), seccomp RuntimeDefault, readOnlyRootFilesystem,
  no privilege escalation, cap drop ALL, resource limits. No Service/Ingress —
  agents are outbound-only.
- **Agent files are baked into the image** for k8s (no bind mounts): a
  generated Dockerfile layers `COPY agents/<name> /app/agent` on top of the
  shared runtime image, or on the agent's custom image if it has a Dockerfile.
- Images in ECR: `ndtvai/wrapper-runtime` + `ndtvai/agents/<name>`, built
  linux/arm64 (cluster is mostly Graviton) with nodeSelector kubernetes.io/arch.
- **Bedrock via IRSA**: IAM OIDC provider for the cluster was missing and got
  registered (issuer id 05BEFCDC…); role `wrapper-agents-eks`
  (bedrock:InvokeModel* only) is bound to ServiceAccount
  wrapper-agents/wrapper-agents via annotation (patched live, not in the
  generated manifest, so regeneration never strips it). No static AWS keys in
  cluster secrets.
- Langfuse from pods: http://langfuse-web.langfuse.svc.cluster.local:3000/langfuse-web
  (note the basepath), project `wrapper-agents` in the existing instance
  (created via UI — project APIs are enterprise-only).
- CLI verbs unchanged; in k8s mode `up` = build+push images, apply manifests,
  sync secret, rollout; `restart` re-syncs the secret first, so
  `wrapper env set … && wrapper restart …` behaves identically to local mode.

## Operational notes (learned during M1 verification)

- langfuse-web healthcheck: Next.js binds to `$HOSTNAME` (container IP), not
  loopback — healthcheck must be `wget … http://$$HOSTNAME:3000/api/public/health`.
- Langfuse caches API-key auth verdicts in Redis; a key used *before* it exists
  gets a cached 401 (`api-key:*` keys). Flush or wait for TTL.
- LANGFUSE_INIT_* vars only apply if they're passed through the compose
  `environment:` block AND the web container is recreated.
- compose `include:` interpolates the included file against the .env in ITS
  directory — infra/langfuse/.env stays next to the langfuse compose file.
- Agent dirs mount at /app/agent (not /agent) so tool modules resolve pi
  packages from /app/node_modules.

## Milestones

1. **M1 core**: runtime (pi Agent + Bolt Socket Mode + Langfuse instrumentation),
   base image, compose generation with the Langfuse stack, CLI
   (add/up/down/env) — one dockerized agent chatting on Slack with traces
2. **M2 isolation**: hardening defaults, workspace mode, deploy-key repo cloning
3. **M3 triggers**: cron + webhook gateway, `wrapper status`, Langfuse project
   auto-provisioning polish
