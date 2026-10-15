# Database

Rangers keeps its data in two MongoDB collections, `rangers` and `schedules`. Each ranger's
configuration is sent to GTWY's direct completion API on every run, so no agent has to exist on
GTWY. The typed models are `src/models/ranger.model.ts` and `src/models/schedule.model.ts`.

> **Status:** the models exist but nothing uses them yet. Today's code still runs on GTWY agents
> and the `channeldetails` / `rangerschedules` collections. Moving the data and switching the
> services over is a later change; see [Migration](#migration).

Rules that hold everywhere:

- **Tenant:** every document carries `org_id`, the MSG91 company id. Every query made for a user
  filters on it.
- **One config per ranger:** there are no versions. Editing a ranger changes `config` in place.
- **Not stored here:**
  - history, analytics and usage, which stay in GTWY
  - knowledge-base content, which stays in GTWY's RAG (only the resource ids are kept here)
  - provider API keys (calls run on GTWY's platform key)
- **The four helper agents** (ranger builder, prompt drafter, update chat, cron assistant) are not
  stored here. They are GTWY agents called by bridge id (`src/constants/agents.ts`).

## `rangers`

One document per ranger.

| Field | Type | Notes | Today in GTWY |
| --- | --- | --- | --- |
| `_id` | ObjectId | The ranger id everything else points to. | agent `_id` + version `_id` |
| `org_id` | string | Tenant: MSG91 company id. | agent `user_id` |
| `created_by` | string? | MSG91 user id. | not recorded |
| `name` | string | | agent `name` |
| `description` | string? | What the ranger is for. | agent `meta.ranger.description` |
| `role` | string? | | agent `meta.ranger.role` |
| `color` | string? | Roster card colour. | agent `meta.ranger.color` |
| `status` | `'active' \| 'paused' \| 'archived'` | Paused rangers don't answer; archived ones leave the roster. | agent `bridge_status`, `status` |
| `deleted_at` | Date \| null | Set when moved to the trash; restore sets it back to null. | agent `deletedAt` |
| `config` | object | Everything needed to call the model; see below. | version |
| `channels.telegram` | object? | See below. | `channeldetails.telegram` |
| `channels.discord` | object? | See below. | `channeldetails.discord` |
| `legacy` | `{ agent_id, version_id }`? | The GTWY agent this ranger came from; finds rangers whose Telegram webhook still carries `?version_id=`. | — |
| `created_at`, `updated_at` | Date | | agent `createdAt`, `updatedAt` |

### `config`

| Field | Type | Notes | Today in the GTWY version |
| --- | --- | --- | --- |
| `service` | string | A GTWY service, e.g. `openai`. | `service` |
| `model` | string | | `configuration.model` |
| `type` | `'chat' \| 'reasoning'` | The model's type in GTWY's catalog. | `configuration.type` |
| `prompt` | string \| `{ role, goal, instruction }` | May use `{{variable}}`. | `configuration.prompt` |
| `params` | object | Model parameters the user changed (`temperature`, `max_tokens`…). Anything absent is the model's default. | other `configuration.*` keys |
| `response_type` | object? | Output format, e.g. `{ type: 'json_schema', json_schema }`. Absent means plain text. | `configuration.response_type` |
| `tone` | `{ value, prompt }`? | Preset label and the text it adds to the prompt. | `settings.tone` |
| `fallback` | `{ service, model }`? | Model to retry with. | `settings.fall_back` |
| `variables` | `{ [name]: { default_value?, required? } }`? | Prompt variables. | `agent_info.variables_state` |
| `tools` | array | Connectors (viaSocket flows): `{ script_id, name, description?, fields?, required?, variable_paths? }`. Run at `https://flow.sokt.io/func/<script_id>`. | `function_ids` + GTWY `/api/tools` + `variables_path` |
| `mcp_servers` | `{ name, url }[]` | | `configuration.mcp_config.servers` |
| `knowledge_bases` | `{ resource_id, collection_id, name?, description? }[]` | GTWY RAG resources. | `doc_ids` |
| `starter_questions` | string[]? | | `starterQuestion` |

Not carried over, because the ranger UI doesn't use them: the version machinery (`versions`,
`published_version_id`, `is_drafted`), fine-tune model and auto model select. A model
parameter that comes back goes into `params`.

### `channels`

| Field | Type | Notes | Today in `channeldetails` |
| --- | --- | --- | --- |
| `telegram.bot_token` | string | Always encrypted, `enc:v1:…` (`src/lib/crypto.js`). | `telegram.botToken` |
| `telegram.webhook_set` | boolean | Whether Telegram accepted the webhook. | `telegram.webhookSet` |
| `telegram.last_update_id` | number? | Last update handled, so a retried webhook is dropped. | `telegram.lastUpdateId` |
| `telegram.last_chat` | `{ chat_id, username?, first_name?, at }`? | Who last wrote to the bot; the chat a schedule can deliver to. | `telegram.chatUser` |
| `telegram.chat_threads` | `{ [chat_id]: thread_id }`? | Only chats that ran `/new_thread`; others use the default thread. | `telegram.chatThreads` |
| `discord.bot_token` | string | Always encrypted. | `discord.botToken` |
| `discord.chat_threads` | `{ [channel_id]: thread_id }`? | | `discord.chatThreads` |

`telegram.webhookUrl` is not stored: it is the public base URL plus the ranger id.

### Indexes

| Index | Options | Serves |
| --- | --- | --- |
| `{ org_id: 1, updated_at: -1 }` | | The roster: one org, newest first. |
| `{ 'legacy.version_id': 1 }` | unique, partial: only where it exists | Telegram webhooks still registered with `?version_id=`. |
| `{ 'channels.discord.bot_token': 1 }` | partial: only where it exists | Starting every Discord bot at boot (query `{ 'channels.discord.bot_token': { $exists: true } }`). |

Both are partial on `$exists`, not on `$type`: Mongo only uses a partial index when the query
implies its filter, and an equality match implies `$exists` but not `$type`. Neither field is
ever stored as null.

## `schedules`

One document per schedule. Schedules are not stored inside the ranger because EasyCron calls the
public run endpoint with the schedule `_id`, and each run updates its own counters.

| Field | Type | Notes | Today in `rangerschedules` |
| --- | --- | --- | --- |
| `_id` | ObjectId | Carried in the EasyCron run URL. | `_id` |
| `ranger_id` | ObjectId | | `agent_id` + `version_id` |
| `org_id` | string | Same tenant as the ranger. | `org_id` (was GTWY's org, the same for everyone) |
| `label` | string? | | `label` |
| `message` | string | What the ranger is asked on each run. | `message` |
| `cron_expression` | string | | `cron_expression` |
| `timezone` | string | Default `UTC`. | `timezone` |
| `delivery` | `{ channel: 'telegram', chat_id, username? }` \| null | Where the answer goes; null keeps it in the run history. | `delivery` (`type` → `channel`) |
| `enabled` | boolean | | `enabled` |
| `easycron_id` | string? | Left out until EasyCron confirms the job; never stored as null. | `easycron_id` |
| `last_run` | `{ at, ok, duration_ms, thread_id, preview?, error? }`? | | `last_run` |
| `run_count` | number | | `run_count` |
| `fail_streak` | number | Consecutive failures; reset by a success. | `fail_streak` |
| `created_by` | string? | MSG91 user id. | `created_by` |
| `created_at`, `updated_at` | Date | | same |

Dropped: `thread_mode`, `thread_id` and `group_id`. They are stored today but never read; every
run uses a fresh thread.

### Indexes

| Index | Options | Serves |
| --- | --- | --- |
| `{ ranger_id: 1 }` | | A ranger's schedules, the per-ranger cap, pausing or deleting them all. |
| `{ easycron_id: 1 }` | unique, partial on strings | Finding a schedule by its job. Partial rather than sparse: a sparse index still indexes an explicit null, so two schedules waiting for their job would collide. |

## Migration

### Copying the data: `src/scripts/migrateRangers.ts`

The script copies every ranger out of GTWY into `rangers`, and every schedule into `schedules`. It
only reads from GTWY and from the old collections.

**What it reads:**

- **Rangers:** GTWY agents (`configurations`) in `ORG_ID`, inside the embed folder `FOLDER_ID`.
- **From GTWY:** each ranger's version (`configuration_versions`) and its tools (`apicalls`).
- **From this service:** its `channeldetails` document and its `rangerschedules`.

```bash
npm run migrate:rangers                   # dry run: reads, maps and reports; writes nothing
npm run migrate:rangers -- --apply        # writes
npm run migrate:rangers -- --agent <id>   # one GTWY agent only; combine with --apply
```

It needs `GTWY_MONGODB_URI` as well as the usual `.env`. That's GTWY's database, with the database
name in the path, and a read-only user is enough. It also uses `MONGODB_URI`, `ORG_ID`, `FOLDER_ID`
and `CHANNEL_ENCRYPTION_KEY`. Where the dev dependencies aren't installed, run
`node dist/scripts/migrateRangers.js` after `npm run build`.

**What it decides:**

- **Which version.** It takes the version a channel is wired to, because that's the one users talk to
  and its id is in the Telegram webhook URL. Otherwise it takes the published version, else the first.
  It warns when a ranger has more than one version.
- **Tenant.** `org_id` is the GTWY agent's `user_id`. A ranger without one is skipped.
- **Parameters.** GTWY stores them as `{ mode, value }`. Custom values are kept, defaults are dropped,
  and `min`/`max` are kept as those words.
- **Prompt.** A prompt with a custom template becomes the text GTWY sent: the template with
  `{{role}}`, `{{goal}}` and `{{instruction}}` filled in.
- **Bot tokens.** Any token still stored in plaintext is encrypted.
- **Schedules.** Each keeps its `_id`, so its EasyCron job URL keeps working. Its `org_id` becomes the
  ranger's tenant, and an `easycron_id` becomes a string, or is left out when there is none.
- **Deleted rangers.** Rangers in GTWY's trash are copied with `deleted_at` set.

**What it skips, reported as warnings:**

- a tool missing from `apicalls`
- a knowledge base without a `resource_id`
- a ranger without a tenant or a version
- a channel document or schedule whose ranger wasn't copied
- a delivery that isn't Telegram

**Running it again is safe until the app writes to `rangers`.** Rangers are matched on
`legacy.agent_id` and keep their `_id` and `created_at`; schedules are replaced by `_id`. After that,
running it again would overwrite edits made in Rangers.

### Before switching the services over

1. **Telegram webhooks.** Look rangers up by `legacy.version_id` until each bot's webhook is
   registered again with the ranger id.
2. **Thread ids.** Prefix them with the ranger id, e.g. `<ranger_id>_tg_<chatId>`. On the direct API
   every ranger shares one hidden GTWY agent, so a bare `tg_<chatId>` would mix the memory of two
   rangers talking to the same person. The prefix also lets GTWY's history be filtered per ranger.
3. **Gaps on GTWY's direct API**, to settle before rangers run on it:
   - knowledge bases (`doc_ids`) can't be sent with a request
   - the tone text has to be added to the prompt by Rangers
   - GTWY can't enforce a per-ranger usage limit
   - the mobile channel (GTWY's chatbot embed) needs a GTWY agent
4. **Auth.** Every route scopes by `org_id`; `/api/channel-details` has no auth today.
5. **Edits during the switch.** Changes made in GTWY after the copy are not picked up: run the
   migration again just before switching, then stop editing rangers in GTWY.
6. **Cleanup.** Delete `src/models/channelDetails.model.ts` and `src/models/rangerSchedule.model.ts`,
   and drop the old collections once nothing reads them.
