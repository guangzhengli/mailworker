import { env } from "cloudflare:test";
import { DomainError } from "@mailworker/core";
import { page } from "@web/app/auth";
import { workerContext } from "@web/app/context";
import { createContainer } from "@web/workers/container";
import { seal } from "@web/workers/http/session";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

/**
 * `page` — the wrapper every dashboard loader and action runs inside.
 *
 * Tested directly rather than through a rendered route, because the dashboard's
 * client build is deliberately not produced in this suite (see
 * `vitest.config.ts`). That costs nothing here: the two things worth pinning
 * down are both about what `page` does with a throw, and neither involves React.
 *
 * The second one is a regression guard with a specific history. React Router
 * catches a loader's rejection and renders the error boundary itself, so a
 * `try` further out — root middleware included — never sees the error and
 * cannot set the status. Every domain failure therefore surfaced as a 500 with
 * the right sentence under the wrong number: `invalid_ulid` and
 * `message_not_found` both looked like the server had fallen over.
 */

const ADMIN_KEY = "test-bootstrap-key";

async function contextFor(): Promise<RouterContextProvider> {
  const context = new RouterContextProvider();
  context.set(workerContext, {
    env,
    ctx: { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    container: createContainer(env),
  });
  return context;
}

async function signedIn(path = "/"): Promise<Request> {
  const sealed = await seal(env, ADMIN_KEY, new Date());
  return new Request(`https://mailworker.test${path}`, {
    headers: { Cookie: `mw_session=${sealed}` },
  });
}

describe("page", () => {
  it("redirects to the login form, remembering where the caller was aiming", async () => {
    const request = new Request("https://mailworker.test/deliveries?status=queued");

    const redirect = await page(await contextFor(), request, async () => "unreachable").catch(
      (error: unknown) => error,
    );

    expect(redirect).toBeInstanceOf(Response);
    expect((redirect as Response).status).toBe(302);
    expect((redirect as Response).headers.get("Location")).toBe(
      "/login?next=%2Fdeliveries%3Fstatus%3Dqueued",
    );
  });

  it("gives a domain error the status the contract says it has", async () => {
    const thrown = await page(await contextFor(), await signedIn(), async () => {
      throw new DomainError("message_not_found", "No message 01ARZ.", { id: "01ARZ" });
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    expect(await (thrown as Response).text()).toBe("No message 01ARZ.");
  });

  it("maps a refused scope to 403 rather than to 500", async () => {
    const thrown = await page(await contextFor(), await signedIn(), async () => {
      throw new DomainError("forbidden", "This credential lacks the admin scope.");
    }).catch((error: unknown) => error);

    expect((thrown as Response).status).toBe(403);
  });

  it("passes a Response through untouched", async () => {
    // Resource routes (the sandboxed message body, an attachment) return one,
    // and `requireCaller`'s redirect is one. Wrapping either in an error status
    // would break the page that works.
    const body = new Response("bytes", { status: 200, headers: { "X-Test": "1" } });
    const returned = await page(await contextFor(), await signedIn(), async () => body);

    expect(returned).toBe(body);
  });

  it("does not disguise a bug as a domain failure", async () => {
    const boom = new TypeError("undefined is not a function");

    await expect(
      page(await contextFor(), await signedIn(), async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
