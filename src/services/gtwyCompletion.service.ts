import { env } from '../config/env.js';

export interface CompletionRequest {
  user: string;
  agent_id: string;
  thread_id: string;
  stream?: boolean;
  response_type?: string;
  variables?: Record<string, unknown>;
}

/**
 * Calls the GTWY completion API with this app's pauthkey. The key identifies the app
 * and never leaves the server. Some agents accept ACCESS_KEY as a fallback key.
 */
export async function requestCompletion(
  payload: CompletionRequest,
  { allowAccessKeyFallback = false } = {}
): Promise<Response> {
  const pauthkey = env.GTWY_PAUTH_KEY || (allowAccessKeyFallback ? env.ACCESS_KEY : undefined);
  if (!env.GTWY_PYTHON_GTWY_SERVER_URL) throw new Error('GTWY_PYTHON_GTWY_SERVER_URL is not set');
  if (!pauthkey) throw new Error('GTWY_PAUTH_KEY is not set');

  return fetch(`${env.GTWY_PYTHON_GTWY_SERVER_URL}/api/v2/model/chat/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', pauthkey },
    body: JSON.stringify(payload),
  });
}

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

/** Best error message from a failed upstream body. */
export function upstreamErrorMessage(data: any, rawText: string, fallback = 'GTWY request failed'): string {
  return data?.message || data?.error || rawText?.slice(0, 500) || fallback;
}
