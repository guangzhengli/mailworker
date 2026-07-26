import type { SendResponse } from "@mailworker/contract";
import {
  addSuppressionBody,
  listDeliveriesQuery,
  sendBody,
  toDeliveryDto,
  toDeliveryEventDto,
} from "@mailworker/contract";
import { EmailAddress, Ulid } from "@mailworker/core";
import type { HttpEnv } from "@web/workers/http/env";
import { compact, invalid } from "@web/workers/http/errors";
import { Hono } from "hono";

/**
 * `/v1/send` — the outbound half.
 *
 * `POST` answers as soon as the decision is durable, not when the mail has
 * landed. Nothing is known about delivery at that moment (DESIGN §2.2): the
 * provider's own answer is a handoff receipt. `GET /v1/send/:id` is where the
 * timeline accumulates, minutes to days later, and that split is the whole
 * reason a `Delivery` is an aggregate rather than a log line.
 */
export const send = new Hono<HttpEnv>()

  .post("/", async (c) => {
    const parsed = sendBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalid(c, parsed.error);

    // The header wins over the body field. A proxy or an SDK retry wrapper sets
    // the header and cannot rewrite the body it was handed, so if the two
    // disagree the header is the one that came from whoever is doing the
    // retrying.
    const header = c.req.header("Idempotency-Key");
    const result = await c.var.services.delivery.send(c.var.caller, {
      ...parsed.data,
      ...(header === undefined ? {} : { idempotencyKey: header }),
    });

    const body: SendResponse = {
      outcome: result.outcome,
      delivery: toDeliveryDto(result.delivery),
    } as SendResponse;

    // 202 for a fresh send, because nothing has been delivered yet and 200
    // would claim otherwise. 200 for a duplicate: no new work was accepted, and
    // a caller retrying after a timeout is asking "did this already happen".
    // 202 for pending_approval too — accepted, awaiting a human.
    return c.json(body, result.outcome === "duplicate" ? 200 : 202);
  })

  .get("/", async (c) => {
    const parsed = listDeliveriesQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);

    const { identity, ...rest } = parsed.data;
    const page = await c.var.services.delivery.list(
      c.var.caller,
      compact({ ...rest, identityId: identity }),
    );
    return c.json({ items: page.items.map(toDeliveryDto), cursor: page.cursor });
  })

  .get("/:id", async (c) => {
    const { delivery, events } = await c.var.services.delivery.timeline(
      c.var.caller,
      Ulid.parse(c.req.param("id")),
    );
    return c.json({
      delivery: toDeliveryDto(delivery),
      events: events.map(toDeliveryEventDto),
    });
  })

  /**
   * Release a send that a policy gate held.
   *
   * Needs `message:approve`, which an agent must never hold — the point of the
   * queue is that the principal being approved and the principal approving are
   * different. The service records the caller's own subject as the approver;
   * there is no field for it here, because an audit trail the approver gets to
   * write is not an audit trail.
   */
  .post("/:id/approve", async (c) => {
    const delivery = await c.var.services.delivery.approve(
      c.var.caller,
      Ulid.parse(c.req.param("id")),
    );
    return c.json(toDeliveryDto(delivery));
  });

/**
 * `/v1/suppressions` — who we must not mail.
 *
 * Cloudflare keeps its own account-level list and adds hard bounces to it
 * automatically; this mirrors it so `SendPolicy` can refuse locally. Refusing
 * before the API call keeps a doomed attempt off the account's sending
 * reputation and, since API-level rejections do not count against quota, off
 * the bill.
 */
export const suppressions = new Hono<HttpEnv>()

  .get("/", async (c) => {
    const entries = await c.var.services.delivery.listSuppressions(c.var.caller);
    return c.json({
      items: entries.map((entry) => ({
        address: entry.address,
        reason: entry.reason,
        source: entry.source,
        createdAt: entry.createdAt.toISOString(),
      })),
    });
  })

  .post("/", async (c) => {
    const parsed = addSuppressionBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return invalid(c, parsed.error);

    await c.var.services.delivery.suppress(c.var.caller, {
      address: parsed.data.address,
      reason: parsed.data.reason ?? "manual",
      source: "local",
    });
    return c.body(null, 204);
  })

  .delete("/:address", async (c) => {
    await c.var.services.delivery.unsuppress(
      c.var.caller,
      EmailAddress.parse(decodeURIComponent(c.req.param("address"))),
    );
    return c.body(null, 204);
  });
