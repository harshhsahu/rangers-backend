import type { Collection, ObjectId } from 'mongodb';
import { getDb } from '../config/database.js';

/** Per-channel bot settings. The bot token is always stored encrypted. */
export interface ChannelBotConfig {
  botToken?: string | null;
  chatThreads?: Record<string, unknown>;
  [key: string]: unknown;
}

/** One document per agent version: the messaging channels that version is wired to. */
export interface ChannelDetails {
  _id?: ObjectId;
  version_id: string;
  agent_id?: string | null;
  org_id?: string | null;
  telegram?: ChannelBotConfig;
  discord?: ChannelBotConfig;
  created_at?: Date;
  updated_at?: Date;
}

const COLLECTION = 'channeldetails';
let indexesReady: Promise<unknown> | null = null;

export async function getChannelDetailsCollection(): Promise<Collection<ChannelDetails>> {
  const collection = (await getDb()).collection<ChannelDetails>(COLLECTION);
  indexesReady ??= collection.createIndex({ version_id: 1 }, { unique: true }).catch((error) => {
    indexesReady = null;
    throw error;
  });
  await indexesReady;
  return collection;
}
