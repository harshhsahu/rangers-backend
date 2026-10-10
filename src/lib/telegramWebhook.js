import { getChannelDetailsCollection } from "../models/channelDetails.model.js";
import { decryptSecret, maskSecret } from "./crypto.js";
import { TelegramStreamUpdater } from "./telegramStreamUpdater.js";
import { humanizeGtwyError } from "./gtwyChannelHelpers.js";
import { getViaSocketExtraTools, redactExtraTools } from "./viasocketAppTools.js";

const TELEGRAM_TEXT_LIMIT = 4096;
const DRAFT_CHUNK_THRESHOLD = Number(process.env.TELEGRAM_DRAFT_CHUNK_THRESHOLD) || 1000;
const NEW_THREAD_COMMANDS = new Set(["/new_thread", "/newthread"]);

function escapeTelegramHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert the model's Markdown output to Telegram's HTML subset.
 * Unmatched/partial markers (common mid-stream, e.g. a lone opening "**")
 * are left as literal text rather than producing invalid HTML — every
 * conversion below only fires on a complete, closed pair.
 */
function markdownToTelegramHtml(text) {
  const raw = String(text || "");
  if (!raw) return raw;

  const codeBlocks = [];
  const inlineCodes = [];

  let out = raw.replace(/```(?:[a-zA-Z0-9_-]*\n)?([\s\S]*?)```/g, (_m, code) => {
    const token = `CB${codeBlocks.length}`;
    codeBlocks.push(`<pre><code>${escapeTelegramHtml(code.replace(/\n$/, ""))}</code></pre>`);
    return token;
  });

  out = out.replace(/`([^`\n]+)`/g, (_m, code) => {
    const token = `IC${inlineCodes.length}`;
    inlineCodes.push(`<code>${escapeTelegramHtml(code)}</code>`);
    return token;
  });

  out = escapeTelegramHtml(out);

  // Links: [text](url)
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    return `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`;
  });

  // Bold: **text** / __text__
  out = out.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");
  out = out.replace(/__([^\n]+?)__/g, "<b>$1</b>");

  // Strikethrough: ~~text~~
  out = out.replace(/~~([^\n]+?)~~/g, "<s>$1</s>");

  // Italic: *text* (single asterisk only — leaves _snake_case_ words untouched)
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>");

  // Headings → bold line
  out = out.replace(/^ {0,3}#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  out = out.replace(/\uE000IC(\d+)\uE000/g, (_m, i) => inlineCodes[Number(i)]);
  out = out.replace(/\uE000CB(\d+)\uE000/g, (_m, i) => codeBlocks[Number(i)]);

  return out;
}

/** Draft/preview only — Telegram hard-caps a single message at 4096. */
function truncateTelegramText(text) {
  const t = String(text || "");
  if (t.length <= TELEGRAM_TEXT_LIMIT) return t;
  return `${t.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`;
}

/**
 * Split long text into Telegram-safe parts (≤4096), preferring line breaks.
 * Final replies must use this — truncate drops the rest of the answer.
 */
function splitTelegramText(text, limit = TELEGRAM_TEXT_LIMIT) {
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

/**
 * Strip model reasoning / task preamble from text before Telegram.
 */
function stripReasoning(text) {
  let t = String(text || "");
  if (!t.trim()) return "";

  // Drop leading "Task identified: …" block if present
  t = t.replace(/^\s*Task identified:\s*[\s\S]*?(?=\n\s*Reasoning:|\n\s*Answer:)/i, "");

  // Reasoning: ... Answer: <answer>
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

function extractAssistantText(gtwyResponse) {
  // Prefer content only — never use data.reasoning
  return (
    gtwyResponse?.response?.data?.content ||
    gtwyResponse?.data?.content ||
    gtwyResponse?.content ||
    gtwyResponse?.response?.content ||
    (typeof gtwyResponse?.response === "string" ? gtwyResponse.response : null) ||
    null
  );
}

/**
 * Resolve image URLs from GTWY payloads.
 * Streaming done events expose image_urls under response.data.
 * History / API shapes may put llm_urls at the root.
 */
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

function extractImageUrls(parsed) {
  const urls = [];
  if (!parsed || typeof parsed !== "object") return urls;

  // Root-level llm_urls (history / metrics / some wrappers)
  collectUrlsFromList(parsed.llm_urls, urls);
  collectUrlsFromList(parsed.llm_url, urls); // singular, if ever used

  // Nested under response (SSE done.accumulated → payload.response)
  const response = parsed.response;
  if (response && typeof response === "object") {
    collectUrlsFromList(response.llm_urls, urls);
    collectUrlsFromList(response.llm_url, urls);
    collectUrlsFromList(response.data?.image_urls, urls);
    collectUrlsFromList(response.data?.llm_urls, urls);
    collectUrlsFromList(response.data?.images, urls);
  }

  // Direct data (non-stream body already unwrapped)
  collectUrlsFromList(parsed.data?.image_urls, urls);
  collectUrlsFromList(parsed.data?.llm_urls, urls);
  collectUrlsFromList(parsed.data?.images, urls);
  collectUrlsFromList(parsed.image_urls, urls);

  return urls;
}

async function telegramApi(botToken, method, body) {
  const url = `https://api.telegram.org/bot${botToken}/${method}`;
  console.log("[tg] telegram API →", method, JSON.stringify(body || {}));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // Log full Telegram response (mask token if it ever appears)
  const logged = JSON.stringify(data);
  console.log(
    "[tg] telegram API ←",
    method,
    `http=${res.status}`,
    botToken && logged.includes(botToken) ? logged.split(botToken).join(maskSecret(botToken)) : logged
  );
  return data;
}

async function sendDraft(botToken, chatId, draftId, text) {
  return telegramApi(botToken, "sendMessageDraft", {
    chat_id: chatId,
    draft_id: draftId,
    text: markdownToTelegramHtml(truncateTelegramText(text ?? "")),
    parse_mode: "HTML",
  });
}

/** One retry — a single dropped/rate-limited call shouldn't silently kill the whole "thinking" indicator. */
async function sendDraftWithRetry(botToken, chatId, draftId, text) {
  const first = await sendDraft(botToken, chatId, draftId, text);
  if (first?.ok) return first;
  console.warn("[tg] sendMessageDraft failed, retrying once:", first?.description);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return sendDraft(botToken, chatId, draftId, text);
}

async function sendMessage(botToken, chatId, text) {
  return telegramApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: markdownToTelegramHtml(String(text || "…").slice(0, TELEGRAM_TEXT_LIMIT)),
    parse_mode: "HTML",
  });
}

/** Send full reply as one or more messages (no silent truncation). */
async function sendLongMessage(botToken, chatId, text) {
  const parts = splitTelegramText(text || "…");
  const results = [];
  for (const part of parts) {
    const sent = await sendMessage(botToken, chatId, part);
    if (!sent?.ok) {
      console.error("[tg] sendMessage part failed", {
        partLen: part.length,
        desc: sent?.description,
      });
    }
    results.push(sent);
  }
  return results;
}

async function sendPhoto(botToken, chatId, photoUrl, caption) {
  const body = {
    chat_id: chatId,
    photo: photoUrl,
  };
  // Caption max 1024 — don't put a long essay here
  if (caption) {
    body.caption = markdownToTelegramHtml(String(caption).slice(0, 1024));
    body.parse_mode = "HTML";
  }
  return telegramApi(botToken, "sendPhoto", body);
}

function chatThreadKey(chatId) {
  return String(chatId);
}

/** Mask bot token inside Telegram file URLs before logging. */
function maskTelegramFileUrl(url, botToken) {
  if (!url) return url;
  const token = String(botToken || "");
  if (token && url.includes(token)) {
    return url.split(token).join(maskSecret(token));
  }
  // Fallback: redact /file/bot<token>/ even if token unknown
  return String(url).replace(/\/file\/bot([^/]+)\//, (_m, t) => `/file/bot${maskSecret(t)}/`);
}

function maskGtwyPayloadForLog(payload, botToken) {
  try {
    const clone = JSON.parse(JSON.stringify(payload || {}));
    const maskVal = (v) => (typeof v === "string" ? maskTelegramFileUrl(v, botToken) : v);
    for (const key of ["image_url", "audio_url", "video_url", "file_url", "youtube_url"]) {
      if (clone[key]) clone[key] = maskVal(clone[key]);
    }
    if (clone.video_data && typeof clone.video_data === "object") {
      clone.video_data = {
        ...clone.video_data,
        uri: maskVal(clone.video_data.uri),
        file_uri: maskVal(clone.video_data.file_uri),
        name: maskVal(clone.video_data.name),
      };
    }
    if (Array.isArray(clone.user_urls)) {
      clone.user_urls = clone.user_urls.map((item) =>
        item && typeof item === "object" ? { ...item, url: maskVal(item.url) } : maskVal(item)
      );
    }
    if (Array.isArray(clone.files)) {
      clone.files = clone.files.map((item) => maskVal(item));
    }
    return clone;
  } catch {
    return { error: "failed_to_mask_payload" };
  }
}

async function getTelegramFileUrl(botToken, fileId) {
  if (!fileId) throw new Error("getFile failed: missing file_id");
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const data = await res.json().catch(() => ({}));
  console.log("[tg] telegram API ← getFile", {
    http: res.status,
    ok: data?.ok,
    file_path: data?.result?.file_path || null,
    file_size: data?.result?.file_size ?? null,
    description: data?.description || null,
  });
  if (!data?.ok || !data?.result?.file_path) {
    const desc = data?.description || "getFile failed";
    const err = new Error(/too big|file is too big/i.test(desc) ? "FILE_TOO_BIG" : desc);
    err.telegramDescription = desc;
    throw err;
  }
  return `https://api.telegram.org/file/bot${botToken}/${data.result.file_path}`;
}

/**
 * Detect inbound Telegram media (do not use nested thumbnail file_ids).
 */
function extractIncomingMedia(message) {
  // PHOTO — array of resolutions, always use the LAST (largest/best quality)
  if (message?.photo?.length) {
    const largest = message.photo[message.photo.length - 1];
    return { type: "photo", fileId: largest.file_id, caption: message.caption || "" };
  }

  // VIDEO — use video.file_id, NOT video.thumbnail.file_id or video.thumb.file_id
  if (message?.video) {
    return {
      type: "video",
      fileId: message.video.file_id,
      mime: message.video.mime_type,
      fileName: message.video.file_name,
      caption: message.caption || "",
    };
  }

  // VOICE NOTE (the round mic-recorded bubble)
  if (message?.voice) {
    return {
      type: "voice",
      fileId: message.voice.file_id,
      mime: message.voice.mime_type,
      caption: message.caption || "",
    };
  }

  // AUDIO FILE (uploaded mp3/music file, has title/performer metadata)
  if (message?.audio) {
    return {
      type: "audio",
      fileId: message.audio.file_id,
      mime: message.audio.mime_type,
      fileName: message.audio.title || message.audio.file_name,
      caption: message.caption || "",
    };
  }

  // DOCUMENT — covers PDFs and any generic file upload
  if (message?.document) {
    return {
      type: "document",
      fileId: message.document.file_id,
      mime: message.document.mime_type,
      fileName: message.document.file_name,
      caption: message.caption || "",
    };
  }

  // VIDEO NOTE (circular video bubble)
  if (message?.video_note) {
    return { type: "video_note", fileId: message.video_note.file_id, caption: "" };
  }

  return null;
}

/**
 * Build GTWY completion media fields.
 * Image/audio → user_urls only (do NOT send files: [] — Python treats [] as falsy and
 * copies all user_urls into files, which breaks OpenAI with .oga/.ogg).
 * PDF → user_urls type pdf + files: [url].
 * Video direct CDN URLs are NOT supported.
 */
function buildGtwyMediaFields(media, mediaUrl) {
  if (!media || !mediaUrl) return {};

  if (media.type === "photo") {
    return {
      user_urls: [{ url: mediaUrl, type: "image", source: "user" }],
    };
  }

  if (media.type === "voice" || media.type === "audio") {
    return {
      user_urls: [{ url: mediaUrl, type: "audio", source: "user" }],
    };
  }

  if (media.type === "document") {
    const mime = String(media.mime || "");
    const name = String(media.fileName || "");
    if (mime.startsWith("image/")) {
      return { user_urls: [{ url: mediaUrl, type: "image", source: "user" }] };
    }
    if (mime.startsWith("audio/") || /\.(ogg|oga|mp3|wav|m4a|opus)$/i.test(name)) {
      return { user_urls: [{ url: mediaUrl, type: "audio", source: "user" }] };
    }
    if (mime.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/i.test(name)) {
      return { unsupportedVideo: true };
    }
    return {
      user_urls: [{ url: mediaUrl, type: "pdf", source: "user" }],
      files: [mediaUrl],
    };
  }

  if (media.type === "video" || media.type === "video_note") {
    return { unsupportedVideo: true };
  }

  return {};
}

function getProcessingStatus(media, mediaFields) {
  const mediaType = mediaFields?.user_urls?.[0]?.type;
  if (mediaType === "audio") return "Listening to your audio…";
  if (mediaType === "image") return "Looking at your image…";
  if (mediaType === "pdf" || media?.type === "document") return "Reading your document…";
  return "Thinking…";
}

function defaultThreadId(chatId) {
  return `tg_${chatId}`;
}

function createFreshThreadId(chatId) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `tg_${chatId}_${suffix}`;
}

function resolveStoredThreadId(channel, chatId) {
  const stored = channel?.telegram?.chatThreads?.[chatThreadKey(chatId)];
  return stored || defaultThreadId(chatId);
}

async function resetChatThread(collection, versionId, chatId) {
  const threadId = createFreshThreadId(chatId);
  await collection.updateOne(
    { version_id: versionId },
    {
      $set: {
        [`telegram.chatThreads.${chatThreadKey(chatId)}`]: threadId,
        updated_at: new Date(),
      },
    }
  );
  return threadId;
}

function parseSlashCommand(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("/")) return null;
  // /new_thread@BotName → /new_thread
  const token = raw.split(/\s+/)[0] || "";
  const cmd = token.split("@")[0].toLowerCase();
  return cmd || null;
}

/** Safe summary of inbound Telegram update for debug logs. */
function summarizeTelegramUpdate(update) {
  const message = update?.message || update?.edited_message || update?.channel_post || null;
  if (!message) {
    return {
      update_id: update?.update_id,
      keys: update && typeof update === "object" ? Object.keys(update) : [],
    };
  }

  const photo = Array.isArray(message.photo)
    ? message.photo.map((p) => ({
      file_id: p?.file_id,
      width: p?.width,
      height: p?.height,
      file_size: p?.file_size,
    }))
    : null;

  return {
    update_id: update?.update_id,
    message_id: message.message_id,
    chat: { id: message.chat?.id, type: message.chat?.type, title: message.chat?.title },
    from: { id: message.from?.id, username: message.from?.username },
    text: message.text ?? null,
    caption: message.caption ?? null,
    has: {
      photo: Boolean(photo?.length),
      voice: Boolean(message.voice),
      audio: Boolean(message.audio),
      video: Boolean(message.video),
      video_note: Boolean(message.video_note),
      document: Boolean(message.document),
      sticker: Boolean(message.sticker),
    },
    photo,
    voice: message.voice
      ? { file_id: message.voice.file_id, duration: message.voice.duration, mime_type: message.voice.mime_type }
      : null,
    audio: message.audio
      ? {
        file_id: message.audio.file_id,
        duration: message.audio.duration,
        mime_type: message.audio.mime_type,
        file_name: message.audio.file_name,
      }
      : null,
    video: message.video
      ? {
        file_id: message.video.file_id,
        duration: message.video.duration,
        width: message.video.width,
        height: message.video.height,
        mime_type: message.video.mime_type,
      }
      : null,
    document: message.document
      ? {
        file_id: message.document.file_id,
        file_name: message.document.file_name,
        mime_type: message.document.mime_type,
        file_size: message.document.file_size,
      }
      : null,
  };
}

/**
 * GTWY SSE — onDelta is sync (must not await Telegram).
 * Skips `reasoning` events. onStart keeps Thinking… alive (does not clear it).
 * Returns { text, images }.
 */
/** Pull a human-readable message from GTWY error payloads. */
function extractGtwyErrorMessage(data, status, rawText = "") {
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

async function streamGtwyCompletion({ versionId, userText, threadId, extraFields, botToken, onDelta, onStart }) {
  const pythonUrl = (process.env.GTWY_PYTHON_GTWY_SERVER_URL || "").replace(/\/$/, "");
  const pauthkey = process.env.GTWY_PAUTH_KEY || process.env.ACCESS_KEY;
  if (!pythonUrl) throw new Error("GTWY_PYTHON_GTWY_SERVER_URL is not set");
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

  console.log("[tg] GTWY payload", JSON.stringify(redactExtraTools(maskGtwyPayloadForLog(payload, botToken))));

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
    console.error("[tg] GTWY HTTP error", { status: response.status, body: rawText?.slice?.(0, 500) });
    throw new Error(extractGtwyErrorMessage(data, response.status, rawText));
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("event-stream") && !contentType.includes("stream")) {
    const data = await response.json().catch(() => ({}));
    const text = stripReasoning(extractAssistantText(data) || "");
    const images = extractImageUrls(data);
    onDelta?.(text);
    return { text, images };
  }

  if (!response.body) throw new Error("GTWY stream empty body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sse = "";
  let full = "";
  let images = [];
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
        // Keep Thinking… visible — refresh empty draft, do NOT clear loader
        onStart?.();
        continue;
      }

      if (parsed.event === "reasoning") {
        // Never stream reasoning to Telegram (keeps Thinking… up)
        continue;
      }

      if (parsed.event === "delta") {
        const chunk = parsed.content || "";
        if (!chunk) continue;
        full += chunk;
        deltas += 1;
        const clean = stripReasoning(full);
        // Only forward when answer text exists — empty would blank the draft
        if (clean) onDelta?.(clean);
      } else if (parsed.event === "done") {
        const fromDone = extractAssistantText(parsed) || full;
        if (fromDone && fromDone.length > full.length) full = fromDone;
        const doneImages = extractImageUrls(parsed);
        if (doneImages.length) {
          images = doneImages;
          console.log("[tg] images from done", { count: doneImages.length, sample: doneImages[0]?.slice?.(0, 80) });
        }
      } else if (parsed.event === "error") {
        throw new Error(
          extractGtwyErrorMessage(parsed, "stream", "") || parsed.error || parsed.fallback_error || "GTWY stream error"
        );
      }
    }
  }

  const text = stripReasoning(full);
  console.log("[tg] GTWY done", { deltas, chars: text.length, images: images.length });
  return { text, images };
}

/**
 * Handles one Telegram webhook update for the bot bound to `versionId`.
 * Always resolves to the JSON body to answer Telegram with (it is always acked
 * with 200 so Telegram does not keep retrying).
 */
export async function handleTelegramUpdate({ versionId, update }) {
  try {
    // Log everything Telegram sends (file_ids only — no bot-token URLs yet)
    console.log("[tg] webhook raw update", JSON.stringify(update));
    console.log("[tg] webhook summary", summarizeTelegramUpdate(update));

    const message = update?.message || update?.edited_message;
    const chatId = message?.chat?.id;
    const updateId = update?.update_id;

    if (chatId == null) {
      console.log("[tg] skipped: no chatId", { versionId, update_id: updateId });
      return { ok: true, skipped: true };
    }

    if (!versionId) {
      console.error("[tg] missing version_id");
      return { ok: true, error: "missing_version_id" };
    }

    const collection = await getChannelDetailsCollection();
    const channel = await collection.findOne({ version_id: versionId });

    if (!channel?.telegram?.botToken || !channel?.version_id) {
      console.error("[tg] channel not found", { versionId });
      return { ok: true, error: "channel_not_found" };
    }

    // Remember who has talked to this bot (assumes one active user per bot for now) —
    // the scheduler needs this chatId to push responses back into Telegram.
    await collection.updateOne(
      { version_id: versionId },
      {
        $set: {
          "telegram.chatUser": {
            chat_id: chatId,
            username: message?.from?.username || null,
            first_name: message?.from?.first_name || null,
            updated_at: new Date(),
          },
        },
      }
    );

    // Dedup: Telegram resends an update if this webhook doesn't ack fast enough.
    // The update id only increases per bot, so seeing one at or below what was
    // last recorded for this version means it's a retry we already handled.
    if (updateId != null) {
      const lastSeen = channel?.telegram?.lastUpdateId ?? null;
      if (lastSeen != null && updateId <= lastSeen) {
        console.log("[tg] duplicate update skipped", { updateId, lastSeen, chatId });
        return { ok: true, duplicate: true };
      }
      await collection.updateOne({ version_id: versionId }, { $set: { "telegram.lastUpdateId": updateId } });
    }

    // Ack Telegram now — everything below (GTWY streaming, Telegram sends) can take a
    // while, and a slow HTTP response is exactly what makes Telegram retry this update.
    processTelegramMessage({ channel, versionId, message, chatId, update }).catch((error) =>
      console.error("[tg] FATAL (async)", error?.message || error)
    );

    return { ok: true, accepted: true };
  } catch (error) {
    console.error("[tg] FATAL", error);
    return { ok: true, error: error.message };
  }
}

async function processTelegramMessage({ channel, versionId, message, chatId, update }) {
  try {
    const collection = await getChannelDetailsCollection();
    const botToken = decryptSecret(channel.telegram.botToken);

    // /new_thread — rotate GTWY thread_id only (do not delete Telegram messages)
    const slash = parseSlashCommand(message?.text);
    if (slash && NEW_THREAD_COMMANDS.has(slash)) {
      const previousThreadId = resolveStoredThreadId(channel, chatId);
      const threadId = await resetChatThread(collection, versionId, chatId);
      console.log("[tg] new_thread", { chatId, versionId, previousThreadId, threadId });
      await sendMessage(botToken, chatId, "New thread started. Previous conversation context has been cleared.");
      return;
    }

    const userText = message?.text || "";
    const media = extractIncomingMedia(message || {});

    if (!userText && !media) {
      console.log("[tg] skipped: no text/caption/attachment", {
        chatId,
        update_id: update?.update_id,
      });
      return;
    }

    let mediaUrl = null;
    let extraFields = {};
    if (media) {
      console.log("[tg] media received", {
        type: media.type,
        chatId,
        mime: media.mime || null,
        fileName: media.fileName || null,
      });

      // GTWY does not accept direct downloadable Telegram video URLs via user_urls
      if (media.type === "video" || media.type === "video_note") {
        console.warn("[tg] video skipped — direct video URLs not supported by GTWY user_urls");
        await sendMessage(
          botToken,
          chatId,
          "Sorry, Telegram video files aren't supported yet. Please send a YouTube link, or an image / voice note / audio / PDF."
        );
        return;
      }

      try {
        mediaUrl = await getTelegramFileUrl(botToken, media.fileId);
        console.log("[tg] media resolved", {
          type: media.type,
          chatId,
          urlMasked: mediaUrl.replace(botToken, "***"),
        });
      } catch (err) {
        console.error("[tg] getFile failed", {
          type: media?.type,
          error: err.message,
          desc: err.telegramDescription || null,
        });
        const msg =
          err.message === "FILE_TOO_BIG"
            ? "Sorry, that file is too large for Telegram (max 20MB). Please send a smaller file."
            : "Sorry, I couldn't process that file. Please try again.";
        await sendMessage(botToken, chatId, msg);
        return;
      }

      extraFields = buildGtwyMediaFields(media, mediaUrl);
      if (extraFields.unsupportedVideo) {
        await sendMessage(
          botToken,
          chatId,
          "Sorry, Telegram video files aren't supported yet. Please send a YouTube link, or an image / voice note / audio / PDF."
        );
        return;
      }
    }

    // Caption for media, else text. Audio-only asks for a direct answer in one GTWY call.
    const hasAudio =
      media?.type === "voice" || media?.type === "audio" || extraFields?.user_urls?.some?.((u) => u?.type === "audio");
    const userMessage = media
      ? media.caption ||
      userText ||
      (hasAudio
        ? "The attached audio IS the user's message to you. Treat whatever is spoken as if the user typed it directly, and respond to it exactly as you would to a normal text message. Do NOT describe, summarize, transcribe, or mention the audio, and do NOT say what the speaker is asking — just reply directly with the answer itself."
        : "")
      : userText;

    const threadId = resolveStoredThreadId(channel, chatId);
    const draftId = Math.abs(Number(update?.update_id) || Date.now()) % 2147483646 || 1;
    const processingStatus = getProcessingStatus(media, extraFields);

    console.log("[tg] HIT", {
      chatId,
      versionId,
      draftId,
      chunkThreshold: DRAFT_CHUNK_THRESHOLD,
      hasAttachment: Boolean(media),
      attachmentKind: media?.type || null,
    });

    const probe = await sendDraftWithRetry(botToken, chatId, draftId, processingStatus);
    if (!probe?.ok) {
      console.warn("[tg] sendMessageDraft unavailable:", probe?.description);
    } else {
      console.log("[tg] processing draft ON", { processingStatus });
    }

    const streamer = new TelegramStreamUpdater({
      chunkThreshold: DRAFT_CHUNK_THRESHOLD,
      textLimit: TELEGRAM_TEXT_LIMIT,
      sendDraft: (text) => sendDraft(botToken, chatId, draftId, text),
    });

    let replyText = "";
    let images = [];
    try {
      const result = await streamGtwyCompletion({
        versionId: channel.version_id,
        userText: userMessage,
        threadId,
        extraFields,
        botToken,
        // Refresh the type-aware status on start; the first answer replaces it.
        onStart: () => {
          if (probe?.ok) {
            sendDraft(botToken, chatId, draftId, processingStatus).catch(() => { });
          }
        },
        onDelta: (cleanText) => {
          if (probe?.ok) streamer.push(cleanText);
        },
      });
      replyText = result?.text || "";
      images = result?.images || [];
    } catch (err) {
      const errMsg = String(err?.message || err || "").trim();
      console.error("[tg] GTWY error", errMsg);
      // Don't dump raw HTTP/JSON errors into Telegram chat
      if (/unsupported_file/i.test(errMsg)) {
        replyText =
          "Sorry, this agent couldn't process that audio file. Use a Gemini / Deepgram / Mistral model for voice, or send an image or PDF.";
      } else if (/^HTTP \d+/i.test(errMsg) || errMsg.trim().startsWith("{")) {
        replyText = "Sorry, something went wrong generating a response.";
      } else {
        replyText = humanizeGtwyError(errMsg) || "Sorry, something went wrong generating a response.";
      }
    }

    const FALLBACK_MSG = "Sorry, I could not generate a response.";
    // Never echo Telegram CDN / uploaded file URLs back to the user (text or media)
    const stripTelegramFileUrls = (text) =>
      String(text || "")
        .replace(/https?:\/\/api\.telegram\.org\/file\/bot\S+/gi, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    const finalText = stripTelegramFileUrls(stripReasoning(replyText || ""));
    const outboundImages = (images || []).filter(
      (url) => typeof url === "string" && url && !/api\.telegram\.org\/file\/bot/i.test(url)
    );
    const stats = probe?.ok
      ? await streamer.finish(finalText || (outboundImages.length ? " " : FALLBACK_MSG))
      : (streamer.stop(), { sentCount: 0, text: finalText });

    // Images → sendPhoto; long text goes as follow-up messages (split at 4096)
    if (outboundImages.length > 0) {
      for (let i = 0; i < outboundImages.length; i++) {
        const photoRes = await sendPhoto(botToken, chatId, outboundImages[i], undefined);
        if (!photoRes?.ok) {
          console.error("[tg] sendPhoto failed", photoRes?.description);
          // Do not send the raw URL as text
        }
      }
      if (finalText) {
        await sendLongMessage(botToken, chatId, finalText);
      }
    } else {
      const parts = await sendLongMessage(botToken, chatId, finalText || FALLBACK_MSG);
      console.log("[tg] sent message parts", { count: parts.length });
    }

    console.log("[tg] done", {
      drafts: stats.sentCount,
      chars: finalText.length,
      parts: splitTelegramText(finalText || "…").length,
      images: outboundImages.length,
      skippedTelegramFileUrls: (images?.length || 0) - outboundImages.length,
    });
  } catch (error) {
    console.error("[tg] FATAL", error);
  }
}
