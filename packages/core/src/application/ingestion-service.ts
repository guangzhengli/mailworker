import type { AttachmentMeta, Caller, DomainEvent, ThreadId, Ulid } from "@core/domain";
import {
  AddressResolutionPolicy,
  BlobKeys,
  Inbox,
  MailboxAddress,
  Message,
  RfcMessageId,
  SenderTrust,
  ThreadingPolicy,
} from "@core/domain";
import type {
  BlobStore,
  Clock,
  DomainRepository,
  EventBus,
  IdGenerator,
  InboxRepository,
  MessageRepository,
  MimeParser,
  Waiter,
} from "@core/domain/ports";
/**
 * ingestion — raw mail becomes a stored, threaded, trust-assessed message.
 *
 * One method today. It gets `inject` (replay a fixture through the same path)
 * as soon as the CLI lands, which is precisely why it is a service and not a
 * free function: the second entry point should not need a second file.
 */

export interface IngestionDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly inboxes: InboxRepository;
  readonly messages: MessageRepository;
  readonly domains: DomainRepository;
  readonly blobs: BlobStore;
  readonly events: EventBus;
  readonly waiter: Waiter;
  readonly mimeParser: MimeParser;
}

export interface IngestInboundEmailInput {
  /** Envelope recipient, from the Email Routing handler. */
  readonly recipient: string;
  /** Envelope sender. Recorded for diagnostics; the From header is authoritative. */
  readonly envelopeFrom: string;
  readonly raw: Uint8Array;
}

export type IngestResult =
  | { readonly outcome: "stored"; readonly message: Message; readonly inbox: Inbox }
  | { readonly outcome: "duplicate"; readonly rfcMessageId: string }
  | { readonly outcome: "unroutable"; readonly reason: string }
  | { readonly outcome: "inbox_unavailable"; readonly reason: string };

export function createIngestionService(deps: IngestionDeps) {
  return {
    /**
     * The inbound path: raw MIME to a stored, threaded, trust-assessed message.
     *
     * Ordering here is not arbitrary. The raw bytes are archived BEFORE the row is
     * inserted, so a message can never exist in the database with nothing behind
     * `rawKey`; an orphaned blob (row insert fails after the put) is harmless and
     * gets swept, while the reverse renders as a broken message forever.
     *
     * Deduplication is left to the unique constraint rather than a read-then-write:
     * Email Routing can deliver the same message twice, and a check-then-insert
     * would race with itself under concurrent retries.
     */
    async ingest(ctx: Caller, input: IngestInboundEmailInput): Promise<IngestResult> {
      const now = deps.clock.now();
      const events: DomainEvent[] = [];

      const recipient = MailboxAddress.tryParse(input.recipient);
      if (recipient === null) {
        return { outcome: "unroutable", reason: "unparseable_recipient" };
      }

      const existing = await deps.inboxes.findByAddress(ctx, recipient.matchKey);
      const routing = await deps.domains.findRouting(ctx, recipient.domain);
      const resolution = AddressResolutionPolicy.resolve({
        recipient,
        existingInboxId: existing?.id ?? null,
        routing,
      });

      if (resolution.kind === "unroutable") {
        await deps.events.publish([
          {
            type: "message.unroutable",
            accountId: ctx.accountId,
            occurredAt: now,
            recipient: recipient.matchKey,
            reason: resolution.reason,
          },
        ]);
        return { outcome: "unroutable", reason: resolution.reason };
      }

      let inbox: Inbox;
      if (resolution.kind === "autocreate") {
        inbox = Inbox.create({
          id: deps.ids.ulid(),
          accountId: ctx.accountId,
          address: resolution.address,
          kind: "ephemeral",
          expiresAt: Inbox.expiryFromTtl(now, DEFAULT_AUTOCREATE_TTL_MS),
          now,
        });
        // Two deliveries to the same unknown address arrive at once — Email
        // Routing retries, and a sender can fan out — so both autocreate the
        // same inbox and one loses. Losing must not drop the mail: the message
        // is a fact that already happened, so fall back to the inbox the winner
        // wrote and file against that. `inbox.created` is only announced by the
        // winner, or a subscriber counts one creation twice.
        const { stored } = await deps.inboxes.insert(ctx, inbox);
        if (!stored) {
          const existing = await deps.inboxes.findByAddress(ctx, inbox.address);
          // Taken but unreadable means a soft-deleted row holds the address —
          // the unique index spans it, `findByAddress` does not. That is the
          // same "there is nowhere to file this" the deleted branch below
          // reports, so it answers the same way rather than throwing.
          if (existing === null) {
            return { outcome: "inbox_unavailable", reason: "inbox_deleted" };
          }
          inbox = existing;
        } else {
          events.push({
            type: "inbox.created",
            accountId: ctx.accountId,
            occurredAt: now,
            inboxId: inbox.id,
            address: inbox.address,
            expiresAt: inbox.expiresAt,
          });
        }
      } else {
        const found =
          resolution.kind === "inbox" && existing !== null
            ? existing
            : await deps.inboxes.findById(ctx, resolution.inboxId);
        if (found === null) {
          return { outcome: "unroutable", reason: "no_such_inbox" };
        }
        inbox = found;
      }

      if (!Inbox.canReceive(inbox, now)) {
        // Read-only, not gone: the caller gets a diagnosable reason.
        return {
          outcome: "inbox_unavailable",
          reason: Inbox.isDeleted(inbox) ? "inbox_deleted" : "inbox_expired",
        };
      }

      const parsed = await deps.mimeParser.parse(input.raw);
      const messageUlid = deps.ids.ulid();
      // A message with no Message-ID cannot be deduplicated or threaded by anyone,
      // so we mint one. Synthesising it from our own ULID keeps it stable if the
      // same bytes are replayed through `inject`.
      const rfcMessageId =
        parsed.rfcMessageId ?? RfcMessageId.parse(`${messageUlid}@${inbox.domain}`);

      const candidates = ThreadingPolicy.candidateIds(parsed.inReplyTo, parsed.references);
      const known =
        candidates.length > 0
          ? await deps.messages.findThreadIds(ctx, candidates)
          : new Map<string, ThreadId>();
      const thread = ThreadingPolicy.resolve({
        ownMessageId: rfcMessageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        known,
      });

      const trust = SenderTrust.assess(parsed.auth);

      const rawKey = BlobKeys.rawMessage(ctx.accountId, messageUlid);
      await deps.blobs.put(ctx, rawKey, input.raw, { contentType: "message/rfc822" });

      const attachments: AttachmentMeta[] = [];
      for (const attachment of parsed.attachments) {
        const attachmentId: Ulid = deps.ids.ulid();
        const key = BlobKeys.attachment(ctx.accountId, messageUlid, attachmentId);
        await deps.blobs.put(ctx, key, attachment.content, {
          ...(attachment.mime === null ? {} : { contentType: attachment.mime }),
          ...(attachment.filename === null ? {} : { filename: attachment.filename }),
        });
        attachments.push({
          id: attachmentId,
          filename: attachment.filename,
          mime: attachment.mime,
          contentId: attachment.contentId,
          size: attachment.content.byteLength,
          inline: attachment.inline,
          storageKey: key,
        });
      }

      const message = Message.create({
        id: messageUlid,
        accountId: ctx.accountId,
        inboxId: inbox.id,
        rfcMessageId,
        threadId: thread.threadId,
        direction: "inbound",
        fromHeader: parsed.fromHeader,
        from: parsed.from,
        toHeader: parsed.toHeader,
        to: parsed.to,
        cc: parsed.cc,
        replyTo: parsed.replyTo,
        subject: parsed.subject,
        bodyText: parsed.bodyText,
        bodyHtml: parsed.bodyHtml,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        auth: parsed.auth,
        trusted: trust.trusted,
        trustReasons: trust.reasons,
        tag: resolution.tag,
        autoSubmitted: parsed.autoSubmitted,
        rawKey,
        size: input.raw.byteLength,
        attachments,
        sentAt: parsed.sentAt,
        receivedAt: now,
      });

      const { stored } = await deps.messages.insert(ctx, message);
      if (!stored) {
        await deps.events.publish([
          ...events,
          {
            type: "message.duplicate",
            accountId: ctx.accountId,
            occurredAt: now,
            rfcMessageId,
            inboxId: inbox.id,
          },
        ]);
        return { outcome: "duplicate", rfcMessageId };
      }

      await deps.waiter.notify(ctx, message);
      await deps.events.publish([
        ...events,
        {
          type: "message.received",
          accountId: ctx.accountId,
          occurredAt: now,
          messageId: message.id,
          inboxId: inbox.id,
          threadId: message.threadId,
          from: message.from,
          subject: message.subject,
          trusted: message.trusted,
        },
      ]);

      return { outcome: "stored", message, inbox };
    },
  };
}

export type IngestionService = ReturnType<typeof createIngestionService>;

/** Inboxes minted by catch-all autocreate get a short life by default. */
export const DEFAULT_AUTOCREATE_TTL_MS = 24 * 60 * 60 * 1000;
