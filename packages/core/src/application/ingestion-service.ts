import type { AttachmentMeta, DomainEvent, ThreadId, Ulid } from "@core/domain";
import {
  AddressResolutionPolicy,
  BlobKeys,
  Caller,
  DomainError,
  encodeStoredMessageBody,
  Inbox,
  ListUnsubscribe,
  MailboxAddress,
  Message,
  RfcMessageId,
  SenderTrust,
  ThreadingPolicy,
} from "@core/domain";
import type {
  BlobStore,
  Clock,
  ContentHasher,
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
  readonly contentHasher: ContentHasher;
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
  /** Adapter-attested origin; caller payload cannot override this over HTTP. */
  readonly origin?: "email" | "injected" | "sandbox";
}

export type IngestResult =
  | { readonly outcome: "stored"; readonly message: Message; readonly inbox: Inbox }
  | { readonly outcome: "duplicate"; readonly rfcMessageId: string }
  | { readonly outcome: "unroutable"; readonly reason: string }
  | { readonly outcome: "inbox_unavailable"; readonly reason: string };

/** Cloudflare Email Routing rejects anything larger than this at SMTP time. */
export const MAX_INBOUND_MESSAGE_BYTES = 25 * 1024 * 1024;

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
      Caller.require(ctx, "message:inject");
      if (input.raw.byteLength > MAX_INBOUND_MESSAGE_BYTES) {
        throw new DomainError(
          "message_too_large",
          `Inbound message is ${input.raw.byteLength} bytes, over the ${MAX_INBOUND_MESSAGE_BYTES} byte limit.`,
          { bytes: input.raw.byteLength, max: MAX_INBOUND_MESSAGE_BYTES },
        );
      }
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
          identityId: !Caller.has(ctx, "admin") ? ctx.identityId : null,
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

      // The HTTP injection endpoint is agent-facing; Email Routing itself uses
      // an admin system caller. A bound key may only place fixtures in inboxes
      // it owns, otherwise it could forge mail into another agent's wait stream.
      if (
        !Caller.has(ctx, "admin") &&
        ctx.identityId !== null &&
        inbox.identityId !== ctx.identityId
      ) {
        return { outcome: "unroutable", reason: "no_such_inbox" };
      }

      const parsed = await deps.mimeParser.parse(input.raw);
      const messageUlid = deps.ids.ulid();
      // A missing Message-ID is synthesized from the original bytes. Email
      // Routing and queue consumers are at-least-once, so a random id would
      // turn the same delivery into a new message on every retry.
      const rfcMessageId =
        parsed.rfcMessageId ??
        RfcMessageId.parse(`mw-${await deps.contentHasher.sha256(input.raw)}@${inbox.domain}`);

      const candidates = ThreadingPolicy.candidateIds(parsed.inReplyTo, parsed.references);
      const known =
        candidates.length > 0
          ? await deps.messages.findThreadIds(ctx, candidates, inbox.id)
          : new Map<string, ThreadId>();
      const thread = ThreadingPolicy.resolve({
        ownMessageId: rfcMessageId,
        inReplyTo: parsed.inReplyTo,
        references: parsed.references,
        known,
      });

      const trust = SenderTrust.assess(parsed.auth);

      const rawKey = BlobKeys.rawMessage(ctx.accountId, messageUlid);
      const bodyKey = BlobKeys.messageBody(ctx.accountId, messageUlid);
      const attachments: AttachmentMeta[] = parsed.attachments.map((attachment) => {
        const attachmentId: Ulid = deps.ids.ulid();
        const key = BlobKeys.attachment(ctx.accountId, messageUlid, attachmentId);
        return {
          id: attachmentId,
          filename: attachment.filename,
          mime: attachment.mime,
          contentId: attachment.contentId,
          size: attachment.content.byteLength,
          inline: attachment.inline,
          storageKey: key,
        };
      });

      const message = Message.create({
        id: messageUlid,
        accountId: ctx.accountId,
        inboxId: inbox.id,
        identityId: inbox.identityId,
        rfcMessageId,
        // SMTP RCPT TO is adapter-attested. The MIME To header can be absent,
        // spoofed, or name a different address (BCC/forwarding), so it cannot
        // identify this placement for deduplication.
        envelopeRecipient: recipient.routeKey,
        threadId: thread.threadId,
        direction: "inbound",
        origin: input.origin ?? "email",
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
        listId: parsed.listId,
        unsubscribe: ListUnsubscribe.parse(parsed.listUnsubscribe, parsed.listUnsubscribePost),
        rawKey,
        size: input.raw.byteLength,
        attachments,
        sentAt: parsed.sentAt,
        receivedAt: now,
      });

      // Validate/build the D1 aggregate before creating any object. A hostile
      // oversized subject must not leak raw/body/attachment blobs on every
      // Email Routing retry.
      const writtenKeys: string[] = [];
      let stored: boolean;
      try {
        await deps.blobs.put(ctx, rawKey, input.raw, { contentType: "message/rfc822" });
        writtenKeys.push(rawKey);
        await deps.blobs.put(
          ctx,
          bodyKey,
          encodeStoredMessageBody({ bodyText: message.bodyText, bodyHtml: message.bodyHtml }),
          { contentType: "application/json" },
        );
        writtenKeys.push(bodyKey);
        for (const [index, meta] of message.attachments.entries()) {
          const attachment = parsed.attachments[index]!;
          await deps.blobs.put(ctx, meta.storageKey, attachment.content, {
            ...(meta.mime === null ? {} : { contentType: meta.mime }),
            ...(meta.filename === null ? {} : { filename: meta.filename }),
          });
          writtenKeys.push(meta.storageKey);
        }
        ({ stored } = await deps.messages.insert(ctx, message, { bodyKey }));
      } catch (error) {
        // D1 may have committed even when the response was lost. Re-read by
        // the deterministic placement before deleting objects; a possible
        // orphan is recoverable, a committed row pointing at deleted R2 is not.
        try {
          const committed = await deps.messages.findPlacement(
            ctx,
            inbox.id,
            recipient.routeKey,
            rfcMessageId,
          );
          if (committed === null) await deps.blobs.delete(ctx, writtenKeys);
        } catch {
          // Unknown commit outcome: preserve blobs for the next retry/sweep.
        }
        throw error;
      }
      if (!stored) {
        // These keys were minted for this placement, so deleting them cannot
        // affect the original row that won the uniqueness race. Without this,
        // every at-least-once redelivery leaks one raw object and every attachment.
        await deps.blobs.delete(ctx, writtenKeys);
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
        // Storage may have committed but its first notify RPC failed. A
        // redelivery is our durable chance to wake any listener that completed
        // its initial look-back just before that commit.
        const winner = await deps.messages.findPlacement(
          ctx,
          inbox.id,
          recipient.routeKey,
          rfcMessageId,
        );
        if (winner !== null) await deps.waiter.notify(ctx, winner);
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
