# Troubleshooting

## Pre-existing repo blockers

These are not deploy mistakes — they are in the repo as committed. Phase 4 fixes
the first two; the third only needs the right runner.

| Symptom | Cause | Fix |
|---|---|---|
| `deploy` fails on the Durable Object migration | `migrations[0]` uses `new_classes`; new accounts cannot create key-value-backed DO namespaces | Phase 4 step 4 — `new_sqlite_classes`. `MessageWaiter` stores nothing, so nothing else changes |
| `deploy` fails on the D1 binding, or binds nothing | `database_id` is `PLACEHOLDER_RUN_MAILWORKER_DEPLOY` | Phase 4 steps 1–2 |
| `node packages/cli/src/bin.ts` → `ERR_MODULE_NOT_FOUND: @cli/main` | `bin` points at a `.ts` file and there is no build step; bare `node` cannot resolve the `@cli/*` alias | Run it through `tsx`, which reads `tsconfig.base.json` paths: `cd packages/cli && ../../node_modules/.bin/tsx src/bin.ts <cmd>`. Verified working for every subcommand. `tsx` is only a transitive dep today — worth making explicit, but not as part of a deploy |

## Deploy-time failures

| Symptom | Likely cause | Check |
|---|---|---|
| `queues list` fails with a plan error | Not on Workers Paid | Queues are required by the config; there is no free path that keeps sending, webhooks and delivery events working |
| `deploy` complains a queue does not exist | One of the six was not created, most often a `-dlq` | `WR queues list` — all six, including the three DLQs |
| Dashboard loads blank | `build/client` missing or stale | `pnpm --filter @mailworker/web build`, then re-deploy |
| `secret put` fails | Worker does not exist yet | Secrets come after step 7 |
| `d1 migrations apply --remote` applies nothing | Pointed at the local database | `--remote` is not the default |

## Email failures

| Symptom | Likely cause | Check |
|---|---|---|
| `email routing enable mail.<zone>` → "Could not find zone" | Routing commands do an exact zone-name lookup | Pass the apex, or `--zone-id` |
| Catch-all rule saved but mail never arrives | MX not propagated on the subdomain, or the subdomain was never added to routing | `dig +short MX mail.<zone>`; then `WR email routing rules get <zone> catch-all` |
| Mail arrives but every message is rejected | No `domains` row, or `name` does not match the recipient domain exactly | `SELECT name FROM domains` — must be lowercase and exact |
| Inbound rejected as `unknown_domain` | Same as above | Same |
| Inbound rejected as `no_such_inbox` | Working as designed: `catchall_mode='reject'` and no inbox exists at that address | Create an inbox first, or switch the mode deliberately |
| `createInbox` throws "No sending domain is configured" | `domains` table is empty | Phase 4 step 15 |
| `createInbox` throws "This deployment serves N domains" | More than one `domains` row and no explicit `domain` argument | Keep one row, or always pass `domain` |
| Sending fails only for real recipients | Sending domain not verified yet — Cloudflare accepts only account-verified addresses until then | `WR email sending dns get mail.<zone>` |
| `doctor` reports MX `fail` forever | A `domains` row whose MX does not point at Cloudflare — e.g. a send-only apex row | Do not add a row for a domain that does not receive; `DomainHealthPolicy.mx` returns `fail` and the CLI turns any `fail` into a non-zero exit |
| Renaming the Worker silently breaks inbound | Routing rules bind to the Worker name | After any rename, re-run the catch-all update |

## Renaming and re-running

`wrangler deploy` is safe to re-run. The dangerous re-run is anything that
touches DNS while mail is flowing. Before re-running step 10 on a zone that
already has routing enabled, check `WR email routing settings <zone>` — it is
harmless when already enabled, but confirm rather than assume.

## Resuming a failed run

`.mailworker/deploy-state.json` holds the per-step status. On `--resume`:

1. Read the state file.
2. Re-run the **verification** for the last `done` step — the state file can be
   stale if the process was killed between the command and the write.
3. Continue from the first step that is not `done` or `skipped`.
4. A step marked `manual` needs the user again; do not silently retry the API.

## When something is genuinely unclear

Load the sibling skills rather than guessing: `wrangler` for CLI flags,
`cloudflare-email-service` for Email Service behaviour, `durable-objects` for DO
migrations, `workers-best-practices` for config review. All four prefer retrieval
over pre-training, and so should this one — `cloudflare-docs` search and
`--help` beat recalled flags every time.
