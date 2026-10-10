import { AGENTS, type AgentSlug } from '../constants/agents.js';
import { type Agent, agentSchema, getAgentsCollection } from '../models/agent.model.js';
import { AppError, errorMessage } from '../utils/AppError.js';
import { checkAgentModel } from './gtwyModels.service.js';

/** Why a stored agent cannot be used, or the agent itself. */
async function loadAgent(slug: AgentSlug): Promise<{ agent: Agent } | { problem: string }> {
  const doc = await (await getAgentsCollection()).findOne({ slug });
  if (!doc) return { problem: `no document with slug "${slug}" in the agents collection` };

  const { value, error } = agentSchema.validate(doc, { errors: { wrap: { label: false } } });
  if (error) return { problem: `the "${slug}" document is invalid: ${error.message}` };
  return { agent: value };
}

/**
 * The agent stored under `slug`. Read on every call, so an edited document applies to
 * the next request. A missing or malformed document is a setup problem, answered 503.
 */
export async function getAgent(slug: AgentSlug): Promise<Agent> {
  const loaded = await loadAgent(slug);
  if ('agent' in loaded) return loaded.agent;
  console.error(`[agents] ${loaded.problem}`);
  throw new AppError(503, 'This assistant is not set up yet.');
}

/** Checks every agent this service runs, and its model, logging what is wrong. Run at boot; never throws. */
export async function verifyAgents(): Promise<void> {
  for (const slug of Object.values(AGENTS)) {
    try {
      const loaded = await loadAgent(slug);
      if ('problem' in loaded) {
        console.warn(`[agents] ${loaded.problem}; calls to it answer 503 until this is fixed`);
        continue;
      }
      const { service, configuration } = loaded.agent;
      if ((await checkAgentModel(loaded.agent))?.ok) {
        console.log(`[agents] ${slug}: ${service}/${configuration.model} is available`);
      }
    } catch (error) {
      console.warn('[agents] could not check the agents collection', errorMessage(error));
      return;
    }
  }
}
