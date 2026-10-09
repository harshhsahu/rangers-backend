import Joi from 'joi';
import { optionalString } from './common.js';

export interface InternalLoginBody {
  proxy_auth_token?: string;
  /** camelCase alias accepted for older callers */
  proxyAuthToken?: string;
}

export const internalLoginSchema = {
  body: Joi.object<InternalLoginBody>({
    proxy_auth_token: optionalString,
    proxyAuthToken: optionalString,
  })
    .or('proxy_auth_token', 'proxyAuthToken')
    .messages({ 'object.missing': 'proxy_auth_token is required' }),
};
