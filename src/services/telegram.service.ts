import { env } from '../config/env.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { telegramApi } from '../lib/telegramApi.js';
import { handleTelegramUpdate } from '../lib/telegramWebhook.js';
import { getChannelDetailsCollection } from '../models/channelDetails.model.js';
import { AppError, errorMessage } from '../utils/AppError.js';
import { verifyAgentAccess } from './agentAccess.service.js';
import { sanitizeChannel, unsetChannel } from './channelDetails.service.js';

type SessionToken = string | null | undefined;

export interface BotCommand {
  command: string;
  description: string;
}

const DEFAULT_BOT_COMMANDS: BotCommand[] = [{ command: 'new_thread', description: 'Start a new thread' }];

interface TelegramApiResult {
  ok?: boolean;
  description?: string;
  [key: string]: unknown;
}

/** Where Telegram should deliver updates for a version's bot, or null when no public URL is configured. */
export function buildWebhookUrl(versionId: string): string | null {
  const base = env.telegramWebhookBaseUrl;
  return base ? `${base}/api/telegram/webhook?version_id=${encodeURIComponent(versionId)}` : null;
}

/** Telegram only delivers to public HTTPS endpoints. */
export const isDeliverable = (url: string | null): url is string =>
  Boolean(url && url.startsWith('https://') && !url.includes('localhost'));

/** Points the bot's webhook at this API. Best effort: the failure reason is returned, not thrown. */
async function registerWebhook(botToken: string, webhookUrl: string | null) {
  if (!isDeliverable(webhookUrl)) {
    return {
      result: null,
      error:
        'Webhook not registered yet — set TELEGRAM_WEBHOOK_BASE_URL to a public HTTPS URL (e.g. ngrok) and re-save.',
    };
  }
  try {
    const result: TelegramApiResult = await telegramApi(botToken, 'setWebhook', { url: webhookUrl });
    return { result, error: result?.ok ? null : result?.description || 'Telegram setWebhook failed' };
  } catch (error) {
    return { result: null, error: errorMessage(error) };
  }
}

/** Publishes the bot's slash-command menu. Best effort, like the webhook. */
async function registerCommands(botToken: string, commands: BotCommand[]) {
  try {
    const result: TelegramApiResult = await telegramApi(botToken, 'setMyCommands', { commands });
    const error = result?.ok ? null : result?.description || 'Telegram setMyCommands failed';
    if (error) console.warn('[telegram] setMyCommands skipped:', error);
    return { result, error };
  } catch (error) {
    console.warn('[telegram] setMyCommands skipped:', errorMessage(error));
    return { result: null, error: errorMessage(error) };
  }
}

export interface ConnectTelegramInput {
  botToken: string;
  versionId: string;
  agentId: string | null;
  commands?: BotCommand[];
}

/**
 * Binds a Telegram bot to an agent version: stores the encrypted token, registers the
 * webhook and the command menu. org_id comes from the verified agent, never the request.
 */
export async function connectTelegramBot(sessionToken: SessionToken, input: ConnectTelegramInput) {
  const { orgId } = await verifyAgentAccess(sessionToken, { agentId: input.agentId, versionId: input.versionId });

  try {
    const { botToken, versionId } = input;
    const webhookUrl = buildWebhookUrl(versionId);
    const now = new Date();
    const collection = await getChannelDetailsCollection();
    const existing = await collection.findOne({ version_id: versionId });

    // $set on the whole `telegram` subdocument replaces it (dropping legacy botId) while
    // keeping the per-chat GTWY thread map across re-setup.
    await collection.updateOne(
      { version_id: versionId },
      {
        $set: {
          telegram: {
            botToken: encryptSecret(botToken),
            webhookUrl,
            webhookSet: false,
            ...(existing?.telegram?.chatThreads ? { chatThreads: existing.telegram.chatThreads } : {}),
          },
          version_id: versionId,
          agent_id: input.agentId,
          org_id: orgId || env.ORG_ID || null,
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true }
    );

    const webhook = await registerWebhook(botToken, webhookUrl);
    if (webhook.result?.ok) {
      await collection.updateOne(
        { version_id: versionId },
        { $set: { 'telegram.webhookSet': true, updated_at: new Date() } }
      );
    }

    const commands = await registerCommands(botToken, input.commands?.length ? input.commands : DEFAULT_BOT_COMMANDS);

    return {
      data: sanitizeChannel(await collection.findOne({ version_id: versionId })),
      webhook: {
        url: webhookUrl,
        params: { version_id: versionId },
        registered: Boolean(webhook.result?.ok),
        result: webhook.result,
        message: webhook.error,
      },
      commands: {
        registered: Boolean(commands.result?.ok),
        result: commands.result,
        message: commands.error,
      },
    };
  } catch (error) {
    throw AppError.asServerError(error, 'Failed to save Telegram bot');
  }
}

/**
 * Unbinds the Telegram bot from a version: clears its webhook and commands (best effort)
 * and removes only the telegram channel, keeping discord on the same document.
 * Returns how many channel documents were deleted.
 */
export async function disconnectTelegramBot(sessionToken: SessionToken, versionId: string, agentId: string | null) {
  const collection = await getChannelDetailsCollection();
  const existing = await collection.findOne({ version_id: versionId });

  // Authorize before revealing whether a channel exists for this version
  await verifyAgentAccess(sessionToken, { agentId: agentId || existing?.agent_id || null, versionId });
  if (!existing) throw AppError.notFound('Channel not found');

  try {
    const token = decryptSecret(existing.telegram?.botToken);
    if (token) {
      await telegramApi(token, 'deleteWebhook', {}).catch((error: unknown) =>
        console.warn('[telegram] deleteWebhook skipped:', errorMessage(error))
      );
      await telegramApi(token, 'deleteMyCommands', {}).catch((error: unknown) =>
        console.warn('[telegram] deleteMyCommands skipped:', errorMessage(error))
      );
    }
  } catch (error) {
    console.warn('[telegram] token unreadable, skipped Telegram cleanup:', errorMessage(error));
  }

  try {
    return await unsetChannel(versionId, 'telegram');
  } catch (error) {
    throw AppError.asServerError(error, 'Failed to disconnect Telegram');
  }
}

/** Telegram webhook delivery; resolves to the ack body (always answered 200 so Telegram does not retry). */
export function receiveTelegramUpdate(versionId: string | null, update: unknown) {
  return handleTelegramUpdate({ versionId, update });
}
