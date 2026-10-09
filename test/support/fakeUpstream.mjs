import http from 'node:http';

/** Agents the backend drives (mirrors src/constants/agents.ts). */
export const AGENTS = {
  BUILDER: '6a881574306498162b09a296',
  PROMPT: '6843d832aab19264b8967f3b',
  UPDATE: '6a98e24a1b30b30277b9f371',
  CRON: '6aa016abb54ce2b5442ddcea',
};

/** Session tokens the fake GTWY server recognises. */
export const TOKENS = { OWNER: 'owner-token', STRANGER: 'stranger-token' };
export const AGENT = { id: 'agent-1', orgId: 'org-1', versions: ['v1', 'v2', 'v3'] };

const sse = (res, events, gapMs = 50) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let i = 0;
  const tick = () => {
    if (i === events.length) return res.end();
    res.write(`data: ${JSON.stringify(events[i++])}\n\n`);
    setTimeout(tick, gapMs);
  };
  tick();
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * One HTTP server standing in for GTWY (API + completion), MSG91, EasyCron and the
 * Telegram / Discord REST APIs. Every request is recorded for assertions.
 */
export function startFakeUpstream() {
  const calls = [];
  const easycronJobs = new Map();
  let nextJobId = 1000;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      let body = {};
      if (req.headers['content-type']?.includes('json')) body = raw ? JSON.parse(raw) : {};
      else if (req.headers['content-type']?.includes('urlencoded')) body = Object.fromEntries(new URLSearchParams(raw));
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      route(req, res, url, body);
    });
  });

  function route(req, res, url, body) {
    const path = url.pathname;

    // ---- GTWY API: agent ownership
    if (path.startsWith('/api/agent/')) {
      const token = req.headers.authorization;
      if (token === TOKENS.OWNER) return json(res, 200, { agent: { _id: AGENT.id, org_id: AGENT.orgId, versions: AGENT.versions } });
      if (token === TOKENS.STRANGER) return json(res, 403, { message: 'forbidden' });
      return json(res, 401, { message: 'invalid token' });
    }

    // ---- GTWY embed login
    if (path === '/api/embed/login') {
      if (!req.headers.authorization) return json(res, 401, { message: 'no jwt' });
      return json(res, 200, { data: { token: 'gtwy-session-token', org_id: AGENT.orgId, folder_id: 'folder-1', user_id: 'gtwy-user-1' } });
    }

    // ---- MSG91 proxy
    if (path === '/api/c/getDetails') {
      if (req.headers.proxy_auth_token !== 'good-proxy-token') return json(res, 401, { message: 'bad proxy token' });
      return json(res, 200, { data: [{ id: 7, name: 'Test User', currentCompany: { id: 99, name: 'Test Co' } }] });
    }

    // ---- GTWY completion
    if (path === '/api/v2/model/chat/completion') {
      if (!req.headers.pauthkey) return json(res, 401, { message: 'no pauthkey' });
      return completion(res, body);
    }

    // ---- EasyCron
    if (path.startsWith('/__ext/www.easycron.com/rest/')) {
      const action = path.split('/').pop();
      if (action === 'add') {
        const id = String(nextJobId++);
        easycronJobs.set(id, { cron_job_id: id, url: body.url, cron_job_name: body.cron_job_name, status: 1 });
        return json(res, 200, { status: 'success', cron_job_id: id });
      }
      if (action === 'list') {
        // One stray job nobody has a row for, so reconcile has an orphan to report.
        const jobs = [...easycronJobs.values(), { cron_job_id: '1', cron_job_name: 'stray', url: 'https://old/run' }];
        return json(res, 200, { status: 'success', cron_jobs: jobs });
      }
      if (!easycronJobs.has(body.id)) return json(res, 200, { status: 'error', error: { message: 'Cron job not found' } });
      if (action === 'delete') easycronJobs.delete(body.id);
      if (action === 'enable' || action === 'disable') easycronJobs.get(body.id).status = action === 'enable' ? 1 : 0;
      return json(res, 200, { status: 'success' });
    }

    // ---- Telegram Bot API
    if (path.startsWith('/__ext/api.telegram.org/')) {
      return json(res, 200, { ok: true, result: { message_id: 42 } });
    }

    // ---- Discord REST
    if (path.startsWith('/__ext/discord.com/')) {
      return json(res, 401, { message: '401: Unauthorized' });
    }

    json(res, 404, { message: `fake upstream: no route for ${path}` });
  }

  function completion(res, body) {
    const content = (value) => ({ response: { data: { content: value } } });

    switch (body.agent_id) {
      case AGENTS.BUILDER:
        return json(res, 200, content(JSON.stringify({ response: 'Here is a draft', draft_config: { name: 'Helper' } })));
      case AGENTS.PROMPT:
        return json(res, 200, content('```json\n{"role":"Support","goal":"Help users","instruction":"Be kind"}\n```'));
      case AGENTS.CRON:
        if (/first monday/i.test(body.user)) {
          return json(res, 200, content('{"answerable":false,"reason":"Cron cannot express the first Monday"}'));
        }
        return json(res, 200, content('{"cronExpression":"0 9 * * 1-5","meaning":"weekdays at 9"}'));
      case AGENTS.UPDATE:
        if (body.user === 'plain') return json(res, 200, content('Renamed the ranger.'));
        if (body.user === 'fail') return json(res, 503, { message: 'completion service is down' });
        return sse(res, [
          { event: 'start' },
          { event: 'delta', content: 'Renaming' },
          { event: 'delta', content: ' done.' },
          { event: 'done' },
        ], 150);
    }

    // A ranger version itself (scheduled runs, Telegram replies)
    if (body.version_id) {
      if (/boom/i.test(body.user)) return sse(res, [{ event: 'error', error: 'model exploded' }]);
      return sse(res, [{ event: 'start' }, { event: 'delta', content: 'Answer for ' }, { event: 'delta', content: body.user }, { event: 'done' }]);
    }
    return json(res, 400, { message: 'unknown agent' });
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        calls,
        easycronJobs,
        /** Calls whose path contains `fragment`, optionally only those after `since`. */
        find: (fragment, since = 0) => calls.slice(since).filter((call) => call.path.includes(fragment)),
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}
