import type { DiagnosticsDto } from "@mailworker/contract";
import type { AccountId } from "@mailworker/core";
import { createContainer } from "@web/workers/container";
import { labels, notes } from "@web/workers/http/annotations";
import { authenticate } from "@web/workers/http/auth";
import { capabilities } from "@web/workers/http/capabilities";
import type { HttpEnv } from "@web/workers/http/env";
import { failure, onError } from "@web/workers/http/errors";
import { environments, identities, keys, webhooks } from "@web/workers/http/identity";
import { inboxes } from "@web/workers/http/inboxes";
import { ingest, messages, threads } from "@web/workers/http/messages";
import { send, suppressions } from "@web/workers/http/send";
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
    // The header only names a target; `authenticate` is what refuses it unless
    // the credential is `admin` and the environment shares its project. An agent
    // key stays pinned to the environment it was minted in.
    const target = c.req.header("X-Mailworker-Environment");
    const caller = await authenticate(
      c.var.container,
      c.env,
      c.req.header("Authorization"),
      new Date(),
      target === undefined ? undefined : (target as AccountId),
    );
    c.set("caller", caller);
    await next();
  })

  .route("/v1/environments", environments)
  .route("/v1/capabilities", capabilities)
  .route("/v1/inboxes", inboxes)
  .route("/v1/messages", messages)
  .route("/v1/threads", threads)
  .route("/v1/labels", labels)
  .route("/v1/notes", notes)
  .route("/v1/ingest", ingest)
  .route("/v1/send", send)
  .route("/v1/suppressions", suppressions)
  .route("/v1/identities", identities)
  .route("/v1/keys", keys)
  .route("/v1/webhooks", webhooks)

  /**
   * The backend for `mailworker doctor`.
   *
   * Everything it reports fails silently in production — mail that lands in
   * spam because DMARC is missing, an inbox that receives nothing because MX
   * points at the old host, a send that works against your own address and
   * fails against a customer because the domain is not verified yet. A system
   * whose failures are silent needs somewhere to ask, and none of the reference
   * projects has one.
   */
  .get("/v1/diagnostics", async (c) => {
    const domains = await c.var.services.delivery.diagnose(c.var.caller);
    const body: DiagnosticsDto = {
      domains: domains.map((diagnosis) => ({
        domain: diagnosis.domain,
        status: diagnosis.status,
        checks: diagnosis.checks.map((check) => ({
          name: check.name,
          status: check.status,
          detail: check.detail,
          ...(check.fix === undefined ? {} : { fix: check.fix }),
        })),
      })),
      // Read off the bindings rather than off a config file, because the
      // question is "what does this Worker actually have", and a file can say
      // otherwise.
      deployment: {
        sendingConfigured: c.env.SEND_EMAIL !== undefined,
        dispatchQueueConfigured: c.env.DISPATCH_QUEUE !== undefined,
      },
    };
    return c.json(body);
  });
