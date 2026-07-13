import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

const MAX_READ_CHARS = 60_000;
const MAX_LIST_ENTRIES = 500;

export function createWorkspaceTools(dataDir: string): AgentTool[] {
  const root = join(dataDir, "workspace");

  function safePath(p: string): string {
    const abs = resolve(root, p.replace(/^\/+/, ""));
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`Path escapes the workspace: ${p}`);
    }
    return abs;
  }

  const write: AgentTool = {
    name: "workspace_write",
    label: "Write a workspace file",
    description:
      "Write (or append to) a file in your persistent workspace (/data/workspace, survives " +
      "restarts). Use it for reports, CSV extracts, scratch notes, anything you want to keep " +
      "or build up over time. Parent directories are created automatically.",
    parameters: Type.Object({
      path: Type.String({ description: "relative path, e.g. 'reports/2026-07-weekly.md'" }),
      content: Type.String(),
      append: Type.Optional(Type.Boolean({ description: "append instead of overwrite" })),
    }),
    async execute(_id, params: any) {
      const abs = safePath(params.path);
      mkdirSync(dirname(abs), { recursive: true });
      if (params.append) appendFileSync(abs, params.content);
      else writeFileSync(abs, params.content);
      const size = statSync(abs).size;
      return { content: [{ type: "text" as const, text: `Wrote ${relative(root, abs)} (${size} bytes).` }], details: undefined };
    },
  };

  const read: AgentTool = {
    name: "workspace_read",
    label: "Read a workspace file",
    description: "Read a file from your persistent workspace. Large files are truncated; use offset to page.",
    parameters: Type.Object({
      path: Type.String(),
      offset: Type.Optional(Type.Number({ description: "character offset to start from (default 0)" })),
    }),
    async execute(_id, params: any) {
      const abs = safePath(params.path);
      if (!existsSync(abs)) return { content: [{ type: "text" as const, text: `No such file: ${params.path}` }], details: undefined };
      const full = readFileSync(abs, "utf8");
      const start = Math.max(0, params.offset ?? 0);
      const chunk = full.slice(start, start + MAX_READ_CHARS);
      const note = start + chunk.length < full.length ? `\n[TRUNCATED at ${start + chunk.length} of ${full.length} chars — re-read with offset=${start + chunk.length}]` : "";
      return { content: [{ type: "text" as const, text: chunk + note }], details: undefined };
    },
  };

  const list: AgentTool = {
    name: "workspace_list",
    label: "List workspace files",
    description: "List files in your persistent workspace (recursive), with sizes and mtimes.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "subdirectory to list (default: whole workspace)" })),
    }),
    async execute(_id, params: any) {
      const base = safePath(params.path ?? ".");
      if (!existsSync(base)) return { content: [{ type: "text" as const, text: "(empty workspace)" }], details: undefined };
      const out: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (out.length >= MAX_LIST_ENTRIES) return;
          const abs = join(dir, entry.name);
          if (entry.isDirectory()) walk(abs);
          else {
            const st = statSync(abs);
            out.push(`${relative(root, abs)}  ${st.size}B  ${st.mtime.toISOString().slice(0, 16)}`);
          }
        }
      };
      walk(base);
      return {
        content: [{ type: "text" as const, text: out.length ? out.join("\n") + (out.length >= MAX_LIST_ENTRIES ? "\n[list capped]" : "") : "(empty)" }],
        details: undefined,
      };
    },
  };

  const del: AgentTool = {
    name: "workspace_delete",
    label: "Delete a workspace file",
    description: "Delete a workspace file, or a directory with recursive=true.",
    parameters: Type.Object({
      path: Type.String(),
      recursive: Type.Optional(Type.Boolean({ description: "required to delete a directory" })),
    }),
    async execute(_id, params: any) {
      const abs = safePath(params.path);
      if (abs === root) return { content: [{ type: "text" as const, text: "Refusing to delete the workspace root." }], details: undefined };
      if (!existsSync(abs)) return { content: [{ type: "text" as const, text: `No such path: ${params.path}` }], details: undefined };
      const isDir = statSync(abs).isDirectory();
      if (isDir && !params.recursive) return { content: [{ type: "text" as const, text: "That is a directory — pass recursive=true to delete it." }], details: undefined };
      rmSync(abs, { recursive: Boolean(params.recursive) });
      return { content: [{ type: "text" as const, text: `Deleted ${relative(root, abs)}.` }], details: undefined };
    },
  };

  return [write, read, list, del];
}
