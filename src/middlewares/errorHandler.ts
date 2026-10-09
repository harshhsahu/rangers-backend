import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/AppError.js';

export function notFound(req: Request, _res: Response, next: NextFunction) {
  next(AppError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

/** body-parser errors carry an HTTP status and a `type`. */
interface BodyParserError {
  status?: number;
  type?: string;
}

const BODY_PARSER_MESSAGES: Record<string, string> = {
  'entity.parse.failed': 'Request body is not valid JSON',
  'entity.too.large': 'Request body is too large',
};

/**
 * Single place errors become responses. AppErrors are returned as written; anything
 * else is logged and answered with a generic 500 so internals never leak.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  let status = 500;
  let message = 'Internal Server Error';

  const parserError = err as BodyParserError;
  if (err instanceof AppError) {
    status = err.status;
    message = err.message;
  } else if (parserError?.type && parserError.type in BODY_PARSER_MESSAGES) {
    status = parserError.status ?? 400;
    message = BODY_PARSER_MESSAGES[parserError.type];
  }

  if (status >= 500) {
    const cause = err instanceof AppError && err.cause ? err.cause : err;
    console.error(`[error] ${req.method} ${req.originalUrl}`, cause);
  }

  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ success: false, error: message });
}
