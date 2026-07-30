import { SENDING_LIMITS } from "@core/domain/delivery/sending-limits";
import { DomainError, invalidArgument } from "@core/domain/errors";

/**
 * An outbound attachment as it travels through the send path: base64, not bytes.
 *
 * The encoding is not incidental. A send is accepted at one moment and dispatched
 * at another, with an R2 blob and a queue hop in between, and that blob is JSON
 * (`encodePayload`). Bytes do not survive `JSON.stringify`, so something has to
 * be base64 somewhere; keeping it base64 from the API boundary all the way to
 * `dispatch` means exactly one decode, at the point where the transport actually
 * wants an `ArrayBuffer`, instead of a decode-and-re-encode on either side of the
 * queue.
 *
 * The cost is that every size we reason about is a size of the DECODED content —
 * see `byteLength`, which computes it without doing the decode.
 */
export interface AttachmentSpec {
  readonly filename: string;
  readonly mime: string;
  /** Base64. `Attachment.decode` is the only thing that should undo this. */
  readonly content: string;
  /**
   * True for an image referenced from the HTML body as `cid:<contentId>`.
   * An inline part with no `contentId` is unreferenceable, so it is stored as
   * an ordinary attachment instead.
   */
  readonly inline: boolean;
  readonly contentId: string | null;
}

export const Attachment = {
  /**
   * Decoded size, computed from the base64 length rather than by decoding.
   *
   * The size gate runs on every send, including the ones it is about to refuse
   * for being too big. Decoding first would mean allocating the 20 MiB we are
   * refusing in order to discover that we are refusing it.
   */
  byteLength(base64: string): number {
    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
  },

  totalBytes(attachments: readonly AttachmentSpec[]): number {
    return attachments.reduce((sum, one) => sum + Attachment.byteLength(one.content), 0);
  },

  decode(spec: AttachmentSpec): Uint8Array {
    const binary = atob(spec.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  },

  /**
   * The whole-message size check, run before anything is stored or queued.
   *
   * Local refusal rather than letting Cloudflare answer `E_CONTENT_TOO_LARGE`:
   * a rejected send still costs a round trip and a row in the timeline, and the
   * caller learns nothing from a provider error that our own limit could have
   * named. Same reasoning as the recipient cap — see `sending-limits.ts`.
   *
   * The estimate is deliberately the honest one: base64 in transit inflates an
   * attachment by a third, and the provider measures the encoded message. Using
   * the decoded size here would accept messages that are under 5 MiB in our
   * arithmetic and over it in Cloudflare's.
   */
  enforceMessageSize(input: {
    readonly text: string | null;
    readonly html: string | null;
    readonly attachments: readonly AttachmentSpec[];
  }): void {
    if (input.attachments.length > SENDING_LIMITS.MAX_ATTACHMENTS) {
      throw invalidArgument(
        `Too many attachments: ${input.attachments.length} ` +
          `(max ${SENDING_LIMITS.MAX_ATTACHMENTS}).`,
        { count: input.attachments.length, max: SENDING_LIMITS.MAX_ATTACHMENTS },
      );
    }

    const bodyBytes =
      utf8Length(input.text ?? "") + utf8Length(input.html ?? "") + ENVELOPE_OVERHEAD_BYTES;
    // The base64 length itself, since that is what goes on the wire.
    const attachmentBytes = input.attachments.reduce((sum, one) => sum + one.content.length, 0);
    const total = bodyBytes + attachmentBytes;

    if (total > SENDING_LIMITS.MAX_MESSAGE_BYTES) {
      throw new DomainError(
        "message_too_large",
        `Message is ${Math.round(total / 1024)} KiB encoded, over the ` +
          `${SENDING_LIMITS.MAX_MESSAGE_BYTES / (1024 * 1024)} MiB limit.`,
        { bytes: total, max: SENDING_LIMITS.MAX_MESSAGE_BYTES },
      );
    }
  },
} as const;

/**
 * Headers, MIME boundaries and the part preambles, none of which are known until
 * the message is built. A flat allowance is enough: it only has to keep a message
 * that is a few bytes under the limit from becoming a few bytes over it once
 * assembled.
 */
const ENVELOPE_OVERHEAD_BYTES = 4 * 1024;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}
