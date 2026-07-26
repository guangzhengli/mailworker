import type { AuthContext } from "@/domain/index.ts";
import type {
  ApiKeyRepositoryPort,
  BlobStorePort,
  ClockPort,
  DomainRepositoryPort,
  EventBusPort,
  IdentityRepositoryPort,
  IdGeneratorPort,
  InboxRepositoryPort,
  MailTransportPort,
  MessageRepositoryPort,
  MimeBuilderPort,
  MimeParserPort,
  OutboundRepositoryPort,
  SuppressionListPort,
  TokenHasherPort,
  WaiterPort,
} from "@/ports/index.ts";

/**
 * Everything a use case might need. Each one declares the subset it actually
 * uses via `Pick<Deps, …>`, so its signature documents its reach and a test only
 * has to supply what it touches.
 */
export interface Deps {
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly hasher: TokenHasherPort;
  readonly inboxes: InboxRepositoryPort;
  readonly messages: MessageRepositoryPort;
  readonly outbound: OutboundRepositoryPort;
  readonly identities: IdentityRepositoryPort;
  readonly apiKeys: ApiKeyRepositoryPort;
  readonly domains: DomainRepositoryPort;
  readonly blobs: BlobStorePort;
  readonly suppressions: SuppressionListPort;
  readonly transport: MailTransportPort;
  readonly events: EventBusPort;
  readonly waiter: WaiterPort;
  readonly mimeParser: MimeParserPort;
  readonly mimeBuilder: MimeBuilderPort;
}

/**
 * A use case is a factory: dependencies in, an operation out. Callers wire it
 * once at startup; the returned function takes the request-scoped AuthContext.
 */
export type Operation<In, Out> = (ctx: AuthContext, input: In) => Promise<Out>;
