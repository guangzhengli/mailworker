import type { AuthContext, EmailAddress } from "@core/domain/index.ts";

/**
 * Blob storage — R2 in production, a Map in tests.
 *
 * Every inbound message's original MIME goes here verbatim. That is what makes
 * `mailworker get --raw > fixture.eml` and `mailworker inject fixture.eml` a
 * closed loop: a weird message from production becomes a regression test, and a
 * parser change can be replayed against everything we ever received.
 */
export interface BlobStorePort {
  put(ctx: AuthContext, key: string, body: Uint8Array, meta?: BlobMeta): Promise<void>;
  get(ctx: AuthContext, key: string): Promise<Uint8Array | null>;
  delete(ctx: AuthContext, keys: readonly string[]): Promise<void>;
}

export interface BlobMeta {
  readonly contentType?: string;
  readonly filename?: string;
}

/** Key layout, in one place so the sweeper and the readers cannot disagree. */
export const BlobKeys = {
  rawMessage(accountId: string, messageId: string): string {
    return `raw/${accountId}/${messageId}.eml`;
  },
  attachment(accountId: string, messageId: string, attachmentId: string): string {
    return `att/${accountId}/${messageId}/${attachmentId}`;
  },
  outboundPayload(accountId: string, outboundId: string): string {
    return `out/${accountId}/${outboundId}.json`;
  },
} as const;

export type SuppressionReason = "hard_bounce" | "soft_bounce" | "complaint" | "manual";

export interface SuppressionEntry {
  readonly address: EmailAddress;
  readonly reason: SuppressionReason;
  /** `cf_sync` when mirrored from Cloudflare's account list, `local` when ours. */
  readonly source: "cf_sync" | "local";
  readonly createdAt: Date;
}

/**
 * Addresses we must not mail.
 *
 * Cloudflare keeps its own account-level list and adds hard bounces to it
 * automatically. We mirror it so `SendPolicy` can reject locally — refusing
 * before the API call keeps the attempt off our reputation and, since API-level
 * rejections do not count against quota, off the bill too.
 */
export interface SuppressionListPort {
  /** Which of these addresses are suppressed. Batched: SendPolicy needs all of them. */
  filterSuppressed(
    ctx: AuthContext,
    addresses: readonly EmailAddress[],
  ): Promise<EmailAddress[]>;
  add(ctx: AuthContext, entry: SuppressionEntry): Promise<void>;
  remove(ctx: AuthContext, address: EmailAddress): Promise<void>;
  list(ctx: AuthContext): Promise<SuppressionEntry[]>;
}
