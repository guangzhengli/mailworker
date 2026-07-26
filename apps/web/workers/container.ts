import type { ApiKeyRepository, CoreDeps, Services } from "@mailworker/core";
import { AccountId, createServices } from "@mailworker/core";
import { PostalMimeParser, Rfc5322Builder } from "@mailworker/mime";
import type { QueuedEvent } from "@web/workers/adapters";
import {
  CloudflareTransport,
  createDb,
  D1ApiKeys,
  D1Deliveries,
  D1Domains,
  D1Identities,
  D1Inboxes,
  D1Messages,
  D1Suppressions,
  D1Webhooks,
  DohResolver,
  LoggingEventBus,
  QueueDispatch,
  R2Blobs,
  SigningWebhookSender,
  SystemClock,
  UlidGenerator,
  UnavailableDispatchQueue,
  UnconfiguredTransport,
  WebCryptoSecrets,
} from "@web/workers/adapters";
import { DurableWaiter } from "@web/workers/waiter";

/**
 * The composition root: the one place that knows both what a port is and which
 * Cloudflare service implements it.
 *
 * Everything above this line takes its dependencies as arguments, which is what
 * lets the entire domain and application be tested without workerd. Everything
 * below it is a binding. Keeping the seam to a single file means "what does
 * this deployment consist of" is a page of reading rather than a search.
 *
 * Built per request rather than cached in a module global. The adapters are
 * cheap — a drizzle client over a binding, three classes with no state — and a
 * module-level cache in a Worker is shared across every request an isolate
 * serves, which is precisely the shape that leaks one caller's data into
 * another's response the day someone stores a `Caller` on an adapter.
 */
export interface Container {
  readonly services: Services;
  /**
   * Not part of `CoreDeps`: authentication happens before there is a `Caller`
   * to pass, so it cannot go through a service that requires one. The HTTP
   * layer uses this to turn a bearer token into a `Caller`, and M3's
   * identity-service takes over key management itself.
   */
  readonly apiKeys: ApiKeyRepository;
  /**
   * The account this deployment serves. Single-tenant today (DESIGN §6): it
   * comes from a var so that the multi-tenant migration changes where a
   * `Caller` is built and nothing else.
   */
  readonly accountId: AccountId;
}

export function createContainer(env: Env): Container {
  const db = createDb(env.DB);
  const messages = new D1Messages(db);
  const apiKeys = new D1ApiKeys(db);

  // `wrangler types` marks every declared binding as present, which is true of
  // a deployment and false of the test environment, where neither is bound.
  // Widening here rather than casting at the use site keeps the optionality
  // stated once, in the place that knows why.
  const sendEmail: SendEmail | undefined = env.SEND_EMAIL;
  const dispatch: Queue<string> | undefined = env.DISPATCH_QUEUE;
  const webhookQueue: Queue<QueuedEvent> | undefined = env.WEBHOOK_QUEUE;

  const deps: CoreDeps = {
    clock: new SystemClock(),
    ids: new UlidGenerator(),
    secrets: new WebCryptoSecrets(),

    inboxes: new D1Inboxes(db),
    messages,
    deliveries: new D1Deliveries(db),
    identities: new D1Identities(db),
    domains: new D1Domains(db),
    webhooks: new D1Webhooks(db),
    apiKeys,
    suppressions: new D1Suppressions(db),
    blobs: new R2Blobs(env.BLOBS),

    dns: new DohResolver(),
    webhookSender: new SigningWebhookSender(),
    events: new LoggingEventBus(webhookQueue),
    waiter: new DurableWaiter(env.WAITER, messages),
    mimeParser: new PostalMimeParser(),
    mimeBuilder: new Rfc5322Builder(),

    // Both optional, and for the same reason: Email Routing is free while
    // Email Sending needs Workers Paid, so "can receive, cannot send" is a real
    // deployment rather than a broken one. Each missing binding degrades one
    // capability with an explanation instead of failing the whole Worker at
    // startup, where nobody would see it.
    transport:
      sendEmail === undefined
        ? new UnconfiguredTransport()
        : new CloudflareTransport(sendEmail),
    dispatchQueue:
      dispatch === undefined ? new UnavailableDispatchQueue() : new QueueDispatch(dispatch),
  };

  return {
    services: createServices(deps),
    apiKeys,
    accountId: AccountId.parse(env.MAILWORKER_ACCOUNT_ID),
  };
}
