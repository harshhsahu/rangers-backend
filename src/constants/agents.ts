/** Published GTWY agents this service drives through the completion API. */
export const GTWY_AGENTS = {
  /** "Build with AI" ranger builder. */
  RANGER_BUILDER: '6a881574306498162b09a296',
  /** Drafts a ranger's role, goal and instruction. */
  RANGER_PROMPT: '6843d832aab19264b8967f3b',
  /** "Update the ranger" chat. */
  RANGER_UPDATE: '6a98e24a1b30b30277b9f371',
  /** Turns "every weekday at 9" into a cron expression. */
  CRON_ASSISTANT: '6aa016abb54ce2b5442ddcea',
} as const;
