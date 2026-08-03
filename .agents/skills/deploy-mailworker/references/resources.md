# The resources, and what each one is for

Eleven resources. Knowing why each exists is what lets you tell a real failure
from a cosmetic one, and what to keep when tearing down.

| Resource | Name | Purpose | Degrades to |
|---|---|---|---|
| Worker | `mailworker` | All four entrypoints: `/v1` API + SSR dashboard (`fetch`), inbound mail (`email`), dispatch + delivery events (`queue`), retention sweep (`scheduled`) | nothing — this is the deployment |
| Static assets | `./build/client` | Dashboard client bundle, served off the edge so a page load does not cost a Worker request against a Worker that is also handling mail | broken dashboard, API unaffected |
| D1 | `mailworker` | System of record: messages, inboxes, deliveries, identities, keys, domains | nothing works |
| R2 | `mailworker-blobs` | Raw MIME, attachments, pending outbound payloads. What makes `get --raw` → `inject` a closed loop | bodies unavailable, metadata still stored |
| Queue | `mailworker-dispatch` | `send` ends at `queued` with the decision already durable; the consumer does the network call | sending stops |
| Queue | `mailworker-dispatch-dlq` | Where a send that failed 3× goes for a human to look at | failed sends vanish |
| Queue | `mailworker-webhooks` | Domain-event fan-out to subscribers. Separate from dispatch because a dead subscriber must not delay anyone's mail | webhooks stop |
| Queue | `mailworker-webhooks-dlq` | Same, 8 retries first | — |
| Queue | `mailworker-events` | **Consumer-only.** Cloudflare publishes the six `cf.email.sending.message.*` types here via the step-14 subscription | delivery timeline stops at `queued`; no auto-suppression |
| Queue | `mailworker-events-dlq` | Losing a bounce means losing a suppression, hence 5 retries then here | — |
| DO namespace | `WAITER` → `MessageWaiter` | `wait` rendezvous + dashboard WebSocket broadcast, one instance per account | `wait` and live updates break |
| Cron | `0 * * * *` | The only thing in the deployment that deletes an expired inbox | ephemeral inboxes stop answering but their rows and R2 objects stay forever |
| Secret | `MAILWORKER_ADMIN_KEY` | Bootstrap credential — a fresh deploy has an empty `api_keys` table and no way to fill it | no way in |

## Idempotency

None of the `create` commands are idempotent; they error when the resource
exists. That is fine and even useful — treat "already exists" as SKIP, not as
failure, and record it that way in the state file.

The exceptions worth knowing:

- `wrangler deploy` is idempotent by design; re-running is how you ship a change.
- `d1 migrations apply` tracks what it has run and is safe to re-run.
- `email routing rules update … catch-all` is a `PUT` — safe to re-run.
- `email routing enable` on an already-enabled zone is harmless.
- The `domains` row `INSERT` will fail on the unique index
  `(account_id, name)` if the row exists. Check with a `SELECT` first.

## Teardown order

If the user ever wants this removed, reverse dependency order. Say plainly that
the D1 and R2 deletions destroy stored mail.

1. `email routing rules update <zone> catch-all --action-type drop` — stop mail
   arriving before anything that handles it goes away.
2. Delete the event subscription (`queues subscription delete mailworker-events
   --id …`).
3. `email sending disable mail.<zone>` — removes the `cf-bounce` records.
4. `email routing disable <zone>` — removes the routing MX/SPF/DKIM. Unlock and
   add the replacement provider's records **first** if mail flow matters.
5. `wrangler delete --name mailworker` — takes the DO namespace and cron with it.
6. `queues delete` ×6.
7. `r2 bucket delete mailworker-blobs` (must be empty first).
8. `d1 delete mailworker`.
9. Revert `wrangler.jsonc` and remove `.mailworker/`.
