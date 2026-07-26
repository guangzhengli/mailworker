import type { Deps, Operation } from "@/application/deps.ts";
import type { AuthContext, DeliveryEventType, EmailAddress } from "@/domain/index.ts";
import { OutboundMessage as OutboundVO } from "@/domain/index.ts";

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

type Needs = "clock" | "ids" | "outbound" | "suppressions" | "events";

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
export function recordDeliveryEvent(
  deps: Pick<Deps, Needs>,
): Operation<ProviderDeliveryEvent, RecordEventOutcome> {
  return async (
    ctx: AuthContext,
    event: ProviderDeliveryEvent,
  ): Promise<RecordEventOutcome> => {
    const outbound = await deps.outbound.findByProviderMessageId(ctx, event.providerMessageId);

    await deps.outbound.appendDeliveryEvent(ctx, {
      id: deps.ids.ulid(),
      outboundId: outbound?.id ?? null,
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
    if (event.recipient !== null && (event.type === "bounced" || event.type === "complained")) {
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

    if (outbound === null) {
      return { outcome: "unmatched" };
    }

    const applied = OutboundVO.applyDeliveryEvent(outbound, {
      type: event.type,
      occurredAt: event.occurredAt,
      detail: event.smtpResponse ?? null,
    });

    if (!applied.applied) {
      return { outcome: "recorded_only", reason: applied.reason };
    }

    await deps.outbound.update(ctx, applied.outbound);
    await deps.events.publish([
      {
        type: "outbound.status_changed",
        accountId: ctx.accountId,
        occurredAt: event.occurredAt,
        outboundId: applied.outbound.id,
        from: outbound.status,
        to: applied.outbound.status,
        deliveryEvent: event.type,
        recipient: event.recipient,
      },
    ]);

    return { outcome: "applied", from: outbound.status, to: applied.outbound.status };
  };
}
