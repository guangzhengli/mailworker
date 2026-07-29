# Phase 4 — Execute

Only after explicit approval. `WR` = `pnpm --filter @mailworker/web exec
wrangler`. Run wrangler from the repo root via that alias — it resolves
`apps/web/wrangler.jsonc` through the workspace filter, so you do not need to
`cd`.

**Order is load-bearing.** Queues, D1 and R2 must exist before `deploy`, the
Worker must exist before the catch-all rule can name it and before
`secret put`, and the sending domain must be verified before the event
subscription can be scoped to it.

After each step: run the verification, then update
`.mailworker/deploy-state.json`. On failure, stop, report the real output, and
say which step to resume from. Do not skip ahead past a failure.

---

## 0 · Load the API token

Before anything mutating. Follow [credentials.md](credentials.md) §2 to write
`$SCRATCH/cf.curlrc` from `.env`, and re-run the §3 probes if Phase 1 was in a
previous session — a token with a TTL can have expired since.

This step creates nothing on Cloudflare, so it is safe to redo at any point. Its
teardown is at the end of this file and it is **not optional**.

---

## 1 · Create D1 and capture the id

```bash
WR d1 create mailworker
```

Prints the `database_id`, and offers to write the binding into the config —
answer no (in a non-interactive shell it defaults to no, which is correct). Doing
it by hand in step 2 preserves the `DB` binding name; wrangler's snippet would
set the binding to `mailworker` and break every `env.DB` reference.

**Verify with `WR d1 list`, not `d1 info`.** `d1 info <name>` resolves the name
through `wrangler.jsonc`, so before step 2 it looks up the literal
`PLACEHOLDER_RUN_MAILWORKER_DEPLOY` and fails with `code: 7404`. Use:

```bash
WR d1 list        # expect a row: <uuid> │ mailworker
```

If the database already exists, take the uuid from that same listing and mark
this step SKIP. `d1 info` becomes usable after step 2.

## 2 · Write the id into the config

Edit `apps/web/wrangler.jsonc`, replacing
`"PLACEHOLDER_RUN_MAILWORKER_DEPLOY"` with the real uuid. Leave the surrounding
comment intact — it explains why the placeholder was there.

**Verify:** `grep -n database_id apps/web/wrangler.jsonc` shows a uuid, and
`grep -c PLACEHOLDER apps/web/wrangler.jsonc` is 0.

## 3 · Create the R2 bucket

```bash
WR r2 bucket create mailworker-blobs
```

**Verify:** `WR r2 bucket list` contains it.

## 4 · Switch the Durable Object to the SQLite backend

Edit `apps/web/wrangler.jsonc`: in `migrations[0]` (tag `v1`), rename
`new_classes` to `new_sqlite_classes`. Keep the tag as `v1` — nothing has been
deployed yet, so there is no migration history to respect and no new tag is
needed.

Do **not** add a second migration entry. Do not touch `waiter.ts` — it stores
nothing, so the backend change is invisible to it.

**Verify:** `grep -n new_sqlite_classes apps/web/wrangler.jsonc` matches and
`grep -c '"new_classes"' apps/web/wrangler.jsonc` is 0.

## 5 · Create the six queues

Order does not matter among these, but all six must exist before `deploy`
because the consumers reference their DLQs by name.

```bash
WR queues create mailworker-dispatch
WR queues create mailworker-dispatch-dlq
WR queues create mailworker-webhooks
WR queues create mailworker-webhooks-dlq
WR queues create mailworker-events
WR queues create mailworker-events-dlq
```

`mailworker-events` has no producer in this repo on purpose — Cloudflare
publishes into it via the step 14 subscription.

**Verify:** `WR queues list` shows all six.

## 6 · Build the client bundle

```bash
pnpm --filter @mailworker/web build
```

`assets.directory` is `./build/client`; `deploy` fails or ships an empty
dashboard without this. The repo's own `deploy` script (`vite build && wrangler
deploy`) does both, but running them separately gives a clean failure boundary.

**Verify:** `ls apps/web/build/client/` is non-empty.

## 7 · Deploy the Worker

```bash
WR deploy
```

Capture the deployed URL from the output — that is the real
`https://mailworker.<subdomain>.workers.dev`, and the CLI/dashboard base URL.
Do not guess the workers.dev subdomain.

This is also where the DO namespace and the cron trigger get created, and where
the three queue consumers get attached.

**Verify:** `WR deployments list --name mailworker` shows a deployment, then

```bash
curl -s -o /dev/null -w '%{http_code}' <url>/v1      # 401 — router alive, unauthenticated
curl -s -o /dev/null -w '%{http_code}' <url>/login   # 200 — dashboard SSR alive
```

**Wait a few seconds first, and retry before believing a 404.** Routes and assets
propagate after `Deployed … triggers` is printed; curling immediately returns 404
for the dashboard paths while `/v1` already answers. That transient 404 was
misread as a broken dashboard once. Confirm with the response body — a real hit
returns `<title>Sign in · Mailworker</title>`.

## 8 · Apply the D1 migrations

```bash
WR d1 migrations apply mailworker --remote
```

Two migrations: `0000_init.sql`, `0001_messages_fts.sql`.

**Verify:**

```bash
WR d1 execute mailworker --remote --command \
  "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
```

Expect `accounts`-through-`webhooks` including `domains`, `inboxes`, `messages`,
`deliveries`, `delivery_events`, `api_keys`, `agent_identities`, and the FTS
tables.

## 9 · Set the bootstrap admin secret

**Guard — check before generating anything:**

```bash
WR secret list --name mailworker        # names only, no values
```

If `MAILWORKER_ADMIN_KEY` is already listed, **mark this step SKIP and move on.**
Generating a new one is destructive in two ways that no verification would catch:
the old value is unrecoverable (it is compared against
`env.MAILWORKER_ADMIN_KEY`, never stored), and `apps/web/workers/http/session.ts:47`
uses `MAILWORKER_SESSION_SECRET ?? MAILWORKER_ADMIN_KEY` to seal dashboard
sessions — so rotating it logs everyone out. The comment at `session.ts:42` states
this consequence deliberately.

Overwrite it only if the user asked for a rotation in this conversation. When they
do, tell them up front that they will be logged out, and rewrite
`.mailworker/config.json` in the same step so the CLI does not break.

If the secret is absent — the normal first-deploy case — generate, pipe, delete.
The value must never appear in argv or stdout.

```bash
umask 077
openssl rand -base64 32 > "$SCRATCH/admin-key"
WR secret put MAILWORKER_ADMIN_KEY --name mailworker < "$SCRATCH/admin-key"
```

Keep the file until step 16 (verification needs the value), then `rm -f` it.
Also write `.mailworker/config.json` for the CLI:

```json
{ "url": "<deployed url>", "token": "<the admin key>" }
```

`.mailworker/` is gitignored (confirmed in `.gitignore`). This is the bootstrap
credential, not a scoped key — mint a real one later with `mailworker keys
create --identity …`, which is the whole reason the admin key exists.

**Verify:** `WR secret list --name mailworker` lists `MAILWORKER_ADMIN_KEY`
(names only, no values).

## 10 · Enable Email Routing on the zone

**Read [dns-and-email.md](dns-and-email.md) before running this.** It replaces
the apex MX and locks the records.

```bash
WR email routing enable <ZONE>
```

This command resolves the domain via an **exact** zone-name lookup
(`resolveZoneId` → `GET /zones?name=…`), so it must be given the apex. Passing
`<MAIL_HOST>` fails with "Could not find zone".

**Verify:**

```bash
WR email routing settings <ZONE>     # Enabled: true
WR email routing dns get <ZONE>      # the records it now manages
dig +short MX <ZONE>                 # *.mx.cloudflare.net
```

## 11 · Add `mail` as an Email Routing subdomain

No CLI command exists for this — `wrangler`'s bundled SDK has
`email/sending/subdomains` but no routing equivalent. See
[rest-api.md](rest-api.md) for the REST attempt and the dashboard fallback.

**Verify:** `dig +short MX <MAIL_HOST>` returns Cloudflare MX hosts. DNS
usually lands in 5–15 minutes on a Cloudflare-hosted zone; if it is empty,
re-check before declaring failure.

## 12 · Point the catch-all at the Worker

The catch-all is a single **zone-level** rule
(`PUT /zones/{zone}/email/routing/rules/catch_all`), so it is addressed by the
apex even though the mail it will actually receive arrives for the subdomain.

**wrangler cannot do this.** `wrangler email routing rules update <zone>
catch-all --action-type worker` fails with:

```
✘ Catch-all rule only supports 'forward' or 'drop' action types
```

That is a CLI-side validation limit, not an API one — the dashboard offers a
Worker catch-all, and the API accepts it. Use REST. Conveniently this is the one
Email Routing path an API token *can* reach (`/rules/catch_all` probes 200 while
`/email/routing` and `/email/routing/dns` return 403 — see credentials.md).

```bash
python3 - <<'PY'
import json, os, pathlib
pathlib.Path(os.environ["SCRATCH"], "ca-body.json").write_text(json.dumps({
    "name": "mailworker catch-all",
    "enabled": True,
    "matchers": [{"type": "all"}],
    "actions": [{"type": "worker", "value": ["mailworker"]}],
}))
PY

curl -K "$SCRATCH/cf.curlrc" -X PUT \
  -H 'Content-Type: application/json' \
  --data @"$SCRATCH/ca-body.json" \
  -o "$SCRATCH/ca-put.json" -w '%{http_code}\n' \
  "https://api.cloudflare.com/client/v4/zones/<zone id>/email/routing/rules/catch_all"
```

Note `value` is an **array** for a worker action. A fresh zone's catch-all starts
as `{"type":"drop"}` with `enabled: false`, so both fields must be set.

This one rule is the whole point of the architecture: inboxes are database rows
resolved by `AddressResolutionPolicy`, so the 200-rules-per-domain ceiling never
applies. Never create a routing rule per inbox.

**Verify:**

```bash
WR email routing rules get <ZONE> catch-all
```

Action must be `worker` → `mailworker`, enabled true.

## 13 · Onboard the sending subdomain

```bash
WR email sending enable <MAIL_HOST>
```

Unlike the routing commands, `email sending enable` walks up the labels to find
the parent zone (`resolveDomain`), so the subdomain works directly. Under the
hood it POSTs to `/zones/{zone}/email/sending/subdomains`.

**Verify:**

```bash
WR email sending list <MAIL_HOST>
WR email sending dns get <MAIL_HOST>
dig +short MX cf-bounce.<MAIL_HOST>
dig +short TXT cf-bounce._domainkey.<MAIL_HOST>
```

Until the domain is verified, Cloudflare only accepts mail to addresses already
verified on the account. That is expected on a fresh deploy — record it, and use
`sending_status='unverified'` in step 15 rather than pretending otherwise.

## 14 · Subscribe `mailworker-events` to delivery events

**Guard — this is the one step whose re-run corrupts data:**

```bash
WR queues subscription list mailworker-events
```

If a subscription for this sending domain already exists, **mark the step SKIP.**
The endpoint is a plain `POST` with no idempotency key and no unique constraint on
the name, so a second call yields a second subscription — and then Cloudflare
delivers every `cf.email.sending.message.*` event twice. `workers/queue.ts`
appends on each one, so the delivery timeline gains duplicate rows and a bounce is
counted twice against the suppression list. Nothing errors; the deploy reports
success.

If a subscription exists but is wrong (disabled, wrong domain, missing events),
fix it with `queues subscription update` or `delete` + re-create. Never create
alongside it.

No CLI coverage for creation: `queues subscription create --source` has no email
choice in wrangler 4.114. See [rest-api.md](rest-api.md) for the verified
endpoint, the body shape, and the dashboard fallback. `list`, `get`, `update` and
`delete` *are* available in the CLI, so the guard needs no API token.

**Verify:** `WR queues subscription list mailworker-events` shows a subscription
whose source is the sending domain.

If this step falls back or fails, the deployment still works — say clearly what
degrades: the delivery timeline stops at `queued`, and hard bounces stop feeding
the suppression list.

## 15 · Insert the `domains` row

Nothing in the deployment can create this row — `D1Domains` implements only
`findRouting` and `list`. Without it, `createInbox` throws "No sending domain is
configured" and every inbound message resolves to `unroutable: unknown_domain`.

**Guard — check first, or this step aborts the phase:**

```bash
WR d1 execute mailworker --remote --command \
  "SELECT id, name, sending_status FROM domains WHERE name='<MAIL_HOST>'"
```

A row already there means SKIP. The `INSERT` below would violate the unique index
on `(account_id, name)` and stop Phase 4 one step short of verification. If the
row exists but `sending_status` is stale, `UPDATE` that column instead of
inserting — the final report already carries the `sending_status='verified'`
command for exactly this.

Use the values computed in Phase 2 §C.

```bash
WR d1 execute mailworker --remote --command "INSERT INTO domains \
 (id, account_id, name, zone_id, inbound_enabled, sending_status, dkim_selector, \
  catchall_mode, catchall_inbox, autocreate_pattern, created_at) VALUES \
 ('<ULID>', 'default', '<MAIL_HOST>', '<zone id>', 1, 'unverified', \
  'cf-bounce', 'reject', NULL, NULL, '<iso millis>')"
```

`account_id` must be `'default'` — it matches `vars.MAILWORKER_ACCOUNT_ID`, the
tenant id inside D1, and has nothing to do with the Cloudflare account id.

**Verify:**

```bash
WR d1 execute mailworker --remote --command "SELECT name, account_id, catchall_mode, dkim_selector FROM domains"
```

## 16 · End-to-end verification

Use the repo's own CLI — that is what it is for, and `doctor` is exactly this
check. It reads `.mailworker/config.json` written in step 9, so no credential
goes on the command line.

`packages/cli` has no build step and its `bin` points at a `.ts` file, so bare
`node` fails with `ERR_MODULE_NOT_FOUND: @cli/main`. Run it through `tsx` with an
explicit tsconfig, **from the repo root**:

```bash
./node_modules/.bin/tsx --tsconfig packages/cli/tsconfig.json packages/cli/src/bin.ts doctor
```

Both halves of that matter, and getting either wrong wastes a round trip:

- `--tsconfig packages/cli/tsconfig.json` — the repo root has only
  `tsconfig.base.json`, no `tsconfig.json`, so tsx finds no `paths` mapping there
  and `@cli/main` fails to resolve. Running from inside `packages/cli` fixes the
  paths but breaks the next point.
- **cwd must be the repo root** — `config.ts` reads `join(process.cwd(),
  ".mailworker", "config.json")`. From `packages/cli` it looks for
  `packages/cli/.mailworker/config.json` and reports "No deployment URL".

Do not build that command into a shell variable. zsh does not word-split unquoted
parameters, so `T="./node_modules/.bin/tsx --tsconfig …"; $T doctor` fails with
`no such file or directory`. Write it out each time.

Verified working, including every subcommand (`inbox`, `wait`, `send`, `doctor`,
`keys`, `identities`, `webhooks`). Note that `tsx` is currently only a transitive
dependency — mention in the report that adding it as an explicit devDependency of
`packages/cli` plus a `dev` script would make this reliable, but do not make that
change as part of a deploy.

Then:

```bash
cd packages/cli
T=../../node_modules/.bin/tsx
$T src/bin.ts doctor                          # MX / SPF / DKIM / DMARC / sending / bindings
$T src/bin.ts inbox create --kind ephemeral   # mints inbox-xxxx@<MAIL_HOST>
$T src/bin.ts ls --limit 5
```

`doctor` exits non-zero if any domain check is `fail` or the dispatch queue is
unconfigured, so its exit code is the deployment gate. Report the actual check
table, not just the exit code.

Send a real message from an outside account to the minted address and confirm it
lands with `ls`. If it does not, `references/troubleshooting.md` has the
inbound decision tree.

If the CLI cannot run for any reason, the HTTP fallback is equivalent. Use the
same curl-config trick as for the API token, so the admin key never reaches a
command line:

```bash
python3 - <<'PY'
import os, pathlib, stat
key = pathlib.Path(os.environ["SCRATCH"], "admin-key").read_text().strip()
out = pathlib.Path(os.environ["SCRATCH"]) / "mw.curlrc"
out.write_text('header = "Authorization: Bearer %s"\nsilent\n' % key)
out.chmod(stat.S_IRUSR | stat.S_IWUSR)
print("ok")
PY

curl -K "$SCRATCH/mw.curlrc" -o "$SCRATCH/diag.json" -w '%{http_code}\n' <url>/v1/diagnostics
```

## Cleanup — always, success or failure

```bash
rm -f "$SCRATCH/admin-key" "$SCRATCH/cf.curlrc" "$SCRATCH/mw.curlrc" \
      "$SCRATCH/sub-body.json" "$SCRATCH/sub.json" "$SCRATCH/diag.json"
```

The scratchpad is session-scoped, but a credential left on disk for the rest of a
session is still a credential left on disk. Do this even when Phase 4 aborts
early.

---

## Final report

Cover:

1. What was created, with real ids/URLs.
2. What was skipped or fell back, and why.
3. The `wrangler.jsonc` diff, uncommitted, for them to review.
4. **The apex MX reminder**: `<ZONE>` now points at Cloudflare. If they want
   their own provider on the apex instead, run
   `WR email routing dns unlock <ZONE>`, swap the MX in the dashboard, and
   `<MAIL_HOST>` is unaffected either way. Say this even when the apex had no MX
   before — it is the sentence that stops a surprise six months from now.
5. Whatever is still pending on Cloudflare's side — sending-domain verification
   in particular, with the command to re-check:
   `WR email sending dns get <MAIL_HOST>`. Once verified, flip the row:
   `UPDATE domains SET sending_status='verified' WHERE name='<MAIL_HOST>'`.
6. Next steps that are the user's to take: mint a scoped key instead of using
   the admin key, and decide whether the dashboard needs a custom domain.
