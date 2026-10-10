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
- `npm run migrate:rangers [-- --apply]` – copy rangers and schedules out of GTWY into the new
  collections; a dry run unless `--apply` ([docs/database.md](docs/database.md#migration))
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
- **models/** – typed Mongo collections and their indexes. The schema Rangers is moving to
  (`rangers` + `schedules`) is described in [docs/database.md](docs/database.md).
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
