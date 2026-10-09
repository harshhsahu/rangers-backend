/**
 * Repoint every schedule at the tunnel that is running right now.
 *
 *   node scripts/sync-scheduler-tunnel.mjs [https://new-host.example.com]
 *
 * A trycloudflare quick tunnel gets a new hostname every time it restarts, and
 * each EasyCron job keeps the URL it was created with — so a restart silently
 * breaks every existing schedule, and the only symptom is "no such host" in a
 * dashboard nobody is watching. This rewrites .env and every job's URL in one go.
 *
 * With no argument it reads the hostname from a running cloudflared's metrics
 * server. Pass one explicitly for ngrok or a named tunnel.
 *
 * Not needed in production: a stable RANGER_PUBLIC_URL never goes out of date.
 */
import fs from "fs";
import { MongoClient } from "mongodb";

const ENV_PATH = ".env";

const readEnv = () =>
  Object.fromEntries(
    fs
      .readFileSync(ENV_PATH, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.trim().startsWith("#"))
      .map((line) => [
        line.slice(0, line.indexOf("=")).trim(),
        line
          .slice(line.indexOf("=") + 1)
          .trim()
          .replace(/^["']|["']$/g, ""),
      ])
  );

/** cloudflared exposes its quick-tunnel hostname on a local metrics port. */
async function discoverTunnel() {
  const ports = [];
  try {
    const out = fs.readFileSync("/proc/net/tcp", "utf8");
    for (const line of out.split("\n").slice(1)) {
      const local = line.trim().split(/\s+/)[1];
      if (!local) continue;
      const [ip, port] = local.split(":");
      if (ip === "0100007F") ports.push(parseInt(port, 16));
    }
  } catch {
    /* not Linux — pass the host in explicitly */
  }

  for (const port of [...new Set(ports)]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/quicktunnel`, { signal: AbortSignal.timeout(1500) });
      const data = await res.json();
      if (data?.hostname) return `https://${data.hostname}`;
    } catch {
      /* not a cloudflared metrics port */
    }
  }
  return null;
}

const host = (process.argv[2] || (await discoverTunnel()) || "").replace(/\/$/, "");
if (!host) {
  console.error(
    "No tunnel found. Start cloudflared, or pass the URL: node scripts/sync-scheduler-tunnel.mjs https://…"
  );
  process.exit(1);
}

// Both vars point at the same origin: the scheduler's callback and Telegram's
// webhook are the same app, and a restart invalidates both together.
let env = fs.readFileSync(ENV_PATH, "utf8");
for (const key of ["RANGER_PUBLIC_URL", "TELEGRAM_WEBHOOK_BASE_URL"]) {
  env = env.match(new RegExp(`^${key}=`, "m"))
    ? env.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${host}`)
    : `${env.replace(/\n*$/, "\n")}${key}=${host}\n`;
}
fs.writeFileSync(ENV_PATH, env);
console.log("env  ->", host);

const config = readEnv();
const client = new MongoClient(config.MONGODB_URI);
await client.connect();
const rows = await client.db().collection("rangerschedules").find({}).toArray();
await client.close();

for (const row of rows) {
  if (!row.easycron_id) {
    console.log(`row ${row._id}: no cron job attached — skipped`);
    continue;
  }
  const res = await fetch("https://www.easycron.com/rest/edit", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: config.EASYCRON_API_KEY,
      id: row.easycron_id,
      url: `${host}/api/scheduler/run?id=${row._id}`,
      cron_expression: row.cron_expression,
      timezone: row.timezone,
    }),
  });
  const data = await res.json().catch(() => ({}));
  console.log(
    `job ${row.easycron_id} (${row.label}):`,
    data.status === "success" ? "updated" : JSON.stringify(data.error)
  );
}

console.log(`\n${rows.length} schedule(s) repointed. Restart the dev server so new schedules use the new URL.`);
