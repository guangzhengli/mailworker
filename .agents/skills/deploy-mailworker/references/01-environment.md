# Phase 1 — Environment

Strictly read-only. Run every check, collect every result, then report once.
Do not stop at the first failure — a report listing four things to fix beats
four round trips.

`WR` below means `pnpm --filter @mailworker/web exec wrangler` (verified
working; resolves to wrangler 4.114 from `apps/web/node_modules`). There is no
global wrangler on this machine and that is fine — do not install one.

**`WR` is documentation shorthand, not a shell variable.** The shell here is zsh,
which does not word-split unquoted parameters, so `WR="pnpm --filter … wrangler"`
followed by `$WR d1 list` fails with `no such file or directory`. That failure is
dangerous in a pipeline: `$WR d1 list | grep -c mailworker` prints `0` — an
apparently clean "no collision" that is really an empty input. Write the command
out in full, or `cd apps/web` and call `./node_modules/.bin/wrangler`. Whenever a
check's answer is "none", confirm the command actually ran.

## Checks

| # | Check | Command | Pass criterion | Severity if failed |
|---|---|---|---|---|
| 1 | Node | `node -v` | ≥ 22 (`engines.node`) | BLOCKER |
| 2 | pnpm | `pnpm -v` | ≥ 11.17 (`packageManager`) | BLOCKER |
| 3 | Deps installed | `ls apps/web/node_modules/.bin/wrangler` | exists | BLOCKER → `pnpm install` |
| 4 | Wrangler | `WR --version` | ≥ 4.114 | BLOCKER |
| 5 | Auth | `WR whoami` | prints an account, not "not authenticated" | BLOCKER → user runs `! npx wrangler login` |
| 6 | Login scopes | `WR whoami` (same call as check 5) | includes `workers`, `d1`, `queues`, `email_routing`, `email_sending` as write | BLOCKER if a scope is missing → re-run `wrangler login` |
| 7 | API token in `.env` | detection command in [credentials.md](credentials.md) §1 | a non-empty `CLOUDFLARE_API_TOKEN` | **BLOCKER** — see below |
| 7b | Token permissions | the six read-only probes in [credentials.md](credentials.md) §3 | all `200` | **BLOCKER** — report the failing endpoint and its message |
| 8 | Workers Paid | `WR queues list` | succeeds (any list, including empty) | BLOCKER — see below |
| 9 | Zone exists | zone lookup, below | exactly one zone named `<ZONE>` | BLOCKER |
| 10 | DNS baseline | `dig +short MX <ZONE>`, `dig +short MX <MAIL_HOST>`, `dig +short TXT <ZONE>` | record whatever is there | INFO, but see below |
| 11 | Test suite | `pnpm -s check` | exits 0 | WARN — deploying a red tree is the user's call, but say so |
| 12 | Working tree | `git status --porcelain` | note it | INFO — Phase 4 will add edits on top |


### Check 5 — auth

If `whoami` reports not authenticated, tell the user to type this in the
session so the output lands in the conversation:

```
! npx wrangler login
```

Do not try to run `wrangler login` yourself — it needs a browser and an
interactive callback.

Capture the **account id** from `whoami`. Everything in Phase 4 needs it.

### Check 6 — wrangler's own auth is already sufficient

The `wrangler login` OAuth token carries every scope the wrangler commands need
(verified: `workers`, `workers_scripts`, `d1`, `queues`, `email_routing`,
`email_sending` all write; `zone` read; R2 works despite not being listed). Do
not ask the user for a token on account of any `wrangler` command.

### Checks 7 and 7b — the API token gates full automation

This skill deploys without manual clicking, and the only two operations with no
CLI (steps 11 and 14) need a REST token. So a missing or under-permissioned
`CLOUDFLARE_API_TOKEN` stops Phase 1 — it does not silently downgrade to a
dashboard walkthrough.

Follow [credentials.md](credentials.md): detect with a count (never `cat`), load
into a curl config file, then run the six read-only probes. Report the outcome as
one of three states:

- **Absent** → give the full token-creation instructions from credentials.md §4,
  with the permission table and the resource scoping, then stop.
- **Present but a probe returns 403** → name the endpoint, quote the error, and
  say which single permission row to add. Then stop.
- **Present and all probes 200** → note it and continue. If the
  `email/routing/subdomains` probe returns 404, continue but flag in the plan that
  step 11 has no API and will need the dashboard — that is a Cloudflare gap, not a
  token problem.

### Check 8 — Workers Paid is not optional

Queues require Workers Paid, and `wrangler.jsonc` declares three producer
bindings and three consumers. There is no free-tier path that keeps this repo's
`send`, webhook fan-out or delivery-event handling working. Receiving alone
would work on Free, but the config would have to be gutted first — do not
propose that unless the user asks.

`WR queues list` on a Free account fails with a plan error. Report the actual
error text; do not paraphrase it into "you need to pay".

### Check 9 — zone lookup

Prefer the wrangler route, which needs no token at all:

```bash
WR email routing settings <ZONE>
```

It resolves the zone by name and succeeds even when routing is `unconfigured`, so
it answers "does this zone exist" and "has routing been enabled" in one call, and
its `Tag` field is the zone id. Zone `status` still needs the API, so once
`$SCRATCH/cf.curlrc` exists (check 7):

```bash
curl -K "$SCRATCH/cf.curlrc" -o "$SCRATCH/zone.json" -w '%{http_code}\n' \
  "https://api.cloudflare.com/client/v4/zones?name=<ZONE>"
```

Then parse `$SCRATCH/zone.json`. Never put a token on the command line — see
[credentials.md](credentials.md).

`WR email routing list` only shows zones that already have routing enabled, so an
empty list says nothing about whether the zone exists.

Zone `status` must be `active`. A `pending` zone means the nameservers have not
moved to Cloudflare yet — that is a BLOCKER for Email Routing, which requires
Cloudflare DNS.

### Check 10 — the DNS baseline matters

Record the existing MX for the apex **before** anything changes. Phase 4 step 9
(`email routing enable <ZONE>`) replaces the apex MX and locks it. If the
baseline shows MX records already pointing somewhere real (Lark, Google, Zoho),
that is mail this deploy is about to break — escalate it to a BLOCKER, show the
records, and make the user confirm explicitly. The recorded decision assumes
the apex MX is currently unused.

## Report shape

One line per check, grouped by severity, in this order and no longer than this:

1. `✅` lines — toolchain versions on one line; auth with the account id; plan
   tier; zone id and status; test suite result with the test count.
2. `⚠️` lines — each with its consequence for Phase 4, not just the finding.
   A missing `CLOUDFLARE_API_TOKEN` means "steps 11 and 14 fall back to the
   dashboard", so say that.
3. `ℹ️` lines — the DNS baseline as measured, and the working-tree state with a
   note that Phase 4 adds one more edit.
4. `🛑` block, only if there is a BLOCKER: the exact commands to run, in order,
   prefixed with `!` when they need to be interactive (e.g. `! npx wrangler
   login`).

Stop after this report if there is any BLOCKER. Otherwise continue to Phase 2
without asking — Phase 2 is also read-only.

If Phase 1 ends on a BLOCKER, delete `$SCRATCH/cf.curlrc` and the probe responses
before stopping. The same token will work once its permissions are fixed, so
Phase 4 step 0 simply re-creates the config.
