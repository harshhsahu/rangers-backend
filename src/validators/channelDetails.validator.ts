import Joi from 'joi';
import { nullableString, optionalString, requiredString } from './common.js';

export interface ChannelLookupQuery {
  id?: string;
  version_id?: string;
}

export interface CreateChannelBody {
  version_id: string;
  agent_id: string | null;
  org_id: string | null;
  telegram: { botToken: string; webhookUrl: string | null; webhookSet?: boolean };
}

export interface UpdateChannelBody {
  id?: string;
  version_id?: string;
  telegram?: Record<string, unknown>;
  agent_id?: string | null;
  org_id?: string | null;
}

const lookupQuery = Joi.object<ChannelLookupQuery>({
  id: optionalString,
  version_id: optionalString,
});

/** GET: ?id= takes precedence over ?version_id=; neither lists every channel. */
export const getChannelsSchema = { query: lookupQuery };

export const createChannelSchema = {
  body: Joi.object<CreateChannelBody>({
    version_id: requiredString('version_id is required'),
    agent_id: nullableString,
    org_id: nullableString,
    telegram: Joi.object({
      botToken: requiredString('telegram.botToken is required'),
      webhookUrl: nullableString,
      webhookSet: Joi.boolean(),
    })
      .required()
      .messages({ 'any.required': 'telegram.botToken is required', 'object.base': 'telegram.botToken is required' }),
  }),
};

export const updateChannelSchema = {
  body: Joi.object<UpdateChannelBody>({
    id: optionalString,
    version_id: optionalString,
    telegram: Joi.object().unknown(true),
    agent_id: Joi.string().trim().allow(null, ''),
    org_id: Joi.string().trim().allow(null, ''),
  })
    .or('id', 'version_id')
    .messages({ 'object.missing': 'id or version_id is required' }),
};

export const deleteChannelSchema = {
  query: lookupQuery.or('id', 'version_id').messages({ 'object.missing': 'id or version_id is required' }),
};
