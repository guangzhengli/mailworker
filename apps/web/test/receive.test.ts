import { env, SELF } from "cloudflare:test";
import type {
  InboxDto,
  LabelUsageDto,
  MessageDto,
  MessageSummaryDto,
  NoteDto,
  WaitResponse,
} from "@mailworker/contract";
import { createDb, schema } from "@web/workers/adapters";
import entry from "@web/workers/entry";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The receive path, end to end, through the code that actually deploys.
 *
 * `SELF.fetch` runs the real router — the same middleware chain, the same error
 * translation — and `entry.email` is the same function Email Routing calls. The
 * only things constructed by hand are the two the internet supplies: the
 * envelope and the bytes.
 *
 * What this can prove that the fast suite cannot is everything that involves
 * two things happening at once, plus everything that involves a real database:
 * that a wait registered before a message arrives is woken by it, that the
 * dedupe is a unique constraint rather than a hope, and that a `Caller` built
 * from a bearer token reaches D1 with the right account on it.
 */

const ADMIN_KEY = "test-bootstrap-key";
const DOMAIN = "mail.example.com";

const db = createDb(env.DB);

beforeEach(async () => {
  await db.batch([
    db.delete(schema.attachments),
    db.delete(schema.messages),
    db.delete(schema.labels),
    db.delete(schema.inboxes),
    db.delete(schema.domains),
  ]);

  // The one routing row a deployment needs before it can mint an address.
  // `mailworker deploy` writes this; here it is the fixture.
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

async function createInbox(prefix = "agent"): Promise<InboxDto> {
  const response = await api("/v1/inboxes", {
    method: "POST",
    body: JSON.stringify({ prefix, domain: DOMAIN }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as InboxDto;
}

function rawEmail(
  to: string,
  options: { subject?: string; body?: string; id?: string; headers?: readonly string[] } = {},
) {
  const messageId = options.id ?? `${crypto.randomUUID()}@sender.test`;
  return [
    `From: Sender <noreply@sender.test>`,
    `To: ${to}`,
    `Subject: ${options.subject ?? "Hello"}`,
    `Message-ID: <${messageId}>`,
    `Date: Wed, 01 Jul 2026 12:00:00 +0000`,
    `Content-Type: text/plain; charset=utf-8`,
    ...(options.headers ?? []),
    "",
    options.body ?? "Nothing to see here.",
    "",
  ].join("\r\n");
}

/** What Email Routing hands the `email()` handler, minus the parts we ignore. */
function inbound(to: string, raw: string) {
  const rejections: string[] = [];
  const message = {
    from: "noreply@sender.test",
    to,
    raw: new Response(raw).body!,
    rawSize: raw.length,
    headers: new Headers(),
    setReject(reason: string) {
      rejections.push(reason);
    },
    forward: async () => {},
    reply: async () => {},
  };
  return { message: message as unknown as ForwardableEmailMessage, rejections };
}

async function deliver(to: string, raw: string): Promise<string[]> {
  const { message, rejections } = inbound(to, raw);
  await entry.email(message, env as unknown as Env);
  return rejections;
}

describe("inbound mail", () => {
  it("stores a message addressed to an inbox, and serves it back", async () => {
    const inbox = await createInbox();

    const rejections = await deliver(
      inbox.address,
      rawEmail(inbox.address, { subject: "Receipt" }),
    );
    expect(rejections).toEqual([]);

    const listed = await api(`/v1/messages?inbox=${inbox.id}`);
    const page = (await listed.json()) as { items: MessageDto[] };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.subject).toBe("Receipt");
    expect(page.items[0]!.inboxId).toBe(inbox.id);
  });

  it("serves the original bytes back verbatim", async () => {
    // The half of `get --raw > fixture.eml | inject` that has to be exact: a
    // re-serialized message would reproduce our parser's opinion of the mail.
    const inbox = await createInbox();
    const raw = rawEmail(inbox.address, { subject: "Keep me" });
    await deliver(inbox.address, raw);

    const listed = await api(`/v1/messages?inbox=${inbox.id}`);
    const { items } = (await listed.json()) as { items: MessageDto[] };

    const response = await api(`/v1/messages/${items[0]!.id}/raw`);
    expect(response.headers.get("Content-Type")).toBe("message/rfc822");
    // Decoded from the bytes rather than via `.text()`: workerd warns about
    // reading a non-text content type as text, and the point here is the bytes.
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(raw);
  });

  it("stores a redelivery once, because the unique constraint says so", async () => {
    const inbox = await createInbox();
    const raw = rawEmail(inbox.address, { id: "stable@sender.test" });

    expect(await deliver(inbox.address, raw)).toEqual([]);
    // Email Routing retries. A retry we already stored is a success from the
    // sender's point of view, so it must not bounce.
    expect(await deliver(inbox.address, raw)).toEqual([]);

    const listed = await api(`/v1/messages?inbox=${inbox.id}`);
    expect(((await listed.json()) as { items: MessageDto[] }).items).toHaveLength(1);
  });

  it("stores one RFC message delivered to two +tags in the same inbox", async () => {
    const inbox = await createInbox("tagged");
    const at = inbox.address.lastIndexOf("@");
    const one = `${inbox.address.slice(0, at)}+run-one@${DOMAIN}`;
    const two = `${inbox.address.slice(0, at)}+run-two@${DOMAIN}`;
    // MIME To deliberately stays at the base address: SMTP RCPT TO is the
    // authoritative route identity, and the two can differ for BCC/forwarding.
    const raw = rawEmail(inbox.address, { id: "tagged-fanout@sender.test" });

    expect(await deliver(one, raw)).toEqual([]);
    expect(await deliver(two, raw)).toEqual([]);
    expect(await deliver(one.toUpperCase(), raw)).toEqual([]);

    const listed = await api(`/v1/messages?inbox=${inbox.id}`);
    expect(((await listed.json()) as { items: MessageDto[] }).items).toHaveLength(2);
  });

  it("rejects mail for an address no inbox claims", async () => {
    const unknown = `nobody@${DOMAIN}`;
    const rejections = await deliver(unknown, rawEmail(unknown));
    // A bounce is information. Silently accepting unknown addresses is what
    // makes a catch-all domain a spam sink.
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toContain(unknown);
  });

  it("derives a text body from an HTML-only message", async () => {
    // The bug this exists to catch is invisible: no error, just an empty
    // preview, an unsearchable message and `wait --text` printing nothing.
    const inbox = await createInbox();
    const raw = [
      `From: Sender <noreply@sender.test>`,
      `To: ${inbox.address}`,
      `Subject: Verify`,
      `Message-ID: <html-only@sender.test>`,
      `Content-Type: text/html; charset=utf-8`,
      "",
      "<html><body><p>Your code is <b>314159</b></p></body></html>",
      "",
    ].join("\r\n");

    await deliver(inbox.address, raw);
    const listed = await api(`/v1/messages?inbox=${inbox.id}`);
    const { items } = (await listed.json()) as { items: MessageDto[] };

    const message = (await (await api(`/v1/messages/${items[0]!.id}`)).json()) as MessageDto;
    expect(message.bodyText).toContain("314159");
  });
});

describe("wait", () => {
  it("wakes a caller that was already blocked when the message arrived", async () => {
    const inbox = await createInbox();

    // Registered first, deliberately: this is the case the Durable Object
    // exists for, and the one a look-back over stored messages cannot answer.
    const waiting = api(`/v1/messages/wait?inbox=${inbox.id}&timeout=10s`);
    await deliver(inbox.address, rawEmail(inbox.address, { body: "Your code is 998877" }));

    const result = (await (await waiting).json()) as WaitResponse;
    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") return;
    expect(result.message.bodyText).toContain("998877");
  });

  it("answers a message that arrived before the wait started", async () => {
    // The other half: a caller that asks late must not be told "nothing yet"
    // about mail that is already sitting in the inbox.
    const inbox = await createInbox();
    await deliver(inbox.address, rawEmail(inbox.address, { subject: "Already here" }));

    const result = (await (
      await api(`/v1/messages/wait?inbox=${inbox.id}&timeout=10s`)
    ).json()) as WaitResponse;
    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") return;
    expect(result.message.subject).toBe("Already here");
  });

  it("returns a timeout as an outcome, with a 200", async () => {
    const inbox = await createInbox();
    const response = await api(`/v1/messages/wait?inbox=${inbox.id}&timeout=1s`);

    // Not an error status. The caller asked "has it arrived?" and "not yet" is
    // an answer; only the CLI turns that into exit code 4.
    expect(response.status).toBe(200);
    expect(((await response.json()) as WaitResponse).outcome).toBe("timeout");
  });

  it("does not match a message in a different inbox", async () => {
    const mine = await createInbox("mine");
    const theirs = await createInbox("theirs");

    const waiting = api(`/v1/messages/wait?inbox=${mine.id}&timeout=1s`);
    await deliver(theirs.address, rawEmail(theirs.address));

    expect(((await (await waiting).json()) as WaitResponse).outcome).toBe("timeout");
  });
});

describe("the API surface", () => {
  it("refuses an unauthenticated request", async () => {
    const response = await SELF.fetch("https://mailworker.test/v1/inboxes");
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "unauthorized",
    );
  });

  it("answers health without a credential", async () => {
    const response = await SELF.fetch("https://mailworker.test/v1/health");
    expect(response.status).toBe(200);
  });

  it("reports a malformed body as invalid_argument with the offending path", async () => {
    const response = await api("/v1/inboxes", {
      method: "POST",
      body: JSON.stringify({ prefix: "Not Allowed Caps" }),
    });
    expect(response.status).toBe(400);

    const body = (await response.json()) as {
      error: { code: string; details: { issues: { path: string }[] } };
    };
    expect(body.error.code).toBe("invalid_argument");
    expect(body.error.details.issues[0]!.path).toBe("prefix");
  });

  it("gives an unknown route a code, not just a status", async () => {
    const response = await api("/v1/nope");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "not_found",
    );
  });

  it("replays a fixture through the same path as real mail", async () => {
    // `inject` is the other end of the testing loop. It has to go through the
    // production parser and the production policies, or a reproduction on a
    // laptop proves nothing about the deployment.
    const inbox = await createInbox();
    const response = await api(`/v1/ingest/raw?to=${encodeURIComponent(inbox.address)}`, {
      method: "POST",
      body: rawEmail(inbox.address, { subject: "Injected" }),
      headers: { "Content-Type": "message/rfc822" },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { outcome: string; message: MessageDto };
    expect(body.outcome).toBe("stored");
    expect(body.message.subject).toBe("Injected");
  });

  it("rejects an oversized raw fixture before reading its body", async () => {
    const response = await api(`/v1/ingest/raw?to=agent%40${DOMAIN}`, {
      method: "POST",
      body: "not read",
      headers: {
        "Content-Type": "message/rfc822",
        "Content-Length": String(25 * 1024 * 1024 + 1),
      },
    });

    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "payload_too_large",
    );
  });

  it("does not let a read-only key forge inbound mail", async () => {
    const keyResponse = await api("/v1/keys", {
      method: "POST",
      body: JSON.stringify({ name: "reader", scopes: ["message:read"] }),
    });
    const { token } = (await keyResponse.json()) as { token: string };
    const inbox = await createInbox();

    const response = await SELF.fetch(
      `https://mailworker.test/v1/ingest/raw?to=${encodeURIComponent(inbox.address)}`,
      {
        method: "POST",
        body: rawEmail(inbox.address, { subject: "Forged" }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "message/rfc822",
        },
      },
    );

    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      "forbidden",
    );
  });
});

describe("mail client state over /v1", () => {
  const absent = "01ARZ3NDEKTSV4RRFFQ69G5FAW";

  function write(method: "POST" | "PATCH", body: object): RequestInit {
    return {
      method,
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
    };
  }

  async function expectError(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  }

  it("creates and patches inbox mute state and reports invalid or missing inboxes", async () => {
    const ephemeral = await createInbox();
    expect(ephemeral.muted).toBe(true);
    const created = await api(
      "/v1/inboxes",
      write("POST", { kind: "persistent", muted: true }),
    );
    expect(created.status).toBe(201);
    const inbox = (await created.json()) as InboxDto;
    expect(inbox.muted).toBe(true);

    const changed = await api(
      `/v1/inboxes/${inbox.id}`,
      write("PATCH", { muted: false, displayName: "  Support  " }),
    );
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({
      id: inbox.id,
      muted: false,
      displayName: "Support",
    });
    const listed = await api("/v1/inboxes?muted=false");
    expect(await listed.json()).toMatchObject({ items: [{ id: inbox.id }] });
    await expectError(
      await api(`/v1/inboxes/${inbox.id}`, write("PATCH", {})),
      400,
      "invalid_argument",
    );
    await expectError(
      await api(`/v1/inboxes/${absent}`, write("PATCH", { muted: true })),
      404,
      "inbox_not_found",
    );
  });

  it("persists list headers from the real email path and exposes them on message and thread reads", async () => {
    const inbox = await createInbox();
    const raw = rawEmail(inbox.address, {
      headers: [
        "List-Id: Weekly Digest <digest.example.com>",
        "List-Unsubscribe: <http://example.com/old>, <https://example.com/leave>, <mailto:leave@example.com>",
        "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
      ],
    });
    expect(await deliver(inbox.address, raw)).toEqual([]);
    const {
      items: [summary],
    } = (await (await api("/v1/messages")).json()) as { items: MessageSummaryDto[] };
    expect(summary).toMatchObject({
      starred: false,
      archivedAt: null,
      labels: [],
      noteCount: 0,
    });
    const message = (await (await api(`/v1/messages/${summary!.id}`)).json()) as MessageDto;
    expect(message).toMatchObject({
      listId: "Weekly Digest <digest.example.com>",
      unsubscribe: {
        https: "https://example.com/leave",
        mailto: "mailto:leave@example.com",
        oneClick: true,
      },
    });
    const thread = await api(`/v1/threads/${encodeURIComponent(message.threadId)}`);
    expect(await thread.json()).toMatchObject({
      items: [{ listId: message.listId, unsubscribe: message.unsubscribe }],
    });
  });

  it("patches one or many messages and manages usage and labels", async () => {
    const inbox = await createInbox();
    await deliver(inbox.address, rawEmail(inbox.address));
    const {
      items: [item],
    } = (await (await api("/v1/messages")).json()) as { items: MessageSummaryDto[] };
    const path = `/v1/messages/${item!.id}`;
    const patched = await api(
      path,
      write("PATCH", {
        starred: true,
        archived: true,
        labels: { add: [" Bug ", "BUG", "Support"] },
      }),
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      id: item!.id,
      starred: true,
      archivedAt: expect.any(String),
      labels: ["Bug", "Support"],
      noteCount: 0,
    });

    const batch = await api(
      "/v1/messages",
      write("PATCH", { ids: [item!.id, item!.id], archived: false }),
    );
    expect(batch.status).toBe(200);
    expect(await batch.json()).toEqual({ updated: 1 });
    const page = await api("/v1/messages?starred=true&archived=false&label=bUg");
    expect(await page.json()).toMatchObject({ items: [{ id: item!.id, archivedAt: null }] });

    const failed = await api(
      "/v1/messages",
      write("PATCH", { ids: [item!.id, absent], seen: true, labels: { add: ["Rollback"] } }),
    );
    expect(failed.status).toBe(404);
    expect(await failed.json()).toMatchObject({
      error: { code: "message_not_found", details: { ids: [absent] } },
    });
    const labels = await api("/v1/labels");
    expect(labels.status).toBe(200);
    const { items } = (await labels.json()) as { items: LabelUsageDto[] };
    expect(
      items.map(({ name, messageCount, unreadCount }) => ({ name, messageCount, unreadCount })),
    ).toEqual([
      { name: "Bug", messageCount: 1, unreadCount: 1 },
      { name: "Support", messageCount: 1, unreadCount: 1 },
    ]);
    const bug = items.find(({ name }) => name === "Bug")!;
    const labelPath = `/v1/labels/${bug.id}`;
    await expectError(
      await api(labelPath, write("PATCH", { name: "SUPPORT" })),
      400,
      "invalid_argument",
    );
    const renamed = await api(labelPath, write("PATCH", { name: "Incident" }));
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: bug.id, name: "Incident" });
    expect((await api(labelPath, { method: "DELETE" })).status).toBe(204);
    expect(await (await api(path)).json()).toMatchObject({ labels: ["Support"], seen: false });
    await expectError(await api(path, write("PATCH", {})), 400, "invalid_argument");
    expect((await api(`${path}/seen`, write("POST", {}))).status).toBe(204);
    expect(await (await api(path)).json()).toMatchObject({ seen: true });
  });

  it("writes and lists plain-text notes, checks note authorship, and rejects unknown messages", async () => {
    const inbox = await createInbox();
    await deliver(inbox.address, rawEmail(inbox.address));
    const {
      items: [message],
    } = (await (await api("/v1/messages")).json()) as { items: MessageSummaryDto[] };
    const notesPath = `/v1/messages/${message!.id}/notes`;
    const posted = await api(notesPath, write("POST", { body: "  <b>Investigate</b>  " }));
    expect(posted.status).toBe(201);
    const note = (await posted.json()) as NoteDto;
    expect(note).toMatchObject({
      messageId: message!.id,
      body: "<b>Investigate</b>",
      authorSubject: "key:bootstrap",
      authorIdentityId: null,
    });
    const list = await api(notesPath);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [note] });
    expect(await (await api("/v1/messages")).json()).toMatchObject({
      items: [{ id: message!.id, noteCount: 1 }],
    });

    const key = await api(
      "/v1/keys",
      write("POST", { name: "note reader", scopes: ["message:read"] }),
    );
    const { token } = (await key.json()) as { token: string };
    const notePath = `/v1/notes/${note.id}`;
    const headers = { Authorization: `Bearer ${token}` };
    await expectError(await api(notePath, { method: "DELETE", headers }), 403, "forbidden");
    await expectError(
      await api(`/v1/labels/${absent}`, { method: "DELETE", headers }),
      403,
      "forbidden",
    );
    expect((await api(notePath, { method: "DELETE" })).status).toBe(204);
    await expectError(
      await api(notesPath, write("POST", { body: "  " })),
      400,
      "invalid_argument",
    );
    await expectError(await api(`/v1/messages/${absent}/notes`), 404, "message_not_found");
  });
});
