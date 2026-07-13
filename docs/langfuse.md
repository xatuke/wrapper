# Langfuse: bundled, existing, or cloud

Every agent turn is traced to [Langfuse](https://langfuse.com): the Slack
thread becomes a *session*, the Slack user the *userId*, each reply a *trace*
containing one *generation* per LLM call (with token usage **and cost**) and
one *span* per tool execution. Traces are tagged with the agent name and
trigger (`slack` / `cron`).

You have three ways to get a Langfuse:

| Setup | `wrapper.yaml` | Who runs Langfuse |
|---|---|---|
| **Bundled** (default) | `langfuse: { baseUrl: http://localhost:3010 }` | wrapper, via docker compose |
| **Existing / external** | `langfuse: { external: true, ... }` | you (self-hosted anywhere, or Langfuse Cloud) |
| **K8s target** | `k8s: { langfuseBaseUrl: ... }` | you (typically already in the cluster) |

An agent traces to whatever `LANGFUSE_BASEURL`, `LANGFUSE_PUBLIC_KEY`, and
`LANGFUSE_SECRET_KEY` resolve to in its container env. If the keys are absent
the agent runs fine with tracing disabled (a warning is logged).

## Bundled stack (default for local)

`wrapper init` generates secrets, starts the full Langfuse v3 stack (web,
worker, postgres, clickhouse, redis, minio) inside the wrapper compose project,
and headlessly provisions an org + a shared `wrapper-agents` project. The
project keys land in `wrapper.secrets.json`, and every `wrapper agent add`
copies them into the agent's `.env`. Nothing else to do.

## Using an existing Langfuse deployment

If you already run Langfuse (or use [Langfuse Cloud](https://cloud.langfuse.com)),
don't start a second one — point wrapper at yours:

1. **Configure** `wrapper.yaml`:

   ```yaml
   target: local
   langfuse:
     external: true
     # Reachable from where you run the CLI (health checks):
     baseUrl: https://langfuse.mycompany.com
     # Reachable from inside the agent containers (defaults to baseUrl).
     # Only needed when the two differ — e.g. Langfuse in another compose
     # project on the same host: http://host.docker.internal:3000
     containerBaseUrl: https://langfuse.mycompany.com
     orgId: wrapper
   ```

   With `external: true` the generated docker-compose.yml no longer includes
   the bundled stack (and `wrapper init` won't try to start it); agents get
   `LANGFUSE_BASEURL=<containerBaseUrl or baseUrl>`.

2. **Create a project** in your Langfuse UI (e.g. `wrapper-agents`) and copy
   its API keys (`pk-lf-…` / `sk-lf-…`).

3. **Give wrapper the keys** — either of:

   - Put them in `wrapper.secrets.json` so every future `wrapper agent add`
     writes them into the agent's `.env` automatically:

     ```json
     {
       "langfuseProjectPublicKey": "pk-lf-...",
       "langfuseProjectSecretKey": "sk-lf-..."
     }
     ```

   - Or set them per agent (also how you fix up *existing* agents):

     ```bash
     wrapper env set my-agent LANGFUSE_PUBLIC_KEY=pk-lf-... LANGFUSE_SECRET_KEY=sk-lf-...
     wrapper restart my-agent
     ```

4. `wrapper init --team-id T0…` then behaves as a pure config step: it writes
   configs/secrets, health-checks your Langfuse, and skips the stack.

Notes for specific hosts:

- **Langfuse Cloud**: `baseUrl: https://cloud.langfuse.com` (or your region's
  URL); no `containerBaseUrl` needed.
- **Langfuse on the same machine, outside wrapper's compose**: containers can't
  reach your host's `localhost` — use `containerBaseUrl:
  http://host.docker.internal:<port>` (Docker Desktop) or the host's LAN IP
  (Linux).
- **Served under a basepath** (e.g. `/langfuse-web` behind a shared ingress):
  include the basepath in the URLs.

## K8s target

`target: k8s` always brings your own Langfuse — the bundled stack is
local-mode only. Set the in-cluster (or public) endpoint:

```yaml
k8s:
  # As reached FROM AGENT PODS — include any basepath:
  langfuseBaseUrl: http://langfuse-web.langfuse.svc.cluster.local:3000
  # Optional, for humans (`wrapper status` prints it):
  langfuseUiUrl: https://langfuse.mycompany.com
```

Keys work exactly as in the external case above (`wrapper.secrets.json` for
new agents, `wrapper env set` for existing ones); `wrapper restart` re-syncs
each agent's k8s Secret from its `.env`.

## Per-agent projects

Project management APIs are enterprise-only on OSS self-hosted Langfuse, so by
default all agents share one project, separated by tag (agent name) and
session. To isolate an agent into its own project: create the project in the
UI, then `wrapper env set <agent> LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=…`
and restart.

## What ends up in Langfuse (privacy note)

Traces contain the full prompt context, tool inputs, and tool outputs —
including whatever users paste into Slack. Treat the Langfuse project like the
conversations themselves: restrict who can view it, and consider a retention
window on the project.
