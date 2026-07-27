import * as build from "virtual:react-router/server-build";
import { workerContext } from "@web/app/context";
import { createContainer } from "@web/workers/container";
import { createRequestHandler, RouterContextProvider, type ServerBuild } from "react-router";

/**
 * The dashboard half of `fetch`: React Router's server build, given the same
 * container the API uses.
 *
 * It lives in its own file for one reason, and the reason is the test suite.
 * `virtual:react-router/server-build` only exists once Vite has run React
 * Router's plugin, and `apps/web`'s Vitest suite deliberately does not — it
 * boots `entry.ts` inside workerd to exercise `/v1`, `email()` and a real
 * Durable Object, and building the client bundle to do that would cost seconds
 * per run and prove nothing. Isolating the virtual import here is what lets
 * that suite stub exactly one module (see `vitest.config.ts`) instead of
 * pretending to have a dashboard.
 *
 * The container is built here, per request, and handed to the loaders through
 * context — so a loader calls `services.mailbox.listMessages(caller, …)`
 * directly rather than making an HTTP call to its own Worker. That is not just
 * a saved round trip: it means the dashboard's credential never has to be
 * something `/v1` accepts, which is what keeps cookies off the API entirely.
 */
/**
 * The cast is `exactOptionalPropertyTypes` and nothing else: React Router's
 * generated declaration re-exports each field as `ServerBuild["x"]`, which turns
 * every optional property into a required one whose type includes `undefined` —
 * a shape that flag rejects. The values are the ones `ServerBuild` describes.
 */
const handler = createRequestHandler(
  build as unknown as ServerBuild,
  import.meta.env?.MODE ?? "production",
);

export function renderDashboard(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const context = new RouterContextProvider();
  context.set(workerContext, { env, ctx, container: createContainer(env) });
  return handler(request, context);
}
