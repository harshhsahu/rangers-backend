import { env } from '../config/env.js';
import { AppError, errorMessage } from '../utils/AppError.js';

export interface GtwyAgent {
  org_id?: string | number | null;
  versions?: unknown[];
  [key: string]: unknown;
}

export interface AgentAccess {
  token: string;
  agent: GtwyAgent;
  orgId: string | null;
}

export interface AccessTarget {
  agentId?: string | null;
  versionId?: string | null;
}

/**
 * Verifies the caller against the GTWY server and confirms they may manage this
 * agent version. The session token is signed by the GTWY server, so it is
 * validated there rather than locally — GTWY answers both "is this token valid"
 * and "does this org own this agent" in one call, which also closes the IDOR on
 * version_id.
 */
export async function verifyAgentAccess(
  token: string | null | undefined,
  { agentId, versionId }: AccessTarget
): Promise<AgentAccess> {
  if (!token) throw AppError.unauthorized('Authorization token is required');
  if (!env.SERVER_URL) throw new AppError(500, 'SERVER_URL is not configured');
  if (!agentId) throw AppError.badRequest('agent_id is required');

  let res: Response;
  try {
    res = await fetch(`${env.SERVER_URL}/api/agent/${encodeURIComponent(agentId)}`, {
      headers: { Authorization: token },
      cache: 'no-store',
    });
  } catch (error) {
    console.error('[auth] agent verification request failed:', errorMessage(error));
    throw new AppError(503, 'Could not verify authorization, please retry', { cause: error });
  }

  if (res.status === 401) throw AppError.unauthorized('Invalid or expired session token');
  // 403/404/anything else — do not disclose whether the agent exists
  if (!res.ok) throw AppError.forbidden('You do not have access to this agent');

  const body: any = await res.json().catch(() => ({}));
  const agent: GtwyAgent | null = body?.agent || body?.data?.agent || body?.data || null;
  if (!agent) throw AppError.forbidden('You do not have access to this agent');

  // The version being acted on must belong to the agent we just authorized
  const versions = Array.isArray(agent.versions) ? agent.versions.map(String) : [];
  if (versionId && versions.length > 0 && !versions.includes(String(versionId))) {
    throw AppError.forbidden('version_id does not belong to this agent');
  }

  return { token, agent, orgId: agent.org_id != null ? String(agent.org_id) : null };
}
