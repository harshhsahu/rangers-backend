import { env } from '../config/env.js';
import type { Agent } from '../models/agent.model.js';
import { AppError, errorMessage } from '../utils/AppError.js';

/**
 * GTWY's model catalog for one service, as GET /api/service/:service returns it: active
 * models only, grouped by type (chat, reasoning, image…). An unknown service is `{}`.
 */
type ServiceCatalog = Record<string, Record<string, unknown>>;

/** `null` means the catalog could not be read, so nothing is known either way. */
export type ModelCheck = { ok: true } | { ok: false; problem: string } | null;

const CATALOG_TIMEOUT_MS = 5_000;
/** How long an unanswered check is reused before the catalog is asked again. */
const RETRY_AFTER_MS = 60_000;

/**
 * One check per service/type/model for the life of the process. An unanswered one expires
 * after RETRY_AFTER_MS, so a GTWY outage costs one catalog request a minute, not one per call.
 */
const checks = new Map<string, { result: Promise<ModelCheck>; expiresAt: number }>();

async function fetchServiceCatalog(service: string): Promise<ServiceCatalog | null> {
  if (!env.GTWY_SERVER_URL || !env.GTWY_PAUTH_KEY) {
    console.warn('[gtwy-models] GTWY_SERVER_URL or GTWY_PAUTH_KEY is not set; skipping the model check');
    return null;
  }
  try {
    const res = await fetch(`${env.GTWY_SERVER_URL}/api/service/${encodeURIComponent(service)}`, {
      headers: { pauthkey: env.GTWY_PAUTH_KEY },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn('[gtwy-models] catalog request failed', service, res.status);
      return null;
    }
    return (await res.json()) as ServiceCatalog;
  } catch (error) {
    console.warn('[gtwy-models] catalog request failed', service, errorMessage(error));
    return null;
  }
}

async function lookUpModel(service: string, type: string, model: string): Promise<ModelCheck> {
  const catalog = await fetchServiceCatalog(service);
  if (!catalog) return null;
  if (!Object.values(catalog).some((models) => Object.keys(models ?? {}).length)) {
    return { ok: false, problem: `GTWY has no active models for service "${service}"` };
  }
  if (catalog[type]?.[model]) return { ok: true };

  const actualType = Object.keys(catalog).find((group) => catalog[group]?.[model]);
  return {
    ok: false,
    problem: actualType
      ? `${service}/${model} is a ${actualType} model on GTWY, but the agent sends type "${type}"`
      : `${service}/${model} is not an active model on GTWY`,
  };
}

/** Whether GTWY's catalog lists the agent's model under its service and type. */
export function checkAgentModel({ service, configuration }: Pick<Agent, 'service' | 'configuration'>): Promise<ModelCheck> {
  const { type, model } = configuration;
  const key = `${service}/${type}/${model}`;
  const cached = checks.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.result;

  // In flight it never expires, so concurrent calls share one catalog request.
  const entry = { result: lookUpModel(service, type, model), expiresAt: Infinity };
  entry.result = entry.result.then((result) => {
    if (!result) entry.expiresAt = Date.now() + RETRY_AFTER_MS;
    else if (!result.ok) console.error(`[gtwy-models] ${result.problem}`);
    return result;
  });
  checks.set(key, entry);
  return entry.result;
}

/**
 * Refuses a call whose model GTWY's catalog says cannot run. When the catalog cannot be
 * read the call goes ahead: GTWY still validates the model itself.
 */
export async function assertAgentModelAvailable(agent: Pick<Agent, 'service' | 'configuration'>): Promise<void> {
  const result = await checkAgentModel(agent);
  if (result && !result.ok) throw new AppError(503, `The assistant is unavailable: ${result.problem}.`);
}
