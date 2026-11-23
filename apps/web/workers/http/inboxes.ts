import {
  createInboxBody,
  listInboxesQuery,
  toInboxDto,
  updateInboxBody,
} from "@mailworker/contract";
import { Ulid } from "@mailworker/core";
import type { HttpEnv } from "@web/workers/http/env";
import { compact, invalid } from "@web/workers/http/errors";
import { Hono } from "hono";

/**
 * `/v1/inboxes` — mint and manage receiving addresses.
 *
 * Every handler is the same four steps: parse with a contract schema, call one
 * service method, map to a DTO, answer. Anything that looks like a decision
 * belongs in `mailbox-service`, where it can be tested without a request.
 */
export const inboxes = new Hono<HttpEnv>()

  .post("/", async (c) => {
    const parsed = createInboxBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalid(c, parsed.error);

    const inbox = await c.var.services.mailbox.createInbox(c.var.caller, parsed.data);
    return c.json(toInboxDto(inbox), 201);
  })

  .get("/", async (c) => {
    const parsed = listInboxesQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);

    const page = await c.var.services.mailbox.listInboxes(c.var.caller, compact(parsed.data));
    return c.json({ items: page.items.map(toInboxDto), cursor: page.cursor });
  })

  .get("/:id", async (c) => {
    const inbox = await c.var.services.mailbox.getInbox(
      c.var.caller,
      Ulid.parse(c.req.param("id")),
    );
    return c.json(toInboxDto(inbox));
  })

  .patch("/:id", async (c) => {
    const parsed = updateInboxBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c, parsed.error);
    const inbox = await c.var.services.mailbox.updateInbox(
      c.var.caller,
      Ulid.parse(c.req.param("id")),
      compact(parsed.data),
    );
    return c.json(toInboxDto(inbox));
  })

  .delete("/:id", async (c) => {
    await c.var.services.mailbox.deleteInbox(c.var.caller, Ulid.parse(c.req.param("id")));
    return c.body(null, 204);
  });
