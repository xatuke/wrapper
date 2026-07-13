import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ScaffoldOptions {
  name: string;
  model: string;
  channels: string[];
}

const PROMPT_TEMPLATE = `You are {{name}}, a helpful Slack assistant.

Keep replies concise and formatted for Slack (plain text, *bold*, \`code\`).
`;

const TIME_TOOL = `import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const tool: AgentTool = {
  name: "current_time",
  label: "Current time",
  description: "Get the current date and time (ISO 8601, UTC).",
  parameters: Type.Object({}),
  async execute() {
    return {
      content: [{ type: "text", text: new Date().toISOString() }],
      details: undefined,
    };
  },
};

export default tool;
`;

// Agents are typically version-controlled separately from wrapper (nested git
// repos under agents/ — see agents/README.md), so each level gets its own
// secret-excluding .gitignore regardless of which layout the user picks.
const AGENT_GITIGNORE = `# secrets & local state — never commit
.env
data/
slack/.slack/
*service-account*.json
`;

const AGENTS_DIR_GITIGNORE = `# Secrets & local state of ALL agents — applies when this folder (or a parent
# of it) is its own git repo. Never commit these.
.env
*/.env
*/data/
*/slack/.slack/
*/*service-account*.json
`;

const AGENTS_DIR_README = `# agents/ — yours, not wrapper's

Wrapper's git ignores this whole folder: your agents are your code. Version
them yourself — either \`git init\` here (one repo for all agents; the
.gitignore next to this file keeps secrets out) or one repo per agent dir.
Committing your \`wrapper.yaml\` here too makes your deployment restorable
from this one private repo (the CLI reads agents/wrapper.yaml when the repo
root has none).

Shared provider API keys for all agents live in .env here (per-agent .env
overrides them). Never commit: .env files, data/, slack/.slack/,
service-account JSONs.

How to build agents: see docs/agents.md in the wrapper repo.
`;

export function scaffoldAgent(dir: string, opts: ScaffoldOptions): void {
  if (existsSync(join(dir, "agent.yaml"))) {
    throw new Error(`Agent already exists: ${dir}`);
  }
  mkdirSync(join(dir, "tools"), { recursive: true });
  mkdirSync(join(dir, "slack"), { recursive: true });

  writeFileSync(join(dir, ".gitignore"), AGENT_GITIGNORE);
  // agents/ is entirely untracked by wrapper's git, so the scaffolder owns
  // seeding its README + secret-excluding .gitignore (only if absent — the
  // user's own agents repo may have customized them).
  const agentsDir = dirname(dir);
  if (!existsSync(join(agentsDir, ".gitignore"))) {
    writeFileSync(join(agentsDir, ".gitignore"), AGENTS_DIR_GITIGNORE);
  }
  if (!existsSync(join(agentsDir, "README.md"))) {
    writeFileSync(join(agentsDir, "README.md"), AGENTS_DIR_README);
  }

  writeFileSync(
    join(dir, "agent.yaml"),
    [
      `name: ${opts.name}`,
      `mode: chat`,
      `model: ${opts.model}`,
      `systemPrompt: ./prompt.md`,
      `channels: ${JSON.stringify(opts.channels)}`,
      `tools:`,
      `  - ./tools/time.ts`,
      ``,
    ].join("\n"),
  );
  writeFileSync(join(dir, "prompt.md"), PROMPT_TEMPLATE.replaceAll("{{name}}", opts.name));
  writeFileSync(join(dir, "tools", "time.ts"), TIME_TOOL);
  writeFileSync(
    join(dir, ".env"),
    `# Secrets for agent '${opts.name}' — never commit this file.\n`,
    { mode: 0o600 },
  );
}
