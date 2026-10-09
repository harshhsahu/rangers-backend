import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { startFakeUpstream } from './fakeUpstream.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

/**
 * Boots the real compiled server (dist/index.js) as a child process against an
 * in-memory MongoDB and the fake upstream. Nothing outside this machine is contacted.
 */
export async function startStack() {
  const mongo = await MongoMemoryServer.create();
  const upstream = await startFakeUpstream();
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const logs = [];
  const server = spawn(process.execPath, ['--import', './test/support/redirect-fetch.mjs', 'dist/index.js'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      PORT: String(port),
      CORS_ORIGIN: '*',
      FAKE_UPSTREAM_URL: upstream.url,
      MONGODB_URI: mongo.getUri('rangers_test'),
      SERVER_URL: upstream.url,
      PYTHON_SERVER_URL: upstream.url,
      PROXY_URL: upstream.url,
      FRONTEND_URL: 'https://app.rangers.test',
      TELEGRAM_WEBHOOK_BASE_URL: 'https://hooks.rangers.test',
      RANGER_PUBLIC_URL: 'https://api.rangers.test',
      ORG_ID: 'jwt-org',
      FOLDER_ID: 'folder-1',
      ACCESS_KEY: 'test-access-key',
      GTWY_PAUTH_KEY: 'test-pauthkey',
      CHANNEL_ENCRYPTION_KEY: 'test-encryption-key',
      EASYCRON_API_KEY: 'test-easycron-key',
      SCHEDULER_ADMIN_KEY: 'test-admin-key',
      SCHEDULER_MAX_PER_RANGER: '3',
      DISCORD_INTERNAL_SECRET: 'test-discord-secret',
    },
  });
  server.stdout.on('data', (chunk) => logs.push(String(chunk)));
  server.stderr.on('data', (chunk) => logs.push(String(chunk)));

  // Wait for the health endpoint rather than a fixed delay.
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${logs.join('')}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`server did not start:\n${logs.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const db = new MongoClient(mongo.getUri('rangers_test'));
  await db.connect();

  return {
    baseUrl,
    upstream,
    logs,
    db: db.db(),
    async stop() {
      server.kill('SIGTERM');
      await once(server, 'exit');
      await db.close();
      await upstream.close();
      await mongo.stop();
    },
  };
}

/** Polls `check` until it returns a truthy value (for work done after the response). */
export async function eventually(check, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
