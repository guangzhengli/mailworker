import type { AccountId, Caller } from "@mailworker/core";
import { Caller as CallerRules } from "@mailworker/core";
import type { Container } from "@web/workers/container";

/**
 * A system `Caller` for one environment.
 *
 * The handlers that have no credential to authenticate — inbound mail, the queue
 * consumers, the cron sweep — still have to act on exactly one environment, and
 * the account's `mode` is what decides whether their sends leave the building.
 * A deployment that has not run the environment migration resolves to live
 * production defaults rather than refusing to process mail.
 */
export async function systemCaller(
  container: Container,
  accountId: AccountId,
  subject: `system:${string}`,
): Promise<Caller> {
  const account = await container.accounts.findById(accountId);
  return CallerRules.system({
    accountId,
    projectId: account?.projectId ?? container.projectId,
    mode: account?.mode ?? "live",
    subject,
  });
}

export async function everyEnvironment(container: Container): Promise<AccountId[]> {
  const accounts = await container.accounts.listByProject(container.projectId);
  return accounts.length === 0 ? [container.defaultAccountId] : accounts.map((a) => a.id);
}
