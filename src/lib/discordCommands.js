/**
 * Discord application (slash) command registration.
 * Slash commands are separate from text messages — they must be registered with
 * Discord before they show up in the client's command picker.
 */

const DISCORD_API = "https://discord.com/api/v10";

export const NEW_THREAD_COMMAND = "new_thread";

const COMMAND_DEFINITIONS = [
  {
    name: NEW_THREAD_COMMAND,
    description: "Start a new thread (clears previous conversation context)",
    type: 1,
  },
];

async function discordFetch(botToken, method, path, body) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function getApplicationId(botToken) {
  const res = await discordFetch(botToken, "GET", "/applications/@me");
  if (!res.ok || !res.data?.id) {
    throw new Error(res.data?.message || `Failed to resolve Discord application (${res.status})`);
  }
  return res.data.id;
}

/**
 * Register global slash commands. Global commands can take a few minutes to
 * appear in every client; they work in DMs and in servers the bot is in.
 */
export async function registerDiscordCommands(botToken) {
  const applicationId = await getApplicationId(botToken);
  const res = await discordFetch(botToken, "PUT", `/applications/${applicationId}/commands`, COMMAND_DEFINITIONS);
  if (!res.ok) {
    throw new Error(res.data?.message || `Failed to register commands (${res.status})`);
  }
  return { registered: COMMAND_DEFINITIONS.map((c) => c.name), applicationId };
}

export async function clearDiscordCommands(botToken) {
  const applicationId = await getApplicationId(botToken);
  const res = await discordFetch(botToken, "PUT", `/applications/${applicationId}/commands`, []);
  if (!res.ok) {
    throw new Error(res.data?.message || `Failed to clear commands (${res.status})`);
  }
  return { cleared: true, applicationId };
}
