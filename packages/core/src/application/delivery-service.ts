import type {
  AgentIdentity,
  AttachmentMeta,
  AttachmentSpec,
  Check,
  CheckStatus,
  DeliveryEventType,
  DeliverySource,
  DomainErrorCode,
  DomainEvent,
  DomainEventType,
  Page,
  SuppressionEntry,
  ThreadId,
} from "@core/domain";
import {
  Attachment,
  BlobKeys,
  Caller,
  Delivery,
  DomainError,
  DomainHealthPolicy,
  EmailAddress,
  encodeStoredMessageBody,
  invalidArgument,
  isDomainError,
  LoopBreakerPolicy,
  Message,
  notFound,
  RfcMessageId,
  SENDING_LIMITS,
  SendPolicy,
  ThreadingPolicy,
  Ulid,
  WebhookSubscription,
} from "@core/domain";
import type {
  BlobStore,
  Clock,
  DeliveryEvent,
  DeliveryRepository,
  DispatchQueue,
  DnsResolver,
  DomainRepository,
  EventBus,
  IdentityRepository,
  IdGenerator,
  InboxRepository,
  ListDeliveriesQuery,
  LoopbackSink,
  MailTransport,
  MessageRepository,
  MimeBuilder,
  Secrets,
  SuppressionList,
  WebhookRepository,
  WebhookSender,
} from "@core/domain/ports";
/**
 * delivery — the gates in front of a send, the network call, and the fate after.
 *
 * The three methods are one pipeline deliberately split at durable points:
 * `send` ends at `queued` with the policy decision and the payload already
 * stored, `dispatch` runs in the queue consumer, `recordEvent` folds in what
 * the provider says minutes or days later.
 */

export interface DeliveryDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly inboxes: InboxRepository;
  readonly messages: MessageRepository;
  readonly deliveries: DeliveryRepository;
  readonly identities: IdentityRepository;
  readonly domains: DomainRepository;
  readonly webhooks: WebhookRepository;
  readonly suppressions: SuppressionList;
  readonly blobs: BlobStore;
  readonly events: EventBus;
  readonly transport: MailTransport;
  readonly dispatchQueue: DispatchQueue;
  readonly dns: DnsResolver;
  readonly secrets: Secrets;
  readonly webhookSender: WebhookSender;
  readonly mimeBuilder: MimeBuilder;
  readonly loopback: LoopbackSink;
}

export interface SendMessageRequest {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly replyTo?: string;
  readonly inReplyToMessageId?: string;
  readonly headers?: Record<string, string>;
  readonly attachments?: readonly AttachmentSpec[];
  /**
   * Caller-defined key/value pairs, echoed on the delivery and on every webhook
   * event about it. Opaque to us on purpose: this is how a caller correlates a
   * bounce three days later with the order, tenant or test run that caused the
   * send, without us having to model any of those.
   */
  readonly metadata?: Record<string, string>;
  readonly idempotencyKey?: string;
  /** True when a machine triggered this. Drives loop breaking and `Auto-Submitted`. */
  readonly automated?: boolean;
  /**
   * Who authored it. Set by the driving adapter, never by the caller's payload:
   * `console` skips the approval hold, so accepting it over the wire would let
   * an agent opt out of the queue by claiming to be a human.
   */
  readonly source?: DeliverySource;
}

export type SendResult =
  | { readonly outcome: "queued"; readonly delivery: Delivery }
  | { readonly outcome: "pending_approval"; readonly delivery: Delivery }
  | { readonly outcome: "duplicate"; readonly delivery: Delivery };

/**
 * One message's fate inside a batch.
 *
 * `index` is on every item, including the failures, because the response is the
 * only thing correlating a result back to the message the caller submitted — and
 * a rejected message has no delivery id to correlate by.
 */
export type BatchSendItem =
  | ({ readonly index: number } & SendResult)
  | {
      readonly index: number;
      readonly outcome: "error";
      readonly code: DomainErrorCode;
      readonly message: string;
      readonly details: Readonly<Record<string, unknown>>;
    };

export interface DeliveryPayload {
  readonly from: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly replyTo: EmailAddress | null;
  readonly subject: string;
  readonly text: string | null;
  readonly html: string | null;
  readonly messageId: RfcMessageId;
  readonly inReplyTo: RfcMessageId | null;
  /**
   * The stored parent, when the caller named one. The RFC id alone is ambiguous:
   * one Message-ID can be placed in several inboxes. Absent on older payloads.
   */
  readonly inReplyToMessageId?: Ulid | null;
  readonly references: readonly RfcMessageId[];
  readonly headers: Record<string, string>;
  /**
   * Optional because payloads written before attachments existed do not have
   * the field, and a queue can still be holding one when this deploys.
   */
  readonly attachments?: readonly AttachmentSpec[];
}

export interface DispatchDeliveryRequest {
  readonly deliveryId: string;
}

export interface DeliveryPreview {
  readonly subject: string;
  readonly from: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly replyTo: EmailAddress | null;
  readonly text: string | null;
  readonly html: string | null;
  readonly attachments: readonly AttachmentManifestEntry[];
  /** The stored message this replies to, when it is one the caller can read. */
  readonly inReplyToMessageId: Ulid | null;
}

export interface AttachmentManifestEntry {
  readonly filename: string;
  readonly mime: string;
  readonly bytes: number;
  readonly inline: boolean;
}

export type DispatchOutcome =
  | {
      readonly outcome: "dispatched";
      readonly delivery: Delivery;
      readonly sentCopy: Message;
    }
  | { readonly outcome: "failed"; readonly delivery: Delivery; readonly error: string }
  | { readonly outcome: "skipped"; readonly reason: string };

/**
 * One event as Cloudflare publishes it to the subscribed queue. Shape follows
 * `cf.email.sending.message.*`, flattened by the adapter.
 */
export interface ProviderDeliveryEvent {
  readonly eventId: string;
  readonly type: DeliveryEventType;
  readonly providerMessageId: string;
  readonly recipient: EmailAddress | null;
  readonly sourceDomain: string;
  readonly sourceZoneId: string;
  readonly occurredAt: Date;
  readonly terminal: boolean;
  readonly smtpCode?: string | null;
  readonly smtpEnhancedCode?: string | null;
  readonly smtpResponse?: string | null;
  readonly bounceType?: "hard" | "soft" | null;
  readonly bounceClassification?: string | null;
  readonly bounceReason?: string | null;
  readonly raw?: string | null;
}

export type RecordEventOutcome =
  | { readonly outcome: "applied"; readonly from: string; readonly to: string }
  | { readonly outcome: "recorded_only"; readonly reason: string }
  | { readonly outcome: "duplicate" }
  | { readonly outcome: "unmatched" };

export interface DispatchReconcileResult {
  examined: number;
  enqueued: number;
  discarded: number;
  markedUnknown: number;
  failed: number;
  backlogRemaining: boolean;
}

export const DEFAULT_DISPATCH_RECONCILE_LIMIT = 200;
export const DISPATCH_LEASE_MS = 5 * 60 * 1000;
const UNKNOWN_HANDOFF_REASON =
  "Dispatch worker stopped during provider hand-off; delivery outcome is unknown. Verify before retrying.";

export function createDeliveryService(deps: DeliveryDeps) {
  async function publishStagedDispatch(ctx: Caller, deliveryId: Ulid): Promise<void> {
    // This row is a durable processing fact, not merely a D1-to-Queue hand-off.
    // It stays until transport hand-off AND sent-copy archival complete. That
    // lets cron recover a stopped consumer without ever repeating a successful
    // provider call just because the local archive failed afterwards.
    await deps.dispatchQueue.enqueue(ctx, deliveryId);
  }

  async function persistNewDelivery(
    ctx: Caller,
    delivery: Delivery,
    payloadKey: string,
    stageDispatch: boolean,
    quota: { readonly identityId: Ulid; readonly maximum: number } | null,
    exchange: {
      readonly from: EmailAddress;
      readonly recipients: readonly EmailAddress[];
    } | null,
    request: SendMessageRequest,
  ): Promise<SendResult | null> {
    const result = await deps.deliveries.insert(ctx, delivery, {
      ...(stageDispatch ? { stageDispatch: true } : {}),
      ...(quota === null
        ? {}
        : {
            quota: {
              identityId: quota.identityId,
              maximum: quota.maximum,
              since: new Date(delivery.createdAt.getTime() - QUOTA_WINDOW_MS),
            },
          }),
      ...(exchange === null
        ? {}
        : {
            exchange: {
              ...exchange,
              maximum: LoopBreakerPolicy.MAX_EXCHANGES_PER_WINDOW,
              since: new Date(
                delivery.createdAt.getTime() - LoopBreakerPolicy.EXCHANGE_WINDOW_MS,
              ),
            },
          }),
    });
    if (result === "inserted") return null;

    // Another request won the idempotency race after our optimistic read. Its
    // payload is keyed by its own delivery id, so this loser's blob is safe to
    // remove and must not become permanent R2 garbage.
    await deps.blobs.delete(ctx, [payloadKey]);
    if (result === "quota_exceeded") {
      throw new DomainError(
        "quota_exceeded",
        `Identity reached its quota of ${quota?.maximum ?? 0} messages.`,
        { quota: quota?.maximum ?? 0, identityId: quota?.identityId ?? null },
      );
    }
    if (result === "exchange_limit_exceeded") {
      throw new DomainError(
        "loop_detected",
        "Too many recent accepted sends to this recipient.",
        {
          reason: "too_many_exchanges",
          max: LoopBreakerPolicy.MAX_EXCHANGES_PER_WINDOW,
        },
      );
    }
    if (delivery.idempotencyKey === null) {
      throw new Error("A delivery id collided unexpectedly.");
    }
    const existing = await deps.deliveries.findByIdempotencyKey(
      ctx,
      delivery.idempotencyKey,
      delivery.identityId,
    );
    if (existing === null) {
      throw new Error("Idempotent delivery winner is missing after a unique-key conflict.");
    }
    await assertIdempotentRequestMatches(ctx, request, existing);
    if (resourceIdentity(ctx) !== null && existing.identityId !== resourceIdentity(ctx)) {
      throw invalidArgument("That idempotency key is already in use.", {
        idempotencyKey: delivery.idempotencyKey,
      });
    }
    return { outcome: "duplicate", delivery: existing };
  }

  async function assertIdempotentRequestMatches(
    ctx: Caller,
    request: SendMessageRequest,
    existing: Delivery,
  ): Promise<void> {
    if (existing.payloadKey === null) return;
    const bytes = await deps.blobs.get(ctx, existing.payloadKey);
    // Retention may remove the old payload while the idempotency row remains.
    // In that legacy case preserve retry safety; there is no body left to prove
    // either equality or conflict.
    if (bytes === null) return;
    const payload = decodePayload(bytes);

    let intendedParent: RfcMessageId | null = null;
    if (request.inReplyToMessageId !== undefined) {
      const parent = await deps.messages.findById(ctx, Ulid.parse(request.inReplyToMessageId));
      if (parent === null) return;
      intendedParent = parent.rfcMessageId;
    }

    const intended = canonicalJson({
      from: EmailAddress.parse(request.from),
      to: request.to.map(EmailAddress.parse),
      cc: (request.cc ?? []).map(EmailAddress.parse),
      bcc: (request.bcc ?? []).map(EmailAddress.parse),
      replyTo: request.replyTo === undefined ? null : EmailAddress.parse(request.replyTo),
      subject: request.subject,
      text: request.text ?? null,
      html: request.html ?? null,
      inReplyTo: intendedParent,
      headers: {
        ...request.headers,
        "Auto-Submitted": LoopBreakerPolicy.autoSubmittedHeader(request.automated ?? false),
      },
      attachments: request.attachments ?? [],
      metadata: request.metadata ?? {},
      source: request.source ?? "agent",
    });
    const recorded = canonicalJson({
      from: payload.from,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      replyTo: payload.replyTo,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      inReplyTo: payload.inReplyTo,
      headers: payload.headers,
      attachments: payload.attachments ?? [],
      metadata: existing.metadata,
      source: existing.source,
    });
    if (intended !== recorded) {
      throw new DomainError(
        "idempotency_conflict",
        "This idempotency key was already used for a different send request.",
        { idempotencyKey: request.idempotencyKey ?? null, deliveryId: existing.id },
      );
    }
  }

  const service = {
    /**
     * Everything between "an agent wants to send" and "it is safe to hand to a
     * transport". Ends at `queued`; `dispatch` does the network call.
     *
     * Splitting there is what makes the send path retryable. The policy decision,
     * the audit row and the payload are durable before anything leaves, so a failed
     * dispatch is a retry against a recorded decision rather than a re-litigation of
     * whether the send was allowed — and a crash mid-send cannot lose the fact that
     * we accepted it.
     */
    async send(ctx: Caller, input: SendMessageRequest): Promise<SendResult> {
      Caller.require(ctx, "message:send");
      const now = deps.clock.now();

      // Idempotency first: a retried request must not re-run the policy gates,
      // let alone re-send.
      if (input.idempotencyKey !== undefined) {
        const existing = await deps.deliveries.findByIdempotencyKey(
          ctx,
          input.idempotencyKey,
          resourceIdentity(ctx),
        );
        if (existing !== null) {
          if (resourceIdentity(ctx) !== null && existing.identityId !== resourceIdentity(ctx)) {
            throw invalidArgument("That idempotency key is already in use.", {
              idempotencyKey: input.idempotencyKey,
            });
          }
          await assertIdempotentRequestMatches(ctx, input, existing);
          return { outcome: "duplicate", delivery: existing };
        }
      }

      if (input.text === undefined && input.html === undefined) {
        throw invalidArgument("A message needs `text`, `html`, or both.");
      }

      // Before the reads below, not after: this needs no I/O to decide, and a
      // 6 MiB attachment should not cost an inbox lookup and a quota count
      // before being told it is too big.
      const attachments = input.attachments ?? [];
      Attachment.validateHeaders(input.headers ?? {});
      Attachment.enforceMessageSize({
        text: input.text ?? null,
        html: input.html ?? null,
        attachments,
      });

      const from = EmailAddress.parse(input.from);
      const to = input.to.map((value) => EmailAddress.parse(value));
      const cc = (input.cc ?? []).map((value) => EmailAddress.parse(value));
      const bcc = (input.bcc ?? []).map((value) => EmailAddress.parse(value));
      const recipients = [...to, ...cc, ...bcc];

      if (recipients.length === 0) {
        throw invalidArgument("A message needs at least one recipient.");
      }

      // The From address must be an inbox we own — otherwise the reply has nowhere
      // to land, and Cloudflare would refuse the send anyway.
      const inbox = await deps.inboxes.findByAddress(ctx, from);
      if (inbox === null) {
        throw new DomainError("inbox_not_found", `No inbox owns ${from}; cannot send as it.`, {
          from,
        });
      }
      // An identity-bound credential owns only inboxes explicitly assigned to
      // that identity. Answer as if the address did not exist so the key cannot
      // use the send endpoint as an oracle for another agent's resources.
      if (
        ctx.identityId !== null &&
        !Caller.has(ctx, "admin") &&
        inbox.identityId !== ctx.identityId
      ) {
        throw new DomainError("inbox_not_found", `No inbox owns ${from}; cannot send as it.`, {
          from,
        });
      }

      const identity = await resolveIdentity(deps, ctx, inbox.identityId);

      // An unbound/admin caller can legitimately send from an identity-owned
      // inbox. Its optimistic lookup above cannot know that identity yet, so do
      // the authoritative lookup now, before quota or policy changes could turn
      // a harmless retry into a rejection.
      if (input.idempotencyKey !== undefined && identity?.id !== resourceIdentity(ctx)) {
        const existing = await deps.deliveries.findByIdempotencyKey(
          ctx,
          input.idempotencyKey,
          identity?.id ?? null,
        );
        if (existing !== null) {
          await assertIdempotentRequestMatches(ctx, input, existing);
          return { outcome: "duplicate", delivery: existing };
        }
      }

      let inReplyTo: RfcMessageId | null = null;
      let inReplyToMessageId: Ulid | null = null;
      let references: RfcMessageId[] = [];
      let inboundAutoSubmitted: string | null = null;
      if (input.inReplyToMessageId !== undefined) {
        const parent = await deps.messages.findById(ctx, Ulid.parse(input.inReplyToMessageId));
        if (parent === null) {
          throw new DomainError(
            "message_not_found",
            `No message ${input.inReplyToMessageId}.`,
            {
              messageId: input.inReplyToMessageId,
            },
          );
        }
        if (resourceIdentity(ctx) !== null && parent.identityId !== resourceIdentity(ctx)) {
          throw new DomainError(
            "message_not_found",
            `No message ${input.inReplyToMessageId}.`,
            { messageId: input.inReplyToMessageId },
          );
        }
        inReplyTo = parent.rfcMessageId;
        inReplyToMessageId = parent.id;
        references = [...parent.references, parent.rfcMessageId];
        inboundAutoSubmitted = parent.autoSubmitted;
      }

      const suppressed = await deps.suppressions.filterSuppressed(ctx, recipients);
      const sentInWindow = await deps.deliveries.countSince(
        ctx,
        identity?.id ?? null,
        new Date(now.getTime() - QUOTA_WINDOW_MS),
      );
      const exchangesInWindow = await maxExchanges(deps, ctx, from, to, now);

      const loop = LoopBreakerPolicy.check({
        referencesDepth: references.length,
        exchangesInWindow,
        inboundAutoSubmitted,
        automated: input.automated ?? false,
        selfAddressed: recipients.some((recipient) => recipient === from),
      });

      const decision = SendPolicy.evaluate({
        scopes: ctx.scopes,
        mode: ctx.mode,
        identity,
        from,
        recipients,
        suppressedRecipients: suppressed,
        sentInWindow,
        loop,
      });

      if (decision.kind === "reject") {
        await deps.events.publish([
          {
            type: "delivery.rejected",
            accountId: ctx.accountId,
            occurredAt: now,
            metadata: input.metadata ?? {},
            deliveryId: null,
            reason: decision.reason,
            code: decision.code,
          },
        ]);
        throw SendPolicy.toError(decision);
      }

      const deliveryId = deps.ids.ulid();
      const rfcMessageId = deps.ids.rfcMessageId(EmailAddress.domain(from));
      const payload: DeliveryPayload = {
        from,
        to,
        cc,
        bcc,
        replyTo: input.replyTo === undefined ? null : EmailAddress.parse(input.replyTo),
        subject: input.subject,
        text: input.text ?? null,
        html: input.html ?? null,
        messageId: rfcMessageId,
        inReplyTo,
        inReplyToMessageId,
        references,
        headers: {
          ...input.headers,
          // Always announce automation, so a well-behaved peer can break the loop
          // from its side too (RFC 3834).
          "Auto-Submitted": LoopBreakerPolicy.autoSubmittedHeader(input.automated ?? false),
        },
        attachments,
      };

      const payloadKey = BlobKeys.deliveryPayload(ctx.accountId, deliveryId);
      await deps.blobs.put(ctx, payloadKey, encodePayload(payload), {
        contentType: "application/json",
      });

      const source = input.source ?? "agent";
      const quota =
        identity?.dailySendQuota == null
          ? null
          : { identityId: identity.id, maximum: identity.dailySendQuota };
      let delivery = Delivery.create({
        id: deliveryId,
        accountId: ctx.accountId,
        recipients,
        inboxId: inbox.id,
        identityId: identity?.id ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        payloadKey,
        metadata: input.metadata ?? {},
        source,
        now,
      });

      // A console send is a human at the keyboard, so the approval hold does not
      // apply: the queue exists to put a second principal between an agent and
      // the outside world, and here the sender IS that second principal. Every
      // rejecting gate above still ran.
      if (decision.kind === "require_approval" && source === "console") {
        delivery = Delivery.enqueue(delivery, now);
        const duplicate = await persistNewDelivery(
          ctx,
          delivery,
          payloadKey,
          true,
          quota,
          { from, recipients },
          input,
        );
        if (duplicate !== null) return duplicate;
        await deps.events.publish([
          {
            type: "delivery.queued",
            accountId: ctx.accountId,
            occurredAt: now,
            metadata: delivery.metadata,
            deliveryId: delivery.id,
            recipients,
          },
        ]);
        await publishStagedDispatch(ctx, delivery.id);
        return { outcome: "queued", delivery };
      }

      if (decision.kind === "require_approval") {
        delivery = Delivery.requireApproval(delivery, decision.reason, now);
        const duplicate = await persistNewDelivery(
          ctx,
          delivery,
          payloadKey,
          false,
          quota,
          { from, recipients },
          input,
        );
        if (duplicate !== null) return duplicate;
        await deps.events.publish([
          {
            type: "delivery.approval_requested",
            accountId: ctx.accountId,
            occurredAt: now,
            metadata: delivery.metadata,
            deliveryId: delivery.id,
            reason: decision.reason,
          },
        ]);
        return { outcome: "pending_approval", delivery };
      }

      delivery = Delivery.enqueue(delivery, now);
      const duplicate = await persistNewDelivery(
        ctx,
        delivery,
        payloadKey,
        true,
        quota,
        { from, recipients },
        input,
      );
      if (duplicate !== null) return duplicate;
      await deps.events.publish([
        {
          type: "delivery.queued",
          accountId: ctx.accountId,
          occurredAt: now,
          metadata: delivery.metadata,
          deliveryId: delivery.id,
          recipients,
        },
      ]);

      // Last, after the row, the payload and the decision are all durable.
      await publishStagedDispatch(ctx, delivery.id);
      return { outcome: "queued", delivery };
    },

    /**
     * Many messages in one call, each judged on its own.
     *
     * Two decisions here are load-bearing.
     *
     * **Sequential, not `Promise.all`.** Three of the seven gates — quota, the
     * loop breaker, and the suppression list — read counts that the sends before
     * them have just changed. Run concurrently, a hundred messages would all read
     * the same pre-batch count and a quota with one message of room left would
     * admit all hundred. The gates are only meaningful if each send sees the
     * effect of its predecessors, and that means one at a time.
     *
     * **Partial success, not all-or-nothing.** A batch of 100 where recipient 37
     * is suppressed sends the other 99 and reports the one. Failing the whole
     * batch would be the wrong trade in both directions: mail that was fine goes
     * unsent, and there is nothing to roll back the ones already handed to the
     * transport anyway. The caller gets an item per message and decides.
     */
    async sendBatch(
      ctx: Caller,
      messages: readonly SendMessageRequest[],
    ): Promise<readonly BatchSendItem[]> {
      Caller.require(ctx, "message:send");

      if (messages.length === 0) {
        throw invalidArgument("A batch needs at least one message.");
      }
      if (messages.length > SENDING_LIMITS.MAX_BATCH) {
        throw invalidArgument(
          `Too many messages: ${messages.length} (max ${SENDING_LIMITS.MAX_BATCH}).`,
          { count: messages.length, max: SENDING_LIMITS.MAX_BATCH },
        );
      }

      const items: BatchSendItem[] = [];
      for (const [index, message] of messages.entries()) {
        try {
          items.push({ index, ...(await service.send(ctx, message)) });
        } catch (error) {
          // A domain error is this message's verdict and belongs in its slot.
          // Anything else is the deployment failing rather than the message
          // being wrong, and turning that into a per-item result would report
          // 99 successes for a batch that never ran.
          if (!isDomainError(error)) throw error;
          items.push({
            index,
            outcome: "error",
            code: error.code,
            message: error.message,
            details: error.details,
          });
        }
      }
      return items;
    },

    /**
     * Hand a queued message to the transport, then archive our own copy.
     *
     * Runs in the Queues consumer, which shapes the error handling: a retryable
     * transport failure THROWS, because that is how the queue is told to retry. A
     * permanent failure does not throw — it records `failed` and returns, since
     * retrying a rejected recipient just burns quota.
     *
     * The sent copy is stored after a successful dispatch rather than before. If the
     * order were reversed, a failed send would leave a message in the mailbox that
     * was never actually sent, which is the one lie a mail log must not tell.
     */
    async dispatch(ctx: Caller, input: DispatchDeliveryRequest): Promise<DispatchOutcome> {
      const now = deps.clock.now();
      const delivery = await deps.deliveries.findById(ctx, Ulid.parse(input.deliveryId));
      if (delivery === null) {
        throw new DomainError("message_not_found", `No delivery message ${input.deliveryId}.`, {
          deliveryId: input.deliveryId,
        });
      }

      // A provider hand-off may succeed before our sent-copy archive does. A
      // queue retry repairs that archive from the durable payload, but it must
      // never call the transport again. `providerMessageId !== null` is the
      // durable proof that hand-off already happened, even if a later provider
      // event advanced the status beyond `dispatched` in the meantime.
      const repairingArchive =
        delivery.status !== "queued" &&
        delivery.status !== "dispatching" &&
        delivery.messageId === null &&
        hasProviderHandoff(delivery);
      if (delivery.status !== "queued" && !repairingArchive) {
        return { outcome: "skipped", reason: `status is ${delivery.status}` };
      }

      let claimed = delivery;
      if (!repairingArchive) {
        claimed = Delivery.beginDispatch(delivery, now);
        if (!(await deps.deliveries.updateIfStatus(ctx, claimed, "queued"))) {
          return { outcome: "skipped", reason: "already claimed by another consumer" };
        }
      }
      // `send` guarantees both of these; a violation means the row was written
      // by something else, and fabricating a value would attach the sent copy to an
      // inbox that does not exist.
      if (delivery.inboxId === null) {
        const reason = "outbound message has no originating inbox";
        const failed = Delivery.fail(claimed, reason, now);
        await deps.deliveries.updateIfStatus(ctx, failed, "dispatching");
        await deps.deliveries.unstageDispatch(ctx, failed.id);
        return { outcome: "failed", delivery: failed, error: reason };
      }
      if (delivery.payloadKey === null) {
        const failed = Delivery.fail(claimed, "payload missing", now);
        await deps.deliveries.updateIfStatus(ctx, failed, "dispatching");
        await deps.deliveries.unstageDispatch(ctx, failed.id);
        return { outcome: "failed", delivery: failed, error: "payload missing" };
      }

      const bytes = await deps.blobs.get(ctx, delivery.payloadKey);
      if (bytes === null) {
        const failed = Delivery.fail(claimed, "payload blob not found", now);
        await deps.deliveries.updateIfStatus(ctx, failed, "dispatching");
        await deps.deliveries.unstageDispatch(ctx, failed.id);
        return { outcome: "failed", delivery: failed, error: "payload blob not found" };
      }
      const payload = decodePayload(bytes);

      /**
       * The one decode. Both the transport and the archived `.eml` want the same
       * bytes, so they are produced once and shared rather than each decoding the
       * base64 — a 5 MiB attachment decoded twice is 10 MiB of a Worker's 128 MiB.
       */
      const attachments = (payload.attachments ?? []).map((spec) => ({
        filename: spec.filename,
        mime: spec.mime,
        content: Attachment.decode(spec),
        inline: spec.inline,
        contentId: spec.contentId,
      }));

      const result = repairingArchive
        ? {
            ok: true as const,
            providerMessageId: delivery.providerMessageId,
            accepted: [] as readonly EmailAddress[],
            queued: [] as readonly EmailAddress[],
            rejected: [] as readonly EmailAddress[],
          }
        : await deps.transport.dispatch(ctx, {
            from: payload.from,
            fromName: null,
            to: payload.to,
            cc: payload.cc,
            bcc: payload.bcc,
            replyTo: payload.replyTo,
            subject: payload.subject,
            text: payload.text,
            html: payload.html,
            messageId: payload.messageId,
            inReplyTo: payload.inReplyTo,
            references: payload.references,
            headers: payload.headers,
            attachments,
          });

      if (!result.ok) {
        if (result.retryable) {
          const requeued = Delivery.retryDispatch(claimed, result.error, now);
          await deps.deliveries.updateIfStatus(ctx, requeued, "dispatching");
          throw new DomainError("send_rejected", `Transport error: ${result.error}`, {
            deliveryId: claimed.id,
            retryable: true,
          });
        }
        const failed = Delivery.fail(claimed, result.error, now);
        await deps.deliveries.updateIfStatus(ctx, failed, "dispatching");
        await deps.deliveries.unstageDispatch(ctx, failed.id);
        await deps.events.publish([
          {
            type: "delivery.rejected",
            accountId: ctx.accountId,
            occurredAt: now,
            metadata: failed.metadata,
            deliveryId: failed.id,
            reason: result.error,
            code: "send_rejected",
          },
        ]);
        return { outcome: "failed", delivery: failed, error: result.error };
      }

      let dispatched = repairingArchive
        ? delivery
        : Delivery.markDispatched(claimed, result.providerMessageId, now);

      // Persist the provider hand-off before archive work. Once the external
      // side effect succeeded, a later MIME/R2/D1 failure must never make a
      // queue retry send the email again.
      if (!repairingArchive) {
        const persisted = await deps.deliveries.updateIfStatus(ctx, dispatched, "dispatching");
        if (!persisted) {
          // The external side effect happened, but another recovery path moved
          // the lease meanwhile. Never resend and never overwrite that newer
          // decision; the retained outbox row makes the unknown outcome visible.
          throw new Error(`Delivery ${dispatched.id} changed during provider hand-off.`);
        }
      }

      // Archive our copy, threaded alongside the message it replies to.
      const candidates = ThreadingPolicy.candidateIds(payload.inReplyTo, payload.references);
      const known =
        candidates.length > 0
          ? await deps.messages.findThreadIds(ctx, candidates, delivery.inboxId)
          : new Map<string, ThreadId>();
      const thread = ThreadingPolicy.resolve({
        ownMessageId: payload.messageId,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        known,
      });

      const messageId = deps.ids.ulid();
      const archivedAttachments: AttachmentMeta[] = attachments.map((attachment) => {
        const attachmentId = deps.ids.ulid();
        return {
          id: attachmentId,
          filename: attachment.filename,
          mime: attachment.mime,
          contentId: attachment.contentId,
          size: attachment.content.byteLength,
          inline: attachment.inline,
          storageKey: BlobKeys.attachment(ctx.accountId, messageId, attachmentId),
        };
      });
      const raw = await deps.mimeBuilder.build({
        from: payload.from,
        fromName: null,
        to: payload.to,
        cc: payload.cc,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        messageId: payload.messageId,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        date: now,
        headers: payload.headers,
        attachments,
      });
      const rawKey = BlobKeys.rawMessage(ctx.accountId, messageId);
      const bodyKey = BlobKeys.messageBody(ctx.accountId, messageId);

      let sentCopy = Message.create({
        id: messageId,
        accountId: ctx.accountId,
        inboxId: delivery.inboxId,
        identityId: delivery.identityId,
        rfcMessageId: payload.messageId,
        threadId: thread.threadId,
        direction: "outbound",
        origin: "outbound",
        fromHeader: payload.from,
        from: payload.from,
        toHeader: payload.to.join(", "),
        to: payload.to,
        cc: payload.cc,
        bcc: payload.bcc,
        replyTo: payload.replyTo,
        subject: payload.subject,
        bodyText: payload.text,
        bodyHtml: payload.html,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        autoSubmitted: payload.headers["Auto-Submitted"] ?? null,
        rawKey,
        size: raw.byteLength,
        attachments: archivedAttachments,
        sentAt: now,
        receivedAt: now,
      });
      const archiveKeys = [
        rawKey,
        bodyKey,
        ...archivedAttachments.map((attachment) => attachment.storageKey),
      ];
      let insertAttempted = false;
      try {
        await deps.blobs.put(ctx, rawKey, raw, { contentType: "message/rfc822" });
        await deps.blobs.put(
          ctx,
          bodyKey,
          encodeStoredMessageBody({
            bodyText: sentCopy.bodyText,
            bodyHtml: sentCopy.bodyHtml,
          }),
          { contentType: "application/json" },
        );
        for (const [index, attachment] of archivedAttachments.entries()) {
          await deps.blobs.put(ctx, attachment.storageKey, attachments[index]!.content, {
            contentType: attachment.mime ?? "application/octet-stream",
          });
        }
        insertAttempted = true;
        const { stored } = await deps.messages.insert(ctx, sentCopy, { bodyKey });
        if (!stored) {
          await deps.blobs.delete(ctx, archiveKeys);
          const winner = await deps.messages.findPlacement(
            ctx,
            sentCopy.inboxId,
            null,
            sentCopy.rfcMessageId,
          );
          if (
            winner === null ||
            winner.direction !== "outbound" ||
            winner.inboxId !== sentCopy.inboxId
          ) {
            throw new Error(
              `Outbound archive ${sentCopy.rfcMessageId} deduplicated without a winner.`,
            );
          }
          sentCopy = winner;
        }
      } catch (error) {
        if (!insertAttempted) {
          await deps.blobs.delete(ctx, archiveKeys);
        } else {
          // An insert can commit before its response is lost. Only delete if a
          // successful verification proves no archive row exists; on a failed
          // verification retain the objects and let archive repair retry.
          try {
            const committed = await deps.messages.findPlacement(
              ctx,
              sentCopy.inboxId,
              null,
              sentCopy.rfcMessageId,
            );
            if (committed === null) await deps.blobs.delete(ctx, archiveKeys);
          } catch {
            // Unknown D1 outcome: preserving possible orphans is the safe side.
          }
        }
        throw error;
      }

      dispatched = Delivery.attachSentCopy(dispatched, sentCopy.id, now);
      // Partial write: a provider event can advance the row to delivered while
      // MIME/R2 archival is in progress. Rewriting the older aggregate here
      // would move it backwards to dispatched and the event's unique id means
      // no retry would repair that regression.
      await deps.deliveries.attachMessageId(ctx, dispatched.id, sentCopy.id, now);

      /**
       * A sandbox environment gets the whole shape of a real send without one
       * leaving: the same bytes we just archived are fed back through the
       * inbound path, so a development send is resolvable by `wait`, and a
       * `delivered` event is synthesized so the timeline reads the same as
       * production instead of looking stuck at `dispatched`.
       *
       * There is no provider to hear from later, so this is the only chance to
       * write that event.
       */
      if (ctx.mode === "sandbox") {
        /**
         * The looped-back copy carries its own Message-ID.
         *
         * Not cosmetic: `messages` is unique on `(account_id, rfc_message_id)`,
         * and the sent copy above already claimed the original. Reusing it would
         * make every loopback dedupe away as a duplicate of our own archive —
         * which is exactly the case sandbox exists for, an environment mailing
         * its own test inbox. Threading is unaffected; it keys off In-Reply-To
         * and References, which are copied verbatim.
         */
        const loopbackId = RfcMessageId.parse(
          `${payload.messageId.split("@")[0]}.loopback@${EmailAddress.domain(payload.from)}`,
        );
        const loopbackRaw = await deps.mimeBuilder.build({
          from: payload.from,
          fromName: null,
          to: payload.to,
          cc: payload.cc,
          subject: payload.subject,
          text: payload.text,
          html: payload.html,
          messageId: loopbackId,
          inReplyTo: payload.inReplyTo,
          references: payload.references,
          date: now,
          headers: { ...payload.headers, "X-Mailworker-Sandbox": payload.messageId },
          attachments,
        });

        for (const recipient of dispatched.recipients) {
          await deps.loopback.deliver(ctx, {
            recipient,
            envelopeFrom: payload.from,
            raw: loopbackRaw,
          });
        }

        await deps.deliveries.appendDeliveryEvent(ctx, {
          id: deps.ids.ulid(),
          eventId: null,
          deliveryId: dispatched.id,
          providerMessageId: result.providerMessageId,
          recipient: null,
          sourceDomain: null,
          sourceZoneId: null,
          type: "delivered",
          terminal: true,
          smtpCode: null,
          smtpEnhancedCode: null,
          smtpResponse: "Delivered in sandbox — nothing left this deployment.",
          bounceType: null,
          bounceClassification: null,
          bounceReason: null,
          occurredAt: now,
          raw: null,
        });
        dispatched = Delivery.transitionTo(dispatched, "delivered", now);
      }

      if (ctx.mode === "sandbox") {
        // Sandbox synthesized the provider outcome above and has no external
        // event racing this transition. Live mode already persisted handoff
        // before archive and uses the partial message-id update above.
        await deps.deliveries.update(ctx, dispatched);
      }
      await deps.events.publish([
        {
          type: "delivery.dispatched",
          accountId: ctx.accountId,
          occurredAt: now,
          metadata: dispatched.metadata,
          deliveryId: dispatched.id,
          providerMessageId: result.providerMessageId,
        },
      ]);

      // The durable dispatch task is complete only after provider hand-off,
      // archive attachment and event publication. Until here, a retry is either
      // a normal queued dispatch or an archive-only repair.
      await deps.deliveries.unstageDispatch(ctx, dispatched.id);

      return { outcome: "dispatched", delivery: dispatched, sentCopy };
    },

    /**
     * Fold a provider delivery event into our record of the send.
     *
     * This is the half of "Resend-like" that the reference projects skip, and it is
     * what turns a send from fire-and-forget into something with a timeline.
     *
     * Two deliberate choices, both because this runs in a queue consumer:
     *
     * - The event row is appended BEFORE the state transition is attempted. Even a
     *   stale or out-of-order event is a fact about what the provider said, and
     *   `mailworker status` is more useful for showing it.
     * - An event that cannot be applied is never an error. Throwing would make the
     *   queue retry forever, and out-of-order arrival is normal at scale.
     */
    async recordEvent(ctx: Caller, event: ProviderDeliveryEvent): Promise<RecordEventOutcome> {
      let delivery = await deps.deliveries.findByProviderMessageId(
        ctx,
        event.providerMessageId,
      );

      await deps.deliveries.appendDeliveryEvent(ctx, {
        id: deps.ids.ulid(),
        eventId: event.eventId,
        deliveryId: delivery?.id ?? null,
        providerMessageId: event.providerMessageId,
        recipient: event.recipient,
        sourceDomain: event.sourceDomain,
        sourceZoneId: event.sourceZoneId,
        type: event.type,
        terminal: event.terminal,
        smtpCode: event.smtpCode ?? null,
        smtpEnhancedCode: event.smtpEnhancedCode ?? null,
        smtpResponse: event.smtpResponse ?? null,
        bounceType: event.bounceType ?? null,
        bounceClassification: event.bounceClassification ?? null,
        bounceReason: event.bounceReason ?? null,
        occurredAt: event.occurredAt,
        raw: event.raw ?? null,
      });

      // The row is the durable idempotency boundary, while the processing claim
      // makes a crash after the insert retryable. A duplicate whose first
      // attempt completed is ignored; a duplicate whose attempt released its
      // claim resumes all remaining idempotent side effects.
      const claimNow = deps.clock.now();
      const claim = await deps.deliveries.claimDeliveryEvent(
        ctx,
        event.eventId,
        claimNow,
        new Date(claimNow.getTime() - 5 * 60 * 1000),
      );
      if (claim === "processed") return { outcome: "duplicate" };
      if (claim === "busy") {
        // Do not acknowledge an in-flight lease as a duplicate. The current
        // owner may have hard-crashed after claiming; a retry is what eventually
        // reaches the stale-lease branch and finishes the durable side effects.
        throw new Error(`Provider event ${event.eventId} is still being processed.`);
      }

      try {
        // A bounce or complaint must reach the suppression list even if we cannot
        // match the send — protecting sender reputation matters more than tidy
        // bookkeeping, and quota is only consumed by attempts we actually make.
        if (
          event.recipient !== null &&
          (event.type === "complained" ||
            (event.type === "bounced" && event.bounceType === "hard"))
        ) {
          await deps.suppressions.add(ctx, {
            address: event.recipient,
            reason: event.type === "bounced" ? "hard_bounce" : "complaint",
            source: "cf_sync",
            createdAt: event.occurredAt,
          });
          await deps.events.publish([
            {
              type: "suppression.added",
              accountId: ctx.accountId,
              occurredAt: event.occurredAt,
              address: event.recipient,
              reason: event.type,
            },
          ]);
        }

        if (delivery === null) {
          await deps.deliveries.completeDeliveryEvent(ctx, event.eventId, deps.clock.now());
          return { outcome: "unmatched" };
        }

        // A provider may report a failed attempt that it still intends to retry.
        // Preserve it in the timeline, but do not freeze the aggregate in the
        // terminal `failed` status until Cloudflare says the event is terminal.
        if (event.type === "failed" && !event.terminal) {
          await deps.deliveries.completeDeliveryEvent(ctx, event.eventId, deps.clock.now());
          return { outcome: "recorded_only", reason: "non_terminal_failure" };
        }

        // Re-read after claiming. Different provider events may have advanced
        // this delivery while the event row was being inserted.
        delivery = await deps.deliveries.findByProviderMessageId(ctx, event.providerMessageId);
        if (delivery === null) {
          await deps.deliveries.completeDeliveryEvent(ctx, event.eventId, deps.clock.now());
          return { outcome: "unmatched" };
        }
        const applied = Delivery.applyDeliveryEvent(delivery, {
          type: event.type,
          occurredAt: event.occurredAt,
          detail: event.smtpResponse ?? null,
        });

        if (!applied.applied) {
          await deps.deliveries.completeDeliveryEvent(ctx, event.eventId, deps.clock.now());
          return { outcome: "recorded_only", reason: applied.reason };
        }

        const updated = await deps.deliveries.updateIfStatus(
          ctx,
          applied.delivery,
          delivery.status,
        );
        if (!updated) {
          // Leave the row pending so queue retry recomputes against the winner.
          throw new Error(`Delivery ${delivery.id} changed while applying provider event.`);
        }
        await deps.events.publish([
          {
            type: "delivery.status_changed",
            accountId: ctx.accountId,
            occurredAt: event.occurredAt,
            metadata: applied.delivery.metadata,
            deliveryId: applied.delivery.id,
            from: delivery.status,
            to: applied.delivery.status,
            deliveryEvent: event.type,
            recipient: event.recipient,
          },
        ]);

        await deps.deliveries.completeDeliveryEvent(ctx, event.eventId, deps.clock.now());
        return { outcome: "applied", from: delivery.status, to: applied.delivery.status };
      } catch (error) {
        await deps.deliveries.releaseDeliveryEvent(ctx, event.eventId);
        throw error;
      }
    },

    /**
     * Release a send that `SendPolicy` held for a human.
     *
     * Requires `message:approve`, which an agent should never be granted — the
     * whole point of the approval queue is that the thing being approved and the
     * thing doing the approving are not the same principal. `approvedBy` is the
     * caller's subject rather than a free-text field for the same reason: an
     * audit trail that the approver gets to write is not an audit trail.
     *
     * Enqueueing happens here, so approving is genuinely the last gate. The
     * message goes out because someone said yes, not because it was already on
     * its way and merely unpaused.
     */
    async approve(ctx: Caller, deliveryId: Ulid): Promise<Delivery> {
      Caller.require(ctx, "message:approve");
      assertIndependentApprover(ctx);
      const now = deps.clock.now();

      const delivery = await deps.deliveries.findById(ctx, deliveryId);
      if (delivery === null) {
        throw notFound("message_not_found", `No delivery ${deliveryId}.`, { deliveryId });
      }
      assertDeliveryAccess(ctx, delivery);
      if (delivery.status !== "pending_approval") {
        throw new DomainError(
          "invalid_state_transition",
          `Delivery ${deliveryId} is ${delivery.status}, not awaiting approval.`,
          { deliveryId, status: delivery.status },
        );
      }

      const approved = Delivery.approve(delivery, ctx.subject, now);
      const updated = await deps.deliveries.approveAndStage(ctx, approved);
      if (!updated) {
        // Never remove the row here. The request that created it need not be the
        // request that won the compare-and-set; deleting it can erase the
        // winner's only recovery fact if Queue.send failed. Reconciliation
        // observes the final delivery state and is the sole loser cleanup.
        throw new DomainError(
          "invalid_state_transition",
          `Delivery ${deliveryId} is no longer awaiting approval.`,
          { deliveryId },
        );
      }
      await publishStagedDispatch(ctx, approved.id);
      await deps.events.publish([
        {
          type: "delivery.status_changed",
          accountId: ctx.accountId,
          occurredAt: now,
          metadata: approved.metadata,
          deliveryId: approved.id,
          from: delivery.status,
          to: approved.status,
          deliveryEvent: null,
          recipient: null,
        },
      ]);
      return approved;
    },

    /**
     * Repair the D1-to-Queues hand-off.
     *
     * A send is accepted into D1 and then published to Queues, two services that
     * cannot share a transaction. The outbox row is committed with a newly
     * queued delivery, so a transient queue outage or isolate stop becomes a
     * delayed hand-off instead of a silently stranded message.
     */
    async reconcileDispatchOutbox(
      ctx: Caller,
      limit = DEFAULT_DISPATCH_RECONCILE_LIMIT,
    ): Promise<DispatchReconcileResult> {
      Caller.require(ctx, "admin");
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
        throw invalidArgument("Dispatch reconciliation limit must be between 1 and 1000.", {
          limit,
        });
      }

      const staged = await deps.deliveries.listStagedDispatches(ctx, limit);
      const result: DispatchReconcileResult = {
        examined: staged.length,
        enqueued: 0,
        discarded: 0,
        markedUnknown: 0,
        failed: 0,
        backlogRemaining: staged.length >= limit,
      };

      for (const entry of staged) {
        try {
          const delivery = await deps.deliveries.findById(ctx, entry.deliveryId);
          if (delivery?.status === "dispatching") {
            if (
              delivery.statusChangedAt.getTime() >
              deps.clock.now().getTime() - DISPATCH_LEASE_MS
            ) {
              // A live consumer owns the provider hand-off. Keep the durable
              // task and let the next cron pass decide whether its lease went stale.
              continue;
            }
            const unknown = Delivery.fail(delivery, UNKNOWN_HANDOFF_REASON, deps.clock.now());
            if (await deps.deliveries.updateIfStatus(ctx, unknown, "dispatching")) {
              await deps.deliveries.unstageDispatch(ctx, entry.deliveryId);
              result.markedUnknown += 1;
            }
            continue;
          }
          if (delivery?.status === "pending_approval") {
            // Modern approval staging is atomic and only fires when the status
            // becomes queued. A pending row is therefore legacy debris, never
            // permission to bypass review.
            await deps.deliveries.unstageDispatch(ctx, entry.deliveryId);
            result.discarded += 1;
            continue;
          }
          if (
            delivery !== null &&
            delivery.status !== "queued" &&
            delivery.messageId === null &&
            hasProviderHandoff(delivery)
          ) {
            // Provider hand-off is durable but archive is absent. Re-enqueueing
            // enters dispatch's archive-only repair path and cannot send twice.
            await publishStagedDispatch(ctx, entry.deliveryId);
            result.enqueued += 1;
            continue;
          }
          if (delivery === null || delivery.status !== "queued") {
            await deps.deliveries.unstageDispatch(ctx, entry.deliveryId);
            result.discarded += 1;
            continue;
          }
          await publishStagedDispatch(ctx, entry.deliveryId);
          result.enqueued += 1;
        } catch {
          // Leave the row intact. One broken queue binding must not stop the
          // remaining environments being swept or erase the recovery signal.
          result.failed += 1;
        }
      }
      return result;
    },

    /**
     * Decline a held send.
     *
     * The counterpart `approve` was missing, and its absence made the queue a
     * one-way door: the only way to dispose of a message you did not want sent
     * was to leave it pending forever, which is indistinguishable from not
     * having looked at it. Rejecting is terminal and the payload stays in R2
     * until retention sweeps it, so the record of what was refused survives.
     *
     * Same scope as approving. Both are the reviewer's decision, and a
     * credential that could reject but not approve could still silence an agent.
     */
    async reject(ctx: Caller, deliveryId: Ulid, reason: string): Promise<Delivery> {
      Caller.require(ctx, "message:approve");
      assertIndependentApprover(ctx);
      const now = deps.clock.now();

      const delivery = await deps.deliveries.findById(ctx, deliveryId);
      if (delivery === null) {
        throw notFound("message_not_found", `No delivery ${deliveryId}.`, { deliveryId });
      }
      assertDeliveryAccess(ctx, delivery);
      if (delivery.status !== "pending_approval") {
        throw new DomainError(
          "invalid_state_transition",
          `Delivery ${deliveryId} is ${delivery.status}, not awaiting approval.`,
          { deliveryId, status: delivery.status },
        );
      }

      const rejected = Delivery.reject(delivery, `${reason} (${ctx.subject})`, now);
      const updated = await deps.deliveries.updateIfStatus(ctx, rejected, "pending_approval");
      if (!updated) {
        throw new DomainError(
          "invalid_state_transition",
          `Delivery ${deliveryId} is no longer awaiting approval.`,
          { deliveryId },
        );
      }
      await deps.events.publish([
        {
          type: "delivery.status_changed",
          accountId: ctx.accountId,
          occurredAt: now,
          metadata: rejected.metadata,
          deliveryId: rejected.id,
          from: delivery.status,
          to: rejected.status,
          deliveryEvent: null,
          recipient: null,
        },
      ]);
      return rejected;
    },

    /**
     * One send and everything that has happened to it — what `mailworker status`
     * prints.
     *
     * The events come back even when none of them changed the status. An event
     * the state machine refused (out of order, or after a terminal state) is
     * still a fact about what the provider said, and the case where someone
     * reaches for this is exactly the case where that fact is the answer.
     */
    async timeline(
      ctx: Caller,
      deliveryId: Ulid,
    ): Promise<{ delivery: Delivery; events: DeliveryEvent[] }> {
      Caller.require(ctx, "message:read");
      const delivery = await deps.deliveries.findById(ctx, deliveryId);
      if (delivery === null) {
        throw notFound("message_not_found", `No delivery ${deliveryId}.`, { deliveryId });
      }
      assertDeliveryAccess(ctx, delivery);
      return { delivery, events: await deps.deliveries.listDeliveryEvents(ctx, deliveryId) };
    },

    /**
     * What a delivery actually says — read back out of the payload blob.
     *
     * This exists because the sent copy in the mailbox is written at DISPATCH,
     * so for every status before that there is no archived message to read, and
     * `pending_approval` is precisely the status where someone needs to see the
     * content. An approval queue whose items cannot be inspected is a button
     * that says "yes" to something unspecified.
     *
     * Attachment CONTENT is deliberately not returned, only the manifest: this
     * is a preview, and returning 5 MiB of base64 to render a filename would be
     * a denial of service on our own dashboard.
     */
    async preview(ctx: Caller, deliveryId: Ulid): Promise<DeliveryPreview> {
      Caller.require(ctx, "message:read");
      const delivery = await deps.deliveries.findById(ctx, deliveryId);
      if (delivery === null) {
        throw notFound("message_not_found", `No delivery ${deliveryId}.`, { deliveryId });
      }
      assertDeliveryAccess(ctx, delivery);
      if (delivery.payloadKey === null) {
        throw notFound("message_not_found", `Delivery ${deliveryId} has no stored payload.`, {
          deliveryId,
        });
      }

      const bytes = await deps.blobs.get(ctx, delivery.payloadKey);
      if (bytes === null) {
        // Retention swept it, or it was never written. Not an error worth a 500:
        // the delivery row is intact and the timeline still answers the question
        // the page was opened to ask.
        throw notFound("message_not_found", `Payload for ${deliveryId} is gone.`, {
          deliveryId,
        });
      }

      const payload = decodePayload(bytes);
      const parent =
        payload.inReplyToMessageId !== undefined && payload.inReplyToMessageId !== null
          ? await deps.messages.findById(ctx, payload.inReplyToMessageId)
          : payload.inReplyTo === null
            ? null
            : await deps.messages.findByRfcMessageId(ctx, payload.inReplyTo);
      const identityId = resourceIdentity(ctx);
      return {
        inReplyToMessageId:
          parent === null || (identityId !== null && parent.identityId !== identityId)
            ? null
            : parent.id,
        subject: payload.subject,
        from: payload.from,
        to: [...payload.to],
        cc: [...payload.cc],
        bcc: [...payload.bcc],
        replyTo: payload.replyTo,
        text: payload.text,
        html: payload.html,
        attachments: (payload.attachments ?? []).map((one) => ({
          filename: one.filename,
          mime: one.mime,
          bytes: Attachment.byteLength(one.content),
          inline: one.inline,
        })),
      };
    },

    async list(ctx: Caller, query: ListDeliveriesQuery = {}): Promise<Page<Delivery>> {
      Caller.require(ctx, "message:read");
      const identityId = resourceIdentity(ctx);
      return await deps.deliveries.list(ctx, {
        ...query,
        ...(identityId === null ? {} : { identityId }),
      });
    },

    async listSuppressions(ctx: Caller): Promise<SuppressionEntry[]> {
      // Suppressions are account-wide reputation state, not an identity-owned
      // mailbox resource. Letting one agent enumerate them leaks other agents'
      // recipients; letting it add one is a cross-identity denial of service.
      Caller.require(ctx, "admin");
      return await deps.suppressions.list(ctx);
    },

    async suppress(ctx: Caller, entry: Omit<SuppressionEntry, "createdAt">): Promise<void> {
      Caller.require(ctx, "admin");
      await deps.suppressions.add(ctx, { ...entry, createdAt: deps.clock.now() });
    },

    /**
     * Take an address off the list.
     *
     * Deliberately allowed even for a hard bounce that Cloudflare synced: an
     * address can be fixed, and a suppression list with no way out becomes a
     * list of customers you have permanently stopped talking to. It needs
     * `admin` because doing it wrongly damages sending reputation for everyone
     * on the deployment.
     */
    async unsuppress(ctx: Caller, address: EmailAddress): Promise<void> {
      Caller.require(ctx, "admin");
      await deps.suppressions.remove(ctx, address);
    },

    /**
     * Subscribe to events.
     *
     * The secret is minted here and returned once. Unlike an API key it is
     * stored in the clear, because signing needs the secret itself and both
     * ends must hold the same one — and what that buys is that a receiver
     * verifies locally and never sends it back to us.
     */
    async createWebhook(
      ctx: Caller,
      input: { url: string; events?: readonly DomainEventType[] },
    ): Promise<WebhookSubscription> {
      Caller.require(ctx, "admin");
      const subscription = WebhookSubscription.create({
        id: deps.ids.ulid(),
        accountId: ctx.accountId,
        url: input.url,
        secret: `whsec_${deps.secrets.generate(24)}`,
        now: deps.clock.now(),
        ...(input.events === undefined ? {} : { events: input.events }),
      });
      await deps.webhooks.insert(ctx, subscription);
      return subscription;
    },

    async listWebhooks(ctx: Caller): Promise<WebhookSubscription[]> {
      Caller.require(ctx, "admin");
      return await deps.webhooks.list(ctx);
    },

    async deleteWebhook(ctx: Caller, id: Ulid): Promise<void> {
      Caller.require(ctx, "admin");
      const existing = await deps.webhooks.findById(ctx, id);
      if (existing === null) throw notFound("webhook_not_found", `No webhook ${id}.`, { id });
      await deps.webhooks.deleteById(ctx, id);
    },

    /**
     * Fan one event out to whoever subscribed to it.
     *
     * Runs in the queue consumer, one event at a time. Each subscriber is an
     * independent attempt: a subscriber whose server is down must not stop the
     * others from being told, so failures are collected and re-thrown together
     * only after every delivery has been tried. Throwing is how the queue is
     * asked to retry, and it will retry the whole event — which is why the
     * request carries a stable `messageId` for the receiver to dedupe on.
     */
    async fanOut(ctx: Caller, event: DomainEvent, eventId: string): Promise<number> {
      const subscriptions = await deps.webhooks.list(ctx);
      const wanted = subscriptions.filter((s) => WebhookSubscription.wants(s, event));
      if (wanted.length === 0) return 0;

      const body = JSON.stringify({
        id: eventId,
        type: event.type,
        occurredAt: event.occurredAt.toISOString(),
        data: event,
      });

      const results = await Promise.allSettled(
        wanted.map((subscription) =>
          deps.webhookSender.deliver({
            url: subscription.url,
            secret: subscription.secret,
            // Per subscription, not per event: two subscribers retrying
            // independently must not be told they received the same delivery.
            messageId: `${eventId}.${subscription.id}`,
            body,
            // Signature freshness describes this delivery attempt, not when
            // the business event happened. A queued retry hours later must not
            // look like a replay; the original time remains in the JSON body.
            timestamp: deps.clock.now(),
          }),
        ),
      );

      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} of ${wanted.length} webhook deliveries failed for ${event.type}.`,
        );
      }
      return wanted.length;
    },

    /**
     * What `mailworker doctor` prints: every domain this deployment serves, and
     * whether its DNS actually says what it needs to say.
     *
     * Worth having as a first-class operation rather than a page in the docs.
     * Every failure it reports is silent in production — mail that goes to spam
     * because DMARC is missing, an inbox that receives nothing because MX
     * points at the old host — and a system whose failures are silent needs
     * somewhere to ask.
     *
     * All four lookups per domain run together. They are independent, and a
     * doctor that takes eight seconds is one people stop running.
     */
    async diagnose(ctx: Caller): Promise<DomainDiagnosis[]> {
      Caller.require(ctx, "admin");
      const domains = await deps.domains.list(ctx);

      return await Promise.all(
        domains.map(async (routing) => {
          const selector = routing.dkimSelector ?? null;
          const [mx, txt, dmarc, dkim] = await Promise.all([
            deps.dns.mx(routing.domain),
            deps.dns.txt(routing.domain),
            deps.dns.txt(`_dmarc.${routing.domain}`),
            selector === null
              ? Promise.resolve<string[]>([])
              : deps.dns.txt(`${selector}._domainkey.${routing.domain}`),
          ]);

          const checks: Check[] = [
            DomainHealthPolicy.mx(mx),
            DomainHealthPolicy.spf(txt),
            DomainHealthPolicy.dmarc(dmarc),
            DomainHealthPolicy.dkim(selector, dkim),
            DomainHealthPolicy.sendingStatus(routing.sendingStatus),
          ];

          return { domain: routing.domain, status: DomainHealthPolicy.worst(checks), checks };
        }),
      );
    },
  };

  return service;
}

export interface DomainDiagnosis {
  readonly domain: string;
  readonly status: CheckStatus;
  readonly checks: readonly Check[];
}

export type DeliveryService = ReturnType<typeof createDeliveryService>;

export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Existing unbound keys retain account-wide access; identity keys are scoped. */
function resourceIdentity(ctx: Caller): Ulid | null {
  return Caller.has(ctx, "admin") ? null : ctx.identityId;
}

function assertDeliveryAccess(ctx: Caller, delivery: Delivery): void {
  const identityId = resourceIdentity(ctx);
  if (identityId !== null && delivery.identityId !== identityId) {
    throw notFound("message_not_found", `No delivery ${delivery.id}.`, { id: delivery.id });
  }
}

function assertIndependentApprover(ctx: Caller): void {
  if (ctx.identityId !== null) {
    throw new DomainError(
      "forbidden",
      "An identity-bound credential cannot approve or reject agent sends.",
      { subject: ctx.subject },
    );
  }
}

function hasProviderHandoff(delivery: Delivery): boolean {
  if (delivery.providerMessageId !== null) return true;
  return ["dispatched", "deferred", "delivered", "bounced", "complained"].includes(
    delivery.status,
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

export function encodePayload(payload: DeliveryPayload): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

export function decodePayload(bytes: Uint8Array): DeliveryPayload {
  return JSON.parse(new TextDecoder().decode(bytes)) as DeliveryPayload;
}

async function resolveIdentity(
  deps: Pick<DeliveryDeps, "identities">,
  ctx: Caller,
  inboxIdentityId: Ulid | null,
): Promise<AgentIdentity | null> {
  // The credential's own identity wins over the inbox's: a key bound to an
  // identity must not be able to widen its limits by sending from a
  // less-restricted inbox.
  const id = ctx.identityId ?? inboxIdentityId;
  return id === null ? null : await deps.identities.findById(ctx, id);
}

/**
 * The loop breaker meters per counterparty, so a message to five recipients is
 * checked against the busiest of them rather than their sum — otherwise one
 * chatty peer would throttle sends to everyone else.
 */
async function maxExchanges(
  deps: Pick<DeliveryDeps, "messages">,
  ctx: Caller,
  from: EmailAddress,
  to: readonly EmailAddress[],
  now: Date,
): Promise<number> {
  const since = new Date(now.getTime() - LoopBreakerPolicy.EXCHANGE_WINDOW_MS);
  const counts = await Promise.all(
    to.map((recipient) => deps.messages.countSentBetween(ctx, from, recipient, since)),
  );
  return counts.length === 0 ? 0 : Math.max(...counts);
}
