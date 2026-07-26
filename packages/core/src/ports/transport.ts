import type { AuthContext, EmailAddress, RfcMessageId } from "@/domain/index.ts";

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
export interface MailTransportPort {
  dispatch(ctx: AuthContext, message: DispatchRequest): Promise<DispatchResult>;
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

/**
 * Cloudflare Email Sending limits, encoded once so the send path can check them
 * before burning an API call. Verified 2026-07; see DESIGN.md §2.2.
 */
export const TRANSPORT_LIMITS = {
  /** 5 MiB total message size, including attachments. */
  MAX_MESSAGE_BYTES: 5 * 1024 * 1024,
  /** 25 MiB when every recipient is a verified destination address. */
  MAX_MESSAGE_BYTES_VERIFIED: 25 * 1024 * 1024,
  /** 50 across to + cc + bcc. */
  MAX_RECIPIENTS: 50,
  /** 16 KiB for all custom headers combined. */
  MAX_HEADER_BYTES: 16 * 1024,
} as const;
