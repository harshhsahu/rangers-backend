import { ObjectId, type Filter } from 'mongodb';
import { env } from '../config/env.js';
import { encryptSecret, maskSecret } from '../lib/crypto.js';
import { getChannelDetailsCollection, type ChannelDetails } from '../models/channelDetails.model.js';
import { AppError } from '../utils/AppError.js';

/** A channel document with every bot token masked, safe to return to the browser. */
export function sanitizeChannel(doc: ChannelDetails | null): ChannelDetails | null {
  if (!doc) return doc;
  const out = { ...doc };
  if (out.telegram?.botToken) out.telegram = { ...out.telegram, botToken: maskSecret(out.telegram.botToken) };
  if (out.discord?.botToken) out.discord = { ...out.discord, botToken: maskSecret(out.discord.botToken) };
  return out;
}

export type ChannelLookup = { id: string } | { versionId: string };

function toFilter(lookup: ChannelLookup): Filter<ChannelDetails> {
  if ('id' in lookup) {
    if (!ObjectId.isValid(lookup.id)) throw AppError.badRequest('Invalid id');
    return { _id: new ObjectId(lookup.id) };
  }
  return { version_id: lookup.versionId };
}

export async function findChannel(lookup: ChannelLookup) {
  const collection = await getChannelDetailsCollection();
  return sanitizeChannel(await collection.findOne(toFilter(lookup)));
}

export async function listChannels(limit = 200) {
  const collection = await getChannelDetailsCollection();
  const docs = await collection.find({}).sort({ updated_at: -1 }).limit(limit).toArray();
  return docs.map(sanitizeChannel);
}

export interface CreateTelegramChannelInput {
  version_id: string;
  agent_id?: string | null;
  org_id?: string | null;
  telegram: { botToken: string; webhookUrl?: string | null; webhookSet?: boolean };
}

/** Upserts the Telegram binding for a version (replacing the whole `telegram` subdocument). */
export async function upsertTelegramChannel(input: CreateTelegramChannelInput) {
  const collection = await getChannelDetailsCollection();
  const now = new Date();

  try {
    await collection.updateOne(
      { version_id: input.version_id },
      {
        $set: {
          telegram: {
            botToken: encryptSecret(input.telegram.botToken),
            webhookUrl: input.telegram.webhookUrl || null,
            webhookSet: Boolean(input.telegram.webhookSet),
          },
          version_id: input.version_id,
          agent_id: input.agent_id || null,
          org_id: input.org_id || env.ORG_ID || null,
          updated_at: now,
        },
        $setOnInsert: { created_at: now },
      },
      { upsert: true }
    );
  } catch (error) {
    if ((error as { code?: number })?.code === 11000) {
      throw new AppError(409, 'A channel already exists for this version_id', { cause: error });
    }
    throw error;
  }

  return sanitizeChannel(await collection.findOne({ version_id: input.version_id }));
}

export interface UpdateChannelInput {
  id?: string;
  version_id?: string;
  telegram?: Record<string, unknown>;
  agent_id?: string | null;
  org_id?: string | null;
}

export async function updateChannel(input: UpdateChannelInput) {
  const filter = input.id
    ? toFilter({ id: input.id })
    : input.version_id
      ? toFilter({ versionId: input.version_id })
      : null;
  if (!filter) throw AppError.badRequest('id or version_id is required');

  const update: Partial<ChannelDetails> = { updated_at: new Date() };
  if (input.telegram) {
    const { botId: _legacy, ...telegram } = input.telegram;
    if (typeof telegram.botToken === 'string' && telegram.botToken) {
      telegram.botToken = encryptSecret(telegram.botToken);
    }
    update.telegram = telegram;
  }
  if (input.agent_id !== undefined) update.agent_id = input.agent_id;
  if (input.org_id !== undefined) update.org_id = input.org_id;

  const collection = await getChannelDetailsCollection();
  const saved = await collection.findOneAndUpdate(filter, { $set: update }, { returnDocument: 'after' });
  if (!saved) throw AppError.notFound('Channel not found');
  return sanitizeChannel(saved);
}

export async function deleteChannel(lookup: ChannelLookup) {
  const collection = await getChannelDetailsCollection();
  const result = await collection.deleteOne(toFilter(lookup));
  return result.deletedCount;
}

/**
 * Removes one channel (telegram or discord) from a version's document and drops the
 * document when no channel is left. Returns how many documents were deleted.
 */
export async function unsetChannel(versionId: string, channel: 'telegram' | 'discord') {
  const collection = await getChannelDetailsCollection();
  await collection.updateOne(
    { version_id: versionId },
    { $unset: { [channel]: '' }, $set: { updated_at: new Date() } }
  );

  const after = await collection.findOne({ version_id: versionId });
  if (after && !after.telegram && !after.discord) {
    const result = await collection.deleteOne({ version_id: versionId });
    return result.deletedCount;
  }
  return 0;
}
