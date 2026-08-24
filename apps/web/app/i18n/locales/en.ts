import type { ErrorCode } from "@mailworker/contract";

/**
 * The source of truth for every string the dashboard renders.
 *
 * `as const` is load-bearing: the literal types are what let `t()` extract a
 * message's `{placeholders}` at compile time and require exactly those variables
 * at the call site. Widen this and a forgotten interpolation becomes a literal
 * `{count}` on the page instead of a type error.
 *
 * Lists, tabs and navigation use business words. Human-facing delivery states
 * are translated, while the raw wire value stays visible in technical details
 * for anyone comparing the page with a log or the API. Making a person learn the
 * state machine before they can choose a tab is what this rebalance corrects.
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
    "common.copyId": "Copy ID",
    "common.close": "Close",

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
    "field.receivingAddress": "Receiving address",
    "field.recipients": "Recipients",
    "field.result": "Status",
    "field.scopes": "Scopes",
    "field.agent": "Agent",
    "field.since": "Since",
    "field.source": "Source",
    "field.status": "Delivery status",
    "field.subject": "Subject",
    "field.to": "To",

    "nav.overview": "Overview",
    "nav.approvals": "Approvals",
    "nav.sent": "Sent Mail",
    "nav.inbox": "Inbox",
    "nav.agents": "Agents",
    "nav.settings": "Settings",

    "shell.signOut": "Sign out",
    "shell.openNav": "Open navigation",
    "shell.closeNav": "Close navigation",
    "shell.nav": "Navigation",
    "shell.pendingApprovals": "Pending approvals",

    "env.switch": "Switch environment",
    "env.modeLive": "Live",
    "env.modeSandbox": "Sandbox",
    "env.modeTest": "Test",

    "overview.pageTitle": "Overview · Mailworker",
    "overview.title": "Overview",
    "overview.description":
      "Runtime health, pending approvals, agent activity, and recent mail stream.",
    "overview.generatedAt": "Data generated at",
    "overview.awaiting": "Awaiting approval",
    "overview.currentBacklog": "Pending human review",
    "overview.inboundWindow": "Inbound",
    "overview.outboundWindow": "Outbound",
    "overview.problemsWindow": "Delivery problems",
    "overview.past24Hours": "Past 24 hours",
    "overview.deliveredWindow": "{count} delivered in past 24h",
    "overview.viewAll": "View all",
    "overview.needsAttention": "Needs attention",
    "overview.attentionClear":
      "No approvals, delivery failures, or failing domain checks need action.",
    "overview.domainChecksFailing": "{count} domain checks are failing",
    "overview.domainChecksAction": "Review the exact failure and suggested remediation.",
    "overview.byAgent": "Agent {agent}",
    "overview.unassignedAgent": "Direct API / Console",
    "overview.runtimeHealth": "Runtime health",
    "overview.healthDomains": "Domain and DNS",
    "overview.healthDomainDetail": "{count} configured domains",
    "overview.healthSending": "Email Sending",
    "overview.healthSendingDetail": "Required for external delivery in this environment.",
    "overview.healthSandboxDetail": "Not required while Sandbox loops mail back internally.",
    "overview.healthDispatch": "Dispatch queue",
    "overview.healthDispatchDetail": "Moves durable send decisions to the provider.",
    "overview.healthWebhooks": "Webhook queue",
    "overview.healthWebhooksDetail": "Dispatches delivery events to your webhook endpoints.",
    "overview.healthReady": "Ready",
    "overview.healthMissing": "Missing",
    "overview.healthOptional": "Optional",
    "overview.healthHealthy": "Healthy",
    "overview.healthWarning": "Review",
    "overview.healthFailing": "Failing",
    "overview.healthNotSet": "Not set up",
    "overview.healthLimited": "Limited",
    "overview.healthLimitedDetail": "An admin credential can run domain diagnostics.",
    "overview.openDiagnostics": "Open diagnostics",
    "overview.agentPulse": "Agent pulse",
    "overview.manageAgents": "Manage agents",
    "overview.agentLimited": "Agent policy and quota data requires an admin credential.",
    "overview.noAgents": "No agent identity has been configured for this environment.",
    "overview.createAgent": "Create an agent",
    "overview.approvalOn": "Approval on",
    "overview.agentProblems": "{count} problems",
    "overview.agentQuota": "{used} of {quota} send slots used · past 24 hours",
    "overview.agentUnlimited": "{used} sends · no agent limit",
    "overview.agentWaiting": "{count} awaiting approval",
    "overview.activity": "Recent activity",
    "overview.latestActivity": "Newest first",
    "overview.noActivity": "No inbound or outbound activity yet.",
    "overview.outboundEvent": "Outbound delivery",
    "overview.readyTitle": "Prepare this environment",
    "overview.readyDescription":
      "Complete the setup path below, then verify an end-to-end mail flow before relying on an agent.",
    "overview.readyDomain": "Register a domain",
    "overview.readyDomainDetail":
      "Run {command} to register routing and sending configuration.",
    "overview.readyInbox": "Create a receiving address",
    "overview.readyInboxDetail": "Give the first workflow a dedicated, inspectable inbox.",
    "overview.readyAgent": "Define an agent policy",
    "overview.readyAgentDetail":
      "Set recipients, a quota, and approval requirements before issuing access.",
    "overview.readyKey": "Issue a scoped key",
    "overview.readyKeyDetail": "Give the agent only the scopes its workflow needs.",
    "overview.continueSetup": "Continue setup",

    "approvals.pageTitle": "Approval queue · Mailworker",
    "approvals.title": "Approval queue",
    "approvals.description":
      "Oldest first. Review the agent, policy decision, recipients, and content before releasing delivery.",
    "approvals.empty": "Nothing is waiting for review.",
    "approvals.heldBecause": "Held by policy",
    "approvals.context": "Workflow context",
    "approvals.attachments": "{count} attachments",
    "approvals.approve": "Approve & Send",
    "approvals.liveWarning":
      "Live environment — approving a message releases it to real external recipients.",
    "approvals.approveLiveTitle": "Release this email in Live?",
    "approvals.approveLiveBody":
      "This immediately queues delivery to {recipients}. Review the message and policy decision before continuing.",
    "approvals.approveLiveConfirm": "Approve and send",
    "approvals.reject": "Reject",
    "approvals.rejectTitle": "Reject this email?",
    "approvals.rejectBody":
      "The email to {recipients} will be discarded. This cannot be undone.",
    "approvals.rejectConfirm": "Reject email",
    "approvals.rejectReason": "Rejected from the dashboard",
    "approvals.approved": "Approved; delivery queued",
    "approvals.rejected": "Email rejected",
    "approvals.cannotApprove":
      "This credential cannot approve emails because the approver must be different from the sender.",
    "approvals.openDetail": "View message and delivery details",
    "approvals.next": "Next waiting emails",

    "sent.pageTitle": "Sent Mail · Mailworker",
    "sent.title": "Sent Mail",
    "sent.description":
      "Every email sent from this environment, its current delivery outcome, and the agent it belongs to.",
    "sent.allAgents": "All agents",
    "sent.clearFilters": "Clear filters",
    "sent.bucket.all": "All",
    "sent.bucket.waiting": "Awaiting approval",
    "sent.bucket.moving": "In progress",
    "sent.bucket.problem": "Needs attention",
    "sent.bucket.done": "Delivered",
    "sent.emptyAll": "No email has been sent from this environment yet.",
    "sent.emptyBucket": "No email matches this filter.",
    "sent.searchPlaceholder": "Search subject, text or recipient…",
    "sent.searchLabel": "Search sent mail",
    "sent.noMatch": "No send matches {query}.",
    "sent.byAgent": "Direct / Console",
    "sent.byConsole": "console",
    "sent.compose": "New email",

    "delivery.pageTitle": "Delivery record · Mailworker",
    "delivery.all": "Back to Sent Mail",
    "delivery.metadata": "Metadata",
    "delivery.providerId": "Provider message ID",
    "delivery.idempotencyKey": "Idempotency key",
    "delivery.rejectedBecause": "Rejection reason",
    "delivery.lastError": "Last delivery error",
    "delivery.approvedBy": "Approved by",
    "delivery.statusChanged": "Last status change",
    "delivery.timeline": "Delivery history",
    "delivery.noEvents":
      "No delivery update has arrived yet. Email Sending usually reports a result within a minute.",
    "delivery.terminal": "final state",
    "delivery.wireStatus": "Internal status",
    "delivery.id": "Delivery ID",
    "delivery.technical": "Technical details",
    "delivery.approveAndSend": "Approve & Send",
    "delivery.approveTitle": "Release this email in Live?",
    "delivery.approveBody":
      "This immediately queues delivery to {recipients}. Review the message and policy decision before continuing.",
    "delivery.approveConfirm": "Approve and send",
    "delivery.next.bounced":
      "This address is suppressed, so future emails to it will be refused. If the address was wrong, correct it and remove the suppression.",
    "delivery.next.complained":
      "The recipient marked this email as spam. Do not send to this address again until they opt in again.",
    "delivery.next.rejected":
      "The email service refused this send. The reason below came from the service; retrying will not change it.",
    "delivery.next.failed":
      "The email failed before delivery. Fix the cause, then send it again.",
    "delivery.next.deferred":
      "The email service is retrying. Wait unless it remains in this state for an unusually long time.",
    "delivery.next.dispatching":
      "The provider hand-off is in progress. If this stays unchanged, verify delivery before retrying—do not resend automatically.",

    "status.draft": "Draft",
    "status.pendingApproval": "Awaiting approval",
    "status.queued": "Queued",
    "status.dispatching": "Sending",
    "status.dispatched": "Submitted",
    "status.deferred": "Retrying",
    "status.delivered": "Delivered",
    "status.bounced": "Bounced",
    "status.complained": "Marked as spam",
    "status.failed": "Failed",
    "status.rejected": "Rejected",

    "inboxes.pageTitle": "Receiving addresses · Mailworker",
    "inboxes.title": "Receiving addresses",
    "inboxes.description":
      "Create and manage the addresses this environment can receive mail on.",
    "inboxes.showExpired": "Show expired",
    "inboxes.hideExpired": "Hide expired",
    "inboxes.nameLabel": "Address name",
    "inboxes.namePlaceholder": "leave empty to generate one",
    "inboxes.randomSuffix": "Append a random suffix",
    "inboxes.taken": "{address} is already taken.",
    "inboxes.ttlLabel": "Expire after (minutes)",
    "inboxes.create": "Create address",
    "inboxes.createHint":
      "Leave the name empty for a generated one. Temporary addresses stop receiving when they expire; permanent ones never do.",
    "inboxes.created": "Address created",
    "inboxes.empty": "No receiving addresses yet. Create one here, or run {command}.",
    "inboxes.deleteAria": "Delete {address}",
    "inboxes.deleteTitle": "Delete this address?",
    "inboxes.deleteBody":
      "This will permanently delete {address} and every message received there.",
    "inboxes.deleteConfirm": "Delete address",
    "inboxes.kindEphemeral": "Temporary",
    "inboxes.kindPersistent": "Permanent",

    "inbox.pageTitle": "Inbox · Mailworker",
    "inbox.title": "Inbox",
    "inbox.description": "All messages received by every address in this environment.",
    "inbox.searchPlaceholder": "Search subject, text or sender…",
    "inbox.searchLabel": "Search inbox",
    "inbox.allAddresses": "All receiving addresses",
    "inbox.manageAddresses": "Manage addresses",
    "inbox.unread": "Unread",
    "inbox.empty": "No email has arrived yet. New mail appears here as soon as it lands.",
    "inbox.noMatch": "No message matches {query}.",

    "message.pageTitle": "{subject} · Mailworker",
    "message.backToInbox": "Back to Inbox",
    "message.details": "Message details",
    "message.replyTo": "Reply-To",
    "message.authentication": "Authentication checks",
    "message.authSummary": "spf {spf} · dkim {dkim} · dmarc {dmarc}",
    "message.why": "Assessment",
    "message.messageId": "Message-ID",
    "message.size": "Size",
    "message.downloadHint": "(requires a bearer token, or use {command})",
    "message.attachments": "Attachments",
    "message.unnamedAttachment": "(unnamed)",
    "message.unknownType": "Unknown",
    "message.body": "Body",
    "message.reply": "Reply",

    "body.preview": "Preview",
    "body.plainText": "Plain text",
    "body.raw": "Raw",
    "body.loadImages": "Load remote images",
    "body.frameTitle": "Message body",
    "body.noText": "This message has no text body. Switch to Preview to read it.",
    "body.none": "This message has no body.",

    "compose.pageTitle": "New email · Mailworker",
    "compose.title": "New email",
    "compose.replyTitle": "Reply to message",
    "compose.from": "From address",
    "compose.to": "To",
    "compose.toPlaceholder": "someone@example.com, another@example.com",
    "compose.subject": "Subject",
    "compose.body": "Message",
    "compose.send": "Send email",
    "compose.sent": "Email sent",
    "compose.quoting": "Replying to {subject}",
    "compose.noInbox":
      "Create a receiving address first. An email needs one of this environment's addresses as its From address.",
    "compose.consoleNote":
      "This email will be attributed to the {identity} agent. Your browser session only provides access; it is not the sender.",
    "compose.testSubject": "Mailworker test email",
    "compose.testBody": "If you can read this, email sending is working.",

    "agents.pageTitle": "Agents · Mailworker",
    "agents.title": "Agents",
    "agents.description":
      "Define who can send, what they can send, and which credentials they use.",
    "agents.adminOnly": "Agent management is available to administrators only.",
    "agents.create": "Create agent",
    "agents.nameLabel": "Agent name",
    "agents.namePlaceholder": "support-bot",
    "agents.allowlistLabel": "Allowed recipients",
    "agents.allowlistPlaceholder": "*@customer.example.com",
    "agents.quotaLabel": "Daily send limit",
    "agents.requireApproval": "Hold every send for approval",
    "agents.created": "Agent {name} created",
    "agents.empty": "No agents yet. Create one above, then issue it an API key.",
    "agents.anyone": "any address",
    "agents.nobody": "no recipients",
    "agents.noLimit": "no limit",
    "agents.approvalRequired": "Approval required",
    "agents.managedTag": "Managed",
    "agents.keys": "API keys",
    "agents.newKey": "Issue API key",
    "agents.noKeys": "No API key yet",
    "agents.revoke": "Revoke",
    "agents.revoked": "revoked",
    "agents.managed":
      "Managed by Mailworker. Emails sent from the dashboard are attributed to the {identity} agent.",
    "agents.mintedTitle": "Copy this API key now",
    "agents.mintedDescription":
      "Only the hash is stored. Once this dialog closes the key cannot be read back.",
    "agents.copy": "Copy API key",
    "agents.copied": "API key copied to clipboard",
    "agents.copyFailed": "Could not copy. Select the key and copy it manually.",
    "agents.done": "Done",
    "agents.scopeNote": "Agent API keys cannot approve emails.",
    "agents.revokedNote":
      "Revoked keys are kept, not deleted, so their history stays readable.",

    "settings.pageTitle": "Settings · Mailworker",
    "settings.title": "Settings",
    "settings.general": "Preferences",
    "settings.theme": "Theme",
    "settings.themeDescription": "Saved in this browser, not on the account.",
    "settings.themeLight": "Light",
    "settings.themeDark": "Dark",
    "settings.themeSystem": "System",
    "settings.language": "Language",
    "settings.languageDescription": "Saved as a cookie so the server renders every page in it.",
    "settings.account": "Current access",
    "settings.signedInAs": "Access credential",
    "settings.accountId": "Environment ID",
    "settings.scopesNote": "These are the permissions on the current credential.",
    "settings.environments": "Environments",
    "settings.environmentsDescription":
      "Each environment has its own receiving addresses, credentials, and sending history.",
    "settings.addEnvironment": "Create environment",
    "settings.envNameLabel": "Name",
    "settings.envModeLabel": "Environment mode",
    "settings.envCreated": "Environment {name} created",
    "settings.modeLive": "Emails are sent to real recipients.",
    "settings.modeSandbox": "Emails stay inside this environment for testing.",
    "settings.modeTest": "Emails go to real recipients, but only allowlisted addresses.",
    "settings.modeLiveShort": "Live",
    "settings.modeSandboxShort": "Sandbox",
    "settings.modeTestShort": "Test",
    "settings.addresses": "Receiving addresses",
    "settings.addressesDescription":
      "Create, review, and remove the addresses this environment receives mail on.",
    "settings.suppressions": "Suppressed addresses",
    "settings.suppressionsDescription":
      "Addresses we refuse to mail, and the reason for each refusal.",
    "settings.diagnostics": "Diagnostics",
    "settings.diagnosticsDescription": "Check the DNS, sending, and queue configuration.",
    "settings.open": "Open",

    "suppressions.pageTitle": "Suppressed addresses · Mailworker",
    "suppressions.title": "Suppressed addresses",
    "suppressions.description":
      "Emails to these addresses are blocked before the email service is called. Hard bounces are synced from Cloudflare.",
    "suppressions.suppress": "Suppress address",
    "suppressions.empty": "No addresses are currently suppressed.",
    "suppressions.remove": "Remove suppression",
    "suppressions.reason.manual": "Manual",
    "suppressions.reason.hard_bounce": "Hard bounce",
    "suppressions.reason.soft_bounce": "Soft bounce",
    "suppressions.reason.complaint": "Complaint",
    "suppressions.source.local": "Local",
    "suppressions.source.cloudflare": "Cloudflare",

    "diagnostics.pageTitle": "Diagnostics · Mailworker",
    "diagnostics.title": "Diagnostics",
    "diagnostics.description": "Check the DNS, sending, and queue configuration.",
    "diagnostics.adminOnly": "Diagnostics are available to administrators only.",
    "diagnostics.note":
      "A production misconfiguration can fail {silently}: mail can land in spam because DMARC is missing, receiving can stop because MX still points to the old host, or a send can work for you and fail for a customer.",
    "diagnostics.silently": "without an obvious error",
    "diagnostics.bindings": "Worker bindings",
    "diagnostics.emailSending": "Email Sending",
    "diagnostics.dispatchQueue": "Sending queue",
    "diagnostics.webhookQueue": "Webhook queue",
    "diagnostics.bound": "Ready",
    "diagnostics.notBound": "Missing",
    "diagnostics.sendingHint": "Receiving still works. Email Sending requires Workers Paid.",
    "diagnostics.sandboxHint":
      "This is a sandbox environment, so email sending works without these bindings because nothing leaves.",
    "diagnostics.domains": "Domains",
    "diagnostics.noDomains": "No domains are registered yet. Run {command} to add one.",
    "diagnostics.fix": "Suggested fix: {fix}",
    "diagnostics.status.pass": "Pass",
    "diagnostics.status.warn": "Warning",
    "diagnostics.status.fail": "Fail",
    "diagnostics.status.unknown": "Unknown",

    "live.live": "live",
    "live.connecting": "connecting",
    "live.offline": "offline",
    "live.liveTitle": "Live — new mail appears automatically",
    "live.connectingTitle": "Connecting to the live feed",
    "live.offlineTitle": "Offline — reload to see new mail",

    "provenance.trusted": "Verified sender",
    "provenance.unverified": "Unverified sender",
    "provenance.attribution": "Based on SPF/DKIM/DMARC",

    "boundary.title": "Error",
    "boundary.fallback": "Something went wrong while loading this page.",
    "boundary.back": "Back to overview",

    "login.pageTitle": "Sign in · Mailworker",
    "login.description":
      "Sign in with an API key. Issue one with {command}, or paste the bootstrap admin key.",
    "login.noSecret":
      "No session secret is configured, so sign-in cannot work. Set {session} or {admin} with {command}.",
    "login.keyLabel": "API key",
    "login.checking": "Checking…",
    "login.submit": "Sign in",
    "login.emptyKey": "Paste an API key to continue.",
    "login.rejected": "That API key was not accepted. It may be revoked, expired, or mistyped.",
    "login.noSessionSecret":
      "This deployment cannot issue sessions: neither MAILWORKER_SESSION_SECRET nor MAILWORKER_ADMIN_KEY is set.",
    "login.cookieNote":
      "The key is sealed into an httpOnly cookie that page scripts cannot read. Revoking the key ends the session.",

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
    idempotency_conflict: "That idempotency key belongs to a different send request.",

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
    wait_capacity_exceeded:
      "This environment has too many concurrent waits. Try again shortly.",

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
