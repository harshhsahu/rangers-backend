import { Router } from 'express';
import { env } from '../config/env.js';
import * as scheduler from '../controllers/scheduler.controller.js';
import { requireHeaderSecret } from '../middlewares/requireHeaderSecret.js';
import { validate } from '../middlewares/validate.js';
import {
  createScheduleSchema,
  cronAiSchema,
  cronTriggerSchema,
  lifecycleSchema,
  listSchedulesSchema,
  scheduleIdSchema,
  updateScheduleSchema,
} from '../validators/scheduler.validator.js';

const router = Router();

router
  .route('/')
  .get(validate(listSchedulesSchema), scheduler.listSchedules)
  .post(validate(createScheduleSchema), scheduler.createSchedule);

// Called by EasyCron, which can be configured to GET or POST.
router
  .route('/run')
  .get(validate(cronTriggerSchema), scheduler.triggerScheduledRun)
  .post(validate(cronTriggerSchema), scheduler.triggerScheduledRun);

// Spans every org, so it is gated by an admin key and hidden (404) without one.
router.get(
  '/reconcile',
  requireHeaderSecret('x-scheduler-admin-key', () => env.SCHEDULER_ADMIN_KEY, { hideRoute: true }),
  scheduler.reconcileSchedules
);

router.post('/lifecycle', validate(lifecycleSchema), scheduler.applyLifecycle);
router.post('/cron-ai', validate(cronAiSchema), scheduler.generateCronExpression);

// Declared after the static paths above so they are not captured as an :id.
router
  .route('/:id')
  .get(validate(scheduleIdSchema), scheduler.getSchedule)
  .patch(validate(updateScheduleSchema), scheduler.updateSchedule)
  .delete(validate(scheduleIdSchema), scheduler.deleteSchedule);
router.post('/:id/run', validate(scheduleIdSchema), scheduler.runScheduleNow);

export default router;
