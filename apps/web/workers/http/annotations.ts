import { renameLabelBody, toLabelDto, toLabelUsageDto } from "@mailworker/contract";
import { Ulid } from "@mailworker/core";
import type { HttpEnv } from "@web/workers/http/env";
import { invalid } from "@web/workers/http/errors";
import { Hono } from "hono";

export const labels = new Hono<HttpEnv>()
  .get("/", async (c) => {
    const items = await c.var.services.mailbox.listLabels(c.var.caller);
    return c.json({ items: items.map(toLabelUsageDto) });
  })
  .patch("/:id", async (c) => {
    const parsed = renameLabelBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return invalid(c, parsed.error);
    const label = await c.var.services.mailbox.renameLabel(
      c.var.caller,
      Ulid.parse(c.req.param("id")),
      parsed.data.name,
    );
    return c.json(toLabelDto(label));
  })
  .delete("/:id", async (c) => {
    await c.var.services.mailbox.deleteLabel(c.var.caller, Ulid.parse(c.req.param("id")));
    return c.body(null, 204);
  });

export const notes = new Hono<HttpEnv>().delete("/:id", async (c) => {
  await c.var.services.mailbox.deleteNote(c.var.caller, Ulid.parse(c.req.param("id")));
  return c.body(null, 204);
});
