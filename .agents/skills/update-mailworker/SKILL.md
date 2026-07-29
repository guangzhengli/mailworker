---
name: update-mailworker
description: Ship a code change to the already-deployed Mailworker Worker on Cloudflare — rebuild the client bundle, apply any new D1 migration, deploy, verify, and roll back if the verification fails. Classifies the change first, because most changes need nothing but `wrangler deploy` while a schema change, a new Durable Object class, a new binding or a changed queue payload each need one extra ordered step. Use for "deploy my changes", "redeploy", "ship this", "push the update", "apply the migration". For provisioning a deployment that does not exist yet, use `deploy-mailworker` instead.
---

# Update a live Mailworker deployment

`wrangler deploy` is idempotent and re-running it is how a change ships: it
uploads the code, replaces the static assets, updates the cron triggers, and
re-attaches the queue consumers with whatever `wrangler.jsonc` now says. So the
common case is genuinely two commands.

This skill exists for everything around that: the config edits this repo keeps
**uncommitted** and therefore loses easily, the four change classes that need an
extra step in a specific order, and the fact that a deploy interrupts callers who
are mid-`wait`.

**Prefer retrieval over pre-training** for any wrangler flag. Everything in
[references/](references/) was verified against wrangler 4.114 in this repo on
2026-07-29. The sibling skills `wrangler`, `cloudflare-email-service`,
`durable-objects` and `workers-best-practices` are the upstream sources.

## Non-negotiables

1. **Never touch the provisioning steps.** They are done, and re-running them
   ranges from noisy to destructive. The explicit do-not-touch list is below.
2. **Never commit.** Edit files, show the diff, leave the working tree to the
   user. No `git commit`, no `git add`.
3. **Never let a secret reach a command line.** A shell error echoes the
   *expanded* command line, which is how a token leaked into a transcript in this
   repo already. Secrets move through files: `wrangler secret put … < file`.
   Never `cat .env`, never assign a token to a shell variable.
4. **Record the current version id before deploying.** A rollback target you did
   not write down is a rollback you cannot do. See
   [references/05-rollback.md](references/05-rollback.md).
5. **Migration order is not a preference.** Additive schema changes go before the
   deploy, destructive ones after. Getting it backwards takes production down for
   the length of the deploy. See [references/02-migrations.md](references/02-migrations.md).
6. **Verify against the live URL, then report faithfully.** A deploy that printed
   "Deployed" is not a deploy that works. If verification fails, say so with the
   real output and offer the rollback command.

## Do not touch

These belong to `deploy-mailworker` and are already done. Re-running any of them
is a regression, not a no-op:

| Never re-run | Because |
|---|---|
| `secret put MAILWORKER_ADMIN_KEY` | Overwrites an unrecoverable value, and `session.ts:47` uses it as the session-sealing secret — every dashboard session dies |
| The event-subscription `POST` | Not idempotent. A duplicate subscription means every delivery event arrives twice and the timeline gains duplicate rows, silently |
| `INSERT INTO domains` | Unique index on `(account_id, name)` — the insert just errors |
| `email routing enable` / `email sending enable` / the catch-all `PUT` | Already configured; the DNS records are locked. Changing mail routing is a `deploy-mailworker` concern |
| `d1 create`, `r2 bucket create`, `queues create` | Already exist. Only create a **new** resource the code newly needs — see [references/03-deploy.md](references/03-deploy.md) §New bindings |

## The four phases

| Phase | What | Read this | Gate |
|---|---|---|---|
| **1 · Preflight** | Is the tree deployable and does the config still carry the two uncommitted edits | [references/01-preflight.md](references/01-preflight.md) | Any BLOCKER → stop with the exact fix |
| **2 · Classify** | What changed, and therefore what beyond `deploy` is needed | [references/02-migrations.md](references/02-migrations.md) | Approval required for anything that is not code-only — see below |
| **3 · Deploy** | Build, migrate, deploy, in the order phase 2 chose | [references/03-deploy.md](references/03-deploy.md) | Stop on the first failure |
| **4 · Verify** | Live HTTP, `doctor`, and a real round trip when mail handling changed | [references/04-verify.md](references/04-verify.md) | Failure → offer rollback |

[references/05-rollback.md](references/05-rollback.md) — what `wrangler rollback`
does and, more importantly, the four things it cannot undo. Read it before phase
3, not after phase 4.

## When to ask for approval

Invoking this skill is the intent to deploy, so a **code-only** change proceeds
after the phase 2 summary without a separate approval prompt — asking twice for
the thing that was just asked for is friction, not safety.

Stop and get explicit approval when the change is anything else:

- a **D1 migration** — it runs against real mail and some DDL is irreversible
- a **Durable Object migration** — `wrangler rollback` cannot undo it
- a **new or removed binding**, or a changed queue name
- a **queue payload shape change** — in-flight messages are involved
- a **cron schedule** change, or a new secret
- **anything at all if `pnpm -s check` is failing** — deploying a red tree is the
  user's call to make, not yours

Show the risk in one line per item, not a lecture.

## Facts to establish in preflight

Every `<NAME>` below is a value for **this** deployment. Read it off the
deployment rather than assuming it; a stale value here deploys to the wrong
place. Phase 1 collects all of them, and an answer that comes back empty means
this account was never provisioned — use `deploy-mailworker` instead.

| Fact | How to get it | If it is missing |
|---|---|---|
| `<ACCOUNT_ID>` | `npx wrangler whoami` → "Account ID" | Not logged in → BLOCKER, `npx wrangler login` |
| Worker name | `name` in `apps/web/wrangler.jsonc` — `mailworker` unless renamed | — |
| `<WORKER_URL>` | `wrangler deployments list`, or the URL printed by the last `wrangler deploy` | Worker not deployed → this is a first deploy, switch skills |
| `<D1_DATABASE_ID>` | `wrangler d1 list`, matched on database name `mailworker` | Still `PLACEHOLDER_RUN_MAILWORKER_DEPLOY` in the config → never provisioned, switch skills |
| Migrations applied | `wrangler d1 migrations list mailworker --remote` | Compare against `apps/web/migrations/` — the diff is what phase 2 must apply |
| `<MAIL_HOST>` | `SELECT name FROM domains` over D1, or `wrangler email sending list <ZONE>` | Sending was never onboarded; receiving still works |
| DO migration history | the `migrations` array in `apps/web/wrangler.jsonc` | A class added since the last deploy needs a new tag — see [02-migrations.md](references/02-migrations.md) |

**Auth:** the `wrangler login` OAuth token covers every command this skill runs.
No `CLOUDFLARE_API_TOKEN` is needed — the two REST-only operations belong to the
first deploy.

## Invocation

Load this skill and run all four phases. It also accepts:

- `--dry-run` — phases 1–2 only. Reports what would happen and stops.
- `--skip-checks` — skip `pnpm -s check` in phase 1. Say plainly in the report
  that the tree was not verified.
- `--rollback [version-id]` — go straight to
  [references/05-rollback.md](references/05-rollback.md). With no id, list the
  recent versions and ask which one.
