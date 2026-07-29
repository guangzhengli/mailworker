# Credentials

Two credentials are in play, and they are not interchangeable.

| Credential | Source | Used by | Do you need to ask for it? |
|---|---|---|---|
| wrangler OAuth token | `wrangler login` | every `wrangler` command | No — already present, scopes verified sufficient |
| `CLOUDFLARE_API_TOKEN` | `.env` at the repo root | the two REST-only operations (steps 11, 14) | Yes, if absent — this skill runs fully automated and there is no click-free alternative |

The OAuth token is never read, copied, or used as a Bearer token. See "Why not
the OAuth token" below.

## Step 1 — detect, without printing

`.env` lives at the repo root and is covered by `.gitignore:25`. Detect presence
and non-emptiness in one command that cannot echo the value:

```bash
test -f .env && grep -cE '^[[:space:]]*CLOUDFLARE_API_TOKEN=..*$' .env || echo 0
```

`1` means a key with a non-empty value. `0` or a missing file means go to step 4.

Do **not** `cat .env`, do not `grep` without `-c`, and do not assign the value to
a shell variable. The count is all you need.

## Step 2 — load it safely

The failure mode to design against: a shell error echoes the **expanded** command
line, so any token that appears in a command — even via `"$VAR"` — can leak. The
fix is to put the token in a file curl reads, so no command line ever contains it.

Write a curl config into the scratchpad. The heredoc is quoted (`<<'PY'`), so
nothing in it is expanded by the shell:

```bash
python3 - <<'PY'
import os, pathlib, re, stat
env = pathlib.Path(".env").read_text()
m = re.search(r'^[ \t]*CLOUDFLARE_API_TOKEN[ \t]*=[ \t]*(.+)$', env, re.M)
if not m:
    raise SystemExit("CLOUDFLARE_API_TOKEN not found in .env")
tok = m.group(1).strip().strip('"').strip("'")
if not tok:
    raise SystemExit("CLOUDFLARE_API_TOKEN is empty")
out = pathlib.Path(os.environ["SCRATCH"]) / "cf.curlrc"
out.write_text('header = "Authorization: Bearer %s"\nsilent\n' % tok)
out.chmod(stat.S_IRUSR | stat.S_IWUSR)
print("curl config written, %d bytes" % out.stat().st_size)
PY
```

Every subsequent call then looks like this, with nothing sensitive on the line:

```bash
curl -K "$SCRATCH/cf.curlrc" -o "$SCRATCH/resp.json" -w '%{http_code}\n' \
  "https://api.cloudflare.com/client/v4/user/tokens/verify"
```

Parse `$SCRATCH/resp.json` with `python3`; never pipe a response body through a
command whose text includes the token.

Delete the config when Phase 4 ends, on success or failure:
`rm -f "$SCRATCH/cf.curlrc"`.

## Step 3 — preflight the permissions with read-only probes

Do not trust a static permission list, including the one below. Probe each
endpoint the deploy will actually use, before mutating anything, and read the
required permission off the failure rather than guessing.

| Probe (all read-only) | Proves | Used by |
|---|---|---|
| `GET /user/tokens/verify` | the token is active and not expired | everything |
| `GET /zones?name=<zone>` | zone read | zone id lookup |
| `GET /zones/{zone}` | the zone is inside the token's Zone Resources | everything zone-scoped |
| `GET /zones/{zone}/email/routing/rules` | Zone · Email Routing on this zone | the catch-all, if ever done over REST |
| `GET /accounts/{account}/event_subscriptions/subscriptions` | Queues read | **step 14 — the only step that needs this token** |
| `GET /zones/{zone}/email/sending/subdomains` | Email Sending read on the zone | step 14's source scoping |

Do **not** probe `GET /zones/{zone}/email/routing` or
`.../email/routing/subdomains` to test permissions. Neither path exists, and the
status they return is misleading — see below.

### Interpreting the codes — read this before diagnosing a 403

**A 403 is not proof of a missing permission.** Verified by controlled experiment
on 2026-07-29: this API returns different codes for an unmatched route depending
on the prefix.

| Prefix | Unmatched route returns |
|---|---|
| `/zones/{z}/email/routing/*` | **403** `code=10000 "Authentication error"` |
| `/zones/{z}/email/sending/*` | 404 |
| `/zones/{z}/email/*` | 400 |
| `/accounts/{a}/email/**` | 400 |

So before reporting any 403 as a permission problem, **run a control probe**: hit
a deliberately nonsensical sibling path such as
`/zones/{z}/email/routing/zzz-does-not-exist`. If the control returns the same
code, the route does not exist and the token is fine.

Then:

- `200` — good.
- `403` **and** a control probe on the same prefix returns 200-able siblings while
  the nonsense control returns something different — genuine permission problem.
  Report the endpoint and message verbatim, then step 4.
- `403` **and** the nonsense control returns 403 too — the endpoint does not
  exist. Not a token problem. Do not send the user to fix permissions.
- `401` — either an invalid token, or a real endpoint whose permission the token
  lacks. `GET /accounts/{a}/email/routing/zones` returns 401 for a token without
  account-level Email Routing; it is not needed by this deploy.
- `400` at the account level — unmatched route.

### Settled: an API token cannot reach Email Routing settings at all

The single most important credential fact in this repo, established 2026-07-29
with a controlled experiment across two zones:

| Endpoint | API token | OAuth (wrangler) |
|---|---|---|
| `/zones/{z}/email/routing/rules` | **200** | 200 |
| `/zones/{z}/email/routing/rules/catch_all` | **200** | 200 |
| `/zones/{z}/email/routing` (settings) | **403** | **200** |
| `/zones/{z}/email/routing/dns` | **403** | 200 (via `dns get`) |
| `/zones/{z}/email/routing/subdomains` | **403** | untested |

Tested against both a zone with routing `unconfigured` and a zone with routing
**already enabled** — identical results, so "routing not enabled yet" is not the
cause. Also tested with the token scoped to all zones and all accounts — no
change.

Why: the only zone-category permission group for this service is **Email Routing
Rules** (Read/Edit), and it covers only the `/rules*` paths. The settings, DNS,
enable/disable and unlock endpoints have no corresponding permission group, so no
API token configuration reaches them. The OAuth credential works because its
scope is service-level (`email_routing:write`).

**Consequences:**

- Never send the user to add API-token permissions for a 403 on
  `/email/routing`, `/email/routing/dns` or `/email/routing/subdomains`. There is
  nothing they can add. Saying otherwise wastes their time — it already did once.
- Because 403 is returned before route matching, whether
  `/email/routing/subdomains` exists is **still unknown**. Do not claim either way.
- `POST /zones/{z}/email/routing/dns` with a `name` body field is documented as
  "Add and lock the necessary MX and SPF records" and is the most plausible
  subdomain mechanism. wrangler does not expose it (`email routing dns` offers only
  `get` and `unlock`). Reaching it requires the OAuth credential.

A 403 whose sibling `/rules` returns 200 is therefore a **credential-type**
finding, not a permission finding. Report it that way.

Run every probe before starting Phase 4, and put the results in the Phase 3 plan.
The user asked for full automation, so discovering at step 11 that a permission
is missing is a worse outcome than a one-minute preflight.

## Step 4 — what to tell the user when the token is missing or insufficient

Be specific. Give the navigation path, the exact permission rows, and the
resource scoping. Do not hand over a vague "create a token with email
permissions".

**Where:** Cloudflare dashboard → the account menu → **My Profile** → **API
Tokens** → **Create Token** → **Create Custom Token** (not a template).

**Permissions** — add these rows. The three-column picker is
`<category> · <permission group> · <level>`:

| Category | Permission group | Level | Why | Confidence |
|---|---|---|---|---|
| Zone | **Email Routing Rules** | Edit | add the routing subdomain, manage rules (step 11) | name inferred — the probe confirms |
| Zone | **DNS** | Edit | the subdomain's MX/SPF/DKIM records | confirmed |
| Zone | **Zone** | Read | resolve the zone by name | confirmed |
| Account | **Queues** | Edit | create the delivery-event subscription (step 14) | confirmed |
| Account | **Email Sending** | Edit | scope the subscription to the sending domain | name inferred — the probe confirms |

**Resources** — scope it, do not leave it account-wide:

- **Account Resources**: Include → the account that owns the deployment.
- **Zone Resources**: Include → **Specific zone** → the target zone only.

Optionally set a TTL under **TTL**, and an IP filter if they want one. Then
**Continue to summary** → **Create Token**. The secret is shown **once**.

**Then, in the repo root:**

```bash
printf 'CLOUDFLARE_API_TOKEN=%s\n' '<paste the token>' >> .env
chmod 600 .env
```

Tell them `.env` is already gitignored (`.gitignore:25`), so it will not be
committed — but that it is plaintext on disk, so the TTL and the zone scoping are
what limit the damage if the machine is compromised.

What the token does **not** need, and should not be given: Workers Scripts, D1,
R2, or Workers KV. Those all go through `wrangler`, which authenticates with the
login OAuth token. A token that can only touch email routing and queues is a much
smaller thing to leak.

After they have added it, re-run from Phase 1 — the detection is a Phase 1 check,
and re-running is cheap and read-only.

## Why not the OAuth token

`wrangler`'s stored token at
`~/Library/Preferences/.wrangler/config/default.toml` (macOS) does work as a
Bearer token, and it already carries `email_routing` and `queues` write. It is
still off-limits:

- It is broad. It also carries `workers`, `d1`, `queues`, `secrets_store` and
  more, all write — a far worse thing to leak than a two-permission token.
- It cannot be scoped to one zone or given a TTL.
- Scraping it requires reading it into the shell, which is precisely how a token
  leaked into a transcript in this repo already: a compound command failed and the
  shell echoed the expanded command line.

If a token does leak, say so immediately and have the user rotate:
`wrangler logout && wrangler login` for the OAuth token, or delete and recreate
the API token in the dashboard.
