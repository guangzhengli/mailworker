import type {
  AccountRepository,
  ApiKeyRepository,
  CoreDeps,
  DeliveryRepository,
  DomainRepository,
  IdentityRepository,
  Services,
} from "@mailworker/core";
import { AccountId, createServices, ProjectId } from "@mailworker/core";
import { PostalMimeParser, Rfc5322Builder } from "@mailworker/mime";
import type { QueuedDispatch, QueuedEvent } from "@web/workers/adapters";
import {
  CloudflareTransport,
  createDb,
  D1Accounts,
  D1ApiKeys,
  D1DashboardQueries,
  D1Deliveries,
  D1Domains,
  D1Identities,
  D1Inboxes,
  D1Labels,
  D1Messages,
  D1Notes,
  D1Suppressions,
  D1Webhooks,
  DohResolver,
  LateBoundLoopback,
  LoggingEventBus,
  ModeAwareTransport,
  QueueDispatch,
  R2Blobs,
  SandboxTransport,
  SigningWebhookSender,
  SystemClock,
  UlidGenerator,
  UnavailableDispatchQueue,
  UnconfiguredTransport,
  WebCryptoContentHasher,
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
  /** Cross-aggregate, read-only projections used only by the human control plane. */
  readonly dashboard: D1DashboardQueries;
  /**
   * Not part of `CoreDeps`: authentication happens before there is a `Caller` to
   * pass, so it cannot go through a service that requires one.
   */
  readonly apiKeys: ApiKeyRepository;
  /** Capability discovery reads only the identity bound to the authenticated key. */
  readonly identities: IdentityRepository;
  readonly accounts: AccountRepository;
  /** Also outside `CoreDeps`: inbound mail resolves its environment by hostname. */
  readonly domains: DomainRepository;
  readonly deliveries: DeliveryRepository;
  /** The environment a request lands in when nothing names another. */
  readonly defaultAccountId: AccountId;
  readonly projectId: ProjectId;
}

export function createContainer(env: Env): Container {
  const db = createDb(env.DB);
  const blobs = new R2Blobs(env.BLOBS);
  const ids = new UlidGenerator();
  const labels = new D1Labels(db, ids);
  const messages = new D1Messages(db, blobs, labels);
  const apiKeys = new D1ApiKeys(db);
  const accounts = new D1Accounts(db);
  const identities = new D1Identities(db);

  // `wrangler types` marks every declared binding as present, which is true of
  // a deployment and false of the test environment, where neither is bound.
  // Widening here rather than casting at the use site keeps the optionality
  // stated once, in the place that knows why.
  const sendEmail: SendEmail | undefined = env.SEND_EMAIL;
  const dispatch: Queue<QueuedDispatch> | undefined = env.DISPATCH_QUEUE;
  const webhookQueue: Queue<QueuedEvent> | undefined = env.WEBHOOK_QUEUE;

  const domainRepo = new D1Domains(db);
  const deliveryRepo = new D1Deliveries(db);
  const loopback = new LateBoundLoopback();

  const deps: CoreDeps = {
    clock: new SystemClock(),
    ids,
    contentHasher: new WebCryptoContentHasher(),
    secrets: new WebCryptoSecrets(),

    inboxes: new D1Inboxes(db),
    messages,
    labels,
    notes: new D1Notes(db),
    deliveries: deliveryRepo,
    identities,
    domains: domainRepo,
    webhooks: new D1Webhooks(db),
    apiKeys,
    accounts,
    suppressions: new D1Suppressions(db),
    blobs,

    dns: new DohResolver(),
    webhookSender: new SigningWebhookSender(),
    events: new LoggingEventBus(webhookQueue),
    waiter: new DurableWaiter(env.WAITER, messages),
    mimeParser: new PostalMimeParser(),
    mimeBuilder: new Rfc5322Builder(),

    loopback,

    // Both optional, and for the same reason: Email Routing is free while
    // Email Sending needs Workers Paid, so "can receive, cannot send" is a real
    // deployment rather than a broken one. Each missing binding degrades one
    // capability with an explanation instead of failing the whole Worker at
    // startup, where nobody would see it.
    //
    // A sandbox environment needs neither: it reaches `SandboxTransport`, which
    // is why development works on a Free plan with no verified domain.
    transport: new ModeAwareTransport(
      sendEmail === undefined
        ? new UnconfiguredTransport()
        : new CloudflareTransport(sendEmail),
      new SandboxTransport(),
    ),
    dispatchQueue:
      dispatch === undefined ? new UnavailableDispatchQueue() : new QueueDispatch(dispatch),
  };

  const services = createServices(deps);
  loopback.bind(async (ctx, message) => {
    await services.ingestion.ingest(ctx, {
      recipient: message.recipient,
      envelopeFrom: message.envelopeFrom,
      raw: message.raw,
      origin: "sandbox",
    });
  });

  return {
    services,
    dashboard: new D1DashboardQueries(db),
    apiKeys,
    identities,
    accounts,
    domains: domainRepo,
    deliveries: deliveryRepo,
    defaultAccountId: AccountId.parse(env.MAILWORKER_ACCOUNT_ID),
    projectId: ProjectId.parse(env.MAILWORKER_PROJECT_ID ?? "default"),
  };
}
