import type { CoreDeps, Services } from "@core/application";
import { createServices } from "@core/application";
import type { Caller, DomainRouting, Scope } from "@core/domain";
import { AccountId, Inbox } from "@core/domain";
import {
  DeterministicIds,
  FakeClock,
  FakeSecrets,
  InMemoryApiKeys,
  InMemoryBlobs,
  InMemoryDeliveries,
  InMemoryDomains,
  InMemoryIdentities,
  InMemoryInboxes,
  InMemoryMessages,
  InMemorySuppressions,
  InMemoryWebhooks,
  MemoryDispatchQueue,
  MemoryTransport,
  MemoryWaiter,
  RecordingEventBus,
  RecordingWebhookSender,
  SimpleMimeBuilder,
  SimpleMimeParser,
  StaticDns,
} from "@core/testing/in-memory";

export const TEST_DOMAIN = "mail.example.com";

export interface Harness {
  readonly deps: CoreDeps;
  /** The three services, wired to the in-memory adapters. */
  readonly services: Services;
  /** Default caller: full scopes, no bound identity. */
  readonly ctx: Caller;
  readonly clock: FakeClock;
  readonly ids: DeterministicIds;
  readonly inboxes: InMemoryInboxes;
  readonly messages: InMemoryMessages;
  readonly deliveries: InMemoryDeliveries;
  readonly identities: InMemoryIdentities;
  readonly apiKeys: InMemoryApiKeys;
  readonly domains: InMemoryDomains;
  readonly blobs: InMemoryBlobs;
  readonly suppressions: InMemorySuppressions;
  readonly transport: MemoryTransport;
  readonly dispatchQueue: MemoryDispatchQueue;
  readonly dns: StaticDns;
  readonly webhooks: InMemoryWebhooks;
  readonly webhookSender: RecordingWebhookSender;
  readonly events: RecordingEventBus;
  readonly waiter: MemoryWaiter;
  /** Records the specs it was handed; see `SimpleMimeBuilder`. */
  readonly mimeBuilder: SimpleMimeBuilder;

  /** A context with a narrower scope set, for testing the gates. */
  withScopes(scopes: readonly Scope[]): Caller;
  /** A context bound to an agent identity. */
  asIdentity(identityId: string, scopes?: readonly Scope[]): Caller;
  /** Insert an inbox directly, bypassing the use case. */
  seedInbox(address: string, overrides?: Partial<SeedInboxOptions>): Promise<Inbox>;
}

export interface SeedInboxOptions {
  readonly kind: "ephemeral" | "persistent";
  readonly ttlMs: number | null;
  readonly identityId: string | null;
}

export interface HarnessOptions {
  readonly now?: Date;
  readonly routings?: DomainRouting[];
}

export const DEFAULT_ROUTING: DomainRouting = {
  domain: TEST_DOMAIN,
  catchAllMode: "reject",
  catchAllInboxId: null,
  autocreatePattern: null,
  sendingStatus: "verified",
  dkimSelector: null,
};

/**
 * Wires every port to its in-memory adapter.
 *
 * Tests take what they need off the returned object — `harness.transport.sent` to
 * see what left, `harness.events.published` to see what the system decided — so
 * assertions can be about behaviour rather than about rows.
 */
export function createHarness(options: HarnessOptions = {}): Harness {
  const clock = options.now === undefined ? new FakeClock() : new FakeClock(options.now);
  const ids = new DeterministicIds();
  const inboxes = new InMemoryInboxes();
  const messages = new InMemoryMessages();
  const deliveries = new InMemoryDeliveries();
  const identities = new InMemoryIdentities();
  const apiKeys = new InMemoryApiKeys();
  const domains = new InMemoryDomains(options.routings ?? [DEFAULT_ROUTING]);
  const blobs = new InMemoryBlobs();
  const suppressions = new InMemorySuppressions();
  const transport = new MemoryTransport();
  const dispatchQueue = new MemoryDispatchQueue();
  const dns = new StaticDns();
  const webhooks = new InMemoryWebhooks();
  const webhookSender = new RecordingWebhookSender();
  const events = new RecordingEventBus();
  const waiter = new MemoryWaiter();
  const mimeBuilder = new SimpleMimeBuilder();

  const deps: CoreDeps = {
    clock,
    ids,
    secrets: new FakeSecrets(),
    inboxes,
    messages,
    deliveries,
    identities,
    apiKeys,
    domains,
    blobs,
    suppressions,
    transport,
    dispatchQueue,
    dns,
    webhooks,
    webhookSender,
    events,
    waiter,
    mimeParser: new SimpleMimeParser(),
    mimeBuilder,
  };

  const baseCtx: Caller = {
    accountId: AccountId.DEFAULT,
    identityId: null,
    scopes: ["admin"],
    subject: "test",
  };

  return {
    deps,
    services: createServices(deps),
    ctx: baseCtx,
    clock,
    ids,
    inboxes,
    messages,
    deliveries,
    identities,
    apiKeys,
    domains,
    blobs,
    suppressions,
    transport,
    dispatchQueue,
    dns,
    webhooks,
    webhookSender,
    events,
    waiter,
    mimeBuilder,

    withScopes(scopes) {
      return { ...baseCtx, scopes: [...scopes] };
    },

    asIdentity(identityId, scopes) {
      return {
        ...baseCtx,
        identityId: identityId as Caller["identityId"],
        scopes: scopes === undefined ? baseCtx.scopes : [...scopes],
      };
    },

    async seedInbox(address, overrides = {}) {
      const now = clock.now();
      const kind = overrides.kind ?? "persistent";
      const inbox = Inbox.create({
        id: ids.ulid(),
        accountId: baseCtx.accountId,
        address,
        kind,
        now,
        identityId: (overrides.identityId ?? null) as Inbox["identityId"],
        expiresAt:
          kind === "persistent"
            ? null
            : Inbox.expiryFromTtl(now, overrides.ttlMs ?? 60 * 60 * 1000),
      });
      await inboxes.insert(baseCtx, inbox);
      return inbox;
    },
  };
}

/** Build a single-part RFC 5322 message. The `inject` fixture format. */
export function rawEmail(fields: {
  from: string;
  to: string;
  subject?: string;
  body?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: readonly string[];
  authResults?: string;
  autoSubmitted?: string;
  date?: Date;
}): Uint8Array {
  const lines = [
    `From: ${fields.from}`,
    `To: ${fields.to}`,
    `Subject: ${fields.subject ?? ""}`,
    `Message-ID: <${fields.messageId ?? "generated@example.com"}>`,
    `Date: ${(fields.date ?? new Date("2026-07-01T12:00:00Z")).toUTCString()}`,
    ...(fields.inReplyTo === undefined ? [] : [`In-Reply-To: <${fields.inReplyTo}>`]),
    ...(fields.references === undefined
      ? []
      : [`References: ${fields.references.map((id) => `<${id}>`).join(" ")}`]),
    ...(fields.authResults === undefined
      ? []
      : [`Authentication-Results: ${fields.authResults}`]),
    ...(fields.autoSubmitted === undefined ? [] : [`Auto-Submitted: ${fields.autoSubmitted}`]),
    "",
    fields.body ?? "Hello.",
  ];
  return new TextEncoder().encode(lines.join("\r\n"));
}
