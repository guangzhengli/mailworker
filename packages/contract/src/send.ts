import { errorCode } from "@contract/errors";
import { emailAddress, toIso, ulid } from "@contract/primitives";
import type {
  AttachmentSpec,
  BatchSendItem,
  Delivery,
  DeliveryEvent,
  SendMessageRequest,
} from "@mailworker/core";
import { SENDING_LIMITS } from "@mailworker/core";
import { z } from "zod";

export const deliveryStatus = z.enum([
  "draft",
  "pending_approval",
  "queued",
  "dispatching",
  "dispatched",
  "deferred",
  "delivered",
  "bounced",
  "complained",
  "failed",
  "rejected",
]);

export const deliveryEventType = z.enum([
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
  "complained",
]);

/**
 * One attachment on the wire, with `content` base64-encoded.
 *
 * Base64 rather than multipart because the request is JSON everywhere else and
 * an agent building one by hand should not have to switch encodings to attach a
 * file. The charset check is worth doing here rather than at decode time: it is
 * the difference between a 400 naming the field and a failed `atob` inside a
 * queue consumer twenty seconds later, where nobody is listening.
 *
 * The SIZE, unlike the shape, is not checked here — `Attachment.enforceMessageSize`
 * owns it, because the limit is a property of Cloudflare's sending API rather
 * than of this schema, and it applies to the bodies and the attachments together.
 */
export const attachmentInput = z
  .strictObject({
    filename: z.string().min(1).max(255),
    type: z.string().min(1).max(255).optional(),
    content: z.base64(),
    contentId: z.string().min(1).max(255).optional(),
  })
  .transform(
    (input): AttachmentSpec => ({
      filename: input.filename,
      mime: input.type ?? "application/octet-stream",
      content: input.content,
      inline: input.contentId !== undefined,
      contentId: input.contentId ?? null,
    }),
  );

/**
 * Caller-defined key/value pairs, echoed on the delivery and on every webhook
 * event about it.
 *
 * Capped in count and length because this is stored on the row that every list
 * query reads, and because an unbounded map on an audit record is somewhere to
 * put a whole message body — which would then be exempt from the retention that
 * governs message bodies.
 */
export const metadataInput = z
  .record(z.string().min(1).max(64), z.string().max(512))
  .refine((value) => Object.keys(value).length <= 20, {
    message: "At most 20 metadata keys.",
  });

/** Shared validation for the body field and the `Idempotency-Key` header. */
export const idempotencyKey = z.string().min(1).max(255);

/**
 * `POST /v1/send`.
 *
 * The recipient caps are Cloudflare's (50 across to + cc + bcc)
 * and the domain enforces the total; capping each list here just stops an
 * obviously oversized request before it reaches a policy gate.
 */
export const sendBody = z
  .strictObject({
    from: emailAddress,
    to: z.array(emailAddress).min(1).max(SENDING_LIMITS.MAX_RECIPIENTS),
    cc: z.array(emailAddress).max(SENDING_LIMITS.MAX_RECIPIENTS).optional(),
    bcc: z.array(emailAddress).max(SENDING_LIMITS.MAX_RECIPIENTS).optional(),
    subject: z.string().max(2000),
    text: z.string().optional(),
    html: z.string().optional(),
    replyTo: emailAddress.optional(),
    inReplyTo: ulid.optional(),
    headers: z.record(z.string().min(1), z.string()).optional(),
    attachments: z.array(attachmentInput).max(SENDING_LIMITS.MAX_ATTACHMENTS).optional(),
    metadata: metadataInput.optional(),
    /**
     * Also accepted as the `Idempotency-Key` header, which wins when both are
     * present. The header suits a proxy or an SDK retry wrapper; the body field
     * suits whoever is building the request by hand.
     */
    idempotencyKey: idempotencyKey.optional(),
    /**
     * True when a machine, not a human, triggered this. Feeds the loop breaker
     * and sets `Auto-Submitted`, so honesty here is what keeps two agents from
     * mailing each other until the quota is gone.
     */
    automated: z.boolean().optional(),
  })
  .transform(
    (input): SendMessageRequest => ({
      from: input.from,
      to: input.to,
      subject: input.subject,
      ...(input.cc === undefined ? {} : { cc: input.cc }),
      ...(input.bcc === undefined ? {} : { bcc: input.bcc }),
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.html === undefined ? {} : { html: input.html }),
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      ...(input.inReplyTo === undefined ? {} : { inReplyToMessageId: input.inReplyTo }),
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.automated === undefined ? {} : { automated: input.automated }),
    }),
  );

export const deliveryDto = z.object({
  id: z.string(),
  inboxId: z.string().nullable(),
  identityId: z.string().nullable(),
  messageId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
  status: deliveryStatus,
  attempts: z.number().int().nonnegative(),
  recipients: z.array(z.string()),
  providerMessageId: z.string().nullable(),
  rejectReason: z.string().nullable(),
  lastError: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DeliveryDto = z.infer<typeof deliveryDto>;

/** `payloadKey` stays off the wire for the same reason as a message's `rawKey`. */
export function toDeliveryDto(delivery: Delivery): DeliveryDto {
  return {
    id: delivery.id,
    inboxId: delivery.inboxId,
    identityId: delivery.identityId,
    messageId: delivery.messageId,
    idempotencyKey: delivery.idempotencyKey,
    metadata: { ...delivery.metadata },
    status: delivery.status,
    attempts: delivery.attempts,
    recipients: [...delivery.recipients],
    providerMessageId: delivery.providerMessageId,
    rejectReason: delivery.rejectReason,
    lastError: delivery.lastError,
    approvedBy: delivery.approvedBy,
    approvedAt: toIso(delivery.approvedAt),
    createdAt: toIso(delivery.createdAt),
    updatedAt: toIso(delivery.updatedAt),
  };
}

/**
 * One line of the delivery timeline.
 *
 * `raw` is the provider's own payload, kept verbatim. It is on the wire on
 * purpose: when a message bounces for a reason our mapping did not anticipate,
 * the SMTP response the receiving host actually gave is the only thing that
 * answers why, and making someone open a database to read it would defeat the
 * point of having a timeline at all.
 */
export const deliveryEventDto = z.object({
  id: z.string(),
  eventId: z.string().nullable(),
  type: z.string(),
  recipient: z.string().nullable(),
  sourceDomain: z.string().nullable(),
  sourceZoneId: z.string().nullable(),
  terminal: z.boolean(),
  smtpCode: z.string().nullable(),
  smtpEnhancedCode: z.string().nullable(),
  smtpResponse: z.string().nullable(),
  bounceType: z.enum(["hard", "soft"]).nullable(),
  bounceClassification: z.string().nullable(),
  bounceReason: z.string().nullable(),
  occurredAt: z.string(),
  raw: z.string().nullable(),
});

export type DeliveryEventDto = z.infer<typeof deliveryEventDto>;

export function toDeliveryEventDto(event: DeliveryEvent): DeliveryEventDto {
  return {
    id: event.id,
    eventId: event.eventId,
    type: event.type,
    recipient: event.recipient,
    sourceDomain: event.sourceDomain,
    sourceZoneId: event.sourceZoneId,
    terminal: event.terminal,
    smtpCode: event.smtpCode,
    smtpEnhancedCode: event.smtpEnhancedCode,
    smtpResponse: event.smtpResponse,
    bounceType: event.bounceType,
    bounceClassification: event.bounceClassification,
    bounceReason: event.bounceReason,
    occurredAt: toIso(event.occurredAt),
    raw: event.raw,
  };
}

/**
 * `GET /v1/send/:id` — the record plus everything the provider has since said
 * about it, oldest first. This is the half of "did my email arrive" that the
 * send response itself cannot answer, because at send time nothing has happened
 * yet.
 */
export const deliveryTimelineDto = z.object({
  delivery: deliveryDto,
  events: z.array(deliveryEventDto),
});

export type DeliveryTimelineDto = z.infer<typeof deliveryTimelineDto>;

/**
 * `duplicate` is a success, not a failure: the idempotency key matched an
 * earlier submission and this is that submission, unsent a second time. A
 * caller retrying after a timeout wants exactly this, and wants to be able to
 * tell it apart from having sent twice.
 */
export const sendResponse = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("queued"), delivery: deliveryDto }),
  z.object({ outcome: z.literal("pending_approval"), delivery: deliveryDto }),
  z.object({ outcome: z.literal("duplicate"), delivery: deliveryDto }),
]);

export type SendResponse = z.infer<typeof sendResponse>;

/**
 * `POST /v1/send/batch` — up to 100 messages, each judged on its own.
 *
 * A flat array rather than `{ messages: [...] }` would have been shorter, but an
 * object leaves room to add batch-wide options later without a second endpoint.
 */
export const sendBatchBody = z.strictObject({
  messages: z.array(sendBody).min(1).max(SENDING_LIMITS.MAX_BATCH),
});

/**
 * One result per submitted message, in submission order.
 *
 * `index` is redundant with the array position and is on the wire anyway: it
 * survives a client that filters or sorts the array, which is the first thing
 * anyone does with a batch result they intend to retry.
 *
 * Note that `error` here is a per-message verdict, not a failed request. The
 * response is 207: some of these were accepted. A caller that treats any non-2xx
 * as "nothing was sent" would be wrong about the other 99, so the status code
 * has to say "mixed" out loud.
 */
export const sendBatchItem = z.discriminatedUnion("outcome", [
  z.object({ index: z.number().int(), outcome: z.literal("queued"), delivery: deliveryDto }),
  z.object({
    index: z.number().int(),
    outcome: z.literal("pending_approval"),
    delivery: deliveryDto,
  }),
  z.object({ index: z.number().int(), outcome: z.literal("duplicate"), delivery: deliveryDto }),
  z.object({
    index: z.number().int(),
    outcome: z.literal("error"),
    error: z.object({
      code: errorCode,
      message: z.string(),
      details: z.record(z.string(), z.unknown()),
    }),
  }),
]);

export const sendBatchResponse = z.object({
  items: z.array(sendBatchItem),
  accepted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});

export type SendBatchItem = z.infer<typeof sendBatchItem>;
export type SendBatchResponse = z.infer<typeof sendBatchResponse>;

export function toSendBatchItem(item: BatchSendItem): SendBatchItem {
  if (item.outcome === "error") {
    return {
      index: item.index,
      outcome: "error",
      error: { code: item.code, message: item.message, details: { ...item.details } },
    };
  }
  return { index: item.index, outcome: item.outcome, delivery: toDeliveryDto(item.delivery) };
}

export const listDeliveriesQuery = z.object({
  status: deliveryStatus.optional(),
  identity: ulid.optional(),
  /** Subject, body or sender of the archived copy, or a recipient address. */
  q: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: ulid.optional(),
  order: z.enum(["asc", "desc"]).optional(),
});

export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuery>;

/** A human reviewer explicitly declines a held send. */
export const rejectDeliveryBody = z.strictObject({
  reason: z.string().trim().min(1).max(500).optional(),
});

export type RejectDeliveryBody = z.infer<typeof rejectDeliveryBody>;

/**
 * `GET /v1/diagnostics` — what `mailworker doctor` prints.
 *
 * Four statuses rather than a boolean, because the useful answers are not
 * binary. `warn` is a real configuration that will work and should not
 * (`p=none` DMARC); `unknown` is a check we could not substantiate rather than
 * one that failed, and conflating the two is how a diagnostic command trains
 * people to ignore it.
 */
export const checkStatus = z.enum(["pass", "warn", "fail", "unknown"]);

export const checkDto = z.object({
  name: z.string(),
  status: checkStatus,
  detail: z.string(),
  fix: z.string().optional(),
});

export const domainDiagnosisDto = z.object({
  domain: z.string(),
  status: checkStatus,
  checks: z.array(checkDto),
});

export const diagnosticsDto = z.object({
  domains: z.array(domainDiagnosisDto),
  deployment: z.object({
    sendingConfigured: z.boolean(),
    dispatchQueueConfigured: z.boolean(),
  }),
});

export type CheckDto = z.infer<typeof checkDto>;
export type DomainDiagnosisDto = z.infer<typeof domainDiagnosisDto>;
export type DiagnosticsDto = z.infer<typeof diagnosticsDto>;
