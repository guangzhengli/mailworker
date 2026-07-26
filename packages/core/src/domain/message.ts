import type { AccountId } from "./account-id.ts";
import type { EmailAddress } from "./address.ts";
import type { AuthVerdict, TrustReason } from "./auth-verdict.ts";
import { UNKNOWN_VERDICT } from "./auth-verdict.ts";
import { invalidArgument } from "./errors.ts";
import type { RfcMessageId, ThreadId } from "./message-id.ts";
import type { Ulid } from "./ulid.ts";

export type Direction = "inbound" | "outbound";

export interface AttachmentMeta {
  readonly id: Ulid;
  readonly filename: string | null;
  readonly mime: string | null;
  /** Content-ID, for inline images referenced from the HTML body. */
  readonly contentId: string | null;
  readonly size: number;
  readonly inline: boolean;
  /** Blob store key. Never exposed raw to API clients. */
  readonly storageKey: string;
}

/**
 * A stored message, inbound or outbound. One table, one shape: an agent asking
 * "what happened in this conversation" should not have to union two schemas, and
 * threading has to resolve across both directions anyway.
 */
export interface Message {
  /** ULID — primary key AND pagination cursor. Ordered by arrival (ADR-2). */
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly inboxId: Ulid;

  readonly rfcMessageId: RfcMessageId;
  readonly threadId: ThreadId;
  readonly direction: Direction;

  /**
   * The raw `From` header, display name preserved
   * (e.g. `"Cloudflare" <noreply@notify.cloudflare.com>`).
   * This is the HEADER, not the SMTP envelope sender — for VERP/bounce senders
   * those differ, and a reply must be addressed to the header.
   */
  readonly fromHeader: string;
  /** Bare address extracted from `fromHeader`. Null if it was unparseable. */
  readonly from: EmailAddress | null;
  readonly toHeader: string;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly replyTo: EmailAddress | null;

  readonly subject: string;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;

  readonly inReplyTo: RfcMessageId | null;
  readonly references: readonly RfcMessageId[];

  readonly auth: AuthVerdict;
  readonly trusted: boolean;
  readonly injectionRisk: boolean;
  readonly trustReasons: readonly TrustReason[];

  /** The `+tag` the message was addressed to, if any. */
  readonly tag: string | null;
  /**
   * The `Auto-Submitted` header (RFC 3834), verbatim.
   *
   * Stored specifically so LoopBreakerPolicy can see it when we later reply:
   * without it, deciding "is this an automated reply to an automated message"
   * would need a re-parse of the raw MIME on every send.
   */
  readonly autoSubmitted: string | null;
  /** Blob store key of the original MIME. Null only if storage failed. */
  readonly rawKey: string | null;
  readonly size: number;
  readonly attachments: readonly AttachmentMeta[];

  readonly seen: boolean;
  /**
   * The `Date` header. DISPLAY ONLY — never sort by this. A message with a
   * three-year-old Date arriving today would insert mid-sequence and invalidate
   * every cached cursor. Sort by `id`.
   */
  readonly sentAt: Date | null;
  readonly receivedAt: Date;
}

/** List projection: no bodies, no attachment rows. */
export interface MessageSummary extends Omit<Message, "bodyText" | "bodyHtml" | "attachments"> {
  readonly attachmentCount: number;
  readonly hasHtml: boolean;
  readonly hasText: boolean;
  /** Short plain-text excerpt for list rendering. */
  readonly preview: string;
}

export interface CreateMessageInput {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly inboxId: Ulid;
  readonly rfcMessageId: RfcMessageId;
  readonly threadId: ThreadId;
  readonly direction: Direction;
  readonly fromHeader: string;
  readonly from: EmailAddress | null;
  readonly toHeader: string;
  readonly receivedAt: Date;
  readonly to?: readonly EmailAddress[];
  readonly cc?: readonly EmailAddress[];
  readonly bcc?: readonly EmailAddress[];
  readonly replyTo?: EmailAddress | null;
  readonly subject?: string;
  readonly bodyText?: string | null;
  readonly bodyHtml?: string | null;
  readonly inReplyTo?: RfcMessageId | null;
  readonly references?: readonly RfcMessageId[];
  readonly auth?: AuthVerdict;
  readonly trusted?: boolean;
  readonly injectionRisk?: boolean;
  readonly trustReasons?: readonly TrustReason[];
  readonly tag?: string | null;
  readonly autoSubmitted?: string | null;
  readonly rawKey?: string | null;
  readonly size?: number;
  readonly attachments?: readonly AttachmentMeta[];
  readonly seen?: boolean;
  readonly sentAt?: Date | null;
}

export const PREVIEW_LENGTH = 160;

export const Message = {
  create(input: CreateMessageInput): Message {
    if (input.subject !== undefined && input.subject.length > 2000) {
      throw invalidArgument("Subject exceeds 2000 characters.", {
        length: input.subject.length,
      });
    }
    return {
      id: input.id,
      accountId: input.accountId,
      inboxId: input.inboxId,
      rfcMessageId: input.rfcMessageId,
      threadId: input.threadId,
      direction: input.direction,
      fromHeader: input.fromHeader,
      from: input.from,
      toHeader: input.toHeader,
      to: input.to ?? [],
      cc: input.cc ?? [],
      bcc: input.bcc ?? [],
      replyTo: input.replyTo ?? null,
      subject: input.subject ?? "",
      bodyText: input.bodyText ?? null,
      bodyHtml: input.bodyHtml ?? null,
      inReplyTo: input.inReplyTo ?? null,
      references: input.references ?? [],
      auth: input.auth ?? UNKNOWN_VERDICT,
      trusted: input.trusted ?? false,
      injectionRisk: input.injectionRisk ?? input.direction === "inbound",
      trustReasons: input.trustReasons ?? [],
      tag: input.tag ?? null,
      autoSubmitted: input.autoSubmitted ?? null,
      rawKey: input.rawKey ?? null,
      size: input.size ?? 0,
      attachments: input.attachments ?? [],
      // Inbound arrives unread; our own sent copy is already read.
      seen: input.seen ?? input.direction === "outbound",
      sentAt: input.sentAt ?? null,
      receivedAt: input.receivedAt,
    };
  },

  summarize(message: Message): MessageSummary {
    const { bodyText, bodyHtml, attachments, ...rest } = message;
    return {
      ...rest,
      attachmentCount: attachments.length,
      hasHtml: (bodyHtml ?? "").trim().length > 0,
      hasText: (bodyText ?? "").trim().length > 0,
      preview: Message.preview(message),
    };
  },

  preview(message: Message, length = PREVIEW_LENGTH): string {
    const source = message.bodyText ?? "";
    const collapsed = source.replace(/\s+/g, " ").trim();
    return collapsed.length <= length ? collapsed : `${collapsed.slice(0, length - 1)}…`;
  },

  markSeen(message: Message, seen: boolean): Message {
    return { ...message, seen };
  },

  /** Ids this message claims to descend from, oldest first, deduplicated. */
  ancestry(message: Message): RfcMessageId[] {
    const seen = new Set<string>();
    const result: RfcMessageId[] = [];
    for (const id of [...message.references, message.inReplyTo]) {
      if (id !== null && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    return result;
  },
} as const;
