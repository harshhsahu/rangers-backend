import { env } from '../config/env.js';
import { signInternalJwt } from '../lib/jwt.js';
import { AppError } from '../utils/AppError.js';

interface Msg91User {
  id: string | number;
  name?: string;
  currentCompany?: { id?: string | number; name?: string };
}

/** Resolves the MSG91 user (and their current org) behind a proxy_auth_token. */
async function resolveProxyAuthToken(proxyAuthToken: string) {
  const res = await fetch(`${env.PROXY_URL}/api/c/getDetails`, {
    method: 'GET',
    headers: { proxy_auth_token: proxyAuthToken },
    cache: 'no-store',
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AppError(500, json?.message || json?.error || `getDetails failed (${res.status})`);
  }

  const user: Msg91User | undefined = json?.data?.[0] || json?.data?.data?.[0];
  if (!user) throw new AppError(500, 'Invalid proxy_auth_token — no user in getDetails');

  return { user, orgId: user.currentCompany?.id ?? null };
}

/**
 * Same as public/gtwy.js embed login: POST /api/embed/login with the embed JWT.
 * Returns the GTWY session used for all subsequent APIs.
 */
async function gtwyEmbedLogin(embedJwt: string) {
  if (!env.SERVER_URL) throw new AppError(500, 'SERVER_URL is not set');

  const res = await fetch(`${env.SERVER_URL}/api/embed/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: embedJwt },
  });

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new AppError(500, json?.message || json?.error || `GTWY embed login failed (${res.status})`);
  }

  const data = json?.data || json;
  if (!data?.token) throw new AppError(500, 'GTWY embed login did not return a token');
  return data;
}

/**
 * Internal login:
 *  1. getDetails(proxy) resolves the current user's org id
 *  2. an embed JWT { org_id, folder_id, user_id } is signed with ACCESS_KEY
 *  3. GTWY embed login exchanges it for a session token
 */
export async function internalLogin(proxyAuthToken: string) {
  if (!env.ORG_ID || !env.ACCESS_KEY || !env.FOLDER_ID) {
    throw new AppError(500, 'ORG_ID, FOLDER_ID, or ACCESS_KEY missing in env');
  }

  const { user, orgId: userOrgId } = await resolveProxyAuthToken(proxyAuthToken);
  if (!userOrgId) throw AppError.badRequest('No org id from getDetails (and no userOrgId override)');

  const embedJwt = signInternalJwt({ userOrgId });
  const gtwy = await gtwyEmbedLogin(embedJwt);

  return {
    // Use THIS token for all GTWY API Authorization (same as embed)
    token: gtwy.token,
    org_id: String(gtwy.org_id || gtwy.company_id || ''),
    folder_id: String(gtwy.folder_id || env.FOLDER_ID),
    gtwy_user_id: String(gtwy.user_id || ''),
    // MSG91 user context
    user_org_id: String(userOrgId),
    user_id: String(user.id),
    user_name: user.name || '',
    company_name: user.currentCompany?.name || '',
    jwt_org_id: env.ORG_ID,
    config: gtwy.config || null,
  };
}
