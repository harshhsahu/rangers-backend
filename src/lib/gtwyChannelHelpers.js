/**
 * Transport-agnostic helpers shared by Telegram / Discord channel webhooks.
 */

import { getViaSocketExtraTools, redactExtraTools } from "./viasocketAppTools.js";

export function stripReasoning(text) {
  let t = String(text || "");
  if (!t.trim()) return "";

  t = t.replace(/^\s*Task identified:\s*[\s\S]*?(?=\n\s*Reasoning:|\n\s*Answer:)/i, "");

  const answerMatch = t.match(/(?:^|\n)\s*Answer:\s*([\s\S]*)$/i);
  if (/\bReasoning:\s*/i.test(t) && answerMatch) {
    t = answerMatch[1];
  } else {
    t = t.replace(/^\s*Reasoning:\s*[\s\S]*?(?=\n\s*Answer:|\n\s*\n|$)/i, "");
    t = t.replace(/^\s*Answer:\s*/i, "");
  }

  t = t
    .split("\n")
    .filter((line) => !/^\s*Reasoning:\s*/i.test(line) && !/^\s*Task identified:\s*/i.test(line))
    .join("\n");

  return t.trim();
}

export function extractAssistantText(gtwyResponse) {
  return (
    gtwyResponse?.response?.data?.content ||
    gtwyResponse?.data?.content ||
    gtwyResponse?.content ||
    gtwyResponse?.response?.content ||
    (typeof gtwyResponse?.response === "string" ? gtwyResponse.response : null) ||
    null
  );
}

function resolveUrl(item) {
  if (!item) return null;
  if (typeof item === "string") return item;
  return item.permanent_url || item.image_url || item.url || null;
}

function collectUrlsFromList(list, into) {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    const url = resolveUrl(item);
    if (url && !into.includes(url)) into.push(url);
  }
}

export function extractImageUrls(parsed) {
  const urls = [];
  if (!parsed || typeof parsed !== "object") return urls;

  collectUrlsFromList(parsed.llm_urls, urls);
  collectUrlsFromList(parsed.llm_url, urls);

  const response = parsed.response;
  if (response && typeof response === "object") {
    collectUrlsFromList(response.llm_urls, urls);
    collectUrlsFromList(response.llm_url, urls);
    collectUrlsFromList(response.data?.image_urls, urls);
    collectUrlsFromList(response.data?.llm_urls, urls);
    collectUrlsFromList(response.data?.images, urls);
  }

  collectUrlsFromList(parsed.data?.image_urls, urls);
  collectUrlsFromList(parsed.data?.llm_urls, urls);
  collectUrlsFromList(parsed.data?.images, urls);
  collectUrlsFromList(parsed.image_urls, urls);

  return urls;
}

/** Non-image file URLs (pdf/doc/etc.) if present on the GTWY payload. */
export function extractFileUrls(parsed) {
  const urls = [];
  if (!parsed || typeof parsed !== "object") return urls;

  const lists = [parsed.files, parsed.data?.files, parsed.response?.files, parsed.response?.data?.files];
  for (const list of lists) {
    collectUrlsFromList(list, urls);
  }
  return urls.filter((url) => typeof url === "string" && !isLikelyImageUrl(url));
}

export function isLikelyImageUrl(url) {
  const u = String(url || "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|$)/i.test(u) || /\/image\//i.test(u);
}

export function splitText(text, limit) {
  const t = String(text || "");
  if (!t) return [];
  if (t.length <= limit) return [t];

  const parts = [];
  let remaining = t;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < Math.floor(limit * 0.5)) cut = remaining.lastIndexOf(" ", limit);
    if (cut < Math.floor(limit * 0.5)) cut = limit;
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function parseSlashCommand(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("/")) return null;
  const token = raw.split(/\s+/)[0] || "";
  const cmd = token.split("@")[0].toLowerCase();
  return cmd || null;
}

export function extractGtwyErrorMessage(data, status, rawText = "") {
  const pick = (v) => {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (v && typeof v === "object") {
      if (typeof v.message === "string" && v.message.trim()) return v.message.trim();
      if (typeof v.error === "string" && v.error.trim()) return v.error.trim();
      if (typeof v.detail === "string" && v.detail.trim()) return v.detail.trim();
    }
    return null;
  };

  const fromFields =
    pick(data?.error) ||
    pick(data?.error?.error) ||
    (typeof data?.error?.message === "string" ? data.error.message.trim() : null) ||
    pick(data?.message) ||
    pick(data?.detail) ||
    pick(data?.msg) ||
    pick(data?.fallback_error) ||
    pick(data?.data) ||
    (Array.isArray(data?.errors)
      ? data.errors
        .map((e) => pick(e) || String(e))
        .filter(Boolean)
        .join("; ")
      : null);

  if (fromFields) return fromFields;

  const raw = String(rawText || "").trim();
  if (raw && raw.length <= 800 && !raw.startsWith("{") && !raw.startsWith("<")) return raw;

  return `GTWY failed (${status})`;
}

/**
 * The completion backend still returns one legacy phrase from before "publishing" was
 * removed as a product concept — a single ambiguous string covering two unrelated causes
 * ("Could not find api key or Agent is not Published"). It can't be changed there, so it's
 * rewritten here into the one cause that's actually still possible: a missing/invalid API key.
 */
export function humanizeGtwyError(message) {
  const msg = String(message || "");
  if (/could not find api ?key or agent is not published/i.test(msg)) {
    return "This agent doesn't have a working API key configured. Add one in the agent's model settings and try again.";
  }
  return message;
}

/**
 * Stream a GTWY completion, skipping reasoning events.
 * Resolves with the final answer text plus any image and non-image file URLs.
 */
export async function streamGtwyCompletion({
  versionId,
  userText,
  threadId,
  extraFields,
  logPrefix = "[gtwy]",
  maskPayload,
  onDelta,
  onStart,
}) {
  const pythonUrl = (process.env.GTWY_PYTHON_SERVER_URL || "").replace(/\/$/, "");
  const pauthkey = process.env.GTWY_PAUTH_KEY || process.env.ACCESS_KEY;
  if (!pythonUrl) throw new Error("GTWY_PYTHON_SERVER_URL is not set");
  if (!pauthkey) throw new Error("GTWY_PAUTH_KEY is not set");

  const payload = {
    user: userText || "",
    version_id: versionId,
    response_type: "text",
    stream: true,
    ...(extraFields || {}),
  };
  if (threadId) payload.thread_id = String(threadId);
  const appTools = await getViaSocketExtraTools({ versionId });
  if (appTools.length) payload.extra_tools = [...(payload.extra_tools || []), ...appTools];

  const logged = redactExtraTools(typeof maskPayload === "function" ? maskPayload(payload) : payload);
  console.log(logPrefix, "GTWY payload", JSON.stringify(logged));

  const response = await fetch(`${pythonUrl}/api/v2/model/chat/completion`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      pauthkey,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const rawText = await response.text().catch(() => "");
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = {};
    }
    console.error(logPrefix, "GTWY HTTP error", { status: response.status, body: rawText?.slice?.(0, 500) });
    throw new Error(extractGtwyErrorMessage(data, response.status, rawText));
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("event-stream") && !contentType.includes("stream")) {
    const data = await response.json().catch(() => ({}));
    const text = stripReasoning(extractAssistantText(data) || "");
    const images = extractImageUrls(data);
    const files = extractFileUrls(data);
    onDelta?.(text);
    return { text, images, files };
  }

  if (!response.body) throw new Error("GTWY stream empty body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sse = "";
  let full = "";
  let images = [];
  let files = [];
  let deltas = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    sse += decoder.decode(value, { stream: true });
    const lines = sse.split("\n");
    sse = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        continue;
      }

      if (parsed.event === "start") {
        onStart?.();
        continue;
      }

      if (parsed.event === "reasoning") {
        continue;
      }

      if (parsed.event === "delta") {
        const chunk = parsed.content || "";
        if (!chunk) continue;
        full += chunk;
        deltas += 1;
        const clean = stripReasoning(full);
        if (clean) onDelta?.(clean);
      } else if (parsed.event === "done") {
        const fromDone = extractAssistantText(parsed) || full;
        if (fromDone && fromDone.length > full.length) full = fromDone;
        const doneImages = extractImageUrls(parsed);
        if (doneImages.length) images = doneImages;
        const doneFiles = extractFileUrls(parsed);
        if (doneFiles.length) files = doneFiles;
      } else if (parsed.event === "error") {
        throw new Error(
          extractGtwyErrorMessage(parsed, "stream", "") || parsed.error || parsed.fallback_error || "GTWY stream error"
        );
      }
    }
  }

  const text = stripReasoning(full);
  console.log(logPrefix, "GTWY done", { deltas, chars: text.length, images: images.length, files: files.length });
  return { text, images, files };
}
