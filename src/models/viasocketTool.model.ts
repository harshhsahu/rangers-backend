import type { Collection } from 'mongodb';
import { getDb } from '../config/database.js';

/** One viaSocket action registered as its own GTWY function. script_id never leaves the server. */
export interface ViaSocketTool {
  _id: string;
  org_id: string;
  service_id: string;
  action_version_id: string;
  script_id: string;
  title: string;
  created_at?: Date;
}

const COLLECTION = 'viasockettools';
let indexesReady: Promise<unknown> | null = null;

export async function getViaSocketToolsCollection(): Promise<Collection<ViaSocketTool>> {
  const collection = (await getDb()).collection<ViaSocketTool>(COLLECTION);
  indexesReady ??= collection.createIndex({ org_id: 1, action_version_id: 1 }).catch((error) => {
    indexesReady = null;
    throw error;
  });
  await indexesReady;
  return collection;
}
