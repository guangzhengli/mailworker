import type { Caller, EmailAddress, RfcMessageId } from "@core/domain";

/**
 * How a composed message leaves the building.
 *
 * A port rather than a direct call to the Cloudflare binding, and not mainly to
 * keep provider options open: the reason is `MemoryTransport`. It lets the whole
 * send path — policy gates, state machine, sent-copy storage, event publication
 * — run in a plain unit test with no network and no miniflare. For a project
 * whose selling point is testing email, being unable to test our own sending
 * would undercut the pitch.
 */
export interface MailTransport {
  dispatch(ctx: Caller, message: DispatchRequest): Promise<DispatchResult>;
}

export interface DispatchRequest {
  readonly from: EmailAddress;
  readonly fromName: string | null;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly replyTo: EmailAddress | null;
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly messageId: RfcMessageId;
  readonly inReplyTo: RfcMessageId | null;
  readonly references: readonly RfcMessageId[];
  /** Extra headers. Cloudflare caps these at 16 KiB combined. */
  readonly headers: Readonly<Record<string, string>>;
  readonly attachments: readonly OutboundAttachment[];
}

export interface OutboundAttachment {
  readonly filename: string;
  readonly mime: string;
  readonly content: Uint8Array;
  readonly inline: boolean;
  readonly contentId: string | null;
}

export type DispatchResult =
  | {
      readonly ok: true;
      /** Provider-side id, used later to match delivery events. May be absent. */
      readonly providerMessageId: string | null;
      /** Recipients the provider accepted outright. */
      readonly accepted: readonly EmailAddress[];
      /** Recipients it queued for later attempts. */
      readonly queued: readonly EmailAddress[];
      /** Recipients it refused permanently, at send time. */
      readonly rejected: readonly EmailAddress[];
    }
  | {
      readonly ok: false;
      readonly error: string;
      /** True when a retry could plausibly succeed (5xx, throttling). */
      readonly retryable: boolean;
    };
