/**
 * Cloudflare Email Sending's hard limits, in one place.
 *
 * These live in the domain rather than in the transport adapter because the send
 * path enforces them BEFORE a network call: refusing locally keeps a doomed
 * attempt off the account's sending reputation, and Cloudflare does not charge
 * quota for API-level rejections (DESIGN.md §2.2). An adapter that also checks
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
} as const;
