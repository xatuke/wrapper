import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const MAX_MEMORY_CHARS = 64_000;

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export function memoryDir(dataDir: string): string {
  return join(dataDir, "memory");
}

/** One-line-per-memory index injected into the system prompt each turn. */
export function memoryPromptSection(dataDir: string): string {
  const dir = memoryDir(dataDir);
  if (!existsSync(dir)) return "";
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const firstLine = readFileSync(join(dir, f), "utf8").split("\n", 1)[0] ?? "";
      return `- ${f.replace(/\.md$/, "")}: ${firstLine.slice(0, 150)}`;
    });
  if (entries.length === 0) return "";
  return `\n\n## Your persistent memories (read the full text with memory_read)\n${entries.join("\n")}`;
}

export function createMemoryTools(dataDir: string): AgentTool[] {
  const dir = memoryDir(dataDir);

  const save: AgentTool = {
    name: "memory_save",
    label: "Save a memory",
    description:
      "Save (or overwrite) a persistent memory that survives across all conversations and " +
      "restarts. Use for durable facts users tell you, data quirks you discover, standing " +
      "preferences, and lessons learned. `content` MUST start with a one-line summary — that " +
      "line is shown in your system prompt every turn.",
    parameters: Type.Object({
      name: Type.String({ description: "short kebab-case name, e.g. 'site-62-quirks'" }),
      content: Type.String({ description: "the memory; first line = one-line summary" }),
    }),
    async execute(_id, params: any) {
      const name = slug(params.name);
      if (!name) return { content: [{ type: "text" as const, text: "Invalid name." }], details: undefined };
      if (params.content.length > MAX_MEMORY_CHARS) {
        return { content: [{ type: "text" as const, text: `Memory too large (${params.content.length} chars, cap ${MAX_MEMORY_CHARS}).` }], details: undefined };
      }
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name + ".md"), params.content);
      return { content: [{ type: "text" as const, text: `Saved memory '${name}'.` }], details: undefined };
    },
  };

  const read: AgentTool = {
    name: "memory_read",
    label: "Read a memory",
    description: "Read the full text of a saved memory by name.",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params: any) {
      const file = join(dir, slug(params.name) + ".md");
      if (!existsSync(file)) return { content: [{ type: "text" as const, text: `No memory named '${params.name}'.` }], details: undefined };
      return { content: [{ type: "text" as const, text: readFileSync(file, "utf8") }], details: undefined };
    },
  };

  const list: AgentTool = {
    name: "memory_list",
    label: "List memories",
    description: "List all saved memories with their one-line summaries.",
    parameters: Type.Object({}),
    async execute() {
      const section = memoryPromptSection(dataDir).trim();
      return { content: [{ type: "text" as const, text: section || "No memories saved yet." }], details: undefined };
    },
  };

  const del: AgentTool = {
    name: "memory_delete",
    label: "Delete a memory",
    description: "Delete a saved memory by name (when it is wrong or obsolete).",
    parameters: Type.Object({ name: Type.String() }),
    async execute(_id, params: any) {
      const file = join(dir, slug(params.name) + ".md");
      if (!existsSync(file)) return { content: [{ type: "text" as const, text: `No memory named '${params.name}'.` }], details: undefined };
      rmSync(file);
      return { content: [{ type: "text" as const, text: `Deleted memory '${params.name}'.` }], details: undefined };
    },
  };

  return [save, read, list, del];
}
