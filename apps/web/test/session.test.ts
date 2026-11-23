import { env, SELF } from "cloudflare:test";
import { createDb, schema } from "@web/workers/adapters";
import { createContainer } from "@web/workers/container";
import {
  callerForRequest,
  clearCookie,
  open,
  seal,
  setCookie,
} from "@web/workers/http/session";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The dashboard's credential.
 *
 * Two things are being proven here, and the second is the one that would be
 * expensive to discover later:
 *
 *   1. A sealed cookie round-trips, and every way of it being wrong — expired,
 *      tampered, sealed under a different secret, naming a revoked key — comes
 *      back as "not signed in" rather than as a partially-trusted caller.
 *   2. `/v1` does not accept the cookie at all. That is what makes every
 *      mutating endpoint under `/v1` unreachable by CSRF: a browser attaches
 *      cookies to a cross-site request it was tricked into making, and does not
 *      attach an `Authorization` header. It is asserted rather than assumed
 *      because the natural "convenience" change — letting the API read the
 *      session too — silently deletes the property.
 */

const ADMIN_KEY = "test-bootstrap-key";
const db = createDb(env.DB);

beforeEach(async () => {
  await db.batch([db.delete(schema.apiKeys), db.delete(schema.agentIdentities)]);
});

function request(cookie?: string): Request {
  return new Request("https://mailworker.test/", {
    ...(cookie === undefined ? {} : { headers: { Cookie: cookie } }),
  });
}

describe("sealing", () => {
  it("round-trips a token", async () => {
    const now = new Date();
    const sealed = await seal(env, "mw_live_abc123_deadbeef", now);
    expect(sealed).not.toBeNull();
    expect(await open(env, sealed!, now)).toBe("mw_live_abc123_deadbeef");
  });

  it("does not put the token in the cookie in readable form", async () => {
    const sealed = await seal(env, "mw_live_abc123_deadbeef", new Date());
    // The point of AES-GCM over a signature: a signed-but-readable cookie shows
    // a live API key in any browser inspector and any header-capturing log.
    expect(sealed).not.toContain("mw_live");
    expect(atob(sealed!.replaceAll("-", "+").replaceAll("_", "/"))).not.toContain("mw_live");
  });

  it("refuses a payload whose expiry has passed", async () => {
    const now = new Date();
    const sealed = await seal(env, "mw_live_abc123_deadbeef", now, 1_000);
    expect(await open(env, sealed!, new Date(now.getTime() + 1_001))).toBeNull();
  });

  it("refuses a tampered ciphertext rather than throwing", async () => {
    const sealed = await seal(env, "mw_live_abc123_deadbeef", new Date());
    const flipped = `${sealed!.slice(0, -2)}${sealed!.slice(-2) === "AA" ? "AB" : "AA"}`;
    expect(await open(env, flipped, new Date())).toBeNull();
  });

  it("refuses a cookie sealed under a different secret", async () => {
    const sealed = await seal(env, "mw_live_abc123_deadbeef", new Date());
    const otherDeployment = {
      ...env,
      MAILWORKER_SESSION_SECRET: "a completely different secret",
    };
    expect(await open(otherDeployment, sealed!, new Date())).toBeNull();
  });

  it("cannot issue a session when no secret is configured", async () => {
    // Omitted rather than set to `undefined`: with `exactOptionalPropertyTypes`
    // those are different types, and the deployment being described here is one
    // where the secret was never set at all.
    const { MAILWORKER_ADMIN_KEY, MAILWORKER_SESSION_SECRET, ...bare } = env;
    expect(await seal(bare, "mw_live_abc123_deadbeef", new Date())).toBeNull();
  });

  it("finds its cookie among others", async () => {
    const sealed = await seal(env, ADMIN_KEY, new Date());
    const container = createContainer(env);
    const caller = await callerForRequest(
      container,
      env,
      request(`theme=dark; mw_session=${sealed}; other=1`),
      new Date(),
    );
    expect(caller?.subject).toBe("key:bootstrap");
  });

  it("marks the cookie Secure over https and not over http", () => {
    expect(setCookie("x", new URL("https://mailworker.test/"))).toContain("; Secure");
    // Not a nicety: a `Secure` cookie is simply never stored by a browser on
    // http://localhost, so `vite dev` would have no session at all.
    expect(setCookie("x", new URL("http://localhost:5173/"))).not.toContain("; Secure");
    expect(clearCookie(new URL("https://mailworker.test/"))).toContain("Max-Age=0");
  });
});

describe("the cookie as a credential", () => {
  it("resolves to the same Caller a bearer token would", async () => {
    const minted = await SELF.fetch("https://mailworker.test/v1/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      body: JSON.stringify({ name: "dash", scopes: ["message:read"] }),
    });
    const { token } = (await minted.json()) as { token: string };

    const sealed = await seal(env, token, new Date());
    const caller = await callerForRequest(
      createContainer(env),
      env,
      request(`mw_session=${sealed}`),
      new Date(),
    );

    expect(caller).not.toBeNull();
    expect(caller?.scopes).toEqual(["message:read"]);
  });

  it("stops working the moment the key behind it is revoked", async () => {
    const minted = await SELF.fetch("https://mailworker.test/v1/keys", {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
      body: JSON.stringify({ name: "dash", scopes: ["message:read"] }),
    });
    const { token, id } = (await minted.json()) as { token: string; id: string };
    const sealed = await seal(env, token, new Date());

    await SELF.fetch(`https://mailworker.test/v1/keys/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });

    // This is why there is no session table: revoking the key is the whole
    // revocation story, with nothing to cascade and nothing to forget.
    expect(
      await callerForRequest(
        createContainer(env),
        env,
        request(`mw_session=${sealed}`),
        new Date(),
      ),
    ).toBeNull();
  });

  it("is refused by /v1, which only reads the Authorization header", async () => {
    const sealed = await seal(env, ADMIN_KEY, new Date());

    const response = await SELF.fetch("https://mailworker.test/v1/inboxes", {
      headers: { Cookie: `mw_session=${sealed}` },
    });

    expect(response.status).toBe(401);

    const patch = await SELF.fetch("https://mailworker.test/v1/messages", {
      method: "PATCH",
      headers: { Cookie: `mw_session=${sealed}` },
      body: JSON.stringify({ ids: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"], starred: true }),
    });
    expect(patch.status).toBe(401);
    expect(await patch.json()).toMatchObject({ error: { code: "unauthorized" } });
  });
});
