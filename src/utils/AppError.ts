/**
 * An error whose status and message are meant for the caller. Anything else that
 * reaches the error handler is treated as an internal failure and not exposed.
 */
export class AppError extends Error {
  readonly status: number;

  constructor(status: number, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.status = status;
  }

  static badRequest(message: string) {
    return new AppError(400, message);
  }

  static unauthorized(message: string) {
    return new AppError(401, message);
  }

  static forbidden(message: string) {
    return new AppError(403, message);
  }

  static notFound(message: string) {
    return new AppError(404, message);
  }

  /**
   * Wraps a failure from domain code whose messages are written for the user
   * (invalid cron field, schedule cap reached…) as a client error.
   */
  static asClientError(error: unknown, fallback: string) {
    if (error instanceof AppError) return error;
    return new AppError(400, errorMessage(error) || fallback, { cause: error });
  }

  /** Wraps an unexpected failure with a safe message; the cause is logged, not returned. */
  static asServerError(error: unknown, message: string) {
    if (error instanceof AppError) return error;
    return new AppError(500, message, { cause: error });
  }
}

/** Message of an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : '';
}
