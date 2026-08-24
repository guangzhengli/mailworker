import { DEFAULT_SWEEP_LIMIT } from "@mailworker/core";
import { createContainer } from "@web/workers/container";
import { everyEnvironment, systemCaller } from "@web/workers/environment";

/**
 * Cron: erase expired inboxes and repair D1-to-Queues hand-offs.
 *
 * This is the only caller of `mailbox.sweepExpired`, and the only thing in the
 * deployment that ever deletes an expired inbox. Everything else treats expiry
 * as a read-only state — which is the right behaviour for a caller, and the
 * reason the missing sweep was invisible: the product kept working exactly as
 * documented while the storage bill grew.
 *
 * Nothing decides anything here. The schedule is in `wrangler.jsonc`, the
 * retention rule is `RetentionPolicy`, and this translates one into the other.
 */
export async function scheduled(
  event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const container = createContainer(env);

  // Every environment, not just the default one: a development environment
  // accumulates ephemeral inboxes faster than production does, and a sweep that
  // silently skipped it would grow the bill in the place nobody looks at.
  ctx.waitUntil(maintainAll(container, event.cron, new Date(event.scheduledTime)));
}

async function maintainAll(
  container: ReturnType<typeof createContainer>,
  cron: string,
  scheduledAt: Date,
): Promise<void> {
  for (const accountId of await everyEnvironment(container)) {
    // A distinct subject from `system:email` and `system:queue`: when a message
    // is gone, the audit trail has to say which of the three erased it.
    const caller = await systemCaller(container, accountId, "system:cron");
    const dispatch = await container.services.delivery.reconcileDispatchOutbox(caller);

    // Reconciliation wants five-minute latency; retention does not. Run the
    // storage sweep only at the top of the hour so empty environments do not
    // pay for twelve identical D1/R2 scans and log lines.
    if (scheduledAt.getUTCMinutes() === 0) {
      const result = await container.services.mailbox.sweepExpired(caller);
      console.log(
        JSON.stringify({
          event: "retention.sweep",
          cron,
          accountId,
          ...result,
          // A full page means the sweep hit its cap and there is more waiting.
          backlogRemaining: result.examined >= DEFAULT_SWEEP_LIMIT,
        }),
      );
    }
    console.log(
      JSON.stringify({
        event: "dispatch.reconcile",
        cron,
        accountId,
        ...dispatch,
      }),
    );
  }
}
