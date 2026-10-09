import type { NextFunction, Request, Response } from 'express';
import type Joi from 'joi';
import { AppError } from '../utils/AppError.js';

export interface RequestSchemas {
  body?: Joi.Schema;
  query?: Joi.Schema;
  params?: Joi.Schema;
}

const OPTIONS: Joi.ValidationOptions = {
  // One clear message per request, matching what the UI shows.
  abortEarly: true,
  // Drop keys a schema does not declare; schemas that must keep them opt in with .unknown(true).
  stripUnknown: true,
  convert: true,
  errors: { wrap: { label: false } },
};

/**
 * Validates and normalises request input before the controller runs. On success the
 * parsed values (trimmed, defaulted, stripped) replace `req.body`, `req.query` and
 * `req.params`, so controllers only ever see validated data. The first failure is a 400.
 */
export function validate(schemas: RequestSchemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    for (const source of ['params', 'query', 'body'] as const) {
      const schema = schemas[source];
      if (!schema) continue;

      const { value, error } = schema.validate(req[source] ?? {}, OPTIONS);
      if (error) return next(AppError.badRequest(error.details[0]?.message ?? 'Invalid request'));

      if (source === 'query') {
        // Express 5 exposes req.query through a getter; shadow it with the parsed value.
        Object.defineProperty(req, 'query', { value, writable: true, configurable: true, enumerable: true });
      } else {
        req[source] = value;
      }
    }
    next();
  };
}
