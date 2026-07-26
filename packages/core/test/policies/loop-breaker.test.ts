import { describe, expect, it } from "vitest";
import { LoopBreakerPolicy } from "../../src/domain/index.ts";

function check(overrides: Partial<Parameters<typeof LoopBreakerPolicy.check>[0]> = {}) {
  return LoopBreakerPolicy.check({
    referencesDepth: 1,
    exchangesInWindow: 0,
    inboundAutoSubmitted: null,
    automated: false,
    selfAddressed: false,
    ...overrides,
  });
}

describe("LoopBreakerPolicy", () => {
  it("passes an ordinary send", () => {
    expect(check().looping).toBe(false);
  });

  it("stops a message addressed to its own sender", () => {
    expect(check({ selfAddressed: true })).toMatchObject({
      looping: true,
      reason: "self_addressed",
    });
  });

  it("stops a reference chain deeper than the limit", () => {
    expect(check({ referencesDepth: LoopBreakerPolicy.MAX_REFERENCES_DEPTH }).looping).toBe(
      false,
    );
    expect(
      check({ referencesDepth: LoopBreakerPolicy.MAX_REFERENCES_DEPTH + 1 }),
    ).toMatchObject({ looping: true, reason: "references_too_deep" });
  });

  it("stays clear of the provider's own References ceiling", () => {
    // Cloudflare truncates at 100; tripping only at 100 would be too late.
    expect(LoopBreakerPolicy.MAX_REFERENCES_DEPTH).toBeLessThan(100);
  });

  it("stops too many exchanges with one counterparty", () => {
    expect(
      check({ exchangesInWindow: LoopBreakerPolicy.MAX_EXCHANGES_PER_WINDOW }),
    ).toMatchObject({ looping: true, reason: "too_many_exchanges" });
  });

  it("stops an automated reply to an automated message", () => {
    expect(check({ automated: true, inboundAutoSubmitted: "auto-replied" })).toMatchObject({
      looping: true,
      reason: "replying_to_automated",
    });
  });

  it("lets a human reply to an autoresponder", () => {
    // Only the bot-to-bot case is a loop. Blocking humans here would be wrong.
    expect(check({ automated: false, inboundAutoSubmitted: "auto-replied" }).looping).toBe(
      false,
    );
  });

  it("lets an agent reply to a human", () => {
    expect(check({ automated: true, inboundAutoSubmitted: "no" }).looping).toBe(false);
    expect(check({ automated: true, inboundAutoSubmitted: null }).looping).toBe(false);
  });

  it("reads Auto-Submitted per RFC 3834", () => {
    expect(LoopBreakerPolicy.isAutomated(null)).toBe(false);
    expect(LoopBreakerPolicy.isAutomated("no")).toBe(false);
    expect(LoopBreakerPolicy.isAutomated("No")).toBe(false);
    expect(LoopBreakerPolicy.isAutomated("auto-generated")).toBe(true);
    expect(LoopBreakerPolicy.isAutomated("auto-replied")).toBe(true);
  });

  it("labels our own outbound so peers can break the loop from their side", () => {
    expect(LoopBreakerPolicy.autoSubmittedHeader(true)).toBe("auto-replied");
    expect(LoopBreakerPolicy.autoSubmittedHeader(false)).toBe("no");
  });
});
