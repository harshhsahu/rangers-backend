import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ObjectId } from 'mongodb';
import { AGENT, TOKENS } from './support/fakeUpstream.mjs';
import { eventually, startStack } from './support/harness.mjs';

let stack;
before(async () => {
  stack = await startStack();
});
after(async () => {
  await stack?.stop();
});

/** Calls the API; returns { status, body, headers }. */
async function api(method, path, { body, token, headers = {} } = {}) {
  const res = await fetch(`${stack.baseUrl}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: token } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* SSE or plain text */
  }
  return { status: res.status, body: parsed, headers: res.headers, text };
}

const owner = { token: TOKENS.OWNER };
/** What every stored (encrypted) bot token looks like in an API response. */
const MASKED = '•••••••• (encrypted)';
const channels = () => stack.db.collection('channeldetails');
const schedules = () => stack.db.collection('rangerschedules');

/* ------------------------------------------------------------------ platform */

describe('platform', () => {
  it('GET /health reports ok', async () => {
    const res = await api('GET', '/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.status, 'ok');
  });

  it('unknown routes answer 404 in the standard error shape', async () => {
    const res = await api('GET', '/does-not-exist');
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { success: false, error: 'Route not found: GET /api/does-not-exist' });
  });

  it('malformed JSON is a 400, not a 500', async () => {
    const res = await api('POST', '/ranger-ai/chat', { body: '{not json' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Request body is not valid JSON');
  });

  it('oversized bodies are rejected with 413', async () => {
    const res = await api('POST', '/ranger-ai/chat', { body: { message: 'x'.repeat(6 * 1024 * 1024), thread_id: 't' } });
    assert.equal(res.status, 413);
    assert.equal(res.body.error, 'Request body is too large');
  });

  it('sets security headers and CORS', async () => {
    const res = await api('GET', '/health', { headers: { origin: 'https://elsewhere.test' } });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('x-powered-by'), null);
  });
});

/* ---------------------------------------------------------------------- auth */

describe('POST /auth/internal-login', () => {
  it('requires a proxy token', async () => {
    const res = await api('POST', '/auth/internal-login', { body: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'proxy_auth_token is required');
  });

  it('exchanges a valid proxy token for a GTWY session', async () => {
    const since = stack.upstream.calls.length;
    const res = await api('POST', '/auth/internal-login', { body: { proxy_auth_token: 'good-proxy-token' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.token, 'gtwy-session-token');
    assert.equal(res.body.data.user_org_id, '99');
    assert.equal(res.body.data.company_name, 'Test Co');

    // The embed JWT sent to GTWY is signed with ACCESS_KEY and carries the user's org.
    const [login] = stack.upstream.find('/api/embed/login', since);
    const payload = JSON.parse(Buffer.from(login.headers.authorization.split('.')[1], 'base64url').toString());
    assert.deepEqual(payload.org_id, 'jwt-org');
    assert.deepEqual(payload.user_id, '99');
  });

  it('accepts the camelCase alias', async () => {
    const res = await api('POST', '/auth/internal-login', { body: { proxyAuthToken: 'good-proxy-token' } });
    assert.equal(res.status, 200);
  });

  it('surfaces an upstream rejection', async () => {
    const res = await api('POST', '/auth/internal-login', { body: { proxy_auth_token: 'bad' } });
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'bad proxy token');
  });
});

describe('agent access (shared by every protected route)', () => {
  const list = (opts) => api('GET', `/scheduler?version_id=v1&agent_id=${AGENT.id}`, opts);

  it('no token → 401', async () => {
    assert.equal((await list()).status, 401);
  });

  it('invalid token → 401', async () => {
    const res = await list({ token: 'garbage' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Invalid or expired session token');
  });

  it("someone else's agent → 403", async () => {
    const res = await list({ token: TOKENS.STRANGER });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'You do not have access to this agent');
  });

  it('version of a different agent → 403', async () => {
    const res = await api('GET', `/scheduler?version_id=not-mine&agent_id=${AGENT.id}`, owner);
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'version_id does not belong to this agent');
  });

  it('Bearer prefix is accepted', async () => {
    assert.equal((await list({ token: `Bearer ${TOKENS.OWNER}` })).status, 200);
  });

  it('cookie works for same-origin requests only', async () => {
    const cookie = `local_token=${TOKENS.OWNER}`;
    assert.equal((await list({ headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status, 200);
    assert.equal((await list({ headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status, 401);
    // No fetch metadata: Origin must match the browser-facing host (x-forwarded-host behind the proxy).
    assert.equal(
      (await list({ headers: { cookie, origin: 'https://app.rangers.test', 'x-forwarded-host': 'app.rangers.test' } })).status,
      200
    );
    assert.equal((await list({ headers: { cookie, origin: 'https://evil.test' } })).status, 401);
    assert.equal((await list({ headers: { cookie } })).status, 401);
  });
});

/* ------------------------------------------------------------- channel details */

describe('/channel-details', () => {
  it('validates input', async () => {
    assert.equal((await api('POST', '/channel-details', { body: { version_id: 'cd1' } })).body.error, 'telegram.botToken is required');
    assert.equal((await api('POST', '/channel-details', { body: { telegram: { botToken: 'x' } } })).body.error, 'version_id is required');
    assert.equal((await api('PUT', '/channel-details', { body: {} })).body.error, 'id or version_id is required');
    assert.equal((await api('DELETE', '/channel-details')).body.error, 'id or version_id is required');
    assert.equal((await api('GET', '/channel-details?id=not-an-id')).body.error, 'Invalid id');
  });

  it('creates, reads, updates and deletes, never exposing the token', async () => {
    const created = await api('POST', '/channel-details', {
      body: { version_id: 'cd1', agent_id: AGENT.id, telegram: { botToken: '111:secret-token-value' } },
    });
    assert.equal(created.status, 200);
    // Masked — neither the plaintext nor the encrypted blob is returned.
    assert.equal(created.body.data.telegram.botToken, MASKED);

    // Encrypted at rest.
    const stored = await channels().findOne({ version_id: 'cd1' });
    assert.ok(stored.telegram.botToken);
    assert.ok(!stored.telegram.botToken.includes('secret-token-value'));
    assert.equal(stored.org_id, 'jwt-org'); // falls back to ORG_ID

    const byVersion = await api('GET', '/channel-details?version_id=cd1');
    assert.equal(byVersion.body.data.version_id, 'cd1');
    assert.equal(byVersion.body.data.telegram.botToken, MASKED);
    const byId = await api('GET', `/channel-details?id=${stored._id}`);
    assert.equal(byId.body.data.version_id, 'cd1');
    const all = await api('GET', '/channel-details');
    assert.ok(all.body.data.some((doc) => doc.version_id === 'cd1'));
    assert.ok(all.body.data.every((doc) => !doc.telegram?.botToken || doc.telegram.botToken === MASKED));

    const updated = await api('PUT', '/channel-details', {
      body: { version_id: 'cd1', agent_id: 'agent-2', telegram: { botToken: '222:new', botId: 'legacy' } },
    });
    assert.equal(updated.body.data.agent_id, 'agent-2');
    assert.equal(updated.body.data.telegram.botToken, MASKED);
    const afterUpdate = await channels().findOne({ version_id: 'cd1' });
    assert.equal(afterUpdate.telegram.botId, undefined);
    assert.ok(!afterUpdate.telegram.botToken.includes('222:new'));

    assert.equal((await api('PUT', '/channel-details', { body: { version_id: 'missing' } })).status, 404);

    const deleted = await api('DELETE', '/channel-details?version_id=cd1');
    assert.deepEqual(deleted.body, { success: true, deleted: 1 });
    assert.equal(await channels().countDocuments({ version_id: 'cd1' }), 0);
  });
});

/* ------------------------------------------------------------------ ranger AI */

describe('/ranger-ai', () => {
  it('chat returns the structured draft', async () => {
    assert.equal((await api('POST', '/ranger-ai/chat', { body: { thread_id: 't' } })).body.error, 'message is required');
    assert.equal((await api('POST', '/ranger-ai/chat', { body: { message: '  ', thread_id: 't' } })).body.error, 'message is required');

    const since = stack.upstream.calls.length;
    const res = await api('POST', '/ranger-ai/chat', { body: { message: ' build me a helper ', thread_id: 'th-1' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { success: true, response: 'Here is a draft', draft_config: { name: 'Helper' }, thread_id: 'th-1' });

    const [call] = stack.upstream.find('/chat/completion', since);
    assert.equal(call.headers.pauthkey, 'test-pauthkey');
    assert.equal(call.body.user, 'build me a helper'); // trimmed by validation
  });

  it('prompt unwraps a fenced JSON draft', async () => {
    assert.equal((await api('POST', '/ranger-ai/prompt', { body: {} })).body.error, 'Describe what the ranger does');
    const res = await api('POST', '/ranger-ai/prompt', { body: { name: 'Sam', description: 'answers support tickets' } });
    assert.deepEqual(res.body, { success: true, prompt: { role: 'Support', goal: 'Help users', instruction: 'Be kind' } });
  });

  it('update requires access and streams SSE incrementally', async () => {
    const body = { message: 'rename it', thread_id: 't', agent_id: AGENT.id, version_id: 'v1' };
    assert.equal((await api('POST', '/ranger-ai/update', { body })).status, 401);

    const since = stack.upstream.calls.length;
    const res = await fetch(`${stack.baseUrl}/api/ranger-ai/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: TOKENS.OWNER },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);

    const arrivals = [];
    let text = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      arrivals.push(Date.now());
      text += decoder.decode(chunk);
    }
    assert.match(text, /"content":"Renaming"/);
    assert.match(text, /"event":"done"/);
    // Events were spaced 150ms apart upstream; they must not arrive in one buffered burst.
    assert.ok(arrivals.at(-1) - arrivals[0] >= 300, `stream was buffered (${arrivals.length} chunks)`);

    // The caller's session is forwarded as a variable; our pauthkey never leaves the server.
    const [call] = stack.upstream.find('/chat/completion', since);
    assert.equal(call.body.variables.auth_token, TOKENS.OWNER);
    assert.equal(call.body.variables.frontend_url, 'https://api.rangers.test');
    assert.equal(call.body.variables.org_timezone, 'UTC');
    assert.equal(call.body.variables.available_knowledge_bases, '[]');
  });

  it('update normalises a non-streamed answer into SSE', async () => {
    const res = await api('POST', '/ranger-ai/update', {
      ...owner,
      body: { message: 'plain', thread_id: 't', agent_id: AGENT.id, version_id: 'v1' },
    });
    assert.equal(res.status, 200);
    assert.equal(
      res.text,
      'data: {"event":"start"}\n\ndata: {"event":"delta","content":"Renamed the ranger."}\n\ndata: {"event":"done"}\n\n'
    );
  });

  it('update passes an upstream failure through with its status', async () => {
    const res = await api('POST', '/ranger-ai/update', {
      ...owner,
      body: { message: 'fail', thread_id: 't', agent_id: AGENT.id, version_id: 'v1' },
    });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'completion service is down');
  });
});

/* ------------------------------------------------------------------ scheduler */

describe('/scheduler', () => {
  const base = { agent_id: AGENT.id, version_id: 'v1' };
  let scheduleId;
  let jobId;

  it('validates input before touching anything', async () => {
    assert.equal((await api('GET', '/scheduler')).body.error, 'version_id is required');
    assert.equal((await api('POST', '/scheduler', { ...owner, body: { agent_id: AGENT.id } })).body.error, 'version_id is required');
    const noMessage = await api('POST', '/scheduler', { ...owner, body: { ...base, frequency: 'daily', time: '09:00' } });
    assert.equal(noMessage.status, 400);
    assert.match(noMessage.body.error, /message is required/);
    const badTime = await api('POST', '/scheduler', { ...owner, body: { ...base, message: 'x', frequency: 'daily', time: '25:00' } });
    assert.equal(badTime.status, 400);
    assert.match(badTime.body.error, /Invalid time/);
    assert.equal(await schedules().countDocuments(), 0);
  });

  it('creates a schedule and its EasyCron job', async () => {
    const res = await api('POST', '/scheduler', {
      ...owner,
      body: { ...base, message: 'Send the daily report', frequency: 'daily', time: '09:30', timezone: 'Asia/Kolkata' },
    });
    assert.equal(res.status, 201);
    const { schedule } = res.body;
    scheduleId = schedule._id;
    jobId = schedule.easycron_id;

    assert.equal(schedule.cron_expression, '30 9 * * *');
    assert.equal(schedule.enabled, true);
    assert.equal(schedule.org_id, AGENT.orgId); // from the verified agent, not the body
    assert.equal(schedule.next_runs.length, 3);

    const job = stack.upstream.easycronJobs.get(jobId);
    assert.equal(job.url, `https://api.rangers.test/api/scheduler/run?id=${scheduleId}`);
    const [add] = stack.upstream.find('/rest/add');
    assert.equal(add.body.token, 'test-easycron-key');
    assert.equal(add.body.timezone, 'Asia/Kolkata');
  });

  it('lists and reads schedules', async () => {
    const list = await api('GET', `/scheduler?version_id=v1&agent_id=${AGENT.id}`, owner);
    assert.equal(list.body.scheduler_available, true);
    assert.equal(list.body.schedules.length, 1);

    const one = await api('GET', `/scheduler/${scheduleId}`, owner);
    assert.equal(one.body.schedule._id, scheduleId);
    assert.equal((await api('GET', `/scheduler/${scheduleId}`, { token: TOKENS.STRANGER })).status, 403);
    assert.equal((await api('GET', `/scheduler/${new ObjectId()}`, owner)).status, 404);
    assert.equal((await api('GET', '/scheduler/not-an-id', owner)).status, 404);
  });

  it('retimes and pauses through EasyCron', async () => {
    const retimed = await api('PATCH', `/scheduler/${scheduleId}`, { ...owner, body: { time: '18:00' } });
    assert.equal(retimed.status, 200);
    assert.equal(retimed.body.schedule.cron_expression, '0 18 * * *');
    assert.equal(stack.upstream.find('/rest/edit').at(-1).body.cron_expression, '0 18 * * *');

    const ambiguous = await api('PATCH', `/scheduler/${scheduleId}`, { ...owner, body: { weekday: 2 } });
    assert.equal(ambiguous.status, 400);
    assert.match(ambiguous.body.error, /unambiguous/);

    const paused = await api('PATCH', `/scheduler/${scheduleId}`, { ...owner, body: { enabled: false } });
    assert.equal(paused.body.schedule.enabled, false);
    assert.equal(stack.upstream.easycronJobs.get(jobId).status, 0);
  });

  it('the EasyCron URL skips a paused schedule and runs an enabled one', async () => {
    const skipped = await api('GET', `/scheduler/run?id=${scheduleId}`);
    assert.deepEqual([skipped.status, skipped.body], [200, { success: true, skipped: 'disabled' }]);
    assert.equal((await api('GET', `/scheduler/run?id=${new ObjectId()}`)).status, 404);
    assert.equal((await api('GET', '/scheduler/run')).status, 404);

    await api('PATCH', `/scheduler/${scheduleId}`, { ...owner, body: { enabled: true } });
    assert.equal(stack.upstream.easycronJobs.get(jobId).status, 1);

    const accepted = await api('POST', `/scheduler/run?id=${scheduleId}`); // EasyCron may POST
    assert.equal(accepted.status, 202);

    const row = await eventually(async () => {
      const doc = await schedules().findOne({ _id: new ObjectId(scheduleId) });
      return doc.run_count === 1 && doc;
    });
    assert.equal(row.last_run.ok, true);
    assert.equal(row.last_run.preview, 'Answer for Send the daily report');
  });

  it('"run now" works while paused and delivers to Telegram', async () => {
    await api('PATCH', `/scheduler/${scheduleId}`, {
      ...owner,
      body: { enabled: false, delivery: { type: 'telegram', chat_id: 555 } },
    });
    await api('POST', '/channel-details', { body: { version_id: 'v1', telegram: { botToken: '999:delivery-bot' } } });

    const since = stack.upstream.calls.length;
    const res = await api('POST', `/scheduler/${scheduleId}/run`, owner);
    assert.equal(res.status, 202);

    const sent = await eventually(() => stack.upstream.find('/bot999:delivery-bot/sendMessage', since)[0]);
    assert.equal(sent.body.chat_id, 555);
    assert.match(sent.body.text, /Answer for Send the daily report/);
    await eventually(async () => (await schedules().findOne({ _id: new ObjectId(scheduleId) })).run_count === 2);
  });

  it('records a failed run', async () => {
    await api('PATCH', `/scheduler/${scheduleId}`, { ...owner, body: { message: 'boom please', delivery: null } });
    await api('POST', `/scheduler/${scheduleId}/run`, owner);
    const row = await eventually(async () => {
      const doc = await schedules().findOne({ _id: new ObjectId(scheduleId) });
      return doc.run_count === 3 && doc;
    });
    assert.equal(row.last_run.ok, false);
    assert.equal(row.fail_streak, 1);
    assert.ok(row.last_run.error);
  });

  it('enforces the per-ranger cap', async () => {
    const make = () =>
      api('POST', '/scheduler', { ...owner, body: { ...base, message: 'more', frequency: 'hourly', minute: 5 } });
    assert.equal((await make()).status, 201);
    assert.equal((await make()).status, 201);
    const capped = await make();
    assert.equal(capped.status, 400);
    assert.match(capped.body.error, /already has 3 schedules \(limit 3\)/);
  });

  it('reconcile is hidden without the admin key and reports drift with it', async () => {
    assert.equal((await api('GET', '/scheduler/reconcile')).status, 404);
    assert.equal((await api('GET', '/scheduler/reconcile', { headers: { 'x-scheduler-admin-key': 'nope' } })).status, 404);

    await schedules().insertOne({ agent_id: AGENT.id, version_id: 'v2', label: 'half-created', enabled: false, easycron_id: null });
    const res = await api('GET', '/scheduler/reconcile', { headers: { 'x-scheduler-admin-key': 'test-admin-key' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.orphan_jobs.map((job) => job.cron_job_id), ['1']);
    assert.deepEqual(res.body.pending_rows.map((row) => row.label), ['half-created']);
    assert.equal(res.body.dead_rows.length, 0);
  });

  it('lifecycle pauses, resumes and deletes every schedule of the ranger', async () => {
    assert.equal(
      (await api('POST', '/scheduler/lifecycle', { ...owner, body: { agent_id: AGENT.id, action: 'stop' } })).body.error,
      'action must be pause, resume or delete'
    );

    await api('POST', '/scheduler/lifecycle', { ...owner, body: { agent_id: AGENT.id, action: 'pause' } });
    assert.equal(await schedules().countDocuments({ agent_id: AGENT.id, enabled: true }), 0);

    await api('POST', '/scheduler/lifecycle', { ...owner, body: { agent_id: AGENT.id, action: 'resume' } });
    assert.ok((await schedules().countDocuments({ agent_id: AGENT.id, enabled: true })) >= 3);

    const deleted = await api('POST', '/scheduler/lifecycle', { ...owner, body: { agent_id: AGENT.id, action: 'delete' } });
    assert.equal(deleted.status, 200);
    assert.equal(await schedules().countDocuments({ agent_id: AGENT.id, easycron_id: { $ne: null } }), 0);
    assert.equal([...stack.upstream.easycronJobs.keys()].length, 0);
  });

  it('deleting one schedule removes the job first', async () => {
    const { body } = await api('POST', '/scheduler', { ...owner, body: { ...base, message: 'x', frequency: 'weekly', weekday: 1, time: '08:00' } });
    const id = body.schedule._id;
    const res = await api('DELETE', `/scheduler/${id}`, owner);
    assert.deepEqual(res.body, { success: true, deleted: id });
    assert.equal(stack.upstream.easycronJobs.has(body.schedule.easycron_id), false);
    assert.equal(await schedules().countDocuments({ _id: new ObjectId(id) }), 0);
  });

  it('cron-ai turns a cadence into a validated expression', async () => {
    assert.equal((await api('POST', '/scheduler/cron-ai', { body: {} })).body.error, 'Describe when it should run');
    const res = await api('POST', '/scheduler/cron-ai', { ...owner, body: { ...base, text: 'every weekday at 9', timezone: '' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.cron_expression, '0 9 * * 1-5');
    assert.equal(res.body.description, 'every weekday at 09:00 UTC');

    const impossible = await api('POST', '/scheduler/cron-ai', { ...owner, body: { ...base, text: 'first monday of the month' } });
    assert.equal(impossible.status, 422);
    assert.equal(impossible.body.error, 'Cron cannot express the first Monday');
  });
});

/* ------------------------------------------------------------------- telegram */

describe('/telegram', () => {
  const versionId = 'v2';
  const botToken = '123456:telegram-secret';

  it('validates the token format', async () => {
    const res = await api('POST', '/telegram/setup', { ...owner, body: { botToken: 'no-colon', version_id: versionId } });
    assert.equal(res.body.error, 'Invalid bot token format. Expected 123456:ABC...');
  });

  it('connects a bot: encrypted token, webhook and commands registered', async () => {
    const since = stack.upstream.calls.length;
    const res = await api('POST', '/telegram/setup', {
      ...owner,
      body: { botToken, version_id: versionId, agent_id: AGENT.id, commands: 'not-a-list' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.webhook.registered, true);
    assert.equal(res.body.webhook.url, `https://hooks.rangers.test/api/telegram/webhook?version_id=${versionId}`);
    assert.equal(res.body.commands.registered, true);
    assert.equal(res.body.data.telegram.botToken, MASKED);

    const [setWebhook] = stack.upstream.find(`/bot${botToken}/setWebhook`, since);
    assert.equal(setWebhook.body.url, res.body.webhook.url);
    const [setCommands] = stack.upstream.find(`/bot${botToken}/setMyCommands`, since);
    assert.deepEqual(setCommands.body.commands, [{ command: 'new_thread', description: 'Start a new thread' }]);

    const stored = await channels().findOne({ version_id: versionId });
    assert.equal(stored.telegram.webhookSet, true);
    assert.equal(stored.org_id, AGENT.orgId);
    assert.ok(!stored.telegram.botToken.includes('telegram-secret'));
  });

  it('webhook acks immediately and replies through Telegram', async () => {
    const since = stack.upstream.calls.length;
    const update = { update_id: 1001, message: { message_id: 1, chat: { id: 777 }, from: { username: 'nat' }, text: 'hello bot' } };
    const res = await api('POST', `/telegram/webhook?version_id=${versionId}`, { body: update });
    assert.deepEqual(res.body, { ok: true, accepted: true });

    const reply = await eventually(() =>
      stack.upstream
        .find(`/bot${botToken}/`, since)
        .find((call) => /send/.test(call.path) && /Answer for hello bot/.test(call.body.text || ''))
    );
    assert.equal(reply.body.chat_id, 777);

    const stored = await channels().findOne({ version_id: versionId });
    assert.equal(stored.telegram.chatUser.chat_id, 777);
    assert.equal(stored.telegram.lastUpdateId, 1001);
  });

  it('webhook drops a retried update', async () => {
    const update = { update_id: 1001, message: { chat: { id: 777 }, text: 'hello again' } };
    const res = await api('POST', `/telegram/webhook?version_id=${versionId}`, { body: update });
    assert.deepEqual(res.body, { ok: true, duplicate: true });
  });

  it('webhook always answers 200', async () => {
    assert.deepEqual((await api('POST', '/telegram/webhook', { body: { message: { chat: { id: 1 } } } })).body, {
      ok: true,
      error: 'missing_version_id',
    });
    assert.deepEqual((await api('POST', '/telegram/webhook?version_id=nope', { body: { message: { chat: { id: 1 } } } })).body, {
      ok: true,
      error: 'channel_not_found',
    });
    assert.deepEqual((await api('POST', '/telegram/webhook?version_id=x', { body: {} })).body, { ok: true, skipped: true });
    assert.equal((await api('GET', '/telegram/webhook')).body.ok, true);
  });

  it('disconnect clears Telegram and keeps other channels', async () => {
    await channels().updateOne({ version_id: versionId }, { $set: { discord: { botToken: 'enc' } } });
    const since = stack.upstream.calls.length;

    assert.equal((await api('DELETE', `/telegram/setup?version_id=${versionId}`, { token: TOKENS.STRANGER })).status, 403);
    const res = await api('DELETE', `/telegram/setup?version_id=${versionId}`, owner);
    assert.deepEqual(res.body, { success: true, deleted: 0, unset: 'telegram' });
    assert.equal(stack.upstream.find(`/bot${botToken}/deleteWebhook`, since).length, 1);
    assert.equal(stack.upstream.find(`/bot${botToken}/deleteMyCommands`, since).length, 1);

    const stored = await channels().findOne({ version_id: versionId });
    assert.equal(stored.telegram, undefined);
    assert.ok(stored.discord);
  });

  it('disconnect of an unknown version is a 404 after auth', async () => {
    const res = await api('DELETE', `/telegram/setup?version_id=v3&agent_id=${AGENT.id}`, owner);
    assert.equal(res.status, 404);
  });
});

/* -------------------------------------------------------------------- discord */

describe('/discord', () => {
  it('validates the token before connecting', async () => {
    assert.equal((await api('POST', '/discord/setup', { ...owner, body: { version_id: 'v3' } })).body.error, 'botToken is required');
    const short = await api('POST', '/discord/setup', { ...owner, body: { botToken: 'short', version_id: 'v3', agent_id: AGENT.id } });
    assert.equal(short.status, 400);
    assert.match(short.body.error, /Invalid Discord bot token/);
  });

  it('rejects a token Discord does not accept and stores nothing', async () => {
    const fakeToken = 'MTAx.' + 'a'.repeat(60);
    const res = await api('POST', '/discord/setup', { ...owner, body: { botToken: fakeToken, version_id: 'v3', agent_id: AGENT.id } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Invalid Discord bot token|Could not connect to Discord/);
    assert.equal(await channels().countDocuments({ version_id: 'v3' }), 0);
  });

  it('disconnect removes discord and drops an empty document', async () => {
    // v2 still has the discord stub from the Telegram tests.
    const res = await api('DELETE', `/discord/setup?version_id=v2&agent_id=${AGENT.id}`, owner);
    assert.deepEqual(res.body, { success: true, deleted: 1 });
    assert.equal(await channels().countDocuments({ version_id: 'v2' }), 0);
  });

  it('relay webhook requires the internal secret', async () => {
    assert.equal((await api('POST', '/discord/webhook?version_id=v1', { body: {} })).status, 401);
    const res = await api('POST', '/discord/webhook?version_id=v1', {
      body: { message: null },
      headers: { 'x-discord-internal-secret': 'test-discord-secret' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal((await api('GET', '/discord/webhook')).body.ok, true);
  });
});

/* --------------------------------------------------------------- server health */

describe('server log', () => {
  it('never logs a plaintext bot token or crashes on an unhandled rejection', () => {
    const output = stack.logs.join('');
    assert.ok(!output.includes('telegram-secret'), 'bot token leaked into logs');
    assert.ok(!output.includes('unhandled rejection'), 'unhandled rejection logged');
  });
});
