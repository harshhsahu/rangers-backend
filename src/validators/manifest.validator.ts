import Joi from 'joi';
import { optionalString } from './common.js';

export interface ManifestQuery {
  start?: string;
}

export const manifestSchema = {
  query: Joi.object<ManifestQuery>({
    start: optionalString,
  }),
};
