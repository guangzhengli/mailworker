import { email } from "@web/workers/email";
import { app } from "@web/workers/http";
import { queue } from "@web/workers/queue";

/**
 * One Worker, three ways in (ADR-6).
 *
 * `fetch` serves the `/v1` API, `email` receives inbound mail from Email
 * Routing, `queue` dispatches sends and folds in delivery events. One
 * `wrangler deploy`, one URL, one origin — which is what makes
 * `mailworker deploy` a single command and the CLI a single base URL rather
 * than a service map.
 *
 * Nothing but wiring lives here. Each handler is a file next door, and none of
 * them decides anything: they translate a protocol into a service call.
 */
export default {
  fetch: app.fetch,
  email,
  queue,
} satisfies ExportedHandler<Env>;

export { MessageWaiter } from "@web/workers/waiter";
