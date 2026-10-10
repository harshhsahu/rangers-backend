/**
 * Copies every ranger out of GTWY into the `rangers` and `schedules` collections
 * (docs/database.md). Read-only on GTWY; safe to run again until the app writes to `rangers`.
 *
 *   npm run migrate:rangers                   # dry run: reads and reports, writes nothing
 *   npm run migrate:rangers -- --apply        # writes
 *   npm run migrate:rangers -- --agent <id>   # one GTWY agent only (combine with --apply)
 *
 * Needs, besides the usual .env (MONGODB_URI, ORG_ID, FOLDER_ID, CHANNEL_ENCRYPTION_KEY):
 *   GTWY_MONGODB_URI — GTWY's database, database name in the path. A read-only user is enough.
 *
 * Sources: GTWY's `configurations` (agents), `configuration_versions` and `apicalls` (tools),
 * plus this service's own `channeldetails` and `rangerschedules`. A ranger is a GTWY agent
 * in ORG_ID inside the embed folder FOLDER_ID.
 */
import { MongoClient, ObjectId, type Document } from 'mongodb';
import { closeDatabase, getDb } from '../config/database.js';
import { env } from '../config/env.js';
import { encryptSecret } from '../lib/crypto.js';
import type { ChannelDetails } from '../models/channelDetails.model.js';
import { getRangersCollection, type Ranger, type RangerConfig, type RangerTool } from '../models/ranger.model.js';
import { getSchedulesCollection, type Schedule } from '../models/schedule.model.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ONLY_AGENT = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined;

/** Configuration keys that are not model parameters. */
const NOT_PARAMS = new Set([
  'prompt', 'model', 'type', 'response_type', 'mcp_config', 'tools',
  'system_prompt_version_id', 'is_rich_text', 'fine_tune_model',
]);

const warnings: string[] = [];
const warn = (subject: string, message: string) => warnings.push(`${subject}: ${message}`);

const asObjectId = (id: unknown) => (ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : null);
const asDate = (value: unknown, fallback: Date) => (value ? new Date(value as string) : fallback);
const isObject = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** GTWY stores parameters as { mode, value }: custom → the value, default → left out, min/max kept. */
function unwrapParam(value: unknown): unknown {
  if (isObject(value) && 'mode' in value) {
    if (value.mode === 'custom') return value.value;
    return value.mode === 'min' || value.mode === 'max' ? value.mode : undefined;
  }
  return value === 'default' || value === null ? undefined : value;
}

function mapPrompt(prompt: unknown, subject: string): RangerConfig['prompt'] {
  if (typeof prompt === 'string') return prompt;
  if (isObject(prompt)) {
    const parts = { role: String(prompt.role ?? ''), goal: String(prompt.goal ?? ''), instruction: String(prompt.instruction ?? '') };
    // A custom template is what GTWY sent, with {{role}}/{{goal}}/{{instruction}} filled in.
    if (typeof prompt.customPrompt === 'string' && prompt.customPrompt.trim()) {
      return prompt.customPrompt.replace(/\{\{(role|goal|instruction)\}\}/g, (_match: string, key: keyof typeof parts) => parts[key]);
    }
    return parts;
  }
  warn(subject, 'no prompt');
  return '';
}

function mapConfig(version: Document, tools: Map<string, Document>, subject: string): RangerConfig {
  const configuration: Record<string, any> = version.configuration ?? {};

  const params: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(configuration)) {
    if (NOT_PARAMS.has(key)) continue;
    const value = unwrapParam(raw);
    if (value !== undefined) params[key] = value;
  }

  const responseType = unwrapParam(configuration.response_type);
  const type = configuration.type === 'reasoning' ? 'reasoning' : 'chat';
  if (configuration.type && configuration.type !== type) warn(subject, `model type "${configuration.type}" migrated as chat`);
  if (!version.service || !configuration.model) warn(subject, 'no service or model');

  const variablesPath: Record<string, Record<string, string>> = version.variables_path ?? {};
  const rangerTools: RangerTool[] = [];
  for (const id of version.function_ids ?? []) {
    const tool = tools.get(String(id));
    if (!tool) {
      warn(subject, `tool ${id} not found in apicalls`);
      continue;
    }
    rangerTools.push({
      script_id: tool.script_id,
      name: tool.title || tool.script_id,
      ...(tool.description && { description: tool.description }),
      ...(isObject(tool.fields) && Object.keys(tool.fields).length && { fields: tool.fields }),
      ...(tool.required?.length && { required: tool.required }),
      ...(isObject(variablesPath[tool.script_id]) && { variable_paths: variablesPath[tool.script_id] }),
    });
  }

  const knowledgeBases: RangerConfig['knowledge_bases'] = [];
  for (const doc of version.doc_ids ?? []) {
    if (!isObject(doc) || !doc.resource_id) {
      warn(subject, `knowledge base ${JSON.stringify(doc)} has no resource_id; skipped`);
      continue;
    }
    knowledgeBases.push({
      resource_id: String(doc.resource_id),
      collection_id: String(doc.collection_id ?? ''),
      ...(doc.name && { name: doc.name }),
      ...(doc.description && { description: doc.description }),
    });
  }

  const tone = version.settings?.tone;
  const fallback = version.settings?.fall_back;
  const variablesState: Record<string, any> = version.agent_info?.variables_state ?? {};
  const starters = (version.starterQuestion ?? []).filter((q: unknown) => typeof q === 'string' && q.trim());

  return {
    service: String(version.service ?? ''),
    model: String(configuration.model ?? ''),
    type,
    prompt: mapPrompt(configuration.prompt, subject),
    params,
    ...(isObject(responseType) && responseType.type !== 'default' && { response_type: responseType }),
    ...(isObject(tone) && (tone.value || tone.prompt) && { tone: { value: String(tone.value ?? ''), prompt: String(tone.prompt ?? '') } }),
    ...(fallback?.is_enable && fallback.service && fallback.model && { fallback: { service: fallback.service, model: fallback.model } }),
    ...(Object.keys(variablesState).length && {
      variables: Object.fromEntries(
        Object.entries(variablesState).map(([name, state]) => [
          name,
          {
            ...(state?.default_value && { default_value: String(state.default_value) }),
            required: state?.status === 'required',
          },
        ])
      ),
    }),
    tools: rangerTools,
    mcp_servers: (configuration.mcp_config?.servers ?? [])
      .filter((server: any) => server?.name && server?.url)
      .map((server: any) => ({ name: String(server.name), url: String(server.url) })),
    knowledge_bases: knowledgeBases,
    ...(starters.length && { starter_questions: starters }),
  };
}

function mapChannels(channel: ChannelDetails | undefined, now: Date): Ranger['channels'] {
  const channels: Ranger['channels'] = {};
  const telegram: Record<string, any> | undefined = channel?.telegram;
  if (telegram?.botToken) {
    const chat = telegram.chatUser;
    channels.telegram = {
      bot_token: encryptSecret(telegram.botToken),
      webhook_set: Boolean(telegram.webhookSet),
      ...(typeof telegram.lastUpdateId === 'number' && { last_update_id: telegram.lastUpdateId }),
      ...(chat?.chat_id != null && {
        last_chat: {
          chat_id: String(chat.chat_id),
          ...(chat.username && { username: chat.username }),
          ...(chat.first_name && { first_name: chat.first_name }),
          at: asDate(chat.updated_at, now),
        },
      }),
      ...(isObject(telegram.chatThreads) && { chat_threads: telegram.chatThreads }),
    };
  }
  const discord: Record<string, any> | undefined = channel?.discord;
  if (discord?.botToken) {
    channels.discord = {
      bot_token: encryptSecret(discord.botToken),
      ...(isObject(discord.chatThreads) && { chat_threads: discord.chatThreads }),
    };
  }
  return channels;
}

function mapSchedule(row: Document, ranger: { _id: ObjectId; org_id: string }, now: Date): Schedule {
  const delivery = row.delivery;
  const run = row.last_run;
  if (delivery && delivery.type && delivery.type !== 'telegram') warn(`schedule ${row._id}`, `delivery "${delivery.type}" dropped`);
  return {
    _id: row._id,
    ranger_id: ranger._id,
    org_id: ranger.org_id,
    ...(row.label && { label: String(row.label) }),
    message: String(row.message ?? ''),
    cron_expression: String(row.cron_expression ?? ''),
    timezone: row.timezone || 'UTC',
    delivery:
      delivery?.chat_id != null && (!delivery.type || delivery.type === 'telegram')
        ? { channel: 'telegram', chat_id: String(delivery.chat_id), ...(delivery.username && { username: delivery.username }) }
        : null,
    enabled: Boolean(row.enabled),
    // Never stored as null: the unique index on easycron_id only skips missing values.
    ...(row.easycron_id != null && { easycron_id: String(row.easycron_id) }),
    ...(isObject(run) && run.at && {
      last_run: {
        at: asDate(run.at, now),
        ok: Boolean(run.ok),
        duration_ms: Number(run.duration_ms ?? 0),
        thread_id: String(run.thread_id ?? ''),
        ...(run.preview && { preview: String(run.preview) }),
        ...(run.error && { error: String(run.error) }),
      },
    }),
    run_count: Number(row.run_count ?? 0),
    fail_streak: Number(row.fail_streak ?? 0),
    ...(typeof row.created_by === 'string' && row.created_by && { created_by: row.created_by }),
    created_at: asDate(row.created_at, now),
    updated_at: asDate(row.updated_at, now),
  };
}

async function main() {
  const gtwyUri = process.env.GTWY_MONGODB_URI;
  if (!gtwyUri) throw new Error('GTWY_MONGODB_URI is not set (GTWY database, read-only is enough)');
  if (!env.ORG_ID || !env.FOLDER_ID) throw new Error('ORG_ID and FOLDER_ID are required: they identify the rangers on GTWY');
  const onlyAgentId = ONLY_AGENT ? asObjectId(ONLY_AGENT) : null;
  if (ONLY_AGENT && !onlyAgentId) throw new Error(`--agent expects a GTWY agent id, got "${ONLY_AGENT}"`);

  console.log(`[migrate] ${APPLY ? 'APPLY' : 'DRY RUN, nothing is written'}${ONLY_AGENT ? `, agent ${ONLY_AGENT} only` : ''}`);
  const gtwyClient = await new MongoClient(gtwyUri).connect();
  const now = new Date();

  try {
    const gtwy = gtwyClient.db();
    const agents = await gtwy
      .collection('configurations')
      .find({ org_id: env.ORG_ID, folder_id: env.FOLDER_ID, ...(onlyAgentId && { _id: onlyAgentId }) })
      .toArray();
    const versionIds = agents.flatMap((agent) => (agent.versions ?? []).map(asObjectId)).filter(Boolean) as ObjectId[];
    const versions = new Map(
      (await gtwy.collection('configuration_versions').find({ _id: { $in: versionIds } }).toArray()).map((v) => [String(v._id), v])
    );
    const toolIds = [...versions.values()].flatMap((v) => (v.function_ids ?? []).map(asObjectId)).filter(Boolean) as ObjectId[];
    const tools = new Map((await gtwy.collection('apicalls').find({ _id: { $in: toolIds } }).toArray()).map((t) => [String(t._id), t]));

    // Read straight from the collections: the model getters create indexes, and a dry run writes nothing.
    const db = await getDb();
    const channelsByVersion = new Map(
      (await db.collection<ChannelDetails>('channeldetails').find({}).toArray()).map((c) => [String(c.version_id), c])
    );
    const oldSchedules = await db.collection('rangerschedules').find({}).toArray();
    console.log(
      `[migrate] read ${agents.length} rangers, ${versions.size} versions, ${tools.size} tools from GTWY; ` +
        `${channelsByVersion.size} channel documents and ${oldSchedules.length} schedules here`
    );

    const rangers = APPLY ? await getRangersCollection() : null;
    const schedules = APPLY ? await getSchedulesCollection() : null;
    const migrated = new Map<string, { _id: ObjectId; org_id: string }>(); // GTWY agent id or version id → ranger
    const usedChannels = new Set<string>();
    let rangerCount = 0;

    for (const agent of agents) {
      const agentId = String(agent._id);
      const subject = `ranger "${agent.name}" (${agentId})`;
      if (!agent.user_id) {
        warn(subject, 'no user_id (MSG91 company id), so no tenant; skipped');
        continue;
      }
      const agentVersions: string[] = (agent.versions ?? []).map(String);
      // The version a channel is wired to is the one users talk to, and its id is in the
      // Telegram webhook URL, so it wins over the published one.
      const versionId =
        agentVersions.find((id) => channelsByVersion.has(id)) ?? (agent.published_version_id ? String(agent.published_version_id) : agentVersions[0]);
      const version = versionId ? versions.get(versionId) : undefined;
      if (!version) {
        warn(subject, `version ${versionId ?? '(none)'} not found; skipped`);
        continue;
      }
      if (agentVersions.length > 1) warn(subject, `${agentVersions.length} versions; migrated ${versionId}`);
      const channel = channelsByVersion.get(versionId!);
      if (channel) usedChannels.add(versionId!);

      const meta = agent.meta?.ranger ?? {};
      const ranger: Omit<Ranger, '_id' | 'created_at'> = {
        org_id: String(agent.user_id),
        name: String(agent.name ?? ''),
        ...(meta.description && { description: String(meta.description) }),
        ...(meta.role && { role: String(meta.role) }),
        ...(meta.color && { color: String(meta.color) }),
        status: agent.status === 0 ? 'archived' : agent.bridge_status === 0 ? 'paused' : 'active',
        deleted_at: agent.deletedAt ? new Date(agent.deletedAt) : null,
        config: mapConfig(version, tools, subject),
        channels: mapChannels(channel, now),
        legacy: { agent_id: agentId, version_id: versionId! },
        updated_at: asDate(agent.updatedAt, now),
      };

      let rangerId = new ObjectId(); // stands in for the real id on a dry run
      if (rangers) {
        const saved = await rangers.findOneAndUpdate(
          { 'legacy.agent_id': agentId },
          { $set: ranger, $setOnInsert: { created_at: asDate(agent.createdAt, now) } },
          { upsert: true, returnDocument: 'after', projection: { _id: 1 } }
        );
        rangerId = saved!._id!;
      }
      const ref = { _id: rangerId, org_id: ranger.org_id };
      migrated.set(agentId, ref);
      for (const id of agentVersions) migrated.set(id, ref);
      rangerCount += 1;
    }

    for (const versionId of channelsByVersion.keys()) {
      if (!usedChannels.has(versionId)) warn(`channel document for version ${versionId}`, 'no migrated ranger uses it; not copied');
    }

    let scheduleCount = 0;
    for (const row of oldSchedules) {
      const ranger = migrated.get(String(row.agent_id)) ?? migrated.get(String(row.version_id));
      if (!ranger) {
        if (!ONLY_AGENT) warn(`schedule ${row._id}`, `its ranger (agent ${row.agent_id}) was not migrated; not copied`);
        continue;
      }
      // Same _id: the EasyCron job URL carries it.
      const schedule = mapSchedule(row, ranger, now);
      if (schedules) await schedules.replaceOne({ _id: row._id }, schedule, { upsert: true });
      scheduleCount += 1;
    }

    console.log(`[migrate] ${APPLY ? 'wrote' : 'would write'} ${rangerCount} rangers and ${scheduleCount} schedules`);
    if (warnings.length) {
      console.log(`[migrate] ${warnings.length} warnings:`);
      for (const line of warnings) console.log(`  - ${line}`);
    }
  } finally {
    await gtwyClient.close();
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error('[migrate] failed:', error);
  process.exitCode = 1;
});
