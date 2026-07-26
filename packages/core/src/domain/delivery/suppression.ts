import type { EmailAddress } from "@core/domain/email-address";

/**
 * An address we must not mail.
 *
 * Cloudflare keeps its own account-level list and adds hard bounces to it
 * automatically. We mirror it so `SendPolicy` can refuse locally — refusing
 * before the API call keeps the attempt off our sending reputation and, since
 * API-level rejections do not count against quota, off the bill too.
 */
export type SuppressionReason = "hard_bounce" | "soft_bounce" | "complaint" | "manual";

export interface SuppressionEntry {
  readonly address: EmailAddress;
  readonly reason: SuppressionReason;
  /** `cf_sync` when mirrored from Cloudflare's account list, `local` when ours. */
  readonly source: "cf_sync" | "local";
  readonly createdAt: Date;
}
