# Deploying on a cloud VM (no Kubernetes)

The `target: local` compose setup runs unchanged on a plain cloud VM — the
simplest way to keep agents running 24/7 without a cluster. Works the same on
an AWS EC2 instance, a GCP Compute Engine instance, or any Linux box with
Docker.

Agents are **outbound-only** (Slack Socket Mode, LLM APIs, Langfuse), so the
VM needs **no inbound ports at all** beyond SSH.

## Sizing

- 2 vCPU / 4 GB RAM / 30 GB disk is comfortable for a few agents **plus the
  bundled Langfuse stack** (postgres, clickhouse, redis, minio — clickhouse is
  the hungry one).
- Using an [existing/external Langfuse](langfuse.md) instead? 1 vCPU / 1–2 GB
  is plenty — each agent container is capped at 1 CPU / 1 GB anyway.
- Any arch works (images build natively on the VM).

## Setup (both clouds)

```bash
# 1. Docker Engine + compose plugin — https://docs.docker.com/engine/install/
sudo systemctl enable docker

# 2. Node.js ≥ 22 (e.g. via https://github.com/nvm-sh/nvm)

# 3. Slack CLI (used by `wrapper agent add` to create Slack apps)
curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash
slack auth login    # prints a URL + a challenge code — complete it in a browser anywhere

# 4. wrapper
git clone <your-repo> wrapper && cd wrapper
npm install --ignore-scripts && npm run build
alias wrapper="node $PWD/packages/cli/dist/index.js"

cp wrapper.example.yaml wrapper.yaml   # target: local, your slackTeamId
wrapper init --team-id T0XXXXXXXXX
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env

wrapper agent add my-agent --channels "#somewhere"
wrapper up my-agent
```

Containers are `restart: unless-stopped` and Docker is enabled on boot, so
agents come back up after a reboot on their own — no systemd units needed.

If you'd rather not log the Slack CLI in on a server: run `wrapper agent add`
on your laptop (against the same repo), then copy `agents/<name>/` —
**including its gitignored `.env`** — to the VM (`rsync -a agents/my-agent/
vm:wrapper/agents/my-agent/`) and run `wrapper up my-agent` there. Just never
run the same agent in both places at once: two containers means two Socket
Mode connections and Slack splits events between them.

## Reaching the Langfuse UI

The bundled Langfuse listens on port 3010. Don't expose it publicly — keep the
firewall closed and use an SSH tunnel when you want the UI:

```bash
ssh -L 3010:localhost:3010 user@vm   # then open http://localhost:3010
```

Same for the wrapper web console (`wrapper ui`, port 3020). Alternatively, use
an external Langfuse and there's nothing to tunnel.

## Cloud-specific notes

### AWS EC2

- **Bedrock without static keys**: attach an instance role whose policy allows
  `bedrock:InvokeModel` + `bedrock:InvokeModelWithResponseStream`, set
  `AWS_REGION=<region>` in the root `.env`, and use a
  `model: amazon-bedrock/...` in `agent.yaml`. pi's Bedrock provider uses the
  AWS SDK default credential chain, which finds the instance role — no
  `AWS_ACCESS_KEY_ID` on disk. (Set IMDSv2 `HttpTokens=required`; the SDK
  handles it.)
- Otherwise any provider works with plain API keys in `.env`.

### GCP Compute Engine

- Use API-key providers (`anthropic/...` with `ANTHROPIC_API_KEY`,
  `openai/...`, Gemini with `GEMINI_API_KEY`, etc.) in the root `.env`.
- A GCE service account on the VM is useful for *your tools* (e.g. BigQuery,
  GCS clients pick up Application Default Credentials) — scope it minimally.

## Updating

```bash
cd wrapper && git pull
npm install --ignore-scripts && npm run build
wrapper up            # rebuilds images, restarts changed agents
```

## Hardening checklist

- No inbound rules except SSH; agents need none.
- Keep provider keys per-agent (`wrapper env set`) where possible — a
  compromised agent then burns only its own key.
- Give dangerous tools read-only credentials (see [agents.md](agents.md)).
- The VM's disk holds session transcripts and `.env` secrets — use an
  encrypted boot/data disk (default on GCP; enable EBS encryption on AWS).
