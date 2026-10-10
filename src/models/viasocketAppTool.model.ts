import type { Collection } from 'mongodb';
import { getDb } from '../config/database.js';

/** One input of an action, as summarizeViaSocketActions() reduces it for the model. */
export interface ViaSocketActionField {
  key: string;
  kind: string;
  type: string;
  required: boolean;
  root: boolean;
  picked: boolean;
  keys_from_options: boolean;
  key_source: string | null;
  searchable: boolean;
  depends_on: string[];
  conditional: boolean;
  condition: string | null;
  default: unknown;
  help: string;
  options: unknown[];
}

export interface ViaSocketAction {
  action_version_id: string;
  action_id: string | null;
  name: string;
  description: string;
  fields: ViaSocketActionField[];
}

/**
 * One row per agent and viaSocket app: every action of that app behind one tool.
 * `_id` is in the run URL GTWY calls; `run_key` is the header it must send.
 * script_id and embed_token never leave the server.
 */
export interface ViaSocketAppTool {
  _id: string;
  run_key: string;
  agent_id: string;
  service_id: string;
  org_id?: string | null;
  version_id?: string | null;
  /** Every version of the agent, so callers that only know a version (channels, schedules) find the row. */
  version_ids?: string[];
  user_id?: string | null;
  service_name: string;
  icon_url?: string | null;
  tool_name: string;
  auth_id: string;
  script_id: string;
  embed_token?: string;
  actions: ViaSocketAction[];
  created_at?: Date;
  updated_at?: Date;
}

const COLLECTION = 'viasocketapptools';
let indexesReady: Promise<unknown> | null = null;

export async function getViaSocketAppToolsCollection(): Promise<Collection<ViaSocketAppTool>> {
  const collection = (await getDb()).collection<ViaSocketAppTool>(COLLECTION);
  indexesReady ??= Promise.all([
    collection.createIndex({ agent_id: 1, service_id: 1 }, { unique: true }),
    collection.createIndex({ version_ids: 1 }),
    collection.createIndex({ org_id: 1 }),
  ]).catch((error) => {
    indexesReady = null;
    throw error;
  });
  await indexesReady;
  return collection;
}
