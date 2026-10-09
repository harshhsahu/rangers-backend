import type { Request, Response } from 'express';
import { internalLogin } from '../services/auth.service.js';
import type { InternalLoginBody } from '../validators/auth.validator.js';

/** POST /api/auth/internal-login — exchanges an MSG91 proxy_auth_token for a GTWY session. */
export async function login(req: Request<{}, unknown, InternalLoginBody>, res: Response) {
  const { proxy_auth_token, proxyAuthToken } = req.body;
  const data = await internalLogin((proxy_auth_token || proxyAuthToken)!);
  res.json({ success: true, data });
}
