import { type CapabilitiesDto, toAgentIdentityDto } from "@mailworker/contract";
import {
  Caller,
  MAX_INBOUND_MESSAGE_BYTES,
  MAX_PAGE_SIZE,
  MAX_WAIT_TIMEOUT_MS,
  SENDING_LIMITS,
  WAIT_MATCH_TEXT_BYTES,
} from "@mailworker/core";
import type { HttpEnv } from "@web/workers/http/env";
import { Hono } from "hono";

/**
 * A credential-readable description of this environment's usable surface.
 *
 * This avoids an agent probing irreversible operations just to discover its
 * boundary. It remains advisory: every endpoint still performs authorization
 * and policy checks at execution time.
 */
export const capabilities = new Hono<HttpEnv>().get("/", async (c) => {
  const caller = c.var.caller;
  const [identity, domains] = await Promise.all([
    caller.identityId === null
      ? Promise.resolve(null)
      : c.var.container.identities.findById(caller, caller.identityId),
    c.var.container.domains.list(caller),
  ]);

  const body: CapabilitiesDto = {
    apiVersion: "v1",
    serverTime: new Date().toISOString(),
    environment: { id: caller.accountId, mode: caller.mode },
    principal: {
      subject: caller.subject,
      identityId: caller.identityId,
      identity: identity === null ? null : toAgentIdentityDto(identity),
      scopes: [...caller.scopes],
    },
    domains: domains.map((domain) => ({
      domain: domain.domain,
      sendingStatus: domain.sendingStatus,
      catchAllMode: domain.catchAllMode,
    })),
    features: {
      receiving: domains.length > 0,
      sending: caller.mode === "sandbox" || c.env.SEND_EMAIL !== undefined,
      sandboxLoopback: caller.mode === "sandbox",
      approvals: true,
      longPolling: true,
      deliveryTimeline: true,
      webhooksConfigured: c.env.WEBHOOK_QUEUE !== undefined,
      typescriptSdk: true,
      labels: true,
      notes: true,
    },
    limits: {
      maxPageSize: MAX_PAGE_SIZE,
      maxWaitMs: MAX_WAIT_TIMEOUT_MS,
      maxWaitMatchTextBytes: WAIT_MATCH_TEXT_BYTES,
      maxRecipients: SENDING_LIMITS.MAX_RECIPIENTS,
      maxMessageBytes: SENDING_LIMITS.MAX_MESSAGE_BYTES,
      maxInboundMessageBytes: MAX_INBOUND_MESSAGE_BYTES,
      maxOutboundMessageBytes: SENDING_LIMITS.MAX_MESSAGE_BYTES,
      maxAttachments: SENDING_LIMITS.MAX_ATTACHMENTS,
      maxCustomHeaderBytes: SENDING_LIMITS.MAX_HEADER_BYTES,
      maxBatchSize: SENDING_LIMITS.MAX_BATCH,
    },
    actions: {
      readInboxes: Caller.has(caller, "inbox:read"),
      createInboxes: Caller.has(caller, "inbox:write"),
      readMessages: Caller.has(caller, "message:read"),
      annotateMessages: Caller.has(caller, "message:read"),
      injectMessages: Caller.has(caller, "message:inject"),
      sendMessages: Caller.has(caller, "message:send"),
      approveMessages: caller.identityId === null && Caller.has(caller, "message:approve"),
      administer: Caller.has(caller, "admin"),
    },
  };

  return c.json(body);
});
