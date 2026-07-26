import { createContainer } from "@web/workers/container";
import { authenticate } from "@web/workers/http/auth";
import type { HttpEnv } from "@web/workers/http/env";
import { failure, onError } from "@web/workers/http/errors";
import { inboxes } from "@web/workers/http/inboxes";
import { ingest, messages, threads } from "@web/workers/http/messages";
import { Hono } from "hono";

/**
 * The `/v1` API — one origin for the CLI, the SDK and the dashboard alike.
 *
 * Two middlewares and a mount table, which is as much as this file should ever
 * be. The routers under it are thin by rule (parse, call a service, map a DTO),
 * and everything that decides anything lives in `@mailworker/core` where it can
 * be tested in milliseconds without workerd.
 */
export const app = new Hono<HttpEnv>()
  .onError(onError)

  .notFound((c) => failure(c, "not_found", `No route for ${c.req.method} ${c.req.path}.`))

  /**
   * Health is deliberately outside `/v1` and outside authentication: it answers
   * "is this Worker up", which an uptime check has to be able to ask without
   * holding a credential. It says nothing about the database on purpose — a
   * health check that queries D1 turns a slow database into an outage.
   */
  .get("/v1/health", (c) => c.json({ status: "ok" }))

  /**
   * Built once per request and shared by every handler.
   *
   * Adapters are cheap here — a drizzle client over a binding — and building
   * them per request rather than caching them in a module global is what keeps
   * one request's `Caller` from ever being visible to another's.
   */
  .use("/v1/*", async (c, next) => {
    const container = createContainer(c.env);
    c.set("container", container);
    c.set("services", container.services);
    await next();
  })

  .use("/v1/*", async (c, next) => {
    const caller = await authenticate(
      c.var.container,
      c.env,
      c.req.header("Authorization"),
      new Date(),
    );
    c.set("caller", caller);
    await next();
  })

  .route("/v1/inboxes", inboxes)
  .route("/v1/messages", messages)
  .route("/v1/threads", threads)
  .route("/v1/ingest", ingest);
