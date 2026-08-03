/**
 * Cloudflare Email Sending's hard limits, in one place.
 *
 * These live in the domain rather than in the transport adapter because the send
 * path enforces them BEFORE a network call: refusing locally keeps a doomed
 * attempt off the account's sending reputation, and Cloudflare does not charge
 * quota for API-level rejections. An adapter that also checks
 * them is checking the same numbers, not owning them.
 *
 * Verified 2026-07.
 */
export const SENDING_LIMITS = {
  /** 5 MiB total message size, including attachments. */
  MAX_MESSAGE_BYTES: 5 * 1024 * 1024,
  /** 25 MiB when every recipient is a verified destination address. */
  MAX_MESSAGE_BYTES_VERIFIED: 25 * 1024 * 1024,
  /** 50 across to + cc + bcc. */
  MAX_RECIPIENTS: 50,
  /** 16 KiB for all custom headers combined. */
  MAX_HEADER_BYTES: 16 * 1024,
  /**
   * Ours, not Cloudflare's — it publishes a total size and no part count.
   *
   * A cap is still worth having: every attachment is base64 held in memory
   * inside a Worker with a 128 MiB ceiling, and a message with 500 one-byte
   * parts passes the size limit while being nothing anyone meant to send.
   */
  MAX_ATTACHMENTS: 20,
  /**
   * Also ours. A batch is sent one message at a time (see `sendBatch`), so the
   * cap is really a cap on how long one request may hold a Worker — 100 sends,
   * each a handful of D1 reads and an R2 write, is about the most that fits
   * comfortably inside a request's CPU budget.
   */
  MAX_BATCH: 100,
} as const;
