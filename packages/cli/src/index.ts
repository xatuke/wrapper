#!/usr/bin/env node
import { Command } from "commander";
import { addCommand, connectSlackCommand, removeCommand } from "./commands/agent.js";
import { envListCommand, envSetCommand, envSetFileCommand, envUnsetCommand } from "./commands/env.js";
import { initCommand } from "./commands/init.js";
import {
  downCommand,
  logsCommand,
  restartCommand,
  statusCommand,
  upCommand,
} from "./commands/lifecycle.js";

const program = new Command("wrapper")
  .description("Host, manage, and observe pi agents on Slack")
  .version("0.1.0");

program
  .command("init")
  .description("Set up the Langfuse stack and provision the wrapper org")
  .option("--team-id <id>", "Slack team ID (e.g. T0123456789)")
  .option("--skip-stack", "only write config/secrets, don't start containers")
  .action((o) => initCommand({ teamId: o.teamId, skipStack: o.skipStack }));

const agent = program.command("agent").description("Manage agents");
agent
  .command("add <name>")
  .description("Scaffold an agent, create its Slack app, and provision Langfuse")
  .option("--model <model>", "provider/model-id", "anthropic/claude-sonnet-4-5")
  .option("--channels <channels>", "comma-separated Slack channels", "")
  .option("--no-slack", "skip Slack app creation")
  .option("--no-langfuse", "skip Langfuse project provisioning")
  .action((name, o) =>
    addCommand(name, {
      model: o.model,
      channels: String(o.channels).split(",").map((c: string) => c.trim()).filter(Boolean),
      slack: o.slack,
      langfuse: o.langfuse,
    }),
  );
agent
  .command("connect-slack <name>")
  .description("Create the Slack app and mint tokens for an existing agent")
  .action(connectSlackCommand);
agent
  .command("remove <name>")
  .description("Stop the container and delete the Slack app")
  .option("--purge", "also delete the agent directory", false)
  .action((name, o) => removeCommand(name, { purge: o.purge }));

program
  .command("up [agents...]")
  .description("Start agents (all if none given) + the Langfuse stack")
  .action((agents) => upCommand(agents));
program
  .command("down [agents...]")
  .description("Stop agents (whole stack if none given)")
  .action((agents) => downCommand(agents));
program
  .command("restart <agents...>")
  .description("Restart agents (picks up .env changes)")
  .action((agents) => restartCommand(agents));
program
  .command("logs <agent>")
  .option("-f, --follow", "follow log output", false)
  .description("Show an agent's container logs")
  .action((name, o) => logsCommand(name, { follow: o.follow }));
program.command("status").description("Container + Langfuse health overview").action(statusCommand);

program
  .command("ui")
  .description("Open the local web console (agents, logs, env, traces)")
  .option("--port <port>", "port to listen on", "3020")
  .action(async (o) => {
    const { uiCommand } = await import("./ui/server.js");
    await uiCommand({ port: Number(o.port) });
  });

const env = program.command("env").description("Manage an agent's container environment");
env
  .command("set <agent> <pairs...>")
  .description("Set KEY=VALUE pairs in the agent's .env")
  .action(envSetCommand);
env
  .command("set-file <agent> <key> <file>")
  .description("Set a key to a file's contents (base64) — for multi-line secrets")
  .action(envSetFileCommand);
env
  .command("unset <agent> <keys...>")
  .description("Remove keys from the agent's .env")
  .action(envUnsetCommand);
env
  .command("list <agent>")
  .option("--show", "show full secret values", false)
  .description("List the agent's .env (secrets masked)")
  .action((name, o) => envListCommand(name, { show: o.show }));

program.parseAsync().catch((err) => {
  console.error(`error: ${err?.message ?? err}`);
  process.exit(1);
});
