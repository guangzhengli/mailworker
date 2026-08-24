import { env, SELF } from "cloudflare:test";
import type { InboxDto, SendResponse } from "@mailworker/contract";
import { workerContext } from "@web/app/context";
import { loader } from "@web/app/routes/delivery-body";
import { createDb, schema } from "@web/workers/adapters";
import { createContainer } from "@web/workers/container";
import { seal } from "@web/workers/http/session";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The outbound body frame.
 *
 * Tested through its loader rather than through a rendered page, for the same
 * reason as `dashboard.test.ts`: this suite does not build the client bundle.
 * That costs nothing here, because this route HAS no component — it returns a
 * `Response`, and the response is the whole thing worth checking.
 */

const ADMIN_KEY = "test-bootstrap-key";
const DOMAIN = "mail.example.com";
const db = createDb(env.DB);

beforeEach(async () => {
  await db.batch([
    db.delete(schema.messages),
    db.delete(schema.dispatchOutbox),
    db.delete(schema.deliveries),
    db.delete(schema.inboxes),
    db.delete(schema.domains),
  ]);
  await db.insert(schema.domains).values({
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    accountId: "default",
    name: DOMAIN,
    zoneId: null,
    inboundEnabled: true,
    sendingStatus: "verified",
    catchallMode: "reject",
    catchallInbox: null,
    autocreatePattern: null,
    createdAt: new Date().toISOString(),
  });
});

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return await SELF.fetch(`https://mailworker.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, ...(init.headers ?? {}) },
  });
}

async function seedDelivery(html: string): Promise<string> {
  const inbox = (await (
    await api("/v1/inboxes", {
      method: "POST",
      body: JSON.stringify({ prefix: "agent", domain: DOMAIN, kind: "persistent" }),
    })
  ).json()) as InboxDto;

  const sent = (await (
    await api("/v1/send", {
      method: "POST",
      body: JSON.stringify({
        from: inbox.address,
        to: ["someone@elsewhere.test"],
        subject: "Styled",
        html,
      }),
    })
  ).json()) as SendResponse;

  return sent.delivery.id;
}

async function fetchBody(id: string): Promise<Response> {
  const context = new RouterContextProvider();
  context.set(workerContext, {
    env,
    ctx: { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    container: createContainer(env),
  });
  const sealed = await seal(env, ADMIN_KEY, new Date());

  return (await loader({
    context,
    request: new Request(`https://mailworker.test/deliveries/${id}/body`, {
      headers: { Cookie: `mw_session=${sealed}` },
    }),
    params: { id },
  } as never)) as Response;
}

describe("GET /deliveries/:id/body", () => {
  it("serves the HTML body as its own document, with its structure intact", async () => {
    const id = await seedDelivery(
      '<div style="color:#a8542a"><h1>Invoice</h1><table><tr><td>Total</td></tr></table></div>',
    );

    const response = await fetchBody(id);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(html).toContain("<h1>Invoice</h1>");
    expect(html).toContain("<table>");
  });

  it("keeps inline CSS, so the preview looks like the message", async () => {
    // The point of the whole route. Mail is styled inline, so this is what makes
    // an approval page show the reviewer what the recipient will actually see
    // rather than an outline of it.
    const id = await seedDelivery(
      '<td style="padding:32px;background:#ffffff" bgcolor="#ffffff">Hi</td>',
    );
    // The frame's own stylesheet lives in the <head>, so assertions have to be
    // about the message rather than the document.
    const html = await fetchBody(id).then((response) => response.text());
    const body = html.slice(html.indexOf("<body>"));

    expect(body).toContain("padding:32px");
    expect(body).toContain('bgcolor="#ffffff"');
  });

  it("still drops the CSS that would reach the network", async () => {
    // A background image is a read receipt with no UI to consent to it, and the
    // CSP would block it anyway — belt and braces, both asserted.
    const id = await seedDelivery(
      '<div style="color:red;background-image:url(https://tracker.test/x.gif)">Hi</div>',
    );
    const response = await fetchBody(id);
    const html = await response.text();
    const body = html.slice(html.indexOf("<body>"));

    expect(body).toContain("color:red");
    expect(body).not.toContain("tracker.test");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
  });

  it("is readable before dispatch, which is the point of it", async () => {
    // The sent copy is only archived at dispatch. Nothing in this test has
    // dispatched — there is no `send_email` binding in this environment — and
    // the body is readable anyway. That is what makes an approval queue
    // reviewable rather than a button that says yes to an id.
    const id = await seedDelivery("<p>Please check this before it goes.</p>");
    expect(await (await fetchBody(id)).text()).toContain("Please check this before it goes.");
  });

  it("strips script and blocks remote images through the CSP", async () => {
    const id = await seedDelivery(
      '<p onclick="steal()">Hi</p><script>steal()</script><img src="https://tracker.test/x.gif">',
    );

    const response = await fetchBody(id);
    const html = await response.text();
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(html).not.toContain("<script>");
    expect(html).not.toContain("onclick");
    // CSP, which the browser enforces regardless of what the markup says. No
    // `?images=1` escape hatch here, unlike inbound: we are the sender, so there
    // is no privacy gain to trade for fetching arbitrary URLs.
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src data:");
    expect(csp).not.toContain("https:");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
