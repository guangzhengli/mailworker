import { DEFAULT_SWEEP_LIMIT } from "@mailworker/core";
import { createContainer } from "@web/workers/container";
import { everyEnvironment, systemCaller } from "@web/workers/environment";

/**
 * Cron. Currently one job: erase inboxes whose grace period has run out.
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
  ctx.waitUntil(sweepAll(container, event.cron));
}

async function sweepAll(
  container: ReturnType<typeof createContainer>,
  cron: string,
): Promise<void> {
  for (const accountId of await everyEnvironment(container)) {
    // A distinct subject from `system:email` and `system:queue`: when a message
    // is gone, the audit trail has to say which of the three erased it.
    const caller = await systemCaller(container, accountId, "system:cron");
    const result = await container.services.mailbox.sweepExpired(caller);

    // One line per environment per run, always — including the zero case. A
    // sweep that has stopped running and a sweep with nothing to do produce
    // identical storage graphs, and this is the only thing that tells them apart.
    console.log(
      JSON.stringify({
        event: "retention.sweep",
        cron,
        accountId,
        ...result,
        // A full page means the sweep hit its cap and there is more waiting. The
        // next cron picks it up rather than this run looping: draining an
        // unbounded backlog in one invocation is how you hit the CPU limit and
        // commit nothing.
        backlogRemaining: result.examined >= DEFAULT_SWEEP_LIMIT,
      }),
    );
  }
}
