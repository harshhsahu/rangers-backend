import Joi from 'joi';
import type { Collection, ObjectId } from 'mongodb';
import { getDb } from '../config/database.js';

/**
 * A tool the agent may call, in GTWY's `extra_tools` format: GTWY runs it as an HTTP
 * request with the arguments the model chose.
 */
export interface AgentTool {
  /** The name the model sees. The update chat's panel refreshes by tool name. */
  name: string;
  description?: string;
  /** May use `{{variable}}`, filled from the call's variables before it is sent. */
  url: string;
  method?: string;
  /** Sent verbatim by GTWY; values may use `{{variable}}`, filled the same way as `url`. */
  headers?: Record<string, string>;
  /** JSON-Schema `properties` of the arguments. */
  fields?: Record<string, unknown>;
  required?: string[];
  /** Non-GET only: argument names sent in the query string instead of the body. */
  query_params?: string[];
  /** Argument → variable path. GTWY fills these arguments itself and hides them from the model. */
  tool_and_variable_path?: Record<string, string>;
}

export type AgentPrompt = string | { role?: string; goal?: string; instruction?: string };

/**
 * An agent this backend runs through GTWY's direct completion API. Documents are written
 * by hand and looked up by slug (see README "Agents"); the backend only reads them.
 */
export interface Agent {
  _id?: ObjectId;
  slug: string;
  name?: string;
  /** A GTWY service name (openai, anthropic, gemini…), as GET /api/service lists them. */
  service: string;
  configuration: {
    /** The model's type in GTWY's catalog. GTWY only substitutes prompt variables for these two. */
    type: 'chat' | 'reasoning';
    model: string;
    prompt: AgentPrompt;
    /** Output format, e.g. { type: 'json_schema', json_schema: {...} }. Omit for plain text. */
    response_type?: Record<string, unknown>;
    /** temperature, max_tokens…; anything left out is the model's default. */
    [param: string]: unknown;
  };
  /** GTWY agent settings, e.g. maximum_iterations, fall_back, guardrails. */
  settings?: Record<string, unknown>;
  tools?: AgentTool[];
  created_at?: Date;
  updated_at?: Date;
}

const nonEmpty = Joi.string().trim().min(1);

const toolSchema = Joi.object<AgentTool>({
  name: nonEmpty.required(),
  description: Joi.string().allow(''),
  url: nonEmpty.required(),
  method: Joi.string().valid('GET', 'POST', 'PUT', 'PATCH', 'DELETE').insensitive(),
  headers: Joi.object().pattern(Joi.string(), Joi.string()),
  fields: Joi.object(),
  required: Joi.array().items(Joi.string()),
  query_params: Joi.array().items(Joi.string()),
  tool_and_variable_path: Joi.object().pattern(Joi.string(), Joi.string()),
});

const promptSchema = Joi.alternatives(
  nonEmpty,
  Joi.object({ role: Joi.string().allow(''), goal: Joi.string().allow(''), instruction: Joi.string().allow('') })
    .or('role', 'goal', 'instruction')
    .custom((prompt: Record<string, string>) => {
      if (!Object.values(prompt).some((part) => part.trim())) throw new Error('role, goal and instruction are all empty');
      return prompt;
    })
);

/** What a hand-written document must contain; anything else is kept as it is. */
export const agentSchema = Joi.object<Agent>({
  slug: nonEmpty.required(),
  service: nonEmpty.required(),
  configuration: Joi.object({
    type: Joi.string().valid('chat', 'reasoning').required(),
    model: nonEmpty.required(),
    prompt: promptSchema.required(),
    response_type: Joi.object(),
  })
    .unknown(true)
    .required(),
  settings: Joi.object(),
  tools: Joi.array().items(toolSchema),
}).unknown(true);

const COLLECTION = 'agents';
let indexesReady: Promise<unknown> | null = null;

export async function getAgentsCollection(): Promise<Collection<Agent>> {
  const collection = (await getDb()).collection<Agent>(COLLECTION);
  indexesReady ??= collection.createIndex({ slug: 1 }, { unique: true }).catch((error) => {
    indexesReady = null;
    throw error;
  });
  await indexesReady;
  return collection;
}
