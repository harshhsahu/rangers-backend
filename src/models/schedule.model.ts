import type { Collection, ObjectId } from 'mongodb';
import { getDb } from '../config/database.js';

/**
 * A scheduled ranger run. Schedules are their own documents because EasyCron calls the
 * public run endpoint with the schedule `_id` (no session), and each run updates its own
 * counters.
 */
export interface Schedule {
  _id?: ObjectId;
  ranger_id: ObjectId;
  /** Same tenant as the ranger. */
  org_id: string;
  label?: string;
  /** What the ranger is asked on each run. */
  message: string;
  cron_expression: string;
  timezone: string;
  /** Where the answer is sent; null keeps it in the run history only. */
  delivery: { channel: 'telegram'; chat_id: string; username?: string } | null;
  enabled: boolean;
  /** Left out until EasyCron confirms the job, never stored as null (see the index below). */
  easycron_id?: string;
  last_run?: {
    at: Date;
    ok: boolean;
    duration_ms: number;
    thread_id: string;
    /** Start of the answer, on success. */
    preview?: string;
    /** On failure. */
    error?: string;
  };
  run_count: number;
  /** Consecutive failed runs; reset by a successful one. */
  fail_streak: number;
  created_by?: string;
  created_at: Date;
  updated_at: Date;
}

const COLLECTION = 'schedules';
let indexesReady: Promise<unknown> | null = null;

export async function getSchedulesCollection(): Promise<Collection<Schedule>> {
  const collection = (await getDb()).collection<Schedule>(COLLECTION);
  indexesReady ??= Promise.all([
    collection.createIndex({ ranger_id: 1 }),
    // Partial on strings, not sparse: a sparse index still indexes an explicit null, so two
    // schedules waiting for their EasyCron job would collide.
    collection.createIndex(
      { easycron_id: 1 },
      { unique: true, partialFilterExpression: { easycron_id: { $type: 'string' } } }
    ),
  ]).catch((error) => {
    indexesReady = null;
    throw error;
  });
  await indexesReady;
  return collection;
}
