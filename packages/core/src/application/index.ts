import { createDeliveryService, type DeliveryDeps } from "@core/application/delivery-service";
import { createIdentityService, type IdentityDeps } from "@core/application/identity-service";
import {
  createIngestionService,
  type IngestionDeps,
} from "@core/application/ingestion-service";
import { createMailboxService, type MailboxDeps } from "@core/application/mailbox-service";

export * from "@core/application/delivery-service";
export * from "@core/application/identity-service";
export * from "@core/application/ingestion-service";
export * from "@core/application/mailbox-service";

/**
 * Everything the application needs from the outside world.
 *
 * Derived by intersection rather than hand-written: each service declares the
 * ports it actually uses, and this is just their union. A god interface that
 * every use case picks a subset out of drifts the moment someone adds a
 * dependency and forgets to narrow the pick.
 */
export interface CoreDeps extends MailboxDeps, IngestionDeps, DeliveryDeps, IdentityDeps {}

/**
 * The whole application surface: one service per bounded context.
 *
 * This is the map. An adapter wires it once at startup and then talks to
 * `services.delivery.send(...)` — the noun is the domain, the verb is the
 * operation, and there is no fourth thing to learn.
 *
 * Four contexts, four services. `identity` is what makes the other three safe
 * to hand to an agent: without it there is one credential with every scope.
 */
export function createServices(deps: CoreDeps) {
  return {
    identity: createIdentityService(deps),
    mailbox: createMailboxService(deps),
    ingestion: createIngestionService(deps),
    delivery: createDeliveryService(deps),
  };
}

export type Services = ReturnType<typeof createServices>;
