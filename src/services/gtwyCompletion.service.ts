import { env } from '../config/env.js';
import type { AgentSlug } from '../constants/agents.js';
import type { AgentTool } from '../models/agent.model.js';
import { AppError } from '../utils/AppError.js';
import { getAgent } from './agents.service.js';
import { assertAgentModelAvailable } from './gtwyModels.service.js';

export interface AgentCall {
  user: string;
  thread_id: string;
  /** Substituted into the prompt as {{name}}, and into tool urls and headers. */
  variables?: Record<string, unknown>;
  stream?: boolean;
}

/** `{{name}}` in a tool's url and header values, filled from the call's variables. GTWY sends both verbatim. */
function fillTool(tool: AgentTool, variables: Record<string, unknown>): AgentTool {
  const fill = (text: string) =>
    text.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) =>
      name in variables ? String(variables[name]) : placeholder
    );
  return {
    ...tool,
    url: fill(tool.url),
    ...(tool.headers && {
      headers: Object.fromEntries(Object.entries(tool.headers).map(([key, value]) => [key, fill(value)])),
    }),
  };
}

/**
 * Runs one of our agents through GTWY's direct completion API: the agent's model, prompt
 * and tools come from its document in the `agents` collection and are sent with the call,
 * so no agent has to exist on GTWY.
 *
 * Calls carry this app's pauthkey, which identifies the app and never leaves the server.
 * Some agents accept ACCESS_KEY as a fallback key.
 */
export async function requestAgentCompletion(
  slug: AgentSlug,
  { variables = {}, ...call }: AgentCall,
  { allowAccessKeyFallback = false } = {}
): Promise<Response> {
  const pauthkey = env.GTWY_PAUTH_KEY || (allowAccessKeyFallback ? env.ACCESS_KEY : undefined);
  if (!env.GTWY_PYTHON_GTWY_SERVER_URL) throw new Error('GTWY_PYTHON_GTWY_SERVER_URL is not set');
  if (!pauthkey) throw new Error('GTWY_PAUTH_KEY is not set');

  const { service, configuration, settings, tools } = await getAgent(slug);
  await assertAgentModelAvailable({ service, configuration });

  return fetch(`${env.GTWY_PYTHON_GTWY_SERVER_URL}/api/v2/model/ai/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', pauthkey },
    body: JSON.stringify({
      service,
      configuration,
      settings,
      extra_tools: tools?.map((tool) => fillTool(tool, variables)),
      variables,
      ...call,
    }),
  });
}

/**
 * The direct API allows each org 100 calls a minute and each thread 20, shared by every
 * agent on it. That limit is passed on as a 429 rather than reported as an outage.
 */
export function throwIfRateLimited(upstream: Response): void {
  if (upstream.status === 429) throw new AppError(429, 'The assistant is busy right now. Try again in a minute.');
}

/* ------------------------------------------------------------------ responses */

/** The reply content, whichever envelope the completion API wrapped it in (varies by deployment). */
export function completionContent(data: any): unknown {
  return (
    data?.response?.data?.content ??
    data?.data?.content ??
    data?.content ??
    data?.response?.content ??
    data?.response ??
    null
  );
}

/** Best error message from a failed upstream body, including FastAPI's `detail` and 422 shapes. */
export function upstreamErrorMessage(data: any, rawText: string, fallback = 'GTWY request failed'): string {
  const detail = data?.detail;
  return (
    data?.message ||
    data?.error ||
    data?.errors?.[0]?.msg ||
    detail?.error ||
    (typeof detail === 'string' ? detail : '') ||
    rawText?.slice(0, 500) ||
    fallback
  );
}
