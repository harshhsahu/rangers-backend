import type { Request, Response } from 'express';
import * as scheduler from '../services/scheduler.service.js';
import type { IdParams } from '../validators/common.js';
import type {
  CreateScheduleBody,
  CronAiBody,
  CronTriggerQuery,
  LifecycleBody,
  ListSchedulesQuery,
  UpdateScheduleBody,
} from '../validators/scheduler.validator.js';
import { validatedQuery } from '../utils/validatedInput.js';

/** GET /api/scheduler?agent_id=&version_id= */
export async function listSchedules(req: Request, res: Response) {
  const { agent_id, version_id } = validatedQuery<ListSchedulesQuery>(req);
  const result = await scheduler.listSchedules(req.sessionToken, agent_id, version_id);
  res.json({ success: true, ...result });
}

/** POST /api/scheduler */
export async function createSchedule(req: Request<{}, unknown, CreateScheduleBody>, res: Response) {
  const schedule = await scheduler.createSchedule(req.sessionToken, req.body);
  res.status(201).json({ success: true, schedule });
}

/** GET /api/scheduler/:id */
export async function getSchedule(req: Request<IdParams>, res: Response) {
  const schedule = await scheduler.getSchedule(req.sessionToken, req.params.id);
  res.json({ success: true, schedule });
}

/** PATCH /api/scheduler/:id — retime, relabel, rewrite, enable or disable. */
export async function updateSchedule(req: Request<IdParams, unknown, UpdateScheduleBody>, res: Response) {
  const schedule = await scheduler.updateSchedule(req.sessionToken, req.params.id, req.body);
  res.json({ success: true, schedule });
}

/** DELETE /api/scheduler/:id */
export async function deleteSchedule(req: Request<IdParams>, res: Response) {
  const deleted = await scheduler.deleteSchedule(req.sessionToken, req.params.id);
  res.json({ success: true, deleted });
}

/** POST /api/scheduler/:id/run — authenticated "run now"; 202 once the run has started. */
export async function runScheduleNow(req: Request<IdParams>, res: Response) {
  const scheduleId = await scheduler.runScheduleNow(req.sessionToken, req.params.id);
  res.status(202).json({ success: true, accepted: true, schedule: scheduleId });
}

/**
 * GET|POST /api/scheduler/run?id= — the URL EasyCron calls. A disabled schedule is a
 * normal state, so it is answered 200 rather than showing up as a failing job.
 */
export async function triggerScheduledRun(req: Request, res: Response) {
  const result = await scheduler.triggerScheduledRun(validatedQuery<CronTriggerQuery>(req).id);

  switch (result.status) {
    case 'not_found':
      res.status(404).json({ success: false });
      return;
    case 'disabled':
      res.status(200).json({ success: true, skipped: 'disabled' });
      return;
    case 'accepted':
      res.status(202).json({ success: true, accepted: true, schedule: result.scheduleId });
  }
}

/** POST /api/scheduler/lifecycle — pause, resume or delete every schedule of a ranger. */
export async function applyLifecycle(req: Request<{}, unknown, LifecycleBody>, res: Response) {
  const { agent_id, version_id, action } = req.body;
  const result = await scheduler.applyLifecycle(req.sessionToken, {
    agentId: agent_id,
    versionId: version_id,
    action,
  });
  res.json({ success: true, ...result });
}

/** GET /api/scheduler/reconcile — admin-only drift report between Mongo and EasyCron. */
export async function reconcileSchedules(_req: Request, res: Response) {
  const report = await scheduler.reconcileSchedules();
  res.json({ success: true, ...report });
}

/** POST /api/scheduler/cron-ai — plain-English cadence to a validated cron expression. */
export async function generateCronExpression(req: Request<{}, unknown, CronAiBody>, res: Response) {
  const { text, timezone, agent_id, version_id } = req.body;
  const result = await scheduler.suggestCron(req.sessionToken, {
    agentId: agent_id,
    versionId: version_id,
    text,
    timezone,
  });
  res.json({ success: true, ...result });
}
