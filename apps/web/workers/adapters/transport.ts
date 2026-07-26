import type { Caller, DispatchRequest, DispatchResult, MailTransport } from "@mailworker/core";

/**
 * The transport for a deployment that cannot send.
 *
 * Not a placeholder for M2 so much as a real state: Email Routing is free and
 * works on the Free plan, so a deployment can receive mail perfectly well while
 * having no `send_email` binding at all — no Workers Paid subscription, or no
 * verified sending domain yet. Receiving is the half of the product that works
 * without a credit card, and it should not be held hostage by the half that
 * does not.
 *
 * It answers `ok: false` rather than throwing, because that is what the
 * `Delivery` state machine is for: the attempt is recorded, moved to a terminal
 * failed state, and shows up in `mailworker status` with a reason a human can
 * act on. A thrown error inside a Queues consumer would be retried forever
 * instead, against a configuration that no retry can change — hence
 * `retryable: false`.
 *
 * M2 replaces this with the binding-backed transport.
 */
export class UnconfiguredTransport implements MailTransport {
  async dispatch(_ctx: Caller, _message: DispatchRequest): Promise<DispatchResult> {
    return {
      ok: false,
      error:
        "This deployment has no sending binding configured. Sending needs Workers Paid " +
        "and a verified domain — run `mailworker doctor` to see what is missing.",
      retryable: false,
    };
  }
}
