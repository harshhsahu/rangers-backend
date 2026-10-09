import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Guards a route with a shared secret sent in `header`.
 *
 * - `hideRoute`: answer 404 rather than 401 so the route's existence is not disclosed.
 * - `optional`: when no secret is configured, let every request through (dev relays).
 *   Otherwise an unconfigured secret disables the route.
 */
export function requireHeaderSecret(
  header: string,
  getSecret: () => string | undefined,
  { hideRoute = false, optional = false } = {}
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const secret = getSecret();
    if (!secret && optional) return next();

    const provided = req.get(header);
    if (secret && provided && safeEqual(provided, secret)) return next();

    if (hideRoute) {
      res.status(404).json({ success: false });
    } else {
      res.status(401).json({ ok: false, error: 'unauthorized' });
    }
  };
}
