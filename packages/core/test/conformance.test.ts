import { runRepositoryConformance } from "@core/testing/conformance";
import {
  InMemoryApiKeys,
  InMemoryBlobs,
  InMemoryDeliveries,
  InMemoryIdentities,
  InMemoryInboxes,
  InMemoryMessages,
  InMemorySuppressions,
} from "@core/testing/in-memory";

/**
 * The in-memory adapters, held to the same behaviour as the real ones.
 *
 * `apps/web/test/conformance.test.ts` runs this identical suite against D1
 * inside workerd. That pairing is what earns the in-memory adapters their keep:
 * without it they are a convenient fiction, and every fast test that passes here
 * proves only that the fiction is self-consistent.
 */
runRepositoryConformance("in-memory", () => {
  const inboxes = new InMemoryInboxes();
  const messages = new InMemoryMessages(inboxes);
  return {
    inboxes,
    messages,
    labels: messages.labels,
    notes: messages.notes,
    deliveries: new InMemoryDeliveries(),
    identities: new InMemoryIdentities(),
    apiKeys: new InMemoryApiKeys(),
    suppressions: new InMemorySuppressions(),
    blobs: new InMemoryBlobs(),
  };
});
