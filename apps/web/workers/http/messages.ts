import type { WaitResponse } from "@mailworker/contract";
import {
  ingestRawQuery,
  listMessagesQuery,
  seenBody,
  toMessageDto,
  toMessageSummaryDto,
  waitQuery,
} from "@mailworker/contract";
import { ThreadId, Ulid } from "@mailworker/core";
import { sanitizeHtml } from "@mailworker/mime";
import type { HttpEnv } from "@web/workers/http/env";
import { compact, failure, invalid } from "@web/workers/http/errors";
import { Hono } from "hono";

/**
 * Sanitizing on the way out, not on the way in.
 *
 * The original markup stays in the database and in R2, because `get --raw` has
 * to reproduce what actually arrived — a store that only kept the cleaned
 * version would make it impossible to investigate the mail that caused a
 * problem. So the cleaning happens per response, and the field is null if it
 * were ever to be omitted (see `MessageDtoOptions`).
 *
 * This is the second line of defence regardless. The first is the sandboxed
 * iframe and the CSP the dashboard renders inside.
 */
const dtoOptions = { sanitizeHtml: (html: string) => sanitizeHtml(html).html };

export const messages = new Hono<HttpEnv>()

  /**
   * The long poll. Registered before `/:id` because Hono matches in order and
   * `wait` would otherwise be read as a message id — which would answer
   * `invalid_ulid` to the single most important call in the product.
   */
  .get("/wait", async (c) => {
    const parsed = waitQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);

    const outcome = await c.var.services.mailbox.wait(c.var.caller, parsed.data);

    // A timeout is 200 with an outcome, not an error status. The caller asked a
    // question — "has it arrived?" — and "not yet" is an answer to it. Only the
    // CLI turns that into a non-zero exit code, because a shell script wants a
    // branch where an HTTP client wants a body.
    const body: WaitResponse =
      outcome.outcome === "timeout"
        ? { outcome: "timeout", waitedMs: outcome.waitedMs }
        : {
            outcome: "matched",
            message: toMessageDto(outcome.message, dtoOptions),
            extracted: outcome.extracted,
          };
    return c.json(body);
  })

  .get("/", async (c) => {
    const parsed = listMessagesQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);

    const { inbox, thread, ...rest } = parsed.data;
    const page = await c.var.services.mailbox.listMessages(
      c.var.caller,
      compact({
        ...rest,
        inboxId: inbox,
        threadId: thread === undefined ? undefined : ThreadId.parse(thread),
      }),
    );
    return c.json({ items: page.items.map(toMessageSummaryDto), cursor: page.cursor });
  })

  .get("/:id", async (c) => {
    const message = await c.var.services.mailbox.getMessage(
      c.var.caller,
      Ulid.parse(c.req.param("id")),
    );
    return c.json(toMessageDto(message, dtoOptions));
  })

  /**
   * The original bytes. Half of the `get --raw > fixture.eml` → `inject` loop.
   *
   * `message/rfc822` and an attachment disposition, so a browser saves it and a
   * shell redirect produces a file that other mail tools can open.
   */
  .get("/:id/raw", async (c) => {
    const id = Ulid.parse(c.req.param("id"));
    const raw = await c.var.services.mailbox.getRawMessage(c.var.caller, id);
    return c.body(raw as unknown as ArrayBuffer, 200, {
      "Content-Type": "message/rfc822",
      "Content-Disposition": `attachment; filename="${id}.eml"`,
    });
  })

  .get("/:id/attachments/:attachmentId", async (c) => {
    const { meta, content } = await c.var.services.mailbox.getAttachment(
      c.var.caller,
      Ulid.parse(c.req.param("id")),
      Ulid.parse(c.req.param("attachmentId")),
    );
    return c.body(content as unknown as ArrayBuffer, 200, {
      // Never the sender's declared type verbatim: `text/html` from a stranger,
      // served from our origin, is a stored XSS. The bytes are what was sent;
      // how the browser is told to treat them is our decision.
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(meta.filename ?? meta.id)}"`,
    });
  })

  .post("/:id/seen", async (c) => {
    const parsed = seenBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalid(c, parsed.error);

    await c.var.services.mailbox.markSeen(
      c.var.caller,
      Ulid.parse(c.req.param("id")),
      parsed.data.seen ?? true,
    );
    return c.body(null, 204);
  });

export const threads = new Hono<HttpEnv>().get("/:id", async (c) => {
  const thread = await c.var.services.mailbox.getThread(
    c.var.caller,
    ThreadId.parse(c.req.param("id")),
  );
  return c.json({ items: thread.map((m) => toMessageDto(m, dtoOptions)) });
});

/**
 * `POST /v1/ingest/raw` — what `mailworker inject` calls.
 *
 * The same service method the `email()` handler uses, with the same parsing and
 * the same policies. That is the entire point: a fixture replayed here goes
 * through the code that runs in production, so reproducing a parser bug on a
 * laptop reproduces it on the deployment.
 */
export const ingest = new Hono<HttpEnv>().post("/raw", async (c) => {
  const parsed = ingestRawQuery.safeParse(c.req.query());
  if (!parsed.success) return invalid(c, parsed.error);

  const raw = new Uint8Array(await c.req.arrayBuffer());
  if (raw.byteLength === 0) {
    return failure(c, "invalid_argument", "Send the raw message as the request body.");
  }

  const result = await c.var.services.ingestion.ingest(c.var.caller, {
    recipient: parsed.data.to,
    envelopeFrom: parsed.data.from ?? "inject@localhost",
    raw,
  });

  switch (result.outcome) {
    case "stored":
      return c.json(
        { outcome: "stored", message: toMessageDto(result.message, dtoOptions) },
        201,
      );
    case "duplicate":
      // Already have it, byte-identical or not — the RFC message id decides.
      // 200 rather than 201 or a conflict: injecting the same fixture twice is
      // normal in a test loop and is not a mistake worth an error for.
      return c.json({ outcome: "duplicate", messageId: result.rfcMessageId });
    case "unroutable":
      return failure(c, "unroutable_address", `No inbox accepts mail at ${parsed.data.to}.`, {
        reason: result.reason,
      });
    case "inbox_unavailable":
      return failure(
        c,
        "inbox_expired",
        `The inbox at ${parsed.data.to} cannot receive mail.`,
        {
          reason: result.reason,
        },
      );
  }
});
