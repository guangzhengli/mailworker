import { agentIdentityDto } from "@contract/identity";
import { scope } from "@contract/primitives";
import { z } from "zod";

/**
 * `GET /v1/capabilities` — what this credential can safely attempt here.
 *
 * This is intentionally a description, not an authorization token. Every
 * operation still checks its scope and policy at execution time; the endpoint
 * exists so an agent can plan without learning those boundaries by failing.
 */
export const capabilitiesDto = z.object({
  apiVersion: z.literal("v1"),
  serverTime: z.iso.datetime(),
  environment: z.object({
    id: z.string(),
    mode: z.enum(["live", "sandbox", "test"]),
  }),
  principal: z.object({
    subject: z.string(),
    identityId: z.string().nullable(),
    identity: agentIdentityDto.nullable(),
    scopes: z.array(scope),
  }),
  domains: z.array(
    z.object({
      domain: z.string(),
      sendingStatus: z.string(),
      catchAllMode: z.enum(["reject", "store", "autocreate"]),
    }),
  ),
  features: z.object({
    receiving: z.boolean(),
    sending: z.boolean(),
    sandboxLoopback: z.boolean(),
    approvals: z.literal(true),
    longPolling: z.literal(true),
    deliveryTimeline: z.literal(true),
    webhooksConfigured: z.boolean(),
    typescriptSdk: z.literal(true),
    /** False when talking to a Worker that predates labels and notes. */
    labels: z.boolean().default(false),
    notes: z.boolean().default(false),
  }),
  limits: z.object({
    maxPageSize: z.number().int().positive(),
    maxWaitMs: z.number().int().positive(),
    maxWaitMatchTextBytes: z.number().int().positive(),
    maxRecipients: z.number().int().positive(),
    /** @deprecated Use maxOutboundMessageBytes. */
    maxMessageBytes: z.number().int().positive(),
    maxInboundMessageBytes: z.number().int().positive(),
    maxOutboundMessageBytes: z.number().int().positive(),
    maxAttachments: z.number().int().positive(),
    maxCustomHeaderBytes: z.number().int().positive(),
    maxBatchSize: z.number().int().positive(),
  }),
  actions: z.object({
    readInboxes: z.boolean(),
    createInboxes: z.boolean(),
    readMessages: z.boolean(),
    annotateMessages: z.boolean().default(false),
    injectMessages: z.boolean(),
    sendMessages: z.boolean(),
    approveMessages: z.boolean(),
    administer: z.boolean(),
  }),
});

export type CapabilitiesDto = z.infer<typeof capabilitiesDto>;
