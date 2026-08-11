import type { Caller, DispatchRequest, RfcMessageId } from "@mailworker/core";
import { CloudflareTransport } from "@web/workers/adapters";
import { classifyFailure } from "@web/workers/adapters/transport";
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

/**
 * Whether a failed send is tried again.
 *
 * Worth testing at this granularity because the two code conventions in play
 * are inverses of each other: over SMTP 4xx means "try again later" and 5xx
 * means "never", while over HTTP 4xx is the caller's fault and 5xx is the
 * server's. Reading one as the other is not a near miss — it is wrong in every
 * case, in the direction that either burns quota against a wall or silently
 * drops mail that would have gone out a minute later.
 */
describe("classifyFailure", () => {
  it("reads an SMTP code the RFC 5321 way", () => {
    expect(classifyFailure({ smtpCode: 451 }, "")).toEqual({
      retryable: true,
      decidedBy: "smtp",
    });
    expect(classifyFailure({ smtpCode: 550 }, "")).toEqual({
      retryable: false,
      decidedBy: "smtp",
    });
  });

  it("reads an HTTP status the opposite way, which is also correct", () => {
    // 4xx over HTTP is the request being wrong; retrying sends the same wrong
    // request again.
    expect(classifyFailure({ status: 400 }, "").retryable).toBe(false);
    expect(classifyFailure({ status: 403 }, "").retryable).toBe(false);
    // The two 4xx exceptions, both of which mean "the same request, later".
    expect(classifyFailure({ status: 408 }, "").retryable).toBe(true);
    expect(classifyFailure({ status: 429 }, "").retryable).toBe(true);
    expect(classifyFailure({ status: 503 }, "").retryable).toBe(true);
    // Named individually rather than taken as a range: 501 is a 5xx that will
    // never succeed however many times it is asked.
    expect(classifyFailure({ status: 501 }, "").retryable).toBe(false);
  });

  it("prefers the SMTP code when both are present", () => {
    // A 200-level HTTP call carrying a 5xx SMTP reply is a delivered request
    // reporting a refused message. The SMTP code is the one about the mail.
    expect(classifyFailure({ status: 200, smtpCode: 550 }, "")).toEqual({
      retryable: false,
      decidedBy: "smtp",
    });
  });

  it("ignores a number that is not a status at all", () => {
    // Cloudflare error numbers live in the same `code` field shape and are not
    // three digits. Reading 10021 as a status would classify by accident.
    expect(classifyFailure({ code: 10021 }, "rate limited").decidedBy).toBe("prose");
  });

  it("falls back to wording, and says that is what it did", () => {
    expect(
      classifyFailure(new Error("Rate limited, try again"), "Rate limited, try again"),
    ).toEqual({ retryable: true, decidedBy: "prose" });
    // The default is not-retryable, so an unrecognised error stops rather than
    // looping: a stuck message is a support question, a looping one is a bill.
    expect(classifyFailure(new Error("nope"), "nope")).toEqual({
      retryable: false,
      decidedBy: "prose",
    });
  });

  it("does not read a bare number in the text as a status", () => {
    // `421` is transient over SMTP and permanent over HTTP. A number floating
    // in an error string does not say which, so it must not decide anything.
    expect(
      classifyFailure(new Error("exceeded 421 recipients"), "exceeded 421 recipients"),
    ).toEqual({ retryable: false, decidedBy: "prose" });
  });
});
