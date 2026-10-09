import { env } from '../config/env.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { startDiscordBot, stopDiscordBot } from '../lib/discordBotManager.js';
import { clearDiscordCommands, registerDiscordCommands } from '../lib/discordCommands.js';
import { processDiscordMessage } from '../lib/discordMessageHandler.js';
import { getChannelDetailsCollection } from '../models/channelDetails.model.js';
import { AppError, errorMessage } from '../utils/AppError.js';
import { verifyAgentAccess } from './agentAccess.service.js';
import { sanitizeChannel, unsetChannel } from './channelDetails.service.js';

type SessionToken = string | null | undefined;

/** Discord bot tokens are ~70 chars; anything much shorter is a paste error. */
const MIN_DISCORD_TOKEN_LENGTH = 50;

/** Turns discord.js Gateway login errors into a message a user can act on. */
function describeLoginError(error: unknown): string {
  const message = errorMessage(error) || String(error);
  if (/disallowed intent/i.test(message)) {
    return 'This bot doesn\'t have the required Privileged Gateway Intent enabled. Open the Discord Developer Portal → your app → Bot, enable "Message Content Intent" under Privileged Gateway Intents, then try again.';
  }
  if (/invalid token/i.test(message)) {
    return 'Invalid Discord bot token. Copy the token again from the Bot page in the Discord Developer Portal and try again.';
  }
  return `Could not connect to Discord: ${message}`;
}

/** Registers slash commands. Best effort: setup succeeds without them. */
async function registerCommands(botToken: string) {
  try {
    const result: { registered: string[] } = await registerDiscordCommands(botToken);
    return {
      registered: true,
      names: result.registered,
      message: 'Slash commands registered — they may take a few minutes to appear in Discord.',
    };
  } catch (error) {
    console.warn('[discord] registerCommands skipped:', errorMessage(error));
    return { registered: false, message: errorMessage(error) || String(error) };
  }
}

export interface ConnectDiscordInput {
  botToken: string;
  versionId: string;
  agentId: string | null;
}

/**
 * Binds a Discord bot to an agent version. The token (and its privileged intents) is
 * validated by logging in to the Gateway BEFORE anything is persisted, so an invalid,
 * revoked or under-privileged token is never written to the database.
 */
export async function connectDiscordBot(sessionToken: SessionToken, input: ConnectDiscordInput) {
  const { botToken, versionId, agentId } = input;
  const { orgId } = await verifyAgentAccess(sessionToken, { agentId, versionId });

  if (botToken.length < MIN_DISCORD_TOKEN_LENGTH) {
    throw AppError.badRequest('Invalid Discord bot token. Paste the full token from the Developer Portal.');
  }

  let started: { ok?: boolean; alreadyRunning?: boolean; tag?: string | null };
  try {
    started = await startDiscordBot(versionId, botToken);
  } catch (error) {
    console.error('[discord] setup validation failed', errorMessage(error));
    throw AppError.badRequest(describeLoginError(error));
  }

  try {
    const now = new Date();
    const orgIdToStore = orgId || env.ORG_ID || null;
    const collection = await getChannelDetailsCollection();
    const existing = await collection.findOne({ version_id: versionId });

    await collection.updateOne(
      { version_id: versionId },
      {
        $set: {
          discord: {
            botToken: encryptSecret(botToken),
            ...(existing?.discord?.chatThreads ? { chatThreads: existing.discord.chatThreads } : {}),
          },
          version_id: versionId,
          ...(agentId != null ? { agent_id: agentId } : {}),
          ...(orgIdToStore != null ? { org_id: orgIdToStore } : {}),
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true }
    );

    const commands = await registerCommands(botToken);

    return {
      data: sanitizeChannel(await collection.findOne({ version_id: versionId })),
      gateway: {
        connected: Boolean(started?.ok),
        alreadyRunning: Boolean(started?.alreadyRunning),
        tag: started?.tag || null,
        message: 'Discord Gateway connected',
      },
      commands,
    };
  } catch (error) {
    throw AppError.asServerError(error, 'Failed to save Discord bot');
  }
}

/**
 * Unbinds the Discord bot: clears its commands, stops its Gateway client and removes
 * only the discord channel (keeping telegram). Returns how many documents were deleted.
 */
export async function disconnectDiscordBot(sessionToken: SessionToken, versionId: string, agentId: string | null) {
  const collection = await getChannelDetailsCollection();
  const existing = await collection.findOne({ version_id: versionId });

  // Authorize before revealing whether a channel exists for this version
  await verifyAgentAccess(sessionToken, { agentId: agentId || existing?.agent_id || null, versionId });
  if (!existing) throw AppError.notFound('Channel not found');

  try {
    const token = decryptSecret(existing.discord?.botToken);
    if (token) await clearDiscordCommands(token);
  } catch (error) {
    console.warn('[discord] clearCommands skipped:', errorMessage(error));
  }

  try {
    await stopDiscordBot(versionId);
  } catch (error) {
    console.warn('[discord] stop on delete skipped:', errorMessage(error));
  }

  try {
    return await unsetChannel(versionId, 'discord');
  } catch (error) {
    throw AppError.asServerError(error, 'Failed to disconnect Discord');
  }
}

/**
 * Relays one Discord message payload to the version's agent. The Gateway client calls
 * the handler in-process; this entry point exists for debugging and external relays.
 */
export function relayDiscordMessage(versionId: string | null, message: unknown) {
  return processDiscordMessage({ versionId, message });
}
