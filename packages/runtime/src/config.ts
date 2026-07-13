import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

export interface AgentConfig {
  name: string;
  mode: "chat" | "workspace";
  model: string; // "provider/model-id"
  systemPrompt: string; // resolved to the actual prompt text
  channels: string[]; // channel names or IDs the agent responds in; empty = anywhere invited
  tools: string[]; // paths to tool modules, relative to the agent dir
  features: string[]; // runtime builtins to enable: cron | memory | workspace | code | slack-files
  mcpServers: McpServerConfig[]; // stdio MCP servers to bridge in
  thinkingLevel?: string;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface RuntimeEnv {
  agentDir: string;
  dataDir: string;
  slackBotToken: string;
  slackAppToken: string;
}

export async function loadAgentConfig(agentDir: string): Promise<AgentConfig> {
  const raw = parse(await readFile(resolve(agentDir, "agent.yaml"), "utf8"));
  if (!raw?.name) throw new Error("agent.yaml: 'name' is required");
  if (!raw?.model) throw new Error("agent.yaml: 'model' is required (e.g. anthropic/claude-sonnet-4-5)");

  let systemPrompt: string = raw.systemPrompt ?? "You are a helpful assistant.";
  // A value that points at an existing file is read as the prompt body.
  const promptPath = resolve(agentDir, systemPrompt);
  if (systemPrompt.length < 500 && existsSync(promptPath)) {
    systemPrompt = await readFile(promptPath, "utf8");
  }

  return {
    name: String(raw.name),
    mode: raw.mode === "workspace" ? "workspace" : "chat",
    model: String(raw.model),
    systemPrompt,
    channels: Array.isArray(raw.channels) ? raw.channels.map(String) : [],
    tools: Array.isArray(raw.tools) ? raw.tools.map(String) : [],
    features: Array.isArray(raw.features) ? raw.features.map(String) : [],
    mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
    thinkingLevel: raw.thinkingLevel ? String(raw.thinkingLevel) : undefined,
  };
}

export function loadRuntimeEnv(): RuntimeEnv {
  const agentDir = process.env.AGENT_DIR ?? process.argv[2] ?? process.cwd();
  const dataDir = process.env.DATA_DIR ?? resolve(agentDir, "data");
  const slackBotToken = process.env.SLACK_BOT_TOKEN ?? "";
  const slackAppToken = process.env.SLACK_APP_TOKEN ?? "";
  if (!slackBotToken || !slackAppToken) {
    throw new Error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN must be set");
  }
  return { agentDir, dataDir, slackBotToken, slackAppToken };
}
