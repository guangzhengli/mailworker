import { email } from "@web/workers/email";
import { app } from "@web/workers/http";
import { EVENTS_PATH, liveEvents } from "@web/workers/http/events";
import { queue } from "@web/workers/queue";
import { renderDashboard } from "@web/workers/render";
import { scheduled } from "@web/workers/scheduled";

/**
 * One Worker, four ways in.
 *
 * `fetch` serves the `/v1` API and the dashboard, `email` receives inbound mail
 * from Email Routing, `queue` dispatches sends and folds in delivery events,
 * and `scheduled` sweeps expired inboxes. One `wrangler deploy`, one URL, one
 * origin — which is what makes `mailworker deploy` a single command and the CLI
 * a single base URL rather than a service map.
 *
 * Nothing but wiring lives here. Each handler is a file next door, and none of
 * them decides anything: they translate a protocol into a service call.
 */
export default {
  /**
   * The split is on the path prefix, and it is the same split as the one in
   * `http/auth.ts`: `/v1` is the machine surface and takes a bearer token,
   * everything else is the dashboard and takes a session cookie. Routing them
   * apart here rather than mounting the dashboard inside Hono keeps that from
   * being a rule someone has to remember — the two never see each other's
   * requests.
   */
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/v1" || url.pathname.startsWith("/v1/")) {
      return app.fetch(request, env, ctx);
    }
    // The dashboard's live connection. Not a route inside React Router because a
    // 101 response carries its socket on the response init, which RR's handler
    // does not preserve — see `http/events.ts`.
    if (url.pathname === EVENTS_PATH) return liveEvents(request, env);
    return renderDashboard(request, env, ctx);
  },
  email,
  queue,
  scheduled,
} satisfies ExportedHandler<Env>;

export { MessageWaiter } from "@web/workers/waiter";
