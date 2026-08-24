import type { Caller, DispatchRequest, DispatchResult, MailTransport } from "@mailworker/core";

/**
 * Sending over the `send_email` binding.
 *
 * The composed form (`send({ from, to, subject, text, … })`) rather than
 * handing over raw MIME: raw takes exactly one recipient per call, so a message
 * to twenty people would become twenty sends — twenty provider message ids,
 * twenty rows in the timeline, and twenty times the quota for one message. The
 * composed form takes the whole recipient set in one call and gives back one id
 * to correlate events against.
 *
 * The cost of that choice is that the `.eml` we archive is OUR rendering of the
 * message rather than the exact bytes Cloudflare put on the wire. Worth stating
 * plainly, because it is the one place the archive is a faithful reconstruction
 * instead of a recording. The inbound side, where `inject` replay depends on
 * byte fidelity, keeps the original.
 *
 * `{ messageId }` is all that comes back, and deliberately so: this is the
 * result at the moment of handoff, not a delivery outcome. Whether it lands,
 * bounces or is deferred arrives minutes to days later on the event
 * subscription (DESIGN §2.3), which is what `mailworker status` reads.
 */
export class CloudflareTransport implements MailTransport {
  constructor(private readonly binding: SendEmail) {}

  async dispatch(_ctx: Caller, message: DispatchRequest): Promise<DispatchResult> {
    const recipients = [...message.to, ...message.cc, ...message.bcc];

    try {
      const result = await this.binding.send({
        from:
          message.fromName === null
            ? message.from
            : { name: message.fromName, email: message.from },
        ...destinationsOf(message),
        subject: message.subject,
        ...(message.replyTo === null ? {} : { replyTo: message.replyTo }),
        ...(message.text === null ? {} : { text: message.text }),
        ...(message.html === null ? {} : { html: message.html }),
        headers: {
          ...message.headers,
          // NOT `Message-ID`. Email Sending mints that itself and rejects the
          // header outright (`E_HEADER_NOT_ALLOWED`), so our id rides along as
          // an `X-` header instead — that much the allowlist does permit. Our
          // id stays the key for threading, idempotency and the archive; it is
          // simply no longer the id the recipient's client sees.
          "X-Mailworker-Message-ID": `<${message.messageId}>`,
          ...(message.inReplyTo === null ? {} : { "In-Reply-To": `<${message.inReplyTo}>` }),
          // Our own id rides at the end of the chain, which RFC 5322 does not
          // strictly sanction — `References` is meant to be ancestors, not
          // self. It is the only way threading survives Cloudflare minting the
          // `Message-ID`: a replying client copies this chain into its own
          // `References`, so the reply reaches us carrying an id we recognise
          // even though its `In-Reply-To` names an id we have never seen. Wire
          // only; the archived `.eml` keeps the honest chain.
          References: [...message.references, message.messageId]
            .map((id) => `<${id}>`)
            .join(" "),
        },
        ...(message.attachments.length === 0
          ? {}
          : {
              attachments: message.attachments.map((attachment) =>
                attachment.inline && attachment.contentId !== null
                  ? {
                      disposition: "inline" as const,
                      contentId: attachment.contentId,
                      filename: attachment.filename,
                      type: attachment.mime,
                      content: toArrayBuffer(attachment.content),
                    }
                  : {
                      disposition: "attachment" as const,
                      filename: attachment.filename,
                      type: attachment.mime,
                      content: toArrayBuffer(attachment.content),
                    },
              ),
            }),
      });

      return {
        ok: true,
        providerMessageId: result.messageId,
        // Handed off, not delivered. Calling these "accepted" would put a word
        // in the timeline that the provider has not yet earned; the terminal
        // state is what the event subscription says later.
        accepted: [],
        queued: recipients,
        rejected: [],
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const verdict = classifyFailure(error, reason);
      if (verdict.decidedBy === "prose") {
        // Logged because it is the branch that can rot without anyone noticing:
        // it decides a message's fate from the wording of an error string, and
        // the wording is not ours. A run of these in the logs is the signal to
        // add whatever code the provider is now sending to the table above.
        console.warn(
          `[transport] retryable=${verdict.retryable} decided by wording, no status code found: ${reason}`,
        );
      }
      return { ok: false, error: reason, retryable: verdict.retryable };
    }
  }
}

/**
 * The recipient lists, shaped so the compiler can see that at least one exists.
 *
 * The binding's type demands that, and it is right to: a send with nobody on it
 * is a bug, not an empty set. `send` already refuses one, but the refusal is a
 * runtime check the type system cannot see through, so the branching here is
 * what turns "we know it has recipients" into something provable. Empty lists
 * are omitted rather than sent as `[]`, which some providers read as a
 * malformed header rather than as no recipients.
 */
function destinationsOf(message: DispatchRequest): EmailDestinations {
  const to = [...message.to];
  const cc = [...message.cc];
  const bcc = [...message.bcc];

  if (to.length > 0) {
    return { to, ...(cc.length > 0 ? { cc } : {}), ...(bcc.length > 0 ? { bcc } : {}) };
  }
  if (cc.length > 0) return { cc, ...(bcc.length > 0 ? { bcc } : {}) };
  return { bcc };
}

/**
 * Whether trying again could plausibly work.
 *
 * This drives whether the queue consumer throws (retry) or records a permanent
 * failure, so getting it wrong in either direction costs something real:
 * retrying a rejected recipient burns quota against a wall, and giving up on a
 * throttle loses a message that would have gone out a minute later.
 *
 * Three sources, most trustworthy first, because they are not equally reliable:
 *
 *   1. An SMTP reply code on the error. RFC 5321 §4.2.1 is unambiguous: 4xx is
 *      transient, 5xx is permanent.
 *   2. An HTTP status on the error. Also unambiguous, and the OPPOSITE way
 *      round — 4xx is a client error nobody should retry, 5xx is the server
 *      saying it failed on its own account.
 *   3. The wording. A last resort, reported as `decidedBy: "prose"` so the
 *      caller can log it: an English keyword list is rephrased around by any
 *      change upstream, and silently, since the failure mode is a message that
 *      quietly stops being retried.
 *
 * The two code conventions being inverses of each other is why a bare number
 * found in the message text is NOT used. `421` is transient over SMTP and
 * permanent over HTTP, and a three-digit number in an error string does not say
 * which one it is — a guess there would be wrong systematically rather than
 * occasionally.
 *
 * Conservative throughout — the default is NOT retryable, so an unrecognised
 * error stops rather than looping. A message stuck in `failed` with a reason in
 * the timeline is a support question; a message retrying forever is a bill.
 */
interface RetryVerdict {
  readonly retryable: boolean;
  readonly decidedBy: "binding" | "smtp" | "http" | "prose";
}

export function classifyFailure(error: unknown, reason: string): RetryVerdict {
  const bindingCode = errorCode(error);
  if (bindingCode !== null) {
    const retryable = BINDING_ERROR_RETRYABLE[bindingCode];
    if (retryable !== undefined) return { retryable, decidedBy: "binding" };
  }

  const smtp = statusField(error, ["smtpCode", "smtp_code"]);
  if (smtp !== null) return { retryable: smtp < 500, decidedBy: "smtp" };

  const http = statusField(error, ["status", "statusCode"]);
  if (http !== null) return { retryable: RETRYABLE_HTTP.has(http), decidedBy: "http" };

  return { retryable: TRANSIENT_WORDING.test(reason), decidedBy: "prose" };
}

/**
 * Documented `send_email` binding errors, classified before SMTP/HTTP/prose.
 * A daily quota is deliberately permanent for this queue attempt: retrying the
 * same message three times over the next minute cannot make a daily budget
 * replenish, while rate limits and provider/internal failures can clear within
 * the queue's retry window.
 */
const BINDING_ERROR_RETRYABLE: Readonly<Record<string, boolean>> = {
  E_VALIDATION_ERROR: false,
  E_FIELD_MISSING: false,
  E_TOO_MANY_RECIPIENTS: false,
  E_SENDER_NOT_VERIFIED: false,
  E_RECIPIENT_NOT_ALLOWED: false,
  E_RECIPIENT_SUPPRESSED: false,
  E_SENDER_DOMAIN_NOT_AVAILABLE: false,
  E_CONTENT_TOO_LARGE: false,
  E_RATE_LIMIT_EXCEEDED: true,
  E_DAILY_LIMIT_EXCEEDED: false,
  E_DELIVERY_FAILED: true,
  E_INTERNAL_SERVER_ERROR: true,
  E_HEADER_NOT_ALLOWED: false,
  E_HEADER_USE_API_FIELD: false,
  E_HEADER_VALUE_INVALID: false,
  E_HEADER_VALUE_TOO_LONG: false,
  E_HEADER_NAME_INVALID: false,
  E_HEADERS_TOO_LARGE: false,
  E_HEADERS_TOO_MANY: false,
};

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as Record<string, unknown>)["code"];
  return typeof value === "string" ? value : null;
}

/**
 * A status the error object states outright, under any of the given keys.
 *
 * Several shapes are tried because the binding's failures are not a documented
 * type. Constrained to three digits so a Cloudflare internal error number like
 * `10021` — which is neither an SMTP reply nor an HTTP status — cannot be read
 * as one.
 */
function statusField(error: unknown, keys: readonly string[]): number | null {
  if (typeof error !== "object" || error === null) return null;
  const source = error as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    const numeric =
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d{3}$/.test(value)
          ? Number(value)
          : null;
    if (numeric !== null && numeric >= 100 && numeric <= 599) return numeric;
  }
  return null;
}

/**
 * The HTTP statuses worth another attempt. Named individually rather than taken
 * as a range: 500 and 501 are both 5xx, and only one of them is a server having
 * a bad minute — the other says the endpoint will never implement this.
 */
const RETRYABLE_HTTP: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

/** The last resort. See `classifyFailure` for why this is not the first one. */
const TRANSIENT_WORDING =
  /\b(rate|throttl|timeout|timed out|temporar|unavailable|try again|too many)\b/i;

/**
 * The binding serializes attachments, and a `Uint8Array` view over a larger
 * buffer would send the whole buffer. Slicing to exactly the view's own bytes
 * is what keeps a parsed attachment from carrying the rest of the message with
 * it.
 */
function toArrayBuffer(content: Uint8Array): ArrayBuffer {
  return content.buffer.slice(
    content.byteOffset,
    content.byteOffset + content.byteLength,
  ) as ArrayBuffer;
}

/**
 * The transport for a deployment that cannot send.
 *
 * Not only a fallback for development: Email Routing is free and works on the
 * Free plan, so a deployment can receive mail perfectly well while having no
 * `send_email` binding at all — no Workers Paid subscription, or no verified
 * sending domain yet. Receiving is the half of the product that works without a
 * credit card, and it should not be held hostage by the half that does not.
 *
 * It answers `ok: false` rather than throwing, because that is what the
 * `Delivery` state machine is for: the attempt is recorded, moved to a terminal
 * failed state, and shows up in `mailworker status` with a reason a human can
 * act on. A thrown error inside a Queues consumer would be retried forever
 * against a configuration no retry can change — hence `retryable: false`.
 */
export class UnconfiguredTransport implements MailTransport {
  async dispatch(_ctx: Caller, _message: DispatchRequest): Promise<DispatchResult> {
    return {
      ok: false,
      error:
        "This deployment has no sending binding configured. Sending needs Workers Paid " +
        "and a verified domain — run `mailworker doctor` to see what is missing.",
      retryable: false,
    };
  }
}
