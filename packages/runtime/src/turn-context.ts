import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Ambient per-turn context so builtin tools (cron_add's default channel, etc.)
 * know where the current conversation is happening. Set around agent.prompt();
 * tool executions inherit it through the async chain.
 */
export interface TurnContext {
  channel?: string;
  userId?: string;
  trigger?: string;
}

export const turnContext = new AsyncLocalStorage<TurnContext>();
