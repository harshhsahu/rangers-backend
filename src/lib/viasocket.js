import crypto from "crypto";
import jwt from "jsonwebtoken";

const ORG_ID = process.env.VIASOCKET_ORG_ID || "5593";
const PROJECT_ID = process.env.VIASOCKET_PROJECT_ID || "projGxjqvJpz";

export function viasocketConfigured() {
  return Boolean(process.env.VIASOCKET_EMBED_SECRET);
}

/** HS256 embed token. Three claims, no expiry — valid until the secret rotates. */
export function signViaSocketEmbedToken(uniqueIdentifier) {
  const secret = process.env.VIASOCKET_EMBED_SECRET;
  if (!secret) {
    const error = new Error(
      "Set VIASOCKET_EMBED_SECRET in .env (viaSocket dashboard → Integrations → embed → Install Code)."
    );
    error.status = 503;
    throw error;
  }
  if (!uniqueIdentifier) {
    const error = new Error("A stable user id is required to sign the embed token.");
    error.status = 400;
    throw error;
  }
  return jwt.sign(
    {
      org_id: String(ORG_ID),
      project_id: String(PROJECT_ID),
      unique_identifier: String(uniqueIdentifier),
    },
    secret,
    { algorithm: "HS256" }
  );
}

export async function searchViaSocketApps(query) {
  const url = `https://flow.sokt.io/func/scri12BSufQM?key=${encodeURIComponent(query || "")}`;
  const res = await fetch(url, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(json?.message || "Could not search apps");
    error.status = res.status;
    throw error;
  }
  return Array.isArray(json?.data) ? json.data : [];
}

/** Popular apps, most-used first. `rowid` is the service id the rest of the API uses. */
export async function listAllViaSocketApps({ limit = 200, offset = 0 } = {}) {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const res = await fetch(`https://plugservice-api.viasocket.com/api/v1/plugins/all?${params}`, { cache: "no-store" });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(json?.message || "Could not list apps");
    error.status = res.status;
    throw error;
  }
  return (Array.isArray(json?.data) ? json.data : []).map((app) => ({
    service_id: app.rowid || app.service_id,
    name: app.name,
    iconurl: app.iconurl,
    description: app.description,
  }));
}

export async function listViaSocketVersions(serviceId) {
  const res = await fetch("https://flow.sokt.io/func/scriolZue69X", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service_id: serviceId }),
    cache: "no-store",
  });
  const json = await res.json().catch(() => []);
  if (!res.ok) {
    const error = new Error("Could not list actions for that app");
    error.status = res.status;
    throw error;
  }
  const rows = Array.isArray(json) ? json : json?.data || [];
  return {
    actions: rows.filter((row) => row?.type === "action"),
    triggers: rows.filter((row) => row?.type === "trigger"),
  };
}

/** Catalog API: `{ service, actions, triggers }`, each action with `action_version_id` and `input_schema`. */
export async function getViaSocketCatalog(serviceId) {
  const res = await fetch("https://flow.sokt.io/func/scriK4LFg2kc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service_id: serviceId }),
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error("Could not load that app from the viaSocket catalog");
    error.status = res.status;
    throw error;
  }
  const data = json?.data && !Array.isArray(json.data) ? json.data : json;
  return {
    service: data?.service || null,
    actions: Array.isArray(data?.actions) ? data.actions : [],
    triggers: Array.isArray(data?.triggers) ? data.triggers : [],
  };
}

export async function enableViaSocketApp({ embedToken, serviceId, authId }) {
  const res = await fetch(
    `https://flow-api.viasocket.com/embed/enable/${encodeURIComponent(serviceId)}/${encodeURIComponent(authId)}`,
    {
      method: "POST",
      headers: { authorization: embedToken, "Content-Type": "application/json" },
      body: "{}",
      cache: "no-store",
    }
  );
  const json = await res.json().catch(() => ({}));
  const data = json?.data && typeof json.data === "object" ? json.data : json;
  const scriptId = data?.script_id || json?.script_id;
  if (!res.ok || !scriptId) {
    const error = new Error(json?.message || json?.error || "Could not enable this app");
    error.status = res.status || 400;
    throw error;
  }
  return { ...data, script_id: scriptId };
}

export async function listViaSocketAuthentications(embedToken) {
  const res = await fetch("https://flow-api.viasocket.com/embed/authentications", {
    method: "GET",
    headers: { authorization: embedToken, "Content-Type": "application/json" },
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(json?.message || json?.error || "Could not list connections");
    error.status = res.status;
    throw error;
  }
  const rows = json?.data?.authentications || json?.data || json?.authentications || [];
  return Array.isArray(rows) ? rows : [];
}

export function authIdFromConnection(row) {
  if (!row || typeof row !== "object") return "";
  const id = row.id || row.auth_id || row.authId || row.rowid || row._id;
  return id ? String(id) : "";
}

export function connectionMatchesService(row, serviceId, serviceName) {
  if (!row) return false;
  const ids = [row.service_id, row.serviceId, row.plugin_id, row.pluginid, row.rowid, row.serviceid, row.service]
    .filter(Boolean)
    .map(String);
  if (serviceId && ids.includes(String(serviceId))) return true;
  const name = String(row.name || row.service_name || row.pluginname || row.plugin || "").toLowerCase();
  const wanted = String(serviceName || "")
    .toLowerCase()
    .trim();
  if (wanted && name && (name === wanted || name.includes(wanted) || wanted.includes(name))) return true;
  return false;
}

function staticEnum(block) {
  const options = Array.isArray(block?.options) ? block.options : [];
  const values = options
    .map((opt) => (opt && typeof opt === "object" ? opt.value : opt))
    .filter((value) => value !== undefined && value !== null && typeof value !== "object");
  return values.length ? values : null;
}

function skipBlock(key, block) {
  const type = String(block?.type || "").toLowerCase();
  if (block?.isHidden) return true;
  if (type === "help") return true;
  // Plain groups are represented by their dotted children. A sourced group is
  // itself an input whose dynamic children come from list-options.
  if (type === "input groups" && !block.source) return true;
  return false;
}

function needsListOptions(block) {
  const type = String(block?.type || "").toLowerCase();
  if (block?.source) return true;
  return type === "dropdown" || type === "multiselect" || type === "dictionary";
}

function isObjectValueField(block) {
  const type = String(block?.type || "").toLowerCase();
  return type === "dictionary" || (type === "input groups" && Boolean(block.source));
}

function ensureObject(node) {
  if (!node || node.type !== "object") {
    return { type: "object", properties: {}, required: [] };
  }
  node.properties = node.properties || {};
  node.required = Array.isArray(node.required) ? node.required : [];
  return node;
}

function putAtPath(root, path, field) {
  const parts = String(path).split(".").filter(Boolean);
  if (!parts.length) return;
  let current = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    current.properties[part] = ensureObject(current.properties[part]);
    current = current.properties[part];
  }
  const leaf = parts[parts.length - 1];
  current.properties[leaf] = field.schema;
  if (field.required && !current.required.includes(leaf)) current.required.push(leaf);
}

export async function listViaSocketFieldOptions({
  embedToken,
  actionVersionId,
  fieldKey,
  authId,
  existingFields = {},
}) {
  const res = await fetch(`https://flow-api.viasocket.com/embed/list-options/${encodeURIComponent(actionVersionId)}`, {
    method: "POST",
    headers: { authorization: embedToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      fieldKey,
      auth_id: authId,
      existingFields,
    }),
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (json?.data?.response?.status >= 400) return [];
  const raw = json?.data?.data || json?.data || json;
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
  return rows
    .map((row) => {
      if (row == null) return null;
      if (typeof row !== "object") return { label: String(row), value: row };
      const value = row.value ?? row.id ?? row.sample ?? row.key;
      if (value === undefined || value === null) return null;
      return { label: String(row.label || row.name || value), value };
    })
    .filter(Boolean);
}

function dictionarySchema(block, options) {
  const properties = {};
  (options || []).forEach((opt) => {
    const key = String(opt.value);
    if (key) properties[key] = { type: "string", description: String(opt.label || opt.value) };
  });
  const keyHint = (options || []).map((opt) => `${opt.label} → ${JSON.stringify(opt.value)}`).join("; ");
  return {
    type: "object",
    additionalProperties: { type: "string" },
    ...(Object.keys(properties).length ? { properties } : {}),
    description:
      `${String(block.help || block.label || "Values")}. Send an object keyed by each list-options value exactly as returned. ${
        keyHint ? `Available keys: ${keyHint}.` : ""
      }`.trim(),
  };
}

function optionType(values) {
  if (!values?.length) return "string";
  if (values.every((value) => typeof value === "boolean")) return "boolean";
  if (values.every((value) => typeof value === "number")) return "number";
  return "string";
}

function fieldContext(block) {
  const details = [];
  if (Array.isArray(block?.dependsOn) && block.dependsOn.length) {
    details.push(`Depends on: ${block.dependsOn.join(", ")}.`);
  }
  if (block?.visibilityCondition) {
    details.push(`Only send when this condition applies: ${block.visibilityCondition}.`);
  }
  const defaultValue =
    block?.defaultValue && typeof block.defaultValue === "object" ? block.defaultValue.value : block?.defaultValue;
  if (defaultValue !== undefined && defaultValue !== null && defaultValue !== "") {
    details.push(`Default: ${JSON.stringify(defaultValue)}.`);
  }
  return details.join(" ");
}

function fieldSchema(block, options) {
  const type = String(block?.type || "").toLowerCase();
  const label = [
    block.help || block.label || block.description || "",
    fieldContext(block),
    block.source ? "Use an option value/id, not its display label." : "",
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
  let schema;

  if (isObjectValueField(block)) {
    schema = dictionarySchema(block, options);
  } else if (type === "multiselect") {
    const values = options?.length ? options.map((opt) => opt.value) : staticEnum(block);
    schema = {
      type: "array",
      items: {
        type: optionType(values),
        ...(values?.length ? { enum: values } : {}),
      },
      description: label,
    };
    const labels = (options || []).map((opt) => `${opt.label} = ${opt.value}`).slice(0, 50);
    if (labels.length) schema.description = `${schema.description} ${labels.join("; ")}`;
  } else if (type === "number" || type === "delay" || type.includes("int")) {
    schema = { type: "number", description: label };
  } else if (type === "boolean") {
    schema = { type: "boolean", description: `${label} true or false, not yes/no text.` };
  } else if (type === "date") {
    schema = { type: "string", description: `${label} Use YYYY-MM-DD.` };
  } else {
    const values = options?.length ? options.map((opt) => opt.value) : staticEnum(block);
    schema = { type: optionType(values), description: label };
    if (values?.length) schema.enum = values;
    const labels = (options || []).map((opt) => `${opt.label} = ${opt.value}`).slice(0, 50);
    if (labels.length) {
      schema.description = `${schema.description} Use the id, not the name. ${labels.join("; ")}`.trim();
    }
  }

  if (block.list) {
    const items = schema.type === "array" ? schema.items : schema;
    return {
      type: "array",
      items,
      description: `${schema.description || label} Repeat once per row.`,
    };
  }
  return schema;
}

/**
 * Tool schema matches the viaSocket run body:
 * { action_version_id, inputData } with nested keys (destination.channel_id → destination.channel_id).
 * Dropdowns that load from the user's account are filled at add-time so the model sends real ids.
 */
export async function actionToOpenAiTool(action, { embedToken, authId } = {}) {
  const input = action?.inputjson || {};
  const blocks = input.blocks && typeof input.blocks === "object" ? input.blocks : {};
  const inputRoot = { type: "object", properties: {}, required: [] };
  const actionVersionId = String(action?.actionversionrecordid || "");

  for (const key of Object.keys(blocks)) {
    const block = blocks[key];
    if (!block || typeof block !== "object" || skipBlock(key, block)) continue;
    const remote =
      embedToken &&
      authId &&
      actionVersionId &&
      needsListOptions(block) &&
      !Array.isArray(block.options) &&
      !(Array.isArray(block.dependsOn) && block.dependsOn.length);
    let options = null;
    if (remote) {
      try {
        options = await listViaSocketFieldOptions({
          embedToken,
          actionVersionId,
          fieldKey: key,
          authId,
          existingFields: {},
        });
      } catch {
        options = null;
      }
    }
    const required =
      Boolean(block.required) &&
      !(Array.isArray(block.dependsOn) && block.dependsOn.length) &&
      !block.visibilityCondition;
    putAtPath(inputRoot, key, { schema: fieldSchema(block, options), required });
  }

  if (inputRoot.required?.length === 0) delete inputRoot.required;
  Object.values(inputRoot.properties).forEach((node) => {
    if (node?.type === "object" && Array.isArray(node.required) && node.required.length === 0) delete node.required;
  });

  return {
    type: "function",
    function: {
      name: toolName(action),
      description:
        `Run this action via viaSocket. Preserve the inputData types and nesting in the schema. For fields populated by list-options, use option values rather than labels. Send conditional fields only when their condition applies. Never report success unless the function succeeds. ${String(action?.description || action?.name || "")}`.trim(),
      parameters: {
        type: "object",
        properties: {
          action_version_id: {
            type: "string",
            ...(actionVersionId ? { enum: [actionVersionId] } : {}),
            description: "Always send this exact action version id.",
          },
          inputData: inputRoot,
        },
        required: ["action_version_id", "inputData"],
      },
    },
  };
}

/** Letters, numbers, and underscores only — the agent tool title rejects anything else. */
export function safeToolTitle(value) {
  const slug = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return slug || "viasocket_action";
}

function toolName(action) {
  return safeToolTitle(`${action?.pluginname || "app"}_${action?.name || "action"}`).toLowerCase() || "app_action";
}

/** GTWY stores tool args as fields with nested `parameter`, not JSON-schema `properties`. */
export function openaiToolToGtwyFields(openaiToolJson) {
  const schema = openaiToolJson?.function?.parameters;
  if (!schema || typeof schema !== "object") return {};
  return schemaToGtwyFields(schema);
}

function schemaToGtwyFields(schema) {
  const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const fields = {};
  for (const [key, def] of Object.entries(properties)) {
    if (!def || typeof def !== "object") continue;
    const field = {
      type: def.type || "string",
      description: String(def.description || ""),
      enum: Array.isArray(def.enum) ? def.enum : [],
      required: Array.isArray(def.required) ? def.required : [],
    };
    if (def.type === "object") {
      field.parameter = schemaToGtwyFields(def);
      field.required = Array.isArray(def.required) ? def.required : [];
    }
    if (def.type === "array") field.items = def.items || { type: "string" };
    fields[key] = field;
  }
  return fields;
}

export function newViaSocketToolId() {
  return crypto.randomBytes(12).toString("hex");
}

export function newViaSocketRunKey() {
  return crypto.randomBytes(24).toString("hex");
}

/** Turns dotted keys such as "destination.channel_id" into nested objects, as viaSocket's inputData expects. */
export function nestDottedInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const out = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key.includes(".")) {
      const parts = key.split(".").filter(Boolean);
      let current = out;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i];
        if (!current[part] || typeof current[part] !== "object" || Array.isArray(current[part])) current[part] = {};
        current = current[part];
      }
      current[parts[parts.length - 1]] = nestDottedInput(nested);
    } else {
      out[key] = nestDottedInput(nested);
    }
  }
  return out;
}

function clip(value, max) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A group with no child fields of its own: the input is one object whose keys come from the user's data. */
function isKeyedGroup(key, block, blocks, steps) {
  if (String(block?.type || "").toLowerCase() !== "input groups" || block.source || block.isHidden) return false;
  const children = Array.isArray(steps?.[key]) ? steps[key] : [];
  return !children.length && !Object.keys(blocks).some((other) => other.startsWith(`${key}.`));
}

function multiselectDeps(block, blocks) {
  return (Array.isArray(block?.dependsOn) ? block.dependsOn : []).filter(
    (dep) => String(blocks[dep]?.type || "").toLowerCase() === "multiselect"
  );
}

/** How the value goes into inputData, per the form-renderer type table. */
function fieldKind(block, keyed) {
  const type = String(block?.type || "").toLowerCase();
  if (keyed || type === "dictionary" || type === "input groups") return "object";
  if (type === "multiselect" || block?.list) return "array";
  if (type === "number" || type === "delay" || type.includes("int")) return "number";
  if (type === "boolean") return "boolean";
  if (type === "date") return "date";
  return "string";
}

function fieldTypeText(block, blocks, kind, keyed) {
  const type = String(block?.type || "").toLowerCase();
  if (keyed) {
    const deps = multiselectDeps(block, blocks);
    return deps.length
      ? `object keyed by each value sent in ${deps.join(", ")}, exactly as sent there`
      : "object keyed by option values from options_for, verbatim";
  }
  if (type === "input groups") return "object keyed by option values from options_for, verbatim";
  if (type === "dictionary") return "object of key/value pairs";
  if (kind === "date") return "date YYYY-MM-DD";
  if (kind === "number") return "number, not text";
  return kind;
}

function readableCondition(expr) {
  if (!expr) return null;
  return clip(
    String(expr)
      .replace(/context\??\.inputData\??\./g, "")
      .replace(/\?\./g, "."),
    120
  );
}

function plainDefault(block) {
  const raw = block?.defaultValue;
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw.value : raw;
  return value === undefined || value === null || value === "" || typeof value === "object" ? null : value;
}

/** Field keys in form order: steps.root, each group's children in place, then anything steps leaves out. */
function orderedKeys(steps, blocks) {
  const seen = new Set();
  const out = [];
  const walk = (keys) =>
    (keys || []).forEach((key) => {
      if (seen.has(key)) return;
      seen.add(key);
      out.push(key);
      if (Array.isArray(steps?.[key])) walk(steps[key]);
    });
  walk(steps?.root);
  Object.keys(blocks).forEach((key) => !seen.has(key) && out.push(key));
  return out;
}

/** The catalog's actions, reduced to what the model needs to fill `body` for each one. */
export function summarizeViaSocketActions(actions) {
  return (actions || [])
    .filter((action) => action?.action_version_id)
    .map((action) => {
      const blocks =
        action?.input_schema?.blocks && typeof action.input_schema.blocks === "object"
          ? action.input_schema.blocks
          : {};
      const steps = action?.input_schema?.steps || {};
      const rootKeys = new Set(Array.isArray(steps.root) ? steps.root : []);
      const parentOf = (key) => Object.keys(steps).find((group) => group !== "root" && steps[group]?.includes?.(key));
      const fields = orderedKeys(steps, blocks)
        .filter((key) => blocks[key] && typeof blocks[key] === "object")
        .filter((key) => !skipBlock(key, blocks[key]) || isKeyedGroup(key, blocks[key], blocks, steps))
        .map((key) => {
          const block = blocks[key];
          const keyed = isKeyedGroup(key, block, blocks, steps);
          const kind = fieldKind(block, keyed);
          const options = staticEnum(block) || [];
          const keySources = keyed ? multiselectDeps(block, blocks) : [];
          const parent = parentOf(key);
          const condition = readableCondition(block.visibilityCondition || blocks[parent]?.visibilityCondition);
          return {
            key,
            kind,
            type: fieldTypeText(block, blocks, kind, keyed),
            required: Boolean(block.required),
            root: rootKeys.size ? rootKeys.has(key) : !key.includes("."),
            picked:
              kind !== "object" &&
              !options.length &&
              (Boolean(block.source) || block.enableSearchApi || needsListOptions(block)),
            keys_from_options: (keyed && !multiselectDeps(block, blocks).length) || isObjectValueField(block),
            key_source: keySources[0] || null,
            searchable: Boolean(block.enableSearchApi),
            depends_on: Array.isArray(block.dependsOn) ? block.dependsOn : [],
            conditional: Boolean(condition),
            condition,
            default: plainDefault(block),
            help: clip(block.help || block.label || block.description, 100),
            options: options.slice(0, 10),
          };
        });
      return {
        action_version_id: String(action.action_version_id),
        action_id: action.action_id ? String(action.action_id) : null,
        name: String(action.name || ""),
        description: clip(action.description, 140),
        fields,
      };
    });
}

function describeField(field) {
  const notes = [field.type];
  if (field.required) notes.push("required");
  if (field.default !== null && field.default !== undefined) notes.push(`default ${JSON.stringify(field.default)}`);
  if (field.picked) notes.push(field.searchable ? "choose via options_for, searchable" : "choose via options_for");
  if (field.depends_on?.length) notes.push(`needs ${field.depends_on.join(", ")}`);
  if (field.condition) notes.push(`only when ${field.condition}`);
  else if (field.conditional) notes.push("conditional");
  if (field.options?.length) notes.push(`one of ${field.options.map((option) => JSON.stringify(option)).join("|")}`);
  return `${field.key} (${notes.join(", ")})${field.help ? `: ${field.help}` : ""}`;
}

const getPath = (obj, key) => key.split(".").reduce((node, part) => (node == null ? undefined : node[part]), obj);
const setPath = (obj, key, value) => {
  const parts = key.split(".");
  let node = obj;
  parts.slice(0, -1).forEach((part) => {
    if (!node[part] || typeof node[part] !== "object") node[part] = {};
    node = node[part];
  });
  node[parts[parts.length - 1]] = value;
};
const isEmptyValue = (value) =>
  value === undefined ||
  value === null ||
  value === "" ||
  (Array.isArray(value) && !value.length) ||
  (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);

function parseJsonText(value, wantArray) {
  const text = value.trim();
  if (!(wantArray ? text.startsWith("[") : text.startsWith("{"))) return value;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) === wantArray ? parsed : value;
  } catch {
    return value;
  }
}

function coerceValue(kind, value) {
  if (kind === "number" && typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value)))
    return Number(value);
  if (kind === "boolean" && (value === "true" || value === "false")) return value === "true";
  if (kind === "object" && typeof value === "string") return parseJsonText(value, false);
  if (kind === "array" && typeof value === "string") {
    const parsed = parseJsonText(value, true);
    return Array.isArray(parsed) ? parsed : [value];
  }
  if (kind === "array" && value !== null && typeof value !== "object") return [value];
  return value;
}

/**
 * The model's `body` as viaSocket's inputData: nested, each value in the type its field takes,
 * plus the always-required top-level fields that are still empty.
 */
export function prepareViaSocketInput(fields, body) {
  const input = nestDottedInput(body && typeof body === "object" && !Array.isArray(body) ? body : {});
  for (const field of fields || []) {
    if (!field.kind) continue;
    const value = getPath(input, field.key);
    if (value === undefined) continue;
    const fixed = coerceValue(field.kind, value);
    if (fixed !== value) setPath(input, field.key, fixed);
  }
  const missing = (fields || []).filter(
    (field) =>
      field.required && field.root && !field.condition && !field.conditional && isEmptyValue(getPath(input, field.key))
  );
  return { input, missing };
}

export const describeViaSocketField = describeField;

/** One field's choices from the user's account. A connection it cannot read comes back as an error, never as no options. */
export async function fetchViaSocketFieldOptions({
  embedToken,
  actionVersionId,
  fieldKey,
  authId,
  existingFields = {},
}) {
  const res = await fetch(`https://flow-api.viasocket.com/embed/list-options/${encodeURIComponent(actionVersionId)}`, {
    method: "POST",
    headers: { authorization: embedToken, "Content-Type": "application/json" },
    body: JSON.stringify({ fieldKey, auth_id: authId, existingFields }),
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  const data = json?.data;
  if (!res.ok || json?.success === false) {
    return { options: [], error: String(json?.message || json?.error || `list-options failed (HTTP ${res.status})`) };
  }
  if (data && !Array.isArray(data) && data.response && Number(data.response.status) >= 400) {
    return { options: [], error: String(data.response.data?.message || "list-options failed") };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
  const options = list
    .map((item) => {
      if (item == null) return null;
      if (typeof item !== "object") return { label: String(item), value: item };
      const value = item.value ?? item.id ?? item.key;
      return value === undefined || value === null ? null : { label: String(item.label ?? item.name ?? value), value };
    })
    .filter(Boolean);
  return { options };
}

/** GTWY `extra_tools` entry: one tool for every action of one connected app. */
export function viaSocketAppToolDefinition(row, { url }) {
  const actions = Array.isArray(row?.actions) ? row.actions : [];
  const app = row?.service_name || "this app";
  const catalog = actions
    .map((action) => {
      const inputs = action.fields.length ? action.fields.map(describeField).join("; ") : "no inputs";
      return `${action.action_version_id} = ${action.name}${action.description ? ` (${action.description})` : ""}. body: ${inputs}`;
    })
    .join("\n");

  return {
    url,
    headers: { "x-viasocket-tool-key": row.run_key },
    name: row.tool_name,
    description: clip(
      `Act in the user's connected ${app} account through viaSocket. Each call runs exactly one action, chosen with action_version_id, with its inputs in body. For a task with several steps, make several calls in order and wait for each result before the next: for example find the sheet, then read its rows, then compute, then write. When a value to write depends on existing data (a total, a count, a lookup), read that data first and compute the real value yourself; never write a description of a value such as "sum of all rows". Reuse ids and names returned by earlier calls. For an unknown input marked "choose via options_for", call with options_for and its dependencies in body, then send the returned value. Leave out inputs whose "only when" condition is false. If a call fails, read the error, fix body and retry. Never claim success unless the call returns success.`,
      1000
    ),
    required_params: ["action_version_id", "body"],
    fields: {
      action_version_id: {
        type: "string",
        enum: actions.map((action) => action.action_version_id),
        description: `The ${app} action to run, or whose input options to list. Send the id exactly. Actions and their body inputs, in order:\n${catalog}`,
      },
      body: {
        type: "object",
        additionalProperties: true,
        parameter: {},
        description:
          "Inputs of the chosen action, keyed exactly as listed (case-sensitive; dotted keys may be sent as written). Send every required input that applies, typed as listed: numbers as numbers, true/false as booleans, objects and arrays as JSON. For an account value, send either its exact option value or an exact display label the user supplied; the server resolves an unambiguous label. Never invent a label. For a keyed values object, its keys can also supply the corresponding selection array.",
      },
      options_for: {
        type: "string",
        description:
          "Optional. An input key of the chosen action. MUST be sent together with that action_version_id and a body object. Nothing runs: the call returns allowed {label, value} options. Put dependencies in body; for a searchable input add body._searchText.",
      },
    },
  };
}
