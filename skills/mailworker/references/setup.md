# When there is no deployment yet

Mailworker is self-hosted. If `mailworker doctor` cannot reach a deployment,
there is nothing to configure — one has to be provisioned first, on a Cloudflare
account the user controls.

**Do not provision it as a side effect of the task you were asked to do.** It
creates real infrastructure, changes DNS for a domain, and needs a Workers Paid
plan for outbound. Stop and tell the user what it requires.

## What it needs

- A Cloudflare account with a domain on Cloudflare DNS
- **Email Routing** for inbound — free, unlimited, works on the Free plan
- **Email Sending** for outbound — needs **Workers Paid**; 3,000 messages/month
  included, then $0.35 per 1,000

Then, from a clone of [the repo](https://github.com/guangzhengli/mailworker):

```sh
pnpm install
npx skills add guangzhengli/mailworker   # if not already installed
```

The repo ships a `deploy-mailworker` skill under `.agents/skills/` that walks
through first-time provisioning in four gated phases, and an `update-mailworker`
skill for shipping changes to a deployment that already exists. Point the agent
at those rather than improvising `wrangler` commands.

## Once it exists: minting a credential

Two steps, and the order matters.

```sh
# 1. Declare what the agent is allowed to be. Limits it cannot widen.
mailworker identities create --name support-bot \
  --quota 50 --allow '*@customer.example.com'

# 2. Mint a narrow credential bound to that identity.
mailworker keys create --name support-bot --identity support-bot \
  --scope inbox:write --scope message:read --scope message:send
```

Three things about that second command are deliberate:

- **`message:approve` is not in the list, and should never be** for a key an
  agent holds. The approval queue only means something if the principal being
  approved and the principal approving are different.
- **The key is bound to an identity.** The sender rule, the recipient allowlist
  and the quota are all properties *of* an identity, so an unbound credential
  does not get generous limits — it skips those three gates entirely. The API
  refuses the send rather than letting a forgotten flag mint an unmetered sender.
- **An admin key cannot be bound to an identity at all.** It could edit the
  identity's own quota, which would make the metering optional for the thing
  being metered.

The token is printed once, on stdout, with everything else on stderr — so
`mailworker keys create … > key.txt` captures exactly the secret. Only its hash
is stored; **there is no endpoint that reads it back.** A lost key is minted
again, not recovered.

## Which environment to hand an agent

`dev`, `test` and `production` are separate accounts under one project. Give an
agent a key in an environment whose mode is `sandbox` unless it genuinely needs
to reach real people: a sandbox send runs every gate and the full state machine,
then loops the message back into a local inbox, so `wait` still resolves and
nothing reaches a real address or your sending reputation.

Inbound mail is routed to an environment by hostname, so each one wants its own
subdomain — `dev.mail.example.com` beside `mail.example.com`.
