/**
 * Discord bot manager — runs discord.js Gateway clients inside the backend Node process.
 * One Client per agent version_id. Handles DMs and direct server mentions.
 */

import { Client, GatewayIntentBits, Partials } from "discord.js";
import { getChannelDetailsCollection } from "../models/channelDetails.model.js";
import { decryptSecret } from "./crypto.js";
import { processDiscordMessage, resetDiscordThread } from "./discordMessageHandler.js";
import { NEW_THREAD_COMMAND, registerDiscordCommands } from "./discordCommands.js";

const globalKey = "__gtwy_discord_bot_manager__";

function getStore() {
  if (!global[globalKey]) {
    global[globalKey] = {
      clients: new Map(), // versionId -> { client, tokenFingerprint }
      syncing: null,
    };
  }
  return global[globalKey];
}

function tokenFingerprint(token) {
  return String(token || "").slice(-12);
}

function buildRelayPayload(message, { content } = {}) {
  const attachments = [];
  if (message.attachments?.size) {
    for (const [, att] of message.attachments) {
      attachments.push({
        id: att.id,
        url: att.url,
        proxy_url: att.proxyURL || att.proxy_url || null,
        content_type: att.contentType || att.content_type || null,
        name: att.name || "file",
        size: att.size ?? null,
      });
    }
  }

  return {
    id: message.id,
    content: content ?? message.content ?? "",
    channel_id: message.channelId || message.channel?.id,
    guild_id: message.guildId || null,
    author: {
      id: message.author?.id,
      username: message.author?.username,
      bot: Boolean(message.author?.bot),
    },
    system: Boolean(message.system),
    attachments,
  };
}

function attachHandlers(client, versionId) {
  client.on("messageCreate", async (message) => {
    try {
      if (message.author?.bot) return;
      if (message.system) return;

      const isDM = !message.guildId;
      const isMentioned = Boolean(client.user) && message.mentions?.has(client.user);
      if (!isDM && !isMentioned) return;

      // Remove Discord mention syntax before sending either DM or server text to GTWY.
      const cleanText = String(message.content || "")
        .replace(/<@!?\d+>/g, "")
        .trim();
      const payload = buildRelayPayload(message, { content: cleanText });
      if (!payload.content?.trim() && !(payload.attachments?.length > 0)) return;

      console.log("[discord] message received", {
        versionId,
        source: isDM ? "dm" : "guild_mention",
        channelId: payload.channel_id,
        author: payload.author?.username,
        attachments: payload.attachments?.length || 0,
      });

      await processDiscordMessage({ versionId, message: payload });
    } catch (err) {
      console.error("[discord] messageCreate error", err?.message || err);
    }
  });

  client.on("interactionCreate", async (interaction) => {
    try {
      if (!interaction.isChatInputCommand?.()) return;
      if (interaction.commandName !== NEW_THREAD_COMMAND) return;

      await resetDiscordThread({ versionId, channelId: interaction.channelId });
      await interaction.reply({
        content: "New thread started. Previous conversation context has been cleared.",
      });
    } catch (err) {
      console.error("[discord] interaction error", err?.message || err);
      if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
        interaction.reply({ content: "Could not start a new thread.", ephemeral: true }).catch(() => {});
      }
    }
  });

  client.on("error", (err) => {
    console.error("[discord] client error", versionId, err?.message || err);
  });
}

export async function startDiscordBot(versionId, botToken) {
  const store = getStore();
  const existing = store.clients.get(versionId);
  const fp = tokenFingerprint(botToken);

  if (existing?.tokenFingerprint === fp && existing.client?.isReady?.()) {
    return { ok: true, alreadyRunning: true };
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  attachHandlers(client, versionId);

  // Login validates the token AND the privileged intents against Discord's
  // Gateway. Throws (e.g. "disallowed intents", "invalid token") before we
  // touch the existing running client, so a failed re-validation never tears
  // down a bot that was already working.
  await client.login(botToken);

  if (existing?.client) {
    try {
      existing.client.destroy();
    } catch {
      /* ignore */
    }
  }

  store.clients.set(versionId, { client, tokenFingerprint: fp });
  console.log("[discord] bot started", { versionId, tag: client.user?.tag });
  return { ok: true, tag: client.user?.tag || null };
}

export async function stopDiscordBot(versionId) {
  const store = getStore();
  const existing = store.clients.get(versionId);
  if (!existing) return { ok: true, stopped: false };
  try {
    existing.client.destroy();
  } catch (err) {
    console.warn("[discord] destroy error", err?.message || err);
  }
  store.clients.delete(versionId);
  console.log("[discord] bot stopped", { versionId });
  return { ok: true, stopped: true };
}

export async function syncDiscordBotsFromDb() {
  const store = getStore();
  if (store.syncing) return store.syncing;

  store.syncing = (async () => {
    try {
      const collection = await getChannelDetailsCollection();
      const docs = await collection
        .find({ "discord.botToken": { $exists: true, $ne: null } })
        .project({ version_id: 1, discord: 1 })
        .toArray();

      const wanted = new Set();
      for (const doc of docs) {
        const versionId = doc.version_id;
        if (!versionId || !doc?.discord?.botToken) continue;
        wanted.add(versionId);
        try {
          const token = decryptSecret(doc.discord.botToken);
          if (!token) continue;
          await startDiscordBot(versionId, token);
          // Idempotent PUT — keeps /new_thread present for bots connected before commands existed
          registerDiscordCommands(token).catch((err) =>
            console.warn("[discord] command sync skipped", versionId, err?.message || err)
          );
        } catch (err) {
          console.error("[discord] failed to start bot", versionId, err?.message || err);
        }
      }

      for (const versionId of store.clients.keys()) {
        if (!wanted.has(versionId)) {
          await stopDiscordBot(versionId);
        }
      }

      return { ok: true, count: store.clients.size };
    } catch (err) {
      console.error("[discord] syncDiscordBotsFromDb failed", err?.message || err);
      return { ok: false, error: err?.message || String(err) };
    } finally {
      store.syncing = null;
    }
  })();

  return store.syncing;
}

export function listRunningDiscordBots() {
  const store = getStore();
  return Array.from(store.clients.keys());
}
