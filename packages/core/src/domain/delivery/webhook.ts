import { invalidArgument } from "@core/domain/errors";
import type { DomainEvent, DomainEventType } from "@core/domain/events";
import type { AccountId } from "@core/domain/identity/account-id";
import type { Ulid } from "@core/domain/ulid";

/**
 * Where domain events go when someone is listening.
 *
 * It lives in `delivery` rather than in a context of its own. DESIGN §4.1
 * retired `automation` for exactly this reason: a webhook has one rule
 * (which events match a subscription) and otherwise consists of ports, and a
 * context with no rules in it is a directory pretending to be a boundary.
 */
export interface WebhookSubscription {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly url: string;
  /**
   * The signing secret, in the clear.
   *
   * Unlike an API key this cannot be hashed: signing a payload requires the
   * secret itself, and both ends need the same one. What that buys the
   * receiver is worth the storage risk — they verify without ever sending the
   * secret back to us, so it never travels after the one time we show it.
   */
  readonly secret: string;
  /**
   * Event types to deliver. Empty means every type, including ones added later
   * — which is the right default for a debugging subscription and the wrong one
   * for a production integration, so it is a choice rather than an omission.
   */
  readonly events: readonly DomainEventType[];
  readonly enabled: boolean;
  readonly createdAt: Date;
}

export interface CreateWebhookInput {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly url: string;
  readonly secret: string;
  readonly now: Date;
  readonly events?: readonly DomainEventType[];
}

export const WebhookSubscription = {
  create(input: CreateWebhookInput): WebhookSubscription {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw invalidArgument(`Not a valid webhook URL: ${input.url}`, { url: input.url });
    }
    // HTTPS only. The payload carries message subjects and recipient addresses,
    // and the signature proves origin rather than providing confidentiality —
    // over plain HTTP the whole thing is readable by anyone on the path.
    if (url.protocol !== "https:") {
      throw invalidArgument("A webhook URL must be https.", { url: input.url });
    }

    return {
      id: input.id,
      accountId: input.accountId,
      url: url.toString(),
      secret: input.secret,
      events: input.events === undefined ? [] : [...input.events],
      enabled: true,
      createdAt: input.now,
    };
  },

  wants(subscription: WebhookSubscription, event: DomainEvent): boolean {
    if (!subscription.enabled) return false;
    return subscription.events.length === 0 || subscription.events.includes(event.type);
  },

  disable(subscription: WebhookSubscription): WebhookSubscription {
    return { ...subscription, enabled: false };
  },
} as const;

/**
 * The bytes that get signed, and the headers that carry the signature.
 *
 * This is the Standard Webhooks format — `webhook-id`, `webhook-timestamp`,
 * `webhook-signature`, over `id.timestamp.payload`. Deliberately not our own
 * scheme: Svix, Resend, Clerk and Vercel all send this, so anyone integrating
 * with Mailworker probably already has a verifier, and the ones who do not can
 * use an off-the-shelf library instead of reading our documentation.
 *
 * The timestamp is inside the signed string, not merely alongside it. That is
 * what makes it a replay defence rather than a decoration: an attacker who
 * captures a delivery cannot move it forward in time without invalidating the
 * signature, so a receiver rejecting old timestamps actually rejects replays.
 */
export const WebhookSignature = {
  /** Reject anything older than this. Five minutes is the spec's tolerance. */
  TOLERANCE_MS: 5 * 60 * 1000,

  /** `<id>.<unix seconds>.<body>` — what the HMAC is computed over. */
  signingInput(id: string, timestampSeconds: number, body: string): string {
    return `${id}.${timestampSeconds}.${body}`;
  },

  /** `v1,<base64 hmac>`. The version prefix is what makes rotation possible. */
  header(signatureBase64: string): string {
    return `v1,${signatureBase64}`;
  },

  fresh(timestampSeconds: number, now: Date): boolean {
    return Math.abs(now.getTime() - timestampSeconds * 1000) <= WebhookSignature.TOLERANCE_MS;
  },
} as const;
