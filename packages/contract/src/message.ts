import {
  durationMs,
  emailAddress,
  pageQuery,
  queryBool,
  toIso,
  ulid,
} from "@contract/primitives";
import type {
  AttachmentMeta,
  Message,
  MessageSummary,
  WaitForMessageRequest,
} from "@mailworker/core";
import { z } from "zod";

export const attachmentDto = z.object({
  id: z.string(),
  filename: z.string().nullable(),
  mime: z.string().nullable(),
  contentId: z.string().nullable(),
  size: z.number().int().nonnegative(),
  inline: z.boolean(),
});

export type AttachmentDto = z.infer<typeof attachmentDto>;

/**
 * Where the content came from and how much of it to believe.
 *
 * Grouped rather than flattened because these seven fields are one thought and
 * always travel together — a renderer, a ranker and a human all want the whole
 * set or none of it. Keeping them in a named object also means the answer to
 * "is this body trustworthy" is somewhere you have to look at, instead of two
 * booleans lost among thirty scalar fields.
 *
 * `trusted` means the sending domain is cryptographically attributable. It does
 * NOT mean the body is safe to act on. Nothing makes inbound email safe to act
 * on: it is data an agent reads, never instructions an agent follows.
 */
export const provenanceDto = z.object({
  trusted: z.boolean(),
  injectionRisk: z.boolean(),
  reasons: z.array(z.string()),
  spf: z.string(),
  dkim: z.string(),
  dmarc: z.string(),
});

export type ProvenanceDto = z.infer<typeof provenanceDto>;

const messageBase = z.object({
  id: z.string(),
  inboxId: z.string(),
  messageId: z.string(),
  threadId: z.string(),
  direction: z.enum(["inbound", "outbound"]),

  /** The raw `From` header, display name intact. Never the SMTP envelope sender. */
  fromHeader: z.string(),
  from: z.string().nullable(),
  toHeader: z.string(),
  to: z.array(z.string()),
  cc: z.array(z.string()),
  bcc: z.array(z.string()),
  replyTo: z.string().nullable(),

  subject: z.string(),
  inReplyTo: z.string().nullable(),
  references: z.array(z.string()),

  provenance: provenanceDto,
  /** The `+tag` this was addressed to, if any. */
  tag: z.string().nullable(),
  autoSubmitted: z.string().nullable(),
  size: z.number().int().nonnegative(),
  seen: z.boolean(),
  /** The `Date` header. Display only — order by `id`, never by this. */
  sentAt: z.string().nullable(),
  receivedAt: z.string(),
});

export const messageDto = messageBase.extend({
  bodyText: z.string().nullable(),
  /** Sanitized HTML, or null. See `toMessageDto` for why it can be null. */
  bodyHtml: z.string().nullable(),
  attachments: z.array(attachmentDto),
});

export type MessageDto = z.infer<typeof messageDto>;

export const messageSummaryDto = messageBase.extend({
  attachmentCount: z.number().int().nonnegative(),
  hasText: z.boolean(),
  hasHtml: z.boolean(),
  preview: z.string(),
});

export type MessageSummaryDto = z.infer<typeof messageSummaryDto>;

export interface MessageDtoOptions {
  /**
   * Required for `bodyHtml` to be populated.
   *
   * Fail closed: without a sanitizer the field comes back null rather than
   * carrying the original markup. Forgetting to wire one up then costs a
   * missing preview, which someone notices, instead of shipping attacker-authored
   * HTML to a dashboard, which nobody notices until it matters.
   *
   * The real boundary is still the sandboxed iframe and the CSP around it; this
   * is the second line, not the first.
   */
  readonly sanitizeHtml?: (html: string) => string;
}

/**
 * `rawKey` and `accountId` are not on the wire. The blob key is an internal
 * address that would let a caller reason about our storage layout; the original
 * bytes are served by `GET /v1/messages/:id/raw` instead, which is the same
 * thing behind an authorization check.
 */
export function toMessageDto(message: Message, options: MessageDtoOptions = {}): MessageDto {
  return {
    ...summaryFields(message),
    bodyText: message.bodyText,
    bodyHtml:
      message.bodyHtml === null || options.sanitizeHtml === undefined
        ? null
        : options.sanitizeHtml(message.bodyHtml),
    attachments: message.attachments.map(toAttachmentDto),
  };
}

export function toMessageSummaryDto(summary: MessageSummary): MessageSummaryDto {
  return {
    ...summaryFields(summary),
    attachmentCount: summary.attachmentCount,
    hasText: summary.hasText,
    hasHtml: summary.hasHtml,
    preview: summary.preview,
  };
}

export function toAttachmentDto(attachment: AttachmentMeta): AttachmentDto {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mime: attachment.mime,
    contentId: attachment.contentId,
    size: attachment.size,
    inline: attachment.inline,
  };
}

function summaryFields(message: Message | MessageSummary): z.infer<typeof messageBase> {
  return {
    id: message.id,
    inboxId: message.inboxId,
    // `messageId` on the wire, `rfcMessageId` in the domain: out here there is
    // only one kind of message id worth naming, and `id` is already taken by
    // the ULID.
    messageId: message.rfcMessageId,
    threadId: message.threadId,
    direction: message.direction,
    fromHeader: message.fromHeader,
    from: message.from,
    toHeader: message.toHeader,
    to: [...message.to],
    cc: [...message.cc],
    bcc: [...message.bcc],
    replyTo: message.replyTo,
    subject: message.subject,
    inReplyTo: message.inReplyTo,
    references: [...message.references],
    provenance: {
      trusted: message.trusted,
      injectionRisk: message.injectionRisk,
      reasons: [...message.trustReasons],
      spf: message.auth.spf,
      dkim: message.auth.dkim,
      dmarc: message.auth.dmarc,
    },
    tag: message.tag,
    autoSubmitted: message.autoSubmitted,
    size: message.size,
    seen: message.seen,
    sentAt: toIso(message.sentAt),
    receivedAt: toIso(message.receivedAt),
  };
}

export const listMessagesQuery = pageQuery.extend({
  inbox: ulid.optional(),
  thread: z.string().optional(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  from: emailAddress.optional(),
  seen: queryBool.optional(),
  /** Full text over subject and text body. */
  q: z.string().min(1).max(256).optional(),
  after: ulid.optional(),
});

export type ListMessagesQuery = z.infer<typeof listMessagesQuery>;

export const extractKind = z.enum(["otp", "link", "none"]);

/**
 * `GET /v1/messages/wait`, the operation the CLI is shaped around.
 *
 * `timeout` accepts `30s` as readily as `30000`, because the person typing it is
 * usually a person. A timeout is an outcome here, not an error — see
 * `waitResponse`.
 */
export const waitQuery = z
  .object({
    inbox: ulid.optional(),
    from: emailAddress.optional(),
    subject: z.string().max(256).optional(),
    match: z.string().max(512).optional(),
    after: ulid.optional(),
    timeout: durationMs.optional(),
    extract: extractKind.optional(),
  })
  .transform(
    (input): WaitForMessageRequest => ({
      ...(input.inbox === undefined ? {} : { inboxId: input.inbox }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.match === undefined ? {} : { match: input.match }),
      ...(input.after === undefined ? {} : { after: input.after }),
      ...(input.timeout === undefined ? {} : { timeoutMs: input.timeout }),
      ...(input.extract === undefined ? {} : { extract: input.extract }),
    }),
  );

export const waitResponse = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("matched"),
    message: messageDto,
    /** The code or link, when `extract` was asked for. Null when nothing matched. */
    extracted: z.string().nullable(),
  }),
  z.object({
    outcome: z.literal("timeout"),
    waitedMs: z.number().int().nonnegative(),
  }),
]);

export type WaitResponse = z.infer<typeof waitResponse>;

/**
 * `POST /v1/ingest/raw` — what `mailworker inject` calls.
 *
 * Query parameters plus an `message/rfc822` body, mirroring Cloudflare's local
 * handler at `/cdn-cgi/handler/email`. Same call shape locally and in
 * production means a fixture that reproduces a bug on a laptop reproduces it on
 * the deployment too, which is the entire point of `inject`.
 */
export const ingestRawQuery = z.object({
  to: emailAddress,
  from: emailAddress.optional(),
});

export type IngestRawQuery = z.infer<typeof ingestRawQuery>;

export const seenBody = z.strictObject({ seen: z.boolean().optional() });
