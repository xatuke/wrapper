import bolt from "@slack/bolt";
import type { AgentConfig } from "./config.js";
import type { PendingStore } from "./pending.js";

const { App } = bolt;

export interface IncomingMessage {
  sessionKey: string;
  text: string;
  userId: string;
  channel: string;
  threadTs: string;
}

export type TurnHandler = (msg: IncomingMessage) => Promise<string>;

/**
 * Called before a message starts a new turn. If a turn is already running in
 * the same conversation the message is handed to it instead: "stop" aborts it,
 * anything else is injected into it. "idle-stop" = a stop with nothing running.
 */
export type InterruptHandler = (sessionKey: string, text: string, userId: string) => "stopped" | "injected" | "idle-stop" | undefined;

export interface SlackConnection {
  app: InstanceType<typeof App>;
  botUserId: string;
  stop: () => Promise<void>;
}

/**
 * Connects via Socket Mode. The agent answers:
 *  - @mentions in channels (thread-scoped sessions)
 *  - messages in DMs (channel-scoped sessions)
 * If config.channels is non-empty it acts as an allowlist for channel events.
 * If config.dmUsers is non-empty, only those users get DM replies (IDs,
 * @handles, or emails — resolved to IDs at startup).
 */
export async function startSlack(
  config: AgentConfig,
  tokens: { botToken: string; appToken: string },
  onTurn: TurnHandler,
  pending: PendingStore,
  onInterrupt?: InterruptHandler,
  /** Is the agent already part of this conversation (running or saved session)? */
  isEngaged?: (sessionKey: string) => boolean,
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

  // Resolve the DM allowlist (IDs pass through; @handles / display names /
  // emails are matched against the workspace member list). Fail-closed: when
  // dmUsers is configured, unresolved entries mean fewer allowed users — never
  // an open bot.
  const dmRestricted = config.dmUsers.length > 0;
  const dmAllowed = new Set<string>();
  if (dmRestricted) {
    const unresolved: string[] = [];
    const wanted = new Map<string, string>(); // normalized handle/email -> original
    for (const u of config.dmUsers) {
      if (/^[UW][A-Z0-9]{6,}$/.test(u)) dmAllowed.add(u);
      else wanted.set(u.replace(/^@/, "").toLowerCase(), u);
    }
    if (wanted.size > 0) {
      try {
        let cursor: string | undefined;
        do {
          const res = await app.client.users.list({ limit: 200, cursor });
          for (const m of res.members ?? []) {
            const keys = [
              m.name,
              m.profile?.display_name,
              m.profile?.real_name,
              m.profile?.email,
            ]
              .filter(Boolean)
              .map((s) => String(s).toLowerCase());
            if (m.id && keys.some((k) => wanted.has(k))) {
              dmAllowed.add(m.id);
              for (const k of keys) wanted.delete(k);
            }
          }
          cursor = res.response_metadata?.next_cursor || undefined;
        } while (cursor);
      } catch (err: any) {
        console.warn("[slack] could not resolve dmUsers:", err?.data?.error ?? err?.message);
      }
      unresolved.push(...wanted.values());
    }
    if (unresolved.length > 0) {
      console.warn(`[slack] dmUsers not found in workspace: ${unresolved.join(", ")}`);
    }
    if (dmAllowed.size === 0) {
      console.warn("[slack] dmUsers configured but NONE resolved — all DMs will be refused");
    }
    console.log(`[slack] DMs restricted to ${dmAllowed.size} user(s)`);
  }

  async function handle(event: any, say: any, client: any, stripMention: boolean) {
    if (event.bot_id || event.user === botUserId) return;
    let text: string = event.text ?? "";
    if (stripMention) text = text.replaceAll(`<@${botUserId}>`, "").trim();
    if (!text) return;

    const isDm = event.channel_type === "im";
    const threadTs = event.thread_ts ?? event.ts;
    const sessionKey = isDm ? `dm-${event.channel}` : `${event.channel}-${threadTs}`;

    const replyThread = isDm ? undefined : threadTs;
    const intr = onInterrupt?.(sessionKey, text, event.user);
    if (intr === "stopped") {
      await say({ text: ":octagonal_sign: Stopping…", thread_ts: replyThread });
      return;
    }
    if (intr === "idle-stop") {
      await say({ text: "Nothing is running right now.", thread_ts: replyThread });
      return;
    }
    if (intr === "injected") {
      // Acknowledge without a new placeholder — the running turn's reply covers it.
      await client.reactions
        .add({ channel: event.channel, timestamp: event.ts, name: "eyes" })
        .catch(() => say({ text: "_Got it — adding that to what I'm working on._", thread_ts: replyThread }));
      return;
    }

    const placeholder = await say({ text: "_thinking…_", thread_ts: replyThread });

    // Write-ahead: record the turn BEFORE running it, so a mid-turn pod death
    // leaves a record the next pod resumes (see main.ts). Removed on completion.
    const pendingId = `${event.channel}-${event.ts}`;
    pending.add({
      id: pendingId,
      sessionKey,
      channel: event.channel,
      threadTs: isDm ? undefined : threadTs,
      userId: event.user,
      input: text,
      placeholderChannel: placeholder.channel,
      placeholderTs: placeholder.ts,
      createdAt: new Date().toISOString(),
      attempts: 0,
    });

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
    } finally {
      // Handled success OR handled error both mean "done, don't resume". Only a
      // hard crash (process killed) skips this and leaves the record behind.
      pending.remove(pendingId);
    }
  }

  app.event("app_mention", async ({ event, say, client }) => {
    if (allowed.size > 0 && !allowed.has(event.channel)) return;
    await handle(event, say, client, true);
  });

  app.message(async ({ message, say, client }) => {
    const m = message as any;
    if (m.subtype) return;
    if (m.channel_type !== "im") {
      // Thread follow: answer replies in a thread the agent is already part of,
      // without needing an @mention (config.followThreads).
      if (!config.followThreads || m.bot_id) return;
      if (m.channel_type !== "channel" && m.channel_type !== "group") return;
      if (!m.thread_ts || m.thread_ts === m.ts) return; // only replies inside a thread
      const text: string = m.text ?? "";
      if (text.includes(`<@${botUserId}>`)) return; // app_mention already handles it
      if (/<@[UW][A-Z0-9]+>/.test(text)) return; // addressed to someone else
      if (allowed.size > 0 && !allowed.has(m.channel)) return;
      if (!isEngaged?.(`${m.channel}-${m.thread_ts}`)) return; // not a thread the agent is in
      await handle(m, say, client, false);
      return;
    }
    if (dmRestricted && (!m.user || !dmAllowed.has(m.user))) {
      if (!m.bot_id) {
        await say({ text: "Sorry — I'm restricted to specific users. Ask my admin for access." });
      }
      return;
    }
    await handle(m, say, client, false);
  });

  await app.start();
  console.log(`[slack] connected as ${auth.user} (${botUserId})${config.followThreads ? " — following threads without @mention" : ""}`);
  return {
    app,
    botUserId,
    stop: async () => {
      await app.stop();
    },
  };
}
