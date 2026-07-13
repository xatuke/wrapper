# Creating agents

An agent is **config + tools; everything else is the shared runtime**
(`packages/runtime`). You never write a service — you write a directory:

```
agents/<name>/
├── agent.yaml       # model, prompt, channels, tools, features
├── prompt.md        # system prompt
├── tools/*.ts       # optional custom tools (TypeScript modules)
├── Dockerfile       # optional: extend the runtime image with extra CLIs/deps
├── slack/           # slack-cli project (manifest.json) — created by the CLI
└── .env             # Slack tokens, provider keys, tool secrets (gitignored)
```

## Scaffold

```bash
wrapper agent add my-agent --channels "#some-channel" --model anthropic/claude-sonnet-4-5
```

This scaffolds the directory, creates + installs a dedicated Slack app for it
(Socket Mode — outbound only, no public ingress), mints its tokens into
`agents/my-agent/.env`, writes Langfuse keys, and regenerates the deploy
artifacts. Flags: `--no-slack` / `--no-langfuse` skip those steps
(`wrapper agent connect-slack my-agent` does the Slack part later).

Agent names must be lowercase alphanumeric with dashes — they become container
names, image names, and the Slack bot's handle.

Agents live in `agents/`, which wrapper's git ignores **entirely** — version
it as your own repo (`git init` inside `agents/`, or per agent dir; scaffolded
`.gitignore`s keep secrets out) so framework updates and your agents evolve
independently. Committing your `wrapper.yaml` there as `agents/wrapper.yaml`
makes the deployment restorable from that one private repo. Never `git add`
the folder to wrapper's repo — a nested repo would only stage a useless
gitlink.

## agent.yaml reference

```yaml
name: my-agent                # required; must match the directory name
mode: chat                    # chat | workspace (reserved for code-work agents)
model: anthropic/claude-sonnet-4-5   # required: provider/model-id (pi-ai)
systemPrompt: ./prompt.md     # path to a file, or the literal prompt text
channels: ["#support"]        # @mention allowlist; [] = respond wherever invited
tools:                        # custom tool modules, paths relative to this dir
  - ./tools/lookup-order.ts
features: [cron, memory, workspace]   # opt-in runtime builtins (see below)
thinkingLevel: medium         # optional; passed through to the model

resources:                    # optional (k8s): per-agent pod resources
  requests: { cpu: "500m", memory: "2Gi" }
  limits:   { cpu: "2",    memory: "4Gi" }
mcpServers:                   # optional: stdio MCP servers bridged in as tools
  - name: browser            # tools appear as browser_<toolname>
    command: node
    args: [/app/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js,
           --headless, --isolated, --executablePath=/usr/local/bin/chromium-nosandbox]
```

Extra `features`:

- `code` — `bash` + `python` in a persistent /data/workspace sandbox (pandas/
  numpy/matplotlib preinstalled if your image has them; runtime `pip install`
  persists in a venv on /data). **The sandbox env is stripped of all secrets and
  cloud credentials** — pull data with your data tools, stage it to a file, then
  process it in code.
- `slack-files` — `slack_upload` sends a workspace file to the current
  channel/thread (needs the `files:write` bot scope, in the default manifest).

`mcpServers` bridges any stdio MCP server's tools in. `resources` sets the k8s
pod limits (defaults 100m/256Mi request, 1/1Gi limit); browser agents also get a
memory-backed `/dev/shm`. Custom images (a `Dockerfile` in the agent dir) are how
you add the binaries these need — e.g. liza's installs chromium + the python
stack + chrome-devtools-mcp.

Notes:

- **model** — anything pi-ai resolves: `anthropic/claude-sonnet-4-5`,
  `amazon-bedrock/global.anthropic.claude-sonnet-5`, `openai/...`, etc. The
  matching credential must be in the environment (shared `agents/.env`, the agent's
  `.env`, or ambient cloud credentials for Bedrock — see the deploy docs).
- **systemPrompt** — if the value (< 500 chars) is a path to an existing file,
  the file's contents are used; otherwise the value itself is the prompt.
- **channels** — names (`#support`) or IDs (`C0…`). Applies to channel
  @mentions only; **DMs are always answered**. There is currently no per-user
  authorization — assume every workspace member can talk to the agent, and
  scope its tools/credentials accordingly.

## How conversations work

- @mention in a channel → a session per thread; DM → one session per DM.
- Session transcripts persist under `/data/sessions` (a volume/PVC), so
  conversations survive restarts. Turns within a session are serialized.
- Every turn is a Langfuse trace: session = Slack thread, user = Slack user,
  one generation per LLM call (tokens + cost), one span per tool execution.

## Custom tools

A tool module default-exports an `AgentTool`, an array of them, or a (possibly
async) factory returning either. Schema via TypeBox `Type`:

```ts
// agents/my-agent/tools/lookup-order.ts
import { Type, type AgentTool } from "@earendil-works/pi-agent-core";

const tool: AgentTool = {
  name: "lookup_order",
  label: "Look up an order",
  description: "Fetch an order's status by ID.",   // what the model reads
  parameters: Type.Object({
    orderId: Type.String({ description: "e.g. ORD-1234" }),
  }),
  async execute(_id, params) {
    const res = await fetch(`https://api.internal/orders/${encodeURIComponent(params.orderId)}`, {
      headers: { authorization: `Bearer ${process.env.ORDERS_API_TOKEN}` },
    });
    return {
      content: [{ type: "text", text: await res.text() }],
      details: undefined,
    };
  },
};

export default tool;
```

Guidelines learned from the agents in this repo:

- **Secrets via env** (`wrapper env set my-agent ORDERS_API_TOKEN=…`), never
  hardcoded. Multi-line secrets (service accounts, `.edgerc` files):
  `wrapper env set-file my-agent MY_SECRET_B64 <file>` stores base64; decode in
  the tool and materialize to `/tmp` (tmpfs, writable) with mode `0600`.
- **Shell out with `execFile` + argv arrays**, never string-interpolated shells
  — the model controls tool arguments, so treat them as untrusted input.
- **Return errors as text content**, not throws, when you want the model to
  see and react to the failure.
- Tool modules run inside the agent container at `/app/agent/tools/` and
  resolve npm packages from the runtime's `/app/node_modules`. Need extra
  packages or CLIs? Give the agent a Dockerfile (below).
- If a tool is dangerous when misused, don't rely on prompt instructions or
  regex blocklists — give the agent a credential that *can't* do the dangerous
  thing (read-only API clients, scoped keys).

## Runtime features (`features:`)

Opt-in builtins, all persisted on the agent's `/data` volume:

- **`cron`** — the agent schedules *itself*: `cron_add` / `cron_list` /
  `cron_update` / `cron_remove` tools (5-field expressions, timezone from
  `CRON_TZ`, default Asia/Kolkata). When a job fires the agent runs its prompt
  in a fresh session with all tools available and posts the reply to the job's
  Slack channel (it must be a member). A reply of exactly `NO_POST` suppresses
  posting — the pattern for alert-style jobs. Occurrences missed while the
  container is down are skipped, not replayed.
- **`memory`** — `memory_save/read/list/delete` over markdown files. Each
  memory's first line is injected into the system prompt every turn, so the
  agent knows what it knows.
- **`workspace`** — `workspace_write/read/list/delete` under a path-sandboxed
  directory. For reports, extracts, and notes the agent builds over time.

## Custom Docker image

Drop a `Dockerfile` in the agent directory extending the shared runtime; both
compose and the k8s builder pick it up automatically:

```dockerfile
FROM wrapper-runtime:latest
USER root
RUN npm install --prefix /app --no-save --omit=dev --ignore-scripts mysql2@^3 pg@^8
USER node
```

The same pattern handles heavier needs — e.g. a multi-stage build that
compiles a vendor CLI in a `golang` stage and copies the binary in. Keep the
ending `USER node` — containers run non-root with a read-only rootfs; only
`/data` and `/tmp` are writable.

## Running it

Same commands for every target (`target:` in `wrapper.yaml` decides what they do):

```bash
wrapper up my-agent        # local: compose build+up | k8s: build → push → apply → rollout
wrapper logs my-agent -f
wrapper env set my-agent KEY=VALUE && wrapper restart my-agent
wrapper down my-agent
wrapper agent remove my-agent [--purge]
```

- **Local / VM** (`target: local`): the agent dir is bind-mounted read-only
  into the container; edit prompt/tools and `wrapper restart` to pick up.
- **Kubernetes** (`target: k8s`): the agent dir is *baked into an image*
  (clusters don't bind-mount your laptop) — prompt/tool changes need
  `wrapper up my-agent` to rebuild and roll. `.env` changes only need
  `wrapper env set … && wrapper restart …` (the Secret is re-synced from
  `.env` before every restart). See [k8s-manifests.md](k8s-manifests.md) for
  what gets generated per agent.
- Never run the same agent in two places at once (laptop + cluster): both hold
  Slack Socket Mode connections and events get split between them.
