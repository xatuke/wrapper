# Deploying on AWS (EKS)

`target: k8s` turns the same CLI verbs into: build images → push to ECR →
apply generated manifests → sync secrets → rollout. There is **no server-side
control plane** — your machine (laptop or CI) drives `docker`, `aws`, and
`kubectl`.

Read [k8s-manifests.md](k8s-manifests.md) for what gets generated per agent,
and [langfuse.md](langfuse.md) for pointing agents at your Langfuse.

## Prerequisites

- An EKS cluster and a kubeconfig context for it (`aws eks update-kubeconfig`).
- AWS CLI credentials able to push to ECR (repos are auto-created) and, once,
  to create an IAM role if you use Bedrock via IRSA.
- Docker with buildx (images are cross-built for the cluster's arch).
- A Langfuse the pods can reach — one already in the cluster, or any external
  URL (the bundled compose stack is local-mode only).

## Configure

```yaml
# wrapper.yaml
target: k8s
slackTeamId: T0XXXXXXXXX
langfuse:
  baseUrl: https://langfuse.mycompany.com     # reachable from YOUR machine
  orgId: wrapper
k8s:
  context: arn:aws:eks:<region>:<account>:cluster/<cluster>
  namespace: wrapper-agents
  serviceAccount: wrapper-agents
  registry: <account>.dkr.ecr.<region>.amazonaws.com
  repoPrefix: myteam            # → myteam/wrapper-runtime, myteam/agents/<name>
  storageClass: gp3
  arch: arm64                   # match your node group (Graviton: arm64)
  awsRegion: <region>
  langfuseBaseUrl: http://langfuse-web.langfuse.svc.cluster.local:3000  # from pods
  langfuseUiUrl: https://langfuse.mycompany.com
```

Langfuse project keys: put them in `wrapper.secrets.json`
(`langfuseProjectPublicKey` / `langfuseProjectSecretKey`) so `agent add`
writes them into each agent's `.env` — see [langfuse.md](langfuse.md).

## Deploy

```bash
wrapper agent add my-agent --channels "#somewhere"   # Slack app + scaffold, as always
wrapper up my-agent
```

`up` runs, in order:

1. `aws ecr get-login-password | docker login` (ECR repos auto-created).
2. Build `docker/runtime.Dockerfile` for `linux/<arch>`, push
   `<repoPrefix>/wrapper-runtime:latest`.
3. Apply Namespace + ServiceAccount (generated `k8s/namespace.yaml`).
4. Per agent: build its image (custom `Dockerfile` first if present, then a
   generated layer that bakes `agents/<name>/` in), push, **sync the Secret
   from `agents/<name>/.env`**, apply the manifest, rollout, wait.

Day-to-day is identical to local mode:

```bash
wrapper status                          # pod states + langfuse UI link
wrapper logs my-agent -f
wrapper env set my-agent K=V && wrapper restart my-agent   # restart re-syncs the Secret
wrapper down my-agent                   # scales to 0 (PVC/session history kept)
wrapper agent remove my-agent [--purge] # delete Deployment+Secret (+PVC with --purge)
```

Never run an agent's local container and its pod at the same time — both hold
Slack Socket Mode connections and events get split between them.

## LLM credentials

**Option A — Bedrock via IRSA (recommended: no static keys in the cluster).**
pi's Bedrock provider falls back to the AWS SDK default credential chain, so a
pod running as an IRSA-annotated ServiceAccount just works:

```bash
# once per cluster: make sure the OIDC provider is registered in IAM
eksctl utils associate-iam-oidc-provider --cluster <cluster> --approve

# a role trusting system:serviceaccount:wrapper-agents:wrapper-agents,
# with ONLY bedrock:InvokeModel + bedrock:InvokeModelWithResponseStream
aws iam create-role --role-name wrapper-agents-eks ... 
aws iam put-role-policy ...

# annotate the live ServiceAccount (survives manifest regeneration by design —
# see k8s-manifests.md §Customizing)
kubectl -n wrapper-agents annotate serviceaccount wrapper-agents \
  eks.amazonaws.com/role-arn=arn:aws:iam::<account>:role/wrapper-agents-eks
```

Then `model: amazon-bedrock/<model-id>` in `agent.yaml`. `AWS_REGION` is
injected into pods from `k8s.awsRegion`.

**Option B — provider API keys**: `wrapper env set my-agent
ANTHROPIC_API_KEY=…` (lands in the agent's Secret) and `model: anthropic/…`.
Note that in k8s mode there is no shared `agents/.env` — keys are per agent.

## Production hardening checklist

The generated pods are already hardened (non-root, read-only rootfs, cap-drop
ALL, seccomp, no privilege escalation, resource limits, no
Service/Ingress). What the generator does *not* do for you, in priority order:

1. **Egress NetworkPolicy** — default-deny egress in the namespace, allowing
   only DNS, Slack, your LLM endpoint (e.g.
   `bedrock-runtime.<region>.amazonaws.com`), Langfuse, and whatever your
   tools call. Without it a compromised agent can reach anything.
2. **Secrets encryption at rest** — enable EKS envelope encryption with a KMS
   key (`aws eks associate-encryption-config`); tighten RBAC on `secrets` in
   the namespace (they hold Slack tokens + provider keys).
3. **Encrypted session storage** — use a StorageClass with `encrypted: "true"`
   (+ KMS key) or enable account-level EBS default encryption; the PVC stores
   full conversation transcripts.
4. **Image supply chain** — enable ECR scan-on-push; consider pinning
   deployments to image digests instead of the floating `:latest`.
5. **Node IMDS** — set `HttpTokens=required`, `HttpPutResponseHopLimit=1` on
   node groups so pods can't borrow the node role.
6. **Slack exposure** — remember the bot answers DMs from *any* workspace
   member (see [agents.md](agents.md)); scope tool credentials read-only.
