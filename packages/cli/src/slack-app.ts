import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.js";

const BOT_SCOPES = [
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "groups:read",
  "chat:write",
  "im:history",
  "im:write",
];

export function buildManifest(agentName: string): object {
  return {
    display_information: {
      name: agentName,
      description: `${agentName} — managed by wrapper`,
      background_color: "#4a154b",
    },
    features: {
      bot_user: { display_name: agentName, always_online: true },
    },
    oauth_config: { scopes: { bot: BOT_SCOPES } },
    settings: {
      event_subscriptions: { bot_events: ["app_mention", "message.im"] },
      interactivity: { is_enabled: true },
      org_deploy_enabled: false,
      socket_mode_enabled: true,
      token_rotation_enabled: false,
    },
  };
}

/**
 * Writes the slack-cli project files into <agentDir>/slack and creates+installs
 * the app non-interactively. Returns the app ID.
 */
export function ensureSlackApp(agentDir: string, agentName: string, teamId: string): string {
  const slackDir = join(agentDir, "slack");
  writeFileSync(join(slackDir, "manifest.json"), JSON.stringify(buildManifest(agentName), null, 2));
  // Trailing '#' swallows the --source= arg the CLI appends to hooks.
  writeFileSync(
    join(slackDir, "slack.json"),
    JSON.stringify({ hooks: { "get-manifest": "cat manifest.json #" } }, null, 2),
  );

  run("slack", ["app", "install", "--team", teamId, "-E", "deployed", "--force"], {
    cwd: slackDir,
  });

  const apps = JSON.parse(readFileSync(join(slackDir, ".slack", "apps.json"), "utf8"));
  const appId: string | undefined = apps?.apps?.[teamId]?.app_id;
  if (!appId) throw new Error("slack app install succeeded but no app_id found in .slack/apps.json");
  return appId;
}

export function deleteSlackApp(agentDir: string, teamId: string): void {
  const slackDir = join(agentDir, "slack");
  if (!existsSync(join(slackDir, ".slack", "apps.json"))) return;
  run("slack", ["app", "delete", "--app", "deployed", "--team", teamId, "--force"], {
    cwd: slackDir,
    allowFail: true,
  });
}

interface CliCredential {
  token: string;
  team_id: string;
  exp?: number;
}

function cliCredentialFor(teamId: string): CliCredential {
  const file = join(homedir(), ".slack", "credentials.json");
  if (!existsSync(file)) {
    throw new Error("Slack CLI is not logged in — run `slack auth login` first");
  }
  const creds = JSON.parse(readFileSync(file, "utf8"));
  for (const entry of Object.values<any>(creds)) {
    if (entry?.team_id === teamId && entry?.token) return entry;
  }
  throw new Error(`No Slack CLI credential for team ${teamId} — run \`slack auth login\``);
}

/**
 * Mints the bot (xoxb) and app-level (xapp) tokens the same way `slack run`
 * does: apps.developerInstall authed with the CLI credential.
 */
export async function mintTokens(
  appId: string,
  teamId: string,
): Promise<{ botToken: string; appToken: string }> {
  // Any CLI command refreshes an expired rotating credential first.
  let cred = cliCredentialFor(teamId);
  if (cred.exp && cred.exp * 1000 < Date.now() + 60_000) {
    run("slack", ["auth", "list"], { allowFail: true });
    cred = cliCredentialFor(teamId);
  }

  const res = await fetch("https://slack.com/api/apps.developerInstall", {
    method: "POST",
    headers: { Authorization: `Bearer ${cred.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId }),
  });
  const data: any = await res.json();
  if (!data.ok) throw new Error(`apps.developerInstall failed: ${data.error}`);
  const bot = data.api_access_tokens?.bot;
  const appLevel = data.api_access_tokens?.app_level;
  if (!bot || !appLevel) {
    throw new Error("apps.developerInstall response missing api_access_tokens.bot/app_level");
  }
  return { botToken: bot, appToken: appLevel };
}
