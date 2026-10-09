import Joi from 'joi';
import { lenientArray, nullableString, optionalString, requiredString } from './common.js';

export interface BotCommandInput {
  command: string;
  description: string;
}

export interface TelegramSetupBody {
  botToken: string;
  version_id: string;
  agent_id: string | null;
  /** Slash-command menu; falls back to the default menu when absent or malformed. */
  commands?: BotCommandInput[];
}

export interface DiscordSetupBody {
  botToken: string;
  version_id: string;
  agent_id: string | null;
}

export interface ChannelTeardownQuery {
  version_id: string;
  agent_id: string | null;
}

export interface WebhookQuery {
  version_id: string | null;
}

export interface DiscordRelayBody {
  message?: unknown;
}

const botCommands = Joi.array().items(
  Joi.object({ command: Joi.string().required(), description: Joi.string().required() }).unknown(true)
);

export const telegramSetupSchema = {
  body: Joi.object<TelegramSetupBody>({
    botToken: requiredString('botToken is required')
      .pattern(/:/)
      .messages({ 'string.pattern.base': 'Invalid bot token format. Expected 123456:ABC...' }),
    version_id: requiredString('version_id is required'),
    agent_id: nullableString,
    commands: lenientArray(botCommands, undefined),
  }),
};

export const discordSetupSchema = {
  body: Joi.object<DiscordSetupBody>({
    botToken: requiredString('botToken is required'),
    version_id: requiredString('version_id is required'),
    agent_id: nullableString,
  }),
};

export const channelTeardownSchema = {
  query: Joi.object<ChannelTeardownQuery>({
    version_id: requiredString('version_id is required'),
    agent_id: nullableString,
  }),
};

const webhookQuery = Joi.object<WebhookQuery>({
  version_id: optionalString.allow(null).default(null),
});

/** Telegram's own update payload is passed through untouched. */
export const telegramWebhookSchema = {
  query: webhookQuery,
};

export const discordRelaySchema = {
  query: webhookQuery,
  body: Joi.object<DiscordRelayBody>({ message: Joi.any() }).unknown(true),
};
