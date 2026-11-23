import type {
  Caller,
  DomainEvent,
  EmailAddress,
  Message,
  RfcMessageId,
  SenderAuth,
  WaitCriteria,
} from "@core/domain";
import type { OutboundAttachment } from "@core/domain/ports/transport";

/**
 * Publishes domain events. Queues in production; a recording array in tests,
 * which is how a use-case test asserts on decisions rather than only on rows.
 */
export interface EventBus {
  publish(events: readonly DomainEvent[]): Promise<void>;
}

/**
 * The rendezvous behind `GET /v1/messages/wait` and `mailworker wait`.
 *
 * Implemented with a Durable Object in production: a long poll needs somewhere
 * with an addressable identity for the ingest path to notify, and polling D1 in a
 * loop would both cost more and add latency to exactly the operation whose whole
 * value is being fast.
 */
export interface Waiter {
  /**
   * Block until a matching message arrives or the timeout elapses.
   * Resolves null on timeout — a timeout is an expected outcome here, not an
   * error, and the CLI turns it into exit code 4.
   */
  wait(ctx: Caller, criteria: WaitCriteria, timeoutMs: number): Promise<Message | null>;
  /** Called by the ingest path after a message is durably stored. */
  notify(ctx: Caller, message: Message): Promise<void>;
}

/** Parsed inbound message, the boundary between MIME handling and the domain. */
export interface ParsedInbound {
  readonly rfcMessageId: RfcMessageId | null;
  /** Decoded display form, e.g. `"Alice" <alice@corp.com>`. */
  readonly fromHeader: string;
  /**
   * The bare sender address.
   *
   * Supplied by the parser rather than re-extracted from `fromHeader`: the
   * parser already resolved it properly (including address groups), so parsing
   * a rendered string back apart would only lose information.
   */
  readonly from: EmailAddress | null;
  readonly toHeader: string;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly replyTo: EmailAddress | null;
  readonly subject: string;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
  readonly inReplyTo: RfcMessageId | null;
  /** Oldest first, as the `References` header orders them. */
  readonly references: readonly RfcMessageId[];
  readonly auth: SenderAuth;
  readonly sentAt: Date | null;
  readonly autoSubmitted: string | null;
  readonly listId: string | null;
  readonly listUnsubscribe: string | null;
  readonly listUnsubscribePost: string | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly attachments: readonly ParsedAttachment[];
}

export interface ParsedAttachment {
  readonly filename: string | null;
  readonly mime: string | null;
  readonly contentId: string | null;
  readonly inline: boolean;
  readonly content: Uint8Array;
}

export interface MimeParser {
  parse(raw: Uint8Array): Promise<ParsedInbound>;
}

/** Builds the RFC 5322 bytes we hand to the transport and archive in R2. */
export interface MimeBuilder {
  build(spec: BuildMimeSpec): Promise<Uint8Array>;
}

export interface BuildMimeSpec {
  readonly from: EmailAddress;
  readonly fromName: string | null;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly messageId: RfcMessageId;
  readonly inReplyTo: RfcMessageId | null;
  readonly references: readonly RfcMessageId[];
  readonly date: Date;
  readonly headers: Readonly<Record<string, string>>;
  readonly attachments: readonly OutboundAttachment[];
}
