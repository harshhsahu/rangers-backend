import { randomUUID } from 'node:crypto';
import type { ReadableStream } from 'node:stream/web';
import { env } from '../config/env.js';
import { AGENTS } from '../constants/agents.js';
import { AppError, errorMessage } from '../utils/AppError.js';
import { safeJsonParse } from '../utils/json.js';
import { verifyAgentAccess } from './agentAccess.service.js';
import {
  completionContent,
  requestAgentCompletion,
  throwIfRateLimited,
  upstreamErrorMessage,
} from './gtwyCompletion.service.js';

/** Reads a failed upstream response and turns it into an error with the upstream status. */
async function upstreamError(upstream: Response): Promise<AppError> {
  const rawText = await upstream.text().catch(() => '');
  return new AppError(upstream.status, upstreamErrorMessage(safeJsonParse(rawText, {}), rawText));
}

/* ------------------------------------------------------------------ build chat */

export interface BuildChatReply {
  response: string;
  draft_config: unknown;
}

/**
 * "Build with AI" chat. The shape of the reply comes from the agent's response_type, a
 * json_schema for {response, draft_config} in its document.
 */
export async function buildChat(message: string, threadId: string): Promise<BuildChatReply> {
  const upstream = await requestAgentCompletion(AGENTS.RANGER_BUILDER, {
    user: message,
    thread_id: threadId,
  });
  throwIfRateLimited(upstream);
  if (!upstream.ok) throw await upstreamError(upstream);

  const rawText = await upstream.text();
  const content = completionContent(safeJsonParse(rawText, {}));
  const candidate = typeof content === 'string' ? safeJsonParse(content) : content;

  if (!candidate || typeof candidate.response !== 'string' || !candidate.draft_config) {
    console.error('[ranger-ai] chat: could not parse a structured reply', rawText.slice(0, 500));
    throw new AppError(502, 'The assistant returned an unexpected response. Try again.');
  }
  return { response: candidate.response, draft_config: candidate.draft_config };
}

/* --------------------------------------------------------------- prompt draft */

export interface PromptDraftInput {
  name?: string;
  role?: string;
  description: string;
}

export type PromptDraft = string | { role?: string; goal?: string; instruction?: string };

/** Asks the prompt-builder agent for a system prompt. Creates nothing. */
export async function draftPrompt({ name, role, description }: PromptDraftInput): Promise<PromptDraft> {
  const upstream = await requestAgentCompletion(
    AGENTS.RANGER_PROMPT,
    {
      user: 'Write the role, goal and instruction for this agent.',
      // A fresh thread each time, so one draft never influences the next.
      thread_id: `ranger_prompt_${randomUUID()}`,
      // The agent needs both: `fields` is what to write, `query` is what to write it from.
      variables: {
        fields: 'role,goal,instruction',
        query: [name && `Agent name: ${name}`, role && `Role title: ${role}`, `Responsibilities: ${description}`]
          .filter(Boolean)
          .join('\n'),
      },
    },
    { allowAccessKeyFallback: true }
  );

  throwIfRateLimited(upstream);
  // Read once as text: it is the reply on the way through, and the reason when it fails.
  const raw = await upstream.text().catch(() => '');
  const prompt = upstream.ok ? extractPrompt(safeJsonParse(raw, {})) : '';

  if (!prompt) {
    console.error('[ranger-ai] prompt: no draft', upstream.status, raw.slice(0, 300));
    // A failure is shown as the API wrote it — a wrong model looks like an outage otherwise.
    const message = upstream.ok
      ? 'No draft came back. Try again.'
      : upstreamErrorMessage(safeJsonParse(raw, {}), raw.slice(0, 300), 'The prompt assistant did not respond');
    throw new AppError(502, message);
  }
  return prompt;
}

function extractPrompt(data: unknown): PromptDraft {
  const content = completionContent(data);
  if (content && typeof content === 'object') return unwrapPrompt(content);
  if (typeof content !== 'string') return '';

  // JSON replies come back as a string, sometimes inside a code fence.
  const cleaned = content.replace(/```[a-z]*|```/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) return cleaned;

  const parsed = safeJsonParse(cleaned.slice(start, end + 1));
  if (!parsed) return cleaned;
  const unwrapped = unwrapPrompt(parsed);
  if (unwrapped) return unwrapped;
  // An object with no prompt field is not a draft. Braces inside prose are part of one.
  return cleaned.startsWith('{') && cleaned.endsWith('}') ? '' : cleaned;
}

/** Keeps {role, goal, instruction} as it is; unwraps anything else to plain text. */
function unwrapPrompt(value: any): PromptDraft {
  if (['role', 'goal', 'instruction'].some((key) => String(value?.[key] || '').trim())) return value;
  const flat = value?.prompt ?? value?.system_prompt ?? value?.content ?? value?.text ?? '';
  return typeof flat === 'string' ? flat.trim() : '';
}

/* ---------------------------------------------------------------- update chat */

export interface UpdateChatInput {
  sessionToken: string | null | undefined;
  message: string;
  threadId: string;
  agentId: string;
  versionId: string;
  orgTimezone: string;
  modelType: string;
  availableKnowledgeBases: unknown[];
}

/** Either a live SSE body to pipe through, or a complete answer to emit as one delta. */
export type UpdateChatReply = { kind: 'stream'; body: ReadableStream } | { kind: 'text'; text: string };

/**
 * The ranger's current configuration, as JSON text for the update agent's {{pre_function}}
 * variable: the one GTWY's pre-function filled when this agent lived on GTWY. Read with the
 * caller's session from the API the editor uses. A failure is handed to the agent as text,
 * as GTWY did, so it can say it could not read the ranger instead of the chat failing.
 */
async function readRangerConfig(token: string, versionId: string): Promise<string> {
  try {
    const res = await fetch(`${env.GTWY_SERVER_URL}/api/versions/${encodeURIComponent(versionId)}`, {
      headers: { Authorization: token },
      cache: 'no-store',
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok && body?.agent) return JSON.stringify(body.agent);
    console.error('[ranger-ai] update: could not read the ranger version', res.status);
    return `Error while reading the ranger's configuration (HTTP ${res.status}).`;
  } catch (error) {
    console.error('[ranger-ai] update: could not read the ranger version', errorMessage(error));
    return "Error while reading the ranger's configuration.";
  }
}

/**
 * "Update the ranger" chat.
 *
 * Two credentials are in play and they are not interchangeable:
 *   - pauthkey   — ours, identifies this app to the completion API. Never leaves the server.
 *   - auth_token — the caller's GTWY session, forwarded as a *variable* so the agent's tools
 *     act strictly within that user's permissions.
 *
 * The caller is verified against the agent + version first, so a valid session cannot be
 * used to spend our pauthkey on an agent the caller does not own.
 */
export async function updateChat(input: UpdateChatInput): Promise<UpdateChatReply> {
  const { token } = await verifyAgentAccess(input.sessionToken, {
    agentId: input.agentId,
    versionId: input.versionId,
  });

  // Channel and scheduler tools need a publicly reachable origin for this API. On a bare
  // localhost server there is none, so the agent is told the capability is unavailable
  // rather than handed a URL it cannot reach.
  const publicUrl = env.publicUrl;

  const upstream = await requestAgentCompletion(AGENTS.RANGER_UPDATE, {
    user: input.message,
    thread_id: input.threadId,
    stream: true,
    variables: {
      pre_function: await readRangerConfig(token, input.versionId),
      auth_token: token,
      agent_id: input.agentId,
      version_id: input.versionId,
      frontend_url: publicUrl,
      channels_available: String(Boolean(publicUrl)),
      server_url: env.GTWY_SERVER_URL ?? '',
      scheduler_available: String(Boolean(publicUrl)),
      // "5 pm" is meaningless without the org's timezone, and the browser's zone is not the team's.
      org_timezone: input.orgTimezone,
      // Sent as JSON text because variables are substituted into the prompt.
      available_knowledge_bases: JSON.stringify(input.availableKnowledgeBases),
      model_type: input.modelType,
    },
  });
  throwIfRateLimited(upstream);
  if (!upstream.ok) throw await upstreamError(upstream);

  // GTWY only streams when the agent's model supports it, so both shapes are handled and
  // normalised to one format for the client.
  const contentType = upstream.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream') && upstream.body) {
    return { kind: 'stream', body: upstream.body as unknown as ReadableStream };
  }

  const rawText = await upstream.text();
  const text = extractAssistantText(rawText);
  if (!text) {
    console.error('[ranger-ai] update: no assistant text in reply', rawText.slice(0, 500));
    throw new AppError(502, 'The assistant returned an empty response. Try again.');
  }
  return { kind: 'text', text };
}

function extractAssistantText(rawText: string): string {
  const data = safeJsonParse(rawText, undefined);
  // Not JSON at all — the body is the answer.
  if (data === undefined) return rawText.trim();

  const content = completionContent(data);
  if (typeof content === 'string') return content.trim();
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}
