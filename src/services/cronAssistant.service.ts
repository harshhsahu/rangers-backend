import { GTWY_AGENTS } from '../constants/agents.js';
import { describeCron, nextCronRuns, validateCronExpression } from '../lib/cronExpression.js';
import { cronCaveat } from '../lib/rangerSchedules.js';
import { AppError } from '../utils/AppError.js';
import { requestCompletion } from './gtwyCompletion.service.js';

export interface GeneratedCron {
  cron_expression: string;
  description: string;
  next_runs: unknown;
  warning: string | null;
}

/**
 * Turns a plain-English cadence into a validated cron expression.
 *
 * Nothing is written. The expression is validated and handed back with its next fire
 * times so the user confirms a real schedule rather than a string they cannot read —
 * the model is a convenience over the preset dropdowns, not an authority.
 */
export async function generateCron(text: string, timezone: string): Promise<GeneratedCron> {
  const upstream = await requestCompletion(
    {
      user: text,
      agent_id: GTWY_AGENTS.CRON_ASSISTANT,
      // One thread per request so an earlier question cannot colour this answer.
      thread_id: `cron_ai_${Date.now()}`,
      response_type: 'text',
    },
    { allowAccessKeyFallback: true }
  );

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    console.error('[cron-ai] completion failed', upstream.status, detail.slice(0, 300));
    throw new AppError(502, 'The cron assistant did not respond');
  }

  const answer = extractText(await upstream.json().catch(() => ({})));
  const parsed = parseAnswer(answer);

  // The agent says so itself when a cadence cannot be expressed as cron ("the first Monday
  // of each month"). Its reason beats a generic parse failure, so it is passed on as written.
  if (parsed?.answerable === false) {
    throw new AppError(422, parsed.reason || 'That cadence cannot be written as a cron expression');
  }

  const expression = parsed?.cronExpression || extractCron(answer);
  if (!expression) {
    throw new AppError(422, `No cron expression came back. It said: ${answer.slice(0, 200) || 'nothing'}`);
  }

  // Validated, not trusted: an out-of-range field would otherwise fail later at save time.
  let cron: string;
  try {
    cron = validateCronExpression(expression);
  } catch (error) {
    throw AppError.asClientError(error, 'Could not read that schedule');
  }

  return {
    cron_expression: cron,
    description: describeCron(cron, timezone),
    next_runs: nextCronRuns(cron, timezone, 3),
    warning: cronCaveat(cron),
  };
}

/**
 * The agent answers with JSON — { cronExpression, meaning, answerable, reason } — usually
 * bare, sometimes fenced. Anything else falls through to the text scan in extractCron.
 */
function parseAnswer(answer: string): any {
  const text = answer.replace(/```[a-z]*|```/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** The completion response shape varies by model; take the first assistant text found. */
function extractText(data: any): string {
  const candidates = [
    data?.response?.data?.content,
    data?.response?.content,
    data?.data?.content,
    data?.content,
    data?.response?.data?.choices?.[0]?.message?.content,
    data?.choices?.[0]?.message?.content,
    typeof data?.response === 'string' ? data.response : null,
  ];
  const found = candidates.find((value) => typeof value === 'string' && value.trim());
  return String(found || '').trim();
}

const CRON_FIELD = '[0-9*/,\\-]+';
const FIVE_FIELD_CRON = new RegExp(
  `(?:^|\\s)(${CRON_FIELD}\\s+${CRON_FIELD}\\s+${CRON_FIELD}\\s+${CRON_FIELD}\\s+${CRON_FIELD})(?=\\s|$)`,
  'm'
);

/**
 * Pulls the expression out of whatever the agent wrapped it in. Six-field (seconds)
 * expressions are ignored rather than truncated: a schedule the rest of the system
 * cannot represent is worse than no answer.
 */
function extractCron(answer: string): string | null {
  const cleaned = answer.replace(/```[a-z]*|`/gi, ' ').replace(/["']/g, ' ');
  const match = FIVE_FIELD_CRON.exec(cleaned);
  if (!match) return null;
  // A six-field match would have consumed the first five and left one behind.
  const after = cleaned.slice(match.index + match[0].length).trim();
  if (/^[0-9*/,\-]+(\s|$)/.test(after)) return null;
  return match[1].trim().split(/\s+/).join(' ');
}
