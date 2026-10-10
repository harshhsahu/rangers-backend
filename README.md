# rangers-backend

Node.js + TypeScript + Express API for Rangers. Holds everything that used to live in the
frontend's Next.js `app/api` routes: internal login, channel details, Telegram/Discord bot
setup and webhooks, the scheduler (EasyCron) and the ranger AI proxies. It also runs the
Discord Gateway clients, so it must be a long-running process (not serverless).

The frontend keeps calling same-origin `/api/*`; `next.config.js` rewrites those calls to
`RANGERS_BACKEND_URL` (default `http://localhost:4000`).

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

## Scripts

- `npm run dev` – start with hot reload (tsx)
- `npm run build` – compile to `dist/`
- `npm start` – run compiled build
- `npm run typecheck` – type-check without emitting
- `node scripts/sync-scheduler-tunnel.mjs [url]` – repoint every EasyCron job at a new dev tunnel

## Testing

```bash
npm test
```

End-to-end API tests (`test/api.test.mjs`, Node's built-in test runner). Each run builds the
app, then boots the real compiled server against:

- an in-memory MongoDB (`mongodb-memory-server`, no local Mongo needed), and
- a fake upstream (`test/support/fakeUpstream.mjs`) standing in for GTWY, the completion
  API, MSG91, EasyCron and the Telegram/Discord REST APIs. A test-only preload
  (`test/support/redirect-fetch.mjs`) reroutes those hardcoded hosts to it.

Nothing outside the machine is called, except that the Discord invalid-token test lets
discord.js reach Discord's real gateway with a fake token.

## Routes (mounted under `/api`)

| Path | Methods |
| --- | --- |
| `/health` | GET |
| `/auth/internal-login` | POST |
| `/channel-details` | GET, POST, PUT, DELETE |
| `/ranger-ai/chat`, `/ranger-ai/prompt`, `/ranger-ai/update` (SSE) | POST |
| `/scheduler` | GET, POST |
| `/scheduler/:id` | GET, PATCH, DELETE |
| `/scheduler/:id/run`, `/scheduler/lifecycle`, `/scheduler/cron-ai` | POST |
| `/scheduler/run` (EasyCron target) | GET, POST |
| `/scheduler/reconcile` (admin key) | GET |
| `/telegram/setup`, `/discord/setup` | POST, DELETE |
| `/telegram/webhook`, `/discord/webhook` | GET, POST |

## Agents

The four AI helpers behind `/ranger-ai/*` and `/scheduler/cron-ai` are not GTWY agents. Each is a
document in this service's own `agents` collection, looked up by `slug`. On every call its
model, prompt and tools are sent to GTWY's direct completion API
(`POST {GTWY_PYTHON_GTWY_SERVER_URL}/api/v2/model/ai/completion`), so nothing has to exist on GTWY.

Documents are written by hand. They are read on every call, so an edit applies to the next request.

| `slug` | Used by | Gets these variables | Must answer with |
| --- | --- | --- | --- |
| `ranger_builder` | `/ranger-ai/chat` | none | JSON `{ response, draft_config }`, so give it a `json_schema` `response_type` |
| `ranger_prompt` | `/ranger-ai/prompt` | `fields`, `query` | JSON `{ role, goal, instruction }` (plain text also works) |
| `ranger_update` | `/ranger-ai/update` (SSE) | `pre_function` (the ranger version's config as JSON, read from GTWY's `/api/versions/:id`), `auth_token`, `agent_id`, `version_id`, `frontend_url`, `channels_available`, `server_url`, `scheduler_available`, `org_timezone`, `available_knowledge_bases`, `model_type` | Text. The editor refreshes its panels by tool name, so keep the tool names it knows (`update_agent_info`, `manageRangerChannel`, `manageRangerResourcesmcpkb`, `manageRangerVersion`, `manageRangerVersion_2`, `manageRangerSchedule`, `lookup_model_details`). |
| `cron_assistant` | `/scheduler/cron-ai` | none | JSON `{ cronExpression, meaning, answerable, reason }` |

```js
{
  slug: 'cron_assistant',
  name: 'Cron assistant',                    // optional, for people reading the collection
  service: 'openai',                         // a service GTWY's /api/service lists
  configuration: {
    type: 'chat',                            // the model's type in GTWY's catalog: chat | reasoning
    model: 'gpt-4o-mini',
    prompt: 'You turn schedules into cron…', // or { role, goal, instruction }; may use {{variable}}
    response_type: { type: 'json_schema', json_schema: { name: 'cron', strict: true, schema: { /* … */ } } },
    temperature: 0                           // any other model parameter; left out = model default
  },
  settings: {}                               // optional GTWY settings, e.g. maximum_iterations (tool rounds, default 3)
}
```

`ranger_update` also carries `tools`, sent to GTWY as `extra_tools`. For example:

```js
tools: [
  {
    name: 'manageRangerSchedule',
    description: 'Create a schedule for this ranger',
    url: '{{frontend_url}}/api/scheduler',                // {{variable}} is filled by this service
    method: 'POST',
    headers: { Authorization: '{{auth_token}}' },         // so the tool acts as the signed-in user
    fields: { message: { type: 'string', description: 'What the ranger should do' } /* … */ },
    required: ['message'],
    tool_and_variable_path: { agent_id: 'agent_id', version_id: 'version_id' } // filled by GTWY, hidden from the model
  }
]
```

Things GTWY does not tell you when you get them wrong:

- **Variables.** `{{name}}` in the prompt is replaced from the call's variables. A variable the prompt
  uses but the call does not send is left in as literal text, with no error. An Anthropic prompt
  must not start with `{{`, or GTWY skips the substitution entirely.
- **`response_type`.** It is always an object. OpenAI's `json_schema` needs `json_schema.name`;
  Gemini needs the `json_schema.schema` wrapper; Anthropic only takes `json_schema`. Leave it
  out for plain text.
- **Tools.** GTWY sends a tool's `url` and `headers` verbatim. This service fills `{{variable}}` in
  them before the call. Arguments named in `tool_and_variable_path` are filled by GTWY from the
  variables, and are hidden from the model.

**Checks.** At startup each agent's document is validated and its `service`/`type`/`model` is
checked against GTWY's model catalog (`GET {GTWY_SERVER_URL}/api/service/:service`). Problems are
logged as `[agents]` / `[gtwy-models]` lines.

- **Missing or invalid document:** that agent's route answers 503 "This assistant is not set up yet.",
  and the log line says what is wrong.
- **Model GTWY doesn't list:** the route answers 503 naming the model.
- **Catalog can't be read:** calls go ahead, and GTWY still rejects an unknown model itself.

**Billing.** No API key is sent, so GTWY runs these calls on its platform key and bills the org's
wallet. It's free when the org is GTWY's platform org. All of them appear in GTWY under one hidden
"Direct API Calls" agent. GTWY allows 100 direct calls a minute per org and 20 per thread; past that
the routes answer 429.

## Architecture

Requests flow through one layer at a time; each layer only talks to the one below it.

```
route  →  validate()  →  controller  →  service  →  model / lib
wiring    Joi schema     HTTP in/out    business     data access and
only      (400 on fail)                 logic        integrations
```

- **routes/** – path + method → `validate(schema)` → controller (plus route-level guards). No logic.
- **controllers/** – read the already-validated input, call one service, shape the response.
  No validation, no Mongo, no `fetch`, no business rules.
- **services/** – business logic. Framework-free (no `req`/`res`); throw `AppError` for
  anything the caller should see.
- **models/** – typed Mongo collections and their indexes.
- **lib/** – integrations and domain helpers carried over from the Next app (EasyCron,
  Telegram, Discord Gateway, GTWY streaming, crypto, cron parsing).
- **middlewares/** – session token resolution, header-secret guards, the error handler.
- **validators/** – Joi schemas for every body/query/params, plus the TypeScript type of each
  validated shape. `middlewares/validate` runs them before the controller: values are trimmed,
  defaulted and stripped of undeclared keys, and the first failure is answered 400.
- **config/** – Joi-validated environment (`env.ts`, fails fast on bad values) and the Mongo connection.
- **jobs/** – long-running background work (Discord bots, started at boot).

### Errors

Services throw `AppError(status, message)`; the central error handler answers
`{ success: false, error }`. Any other error is logged and returned as a generic 500, so
internals never reach the client. Webhook routes (Telegram, Discord relay) always answer
200 so the sender does not retry.

### Auth

`middlewares/sessionToken` resolves the caller's GTWY session from `Authorization` (or the
`local_token` cookie on same-origin requests) onto `req.sessionToken`.
`services/agentAccess.service` verifies it against GTWY and checks agent/version ownership.
