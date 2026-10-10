import crypto from 'crypto';
import {
  actionToOpenAiTool,
  authIdFromConnection,
  connectionMatchesService,
  describeViaSocketField,
  enableViaSocketApp,
  fetchViaSocketFieldOptions,
  getViaSocketCatalog,
  listAllViaSocketApps,
  listViaSocketAuthentications,
  listViaSocketVersions,
  nestDottedInput,
  newViaSocketRunKey,
  newViaSocketToolId,
  prepareViaSocketInput,
  safeToolTitle,
  searchViaSocketApps,
  signViaSocketEmbedToken,
  summarizeViaSocketActions,
  viaSocketAppToolDefinition,
} from '../lib/viasocket.js';
import { viaSocketAppToolRunUrl } from '../lib/viasocketAppTools.js';
import {
  getViaSocketAppToolsCollection,
  type ViaSocketAction,
  type ViaSocketAppTool,
} from '../models/viasocketAppTool.model.js';
import { getViaSocketToolsCollection } from '../models/viasocketTool.model.js';
import { AppError, errorMessage } from '../utils/AppError.js';
import type { AddAppToolBody, AuthenticationsBody, EnableToolBody, TokenBody } from '../validators/viasocket.validator.js';
import { verifyAgentAccess } from './agentAccess.service.js';

type Json = Record<string, any>;
type FieldOption = { label: string; value: unknown };

const VIASOCKET_RUN_URL = 'https://flow.sokt.io/func';
const MAX_OPTIONS = 100;

function requireSession(token: string | null | undefined) {
  if (!token) throw AppError.unauthorized('Authorization token is required');
}

/**
 * The viaSocket helpers throw plain Errors carrying the upstream status. Their messages are
 * written for the user, so they are passed on rather than masked as an internal failure.
 */
function upstreamError(error: unknown, fallback: string, status?: number) {
  if (error instanceof AppError) return error;
  const upstreamStatus = Number((error as { status?: number })?.status) || 0;
  return new AppError(status ?? (upstreamStatus || 500), errorMessage(error) || fallback, { cause: error });
}

// ─── Catalog ──────────────────────────────────────────────────────────────────

/** Catalog search, or the full popular list when key is empty. */
export async function searchApps(token: string | null | undefined, key: string) {
  requireSession(token);
  try {
    return key ? await searchViaSocketApps(key) : await listAllViaSocketApps({ limit: 200, offset: 0 });
  } catch (error) {
    throw upstreamError(error, 'Could not search apps', 502);
  }
}

/** An app's actions and triggers. */
export async function listVersions(token: string | null | undefined, serviceId: string) {
  requireSession(token);
  try {
    return await listViaSocketVersions(serviceId);
  } catch (error) {
    throw upstreamError(error, 'Could not list actions', 502);
  }
}

// ─── Connections ──────────────────────────────────────────────────────────────

/** Verifies the org embed token with viaSocket so the connect popup can open. */
export async function registerEmbed(token: string | null | undefined, embedToken: string) {
  requireSession(token);
  let res: Response;
  let json: Json;
  try {
    res = await fetch('https://flow-api.viasocket.com/users/register', {
      method: 'GET',
      headers: { authorization: embedToken, 'Content-Type': 'application/json' },
      cache: 'no-store',
    });
    json = await res.json().catch(() => ({}));
  } catch (error) {
    throw upstreamError(error, 'Could not start the connection', 502);
  }
  const embedDetails = json?.data;
  if (!res.ok || !embedDetails) {
    throw new AppError(res.ok ? 502 : res.status, json?.message || json?.error || 'Could not start the connection');
  }
  return embedDetails;
}

/**
 * This user's viaSocket connections for one app. After Slack OAuth the popup often
 * closes before posting an id; the account is still listed here.
 */
export async function findAuthentications(token: string | null | undefined, body: AuthenticationsBody) {
  requireSession(token);
  const { embed_token: embedToken, service_id: serviceId = '', service_name: serviceName = '' } = body;
  let rows: Json[];
  try {
    rows = await listViaSocketAuthentications(embedToken);
  } catch (error) {
    throw upstreamError(error, 'Could not list connections', 502);
  }
  const matches = serviceId ? rows.filter((row) => connectionMatchesService(row, serviceId, serviceName)) : rows;
  const authIds = [...new Set(matches.map(authIdFromConnection).filter(Boolean))];
  return { auth_id: authIds[authIds.length - 1] || '', auth_ids: authIds, connections: matches.length };
}

/** A per-org embed token for the connect popup. The secret never leaves the server. */
export async function signEmbedToken(token: string | null | undefined, body: TokenBody) {
  requireSession(token);
  let orgId = body.org_id || '';
  if (body.agent_id) {
    const access = await verifyAgentAccess(token, { agentId: body.agent_id, versionId: body.version_id });
    orgId = access.orgId || orgId;
  }
  if (!orgId) throw AppError.badRequest('org_id is required');
  try {
    return signViaSocketEmbedToken(orgId) as string;
  } catch (error) {
    throw upstreamError(error, 'Could not sign embed token');
  }
}

// ─── App tools: one tool per connected app ────────────────────────────────────

const publicTool = (row: ViaSocketAppTool) => ({
  id: String(row._id),
  service_id: row.service_id,
  service_name: row.service_name,
  icon_url: row.icon_url || null,
  tool_name: row.tool_name,
  actions: (row.actions || []).map((action) => ({ action_version_id: action.action_version_id, name: action.name })),
  created_at: row.created_at,
});

/**
 * This agent's app tools, plus the GTWY `extra_tools` the playground sends with each turn.
 * The version is recorded on the agent's rows so channels that only know it find them.
 */
export async function listAppTools(token: string | null | undefined, agentId: string, versionId?: string) {
  await verifyAgentAccess(token, { agentId, versionId });

  const tools = await getViaSocketAppToolsCollection();
  if (versionId) {
    await tools.updateMany({ agent_id: agentId }, { $addToSet: { version_ids: versionId } });
  }
  const rows = await tools.find({ agent_id: agentId }).sort({ created_at: 1 }).toArray();
  return {
    tools: rows.map(publicTool),
    extra_tools: rows.map((row) => viaSocketAppToolDefinition(row, { url: viaSocketAppToolRunUrl(row._id) })),
  };
}

/**
 * Enables the app once for this connection and saves every action of it as one tool on the
 * agent. Adding the same app again refreshes its actions and connection.
 */
export async function addAppTool(token: string | null | undefined, body: AddAppToolBody) {
  const { agent_id: agentId, version_id: versionId = '', service_id: serviceId } = body;
  const { auth_id: authId, embed_token: embedToken } = body;
  const { agent, orgId } = await verifyAgentAccess(token, { agentId, versionId });

  let catalog: Json;
  let scriptId: string;
  let actions: ViaSocketAction[];
  try {
    catalog = await getViaSocketCatalog(serviceId);
    actions = summarizeViaSocketActions(catalog.actions);
    if (!actions.length) throw AppError.badRequest('This app has no published actions to add');
    ({ script_id: scriptId } = await enableViaSocketApp({ embedToken, serviceId, authId }));
  } catch (error) {
    throw upstreamError(error, 'Could not add the app');
  }

  const serviceName = String(catalog.service?.name || body.service_name || 'App');
  const agentVersions = Array.isArray(agent?.versions) ? agent.versions.map(String) : [];
  const versionIds = [...new Set([versionId, ...agentVersions].filter(Boolean))];
  const now = new Date();

  const tools = await getViaSocketAppToolsCollection();
  const row = await tools.findOneAndUpdate(
    { agent_id: agentId, service_id: serviceId },
    {
      $set: {
        org_id: orgId || body.org_id || null,
        version_id: versionId || null,
        user_id: body.user_id || null,
        service_name: serviceName,
        icon_url: catalog.service?.iconurl || body.icon_url || null,
        tool_name: safeToolTitle(serviceName).toLowerCase(),
        auth_id: authId,
        script_id: scriptId,
        embed_token: embedToken,
        actions,
        updated_at: now,
      },
      $addToSet: { version_ids: { $each: versionIds } },
      $setOnInsert: { _id: newViaSocketToolId(), run_key: newViaSocketRunKey(), created_at: now },
    },
    { upsert: true, returnDocument: 'after' }
  );
  if (!row) throw new AppError(500, 'Could not add the app');
  return publicTool(row);
}

/** Removes one app tool from its agent. The viaSocket connection stays. */
export async function deleteAppTool(token: string | null | undefined, id: string) {
  const tools = await getViaSocketAppToolsCollection();
  const row = await tools.findOne({ _id: id });
  if (!row) throw AppError.notFound('Tool not found');

  await verifyAgentAccess(token, { agentId: row.agent_id });
  await tools.deleteOne({ _id: row._id });
}

// ─── App tool runs (called by GTWY, authenticated by the row's run key) ───────

/** What a run answers. Failures are 200 so GTWY hands the reason to the model to fix and retry. */
export type RunResult = { status: number; body: Json };

const ok = (body: Json): RunResult => ({ status: 200, body });
const fail = (error: string, extra: Json = {}): RunResult => ok({ success: false, error, ...extra });

function sameKey(sent: unknown, stored: unknown) {
  const a = Buffer.from(String(sent || ''));
  const b = Buffer.from(String(stored || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function parseBody(value: unknown): Json {
  if (typeof value !== 'string') {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** viaSocket reports an action's own errors with HTTP 200 and a `status` of 400+ in the body. */
function actionFailure(res: Response, json: Json) {
  const bodyStatus = Number(json?.status ?? json?.data?.status);
  const message = json?.message || json?.error || json?.data?.message || json?.originalError?.message;
  if (json?.message === 'No response' || json?.data?.message === 'No response') return 'viaSocket returned no response';
  if (res.ok && json?.success === true) return null;
  if (!res.ok || json?.success === false || bodyStatus >= 400 || json?.originalError) {
    return String(typeof message === 'string' ? message : `HTTP ${res.status}`).slice(0, 1000);
  }
  return null;
}

const getPath = (obj: Json, key: string): any =>
  key.split('.').reduce<any>((node, part) => (node == null ? undefined : node[part]), obj);
const setPath = (obj: Json, key: string, value: unknown) => {
  const parts = key.split('.');
  let node = obj;
  parts.slice(0, -1).forEach((part) => {
    if (!node[part] || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  });
  node[parts[parts.length - 1]] = value;
};
const missingValue = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && !value.length) ||
  (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value as Json).length);

function resolveOptionValue(value: unknown, options: FieldOption[]): { value?: unknown; error?: string } {
  const exactValue = options.find((option) => String(option.value) === String(value));
  if (exactValue) return { value: exactValue.value };
  const labels = options.filter((option) => String(option.label).toLowerCase() === String(value).toLowerCase());
  if (labels.length === 1) return { value: labels[0].value };
  if (labels.length > 1) return { error: `"${value}" matches more than one option` };
  return { value };
}

async function fieldOptions(row: ViaSocketAppTool, action: ViaSocketAction, fieldKey: string, existingFields: Json) {
  return (await fetchViaSocketFieldOptions({
    embedToken: row.embed_token,
    actionVersionId: action.action_version_id,
    fieldKey,
    authId: row.auth_id,
    existingFields,
  })) as { options: FieldOption[]; error?: string };
}

/**
 * Lets a model send exact display labels in a write call. Resolves them to opaque viaSocket
 * values server-side, in field order, so discovery does not consume all of GTWY's tool-call rounds.
 */
async function resolveAccountValues(
  row: ViaSocketAppTool,
  action: ViaSocketAction,
  input: Json
): Promise<{ input: Json; error?: string }> {
  if (!row.embed_token) return { input };

  // A keyed object already states which multiselect values it needs (for example column_name keys).
  for (const field of action.fields) {
    if (!field.key_source || !missingValue(getPath(input, field.key_source))) continue;
    const object = getPath(input, field.key);
    if (object && typeof object === 'object' && !Array.isArray(object)) {
      setPath(input, field.key_source, Object.keys(object));
    }
  }

  for (const field of action.fields) {
    if (!field.picked) continue;
    const value = getPath(input, field.key);
    const dependenciesReady = (field.depends_on || []).every((dep) => !missingValue(getPath(input, dep)));
    if (!dependenciesReady) continue;

    const existingFields: Json = { ...input };
    if (field.searchable && typeof value === 'string') existingFields._searchText = value;
    const result = await fieldOptions(row, action, field.key, existingFields);
    if (result.error) return { input, error: `${field.key}: ${result.error}` };

    if (missingValue(value)) {
      if (field.required && result.options.length === 1) setPath(input, field.key, result.options[0].value);
      continue;
    }

    const values = Array.isArray(value) ? value : [value];
    const resolved = values.map((item) => resolveOptionValue(item, result.options));
    const problem = resolved.find((item) => item.error);
    if (problem) return { input, error: `${field.key}: ${problem.error}` };
    const resolvedValues = resolved.map((item) => item.value);
    setPath(input, field.key, Array.isArray(value) ? resolvedValues : resolvedValues[0]);
  }

  delete input._searchText;
  return { input };
}

async function listOptions(
  row: ViaSocketAppTool,
  action: ViaSocketAction,
  fieldKey: string,
  existingFields: Json
): Promise<RunResult> {
  const field = action.fields.find((item) => item.key === fieldKey);
  if (!field) {
    return fail(
      `"${fieldKey}" is not an input of ${action.name}. Inputs: ${action.fields.map((item) => item.key).join(', ')}`
    );
  }
  if (!row.embed_token) {
    return fail(`Options cannot be listed for this ${row.service_name} tool yet; remove the app and add it again.`);
  }
  if (field.options?.length) {
    return ok({
      success: true,
      options_for_action_version_id: action.action_version_id,
      field: fieldKey,
      options: field.options.map((value) => ({ label: String(value), value })),
      usage: 'Send the chosen value exactly.',
    });
  }
  const missingDeps = (field.depends_on || []).filter((dep) => {
    const value = getPath(existingFields, dep);
    return value === undefined || value === null || value === '';
  });
  if (missingDeps.length) {
    return fail(
      `List options for ${missingDeps.join(', ')} first and send ${missingDeps.length > 1 ? 'them' : 'it'} in body.`
    );
  }
  const { options, error } = await fieldOptions(row, action, fieldKey, existingFields);
  if (error) {
    console.error('[viasocket] app tool options failed', { id: row._id, action: action.name, field: fieldKey, error });
    return fail(error, { field: fieldKey });
  }
  return ok({
    success: true,
    options_for_action_version_id: action.action_version_id,
    field: fieldKey,
    options: options.slice(0, MAX_OPTIONS),
    ...(options.length > MAX_OPTIONS
      ? { note: `First ${MAX_OPTIONS} of ${options.length}; send body._searchText to narrow.` }
      : {}),
    usage: field.keys_from_options
      ? 'Use each value verbatim as a key of this object input.'
      : 'Send the chosen value exactly.',
  });
}

/**
 * GTWY calls this with the model's `{ action_version_id, body, options_for? }`. The row holds the
 * app's script_id; viaSocket runs the chosen action with `body` as its inputData, or lists one
 * input's options when `options_for` is set.
 */
export async function runAppTool(id: string, runKey: string | undefined, args: Json): Promise<RunResult> {
  const tools = await getViaSocketAppToolsCollection();
  const row = await tools.findOne({ _id: id });
  if (!row || !sameKey(runKey, row.run_key)) return { status: 404, body: { success: false, error: 'Tool not found' } };

  const optionsFor = String(args?.options_for || '').trim();
  let actionVersionId = String(args?.action_version_id || '');
  let action = (row.actions || []).find((item) => item.action_version_id === actionVersionId);
  // Models occasionally assume options_for is app-wide and omit the action id. Recover using an
  // action that owns the requested field, preferring a write action so its dependencies match.
  if (!action && !actionVersionId && optionsFor) {
    const candidates = (row.actions || []).filter((item) => item.fields?.some((field) => field.key === optionsFor));
    action =
      candidates.find((item) => /^(add|create|send|post)\b/i.test(item.name || '')) ||
      candidates.find((item) => /^(update|delete|remove)\b/i.test(item.name || '')) ||
      candidates[0];
    actionVersionId = action?.action_version_id || '';
  }
  if (!action) {
    return fail(
      `Unknown action_version_id "${actionVersionId}". Use one of: ${(row.actions || [])
        .map((item) => `${item.action_version_id} (${item.name})`)
        .join(', ')}`
    );
  }

  let { input } = prepareViaSocketInput(action.fields, parseBody(args?.body)) as { input: Json };
  if (optionsFor) return listOptions(row, action, optionsFor, input);

  const resolved = await resolveAccountValues(row, action, input);
  if (resolved.error) return fail(resolved.error, { action: action.name });
  const prepared = prepareViaSocketInput(action.fields, resolved.input) as { input: Json; missing: Json[] };
  input = prepared.input;

  if (prepared.missing.length) {
    console.error('[viasocket] app tool inputs missing', {
      id,
      action: action.name,
      missing: prepared.missing.map((field) => field.key),
    });
    return fail(
      `${action.name} needs these inputs in body: ${prepared.missing.map(describeViaSocketField).join('; ')}`
    );
  }

  const res = await fetch(`${VIASOCKET_RUN_URL}/${encodeURIComponent(row.script_id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action_version_id: actionVersionId, inputData: input }),
    cache: 'no-store',
  });
  const json: Json = await res.json().catch(() => ({}));
  const failure = actionFailure(res, json);
  if (failure) {
    console.error('[viasocket] app tool run failed', { id, action: action.name, status: res.status, error: failure });
    return fail(failure, { action: action.name, sent: input });
  }
  return ok(json?.success === undefined ? { success: true, data: json } : json);
}

// ─── Single-action tools (legacy: one GTWY function per action) ───────────────

/**
 * Enables the app and registers a GTWY function whose URL is the viaSocket script.
 * Axios-work POSTs { action_version_id, inputData } there.
 */
export async function enableActionTool(token: string | null | undefined, body: EnableToolBody) {
  requireSession(token);
  const { service_id: serviceId, auth_id: authId, embed_token: embedToken, action } = body;

  let orgId = body.org_id || '';
  if (body.agent_id) {
    const access = await verifyAgentAccess(token, { agentId: body.agent_id, versionId: body.version_id });
    orgId = access.orgId || orgId;
  }
  if (!orgId) throw AppError.badRequest('org_id is required');

  let scriptId: string;
  let openaiToolJson: unknown;
  const title = safeToolTitle([action.pluginname, action.name].filter(Boolean).join('_')) as string;
  try {
    ({ script_id: scriptId } = await enableViaSocketApp({ embedToken, serviceId, authId }));
    openaiToolJson = await actionToOpenAiTool(action, { embedToken, authId });
  } catch (error) {
    throw upstreamError(error, 'Could not add the tool');
  }
  const publicId = newViaSocketToolId() as string;
  const actionVersionId = String(action.actionversionrecordid);

  const tools = await getViaSocketToolsCollection();
  await tools.insertOne({
    _id: publicId,
    org_id: orgId,
    service_id: serviceId,
    action_version_id: actionVersionId,
    script_id: scriptId,
    title,
    created_at: new Date(),
  });

  return {
    public_id: publicId,
    script_id: scriptId,
    title,
    description: String(action.description || action.name || title),
    url: `${VIASOCKET_RUN_URL}/${scriptId}`,
    status: 'published',
    openaiToolJson,
    folder_id: null,
    action_version_id: actionVersionId,
  };
}

/**
 * Fallback for single-action tools whose URL is this proxy. GTWY axios-work POSTs model args;
 * they are forwarded as { action_version_id, inputData } to the stored script.
 */
export async function runActionTool(id: string, body: Json): Promise<RunResult> {
  const tools = await getViaSocketToolsCollection();
  const row = await tools.findOne({ _id: id });
  if (!row?.script_id || !row?.action_version_id) {
    return { status: 404, body: { success: false, error: 'Tool not found' } };
  }

  const { action_version_id: actionVersionId, inputData, ...rest } = body || {};
  const rawInput = inputData && typeof inputData === 'object' && !Array.isArray(inputData) ? inputData : rest;
  const payload = {
    action_version_id: String(actionVersionId || row.action_version_id),
    inputData: nestDottedInput(rawInput),
  };

  const res = await fetch(`${VIASOCKET_RUN_URL}/${encodeURIComponent(row.script_id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });
  const json: Json = await res.json().catch(() => ({}));
  const empty = json?.message === 'No response' || json?.data?.message === 'No response';
  if (!res.ok || empty) {
    console.error('[viasocket] run upstream failed', { id, status: res.status, empty });
    return {
      status: empty ? 502 : res.status,
      body: { success: false, error: json?.message || json?.error || 'viaSocket run failed', data: json },
    };
  }
  return ok(json?.success === undefined ? { success: true, data: json } : json);
}
