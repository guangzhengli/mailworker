# Phase 3 — Deploy

Run the steps phase 2 chose, in the order phase 2 chose. Stop on the first
failure, report the real output, and say what state the deployment is in — a
half-applied update is worth naming precisely.

## The core sequence

```bash
pnpm --filter @mailworker/web build          # vite → apps/web/build/client
WR deploy
```

Two commands, separately rather than via the repo's own `deploy` script
(`vite build && wrangler deploy`), because a separate build gives a clean failure
boundary: a Vite error and an upload error need different responses.

`assets.directory` is `./build/client`, so **skipping the build ships the previous
bundle**. The Worker code would be new and the dashboard stale — a mismatch that
looks like a caching bug and costs an hour. Always build, even when the diff looks
server-only; Vite is fast and the alternative is a wrong answer.

Where the migration step goes:

- additive → between `build` and `deploy`
- destructive → after `deploy`

Everything else (a new secret, a new resource for a new binding) goes **before**
the build.

## Verify the deploy landed

```bash
WR deployments status --name mailworker
```

The version id must differ from the one recorded in phase 1. Same id means nothing
shipped — usually an upload that failed after printing progress.

Then wait a few seconds before curling. Routes and assets propagate *after*
`Deployed … triggers` prints, and an immediate request returns 404 for dashboard
paths while `/v1` already answers. That transient 404 has been misread as a broken
dashboard in this repo before. Full checks in [04-verify.md](04-verify.md).

## What a deploy interrupts

Worth a sentence in the report; both are brief and neither is a fault:

- **In-flight `wait` calls.** The new version evicts the running `MessageWaiter`
  instances, and a caller holding an open request to one loses its rendezvous. A
  `wait --timeout 90s` in progress will not receive its message. Do not deploy
  while someone is running a long `wait`; nothing recovers it.
- **Open dashboard WebSockets.** These reconnect on their own —
  `apps/web/app/live.ts:78` reconnects with exponential backoff on close. No action
  needed, and live updates resume within seconds.

Inbound mail is not at risk: Email Routing retries, and the catch-all points at the
Worker by name, not at a version.

## New bindings

A binding added to `wrangler.jsonc` must have its resource created first, or the
deploy fails on an unresolvable binding. Only create what the new code actually
needs — never re-create what already exists.

| New binding | Create it with |
|---|---|
| Queue | `WR queues create <name>` — and its DLQ, if the consumer names one |
| R2 bucket | `WR r2 bucket create <name>` |
| D1 database | `WR d1 create <name>`, then paste the id into the config by hand. Do not accept wrangler's offer to write the binding — it names the binding after the database and would break every `env.DB` reference |
| KV namespace | `WR kv namespace create <name>` |
| DO class | no resource to create; it needs a migration entry — [02-migrations.md](02-migrations.md) §Durable Object migrations |

A new **consumer** on an existing queue also needs its DLQ to exist before the
deploy, because the consumer references it by name.

## New secrets

Through a file, never through argv — a shell error echoes the expanded command
line, which is how a token leaked into a transcript in this repo already.

```bash
umask 077
printf '%s' '…' > "$SCRATCH/secret-value"     # or have the user write the file
WR secret put SOME_NAME --name mailworker < "$SCRATCH/secret-value"
rm -f "$SCRATCH/secret-value"
```

Verify with `WR secret list --name mailworker`, which prints names only.

Setting a secret takes effect immediately on the running version, without a deploy.
Removing one (`secret delete`) while the live code still reads it is a runtime
failure, so deploy the code that stopped needing it first.

**`MAILWORKER_ADMIN_KEY` is not in scope here.** See the do-not-touch list in
[SKILL.md](../SKILL.md). If the user wants it rotated, that is a deliberate
separate request: it logs every dashboard session out, because
`session.ts:47` falls back to it as the session-sealing secret, and
`.mailworker/config.json` has to be rewritten in the same breath or the CLI breaks.

## Cleanup

If any scratch file held a secret, delete it now, on success or failure. The
scratchpad is session-scoped, but a credential left on disk for the rest of a
session is still a credential left on disk.
