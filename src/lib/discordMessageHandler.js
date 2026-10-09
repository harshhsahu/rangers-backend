import { getChannelDetailsCollection } from "../models/channelDetails.model.js";
import { decryptSecret } from "./crypto.js";
import { DiscordStreamUpdater } from "./discordStreamUpdater.js";
import {
  stripReasoning,
  splitText,
  parseSlashCommand,
  streamGtwyCompletion,
  isLikelyImageUrl,
  humanizeGtwyError,
} from "./gtwyChannelHelpers.js";

const DISCORD_TEXT_LIMIT = 2000;
const DISCORD_UPLOAD_LIMIT = 8 * 1024 * 1024; // 8MB bot upload cap
const MAX_ATTACHMENT_BYTES = Number(process.env.DISCORD_MAX_ATTACHMENT_BYTES) || 20 * 1024 * 1024;
const DRAFT_CHUNK_THRESHOLD = Number(process.env.DISCORD_DRAFT_CHUNK_THRESHOLD) || 3;
const NEW_THREAD_COMMANDS = new Set(["/new_thread", "/newthread"]);
const DISCORD_API = "https://discord.com/api/v10";
const TYPING_REFRESH_MS = 8000;

function splitDiscordText(text, limit = DISCORD_TEXT_LIMIT) {
  return splitText(text, limit);
}

function chatThreadKey(channelId) {
  return String(channelId);
}

function defaultThreadId(channelId) {
  return `dc_${channelId}`;
}

function createFreshThreadId(channelId) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `dc_${channelId}_${suffix}`;
}

function resolveStoredThreadId(channel, channelId) {
  const stored = channel?.discord?.chatThreads?.[chatThreadKey(channelId)];
  return stored || defaultThreadId(channelId);
}

async function resetChatThread(collection, versionId, channelId) {
  const threadId = createFreshThreadId(channelId);
  await collection.updateOne(
    { version_id: versionId },
    {
      $set: {
        [`discord.chatThreads.${chatThreadKey(channelId)}`]: threadId,
        updated_at: new Date(),
      },
    }
  );
  return threadId;
}

/**
 * Rotate the GTWY thread for a Discord channel (used by /new_thread, typed or slash).
 */
export async function resetDiscordThread({ versionId, channelId }) {
  const collection = await getChannelDetailsCollection();
  const channel = await collection.findOne({ version_id: versionId });
  const previousThreadId = resolveStoredThreadId(channel, channelId);
  const threadId = await resetChatThread(collection, versionId, channelId);
  console.log("[discord] new_thread", { channelId, versionId, previousThreadId, threadId });
  return { threadId, previousThreadId };
}

/** Mask Discord CDN signed URLs in logs. */
function maskDiscordUrl(url) {
  if (!url) return url;
  const s = String(url);
  return s
    .replace(/([?&](ex|is|hm|signature)=)[^&]+/gi, "$1***")
    .replace(/(discord(?:app)?\.com\/attachments\/\d+\/\d+\/)[^\s?]+/gi, "$1***");
}

function maskGtwyPayloadForLog(payload) {
  try {
    const clone = JSON.parse(JSON.stringify(payload || {}));
    const maskVal = (v) => (typeof v === "string" ? maskDiscordUrl(v) : v);
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

async function discordApi(botToken, method, path, body) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("[discord] API error", method, path, res.status, JSON.stringify(data));
    return {
      ok: false,
      status: res.status,
      error: data?.message || `Discord API ${res.status}`,
      retry_after: data?.retry_after,
      data,
    };
  }
  return { ok: true, data, status: res.status };
}

async function sendDiscordMessage(botToken, channelId, body) {
  return discordApi(botToken, "POST", `/channels/${channelId}/messages`, body);
}

async function editDiscordMessage(botToken, channelId, messageId, body) {
  return discordApi(botToken, "PATCH", `/channels/${channelId}/messages/${messageId}`, body);
}

async function deleteDiscordMessage(botToken, channelId, messageId) {
  if (!messageId) return { ok: true };
  return discordApi(botToken, "DELETE", `/channels/${channelId}/messages/${messageId}`);
}

/**
 * Discord shows "Bot is typing…" for ~10s per trigger, so refresh it while GTWY works.
 * Returns a stop function.
 */
function startTypingIndicator(botToken, channelId) {
  let stopped = false;
  const trigger = () => {
    if (stopped) return;
    discordApi(botToken, "POST", `/channels/${channelId}/typing`).catch(() => {});
  };
  trigger();
  const interval = setInterval(trigger, TYPING_REFRESH_MS);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

async function sendLongText(botToken, channelId, text) {
  const parts = splitDiscordText(text || "…");
  const results = [];
  for (const part of parts) {
    results.push(await sendDiscordMessage(botToken, channelId, { content: part }));
  }
  return results;
}

async function sendImageEmbeds(botToken, channelId, imageUrls) {
  const chunks = [];
  for (let i = 0; i < imageUrls.length; i += 10) {
    chunks.push(imageUrls.slice(i, i + 10));
  }
  const results = [];
  for (const chunk of chunks) {
    const embeds = chunk.map((url) => ({ image: { url } }));
    results.push(await sendDiscordMessage(botToken, channelId, { embeds }));
  }
  return results;
}

async function sendFileAttachment(botToken, channelId, fileUrl, content) {
  try {
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) throw new Error(`fetch file failed (${fileRes.status})`);
    const buf = Buffer.from(await fileRes.arrayBuffer());
    if (buf.length > DISCORD_UPLOAD_LIMIT) {
      console.warn("[discord] file exceeds 8MB upload cap — sending URL as text");
      return sendDiscordMessage(botToken, channelId, {
        content: content
          ? `${String(content).slice(0, DISCORD_TEXT_LIMIT - 80)}\n${fileUrl}`.slice(0, DISCORD_TEXT_LIMIT)
          : fileUrl,
      });
    }

    const disposition = fileRes.headers.get("content-disposition") || "";
    const nameMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
    let filename = nameMatch?.[1] ? decodeURIComponent(nameMatch[1].replace(/"/g, "")) : null;
    if (!filename) {
      try {
        filename = decodeURIComponent(new URL(fileUrl).pathname.split("/").pop() || "file");
      } catch {
        filename = "file";
      }
    }

    const form = new FormData();
    form.append(
      "payload_json",
      JSON.stringify({
        content: content ? String(content).slice(0, DISCORD_TEXT_LIMIT) : undefined,
      })
    );
    const blob = typeof File !== "undefined" ? new File([buf], filename) : new Blob([buf]);
    form.append("files[0]", blob, filename);

    const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error("[discord] multipart upload failed", res.status, data);
      return sendDiscordMessage(botToken, channelId, {
        content: content ? `${content}\n${fileUrl}`.slice(0, DISCORD_TEXT_LIMIT) : fileUrl,
      });
    }
    return { ok: true, data };
  } catch (err) {
    console.error("[discord] sendFileAttachment error", err?.message || err);
    return sendDiscordMessage(botToken, channelId, {
      content: content ? `${content}\n${fileUrl}`.slice(0, DISCORD_TEXT_LIMIT) : String(fileUrl),
    });
  }
}

function buildMediaFromAttachments(attachments) {
  const user_urls = [];
  const files = [];
  let unsupported = null;
  let tooLarge = null;
  let defaultPrompt = "";

  for (const att of attachments || []) {
    const size = Number(att.size) || 0;
    if (size > MAX_ATTACHMENT_BYTES) {
      tooLarge = att.name || "file";
      break;
    }

    const mime = String(att.content_type || "").toLowerCase();
    const url = att.url || att.proxy_url;
    if (!url) continue;

    const name = String(att.name || "");
    if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) {
      user_urls.push({ url, type: "image", source: "user" });
      if (!defaultPrompt) defaultPrompt = "Describe this image";
    } else if (mime.startsWith("audio/") || /\.(ogg|oga|mp3|wav|m4a|opus)$/i.test(name)) {
      user_urls.push({ url, type: "audio", source: "user" });
      if (!defaultPrompt)
        defaultPrompt =
          "The attached audio IS the user's message to you. Treat whatever is spoken as if the user typed it directly, and respond to it exactly as you would to a normal text message. Do NOT describe, summarize, transcribe, or mention the audio, and do NOT say what the speaker is asking — just reply directly with the answer itself.";
    } else if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
      user_urls.push({ url, type: "pdf", source: "user" });
      files.push(url);
      if (!defaultPrompt) defaultPrompt = "Summarize this document";
    } else if (mime.startsWith("video/") || /\.(mp4|mov|webm|mkv)$/i.test(name)) {
      unsupported = name || mime || "file";
      break;
    } else {
      unsupported = name || mime || "file";
      break;
    }
  }

  return { user_urls, files, unsupported, tooLarge, defaultPrompt };
}

function getProcessingStatus(media) {
  const mediaType = media?.user_urls?.[0]?.type;
  if (mediaType === "audio") return "Listening to your audio…";
  if (mediaType === "image") return "Looking at your image…";
  if (mediaType === "pdf") return "Reading your document…";
  return "Thinking…";
}

/**
 * Process one Discord DM (relay payload) for a bound agent version.
 */
export async function processDiscordMessage({ versionId, message }) {
  try {
    if (!versionId) return { ok: true, error: "missing_version_id" };
    if (!message?.channel_id) return { ok: true, skipped: true, reason: "no_channel" };

    if (message.system || message.author?.bot) {
      return { ok: true, skipped: true, reason: "bot_or_system" };
    }

    const collection = await getChannelDetailsCollection();
    const channel = await collection.findOne({ version_id: versionId });
    if (!channel?.discord?.botToken || !channel?.version_id) {
      console.error("[discord] channel not found", { versionId });
      return { ok: true, error: "channel_not_found" };
    }

    const botToken = decryptSecret(channel.discord.botToken);
    const channelId = message.channel_id;

    const slash = parseSlashCommand(message?.content);
    if (slash && NEW_THREAD_COMMANDS.has(slash)) {
      const previousThreadId = resolveStoredThreadId(channel, channelId);
      const threadId = await resetChatThread(collection, versionId, channelId);
      console.log("[discord] new_thread", { channelId, versionId, previousThreadId, threadId });
      await sendDiscordMessage(botToken, channelId, {
        content: "New thread started. Previous conversation context has been cleared.",
      });
      return { ok: true, new_thread: true, thread_id: threadId };
    }

    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const media = buildMediaFromAttachments(attachments);

    if (media.tooLarge) {
      await sendDiscordMessage(botToken, channelId, {
        content: `Sorry, that file is too large (max ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB). Please send a smaller file.`,
      });
      return { ok: true, skipped: true, reason: "file_too_large" };
    }

    if (media.unsupported) {
      await sendDiscordMessage(botToken, channelId, {
        content: "Sorry, that file type isn't supported yet. Please send an image, audio file, or PDF.",
      });
      return { ok: true, skipped: true, reason: "unsupported_attachment" };
    }

    const userText = String(message.content || "").trim();
    if (!userText && !media.user_urls.length) {
      return { ok: true, skipped: true, reason: "empty" };
    }

    const extraFields = {};
    if (media.user_urls.length) extraFields.user_urls = media.user_urls;
    if (media.files.length) extraFields.files = media.files;

    const userMessage = userText || media.defaultPrompt || "";
    const threadId = resolveStoredThreadId(channel, channelId);

    console.log("[discord] HIT", {
      channelId,
      versionId,
      hasAttachment: media.user_urls.length > 0,
      attachmentCount: media.user_urls.length,
    });

    // Keep Discord's native typing indicator alongside an editable, type-aware status.
    const stopTyping = startTypingIndicator(botToken, channelId);

    // In a server channel, reply to the mention so the answer is attributable
    const replyReference =
      message.guild_id && message.id
        ? { message_reference: { message_id: message.id, fail_if_not_exists: false } }
        : {};

    let streamMessageId = null;
    const publishText = async (text) => {
      const content = String(text || "").slice(0, DISCORD_TEXT_LIMIT);
      if (!content) return { ok: true };
      if (!streamMessageId) {
        const created = await sendDiscordMessage(botToken, channelId, { content, ...replyReference });
        if (created?.ok) streamMessageId = created.data?.id || null;
        return created;
      }
      return editDiscordMessage(botToken, channelId, streamMessageId, { content });
    };

    const streamer = new DiscordStreamUpdater({
      chunkThreshold: DRAFT_CHUNK_THRESHOLD,
      textLimit: DISCORD_TEXT_LIMIT,
      publish: publishText,
    });

    const processingStatus = getProcessingStatus(media);
    await publishText(processingStatus);

    let replyText = "";
    let images = [];
    let files = [];
    try {
      const result = await streamGtwyCompletion({
        versionId: channel.version_id,
        userText: userMessage,
        threadId,
        extraFields,
        logPrefix: "[discord]",
        maskPayload: (payload) => maskGtwyPayloadForLog(payload),
        onDelta: (cleanText) => {
          streamer.push(cleanText);
        },
      });
      replyText = result?.text || "";
      images = result?.images || [];
      files = (result?.files || []).filter((u) => !isLikelyImageUrl(u));
    } catch (err) {
      const errMsg = String(err?.message || err || "").trim();
      console.error("[discord] GTWY error", errMsg);
      if (/unsupported_file/i.test(errMsg)) {
        replyText = "Sorry, this agent couldn't process that file. Try an image, audio, or PDF with a supported model.";
      } else if (/^HTTP \d+/i.test(errMsg) || errMsg.trim().startsWith("{")) {
        replyText = "Sorry, something went wrong generating a response.";
      } else {
        replyText = humanizeGtwyError(errMsg) || "Sorry, something went wrong generating a response.";
      }
    } finally {
      stopTyping();
    }

    const FALLBACK_MSG = "Sorry, I could not generate a response.";
    const finalText = stripReasoning(replyText || "");
    const outboundImages = (images || []).filter((url) => typeof url === "string" && url);
    const parts = splitDiscordText(finalText);

    if (parts.length) {
      await streamer.finish(parts[0]);
    } else {
      streamer.stop();
    }

    if (outboundImages.length > 0) {
      await sendImageEmbeds(botToken, channelId, outboundImages);
    }

    for (const fileUrl of files) {
      await sendFileAttachment(botToken, channelId, fileUrl, undefined);
    }

    if (parts.length > 1) {
      await sendLongText(botToken, channelId, parts.slice(1).join("\n\n"));
    }

    if (!parts.length && (outboundImages.length || files.length)) {
      await deleteDiscordMessage(botToken, channelId, streamMessageId);
    } else if (!parts.length) {
      await publishText(FALLBACK_MSG);
    }

    console.log("[discord] done", {
      chars: finalText.length,
      messages: parts.length,
      images: outboundImages.length,
      files: files.length,
      maskedSample: outboundImages[0] ? maskDiscordUrl(outboundImages[0]) : null,
    });

    return {
      ok: true,
      chars: finalText.length,
      images: outboundImages.length,
      files: files.length,
    };
  } catch (error) {
    console.error("[discord] FATAL", error);
    return { ok: true, error: error.message };
  }
}
