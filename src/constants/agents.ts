/**
 * Agents this service runs, by their slug in the `agents` collection. Each document holds
 * the agent's model, prompt and tools, which are sent to GTWY's direct completion API on
 * every call (see README "Agents").
 */
export const AGENTS = {
  /** "Build with AI" ranger builder. */
  RANGER_BUILDER: 'ranger_builder',
  /** Drafts a ranger's role, goal and instruction. */
  RANGER_PROMPT: 'ranger_prompt',
  /** "Update the ranger" chat. */
  RANGER_UPDATE: 'ranger_update',
  /** Turns "every weekday at 9" into a cron expression. */
  CRON_ASSISTANT: 'cron_assistant',
} as const;

export type AgentSlug = (typeof AGENTS)[keyof typeof AGENTS];
