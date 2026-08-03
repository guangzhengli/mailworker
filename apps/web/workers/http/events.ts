import { Caller } from "@mailworker/core";
import { createContainer } from "@web/workers/container";
import { callerForRequest } from "@web/workers/http/session";
import { waiterFor } from "@web/workers/waiter";

/**
 * The dashboard's live connection: a WebSocket that says "mail arrived".
 *
 * It sits beside the API and the dashboard in `entry.ts` rather than inside
 * either, and both exclusions have a reason:
 *
 *   - **Not a React Router route.** A 101 response carries a `webSocket` on its
 *     init, which is a Cloudflare extension to `Response`; React Router's
 *     handler builds its own response around what a loader returns, and the
 *     socket does not survive that. There is no version of this that is a
 *     `loader`.
 *   - **Not under `/v1`.** A browser cannot set an `Authorization` header on a
 *     `new WebSocket()`, so the only credential available is the cookie — and
 *     `/v1` reading a cookie is exactly the property `test/session.test.ts`
 *     exists to prevent. Keeping this on the dashboard side is what lets that
 *     rule stay absolute.
 */

export const EVENTS_PATH = "/events";

export async function liveEvents(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade.", { status: 426 });
  }

  /**
   * WebSockets are not subject to CORS: a page on any origin may open one to
   * here and read every byte that comes back. `SameSite=Lax` already stops the
   * session cookie from riding along on that request, so this is the second
   * lock rather than the first — but it is the one that keeps working if the
   * cookie policy is ever loosened, and it is three lines.
   *
   * A missing `Origin` is allowed: a browser always sends one on a handshake, so
   * the header's absence means the caller is not a browser and no cookie was
   * attached on its behalf. Refusing it would only break `wscat`.
   */
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    return new Response("Cross-origin WebSocket refused.", { status: 403 });
  }

  const container = createContainer(env);
  const caller = await callerForRequest(container, env, request, new Date());
  /**
   * A status, not the redirect a page would get. A WebSocket client cannot
   * follow a redirect to a login form — it would see the handshake fail with no
   * explanation — so the code has to be the explanation.
   */
  if (caller === null) return new Response("Not signed in.", { status: 401 });
  if (!Caller.has(caller, "message:read")) {
    return new Response("This credential cannot read messages.", { status: 403 });
  }

  const url = new URL(request.url);
  const inbox = url.searchParams.get("inbox");
  const forwarded = new URL("https://waiter.internal/");
  if (inbox !== null) forwarded.searchParams.set("inbox", inbox);

  return await waiterFor(env.WAITER, caller.accountId).fetch(
    new Request(forwarded, { headers: request.headers }),
  );
}
