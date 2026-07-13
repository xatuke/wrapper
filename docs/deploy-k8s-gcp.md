# Deploying on GCP (GKE)

The k8s target is cloud-agnostic where it matters — generated manifests are
plain Kubernetes YAML, images go to whatever `k8s.registry` you configure, and
non-ECR registries are assumed pre-authenticated. This doc covers the
GKE + Artifact Registry specifics.

Read [k8s-manifests.md](k8s-manifests.md) for what gets generated, and
[langfuse.md](langfuse.md) for pointing agents at your Langfuse (in-cluster,
elsewhere, or Langfuse Cloud).

## Prerequisites

- A GKE cluster + kubeconfig context
  (`gcloud container clusters get-credentials <cluster> --region <region>`).
- An Artifact Registry **docker repository** (one-time):

  ```bash
  gcloud artifacts repositories create wrapper \
    --repository-format=docker --location=<region>
  gcloud auth configure-docker <region>-docker.pkg.dev   # one-time docker auth
  ```

  Unlike ECR (where the CLI auto-creates one repo per image), Artifact
  Registry hosts all images under this single repository; nothing else to
  create per agent.
- Docker with buildx.
- A Langfuse the pods can reach.

## Configure

```yaml
# wrapper.yaml
target: k8s
slackTeamId: T0XXXXXXXXX
langfuse:
  baseUrl: https://langfuse.mycompany.com          # reachable from YOUR machine
  orgId: wrapper
k8s:
  context: gke_<project>_<region>_<cluster>
  namespace: wrapper-agents
  serviceAccount: wrapper-agents
  registry: <region>-docker.pkg.dev/<project>/wrapper   # the AR repo from above
  repoPrefix: myteam            # → .../wrapper/myteam/wrapper-runtime, .../myteam/agents/<name>
  storageClass: standard-rwo    # GKE's default balanced PD class (encrypted at rest by default)
  arch: amd64                   # or arm64 for T2A nodes — must match your node pool
  awsRegion: ""                 # unused on GCP (skips AWS_REGION injection)
  langfuseBaseUrl: http://langfuse-web.langfuse.svc.cluster.local:3000  # from pods
  langfuseUiUrl: https://langfuse.mycompany.com
```

Because the registry isn't ECR, `wrapper up` skips the AWS login/repo steps
and pushes with your existing docker credentials (the `gcloud auth
configure-docker` above). GKE nodes pull from Artifact Registry in the same
project without extra setup.

Langfuse project keys go in `wrapper.secrets.json` so `agent add` writes them
into each agent's `.env` — see [langfuse.md](langfuse.md).

## Deploy and operate

Identical to every other target:

```bash
wrapper agent add my-agent --channels "#somewhere"
wrapper up my-agent                     # build → push to AR → apply → rollout
wrapper logs my-agent -f
wrapper env set my-agent K=V && wrapper restart my-agent
wrapper down my-agent                   # scale to 0
```

## LLM credentials

There is no Bedrock on GCP, so use API-key providers — keys live in each
agent's `.env` and reach the pod via its synced Secret:

```bash
wrapper env set my-agent ANTHROPIC_API_KEY=sk-ant-...   # model: anthropic/claude-sonnet-4-5
# or GEMINI_API_KEY / OPENAI_API_KEY with a matching model: string
```

If your *tools* need GCP services (BigQuery, GCS, Secret Manager), prefer
[Workload Identity Federation](https://cloud.google.com/kubernetes-engine/docs/how-to/workload-identity)
over key files: bind a GCP service account to the `wrapper-agents` KSA and
annotate it live —

```bash
kubectl -n wrapper-agents annotate serviceaccount wrapper-agents \
  iam.gke.io/gcp-service-account=<gsa>@<project>.iam.gserviceaccount.com
```

Live SA annotations survive manifest regeneration by design (see
[k8s-manifests.md](k8s-manifests.md) §Customizing). A base64'd service-account
JSON via `wrapper env set-file` works too, but rotate it and scope it tightly.

## Production hardening checklist

Same list as [AWS](deploy-k8s-aws.md#production-hardening-checklist), with GKE
flavors:

1. **Egress NetworkPolicy** (enable Dataplane V2 / network policy enforcement
   on the cluster): default-deny egress; allow DNS, Slack, your LLM API,
   Langfuse, and your tools' endpoints.
2. **Secrets at rest**: GKE encrypts etcd by default; add
   [application-layer secrets encryption](https://cloud.google.com/kubernetes-engine/docs/how-to/encrypting-secrets)
   with Cloud KMS for defense in depth, and tighten RBAC on `secrets`.
3. **Session storage**: persistent disks are encrypted by default; use CMEK if
   policy requires.
4. **Images**: enable Artifact Registry vulnerability scanning; consider
   digest pinning instead of `:latest`.
5. **Slack exposure**: the bot answers DMs from any workspace member — scope
   tool credentials read-only (see [agents.md](agents.md)).
