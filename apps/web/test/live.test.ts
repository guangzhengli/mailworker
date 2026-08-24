import { env, SELF } from "cloudflare:test";
import type { AgentIdentityDto, ApiKeyDto, InboxDto } from "@mailworker/contract";
import { AccountId } from "@mailworker/core";
import { createDb, schema } from "@web/workers/adapters";
import entry from "@web/workers/entry";
import { seal } from "@web/workers/http/session";
import { type LiveEvent, waiterFor } from "@web/workers/waiter";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The dashboard's live connection.
 *
 * Run here, in workerd, against the real Durable Object, because everything
 * worth asserting about it is about two things happening at once: a socket that
 * is already open when mail arrives, and a socket that must stay silent because
 * the mail was for somebody else. A mock of the DO would decide both of those
 * for us.
 *
 * The refusals are tested as carefully as the delivery. A WebSocket handshake
 * has no error body a browser will show, so "it just does not connect" is the
 * entire user-visible symptom of every one of them — which makes the status code
 * the only thing that can be checked and the only thing a developer can act on.
 */

const ADMIN_KEY = "test-bootstrap-key";
const DOMAIN = "mail.example.com";
const ORIGIN = "https://mailworker.test";

const db = createDb(env.DB);

beforeEach(async () => {
  await db.batch([
    db.delete(schema.attachments),
    db.delete(schema.messages),
    db.delete(schema.inboxes),
    db.delete(schema.apiKeys),
    db.delete(schema.agentIdentities),
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

async function api(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return await SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

async function createIdentity(name: string): Promise<AgentIdentityDto> {
  const response = await api("/v1/identities", ADMIN_KEY, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as AgentIdentityDto;
}

async function mintBoundKey(identityName: string): Promise<string> {
  const response = await api("/v1/keys", ADMIN_KEY, {
    method: "POST",
    body: JSON.stringify({
      name: `${identityName} live-test`,
      identityName,
      scopes: ["inbox:read", "inbox:write", "message:read"],
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as ApiKeyDto & { token: string }).token;
}

async function createInbox(prefix: string, token = ADMIN_KEY): Promise<InboxDto> {
  const response = await SELF.fetch(`${ORIGIN}/v1/inboxes`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ prefix, domain: DOMAIN }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as InboxDto;
}

async function deliver(to: string, subject: string): Promise<void> {
  const raw = [
    `From: Sender <noreply@sender.test>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: <${crypto.randomUUID()}@sender.test>`,
    `Content-Type: text/plain; charset=utf-8`,
    "",
    "Body.",
    "",
  ].join("\r\n");

  await entry.email(
    {
      from: "noreply@sender.test",
      to,
      raw: new Response(raw).body!,
      rawSize: raw.length,
      headers: new Headers(),
      setReject() {},
      forward: async () => {},
      reply: async () => {},
    } as unknown as ForwardableEmailMessage,
    env as unknown as Env,
  );
}

async function connect(
  options: { inbox?: string; cookie?: boolean; origin?: string | null; token?: string } = {},
): Promise<Response> {
  const url = new URL("/events", ORIGIN);
  if (options.inbox !== undefined) url.searchParams.set("inbox", options.inbox);

  const headers = new Headers({ Upgrade: "websocket" });
  if (options.cookie !== false) {
    headers.set(
      "Cookie",
      `mw_session=${await seal(env, options.token ?? ADMIN_KEY, new Date())}`,
    );
  }
  if (options.origin !== null) headers.set("Origin", options.origin ?? ORIGIN);

  return await SELF.fetch(url, { headers });
}

function nextEvent(socket: WebSocket): Promise<LiveEvent> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event: MessageEvent) => {
      const data = String(event.data);
      if (data === "pong") return;
      resolve(JSON.parse(data) as LiveEvent);
    });
    socket.addEventListener("close", () => reject(new Error("closed before any event")));
  });
}

describe("who may open a live connection", () => {
  it("fails closed when an old forwarder supplies no visibility marker", async () => {
    const response = await waiterFor(env.WAITER, AccountId.parse("default")).fetch(
      new Request("https://waiter.internal/", { headers: { Upgrade: "websocket" } }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a request that is not an upgrade", async () => {
    const response = await SELF.fetch(`${ORIGIN}/events`, {
      headers: { Cookie: `mw_session=${await seal(env, ADMIN_KEY, new Date())}` },
    });
    expect(response.status).toBe(426);
  });

  it("refuses an upgrade with no session, rather than redirecting it", async () => {
    // A redirect to /login is what a page gets. A WebSocket client cannot follow
    // one — it would see the handshake fail with nothing to report.
    const response = await connect({ cookie: false });
    expect(response.status).toBe(401);
  });

  it("refuses an upgrade from another origin", async () => {
    // WebSockets are exempt from CORS: without this check, any page could open
    // one here and read every arrival. SameSite=Lax keeps the cookie away from
    // that request too, so this is the second lock — and the one that survives a
    // change to the first.
    const response = await connect({ origin: "https://evil.example" });
    expect(response.status).toBe(403);
  });

  it("accepts a signed-in upgrade", async () => {
    const response = await connect();
    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
    response.webSocket?.accept();
    response.webSocket?.close();
  });
});

describe("what it says", () => {
  it("tells a watching dashboard that mail landed", async () => {
    const inbox = await createInbox("watched");
    const socket = (await connect({ inbox: inbox.id })).webSocket!;
    socket.accept();

    const event = nextEvent(socket);
    await deliver(inbox.address, "It arrived");

    // The id and the inbox, and deliberately not the message: the page answers
    // "what does it look like now" by re-running its loader, so the event only
    // has to say that it should.
    expect(await event).toMatchObject({ type: "message.received", inboxId: inbox.id });
    expect((await event).id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    socket.close();
  });

  it("does not wake a page watching another inbox", async () => {
    const mine = await createInbox("mine");
    const theirs = await createInbox("theirs");

    const socket = (await connect({ inbox: mine.id })).webSocket!;
    socket.accept();
    const event = nextEvent(socket);

    // Ordered rather than timed: if the filter leaked, the first event to arrive
    // would be the other inbox's, and this assertion names which one it was.
    await deliver(theirs.address, "Not for you");
    await deliver(mine.address, "For you");

    expect((await event).inboxId).toBe(mine.id);
    socket.close();
  });

  it("hears about every inbox when it asks for none", async () => {
    const inbox = await createInbox("any");
    const socket = (await connect()).webSocket!;
    socket.accept();

    const event = nextEvent(socket);
    await deliver(inbox.address, "Anything");

    expect((await event).inboxId).toBe(inbox.id);
    socket.close();
  });

  it("keeps an identity-bound connection inside its identity", async () => {
    await createIdentity("alice-live");
    await createIdentity("bob-live");
    const aliceToken = await mintBoundKey("alice-live");
    const bobToken = await mintBoundKey("bob-live");
    const aliceInbox = await createInbox("alice-live", aliceToken);
    const bobInbox = await createInbox("bob-live", bobToken);

    const socket = (await connect({ token: aliceToken })).webSocket!;
    socket.accept();
    const event = nextEvent(socket);

    // Ordered instead of timed: a missing identity filter makes Bob's event
    // resolve this promise first and names the leaked inbox in the failure.
    await deliver(bobInbox.address, "Bob only");
    await deliver(aliceInbox.address, "Alice only");

    expect((await event).inboxId).toBe(aliceInbox.id);
    socket.close();
  });

  it("refuses another identity's requested inbox", async () => {
    await createIdentity("alice-filter");
    await createIdentity("bob-filter");
    const aliceToken = await mintBoundKey("alice-filter");
    const bobToken = await mintBoundKey("bob-filter");
    const aliceInbox = await createInbox("alice-filter", aliceToken);
    const bobInbox = await createInbox("bob-filter", bobToken);

    const refused = await connect({ token: aliceToken, inbox: bobInbox.id });
    expect(refused.status).toBe(404);

    const accepted = await connect({ token: aliceToken, inbox: aliceInbox.id });
    expect(accepted.status).toBe(101);
    accepted.webSocket?.accept();
    accepted.webSocket?.close();
  });

  it("answers a keepalive without waking the object", async () => {
    // `setWebSocketAutoResponse`, which is what lets a tab left open overnight
    // cost the storage of a socket instead of the duration of an isolate.
    const socket = (await connect()).webSocket!;
    socket.accept();

    const pong = new Promise<string>((resolve) => {
      socket.addEventListener("message", (event: MessageEvent) => resolve(String(event.data)));
    });
    socket.send("ping");

    expect(await pong).toBe("pong");
    socket.close();
  });
});
