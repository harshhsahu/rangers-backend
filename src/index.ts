// Loads and validates configuration before anything reads process.env.
import { env } from './config/env.js';
import dns from 'node:dns';
import { createApp } from './app.js';
import { closeDatabase } from './config/database.js';
import { startDiscordBots, stopDiscordBots } from './jobs/discordBots.js';
import { verifyAgents } from './services/agents.service.js';

// Some hosts (containers without a working IPv6 route) have Node's fetch try IPv6
// first and fail outright instead of falling back to IPv4 the way curl does.
dns.setDefaultResultOrder('ipv4first');

const SHUTDOWN_TIMEOUT_MS = 10_000;

const server = createApp().listen(env.PORT, () => {
  console.log(`Server running on http://localhost:${env.PORT} (${env.NODE_ENV})`);
  void startDiscordBots();
  void verifyAgents();
});

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} received, shutting down`);

  // Force exit if connections refuse to drain (e.g. a long SSE stream).
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await stopDiscordBots();
  await closeDatabase().catch(() => {});
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Background work (scheduled runs, Telegram/Discord processing) runs after the response
// is sent; a stray rejection there must be logged, not take the whole server down.
process.on('unhandledRejection', (reason) => console.error('[server] unhandled rejection', reason));
