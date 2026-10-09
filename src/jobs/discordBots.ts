import { listRunningDiscordBots, stopDiscordBot, syncDiscordBotsFromDb } from '../lib/discordBotManager.js';
import { errorMessage } from '../utils/AppError.js';

/**
 * Discord bots hold Gateway connections, so they live in this long-running process:
 * every bot stored in the database is started at boot.
 */
export async function startDiscordBots() {
  try {
    const result = await syncDiscordBotsFromDb();
    console.log('[discord] boot sync', result);
  } catch (error) {
    console.error('[discord] boot sync failed', errorMessage(error));
  }
}

export async function stopDiscordBots() {
  await Promise.allSettled(listRunningDiscordBots().map((versionId: string) => stopDiscordBot(versionId)));
}
