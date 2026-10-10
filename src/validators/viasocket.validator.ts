import Joi from 'joi';
import { idParams, nullableString, optionalString, requiredString } from './common.js';

export interface AppSearchQuery {
  key?: string;
}

export type ServiceIdParams = { serviceId: string };

export interface EmbedTokenBody {
  embed_token: string;
}

export interface AuthenticationsBody {
  embed_token: string;
  service_id?: string;
  service_name?: string;
}

export interface TokenBody {
  org_id?: string;
  agent_id?: string;
  version_id?: string;
}

export interface AppToolsQuery {
  agent_id: string;
  version_id?: string;
}

export interface AddAppToolBody {
  agent_id: string;
  version_id?: string;
  service_id: string;
  auth_id: string;
  embed_token: string;
  service_name?: string;
  icon_url?: string | null;
  org_id?: string | null;
  user_id?: string | null;
}

export interface EnableToolBody {
  service_id: string;
  auth_id: string;
  embed_token: string;
  action: Record<string, unknown> & { actionversionrecordid: string | number };
  org_id?: string;
  agent_id?: string;
  version_id?: string;
}

/** GTWY's tool-call arguments; the action decides which keys matter, so all pass through. */
export type RunToolBody = Record<string, unknown>;

export const appSearchSchema = {
  query: Joi.object<AppSearchQuery>({ key: Joi.string().trim().allow('').default('') }),
};

export const versionsSchema = {
  params: Joi.object<ServiceIdParams>({ serviceId: requiredString('service id is required') }),
};

export const registerSchema = {
  body: Joi.object<EmbedTokenBody>({ embed_token: requiredString('embed_token is required') }),
};

export const authenticationsSchema = {
  body: Joi.object<AuthenticationsBody>({
    embed_token: requiredString('embed_token is required'),
    service_id: optionalString,
    service_name: optionalString,
  }),
};

export const tokenSchema = {
  body: Joi.object<TokenBody>({
    org_id: optionalString,
    agent_id: optionalString,
    version_id: optionalString,
  }),
};

export const listAppToolsSchema = {
  query: Joi.object<AppToolsQuery>({
    agent_id: requiredString('agent_id is required'),
    version_id: optionalString,
  }),
};

const appToolRequired = 'service_id, auth_id and embed_token are required';

export const addAppToolSchema = {
  body: Joi.object<AddAppToolBody>({
    agent_id: requiredString('agent_id is required'),
    version_id: optionalString,
    service_id: requiredString(appToolRequired),
    auth_id: requiredString(appToolRequired),
    embed_token: requiredString(appToolRequired),
    service_name: optionalString,
    icon_url: nullableString,
    org_id: nullableString,
    user_id: nullableString,
  }),
};

const enableToolRequired = 'service_id, auth_id, embed_token and action are required';

export const enableToolSchema = {
  body: Joi.object<EnableToolBody>({
    service_id: requiredString(enableToolRequired),
    auth_id: requiredString(enableToolRequired),
    embed_token: requiredString(enableToolRequired),
    action: Joi.object({
      actionversionrecordid: Joi.alternatives(Joi.string().trim(), Joi.number())
        .required()
        .messages({ 'any.required': enableToolRequired }),
    })
      .unknown(true)
      .required()
      .messages({ 'any.required': enableToolRequired, 'object.base': enableToolRequired }),
    org_id: optionalString,
    agent_id: optionalString,
    version_id: optionalString,
  }),
};

export const toolIdSchema = { params: idParams };

export const runToolSchema = {
  params: idParams,
  body: Joi.object<RunToolBody>().unknown(true),
};
