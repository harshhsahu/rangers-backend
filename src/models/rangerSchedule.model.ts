import type { Collection, ObjectId } from 'mongodb';
import { getDb } from '../config/database.js';

/**
 * A scheduled ranger run. Schedules live here rather than on the bridge version
 * because they hold a run token and an EasyCron job id, are looked up by the
 * public run endpoint (which has no session), and must outlive version
 * publishes. `_id` is the id carried in the run URL.
 */
export interface RangerSchedule {
  _id: ObjectId;
  org_id?: string | null;
  agent_id: string;
  version_id: string;
  label?: string;
  enabled: boolean;
  easycron_id?: string | number | null;
  fail_streak?: number;
  last_run?: { error?: string | null; [key: string]: unknown } | null;
  created_at?: Date;
  [key: string]: unknown;
}

const COLLECTION = 'rangerschedules';
let indexesReady: Promise<unknown> | null = null;

export async function getRangerSchedulesCollection(): Promise<Collection<RangerSchedule>> {
  const collection = (await getDb()).collection<RangerSchedule>(COLLECTION);
  indexesReady ??= Promise.all([
    collection.createIndex({ version_id: 1 }),
    collection.createIndex({ org_id: 1 }),
    // Sparse: a row exists briefly before its EasyCron job does.
    collection.createIndex({ easycron_id: 1 }, { unique: true, sparse: true }),
  ]).catch((error) => {
    indexesReady = null;
    throw error;
  });
  await indexesReady;
  return collection;
}
