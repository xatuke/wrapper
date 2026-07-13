import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";

/**
 * Load tool modules listed in agent.yaml. A module's default export may be an
 * AgentTool, an array of them, or a (possibly async) factory returning either.
 */
export async function loadTools(agentDir: string, paths: string[]): Promise<AgentTool[]> {
  const tools: AgentTool[] = [];
  for (const p of paths) {
    const url = pathToFileURL(resolve(agentDir, p)).href;
    const mod = await import(url);
    let exported = mod.default ?? mod.tool ?? mod.tools;
    if (typeof exported === "function") exported = await exported();
    const list = Array.isArray(exported) ? exported : [exported];
    for (const t of list) {
      if (!t?.name || typeof t.execute !== "function") {
        throw new Error(`Tool module ${p} does not export a valid AgentTool`);
      }
      tools.push(t);
    }
  }
  return tools;
}
