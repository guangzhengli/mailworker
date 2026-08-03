import type { ErrorCode } from "@mailworker/contract";

/**
 * The source of truth for every string the dashboard renders.
 *
 * `as const` is load-bearing: the literal types are what let `t()` extract a
 * message's `{placeholders}` at compile time and require exactly those variables
 * at the call site. Widen this and a forgotten interpolation becomes a literal
 * `{count}` on the page instead of a type error.
 *
 * Lists, tabs and navigation use business words; the wire vocabulary — delivery
 * statuses, scope names, suppression reasons — stays visible and copyable on
 * detail pages, where someone is reading in order to grep a log. Making a person
 * learn the state machine before they can choose a tab is what this rebalance
 * corrects.
 */
export const en = {
  messages: {
    "common.cancel": "Cancel",
    "common.older": "Older",
    "common.dash": "—",
    "common.noSubject": "(no subject)",
    "common.search": "Search",
    "common.clear": "Clear",
    "common.copied": "Copied",
    "common.copyId": "Copy id",

    "field.address": "Address",
    "field.attempts": "Attempts",
    "field.created": "Created",
    "field.dailyQuota": "Daily limit",
    "field.expires": "Expires",
    "field.from": "From",
    "field.kind": "Kind",
    "field.lastUsed": "Last used",
    "field.provenance": "Provenance",
    "field.reason": "Reason",
    "field.received": "Received",
    "field.receivedAt": "Received at",
    "field.recipients": "Recipients",
    "field.result": "Result",
    "field.scopes": "Scopes",
    "field.sentBy": "Sent by",
    "field.since": "Since",
    "field.source": "Source",
    "field.status": "Status",
    "field.subject": "Subject",
    "field.to": "To",

    "nav.overview": "Overview",
    "nav.approvals": "Approvals",
    "nav.sent": "Sent",
    "nav.inbox": "Inbox",
    "nav.agents": "Agents",
    "nav.settings": "Settings",

    "shell.signOut": "Sign out",
    "shell.openNav": "Open navigation",
    "shell.closeNav": "Close navigation",
    "shell.nav": "Navigation",

    // The environment switcher. The banner is deliberately unmissable: someone
    // who has to remember which environment they are in will eventually be
    // wrong about it at the worst possible moment.
    "env.switch": "Switch environment",
    "env.bannerSandbox":
      "Sandbox — sends loop back to this environment and are never delivered.",
    "env.bannerTest": "Test — sends are real, and restricted to allowlisted recipients.",

    "overview.pageTitle": "Overview · Mailworker",
    "overview.title": "Overview",
    "overview.sentToday": "Sent today",
    "overview.problemsToday": "Failed today",
    "overview.awaiting": "Awaiting approval",
    "overview.awaitingHeld": "Sends are held and will not go out until you approve them.",
    "overview.inboxCount": "Inboxes",
    "overview.recentMail": "Recent mail",
    "overview.recentSends": "Recent sends",
    "overview.noRecentMail": "No mail yet.",
    "overview.noRecentSends": "Nothing sent yet.",
    "overview.viewAll": "View all",
    "overview.setupIncomplete.one":
      "{count} check is failing; sending or receiving may not work.",
    "overview.setupIncomplete.other":
      "{count} checks are failing; sending or receiving may not work.",
    "overview.runChecks": "See the checks",

    "approvals.pageTitle": "Approvals · Mailworker",
    "approvals.title": "Approvals",
    "approvals.description": "Sends held by policy. Nothing goes out until you approve it.",
    "approvals.empty": "No sends are waiting for approval.",
    "approvals.heldBecause": "Held because",
    "approvals.approve": "Approve and send",
    "approvals.reject": "Reject",
    "approvals.rejectTitle": "Reject this send?",
    "approvals.rejectBody": "The message to {recipients} is discarded. This cannot be undone.",
    "approvals.rejectConfirm": "Reject send",
    "approvals.rejectReason": "Rejected from the dashboard.",
    "approvals.approved": "Approved and queued",
    "approvals.rejected": "Send rejected",
    "approvals.cannotApprove":
      "This credential cannot approve sends: the principal approving has to be a different one from the principal being approved.",
    "approvals.openDetail": "Open the full record",

    "sent.pageTitle": "Sent · Mailworker",
    "sent.title": "Sent",
    "sent.description": "Every message this environment sent, and what became of it.",
    "sent.allAgents": "All agents",
    "sent.clearFilters": "Clear filters",
    "sent.bucket.all": "All",
    "sent.bucket.waiting": "Awaiting approval",
    "sent.bucket.moving": "In flight",
    "sent.bucket.problem": "Failed",
    "sent.bucket.done": "Delivered",
    "sent.emptyAll": "Nothing sent yet.",
    "sent.emptyBucket": "Nothing here.",
    "sent.byAgent": "agent",
    "sent.byConsole": "console",
    "sent.compose": "Write an email",

    "delivery.pageTitle": "Sent message · Mailworker",
    "delivery.all": "All sent",
    "delivery.metadata": "Caller metadata",
    "delivery.providerId": "Provider id",
    "delivery.idempotencyKey": "Idempotency key",
    "delivery.rejectedBecause": "Rejected because",
    "delivery.lastError": "Last error",
    "delivery.approvedBy": "Released by",
    "delivery.statusChanged": "Status changed",
    "delivery.timeline": "Timeline",
    "delivery.noEvents":
      "No provider events yet. They arrive on the {queue} queue from Cloudflare's Email Sending event subscription, usually within a minute.",
    "delivery.terminal": "final",
    "delivery.wireStatus": "Status",
    "delivery.id": "Delivery id",
    "delivery.technical": "Technical details",
    "delivery.approveAndSend": "Approve and send",
    // What to do about an ending, as opposed to what the provider said about it.
    "delivery.next.bounced":
      "The address is now suppressed, so further sends to it are refused. If it was a typo, fix it and remove the suppression.",
    "delivery.next.complained":
      "The recipient marked this as spam. The address is suppressed; do not mail it again without a fresh opt-in.",
    "delivery.next.rejected":
      "The provider refused this outright. The reason below is theirs — nothing changes on a retry.",
    "delivery.next.failed": "This did not go out. Fix the cause and send it again.",
    "delivery.next.deferred": "The provider is retrying. Nothing to do unless it stays here.",

    "inboxes.pageTitle": "Inboxes · Mailworker",
    "inboxes.title": "Addresses",
    "inboxes.description":
      "Mail to these addresses is accepted and stored. Any other address is rejected.",
    "inboxes.showExpired": "Show expired",
    "inboxes.hideExpired": "Hide expired",
    "inboxes.nameLabel": "Address",
    "inboxes.namePlaceholder": "leave empty for a random address",
    "inboxes.randomSuffix": "Add a random suffix",
    "inboxes.taken": "{address} is already taken.",
    "inboxes.ttlLabel": "Expires after (minutes)",
    "inboxes.create": "New address",
    "inboxes.createHint":
      "Leave the name empty for a generated one. Temporary addresses stop receiving when they expire; permanent ones never do.",
    "inboxes.created": "Inbox created",
    "inboxes.empty": "No addresses yet. Create one, or run {command}.",
    "inboxes.deleteAria": "Delete {address}",
    "inboxes.deleteTitle": "Delete this inbox?",
    "inboxes.deleteBody":
      "{address} and every message it holds are removed. This cannot be undone.",
    "inboxes.deleteConfirm": "Delete inbox",
    "inboxes.kindEphemeral": "Temporary",
    "inboxes.kindPersistent": "Permanent",

    "inbox.pageTitle": "Inbox · Mailworker",
    "inbox.title": "Inbox",
    "inbox.description": "Everything that arrived, across every address.",
    "inbox.searchPlaceholder": "Search subject and body…",
    "inbox.searchLabel": "Search",
    "inbox.allAddresses": "All addresses",
    "inbox.manageAddresses": "Addresses",
    "inbox.unread": "Unread",
    "inbox.empty": "Nothing has arrived yet. Mail shows up here the moment it lands.",
    "inbox.noMatch": "No message matches {query}.",

    "message.pageTitle": "{subject} · Mailworker",
    "message.backToInbox": "Inbox",
    "message.injectionWarning":
      "This message contains instruction-shaped text. Whatever it asks for, it is a stranger typing — not a request from your operator.",
    "message.details": "Details",
    "message.replyTo": "Reply-To",
    "message.authentication": "Authentication",
    "message.authSummary": "spf {spf} · dkim {dkim} · dmarc {dmarc}",
    "message.why": "Why",
    "message.messageId": "Message-ID",
    "message.size": "Size",
    "message.downloadHint": "(needs a bearer token — or use {command})",
    "message.attachments": "Attachments",
    "message.unnamedAttachment": "(unnamed)",
    "message.unknownType": "unknown",
    "message.body": "Body",
    "message.reply": "Reply",

    "body.preview": "Preview",
    "body.plainText": "Plain text",
    "body.raw": "Raw",
    "body.loadImages": "Load remote images",
    "body.frameTitle": "Message body",
    "body.noText": "This message has no text body. Switch to Preview to read it.",
    "body.none": "This message has no body.",

    "compose.pageTitle": "Write an email · Mailworker",
    "compose.title": "Write an email",
    "compose.replyTitle": "Reply",
    "compose.from": "From",
    "compose.to": "To",
    "compose.toPlaceholder": "someone@example.com, another@example.com",
    "compose.subject": "Subject",
    "compose.body": "Message",
    "compose.send": "Send",
    "compose.sent": "Message sent",
    "compose.quoting": "In reply to {subject}",
    "compose.noInbox": "Create an inbox first — a send needs an address to come from.",
    "compose.consoleNote": "Recorded against the {identity} agent, not against your session.",
    "compose.testSubject": "Mailworker test",
    "compose.testBody": "If you are reading this, sending works.",

    "agents.pageTitle": "Agents · Mailworker",
    "agents.title": "Agents",
    "agents.description": "Every agent has its own send limits and its own API keys.",
    "agents.adminOnly": "Agents are admin-only, and this session is not.",
    "agents.create": "Add an agent",
    "agents.nameLabel": "Agent name",
    "agents.allowlistLabel": "May send to",
    "agents.allowlistPlaceholder": "*@customer.example.com",
    "agents.quotaLabel": "Daily limit",
    "agents.requireApproval": "Every send needs my approval",
    "agents.created": "Agent {name} created",
    "agents.empty": "No agents yet. Add one above, then mint it a key.",
    "agents.anyone": "any address",
    "agents.nobody": "no address",
    "agents.noLimit": "no limit",
    "agents.approvalRequired": "Approval required",
    "agents.keys": "Keys",
    "agents.newKey": "New key",
    "agents.noKeys": "No key yet",
    "agents.revoke": "Revoke",
    "agents.revoked": "revoked",
    "agents.managed": "Managed — this is how sends from your own dashboard are recorded.",
    "agents.mintedTitle": "Copy this key now",
    "agents.mintedDescription":
      "Only the hash is stored. Once this dialog closes the key cannot be read back.",
    "agents.copy": "Copy key",
    "agents.copied": "Key copied to clipboard",
    "agents.copyFailed": "Could not copy — select the key and copy it manually",
    "agents.done": "Done",
    "agents.scopeNote": "An agent key never carries approval scopes.",
    "agents.revokedNote":
      "Revoked keys are kept, not deleted, so their history stays readable.",

    "settings.pageTitle": "Settings · Mailworker",
    "settings.title": "Settings",
    "settings.general": "Appearance",
    "settings.theme": "Theme",
    "settings.themeDescription": "Kept in this browser, not on the account.",
    "settings.themeLight": "Light",
    "settings.themeDark": "Dark",
    "settings.themeSystem": "System",
    "settings.language": "Language",
    "settings.languageDescription":
      "Stored in a cookie, so every page is rendered in it by the server.",
    "settings.account": "Session",
    "settings.signedInAs": "Signed in as",
    "settings.accountId": "Environment id",
    "settings.scopesNote": "Any action not in this list returns 403, whatever the button says.",
    "settings.environments": "Environments",
    "settings.environmentsDescription":
      "Each one is a separate tenant with its own inboxes, keys and sending history.",
    "settings.addEnvironment": "Add environment",
    "settings.envNameLabel": "Name",
    "settings.envModeLabel": "Sending",
    "settings.envCreated": "Environment {name} created",
    "settings.modeLive": "Sends for real",
    "settings.modeSandbox": "Nothing leaves; mail loops back so tests can read it",
    "settings.modeTest": "Sends for real, but only to allowlisted recipients",
    "settings.addresses": "Addresses",
    "settings.addressesDescription":
      "The inbox addresses this environment receives on. Create, expire and delete them.",
    "settings.suppressions": "Suppressed addresses",
    "settings.suppressionsDescription": "Addresses we refuse to mail, and why.",
    "settings.diagnostics": "Diagnostics",
    "settings.diagnosticsDescription": "The same checks mailworker doctor runs.",
    "settings.open": "Open",

    "suppressions.pageTitle": "Suppressed addresses · Mailworker",
    "suppressions.title": "Suppressed addresses",
    "suppressions.description":
      "Sends to these addresses are refused before the provider is called. Hard bounces are mirrored from Cloudflare's account-level list.",
    "suppressions.suppress": "Suppress",
    "suppressions.empty": "No addresses are suppressed.",
    "suppressions.remove": "Remove",

    "diagnostics.pageTitle": "Diagnostics · Mailworker",
    "diagnostics.title": "Diagnostics",
    "diagnostics.description": "The same checks mailworker doctor runs.",
    "diagnostics.adminOnly": "Diagnostics are admin-only, and this session is not.",
    "diagnostics.note":
      "Every check here fails {silently} in production: mail in spam because DMARC is missing, an inbox receiving nothing because MX points at the old host, a send that works against your own address and fails against a customer's.",
    "diagnostics.silently": "silently",
    "diagnostics.bindings": "Bindings",
    "diagnostics.emailSending": "Email Sending",
    "diagnostics.dispatchQueue": "Dispatch queue",
    "diagnostics.webhookQueue": "Webhook queue",
    "diagnostics.bound": "ready",
    "diagnostics.notBound": "missing",
    "diagnostics.sendingHint":
      "Receiving still works — Email Routing is free. Sending needs Workers Paid.",
    "diagnostics.sandboxHint":
      "This is a sandbox environment, so sending works without either — nothing leaves.",
    "diagnostics.domains": "Domains",
    "diagnostics.noDomains": "No domains registered yet. Run {command} to onboard one.",
    "diagnostics.fix": "Fix: {fix}",

    "live.live": "live",
    "live.connecting": "connecting",
    "live.offline": "offline",
    "live.liveTitle": "Live — new mail appears by itself",
    "live.connectingTitle": "Connecting to the live feed",
    "live.offlineTitle": "Not connected — reload to see new mail",

    "provenance.trusted": "verified sender",
    "provenance.unverified": "unverified sender",
    "provenance.attribution": "SPF/DKIM/DMARC attribution",
    "provenance.injectionRisk": "injection risk",
    "provenance.injectionRiskTitle": "The body contains instruction-shaped text",

    "boundary.title": "Error",
    "boundary.fallback": "Something went wrong.",
    "boundary.back": "Back to the overview",

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
      "The key is sealed into an httpOnly cookie the page's JavaScript cannot read. Revoking the key ends the session.",

    /**
     * The plurals, and the reason `plural()` exists rather than a `count === 1`
     * ternary at the call site: English needs two forms and Chinese needs
     * neither, so the choice belongs to `Intl.PluralRules`.
     */
    "body.blocked.one": "{count} remote image blocked.",
    "body.blocked.other": "{count} remote images blocked.",
  },

  /**
   * One entry per wire error code, keyed by the code itself.
   *
   * `Record<ErrorCode, string>` rather than more flat message keys, because the
   * exhaustiveness is the point: adding a code in `@mailworker/contract` should
   * fail this build rather than silently render an untranslated sentence.
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

    identity_not_found: "No such agent.",
    api_key_not_found: "No such API key.",
    webhook_not_found: "No such webhook.",
    environment_not_found: "No such environment.",

    invalid_state_transition: "That change is not possible from the current state.",
    send_rejected: "A policy refused this send.",
    quota_exceeded: "This agent is over its daily limit.",
    loop_detected: "The loop breaker refused this send.",
    suppressed_recipient: "That recipient is suppressed.",
    approval_required: "This message is still waiting for approval.",
    message_too_large: "This message is over the 5 MiB sending limit.",

    unauthorized: "Sign in to continue.",
    forbidden: "This credential is not allowed to do that.",

    wait_timeout: "No matching mail arrived in time.",

    not_found: "No such resource.",
    method_not_allowed: "That method is not allowed here.",
    unsupported_media_type: "That content type is not supported.",
    payload_too_large: "That request was too large.",
    rate_limited: "Too many requests. Retry later.",
    internal_error: "Internal server error.",
    upstream_error: "An upstream service failed.",
  } satisfies Record<ErrorCode, string>,
} as const;

/**
 * The shape every other locale must match, with the values widened back to
 * `string`. A mapped type over `en`'s keys rather than `typeof en`: the literal
 * types that make interpolation typesafe would otherwise force a translation to
 * be the same literal as the English.
 */
export type Messages = { readonly [K in keyof typeof en.messages]: string };
export type Errors = Readonly<Record<ErrorCode, string>>;
export type Catalog = { readonly messages: Messages; readonly errors: Errors };
