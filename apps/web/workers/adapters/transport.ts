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
      return { ok: false, error: reason, retryable: isRetryable(reason) };
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
 * Matched on the message because the binding surfaces a plain `Error` rather
 * than a typed failure. Conservative on purpose — the default is NOT retryable,
 * so an unrecognised error stops rather than looping. A message stuck in
 * `failed` with a reason in the timeline is a support question; a message
 * retrying forever is a bill.
 */
function isRetryable(reason: string): boolean {
  return /\b(rate|throttl|timeout|timed out|temporar|unavailable|try again|50[0234])\b/i.test(
    reason,
  );
}

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
