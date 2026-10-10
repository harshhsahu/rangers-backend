import { getViaSocketAppToolsCollection } from "../models/viasocketAppTool.model.js";
import { viaSocketAppToolDefinition } from "./viasocket.js";

/** Where GTWY reaches this app's run endpoint. Same env chain as the scheduler. */
function publicBaseUrl() {
  return (process.env.RANGER_PUBLIC_URL || process.env.TELEGRAM_WEBHOOK_BASE_URL || "").replace(/\/$/, "");
}

export function viaSocketAppToolRunUrl(id) {
  return `${publicBaseUrl()}/api/viasocket/app-tools/${encodeURIComponent(String(id))}/run`;
}

/**
 * Rows for one chat turn. A row belongs to an agent; version ids are an index
 * for callers that only know the version (channels, schedules).
 */
export async function findViaSocketAppTools({ agentId, versionId }) {
  const or = [];
  if (agentId) or.push({ agent_id: String(agentId) });
  if (versionId) or.push({ version_id: String(versionId) }, { version_ids: String(versionId) });
  if (!or.length) return [];
  const tools = await getViaSocketAppToolsCollection();
  return tools.find({ $or: or }).toArray();
}

/** GTWY `extra_tools` for one chat turn. Never throws: a lookup failure must not stop the reply. */
export async function getViaSocketExtraTools({ agentId, versionId }) {
  if (!publicBaseUrl()) return [];
  try {
    const rows = await findViaSocketAppTools({ agentId, versionId });
    return rows.map((row) => viaSocketAppToolDefinition(row, { url: viaSocketAppToolRunUrl(row._id) }));
  } catch (error) {
    console.error("[viasocket] extra tools lookup failed", error?.message || error);
    return [];
  }
}

/** Payload copy for logs: tool names only, so run keys stay out of the log. */
export function redactExtraTools(payload) {
  if (!Array.isArray(payload?.extra_tools)) return payload;
  return { ...payload, extra_tools: payload.extra_tools.map((tool) => tool?.name) };
}
