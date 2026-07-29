# The two operations with no CLI coverage

Steps 11 and 14 cannot be done with wrangler 4.114. Both have a REST path; one
of the two bodies is verified, the other is inferred. Treat the inferred one as
an attempt with a fallback, not as a fact.

## Read this before making any call

REST is the default here — this deploy is meant to run without manual clicking.
The dashboard appears only where Cloudflare has no API at all (possibly step 11;
the probe decides).

Credentials, permissions and the safe loading procedure are in
[credentials.md](credentials.md). The short version: the token comes from `.env`,
gets written into `$SCRATCH/cf.curlrc`, and **every call below uses
`curl -K "$SCRATCH/cf.curlrc"`** so that no command line ever contains it. Write
each response to a file and parse the file.

Preflight the read-only probes from credentials.md §3 before any POST. A 403
discovered here costs a minute; a 403 discovered at step 14 costs a half-finished
deploy.

---

## Step 11 — add a routing subdomain

**Status: no documented API.** `wrangler`'s bundled Cloudflare SDK exposes
`email/routing/{enable,disable,dns,unlock,rules,addresses,zones,summary}` and
`email/sending/subdomains` — but **no** `email/routing/subdomains`. The docs
describe only a dashboard flow. So this is a best-effort attempt followed by a
fallback.

The Phase 1 probe already told you whether the endpoint exists. If it returned
404, skip straight to the dashboard path below — do not POST to an endpoint that
does not answer GET.

If the probe returned 200, attempt:

```bash
curl -K "$SCRATCH/cf.curlrc" -X POST \
  -H 'Content-Type: application/json' \
  --data '{"name":"<MAIL_HOST>"}' \
  -o "$SCRATCH/sub.json" -w '%{http_code}\n' \
  "https://api.cloudflare.com/client/v4/zones/<ZONE_ID>/email/routing/subdomains"
```

Then read `$SCRATCH/sub.json`. If it is not `"success": true`, **do not retry with
guessed variants** — fall back, and record the actual error in the state file so
this reference can be corrected.

Fallback — dashboard, with a deep link built from the real account id:

```
https://dash.cloudflare.com/<ACCOUNT_ID>/<ZONE>/email-service/routing
```

Then: select the apex domain → **Settings** → under **Subdomains**, enter `mail`
in the inline form and submit. Cloudflare adds the required DNS records to the
subdomain.

Stop and wait for the user to confirm. Then verify:

```bash
dig +short MX <MAIL_HOST>     # expect *.mx.cloudflare.net
```

DNS on a Cloudflare-hosted zone usually lands in 5–15 minutes. An empty answer
right after the change is propagation, not failure — wait and re-check before
reporting a problem.

---

## Step 14 — subscribe the events queue

**Endpoint verified** by reading wrangler's bundled SDK
(`resources/queues/subscriptions.mjs`):

```
POST   /accounts/{account_id}/event_subscriptions/subscriptions
PATCH  /accounts/{account_id}/event_subscriptions/subscriptions/{id}
GET    /accounts/{account_id}/event_subscriptions/subscriptions
DELETE /accounts/{account_id}/event_subscriptions/subscriptions/{id}
```

**Body shape verified** from wrangler's own `queues subscription create`
handler — `name`, `enabled`, `source`, `destination`, `events`, where
`destination` is `{"type":"queues.queue","queue_id":"<id>"}` and source variants
use snake_case extra keys (`model_name`, `worker_name`, `workflow_name`).

**The `email.sending` source shape is VERIFIED** (2026-07-29, first attempt,
HTTP 200):

```json
"source": { "type": "email.sending", "zone_id": "<zone id>", "domain": "mail.<zone>" }
```

Snake_case `zone_id`, even though event *payloads* use camelCase `zoneId`. The
response echoes the source back with an extra `"name": "Email Service"` field that
the request does not need to send. The public API reference does not document this
source at all — it lags, as it also omits `artifacts`, which the CLI supports.

Get the queue id first:

```bash
WR queues info mailworker-events        # prints the queue id
```

Build the body as a file first — no inline JSON with expansions, so nothing
sensitive or malformed can end up echoed:

```bash
python3 - <<'PY'
import json, os, pathlib
body = {
    "name": "mailworker delivery events",
    "enabled": True,
    "source": {
        "type": "email.sending",
        "zone_id": "<ZONE_ID>",
        "domain": "<MAIL_HOST>",
    },
    "destination": {"type": "queues.queue", "queue_id": os.environ["QUEUE_ID"]},
    "events": [
        "message.delivered",
        "message.deferred",
        "message.bounced",
        "message.failed",
        "message.rejected",
        "message.complained",
    ],
}
pathlib.Path(os.environ["SCRATCH"], "sub-body.json").write_text(json.dumps(body))
print("body written")
PY

curl -K "$SCRATCH/cf.curlrc" -X POST \
  -H 'Content-Type: application/json' \
  --data @"$SCRATCH/sub-body.json" \
  -o "$SCRATCH/sub.json" -w '%{http_code}\n' \
  "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/event_subscriptions/subscriptions"
```

All six event types, not a subset: `workers/queue.ts` maps every one of them, and
a missing `bounced` costs a suppression.

If the call is rejected, edit the body file to use `zoneId` instead of `zone_id`
and retry once — the only variant worth a second attempt, since event payloads use
camelCase. Then stop and report. Record the exact error either way so this
reference can be corrected.

Fallback — dashboard:

```
https://dash.cloudflare.com/<ACCOUNT_ID>/workers/queues
```

Select `mailworker-events` → **Subscriptions** → **Subscribe to events** → name
it → source **Email Sending** → select `<MAIL_HOST>` → select all six
events → **Subscribe**.

Verify either path:

```bash
WR queues subscription list mailworker-events
```

If this step ends up skipped, name the degradation precisely rather than calling
the deploy incomplete: the delivery timeline stops at `queued` (the send-time
result is still recorded), and hard bounces no longer feed the account
suppression list. Everything else — receiving, `wait`, sending, the dashboard,
the approval queue — works.

---

## Prerequisite ordering

The subscription is scoped to a **verified** sending domain. If step 13 has just
run and the domain is still `unverified`, the subscription may be rejected for
that reason rather than a bad body. Check first:

```bash
WR email sending list <MAIL_HOST>
```

If it is not yet verified, mark step 14 `manual` with a note to re-run it after
verification, and put the re-run command in the final report. Do not block the
rest of the deploy on it.
