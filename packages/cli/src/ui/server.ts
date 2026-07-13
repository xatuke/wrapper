import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { listAgents, serviceName, generateCompose } from "../compose.js";
import { readEnvFile, removeEnvKeys, upsertEnvFile } from "../env-file.js";
import { run } from "../exec.js";
import { agentDir, findRoot, loadWrapperConfig } from "../root.js";
import { pageHtml } from "./page.js";

const SECRET_PATTERN = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|EDGERC|_B64)/i;
const STACK_SERVICES = ["langfuse-web", "langfuse-worker", "postgres", "clickhouse", "redis", "minio"];

interface PsEntry {
  Service: string;
  State: string;
  Status: string;
  Health?: string;
}

function composePs(root: string): Map<string, PsEntry> {
  const res = run("docker", ["compose", "-f", join(root, "docker-compose.yml"), "ps", "-a", "--format", "json"], {
    cwd: root,
    allowFail: true,
  });
  const out = new Map<string, PsEntry>();
  for (const line of res.stdout.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t);
      for (const e of Array.isArray(parsed) ? parsed : [parsed]) out.set(e.Service, e);
    } catch {
      // non-JSON line (warnings etc.)
    }
  }
  return out;
}

function agentMeta(root: string, name: string): { model: string; channels: string[] } {
  try {
    const raw = parse(readFileSync(join(agentDir(root, name), "agent.yaml"), "utf8"));
    return {
      model: String(raw?.model ?? "?"),
      channels: Array.isArray(raw?.channels) ? raw.channels.map(String) : [],
    };
  } catch {
    return { model: "?", channels: [] };
  }
}

function json(res: any, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: any): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString();
  return text ? JSON.parse(text) : {};
}

export async function uiCommand(opts: { port: number }): Promise<void> {
  const root = findRoot();
  const config = loadWrapperConfig(root);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, body: unknown) => json(res, code, body);

    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(pageHtml());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        const ps = composePs(root);
        let langfuseHealthy = false;
        try {
          const r = await fetch(config.langfuse.baseUrl.replace(/\/$/, "") + "/api/public/health", {
            signal: AbortSignal.timeout(2000),
          });
          langfuseHealthy = r.ok;
        } catch {
          // unreachable
        }
        send(200, {
          langfuse: { healthy: langfuseHealthy, baseUrl: config.langfuse.baseUrl },
          stack: STACK_SERVICES.map((s) => ({
            service: s,
            status: ps.get(s)?.Status ?? "not created",
            up: ps.get(s)?.State === "running",
          })),
          agents: listAgents(root).map((name) => {
            const e = ps.get(serviceName(name));
            return {
              name,
              ...agentMeta(root, name),
              status: e?.Status ?? "not created",
              state: e?.State ?? "missing",
              health: e?.Health ?? "",
              hasSlack: Boolean(readEnvFile(join(agentDir(root, name), ".env")).SLACK_BOT_TOKEN),
            };
          }),
        });
        return;
      }

      const action = url.pathname.match(/^\/api\/agents\/([a-z0-9-]+)\/(action|logs|env)$/);
      if (action) {
        const [, name, kind] = action;
        if (!listAgents(root).includes(name!)) {
          send(404, { error: `unknown agent ${name}` });
          return;
        }
        const service = serviceName(name!);
        const envFile = join(agentDir(root, name!), ".env");

        if (kind === "action" && req.method === "POST") {
          const { op } = await readBody(req);
          if (op === "up") {
            generateCompose(root);
            run("docker", ["compose", "-f", join(root, "docker-compose.yml"), "up", "-d", service], { cwd: root });
          } else if (op === "down") {
            run("docker", ["compose", "-f", join(root, "docker-compose.yml"), "stop", service], { cwd: root });
          } else if (op === "restart") {
            run("docker", ["compose", "-f", join(root, "docker-compose.yml"), "restart", service], { cwd: root });
          } else {
            send(400, { error: `unknown op ${op}` });
            return;
          }
          send(200, { ok: true });
          return;
        }

        if (kind === "logs" && req.method === "GET") {
          const r = run(
            "docker",
            ["compose", "-f", join(root, "docker-compose.yml"), "logs", "--no-color", "--tail", "300", service],
            { cwd: root, allowFail: true },
          );
          send(200, { text: r.stdout || r.stderr });
          return;
        }

        if (kind === "env") {
          if (req.method === "GET") {
            const env = readEnvFile(envFile);
            send(200, {
              vars: Object.entries(env).map(([k, v]) => ({
                key: k,
                value: SECRET_PATTERN.test(k) ? `${v.slice(0, 4)}… (${v.length} chars)` : v,
                secret: SECRET_PATTERN.test(k),
              })),
            });
            return;
          }
          if (req.method === "POST") {
            const body = await readBody(req);
            if (body.set) upsertEnvFile(envFile, body.set);
            if (Array.isArray(body.unset) && body.unset.length) removeEnvKeys(envFile, body.unset);
            send(200, { ok: true });
            return;
          }
        }
      }

      send(404, { error: "not found" });
    } catch (err: any) {
      send(500, { error: err?.message ?? String(err) });
    }
  });

  server.listen(opts.port, "127.0.0.1", () => {
    console.log(`wrapper ui → http://localhost:${opts.port}`);
  });
  await new Promise(() => {});
}
