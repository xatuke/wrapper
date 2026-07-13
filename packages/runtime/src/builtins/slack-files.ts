import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { WebClient } from "@slack/web-api";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { turnContext } from "../turn-context.js";

/**
 * Upload a file from the agent's workspace to Slack. Requires the bot to have
 * the `files:write` scope and to be a member of the target channel. Channel and
 * thread default to the current conversation (via turn-context).
 */
export function createSlackFileTools(dataDir: string): AgentTool[] {
  const root = join(dataDir, "workspace");

  function safePath(p: string): string {
    const abs = resolve(root, p.replace(/^\/+/, ""));
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`Path escapes the workspace: ${p}`);
    return abs;
  }

  const upload: AgentTool = {
    name: "slack_upload",
    label: "Upload a file to Slack",
    description:
      "Upload a file from your workspace (/data/workspace) to Slack — charts, CSVs, reports, " +
      "screenshots. Defaults to the current channel/thread. Use this to deliver generated " +
      "artifacts (e.g. a matplotlib PNG or a browser screenshot you saved).",
    parameters: Type.Object({
      path: Type.String({ description: "workspace-relative file path, e.g. 'reports/traffic.png'" }),
      title: Type.Optional(Type.String()),
      comment: Type.Optional(Type.String({ description: "message posted with the file" })),
      channel: Type.Optional(Type.String({ description: "channel id (default: current channel)" })),
    }),
    async execute(_id, params: any) {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) return { content: [{ type: "text" as const, text: "SLACK_BOT_TOKEN not set." }], details: undefined };
      const ctx = turnContext.getStore();
      const channel = params.channel ?? ctx?.channel;
      if (!channel) return { content: [{ type: "text" as const, text: "No channel to upload to (pass `channel`)." }], details: undefined };

      let abs: string;
      try {
        abs = safePath(params.path);
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: err.message }], details: undefined };
      }
      if (!existsSync(abs)) return { content: [{ type: "text" as const, text: `No such file: ${params.path}` }], details: undefined };
      if (statSync(abs).isDirectory()) return { content: [{ type: "text" as const, text: "Path is a directory." }], details: undefined };

      const client = new WebClient(token);
      try {
        const res: any = await client.files.uploadV2({
          channel_id: channel,
          file: abs,
          filename: params.path.split("/").pop() ?? "file",
          title: params.title,
          initial_comment: params.comment,
          ...(ctx?.threadTs ? { thread_ts: ctx.threadTs } : {}),
        } as any);
        const f = res?.files?.[0]?.files?.[0] ?? res?.file;
        return { content: [{ type: "text" as const, text: `Uploaded ${params.path} to <#${channel}>${f?.permalink ? ` (${f.permalink})` : ""}.` }], details: undefined };
      } catch (err: any) {
        return { content: [{ type: "text" as const, text: `Slack upload failed: ${err?.data?.error ?? err?.message}` }], details: undefined };
      }
    },
  };

  return [upload];
}
