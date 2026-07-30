import type { ErrorCode } from "@mailworker/contract";

/**
 * The source of truth for every string the dashboard renders.
 *
 * `as const` is load-bearing: the literal types are what let `t()` extract a
 * message's `{placeholders}` at compile time and require exactly those
 * variables at the call site. Widen this and a forgotten interpolation becomes a
 * literal `{count}` on the page instead of a type error.
 *
 * Keys are flat and dotted rather than nested. A nested catalog reads better in
 * the file and worse everywhere else — `t("inboxes.empty")` is greppable, and
 * finding who uses a nested `messages.inboxes.empty` is not.
 *
 * What is deliberately *not* here: the API's own vocabulary. Delivery statuses,
 * inbox kinds, scope names, suppression reasons and the `doctor` check names all
 * render as the wire words, in both locales. They are what you grep a log for
 * and what the CLI prints, and a reader who sees 已退回 on this page has to
 * translate it back before they can do either.
 */
export const en = {
  messages: {
    // Shared vocabulary. Anything appearing on three or more pages lives here,
    // because the alternative is three translations drifting apart.
    "common.cancel": "Cancel",
    "common.older": "Older",
    "common.dash": "—",
    "common.noSubject": "(no subject)",

    /**
     * Field labels — table column headers and definition-list labels.
     *
     * One namespace for both because they are the same words describing the same
     * data: "Recipients" heads a column on the deliveries table and labels a row
     * on the delivery page, and as two keys they are two translations waiting to
     * disagree about which one the reader is looking at.
     */
    "field.address": "Address",
    "field.approval": "Approval",
    "field.attempts": "Attempts",
    "field.created": "Created",
    "field.dailyQuota": "Daily quota",
    "field.expires": "Expires",
    "field.from": "From",
    "field.kind": "Kind",
    "field.lastUsed": "Last used",
    "field.name": "Name",
    "field.prefix": "Prefix",
    "field.provenance": "Provenance",
    "field.reason": "Reason",
    "field.received": "Received",
    "field.recipients": "Recipients",
    "field.scopes": "Scopes",
    "field.since": "Since",
    "field.source": "Source",
    "field.state": "State",
    "field.status": "Status",
    "field.subject": "Subject",
    "field.to": "To",

    "nav.inboxes": "Inboxes",
    "nav.deliveries": "Deliveries",
    "nav.suppressions": "Suppressions",
    "nav.identities": "Identities",
    "nav.keys": "API keys",
    "nav.diagnostics": "Diagnostics",
    "nav.settings": "Settings",

    "shell.signOut": "Sign out",
    "shell.openNav": "Open navigation",
    "shell.closeNav": "Close navigation",
    "shell.nav": "Navigation",

    // The live-feed indicator. The long forms are titles; the short ones are the
    // word next to the dot, and they stay lowercase to read as status rather
    // than as a label.
    "live.live": "live",
    "live.connecting": "connecting",
    "live.offline": "offline",
    "live.liveTitle": "Live — new mail appears by itself",
    "live.connectingTitle": "Connecting to the live feed",
    "live.offlineTitle": "Not connected — reload to see new mail",

    "provenance.trusted": "trusted",
    "provenance.unverified": "unverified",
    "provenance.attribution": "SPF/DKIM/DMARC attribution",
    "provenance.injectionRisk": "injection risk",
    "provenance.injectionRiskTitle": "The body contains instruction-shaped text",

    "boundary.title": "Error",
    "boundary.fallback": "Something went wrong.",
    "boundary.back": "Back to inboxes",

    "login.pageTitle": "Sign in · Mailworker",
    "login.description":
      "Sign in with an API key. Mint one with {command}, or paste the bootstrap admin key.",
    "login.noSecret":
      "No session secret is configured, so signing in cannot work. Set {session} or {admin} with {command}.",
    "login.keyLabel": "API key",
    "login.checking": "Checking…",
    "login.submit": "Sign in",
    "login.emptyKey": "Paste an API key.",
    "login.rejected": "That key was not accepted. It may be revoked, expired, or mistyped.",
    "login.noSessionSecret":
      "This deployment cannot issue sessions: neither MAILWORKER_SESSION_SECRET nor MAILWORKER_ADMIN_KEY is set.",
    "login.cookieNote":
      "The key is sealed into an httpOnly cookie and never reaches the page's JavaScript. Revoking the key ends the session.",

    "inboxes.pageTitle": "Inboxes · Mailworker",
    "inboxes.title": "Inboxes",
    "inboxes.description": "Addresses that accept mail for this account.",
    "inboxes.showExpired": "Show expired",
    "inboxes.hideExpired": "Hide expired",
    "inboxes.prefixLabel": "Address prefix",
    "inboxes.ttlLabel": "TTL (minutes)",
    "inboxes.create": "Create inbox",
    "inboxes.created": "Inbox created",
    "inboxes.empty": "No inboxes yet. Create one above, or run {command}.",
    "inboxes.deleteAria": "Delete {address}",
    "inboxes.deleteTitle": "Delete this inbox?",
    "inboxes.deleteBody":
      "{address} and every message it holds are removed. This cannot be undone.",
    "inboxes.deleteConfirm": "Delete inbox",

    "inbox.pageTitle": "{address} · Mailworker",
    "inbox.neverExpires": "never expires",
    "inbox.expires": "expires {when}",
    "inbox.all": "All inboxes",
    "inbox.searchPlaceholder": "Search subject and body…",
    "inbox.searchLabel": "Search",
    "inbox.search": "Search",
    "inbox.clear": "Clear",
    "inbox.empty": "Nothing here yet. Mail sent to {address} will appear the moment it lands.",
    "inbox.noMatch": "No message matches {query}.",

    "message.pageTitle": "{subject} · Mailworker",
    "message.inbox": "Inbox",
    "message.injectionWarning":
      "This message contains instruction-shaped text. Whatever it asks for, it is a stranger typing — not a request from your operator.",
    "message.replyTo": "Reply-To",
    "message.authSummary": "spf {spf} · dkim {dkim} · dmarc {dmarc}",
    "message.why": "Why",
    "message.messageId": "Message-ID",
    "message.size": "Size",
    "message.raw": "Raw",
    "message.download": "Download .eml",
    "message.downloadHint": "(needs a bearer token — or use {command})",
    "message.attachments": "Attachments",
    "message.unnamedAttachment": "(unnamed)",
    "message.unknownType": "unknown",
    "message.body": "Body",
    "message.viewAsText": "View as text",
    "message.viewAsHtml": "View as HTML",
    "message.loadImages": "Load remote images",
    "message.frameTitle": "Message body",
    "message.noTextBody": "This message has no text body.",

    /**
     * The one plural in the dashboard, and the reason `plural()` exists rather
     * than a `count === 1` ternary at the call site: English needs the two forms
     * below and Chinese needs neither, so the choice belongs to
     * `Intl.PluralRules` and not to this file's author.
     */
    "body.blocked.one": "{count} remote image blocked.",
    "body.blocked.other": "{count} remote images blocked.",

    "deliveries.pageTitle": "Deliveries · Mailworker",
    "deliveries.title": "Deliveries",
    "deliveries.description": "Everything this account has tried to send.",
    "deliveries.awaiting": "Messages are waiting for approval.",
    "deliveries.review": "Review the queue",
    // The other filter tabs are delivery statuses and stay in the wire
    // vocabulary; "all" is this page's own word, so it is translated.
    "deliveries.filterAll": "all",
    "deliveries.emptyAll": "Nothing sent yet.",
    "deliveries.emptyFiltered": "Nothing sent with status {status}.",
    "deliveries.approve": "Approve",
    "deliveries.cannotApprove":
      "This credential cannot approve sends. That separation is the point of the queue — the principal being approved and the principal approving have to be different (README).",

    "delivery.pageTitle": "Delivery {status} · Mailworker",
    "delivery.heading": "Delivery {id}",
    "delivery.approveAndSend": "Approve and send",
    "delivery.all": "All deliveries",
    "delivery.metadata": "Metadata",
    "delivery.providerId": "Provider id",
    "delivery.idempotencyKey": "Idempotency key",
    "delivery.rejectedBecause": "Rejected because",
    "delivery.lastError": "Last error",
    "delivery.approvedBy": "Approved by",
    "delivery.statusChanged": "Status changed",
    "delivery.timeline": "Timeline",
    "delivery.noEvents":
      "No provider events yet. They arrive on the {queue} queue from Cloudflare's Email Sending event subscription, usually within a minute.",
    "delivery.terminal": "terminal",

    "suppressions.pageTitle": "Suppressions · Mailworker",
    "suppressions.title": "Suppressions",
    "suppressions.description": "Addresses we refuse to mail.",
    "suppressions.note":
      "Cloudflare adds hard bounces to its own account-level list automatically and we mirror it, so {policy} can refuse before the API call — which keeps the attempt off the sending reputation and off the bill.",
    "suppressions.suppress": "Suppress",
    "suppressions.empty": "Nothing suppressed. That is the good state.",
    "suppressions.remove": "Remove",
    "suppressions.removeNote":
      "Removing an entry is deliberately allowed, even for a hard bounce: an address can be fixed, and a suppression list with no way out becomes a list of people you have permanently stopped talking to. It needs {admin} because doing it wrongly damages sending reputation for everyone on the deployment.",

    "identities.pageTitle": "Identities · Mailworker",
    "identities.title": "Identities",
    "identities.description": "What an agent is allowed to be.",
    "identities.adminOnly":
      "Identities are {admin}-only, and this session is not. That is deliberate: the limits an identity carries are exactly the ones the identity must not be able to widen.",
    "identities.note":
      "A quota, an optional recipient allowlist, and whether every send waits for a human. An identity cannot change its own limits — that is the whole point of declaring them here rather than in the credential.",
    "identities.allowlistLabel": "Recipient allowlist",
    "identities.requireApproval": "require approval",
    "identities.create": "Create",
    "identities.created": "Identity {name} created",
    "identities.createdHint": "Mint a key for it on the API keys page.",
    "identities.empty":
      "No identities. A key without one is subject only to account-level limits.",
    "identities.accountLimit": "account limit",
    "identities.anyone": "anyone",
    "identities.nobody": "nobody",
    "identities.approvalRequired": "required",

    "keys.pageTitle": "API keys · Mailworker",
    "keys.title": "API keys",
    "keys.description": "Credentials that can act on this account.",
    "keys.adminOnly": "Key management is {admin}-only, and this session is not.",
    "keys.nameLabel": "Key name",
    "keys.identityLabel": "Identity",
    "keys.noIdentity": "no identity (account limits only)",
    "keys.create": "Create key",
    "keys.scopesNote":
      "Leave {approve} unchecked for anything an agent holds. The approval queue only means something if the principal being approved and the principal approving are different. {admin} cannot be bound to an identity at all — an admin key could edit that identity's own quota, so the metering would be optional for the thing being metered.",
    "keys.empty":
      "No keys yet. The bootstrap admin secret is the only way in until there is one.",
    "keys.revoked": "revoked",
    "keys.active": "active",
    "keys.revoke": "Revoke",
    "keys.revokedNote":
      "Revoked rather than deleted. After a leak the question is “what did this key do before I noticed”, and deleting the row is what makes that question unanswerable.",
    "keys.mintedDescription":
      "Copy this now. Only the hash is stored, and there is no endpoint that reads it back.",
    "keys.done": "Done",
    "keys.copy": "Copy key",
    "keys.copied": "Key copied to clipboard",
    "keys.copyFailed": "Could not copy — select the key and copy it manually",

    "diagnostics.pageTitle": "Diagnostics · Mailworker",
    "diagnostics.title": "Diagnostics",
    "diagnostics.description": "The same checks mailworker doctor runs.",
    "diagnostics.adminOnly": "Diagnostics are {admin}-only, and this session is not.",
    "diagnostics.note":
      "Everything here fails {silently} in production: mail that lands in spam because DMARC is missing, an inbox that receives nothing because MX points at the old host, a send that works against your own address and fails against a customer because the domain is not verified yet.",
    // Its own key because the component emphasises the word, and passing
    // `<em>silently</em>` from the component would emphasise it in English on a
    // Chinese page.
    "diagnostics.silently": "silently",
    "diagnostics.bindings": "Bindings",
    "diagnostics.emailSending": "Email Sending",
    "diagnostics.dispatchQueue": "Dispatch queue",
    "diagnostics.webhookQueue": "Webhook queue",
    "diagnostics.bound": "bound",
    "diagnostics.notBound": "not bound",
    "diagnostics.sendingHint":
      "Receiving still works — Email Routing is free. Sending needs Workers Paid.",
    "diagnostics.domains": "Domains",
    "diagnostics.noDomains": "No domains registered yet. Run {command} to onboard one.",
    "diagnostics.fix": "Fix: {fix}",

    "settings.pageTitle": "Settings · Mailworker",
    "settings.title": "Settings",
    "settings.description": "How this dashboard looks, and who you are signed in as.",
    "settings.general": "General",
    "settings.theme": "Theme",
    "settings.themeDescription": "Kept in this browser, not on the account.",
    "settings.themeLight": "Light",
    "settings.themeDark": "Dark",
    "settings.themeSystem": "System",
    "settings.language": "Language",
    "settings.languageDescription":
      "Stored in a cookie, so every page is rendered in it by the server.",
    "settings.account": "Account",
    "settings.signedInAs": "Signed in as",
    "settings.accountId": "Account id",
    "settings.scopesNote":
      "The scopes are what a 403 means: an action missing from that list is one this credential cannot perform, whatever the button says. Mint a key with different ones on the API keys page.",
  },

  /**
   * One entry per wire error code, keyed by the code itself.
   *
   * `Record<ErrorCode, string>` rather than more flat message keys, because the
   * exhaustiveness is the point: `@mailworker/contract` calls a code "a
   * permanent promise", and adding one there should fail this build rather than
   * silently render an untranslated sentence. The English here deliberately
   * paraphrases rather than copies `@mailworker/core` — the domain's own message
   * is the fallback and is often more specific, naming the id that was missing.
   */
  errors: {
    invalid_email_address: "That is not a valid email address.",
    invalid_ulid: "That is not a valid id.",
    invalid_message_id: "That is not a valid message id.",
    invalid_argument: "The request was not valid.",

    inbox_not_found: "No such inbox.",
    inbox_expired: "This inbox has expired. Its address is still reserved.",
    address_taken: "That address is already in use.",
    unroutable_address: "No inbox accepts mail for that address.",
    message_not_found: "No such message.",

    identity_not_found: "No such identity.",
    api_key_not_found: "No such API key.",
    webhook_not_found: "No such webhook.",

    invalid_state_transition: "That change is not possible from the current state.",
    send_rejected: "A policy refused this send.",
    quota_exceeded: "This identity is over its quota.",
    loop_detected: "The loop breaker refused this send.",
    suppressed_recipient: "That recipient is suppressed.",
    approval_required: "This message is still waiting for approval.",
    message_too_large: "This message is over the 5 MiB sending limit.",

    unauthorized: "Sign in to continue.",
    forbidden: "This credential is not allowed to do that.",

    wait_timeout: "No matching mail arrived in time.",

    not_found: "There is nothing here.",
    method_not_allowed: "That method is not allowed here.",
    unsupported_media_type: "That content type is not supported.",
    payload_too_large: "That request was too large.",
    rate_limited: "Too many requests. Slow down and retry.",
    internal_error: "Something went wrong on our side.",
    upstream_error: "An upstream service failed.",
  } satisfies Record<ErrorCode, string>,
} as const;

/**
 * The shape every other locale must match, with the values widened back to
 * `string`.
 *
 * A mapped type over `en`'s keys rather than `typeof en`: the literal types that
 * make interpolation typesafe would otherwise force a translation to be the
 * same literal as the English, which is not a useful constraint.
 */
export type Messages = { readonly [K in keyof typeof en.messages]: string };
export type Errors = Readonly<Record<ErrorCode, string>>;
export type Catalog = { readonly messages: Messages; readonly errors: Errors };
