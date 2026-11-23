import { EmailAddress } from "@core/domain/email-address";
import { invalidArgument } from "@core/domain/errors";
import type { AccountId } from "@core/domain/identity/account-id";
import type { Unsubscribe } from "@core/domain/mailbox/list-unsubscribe";
import { MailboxAddress } from "@core/domain/mailbox/mailbox-address";
import { truncateUtf8 } from "@core/domain/mailbox/message-body";
import type { RfcMessageId, ThreadId } from "@core/domain/mailbox/message-id";
import type { SenderAuth, TrustReason } from "@core/domain/mailbox/sender-auth";
import { UNKNOWN_SENDER_AUTH } from "@core/domain/mailbox/sender-auth";
import type { Ulid } from "@core/domain/ulid";

export type Direction = "inbound" | "outbound";
export type MessageOrigin = "email" | "injected" | "sandbox" | "outbound";

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
  /** ULID — primary key AND pagination cursor. Ordered by arrival. */
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly inboxId: Ulid;
  /** Identity owning the inbox when this placement was created. */
  readonly identityId: Ulid | null;

  readonly rfcMessageId: RfcMessageId;
  /**
   * Normalized SMTP RCPT TO for this inbound placement. This is deliberately
   * separate from the untrusted MIME `To:` header: catch-all routes and +tags
   * can place the same RFC message in one inbox more than once legitimately.
   * Outbound archive copies have no single envelope recipient and store null.
   */
  readonly envelopeRecipient: EmailAddress | null;
  readonly threadId: ThreadId;
  readonly direction: Direction;
  /** How these bytes entered the runtime. Never inferred from their content. */
  readonly origin: MessageOrigin;

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

  readonly auth: SenderAuth;
  readonly trusted: boolean;
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
  readonly starred: boolean;
  readonly archivedAt: Date | null;
  readonly labels: readonly string[];
  readonly listId: string | null;
  readonly unsubscribe: Unsubscribe | null;
  /**
   * The `Date` header. DISPLAY ONLY — never sort by this. A message with a
   * three-year-old Date arriving today would insert mid-sequence and invalidate
   * every cached cursor. Sort by `id`.
   */
  readonly sentAt: Date | null;
  readonly receivedAt: Date;
}

/** List projection: no bodies, no attachment rows. */
export interface MessageSummary
  extends Omit<Message, "bodyText" | "bodyHtml" | "attachments" | "listId" | "unsubscribe"> {
  readonly noteCount: number;
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
  readonly identityId?: Ulid | null;
  readonly rfcMessageId: RfcMessageId;
  readonly envelopeRecipient?: EmailAddress | null;
  readonly threadId: ThreadId;
  readonly direction: Direction;
  readonly origin?: MessageOrigin;
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
  readonly auth?: SenderAuth;
  readonly trusted?: boolean;
  readonly trustReasons?: readonly TrustReason[];
  readonly tag?: string | null;
  readonly autoSubmitted?: string | null;
  readonly rawKey?: string | null;
  readonly size?: number;
  readonly attachments?: readonly AttachmentMeta[];
  readonly seen?: boolean;
  readonly starred?: boolean;
  readonly archivedAt?: Date | null;
  readonly labels?: readonly string[];
  readonly listId?: string | null;
  readonly unsubscribe?: Unsubscribe | null;
  readonly sentAt?: Date | null;
}

export const PREVIEW_LENGTH = 160;

/**
 * How much of a body a preview is allowed to read.
 *
 * This exists so a list query does not have to load bodies. A store backed by a
 * real database selects `substr(body_text, 1, PREVIEW_SOURCE_LENGTH)` instead of
 * the column — the difference between a few kilobytes and several megabytes for
 * one page of fifty messages. Declaring the bound here rather than in the
 * adapter is what lets the in-memory store produce a byte-identical preview, so
 * the two implementations stay interchangeable.
 */
export const PREVIEW_SOURCE_LENGTH = 4000;
/** Bounds decoded header metadata retained beside the byte-exact raw MIME. */
export const MAX_STORED_HEADER_BYTES = 8 * 1024;
export const MAX_STORED_ADDRESSES_PER_HEADER = 100;
export const MAX_STORED_REFERENCES = 50;
export const MAX_STORED_ATTACHMENTS = 100;
export const MAX_ATTACHMENT_FILENAME_BYTES = 1024;
export const MAX_ATTACHMENT_MIME_BYTES = 255;
export const MAX_ATTACHMENT_CONTENT_ID_BYTES = 998;

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
      identityId: input.identityId ?? null,
      rfcMessageId: input.rfcMessageId,
      envelopeRecipient: inferEnvelopeRecipient(input),
      threadId: input.threadId,
      direction: input.direction,
      origin: input.origin ?? (input.direction === "outbound" ? "outbound" : "email"),
      fromHeader: truncateUtf8(input.fromHeader, MAX_STORED_HEADER_BYTES) ?? "",
      from: input.from,
      toHeader: truncateUtf8(input.toHeader, MAX_STORED_HEADER_BYTES) ?? "",
      to: (input.to ?? []).slice(0, MAX_STORED_ADDRESSES_PER_HEADER),
      cc: (input.cc ?? []).slice(0, MAX_STORED_ADDRESSES_PER_HEADER),
      bcc: (input.bcc ?? []).slice(0, MAX_STORED_ADDRESSES_PER_HEADER),
      replyTo: input.replyTo ?? null,
      subject: input.subject ?? "",
      bodyText: input.bodyText ?? null,
      bodyHtml: input.bodyHtml ?? null,
      inReplyTo: input.inReplyTo ?? null,
      references: (input.references ?? []).slice(-MAX_STORED_REFERENCES),
      auth: input.auth ?? UNKNOWN_SENDER_AUTH,
      trusted: input.trusted ?? false,
      trustReasons: input.trustReasons ?? [],
      tag: input.tag ?? null,
      autoSubmitted: truncateUtf8(input.autoSubmitted ?? null, MAX_STORED_HEADER_BYTES),
      rawKey: input.rawKey ?? null,
      size: input.size ?? 0,
      attachments: (input.attachments ?? []).slice(0, MAX_STORED_ATTACHMENTS).map((item) => ({
        ...item,
        filename: truncateUtf8(item.filename, MAX_ATTACHMENT_FILENAME_BYTES),
        mime: truncateUtf8(item.mime, MAX_ATTACHMENT_MIME_BYTES),
        contentId: truncateUtf8(item.contentId, MAX_ATTACHMENT_CONTENT_ID_BYTES),
      })),
      // Inbound arrives unread; our own sent copy is already read.
      seen: input.seen ?? input.direction === "outbound",
      starred: input.starred ?? false,
      archivedAt: input.archivedAt ?? null,
      labels: input.labels ?? [],
      listId: truncateUtf8(input.listId ?? null, MAX_STORED_HEADER_BYTES),
      unsubscribe: storedUnsubscribe(input.unsubscribe ?? null),
      sentAt: input.sentAt ?? null,
      receivedAt: input.receivedAt,
    };
  },

  summarize(message: Message, noteCount = 0): MessageSummary {
    const {
      bodyText,
      bodyHtml,
      attachments,
      listId: _listId,
      unsubscribe: _unsubscribe,
      ...rest
    } = message;
    return {
      ...rest,
      attachmentCount: attachments.length,
      noteCount,
      hasHtml: (bodyHtml ?? "").trim().length > 0,
      hasText: (bodyText ?? "").trim().length > 0,
      preview: Message.preview(message),
    };
  },

  preview(message: Message, length = PREVIEW_LENGTH): string {
    return Message.previewFrom(message.bodyText, length);
  },

  /**
   * The preview rule itself, over a body that a store may already have
   * truncated to `PREVIEW_SOURCE_LENGTH`. Truncating again here is what makes
   * that pre-truncation invisible: both callers get the same answer.
   */
  previewFrom(bodyText: string | null, length = PREVIEW_LENGTH): string {
    const collapsed = (bodyText ?? "")
      .slice(0, PREVIEW_SOURCE_LENGTH)
      .replace(/\s+/g, " ")
      .trim();
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

function storedUnsubscribe(unsubscribe: Unsubscribe | null): Unsubscribe | null {
  if (unsubscribe === null) return null;
  const encoder = new TextEncoder();
  const { https, mailto } = unsubscribe;
  // Truncating a URI can change its target.
  const storedHttps =
    https !== null && encoder.encode(https).byteLength <= MAX_STORED_HEADER_BYTES
      ? https
      : null;
  const storedMailto =
    mailto !== null && encoder.encode(mailto).byteLength <= MAX_STORED_HEADER_BYTES
      ? mailto
      : null;
  return storedHttps === null && storedMailto === null
    ? null
    : {
        https: storedHttps,
        mailto: storedMailto,
        oneClick: storedHttps !== null && unsubscribe.oneClick,
      };
}

/**
 * Compatibility fallback for fixtures and pre-route-aware callers. Production
 * ingestion always supplies the authenticated envelope value explicitly.
 */
function inferEnvelopeRecipient(input: CreateMessageInput): EmailAddress | null {
  if (input.direction === "outbound") return null;
  const candidate =
    input.envelopeRecipient ?? input.to?.[0] ?? EmailAddress.fromHeader(input.toHeader);
  return candidate === null
    ? null
    : (MailboxAddress.tryParse(candidate)?.routeKey ?? candidate);
}
