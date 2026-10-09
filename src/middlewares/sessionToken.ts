import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';

/** Cookie name used by setInCookies() in the frontend's utils/utility.js (env-prefixed). */
const LOCAL_TOKEN_COOKIE = env.APP_ENV ? `${env.APP_ENV}_env_local_token` : 'local_token';

function readCookie(req: Request, name: string): string | null {
  const header = req.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/**
 * Cookies are sent by the browser on every same-origin request, so a
 * cookie-authenticated request is CSRF-able. Accept it only when the request
 * demonstrably originated from the app.
 */
function isSameOrigin(req: Request): boolean {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin' || site === 'none';

  const origin = req.get('origin');
  if (!origin) {
    // No Origin and no Sec-Fetch-Site (curl / server-to-server): such callers
    // must send the Authorization header instead.
    return false;
  }
  // Behind the frontend's /api rewrite the browser-facing host arrives as x-forwarded-host.
  const host = req.get('x-forwarded-host') || req.get('host');
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Resolves the caller's GTWY session token onto `req.sessionToken`. Preferred as
 * `Authorization: <token>`; falls back to the local_token cookie for same-origin
 * browser requests. Does not reject — services decide whether a token is required.
 */
export function sessionToken(req: Request, _res: Response, next: NextFunction) {
  const fromHeader = (req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  req.sessionToken = fromHeader || (isSameOrigin(req) ? readCookie(req, LOCAL_TOKEN_COOKIE)?.trim() || null : null);
  next();
}
