import type { Collection, ObjectId } from 'mongodb';
import { getDb } from '../config/database.js';

/** A connector the ranger may call: a viaSocket flow, run at https://flow.sokt.io/func/<script_id>. */
export interface RangerTool {
  script_id: string;
  /** The name the model sees. */
  name: string;
  description?: string;
  /** JSON-Schema `properties` of the arguments. */
  fields?: Record<string, unknown>;
  required?: string[];
  /** Argument → variable it is filled from, hidden from the model. */
  variable_paths?: Record<string, string>;
}

/** Everything needed to call the ranger's model; sent to GTWY's direct completion API on each run. */
export interface RangerConfig {
  /** A GTWY service name, e.g. 'openai'. */
  service: string;
  model: string;
  type: 'chat' | 'reasoning';
  prompt: string | { role: string; goal: string; instruction: string };
  /** temperature, max_tokens…: only the values the user changed. */
  params: Record<string, unknown>;
  /** Output format, e.g. { type: 'json_schema', json_schema }. Absent means plain text. */
  response_type?: Record<string, unknown>;
  /** A tone preset and the prompt text it adds. */
  tone?: { value: string; prompt: string };
  /** Model to retry with when the main one fails. */
  fallback?: { service: string; model: string };
  /** Prompt variables, by name. */
  variables?: Record<string, { default_value?: string; required?: boolean }>;
  tools: RangerTool[];
  mcp_servers: { name: string; url: string }[];
  /** GTWY knowledge-base resources; only their ids live here. */
  knowledge_bases: { resource_id: string; collection_id: string; name?: string; description?: string }[];
  starter_questions?: string[];
}

export interface TelegramChannel {
  /** Always encrypted ("enc:v1:…", lib/crypto.js). */
  bot_token: string;
  webhook_set: boolean;
  /** Last update handled, so a retried webhook is dropped. */
  last_update_id?: number;
  /** Who last wrote to the bot: the chat a scheduled run can deliver to. */
  last_chat?: { chat_id: string; username?: string; first_name?: string; at: Date };
  /** Chat id → thread id, only for chats that started a new thread with /new_thread. */
  chat_threads?: Record<string, string>;
}

export interface DiscordChannel {
  /** Always encrypted ("enc:v1:…", lib/crypto.js). */
  bot_token: string;
  /** Channel id → thread id, only for channels that started a new thread. */
  chat_threads?: Record<string, string>;
}

/**
 * One document per ranger: who owns it, how it looks on the roster, its single model
 * configuration and its messaging channels. There are no versions — edits change `config`
 * in place. History, analytics and usage stay in GTWY.
 */
export interface Ranger {
  _id?: ObjectId;
  /** The tenant: the MSG91 company id. Every query on behalf of a user filters on it. */
  org_id: string;
  /** MSG91 user id of whoever created it. */
  created_by?: string;
  name: string;
  description?: string;
  role?: string;
  /** Roster card colour. */
  color?: string;
  status: 'active' | 'paused' | 'archived';
  /** Set when moved to the trash; restoring sets it back to null. */
  deleted_at: Date | null;
  config: RangerConfig;
  channels: { telegram?: TelegramChannel; discord?: DiscordChannel };
  /** The GTWY agent and version this ranger came from. Telegram webhooks registered with `?version_id=` are found by it. */
  legacy?: { agent_id: string; version_id: string };
  created_at: Date;
  updated_at: Date;
}

const COLLECTION = 'rangers';
let indexesReady: Promise<unknown> | null = null;

export async function getRangersCollection(): Promise<Collection<Ranger>> {
  const collection = (await getDb()).collection<Ranger>(COLLECTION);
  // Partial on $exists: an equality match implies it, so lookups use these indexes.
  indexesReady ??= Promise.all([
    // The roster: always one org, newest first.
    collection.createIndex({ org_id: 1, updated_at: -1 }),
    collection.createIndex(
      { 'legacy.version_id': 1 },
      { unique: true, partialFilterExpression: { 'legacy.version_id': { $exists: true } } }
    ),
    // Discord bots are started at boot from every ranger that has a token.
    collection.createIndex(
      { 'channels.discord.bot_token': 1 },
      { partialFilterExpression: { 'channels.discord.bot_token': { $exists: true } } }
    ),
  ]).catch((error) => {
    indexesReady = null;
    throw error;
  });
  await indexesReady;
  return collection;
}
