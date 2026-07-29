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
 */
export const en = {
  messages: {
    // Shared vocabulary. Anything appearing on three or more pages lives here,
    // because the alternative is three translations drifting apart.
    "common.cancel": "Cancel",
    "common.older": "Older",
    "common.dash": "—",

    "nav.inboxes": "Inboxes",
    "nav.deliveries": "Deliveries",
    "nav.suppressions": "Suppressions",
    "nav.identities": "Identities",
    "nav.keys": "API keys",
    "nav.diagnostics": "Diagnostics",

    "shell.signOut": "Sign out",
    "shell.openNav": "Open navigation",
    "shell.closeNav": "Close navigation",
    "shell.nav": "Navigation",
    "shell.themeToLight": "Switch to light theme",
    "shell.themeToDark": "Switch to dark theme",
    "shell.language": "Language",
    "shell.languageSwitch": "Switch language",

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
    "inboxes.kindLabel": "Kind",
    "inboxes.ttlLabel": "TTL (minutes)",
    "inboxes.create": "Create inbox",
    "inboxes.created": "Inbox created",
    "inboxes.empty": "No inboxes yet. Create one above, or run {command}.",
    "inboxes.colAddress": "Address",
    "inboxes.colKind": "Kind",
    "inboxes.colExpires": "Expires",
    "inboxes.colCreated": "Created",
    "inboxes.deleteAria": "Delete {address}",
    "inboxes.deleteTitle": "Delete this inbox?",
    "inboxes.deleteBody":
      "{address} and every message it holds are removed. This cannot be undone.",
    "inboxes.deleteConfirm": "Delete inbox",
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
