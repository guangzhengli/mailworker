# Phase 2 — Discovery

Still read-only. Two jobs: read what the repo declares, and find out what
already exists on the account. The difference between the two is the plan.

## A. What the repo declares

Read `apps/web/wrangler.jsonc` and extract, rather than trusting this file's
memory of it:

| Field | Expected value | Note |
|---|---|---|
| `name` | `mailworker` | becomes the Worker name and the Email Routing action value |
| `main` | `workers/entry.ts` | four handlers exported from here |
| `assets.directory` | `./build/client` | must exist before `deploy` → build first |
| `d1_databases[0].database_name` | `mailworker` | |
| `d1_databases[0].database_id` | `PLACEHOLDER_RUN_MAILWORKER_DEPLOY` | **must be replaced** — Phase 4 step 1 |
| `d1_databases[0].migrations_dir` | `migrations` | two migrations: `0000_init.sql`, `0001_messages_fts.sql` |
| `r2_buckets[0].bucket_name` | `mailworker-blobs` | |
| `queues.producers[]` | `mailworker-dispatch`, `mailworker-webhooks` | |
| `queues.consumers[]` | `mailworker-dispatch`, `mailworker-events`, `mailworker-webhooks` | `mailworker-events` is consumer-only — Cloudflare fills it |
| consumer `dead_letter_queue` | `-dlq` for each of the three | three more queues that must exist |
| `triggers.crons` | `["0 * * * *"]` | hourly retention sweep |
| `durable_objects.bindings[]` | `WAITER` → `MessageWaiter` | |
| `migrations[0]` | tag `v1`, **`new_classes`** | **must become `new_sqlite_classes`** — Phase 4 step 4 |
| `vars.MAILWORKER_ACCOUNT_ID` | `default` | the *tenant* id inside D1, **not** the Cloudflare account id |
| `send_email[0].name` | `SEND_EMAIL` | |

Re-verify the two "must" rows by reading the file. If someone already fixed
them, mark those steps SKIP in the plan rather than editing again.

## B. What already exists on the account

Run all of these; each is read-only and cheap.

```bash
WR d1 list
WR r2 bucket list
WR queues list
WR email routing list                      # zones with routing enabled
WR email sending list                      # all sending subdomains in the account
WR email routing settings <ZONE>     # errors if routing not enabled — that is an answer
WR email routing rules list <ZONE>   # errors if routing not enabled
WR secret list --name mailworker           # errors if the Worker does not exist yet
WR deployments list --name mailworker      # same
```

For a queue that exists, `WR queues info <name>` shows whether a consumer is
attached. For the delivery-event subscription:

```bash
WR queues subscription list mailworker-events
```

Build an inventory table: resource → exists? → matches config? A resource that
exists with the right name is a SKIP. A resource that exists with the *wrong*
shape (e.g. a `mailworker` D1 whose id differs from the one in the config after
someone edited it) is a CONFLICT and needs the user's decision, not a silent
overwrite.

## C. Derived values to compute now

| Value | How |
|---|---|
| Cloudflare account id | Phase 1 check 5 |
| Zone id for `<ZONE>` | Phase 1 check 9 |
| Worker URL | `https://mailworker.<workers.dev subdomain>.workers.dev` — read the real one from `deploy` output in Phase 4; do not guess the subdomain |
| Sending DKIM selector | `cf-bounce` (Email Sending). Routing uses `cf2024-1` — the wrong one for this repo, whose `doctor` checks the sending side |
| `domains` row values | see below |

The `domains` row that Phase 4 step 15 inserts:

| Column | Value | Source |
|---|---|---|
| `id` | a 26-char Crockford-base32 ULID | generate; any valid ULID works, nothing parses it back |
| `account_id` | `default` | must equal `vars.MAILWORKER_ACCOUNT_ID` |
| `name` | `<MAIL_HOST>` | lowercased — `findRouting` compares lowercased |
| `zone_id` | the real zone id | nullable, but `doctor` reads it |
| `inbound_enabled` | `1` | currently read by no code (`schema.ts` only), set it anyway |
| `sending_status` | `unverified` at insert time | flip to `verified` once `email sending dns get` shows the records live |
| `dkim_selector` | `cf-bounce` | `null` makes `doctor` report DKIM as `unknown` |
| `catchall_mode` | `reject` | the safe default; `autocreate` is an abuse door |
| `catchall_inbox` | `NULL` | only `store` mode needs it |
| `autocreate_pattern` | `NULL` | only `autocreate` mode needs it |
| `created_at` | ISO-8601 with milliseconds, e.g. `2026-07-29T12:00:00.000Z` | `toIsoText` writes this shape; `toDate` parses it |

## D. Inputs to collect from the user

Ask only for what you cannot derive. Four things qualify, and the first two have
no default you may invent:

- **`<ZONE>`** — which domain receives the mail. It must already be on
  Cloudflare; verify with `GET /zones?name=<ZONE>` and record `<ZONE_ID>`. If
  the account has exactly one zone, still confirm rather than assuming it.
- **`<MAIL_HOST>`** — where mail is received and sent. Recommend `mail.<ZONE>`
  and give the reason: Email Routing on the apex overwrites and locks the apex
  MX, so a subdomain keeps their existing mail provider working. Take the apex
  only if they ask for it after hearing that.
- **apex MX disposition** — ask **only** if `dig +short MX <ZONE>` returned
  something. Enabling routing replaces those records; the user needs to say so
  out loud before step 10.
- **`MAILWORKER_ADMIN_KEY`** — the bootstrap credential. Default: generate one
  with `openssl rand -base64 32`. Ask whether they want to supply their own
  instead. Never echo either value; write it to a file, `wrangler secret put …
  < file`, then `rm` the file.

Everything else is derived. Do not ask whether to edit `wrangler.jsonc` — two
edits are hard prerequisites, and the user reviews the diff rather than
approving it in advance.

## Report shape

Three blocks:

1. **What the config declares** — one compact line for the resource set (Worker,
   D1, R2, six queues, the DO binding, the cron), then a `⚠️` line for each of
   the two prerequisite problems found (`database_id` placeholder,
   `new_classes`).
2. **What exists on the account** — one line per resource kind with its actual
   state. Absent is a normal, expected answer on a fresh account; say "none"
   rather than dressing it up as a problem.
3. **What is needed from you** — the zone and mail hostname if not yet settled,
   the apex MX decision if the apex already has records, and the admin key, with
   the generation command offered as the recommended default and an explicit
   note that the value goes only into the Cloudflare secret and
   `.mailworker/config.json` (gitignored), never to the terminal.

Then continue straight into Phase 3 — the plan is what the user is waiting for.
