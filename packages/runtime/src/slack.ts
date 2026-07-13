import bolt from "@slack/bolt";
import type { AgentConfig } from "./config.js";

const { App } = bolt;

export interface IncomingMessage {
  sessionKey: string;
  text: string;
  userId: string;
  channel: string;
  threadTs: string;
}

export type TurnHandler = (msg: IncomingMessage) => Promise<string>;

export interface SlackConnection {
  app: InstanceType<typeof App>;
  botUserId: string;
  stop: () => Promise<void>;
}

/**
 * Connects via Socket Mode. The agent answers:
 *  - @mentions in channels (thread-scoped sessions)
 *  - every message in DMs (channel-scoped sessions)
 * If config.channels is non-empty it acts as an allowlist for channel events.
 */
export async function startSlack(
  config: AgentConfig,
  tokens: { botToken: string; appToken: string },
  onTurn: TurnHandler,
): Promise<SlackConnection> {
  const app = new App({
    token: tokens.botToken,
    appToken: tokens.appToken,
    socketMode: true,
  });

  const auth = await app.client.auth.test();
  const botUserId = auth.user_id as string;

  // Resolve configured channel names to IDs for the allowlist.
  const allowed = new Set<string>();
  if (config.channels.length > 0) {
    const wanted = new Set(config.channels.map((c) => c.replace(/^#/, "")));
    for (const c of config.channels) if (/^[CG][A-Z0-9]{6,}$/.test(c)) allowed.add(c);
    try {
      let cursor: string | undefined;
      do {
        const res = await app.client.conversations.list({
          limit: 200,
          cursor,
          types: "public_channel,private_channel",
        });
        for (const ch of res.channels ?? []) {
          if (ch.name && wanted.has(ch.name) && ch.id) allowed.add(ch.id);
        }
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (err: any) {
      console.warn("[slack] could not resolve channel names:", err?.data?.error ?? err?.message);
    }
  }

  async function handle(event: any, say: any, client: any, stripMention: boolean) {
    if (event.bot_id || event.user === botUserId) return;
    let text: string = event.text ?? "";
    if (stripMention) text = text.replaceAll(`<@${botUserId}>`, "").trim();
    if (!text) return;

    const isDm = event.channel_type === "im";
    const threadTs = event.thread_ts ?? event.ts;
    const sessionKey = isDm ? `dm-${event.channel}` : `${event.channel}-${threadTs}`;

    const placeholder = await say({ text: "_thinking…_", thread_ts: isDm ? undefined : threadTs });
    try {
      const reply = await onTurn({
        sessionKey,
        text,
        userId: event.user,
        channel: event.channel,
        threadTs,
      });
      await client.chat.update({
        channel: placeholder.channel,
        ts: placeholder.ts,
        text: reply || "(no reply)",
      });
    } catch (err: any) {
      console.error("[slack] turn failed:", err);
      await client.chat.update({
        channel: placeholder.channel,
        ts: placeholder.ts,
        text: `:warning: agent error: ${err?.message ?? err}`,
      });
    }
  }

  app.event("app_mention", async ({ event, say, client }) => {
    if (allowed.size > 0 && !allowed.has(event.channel)) return;
    await handle(event, say, client, true);
  });

  app.message(async ({ message, say, client }) => {
    const m = message as any;
    if (m.channel_type !== "im" || m.subtype) return;
    await handle(m, say, client, false);
  });

  await app.start();
  console.log(`[slack] connected as ${auth.user} (${botUserId})`);
  return {
    app,
    botUserId,
    stop: async () => {
      await app.stop();
    },
  };
}
