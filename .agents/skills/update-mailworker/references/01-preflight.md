# Phase 1 — Preflight

Read-only. Run every check, then report once. Do not stop at the first failure.

`WR` below means `pnpm --filter @mailworker/web exec wrangler` (wrangler 4.114
from `apps/web/node_modules`; there is no global wrangler on this machine and that
is fine).

**`WR` is documentation shorthand, not a shell variable.** zsh does not word-split
unquoted parameters, so `WR="pnpm --filter … wrangler"` then `$WR d1 list` fails
with `no such file or directory`. That failure is dangerous in a pipeline —
`$WR d1 list | grep -c mailworker` prints `0`, an apparently clean answer that is
really an empty input. Write the command out in full. Whenever a check's answer is
"nothing there", confirm the command actually ran.

## Checks

| # | Check | Command | Pass criterion | Severity |
|---|---|---|---|---|
| 1 | Config still has the real D1 id | `grep -n database_id apps/web/wrangler.jsonc` | a uuid, **not** `PLACEHOLDER_RUN_MAILWORKER_DEPLOY` | **BLOCKER** — see below |
| 2 | Config still has the SQLite DO backend | `grep -c new_sqlite_classes apps/web/wrangler.jsonc` | `1`, and `grep -c '"new_classes"'` is `0` | **BLOCKER** |
| 3 | Auth, and the right account | `WR whoami` | the account id matches the one this Worker was deployed to — record it as `<ACCOUNT_ID>` and reuse it for the rest of the run | BLOCKER → `! npx wrangler login` |
| 4 | The Worker exists | `WR deployments status --name mailworker` | prints a current deployment | BLOCKER → this is a first deploy, switch skills |
| 5 | What is about to ship | `git status --porcelain` and `git diff --stat` | note it | INFO — but it drives phase 2 |
| 6 | Tree is green | `pnpm -s check` | exits 0 | WARN, and an approval gate |
| 7 | Unapplied D1 migrations | `WR d1 migrations list mailworker --remote` | note the list | drives phase 2 |
| 8 | Pending drizzle output | `git status --porcelain apps/web/migrations` | note new `.sql` files | drives phase 2 |
| 9 | Rollback target | `WR deployments status --name mailworker` | record the current **version id** | BLOCKER if unknown |
| 10 | Live before the change | `curl -s -o /dev/null -w '%{http_code}' <WORKER_URL>/v1` | `401` | INFO — establishes the baseline |

## Check 1 — the uncommitted `database_id`

This is the failure this phase exists for. `apps/web/wrangler.jsonc` is committed
with `"database_id": "PLACEHOLDER_RUN_MAILWORKER_DEPLOY"`, because the real id
identifies one particular Cloudflare account and this is a public repo. The
deploying account's real id therefore lives **only in the working tree**, so any
`git checkout`, `git stash`, branch switch, clean clone or CI runner loses it —
and a deploy without it fails to resolve the database, or worse, resolves a
different one.

If it is missing, recover it with `WR d1 list` (match on database name
`mailworker`), write it back, and show the user the diff. Do not commit it.

`new_sqlite_classes` (check 2) is committed and should never be `new_classes`:
Cloudflare no longer creates key-value-backed DO namespaces for accounts without
one, and it would conflict with the applied `v1` migration, which already
registered `MessageWaiter` as SQLite. If a merge or a revert reintroduces
`new_classes`, that is a BLOCKER, not a preference.

## Check 4 — right skill?

`deployments status` failing with "workers.api.error.script_not_found" means there
is nothing to update. Stop and point at `deploy-mailworker`.

## Check 9 — record the rollback target first

```bash
WR deployments status --name mailworker
```

Write the current version id into the phase 2 plan, verbatim. After the deploy it
is one entry down a list; before the deploy it is unambiguous. `WR versions list
--name mailworker` shows the ten most recent if you need more history.

## Report shape

Four grouped blocks, no longer than this:

1. `✅` — auth and account, current version id, live baseline, `check` result with
   the test count.
2. `⚠️` — each with its consequence for the deploy, not just the finding.
3. `ℹ️` — the diff summary: which files changed, and any new migration files.
4. `🛑` — only if there is a BLOCKER: the exact commands, in order, prefixed with
   `!` when they need to be interactive.

Then continue to phase 2 without asking — phase 2 is also read-only.
