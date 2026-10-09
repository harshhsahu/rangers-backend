import { listCronJobs } from '../lib/easycron.js';
import {
  createSchedule as createScheduleRecord,
  deleteSchedule as deleteScheduleRecord,
  deleteSchedulesForAgent,
  sanitizeSchedule,
  schedulerBaseUrl,
  setSchedulesEnabledForAgent,
  toObjectId,
  updateSchedule as updateScheduleRecord,
} from '../lib/rangerSchedules.js';
import { executeScheduleRun } from '../lib/schedulerExecute.js';
import { getRangerSchedulesCollection, type RangerSchedule } from '../models/rangerSchedule.model.js';
import { AppError, errorMessage } from '../utils/AppError.js';
import { verifyAgentAccess } from './agentAccess.service.js';
import { generateCron } from './cronAssistant.service.js';

/**
 * The schedule lifecycle. Every write is gated by agent ownership: org_id comes from
 * the verified agent, never the request, so a caller cannot file a schedule under
 * someone else's org. These are the only paths that write schedules — the Scheduler
 * tab and the ranger AI's schedule tool both use them.
 *
 * Validation failures from the schedule domain (bad expression, unknown timezone, the
 * per-ranger cap) are written for the user to read, so they are returned as 400s.
 */

type SessionToken = string | null | undefined;

/** Fire-and-forget: the run records its own outcome on the row (`last_run`). */
function startRun(row: RangerSchedule, source: string) {
  executeScheduleRun(row).catch((error: unknown) =>
    console.error(`[scheduler] ${source} run crashed`, errorMessage(error))
  );
}

async function findSchedule(id: string): Promise<RangerSchedule | null> {
  const objectId = toObjectId(id);
  if (!objectId) return null;
  const schedules = await getRangerSchedulesCollection();
  return schedules.findOne({ _id: objectId });
}

/**
 * Loads a schedule the caller may manage. Ownership is checked against the agent and
 * version stored on the row, not ids in the request — the row is the authority.
 */
async function loadOwnedSchedule(sessionToken: SessionToken, id: string): Promise<RangerSchedule> {
  const row = await findSchedule(id);
  if (!row) throw AppError.notFound('Schedule not found');
  await verifyAgentAccess(sessionToken, { agentId: row.agent_id, versionId: row.version_id });
  return row;
}

export async function listSchedules(sessionToken: SessionToken, agentId: string | undefined, versionId: string) {
  await verifyAgentAccess(sessionToken, { agentId, versionId });

  try {
    const schedules = await getRangerSchedulesCollection();
    const rows = await schedules.find({ version_id: versionId }).sort({ created_at: -1 }).toArray();

    return {
      // Lets the UI explain why scheduling is unavailable rather than failing on save.
      scheduler_available: Boolean(schedulerBaseUrl()),
      schedules: rows.map(sanitizeSchedule),
    };
  } catch (error) {
    throw AppError.asServerError(error, 'Could not load schedules');
  }
}

export async function createSchedule(
  sessionToken: SessionToken,
  input: { agent_id?: string; version_id: string; created_by?: string | null; [key: string]: unknown }
) {
  const { orgId } = await verifyAgentAccess(sessionToken, { agentId: input.agent_id, versionId: input.version_id });
  try {
    return await createScheduleRecord({
      orgId,
      agentId: input.agent_id,
      versionId: input.version_id,
      // Only ever used to show who added a schedule; the token itself is not stored.
      createdBy: input.created_by || null,
      input,
    });
  } catch (error) {
    throw AppError.asClientError(error, 'Could not create the schedule');
  }
}

export async function getSchedule(sessionToken: SessionToken, id: string) {
  return sanitizeSchedule(await loadOwnedSchedule(sessionToken, id));
}

export async function updateSchedule(sessionToken: SessionToken, id: string, patch: Record<string, unknown>) {
  const row = await loadOwnedSchedule(sessionToken, id);
  try {
    return await updateScheduleRecord(row, patch);
  } catch (error) {
    throw AppError.asClientError(error, 'Could not update the schedule');
  }
}

/** Removes the EasyCron job first, then the row. */
export async function deleteSchedule(sessionToken: SessionToken, id: string) {
  const row = await loadOwnedSchedule(sessionToken, id);
  try {
    await deleteScheduleRecord(row);
  } catch (error) {
    throw AppError.asClientError(error, 'Could not delete the schedule');
  }
  return String(row._id);
}

/**
 * Authenticated "run now" for testing. Runs even when the schedule is paused
 * (cron still skips disabled rows). Returns as soon as the run has started.
 */
export async function runScheduleNow(sessionToken: SessionToken, id: string) {
  const row = await loadOwnedSchedule(sessionToken, id);
  startRun(row, 'manual');
  return String(row._id);
}

export type CronTriggerResult =
  { status: 'not_found' } | { status: 'disabled' } | { status: 'accepted'; scheduleId: string };

/**
 * The EasyCron entry point. Unauthenticated by decision: the schedule id is the whole
 * instruction, so treat it as public and keep schedules to work that is safe to run
 * more often than planned. Acknowledges before working — EasyCron gives up around 30s
 * and a failed job invites a retry that would run the ranger twice.
 */
export async function triggerScheduledRun(id: string): Promise<CronTriggerResult> {
  const row = await findSchedule(id);
  if (!row) return { status: 'not_found' };
  if (!row.enabled) return { status: 'disabled' };
  startRun(row, 'cron');
  return { status: 'accepted', scheduleId: String(row._id) };
}

export type LifecycleAction = 'pause' | 'resume' | 'delete';

/**
 * Keeps schedules in step with their ranger: a paused ranger's crons must not fire, and
 * a deleted ranger's jobs must not live on. Delete must be called *before* the agent is
 * deleted, while the caller's ownership of it can still be verified.
 */
export async function applyLifecycle(
  sessionToken: SessionToken,
  { agentId, versionId, action }: { agentId: string; versionId?: string; action: LifecycleAction }
): Promise<Record<string, unknown>> {
  await verifyAgentAccess(sessionToken, { agentId, versionId });
  try {
    if (action === 'delete') return await deleteSchedulesForAgent(agentId, { versionId });
    return await setSchedulesEnabledForAgent(agentId, action === 'resume');
  } catch (error) {
    throw AppError.asClientError(error, 'Could not sync schedules');
  }
}

/**
 * Diffs Mongo against EasyCron and names the strays. Read-only on purpose: deleting an
 * unexpected job automatically is how you lose a schedule to a transient list failure.
 */
export async function reconcileSchedules() {
  try {
    const schedules = await getRangerSchedulesCollection();
    const rows = await schedules.find({}).toArray();
    const jobs: any[] = await listCronJobs();

    const jobId = (job: any) => String(job.cron_job_id ?? job.id);
    const rowJobIds = new Set(rows.filter((row) => row.easycron_id).map((row) => String(row.easycron_id)));
    const liveJobIds = new Set(jobs.map(jobId));

    return {
      totals: { rows: rows.length, jobs: jobs.length },
      // Live jobs with no row: they fire at a URL we cannot serve. Delete them in EasyCron.
      orphan_jobs: jobs
        .filter((job) => !rowJobIds.has(jobId(job)))
        .map((job) => ({ cron_job_id: jobId(job), name: job.cron_job_name || null, url: job.url || null })),
      // Rows whose job is gone: harmless but dead — they will never fire.
      dead_rows: rows
        .filter((row) => row.easycron_id && !liveJobIds.has(String(row.easycron_id)))
        .map((row) => ({ id: String(row._id), label: row.label, version_id: row.version_id })),
      // Rows that never got a job — a create that failed midway.
      pending_rows: rows
        .filter((row) => !row.easycron_id)
        .map((row) => ({ id: String(row._id), label: row.label, created_at: row.created_at })),
      // Worth a look before a user reports it.
      failing: rows
        .filter((row) => (row.fail_streak || 0) >= 3)
        .map((row) => ({
          id: String(row._id),
          label: row.label,
          fail_streak: row.fail_streak,
          error: row.last_run?.error || null,
        })),
    };
  } catch (error) {
    throw AppError.asServerError(error, 'Reconcile failed');
  }
}

/**
 * Plain-English cadence to a cron expression, for the Scheduler panel's "generate with AI"
 * field. It spends our pauthkey, so the caller must be acting on their own agent.
 */
export async function suggestCron(
  sessionToken: SessionToken,
  { agentId, versionId, text, timezone }: { agentId?: string; versionId?: string; text: string; timezone: string }
) {
  await verifyAgentAccess(sessionToken, { agentId, versionId });
  return generateCron(text, timezone);
}
