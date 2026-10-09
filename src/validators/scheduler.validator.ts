import Joi from 'joi';
import { idParams, optionalString, requiredString } from './common.js';

export interface ListSchedulesQuery {
  version_id: string;
  agent_id?: string;
}

/**
 * The schedule itself (frequency, time, cron_expression, timezone, query, delivery…) is
 * validated by the schedule domain, which owns those rules — so unknown keys pass through.
 */
export interface CreateScheduleBody {
  version_id: string;
  agent_id?: string;
  created_by?: string;
  [key: string]: unknown;
}

export type UpdateScheduleBody = Record<string, unknown>;

export interface CronTriggerQuery {
  id: string;
}

export interface LifecycleBody {
  agent_id: string;
  version_id?: string;
  action: 'pause' | 'resume' | 'delete';
}

export interface CronAiBody {
  text: string;
  timezone: string;
  agent_id?: string;
  version_id?: string;
}

export const listSchedulesSchema = {
  query: Joi.object<ListSchedulesQuery>({
    version_id: requiredString('version_id is required'),
    agent_id: optionalString,
  }),
};

export const createScheduleSchema = {
  body: Joi.object<CreateScheduleBody>({
    version_id: requiredString('version_id is required'),
    agent_id: optionalString,
    created_by: optionalString,
  }).unknown(true),
};

export const scheduleIdSchema = { params: idParams };

export const updateScheduleSchema = {
  params: idParams,
  body: Joi.object<UpdateScheduleBody>().unknown(true),
};

/** EasyCron's call carries only the id; an unknown or malformed one is answered 404 later. */
export const cronTriggerSchema = {
  query: Joi.object<CronTriggerQuery>({
    id: Joi.string().allow('').default(''),
  }),
};

export const lifecycleSchema = {
  body: Joi.object<LifecycleBody>({
    agent_id: requiredString('agent_id is required'),
    version_id: optionalString,
    action: Joi.string().trim().valid('pause', 'resume', 'delete').required().messages({
      'any.only': 'action must be pause, resume or delete',
      'any.required': 'action must be pause, resume or delete',
      'string.empty': 'action must be pause, resume or delete',
      'string.base': 'action must be pause, resume or delete',
    }),
  }),
};

export const cronAiSchema = {
  body: Joi.object<CronAiBody>({
    text: requiredString('Describe when it should run'),
    timezone: optionalString.default('UTC'),
    agent_id: optionalString,
    version_id: optionalString,
  }),
};
