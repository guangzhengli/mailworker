# DNS, Email Routing and Email Sending

Read this before any `wrangler email` command. The asymmetry between receiving
and sending is the source of every hazard in this deploy.

## The one fact everything follows from

Receiving and sending occupy different DNS records:

| | Email Routing (inbound) | Email Sending (outbound) |
|---|---|---|
| Records it owns | **MX on the exact hostname**, SPF TXT on the hostname, DKIM at `cf2024-1._domainkey.<host>` | MX on `cf-bounce.<host>`, SPF TXT on `cf-bounce.<host>`, DKIM at `cf-bounce._domainkey.<host>`, DMARC at `_dmarc.<host>` |
| Exclusive? | **Yes** — one hostname has one MX set | No — everything lives under `cf-bounce.*` |
| Coexists with a hosted mailbox provider on the same host? | No | **Yes** |
| Onboarding scope | Zone-level, applies to the apex; subdomains are added from inside the apex's routing settings | Per domain, each onboarded separately |
| CLI can target a subdomain directly? | **No** — commands use an exact zone-name lookup | **Yes** — walks up the labels to the parent zone |

So: receiving must be split onto a subdomain if the apex belongs to someone
else; sending never has to be. A common wrong conclusion is that Email Sending's
bounce MX collides with an existing mailbox provider — it does not, because that
MX is on `cf-bounce.<host>`, a different hostname.

## The apex hazard

`wrangler email routing enable <zone>` writes Cloudflare's MX and SPF to the
**apex** and locks them. If the apex currently has working MX records pointing
at a mailbox provider, enabling routing breaks inbound mail for that provider
until the records are restored.

The escape hatch, when the user later wants a provider on the apex:

```bash
WR email routing dns unlock <zone>
# then in the dashboard: remove Cloudflare's apex MX, add the provider's
```

Only Email Routing records on the root domain support unlocking. Email Sending's
`cf-bounce` records stay Cloudflare-managed for the lifetime of the domain
configuration. Subdomain routing records are unaffected by unlocking the apex —
that is what makes "apex for humans, subdomain for the agent" work.

## Why the CLI resolvers differ

Verified by reading wrangler 4.114's bundle:

- `email routing enable | disable | settings | dns | rules | addresses` call
  `resolveZoneId`, which does `GET /zones?name=<domain>` — an **exact** match.
  Give these the apex, or pass `--zone-id`. Passing a subdomain fails with
  "Could not find zone".
- `email sending enable | list | dns` call `resolveDomain`, which loops over the
  label suffixes until a zone matches, then keeps the full domain as the target.
  Give these the subdomain directly.

## The catch-all is zone-level

The catch-all is a single rule per zone:
`PUT /zones/{zone_id}/email/routing/rules/catch_all`. There is no per-subdomain
catch-all. Consequences:

- Address it by the apex, even though the mail it actually receives arrives for
  the subdomain (the apex has no live sender pointing at it once its MX moves to
  another provider).
- If mail does arrive for the apex while Cloudflare still holds its MX, the
  catch-all sends it to the Worker, and `AddressResolutionPolicy` rejects it with
  `unknown_domain` because only `mail.<zone>` is in the `domains` table. A real
  SMTP rejection, which is the right answer — a silent drop is what makes a
  catch-all domain a spam sink.
- `--match-type`, `--match-field` and `--match-value` are ignored for
  `catch-all`. Do not pass them.

One catch-all rule is the architecture, not a shortcut: routing rules cap at 200
per domain, so a rule per inbox puts a hard ceiling on the product. Inbox
ownership is resolved inside the Worker by `AddressResolutionPolicy`. **Never
create a routing rule per inbox.**

## DKIM selectors — do not mix them up

| Selector | Belongs to | Used by |
|---|---|---|
| `cf-bounce` | Email Sending | this repo's `domains.dkim_selector` and `DomainHealthPolicy.dkim` |
| `cf2024-1` | Email Routing | forwarded inbound mail; not what `doctor` checks |

`doctor` looks up `<selector>._domainkey.<domain>` and reports `unknown` — not
`fail` — when the selector is null, because Cloudflare owns the key and the
selector is not derivable from the domain name.

## Limits worth knowing

- 30 domains per zone configured for Routing or Sending combined, apex included.
- 200 routing rules per domain; 200 verified destination addresses per account.
- Inbound message ceiling 25 MiB. Outbound 5 MiB (25 MiB to addresses verified
  on the account), 50 recipients total across to+cc+bcc, 16 KB of custom headers.
- Before a sending domain is verified, Cloudflare only accepts mail to addresses
  already verified on the account. This is the most confusing failure a fresh
  deployment hits: sending works against your own address, then fails against a
  real recipient. `DomainHealthPolicy.sendingStatus` exists to surface it.
- Daily sending quota ramps with reputation; there is no fixed number.

## SPF and DMARC coexistence

A hostname may have only one SPF TXT record and one DMARC record. If another
service already publishes SPF there, merge the `include:` entries rather than
adding a second record, and watch the 10-lookup limit.

DMARC lookups fall back from `_dmarc.<subdomain>` to the organizational domain's
`sp=` policy. If the apex publishes `p=reject` with no `sp=`, a subdomain
inherits reject — so confirm DKIM is live on the subdomain before sending
through it.

Services that need only SPF/DKIM/CNAME (transactional or marketing senders) can
share a hostname with Email Routing. Services that need MX (hosted mailboxes)
cannot.
