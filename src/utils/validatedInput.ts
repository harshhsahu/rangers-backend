import type { Request } from 'express';

/**
 * The request's query string as parsed by the route's `validate()` middleware.
 * Express types `req.query` as raw ParsedQs, which cannot carry the defaults and
 * nulls the schema produces, so the validated shape is read through this accessor.
 */
export function validatedQuery<T>(req: Request): T {
  return req.query as unknown as T;
}
