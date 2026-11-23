import { capabilitiesDto } from "@mailworker/contract";
import { describe, expect, it } from "vitest";

describe("capabilities contract", () => {
  it("describes a credential boundary without turning it into authorization", () => {
    const value = capabilitiesDto.parse({
      apiVersion: "v1",
      serverTime: "2026-08-12T00:00:00.000Z",
      environment: { id: "default", mode: "sandbox" },
      principal: {
        subject: "key:mw_sbx_abc123",
        identityId: null,
        identity: null,
        scopes: ["message:read"],
      },
      domains: [
        { domain: "mail.example.com", sendingStatus: "verified", catchAllMode: "reject" },
      ],
      features: {
        receiving: true,
        sending: true,
        sandboxLoopback: true,
        approvals: true,
        longPolling: true,
        deliveryTimeline: true,
        webhooksConfigured: false,
        typescriptSdk: true,
        labels: true,
        notes: true,
      },
      limits: {
        maxPageSize: 200,
        maxWaitMs: 300_000,
        maxWaitMatchTextBytes: 64 * 1024,
        maxRecipients: 50,
        maxMessageBytes: 5 * 1024 * 1024,
        maxInboundMessageBytes: 25 * 1024 * 1024,
        maxOutboundMessageBytes: 5 * 1024 * 1024,
        maxAttachments: 20,
        maxCustomHeaderBytes: 16 * 1024,
        maxBatchSize: 100,
      },
      actions: {
        readInboxes: false,
        createInboxes: false,
        readMessages: true,
        annotateMessages: true,
        injectMessages: false,
        sendMessages: false,
        approveMessages: false,
        administer: false,
      },
    });

    expect(value.principal.scopes).toEqual(["message:read"]);
    expect(value.actions.sendMessages).toBe(false);
  });
});
