import Joi from 'joi';
import { lenientArray, optionalString, requiredString } from './common.js';

export interface BuildChatBody {
  message: string;
  thread_id: string;
}

export interface PromptDraftBody {
  name?: string;
  role?: string;
  description: string;
}

export interface UpdateChatBody {
  message: string;
  thread_id: string;
  version_id: string;
  agent_id: string;
  org_timezone: string;
  model_type: string;
  available_knowledge_bases: unknown[];
}

export const buildChatSchema = {
  body: Joi.object<BuildChatBody>({
    message: requiredString('message is required'),
    thread_id: requiredString('thread_id is required'),
  }),
};

export const promptDraftSchema = {
  body: Joi.object<PromptDraftBody>({
    name: optionalString,
    role: optionalString,
    description: requiredString('Describe what the ranger does'),
  }),
};

export const updateChatSchema = {
  body: Joi.object<UpdateChatBody>({
    message: requiredString('message is required'),
    thread_id: requiredString('thread_id is required'),
    version_id: requiredString('version_id is required'),
    // Checked by the agent-access service, which answers with its own 400.
    agent_id: Joi.string().trim().allow('').default(''),
    org_timezone: optionalString.default('UTC'),
    model_type: optionalString.default('chat'),
    available_knowledge_bases: lenientArray(Joi.array(), []).default([]),
  }),
};
