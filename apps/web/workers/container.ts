import type { ApiKeyRepository, CoreDeps, Services } from "@mailworker/core";
import { AccountId, createServices } from "@mailworker/core";
import { PostalMimeParser, Rfc5322Builder } from "@mailworker/mime";
import {
  createDb,
  D1ApiKeys,
  D1Deliveries,
  D1Domains,
  D1Identities,
  D1Inboxes,
  D1Messages,
  D1Suppressions,
  LoggingEventBus,
  R2Blobs,
  SystemClock,
  UlidGenerator,
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

  const deps: CoreDeps = {
    clock: new SystemClock(),
    ids: new UlidGenerator(),
    secrets: new WebCryptoSecrets(),

    inboxes: new D1Inboxes(db),
    messages,
    deliveries: new D1Deliveries(db),
    identities: new D1Identities(db),
    domains: new D1Domains(db),
    suppressions: new D1Suppressions(db),
    blobs: new R2Blobs(env.BLOBS),

    events: new LoggingEventBus(),
    waiter: new DurableWaiter(env.WAITER, messages),
    mimeParser: new PostalMimeParser(),
    mimeBuilder: new Rfc5322Builder(),
    transport: new UnconfiguredTransport(),
  };

  return {
    services: createServices(deps),
    apiKeys: new D1ApiKeys(db),
    accountId: AccountId.parse(env.MAILWORKER_ACCOUNT_ID),
  };
}
