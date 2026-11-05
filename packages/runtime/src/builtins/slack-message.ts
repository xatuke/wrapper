import { WebClient } from "@slack/web-api";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { turnContext } from "../turn-context.js";

/** Per-turn ceiling so a looping model can't flood a thread. */
const MAX_PER_TURN = Number(process.env.SLACK_MESSAGES_PER_TURN ?? 20);

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/**
 * Lets the model post to the current Slack conversation while it is still
 * working — progress on a long job, a partial result, or a question — instead
 * of staying silent behind "thinking…" until the final reply.
 */
export function createSlackMessageTools(): AgentTool[] {
  let client: WebClient | undefined;

  const post: AgentTool = {
    name: "slack_message",
    label: "Post a Slack message now",
    description:
      "Post a message to the current Slack conversation immediately, while you keep working. Use it " +
      "for progress on long jobs (what you're pulling, what's done, rough time left), to share a " +
      "partial result early, or to flag a problem. Your final answer is still your normal reply — " +
      "don't repeat it here. Slack mrkdwn is supported. Keep updates short and only at real milestones.",
    parameters: Type.Object({
      text: Type.String({ description: "message text (Slack mrkdwn)" }),
    }),
    async execute(_id, params: any) {
      const token = process.env.SLACK_BOT_TOKEN;
      if (!token) return text("SLACK_BOT_TOKEN not set.");
      const ctx = turnContext.getStore();
      if (!ctx?.channel) return text("No current Slack conversation to post to.");
      const body = String(params?.text ?? "").trim();
      if (!body) return text("Empty message — nothing posted.");

      ctx.posted = (ctx.posted ?? 0) + 1;
      if (ctx.posted > MAX_PER_TURN) {
        return text(`Not posted: already sent ${MAX_PER_TURN} messages in this request. Put the rest in your final reply.`);
      }

      client ??= new WebClient(token);
      // DM replies are not threaded (matches how the placeholder is posted).
      const threadTs = ctx.channel.startsWith("D") ? undefined : ctx.threadTs;
      try {
        await client.chat.postMessage({ channel: ctx.channel, text: body, ...(threadTs ? { thread_ts: threadTs } : {}) });
        return text("Posted. Keep working; give your final answer as your normal reply.");
      } catch (err: any) {
        return text(`Slack post failed: ${err?.data?.error ?? err?.message}`);
      }
    },
  };

  return [post];
}
