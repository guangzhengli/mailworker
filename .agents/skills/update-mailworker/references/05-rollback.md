# Rollback

Read this **before** phase 3, not after phase 4. What a rollback can and cannot
recover is what determines whether a given change needs a second deploy to be safe
— and that is a decision made before shipping.

## Rolling back the code

```bash
WR versions list --name mailworker            # ten most recent, with ids and timestamps
WR rollback <version-id> --name mailworker -m "reason"
```

Rollback re-points production at a version that is already uploaded, so it is
fast and needs no build. The `-m` message shows up in the deployment history;
write the actual reason, since the next person reading it is likely to be the user
in three months.

`WR deployments list` shows the ten most recent deployments;
`WR deployments status` shows what is live now. Confirm with `status` after
rolling back — the live version id must be the one you named.

## What a rollback does not undo

Four things. Each one is a reason to think before shipping, not after:

| Not undone | Consequence | The actual remedy |
|---|---|---|
| **D1 migrations** | The schema stays at the new version while the code goes back to the old. An additive migration is harmless here — old code ignores a new column. A destructive one is not: the old code queries something that no longer exists | A forward migration that restores the column, or `d1 time-travel restore` — which rewinds the **entire database** and discards every message received since that timestamp |
| **Durable Object migrations** | A renamed class stays renamed; a deleted class stays deleted, along with its storage. The rolled-back code references a class that is gone and the DO binding fails | A new migration that renames it back. Deleted storage is gone for good |
| **R2 objects** | Raw MIME and attachments written by the new version stay | Nothing needed — R2 is additive here, and stray objects are harmless |
| **Consumed queue messages** | A message the new consumer already acked is not replayed. One it failed 3× on is in the DLQ | Re-drive from the DLQ, or re-send. Check `WR queues info mailworker-dispatch-dlq` |

Secrets and DNS are likewise unaffected by a rollback, which in their case is
usually what you want.

The practical rule this yields: **an additive migration is rollback-safe, a
destructive one is not.** That is precisely why [02-migrations.md](02-migrations.md)
puts destructive migrations *after* the deploy — so there is a window in which the
code can go back and the schema has not yet moved.

## D1 point-in-time restore

The last resort, not a plan:

```bash
WR d1 time-travel info mailworker
WR d1 time-travel restore mailworker --timestamp <ISO 8601>
```

Time Travel covers a 30-day window. It restores the whole database to that instant,
so **every message received since is lost**. Before using it on a database holding
real mail, export first (`WR d1 export mailworker --remote --output …`) so the
current state is recoverable if the restore turns out to be the wrong call.

`d1 migrations apply` also captures a backup on Cloudflare's side, per wrangler's
own help text, and a migration that errors mid-run is rolled back with the previous
one left applied. That covers a *failed* migration. It does nothing for a migration
that succeeded and was wrong — which is the failure mode worth fearing.

## Deciding whether to roll back

Roll back when the live deployment is worse than the previous one: 5xx on `/v1`,
the dashboard failing to render, `doctor` newly failing a check that passed, or a
DLQ filling up.

Do not roll back for something a forward fix handles in the same number of steps —
a stale `sending_status` row, a cosmetic bug, a missing asset that a rebuild fixes.
Rolling back has its own cost: it discards whatever else shipped in the same
version.

Either way, state the choice and the reason in one line, and give the user the
exact command rather than doing it silently — a rollback is outward-facing and the
call is theirs unless they have already said to fix it however you see fit.
