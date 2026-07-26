import type { Deps } from "@core/application/index.ts";
import type { AuthContext, DomainRouting, Inbox, Scope } from "@core/domain/index.ts";
import { AccountId, Inbox as InboxVO } from "@core/domain/index.ts";
import {
  DeterministicIds,
  FakeClock,
  FakeHasher,
  InMemoryApiKeys,
  InMemoryBlobs,
  InMemoryDomains,
  InMemoryIdentities,
  InMemoryInboxes,
  InMemoryMessages,
  InMemoryOutbound,
  InMemorySuppressions,
  MemoryTransport,
  MemoryWaiter,
  RecordingEventBus,
  SimpleMimeBuilder,
  SimpleMimeParser,
} from "@core/testing/in-memory.ts";

export const TEST_DOMAIN = "mail.example.com";

export interface Harness {
  readonly deps: Deps;
  /** Default caller: full scopes, no bound identity. */
  readonly ctx: AuthContext;
  readonly clock: FakeClock;
  readonly ids: DeterministicIds;
  readonly inboxes: InMemoryInboxes;
  readonly messages: InMemoryMessages;
  readonly outbound: InMemoryOutbound;
  readonly identities: InMemoryIdentities;
  readonly domains: InMemoryDomains;
  readonly blobs: InMemoryBlobs;
  readonly suppressions: InMemorySuppressions;
  readonly transport: MemoryTransport;
  readonly events: RecordingEventBus;
  readonly waiter: MemoryWaiter;

  /** A context with a narrower scope set, for testing the gates. */
  withScopes(scopes: readonly Scope[]): AuthContext;
  /** A context bound to an agent identity. */
  asIdentity(identityId: string, scopes?: readonly Scope[]): AuthContext;
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
  const outbound = new InMemoryOutbound();
  const identities = new InMemoryIdentities();
  const apiKeys = new InMemoryApiKeys();
  const domains = new InMemoryDomains(options.routings ?? [DEFAULT_ROUTING]);
  const blobs = new InMemoryBlobs();
  const suppressions = new InMemorySuppressions();
  const transport = new MemoryTransport();
  const events = new RecordingEventBus();
  const waiter = new MemoryWaiter();

  const deps: Deps = {
    clock,
    ids,
    hasher: new FakeHasher(),
    inboxes,
    messages,
    outbound,
    identities,
    apiKeys,
    domains,
    blobs,
    suppressions,
    transport,
    events,
    waiter,
    mimeParser: new SimpleMimeParser(),
    mimeBuilder: new SimpleMimeBuilder(),
  };

  const baseCtx: AuthContext = {
    accountId: AccountId.DEFAULT,
    identityId: null,
    scopes: ["admin"],
    subject: "test",
  };

  return {
    deps,
    ctx: baseCtx,
    clock,
    ids,
    inboxes,
    messages,
    outbound,
    identities,
    domains,
    blobs,
    suppressions,
    transport,
    events,
    waiter,

    withScopes(scopes) {
      return { ...baseCtx, scopes: [...scopes] };
    },

    asIdentity(identityId, scopes) {
      return {
        ...baseCtx,
        identityId: identityId as AuthContext["identityId"],
        scopes: scopes === undefined ? baseCtx.scopes : [...scopes],
      };
    },

    async seedInbox(address, overrides = {}) {
      const now = clock.now();
      const kind = overrides.kind ?? "persistent";
      const inbox = InboxVO.create({
        id: ids.ulid(),
        accountId: baseCtx.accountId,
        address,
        kind,
        now,
        identityId: (overrides.identityId ?? null) as Inbox["identityId"],
        expiresAt:
          kind === "persistent"
            ? null
            : InboxVO.expiryFromTtl(now, overrides.ttlMs ?? 60 * 60 * 1000),
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
