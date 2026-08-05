import type { Caller, DispatchRequest, RfcMessageId } from "@mailworker/core";
import { CloudflareTransport } from "@web/workers/adapters";
import { describe, expect, it } from "vitest";

const caller = {} as Caller;

function request(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    from: "agent@example.com",
    fromName: null,
    to: ["someone@example.net"],
    cc: [],
    bcc: [],
    replyTo: null,
    subject: "Hello",
    text: "Hello",
    html: null,
    messageId: "01J0@example.com" as RfcMessageId,
    inReplyTo: null,
    references: [],
    headers: {},
    attachments: [],
    ...overrides,
  } as DispatchRequest;
}

/** Captures what reached the binding, and answers the way `send` does. */
function spy() {
  const calls: EmailMessageBuilder[] = [];
  const binding = {
    send: async (message: EmailMessageBuilder) => {
      calls.push(message);
      return { messageId: "cf-1" };
    },
  } as unknown as SendEmail;
  return { binding, calls };
}

describe("CloudflareTransport", () => {
  it("never sends Message-ID, which the header allowlist rejects", async () => {
    // Email Sending mints its own and answers E_HEADER_NOT_ALLOWED to ours —
    // a permanent failure for every send, which is how this reached production
    // once already.
    const { binding, calls } = spy();
    await new CloudflareTransport(binding).dispatch(caller, request());

    const headers = calls[0]!.headers!;
    expect(Object.keys(headers)).not.toContain("Message-ID");
    expect(headers["X-Mailworker-Message-ID"]).toBe("<01J0@example.com>");
  });

  it("appends our own id to References so replies thread back to us", async () => {
    // The recipient replies against Cloudflare's Message-ID, which we have
    // never seen. The chain is the only id in the reply we can recognise.
    const { binding, calls } = spy();
    await new CloudflareTransport(binding).dispatch(
      caller,
      request({
        inReplyTo: "parent@example.net" as RfcMessageId,
        references: ["root@example.net" as RfcMessageId],
      }),
    );

    expect(calls[0]!.headers!["References"]).toBe("<root@example.net> <01J0@example.com>");
    expect(calls[0]!.headers!["In-Reply-To"]).toBe("<parent@example.net>");
  });

  it("reports a rejected header as permanent rather than retrying it", async () => {
    const binding = {
      send: async () => {
        throw new Error("custom header 'Message-ID' is not allowed.");
      },
    } as unknown as SendEmail;

    const result = await new CloudflareTransport(binding).dispatch(caller, request());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.retryable).toBe(false);
  });
});
