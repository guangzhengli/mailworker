import { env, SELF } from "cloudflare:test";
import type { InboxDto, MessageDto } from "@mailworker/contract";
import { workerContext } from "@web/app/context";
import { loader } from "@web/app/routes/message-body";
import { createDb, schema } from "@web/workers/adapters";
import { createContainer } from "@web/workers/container";
import entry from "@web/workers/entry";
import { seal } from "@web/workers/http/session";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The inbound body frame.
 *
 * The route runs one script of its own — the height reporter — which is the
 * only reason the frame is allowed to run scripts at all. That makes the CSP it
 * emits a load-bearing part of the page rather than a header nobody reads, so
 * it is asserted here: a nonce that changes per response, and no second way in.
 *
 * Tested through the loader, like `delivery-body.test.ts`, because the route
 * has no component — the `Response` is the whole thing worth checking.
 */

const ADMIN_KEY = "test-bootstrap-key";
const DOMAIN = "mail.example.com";
const db = createDb(env.DB);

beforeEach(async () => {
  await db.batch([
    db.delete(schema.attachments),
    db.delete(schema.messages),
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

/** Delivers an HTML message through the real `email()` handler and returns its id. */
async function seedMessage(html: string): Promise<string> {
  const inbox = (await (
    await api("/v1/inboxes", {
      method: "POST",
      body: JSON.stringify({ prefix: "agent", domain: DOMAIN, kind: "persistent" }),
    })
  ).json()) as InboxDto;

  const raw = [
    "From: Acme Security <noreply@sender.test>",
    `To: ${inbox.address}`,
    "Subject: Styled",
    `Message-ID: <${crypto.randomUUID()}@sender.test>`,
    "Date: Wed, 01 Jul 2026 12:00:00 +0000",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    "",
  ].join("\r\n");

  await entry.email(
    {
      from: "noreply@sender.test",
      to: inbox.address,
      raw: new Response(raw).body!,
      rawSize: raw.length,
      headers: new Headers(),
      setReject() {},
      forward: async () => {},
      reply: async () => {},
    } as unknown as ForwardableEmailMessage,
    env as unknown as Env,
  );

  const page = (await (await api(`/v1/messages?inbox=${inbox.id}`)).json()) as {
    items: MessageDto[];
  };
  return page.items[0]!.id;
}

async function fetchBody(id: string, search = ""): Promise<Response> {
  const context = new RouterContextProvider();
  context.set(workerContext, {
    env,
    ctx: { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
    container: createContainer(env),
  });
  const sealed = await seal(env, ADMIN_KEY, new Date());

  return (await loader({
    context,
    request: new Request(`https://mailworker.test/messages/${id}/body${search}`, {
      headers: { Cookie: `mw_session=${sealed}` },
    }),
    params: { id },
  } as never)) as Response;
}

function nonceOf(csp: string): string | null {
  return /script-src 'nonce-([^']+)'/.exec(csp)?.[1] ?? null;
}

describe("GET /messages/:id/body", () => {
  it("serves the message with its structure and inline CSS intact", async () => {
    const id = await seedMessage('<h1 style="color:#a8542a">Receipt</h1><p>Total: $49.00</p>');
    const response = await fetchBody(id);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(html).toContain("Receipt");
    expect(html).toContain("color:#a8542a");
  });

  it("admits only the nonced height reporter, and a fresh nonce each time", async () => {
    const id = await seedMessage(
      '<p onclick="steal()">Hi</p><script>steal()</script><a href="javascript:steal()">go</a>',
    );

    const response = await fetchBody(id);
    const html = await response.text();
    const csp = response.headers.get("Content-Security-Policy") ?? "";
    const nonce = nonceOf(csp);

    expect(nonce).not.toBeNull();
    // The sanitizer got there first; the CSP is what holds if it ever does not.
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    // Exactly one script in the document, and it is ours.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain("mailworkerBodyHeight");
    // No blanket escape hatch alongside the nonce, or the nonce buys nothing.
    // `style-src` keeps its `'unsafe-inline'` — inline CSS is how mail is
    // styled — so the check has to be scoped to the script directive.
    expect(csp).toContain("default-src 'none'");
    expect(/script-src[^;]*unsafe-(inline|eval)/.test(csp)).toBe(false);

    // A nonce reused across responses is a nonce an attacker can look up.
    const second = await fetchBody(id);
    expect(nonceOf(second.headers.get("Content-Security-Policy") ?? "")).not.toBe(nonce);
  });

  it("posts the height only to the dashboard's own origin", async () => {
    const id = await seedMessage("<p>Hi</p>");
    const html = await fetchBody(id).then((response) => response.text());

    // A `*` target would hand the height — and anything later added beside it —
    // to whatever page has framed the dashboard.
    expect(html).toContain(
      'parent.postMessage({ mailworkerBodyHeight: height }, "https://mailworker.test")',
    );
  });

  it("blocks remote images until the reader asks for them", async () => {
    const id = await seedMessage('<p>Hi</p><img src="https://tracker.test/x.gif">');

    const blocked = await fetchBody(id);
    const blockedHtml = await blocked.text();
    // The URL is parked on `data-blocked-src`, not removed — that is what lets
    // "load images" restore it. What must be gone is the attribute the browser
    // would fetch from.
    expect(blockedHtml).toContain('data-blocked-src="https://tracker.test/x.gif"');
    expect(/[^-]src="https:\/\/tracker\.test/.test(blockedHtml)).toBe(false);
    expect(blocked.headers.get("Content-Security-Policy")).toContain("img-src data:;");
    expect(blocked.headers.get("Cache-Control")).toBe("private, no-store");

    const allowed = await fetchBody(id, "?images=1");
    expect(await allowed.text()).toContain("tracker.test");
    expect(allowed.headers.get("Content-Security-Policy")).toContain("img-src data: https:");
  });
});
