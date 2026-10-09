import { maskSecret } from "./crypto.js";

export const TELEGRAM_TEXT_LIMIT = 4096;

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
export function markdownToTelegramHtml(text) {
  const raw = String(text || "");
  if (!raw) return raw;

  const codeBlocks = [];
  const inlineCodes = [];

  let out = raw.replace(/```(?:[a-zA-Z0-9_-]*\n)?([\s\S]*?)```/g, (_m, code) => {
    const token = "CB" + codeBlocks.length;
    codeBlocks.push("<pre><code>" + escapeTelegramHtml(code.replace(/\n$/, "")) + "</code></pre>");
    return token;
  });

  out = out.replace(/`([^`\n]+)`/g, (_m, code) => {
    const token = "IC" + inlineCodes.length;
    inlineCodes.push("<code>" + escapeTelegramHtml(code) + "</code>");
    return token;
  });

  out = escapeTelegramHtml(out);

  // Links: [text](url)
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    return '<a href="' + url.replace(/"/g, "&quot;") + '">' + label + "</a>";
  });

  // Bold: **text** / __text__
  out = out.replace(/\*\*([^\n]+?)\*\*/g, "<b>$1</b>");
  out = out.replace(/__([^\n]+?)__/g, "<b>$1</b>");

  // Strikethrough: ~~text~~
  out = out.replace(/~~([^\n]+?)~~/g, "<s>$1</s>");

  // Italic: *text* (single asterisk only — leaves _snake_case_ words untouched)
  out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<i>$2</i>");

  // Headings -> bold line
  out = out.replace(/^ {0,3}#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  out = out.replace(/IC(\d+)/g, function (_m, i) {
    return inlineCodes[Number(i)];
  });
  out = out.replace(/CB(\d+)/g, function (_m, i) {
    return codeBlocks[Number(i)];
  });

  return out;
}

/**
 * Split long text into Telegram-safe parts (<=4096), preferring line breaks.
 * Final replies must use this - truncate drops the rest of the answer.
 */
export function splitTelegramText(text, limit) {
  var lim = limit || TELEGRAM_TEXT_LIMIT;
  var t = String(text || "");
  if (!t) return [];
  if (t.length <= lim) return [t];

  var parts = [];
  var remaining = t;
  while (remaining.length > lim) {
    var cut = remaining.lastIndexOf("\n", lim);
    if (cut < Math.floor(lim * 0.5)) cut = remaining.lastIndexOf(" ", lim);
    if (cut < Math.floor(lim * 0.5)) cut = lim;
    parts.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export async function telegramApi(botToken, method, body) {
  const url = "https://api.telegram.org/bot" + botToken + "/" + method;
  console.log("[tg] telegram API ->", method, JSON.stringify(body || {}));
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(function () {
    return {};
  });
  const logged = JSON.stringify(data);
  console.log(
    "[tg] telegram API <-",
    method,
    "http=" + res.status,
    botToken && logged.includes(botToken) ? logged.split(botToken).join(maskSecret(botToken)) : logged
  );
  return data;
}

export async function sendMessage(botToken, chatId, text) {
  return telegramApi(botToken, "sendMessage", {
    chat_id: chatId,
    text: markdownToTelegramHtml(String(text || "...").slice(0, TELEGRAM_TEXT_LIMIT)),
    parse_mode: "HTML",
  });
}

/** Send full reply as one or more messages (no silent truncation). */
export async function sendLongMessage(botToken, chatId, text) {
  const parts = splitTelegramText(text || "...");
  const results = [];
  for (const part of parts) {
    const sent = await sendMessage(botToken, chatId, part);
    if (!sent || !sent.ok) {
      console.error("[tg] sendMessage part failed", {
        partLen: part.length,
        desc: sent && sent.description,
      });
    }
    results.push(sent);
  }
  return results;
}
