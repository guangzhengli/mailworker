import { emailAddress, toIso, ulid } from "@contract/primitives";
import type {
  AttachmentSpec,
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
    /** Defaulted rather than required: most callers know the bytes, not the type. */
    type: z.string().min(1).max(255).optional(),
    content: z.base64(),
    /** Referenced from the HTML body as `cid:<contentId>`. */
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
 * `POST /v1/send`.
 *
 * The recipient caps are Cloudflare's (50 across to + cc + bcc, DESIGN.md §2.2)
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
    /** Continue a thread, addressed by our message ULID rather than a Message-ID. */
    inReplyTo: ulid.optional(),
    headers: z.record(z.string().min(1), z.string()).optional(),
    attachments: z.array(attachmentInput).max(SENDING_LIMITS.MAX_ATTACHMENTS).optional(),
    /**
     * Also accepted as the `Idempotency-Key` header, which wins when both are
     * present. The header suits a proxy or an SDK retry wrapper; the body field
     * suits whoever is building the request by hand.
     */
    idempotencyKey: z.string().min(1).max(255).optional(),
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
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      ...(input.automated === undefined ? {} : { automated: input.automated }),
    }),
  );

export const deliveryDto = z.object({
  id: z.string(),
  inboxId: z.string().nullable(),
  identityId: z.string().nullable(),
  /** The stored sent copy, once it exists. `GET /v1/messages/:id` reads it. */
  messageId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
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
  type: z.string(),
  recipient: z.string().nullable(),
  terminal: z.boolean(),
  smtpCode: z.string().nullable(),
  smtpResponse: z.string().nullable(),
  occurredAt: z.string(),
  raw: z.string().nullable(),
});

export type DeliveryEventDto = z.infer<typeof deliveryEventDto>;

export function toDeliveryEventDto(event: DeliveryEvent): DeliveryEventDto {
  return {
    id: event.id,
    type: event.type,
    recipient: event.recipient,
    terminal: event.terminal,
    smtpCode: event.smtpCode,
    smtpResponse: event.smtpResponse,
    occurredAt: toIso(event.occurredAt),
    raw: event.raw,
  };
}

/**
 * `GET /v1/send/:id` — the record plus everything the provider has since said
 * about it, oldest first. This is the half of "did my email arrive" that the
 * send response itself cannot answer, because at send time nothing has happened
 * yet (DESIGN.md §2.2).
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

export const listDeliveriesQuery = z.object({
  status: deliveryStatus.optional(),
  identity: ulid.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: ulid.optional(),
});

export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuery>;

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
  /** The next action, when there is one. */
  fix: z.string().optional(),
});

export const domainDiagnosisDto = z.object({
  domain: z.string(),
  status: checkStatus,
  checks: z.array(checkDto),
});

export const diagnosticsDto = z.object({
  domains: z.array(domainDiagnosisDto),
  /** Cross-cutting facts a per-domain check cannot express. */
  deployment: z.object({
    sendingConfigured: z.boolean(),
    dispatchQueueConfigured: z.boolean(),
  }),
});

export type CheckDto = z.infer<typeof checkDto>;
export type DomainDiagnosisDto = z.infer<typeof domainDiagnosisDto>;
export type DiagnosticsDto = z.infer<typeof diagnosticsDto>;
