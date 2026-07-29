# Phase 4 — Verify

A deploy that printed "Deployed" is not a deploy that works. Run the tier that
matches what changed; do not run a full mail round trip for a CSS change, and do
not skip it for a change to `workers/email.ts`.

## Tier 1 — always

```bash
WR deployments status --name mailworker      # version id differs from phase 1
```

Then wait a few seconds and:

```bash
curl -s -o /dev/null -w '%{http_code}\n' <WORKER_URL>/v1
curl -s <WORKER_URL>/login | grep -o '<title>[^<]*</title>'
```

Expect `401` from `/v1` — the router is alive and correctly rejecting an
unauthenticated request — and `<title>Sign in · Mailworker</title>` from `/login`.

**Retry before believing a 404.** Assets and routes propagate after the deploy
prints, and grepping the body rather than trusting the status code is what
distinguishes a live SSR response from an edge placeholder.

## Tier 2 — when anything server-side changed

The repo's own CLI, which reads `.mailworker/config.json` so no credential reaches
a command line:

```bash
./node_modules/.bin/tsx --tsconfig packages/cli/tsconfig.json packages/cli/src/bin.ts doctor
```

Both halves of that invocation matter, and getting either wrong wastes a round
trip:

- `--tsconfig packages/cli/tsconfig.json` — the repo root has only
  `tsconfig.base.json`, so tsx finds no `paths` mapping and `@cli/main` fails with
  `ERR_MODULE_NOT_FOUND`.
- **cwd must be the repo root** — `config.ts` reads `join(process.cwd(),
  ".mailworker", "config.json")`. From inside `packages/cli` it reports "No
  deployment URL".

Do not build that into a shell variable: zsh does not word-split unquoted
parameters, so `T="./node_modules/.bin/tsx --tsconfig …"; $T doctor` fails with
`no such file or directory`.

`doctor` exits non-zero if any domain check is `fail` or the dispatch queue is
unconfigured, so its exit code is the gate. Report the actual check table — MX,
SPF, DKIM, DMARC, sending status, send binding, dispatch queue — not just the exit
code.

Expect `sending_status` to still read whatever the `domains` row says. If Cloudflare
has since verified the sending domain, the row is stale and the fix is one
`UPDATE`, not a deploy:

```bash
WR email sending dns get <MAIL_HOST>
WR d1 execute mailworker --remote --command \
  "UPDATE domains SET sending_status='verified' WHERE name='<MAIL_HOST>'"
```

## Tier 3 — when mail handling changed

Anything touching `workers/email.ts`, `workers/queue.ts`, the parser, address
resolution, `SendPolicy`, or the D1 schema. Run a real round trip; nothing else
proves the path.

```bash
./node_modules/.bin/tsx --tsconfig packages/cli/tsconfig.json packages/cli/src/bin.ts inbox create --prefix verify
```

Note `--prefix`, not `--kind`. Then send to the minted address — from an outside
account, or with Cloudflare's own sender:

```bash
WR email sending send --from deploy-test@<MAIL_HOST> --to <minted address> \
  --subject "post-deploy check" --text "ok"
```

And block on arrival:

```bash
./node_modules/.bin/tsx --tsconfig packages/cli/tsconfig.json packages/cli/src/bin.ts \
  wait --inbox <inbox id> --timeout 90s
```

A message coming back proves the whole chain in one shot: Email Sending → the
Email Routing MX → the catch-all → `email()` → D1 → the Durable Object rendezvous.
If it times out, the decision tree is in
[deploy-mailworker's troubleshooting reference](../../deploy-mailworker/references/troubleshooting.md).

## Tier 4 — when the queue consumers or the cron changed

```bash
WR queues info mailworker-dispatch          # backlog draining, not growing
WR queues info mailworker-dispatch-dlq      # should stay at 0
WR queues info mailworker-events-dlq        # should stay at 0
```

A DLQ that gained messages right after a deploy is the in-flight payload problem
from [02-migrations.md](02-migrations.md) §In-flight queue messages. Say so
explicitly and name the rollback as the fix — those messages are real sends.

For a cron change, confirm the trigger set is what you intended (`WR deployments
status` echoes the triggers) and check the next run in the Cloudflare dashboard's
Worker → Settings → Trigger Events. There is no CLI command to force a scheduled
run against production; `wrangler dev --test-scheduled` exercises it locally only.

## Report

1. **Shipped** — the new version id, and the old one as the rollback target.
2. **What changed** — one line, from the phase 2 classification.
3. **Migrations** — applied or none, by filename.
4. **Verification** — the tier run and its actual output. If a tier was skipped
   because it did not apply, say which and why.
5. **Interrupted** — mention any in-flight `wait` that the deploy would have
   dropped, if the user might have had one running.
6. **Still uncommitted** — the `wrangler.jsonc` diff is still only in the working
   tree. Restate it briefly; it is the thing most likely to bite the next deploy.

If any verification failed, lead with that, give the real output, and offer the
rollback command from [05-rollback.md](05-rollback.md) — do not bury a failure
under a list of what worked.
