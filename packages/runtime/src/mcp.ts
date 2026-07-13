import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildSandboxEnv } from "./builtins/sandbox-env.js";

export interface McpServerConfig {
  name: string; // short prefix for the tools, e.g. "browser"
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConnection {
  tools: AgentTool[];
  close: () => Promise<void>;
}

const CALL_TIMEOUT_MS = 180_000;

/** Down-convert MCP tool-result content blocks to pi's (text | image) union. */
function mapContent(content: any[]): { type: "text" | "image"; text?: string; data?: string; mimeType?: string }[] {
  const out: any[] = [];
  for (const block of content ?? []) {
    if (block?.type === "text") out.push({ type: "text", text: block.text });
    else if (block?.type === "image" && block.data) out.push({ type: "image", data: block.data, mimeType: block.mimeType ?? "image/png" });
    else if (block?.type === "resource" && block.resource) {
      const r = block.resource;
      out.push({ type: "text", text: r.text ?? `[resource ${r.uri ?? ""} ${r.mimeType ?? ""}]` });
    } else if (block?.type === "audio") out.push({ type: "text", text: "[audio omitted]" });
  }
  return out.length ? out : [{ type: "text", text: "(no content)" }];
}

/**
 * Connect to one stdio MCP server and expose its tools as AgentTools. The
 * server subprocess gets the secret-stripped sandbox env (see sandbox-env.ts)
 * plus any explicit env from the config.
 */
export async function connectMcpServer(cfg: McpServerConfig, dataDir: string): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args ?? [],
    env: { ...(buildSandboxEnv(dataDir) as Record<string, string>), ...(cfg.env ?? {}) },
    stderr: "inherit",
  });
  const client = new Client({ name: `wrapper-${cfg.name}`, version: "0.1.0" });
  await client.connect(transport);

  const { tools: mcpTools } = await client.listTools();
  const tools: AgentTool[] = mcpTools.map(
    (t): AgentTool => ({
      name: `${cfg.name}_${t.name}`,
      label: t.title ?? t.name,
      description: (t.description ?? `${cfg.name} ${t.name}`).slice(0, 1024),
      // pi passes `parameters` straight through as the JSON input schema — the raw
      // MCP inputSchema ({type:object, properties, required}) is exactly right.
      parameters: (t.inputSchema ?? { type: "object", properties: {} }) as any,
      async execute(_id: string, params: any, signal?: AbortSignal) {
        const res: any = await client.callTool(
          { name: t.name, arguments: params ?? {} },
          undefined,
          { timeout: CALL_TIMEOUT_MS, signal },
        );
        const content = mapContent(res?.content);
        if (res?.isError) content.unshift({ type: "text", text: "[tool reported an error]" });
        return { content: content as any, details: undefined };
      },
    }),
  );

  return {
    tools,
    close: async () => {
      await client.close().catch(() => {});
    },
  };
}

/** Connect all configured MCP servers; returns their combined tools + a closer. */
export async function connectMcpServers(
  servers: McpServerConfig[],
  dataDir: string,
): Promise<McpConnection> {
  const conns: McpConnection[] = [];
  for (const cfg of servers) {
    try {
      const conn = await connectMcpServer(cfg, dataDir);
      conns.push(conn);
      console.log(`[mcp] connected '${cfg.name}' — ${conn.tools.length} tool(s)`);
    } catch (err: any) {
      console.error(`[mcp] failed to connect '${cfg.name}': ${err?.message ?? err}`);
    }
  }
  return {
    tools: conns.flatMap((c) => c.tools),
    close: async () => {
      await Promise.all(conns.map((c) => c.close()));
    },
  };
}
