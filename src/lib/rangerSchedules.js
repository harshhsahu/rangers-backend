import crypto from "crypto";
import { ObjectId } from "mongodb";
import { getRangerSchedulesCollection } from "../models/rangerSchedule.model.js";
import { addCronJob, deleteCronJob, editCronJob, setCronJobEnabled } from "./easycron.js";
import {
  buildCronExpression,
  describeCron,
  nextCronRuns,
  parseTimeOfDay,
  validateCronExpression,
} from "./cronExpression.js";

/**
 * The schedule lifecycle, shared by the API routes so the two-system dance is
 * written once.
 *
 * Every mutation touches EasyCron *and* Mongo, and the order is deliberate:
 * the row is written first because the run URL has to carry its id and token,
 * and a failed EasyCron call then leaves a disabled row nobody sees. The
 * reverse order leaves a live job firing at a URL we have no record of — the
 * one failure mode that is both invisible and billable.
 */

export const MAX_PER_RANGER = Number(process.env.SCHEDULER_MAX_PER_RANGER || 10);

export const THREAD_MODES = ["fixed", "fresh"];

/**
 * Where EasyCron reaches this API. Deliberately the same env chain the ranger
 * AI route uses, and separate from TELEGRAM_WEBHOOK_BASE_URL for the same
 * reason: a developer needs jobs pointed at their own machine, not the
 * deployment, or the run writes into a database their UI is not reading.
 */
export function schedulerBaseUrl() {
  return (process.env.RANGER_PUBLIC_URL || process.env.TELEGRAM_WEBHOOK_BASE_URL || "").replace(/\/$/, "");
}

/** The URL EasyCron calls for one schedule — the id is the whole instruction. */
export const scheduleRunUrl = (id) => `${schedulerBaseUrl()}/api/scheduler/run?id=${encodeURIComponent(String(id))}`;

export const toObjectId = (id) => {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
};

/**
 * Cron runs a job when day-of-month OR day-of-week matches, not both — so "0 9 1-7 * 1",
 * the expression every model reaches for when asked about "the first Monday of the month",
 * fires on the 1st-7th *and* every Monday. It is syntactically valid, so nothing else
 * catches it, and the schedule looks right until someone counts the emails.
 *
 * Returned on every schedule rather than only where it was written, so the panel, the
 * ranger chat and anything added later all inherit the warning.
 */
export function cronCaveat(expression) {
  const fields = String(expression || "").split(" ");
  if (fields.length !== 5 || fields[2] === "*" || fields[4] === "*") return null;
  return "Both the day of the month and the weekday are restricted. Cron runs this when EITHER matches, not both — check the next run times.";
}

/** Shaped for a browser: adds the cadence description and the next fire times. */
export function sanitizeSchedule(row) {
  if (!row) return null;
  const { ...rest } = row;
  let nextRuns = [];
  try {
    if (row.enabled) nextRuns = nextCronRuns(row.cron_expression, row.timezone, 3);
  } catch {
    nextRuns = [];
  }
  return {
    ...rest,
    _id: String(row._id),
    description: describeCron(row.cron_expression, row.timezone),
    next_runs: nextRuns,
    warning: cronCaveat(row.cron_expression),
  };
}

/**
 * Structured fields -> a validated expression. `cron_expression` is the
 * advanced escape hatch and is validated exactly as hard as the built one.
 */
export function resolveCronExpression(input = {}) {
  if (input.cron_expression) return validateCronExpression(input.cron_expression);
  return validateCronExpression(buildCronExpression(input));
}

/**
 * Create a schedule and the EasyCron job that fires it.
 * Throws on a bad expression, a missing public URL, or the per-ranger cap.
 */
export async function createSchedule({ orgId, agentId, versionId, createdBy, input }) {
  const base = schedulerBaseUrl();
  if (!base) {
    throw new Error("No public URL is configured for scheduling — set RANGER_PUBLIC_URL");
  }

  const message = String(input?.message || "").trim();
  if (!message) throw new Error("message is required — it is what the ranger is asked to do on each run");

  const cronExpression = resolveCronExpression(input);
  const timezone = String(input?.timezone || "UTC").trim();
  // Fails loudly here rather than at 5pm, when the zone reaches EasyCron.
  nextCronRuns(cronExpression, timezone, 1);

  const threadMode = THREAD_MODES.includes(input?.thread_mode) ? input.thread_mode : "fresh";
  const label = String(input?.label || "").trim() || describeCron(cronExpression, timezone);

  const delivery =
    input?.delivery?.type === "telegram" && input.delivery.chat_id
      ? {
          type: "telegram",
          chat_id: input.delivery.chat_id,
          username: input.delivery.username || null,
        }
      : null;

  const schedules = await getRangerSchedulesCollection();
  const existing = await schedules.countDocuments({ version_id: String(versionId) });
  if (existing >= MAX_PER_RANGER) {
    throw new Error(`This ranger already has ${existing} schedules (limit ${MAX_PER_RANGER})`);
  }

  const now = new Date();
  const doc = {
    org_id: orgId ? String(orgId) : null,
    agent_id: String(agentId),
    version_id: String(versionId),
    group_id: input?.group_id ? String(input.group_id) : null,
    label,
    message,
    cron_expression: cronExpression,
    timezone,
    thread_mode: threadMode,
    thread_id: `cron_${crypto.randomBytes(6).toString("hex")}`,
    delivery,
    easycron_id: null,
    enabled: false,
    last_run: null,
    run_count: 0,
    fail_streak: 0,
    created_by: createdBy || null,
    created_at: now,
    updated_at: now,
  };

  const { insertedId } = await schedules.insertOne(doc);

  let easycronId;
  try {
    easycronId = await addCronJob({
      url: scheduleRunUrl(insertedId),
      cronExpression,
      timezone,
      // Prefixed so one shared EasyCron account stays readable per org.
      name: `gtwy:${doc.org_id || "org"}:${String(insertedId)}`,
      description: label,
      groupId: process.env.EASYCRON_GROUP_ID || undefined,
    });
  } catch (error) {
    // Nothing is firing yet, so the row is the only trace — drop it.
    await schedules.deleteOne({ _id: insertedId });
    throw error;
  }

  await schedules.updateOne(
    { _id: insertedId },
    { $set: { easycron_id: easycronId, enabled: true, updated_at: new Date() } }
  );

  return sanitizeSchedule({ ...doc, _id: insertedId, easycron_id: easycronId, enabled: true });
}

/**
 * The expression an edit should end up with.
 *
 * "Make it 6pm instead" arrives as a time and nothing else — no frequency, because the
 * caller is changing one thing about a schedule that already exists. Rebuilding from
 * scratch would fail on the missing frequency, so a lone time is swapped into the stored
 * expression's hour and minute and everything else about the cadence is left alone.
 */
function retimeFrom(row, patch = {}) {
  if (patch.cron_expression) return validateCronExpression(patch.cron_expression);
  if (patch.frequency) return resolveCronExpression(patch);

  const cadenceOnly = patch.weekday !== undefined || patch.day_of_month !== undefined || patch.minute !== undefined;

  if (patch.time) {
    const { hour, minute } = parseTimeOfDay(patch.time);
    const fields = row.cron_expression.split(" ");
    fields[0] = String(minute);
    fields[1] = String(hour);
    return validateCronExpression(fields.join(" "));
  }

  // A weekday or day-of-month on its own is ambiguous — it does not say whether the
  // schedule is meant to become weekly or monthly.
  if (cadenceOnly) {
    throw new Error("Send frequency along with weekday, day_of_month or minute so the new cadence is unambiguous");
  }

  return row.cron_expression;
}

/**
 * Retime, relabel, rewrite or pause a schedule. EasyCron is updated first here
 * (the row already exists and stays authoritative), so a rejected edit leaves
 * both sides on the old values rather than disagreeing.
 */
export async function updateSchedule(row, patch = {}) {
  const schedules = await getRangerSchedulesCollection();
  const set = { updated_at: new Date() };

  const cronExpression = retimeFrom(row, patch);
  const retimed = cronExpression !== row.cron_expression;
  const timezone = patch.timezone ? String(patch.timezone).trim() : row.timezone;

  if (retimed || timezone !== row.timezone) {
    nextCronRuns(cronExpression, timezone, 1);
    set.cron_expression = cronExpression;
    set.timezone = timezone;
  }

  if (patch.message !== undefined) {
    const message = String(patch.message || "").trim();
    if (!message) throw new Error("message cannot be empty");
    set.message = message;
  }
  if (patch.label !== undefined) set.label = String(patch.label || "").trim() || row.label;
  if (patch.group_id !== undefined) set.group_id = patch.group_id ? String(patch.group_id) : null;
  if (patch.thread_mode !== undefined && THREAD_MODES.includes(patch.thread_mode)) {
    set.thread_mode = patch.thread_mode;
  }
  if (patch.delivery !== undefined) {
    if (patch.delivery === null || patch.delivery === false || (patch.delivery && patch.delivery.type !== "telegram")) {
      set.delivery = null;
    } else if (patch.delivery?.type === "telegram" && patch.delivery.chat_id) {
      set.delivery = {
        type: "telegram",
        chat_id: patch.delivery.chat_id,
        username: patch.delivery.username || null,
      };
    } else {
      throw new Error("delivery must be null or { type: 'telegram', chat_id }");
    }
  }

  const wantsEnabled = patch.enabled === undefined ? row.enabled : Boolean(patch.enabled);

  if (row.easycron_id) {
    if (set.cron_expression || set.timezone || set.label) {
      await editCronJob(row.easycron_id, {
        cronExpression: set.cron_expression || row.cron_expression,
        timezone: set.timezone || row.timezone,
        name: `gtwy:${row.org_id || "org"}:${String(row._id)}`,
        groupId: process.env.EASYCRON_GROUP_ID || undefined,
      });
    }
    if (wantsEnabled !== row.enabled) {
      await setCronJobEnabled(row.easycron_id, wantsEnabled);
    }
  }
  set.enabled = wantsEnabled;

  await schedules.updateOne({ _id: row._id }, { $set: set });
  return sanitizeSchedule({ ...row, ...set });
}

/**
 * Delete a schedule and its job. The job goes first: a deleted row with a live
 * job is an orphan that fires forever, while a deleted job with a live row is
 * merely a dead entry the UI can show and the user can remove.
 */
export async function deleteSchedule(row) {
  const schedules = await getRangerSchedulesCollection();
  if (row.easycron_id) {
    try {
      await deleteCronJob(row.easycron_id);
    } catch (error) {
      // A job EasyCron no longer has is already gone; anything else is real.
      if (!/not found|no such|does not exist/i.test(error?.message || "")) throw error;
    }
  }
  await schedules.deleteOne({ _id: row._id });
}

/**
 * Pause or resume every schedule on a ranger — used when the ranger itself is
 * paused, so a paused ranger cannot keep firing crons.
 */
export async function setSchedulesEnabledForAgent(agentId, enabled) {
  const schedules = await getRangerSchedulesCollection();
  const rows = await schedules.find({ agent_id: String(agentId) }).toArray();
  const results = { changed: 0, failed: [] };

  for (const row of rows) {
    if (row.enabled === enabled || !row.easycron_id) continue;
    try {
      await setCronJobEnabled(row.easycron_id, enabled);
      await schedules.updateOne({ _id: row._id }, { $set: { enabled, updated_at: new Date() } });
      results.changed += 1;
    } catch (error) {
      results.failed.push({ id: String(row._id), message: error?.message || "Failed" });
    }
  }
  return results;
}

/** Remove every schedule on a ranger, jobs included. For agent/version deletion. */
export async function deleteSchedulesForAgent(agentId, { versionId } = {}) {
  const schedules = await getRangerSchedulesCollection();
  const query = { agent_id: String(agentId) };
  if (versionId) query.version_id = String(versionId);
  const rows = await schedules.find(query).toArray();

  const results = { deleted: 0, failed: [] };
  for (const row of rows) {
    try {
      await deleteSchedule(row);
      results.deleted += 1;
    } catch (error) {
      results.failed.push({ id: String(row._id), message: error?.message || "Failed" });
    }
  }
  return results;
}
