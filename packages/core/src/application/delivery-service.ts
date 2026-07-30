import type {
  AgentIdentity,
  AttachmentSpec,
  Check,
  CheckStatus,
  DeliveryEventType,
  DomainEvent,
  DomainEventType,
  Page,
  RfcMessageId,
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
  invalidArgument,
  LoopBreakerPolicy,
  Message,
  notFound,
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
  /** Reply into an existing thread by our message ULID. */
  readonly inReplyToMessageId?: string;
  readonly headers?: Record<string, string>;
  /** Base64 content; see `AttachmentSpec` for why it stays encoded until dispatch. */
  readonly attachments?: readonly AttachmentSpec[];
  /** Repeat submissions with the same key return the original send. */
  readonly idempotencyKey?: string;
  /** True when a machine triggered this. Drives loop breaking and `Auto-Submitted`. */
  readonly automated?: boolean;
}

export type SendResult =
  | { readonly outcome: "queued"; readonly delivery: Delivery }
  | { readonly outcome: "pending_approval"; readonly delivery: Delivery }
  | { readonly outcome: "duplicate"; readonly delivery: Delivery };

/** What `dispatch-delivery` reads back out of the blob store. */
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
 * `cf.email.sending.message.*` (DESIGN.md §2.3), flattened by the adapter.
 */
export interface ProviderDeliveryEvent {
  readonly type: DeliveryEventType;
  readonly providerMessageId: string;
  readonly recipient: EmailAddress | null;
  readonly occurredAt: Date;
  readonly terminal: boolean;
  readonly smtpCode?: string | null;
  readonly smtpResponse?: string | null;
  /** Original payload, kept verbatim. */
  readonly raw?: string | null;
}

export type RecordEventOutcome =
  | { readonly outcome: "applied"; readonly from: string; readonly to: string }
  | { readonly outcome: "recorded_only"; readonly reason: string }
  | { readonly outcome: "unmatched" };

export function createDeliveryService(deps: DeliveryDeps) {
  return {
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
        const existing = await deps.deliveries.findByIdempotencyKey(ctx, input.idempotencyKey);
        if (existing !== null) {
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

      const identity = await resolveIdentity(deps, ctx, inbox.identityId);

      // Thread continuation, if this is a reply.
      let inReplyTo: RfcMessageId | null = null;
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
        inReplyTo = parent.rfcMessageId;
        references = [...parent.references, parent.rfcMessageId];
        inboundAutoSubmitted = parent.autoSubmitted;
      }

      // Gather what the policy needs. Each of these is a read, so they happen here
      // and the policy itself stays a pure function of their results.
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

      let delivery = Delivery.create({
        id: deliveryId,
        accountId: ctx.accountId,
        recipients,
        inboxId: inbox.id,
        identityId: identity?.id ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        payloadKey,
        now,
      });

      if (decision.kind === "require_approval") {
        delivery = Delivery.requireApproval(delivery, decision.reason, now);
        await deps.deliveries.insert(ctx, delivery);
        await deps.events.publish([
          {
            type: "delivery.approval_requested",
            accountId: ctx.accountId,
            occurredAt: now,
            deliveryId: delivery.id,
            reason: decision.reason,
          },
        ]);
        return { outcome: "pending_approval", delivery };
      }

      delivery = Delivery.enqueue(delivery, now);
      await deps.deliveries.insert(ctx, delivery);
      await deps.events.publish([
        {
          type: "delivery.queued",
          accountId: ctx.accountId,
          occurredAt: now,
          deliveryId: delivery.id,
          recipients,
        },
      ]);

      // Last, after the row, the payload and the decision are all durable.
      await deps.dispatchQueue.enqueue(ctx, delivery.id);
      return { outcome: "queued", delivery };
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

      // A queue can deliver the same job twice; anything not queued is already
      // handled and must not be sent again.
      if (delivery.status !== "queued") {
        return { outcome: "skipped", reason: `status is ${delivery.status}` };
      }
      // `send` guarantees both of these; a violation means the row was written
      // by something else, and fabricating a value would attach the sent copy to an
      // inbox that does not exist.
      if (delivery.inboxId === null) {
        const reason = "outbound message has no originating inbox";
        const failed = Delivery.fail(delivery, reason, now);
        await deps.deliveries.update(ctx, failed);
        return { outcome: "failed", delivery: failed, error: reason };
      }
      if (delivery.payloadKey === null) {
        const failed = Delivery.fail(delivery, "payload missing", now);
        await deps.deliveries.update(ctx, failed);
        return { outcome: "failed", delivery: failed, error: "payload missing" };
      }

      const bytes = await deps.blobs.get(ctx, delivery.payloadKey);
      if (bytes === null) {
        const failed = Delivery.fail(delivery, "payload blob not found", now);
        await deps.deliveries.update(ctx, failed);
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

      const result = await deps.transport.dispatch(ctx, {
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
          // Stay `queued` and let the queue redeliver. Throwing is the signal.
          throw new DomainError("send_rejected", `Transport error: ${result.error}`, {
            deliveryId: delivery.id,
            retryable: true,
          });
        }
        const failed = Delivery.fail(delivery, result.error, now);
        await deps.deliveries.update(ctx, failed);
        await deps.events.publish([
          {
            type: "delivery.rejected",
            accountId: ctx.accountId,
            occurredAt: now,
            deliveryId: failed.id,
            reason: result.error,
            code: "send_rejected",
          },
        ]);
        return { outcome: "failed", delivery: failed, error: result.error };
      }

      let dispatched = Delivery.markDispatched(delivery, result.providerMessageId, now);

      // Archive our copy, threaded alongside the message it replies to.
      const candidates = ThreadingPolicy.candidateIds(payload.inReplyTo, payload.references);
      const known =
        candidates.length > 0
          ? await deps.messages.findThreadIds(ctx, candidates)
          : new Map<string, ThreadId>();
      const thread = ThreadingPolicy.resolve({
        ownMessageId: payload.messageId,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        known,
      });

      const messageId = deps.ids.ulid();
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
      await deps.blobs.put(ctx, rawKey, raw, { contentType: "message/rfc822" });

      const sentCopy = Message.create({
        id: messageId,
        accountId: ctx.accountId,
        inboxId: delivery.inboxId,
        rfcMessageId: payload.messageId,
        threadId: thread.threadId,
        direction: "outbound",
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
        sentAt: now,
        receivedAt: now,
      });
      await deps.messages.insert(ctx, sentCopy);

      dispatched = Delivery.attachSentCopy(dispatched, sentCopy.id, now);
      await deps.deliveries.update(ctx, dispatched);
      await deps.events.publish([
        {
          type: "delivery.dispatched",
          accountId: ctx.accountId,
          occurredAt: now,
          deliveryId: dispatched.id,
          providerMessageId: result.providerMessageId,
        },
      ]);

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
      const delivery = await deps.deliveries.findByProviderMessageId(
        ctx,
        event.providerMessageId,
      );

      await deps.deliveries.appendDeliveryEvent(ctx, {
        id: deps.ids.ulid(),
        deliveryId: delivery?.id ?? null,
        providerMessageId: event.providerMessageId,
        recipient: event.recipient,
        type: event.type,
        terminal: event.terminal,
        smtpCode: event.smtpCode ?? null,
        smtpResponse: event.smtpResponse ?? null,
        occurredAt: event.occurredAt,
        raw: event.raw ?? null,
      });

      // A bounce or complaint must reach the suppression list even if we cannot
      // match the send — protecting sender reputation matters more than tidy
      // bookkeeping, and quota is only consumed by attempts we actually make.
      if (
        event.recipient !== null &&
        (event.type === "bounced" || event.type === "complained")
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
        return { outcome: "unmatched" };
      }

      const applied = Delivery.applyDeliveryEvent(delivery, {
        type: event.type,
        occurredAt: event.occurredAt,
        detail: event.smtpResponse ?? null,
      });

      if (!applied.applied) {
        return { outcome: "recorded_only", reason: applied.reason };
      }

      await deps.deliveries.update(ctx, applied.delivery);
      await deps.events.publish([
        {
          type: "delivery.status_changed",
          accountId: ctx.accountId,
          occurredAt: event.occurredAt,
          deliveryId: applied.delivery.id,
          from: delivery.status,
          to: applied.delivery.status,
          deliveryEvent: event.type,
          recipient: event.recipient,
        },
      ]);

      return { outcome: "applied", from: delivery.status, to: applied.delivery.status };
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
      const now = deps.clock.now();

      const delivery = await deps.deliveries.findById(ctx, deliveryId);
      if (delivery === null) {
        throw notFound("message_not_found", `No delivery ${deliveryId}.`, { deliveryId });
      }
      if (delivery.status !== "pending_approval") {
        throw new DomainError(
          "invalid_state_transition",
          `Delivery ${deliveryId} is ${delivery.status}, not awaiting approval.`,
          { deliveryId, status: delivery.status },
        );
      }

      const approved = Delivery.enqueue(Delivery.approve(delivery, ctx.subject, now), now);
      await deps.deliveries.update(ctx, approved);
      await deps.dispatchQueue.enqueue(ctx, approved.id);
      await deps.events.publish([
        {
          type: "delivery.status_changed",
          accountId: ctx.accountId,
          occurredAt: now,
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
      return { delivery, events: await deps.deliveries.listDeliveryEvents(ctx, deliveryId) };
    },

    /** Sends, newest first. `status: "pending_approval"` is the approval queue. */
    async list(ctx: Caller, query: ListDeliveriesQuery = {}): Promise<Page<Delivery>> {
      Caller.require(ctx, "message:read");
      return await deps.deliveries.list(ctx, query);
    },

    /** The suppression list: who we must not mail, and why. */
    async listSuppressions(ctx: Caller): Promise<SuppressionEntry[]> {
      Caller.require(ctx, "message:read");
      return await deps.suppressions.list(ctx);
    },

    async suppress(ctx: Caller, entry: Omit<SuppressionEntry, "createdAt">): Promise<void> {
      Caller.require(ctx, "message:send");
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
            timestamp: event.occurredAt,
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
}

export interface DomainDiagnosis {
  readonly domain: string;
  readonly status: CheckStatus;
  readonly checks: readonly Check[];
}

export type DeliveryService = ReturnType<typeof createDeliveryService>;

export const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Encode/decode kept next to the type so the two cannot drift. */
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
