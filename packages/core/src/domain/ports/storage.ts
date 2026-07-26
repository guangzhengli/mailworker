import type { Caller, EmailAddress } from "@core/domain";
import type { SuppressionEntry } from "@core/domain/delivery/suppression";

/**
 * Blob storage — R2 in production, a Map in tests.
 *
 * Every inbound message's original MIME goes here verbatim. That is what makes
 * `mailworker get --raw > fixture.eml` and `mailworker inject fixture.eml` a
 * closed loop: a weird message from production becomes a regression test, and a
 * parser change can be replayed against everything we ever received.
 */
export interface BlobStore {
  put(ctx: Caller, key: string, body: Uint8Array, meta?: BlobMeta): Promise<void>;
  get(ctx: Caller, key: string): Promise<Uint8Array | null>;
  delete(ctx: Caller, keys: readonly string[]): Promise<void>;
}

export interface BlobMeta {
  readonly contentType?: string;
  readonly filename?: string;
}

/**
 * Addresses we must not mail.
 *
 * Cloudflare keeps its own account-level list and adds hard bounces to it
 * automatically. We mirror it so `SendPolicy` can reject locally — refusing
 * before the API call keeps the attempt off our reputation and, since API-level
 * rejections do not count against quota, off the bill too.
 */
export interface SuppressionList {
  /** Which of these addresses are suppressed. Batched: SendPolicy needs all of them. */
  filterSuppressed(ctx: Caller, addresses: readonly EmailAddress[]): Promise<EmailAddress[]>;
  add(ctx: Caller, entry: SuppressionEntry): Promise<void>;
  remove(ctx: Caller, address: EmailAddress): Promise<void>;
  list(ctx: Caller): Promise<SuppressionEntry[]>;
}
