import { describe, expect, it } from "vitest";
import type {
  AgentIdentity,
  EmailAddress,
  LoopVerdict,
  Scope,
} from "../../src/domain/index.ts";
import {
  EmailAddress as Address,
  AgentIdentity as Identity,
  SendPolicy,
} from "../../src/domain/index.ts";

const addr = (value: string): EmailAddress => Address.parse(value);
const NO_LOOP: LoopVerdict = { looping: false, reason: null, detail: null };
const FULL_SCOPES: Scope[] = ["message:send"];

function identity(
  overrides: Partial<Parameters<typeof Identity.create>[0]> = {},
): AgentIdentity {
  return Identity.create({
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as AgentIdentity["id"],
    accountId: "default" as AgentIdentity["accountId"],
    name: "reporter",
    now: new Date("2026-07-01T00:00:00Z"),
    ...overrides,
  });
}

function evaluate(overrides: Partial<Parameters<typeof SendPolicy.evaluate>[0]> = {}) {
  return SendPolicy.evaluate({
    scopes: FULL_SCOPES,
    identity: null,
    from: addr("agent@mail.example.com"),
    recipients: [addr("user@corp.com")],
    suppressedRecipients: [],
    sentInWindow: 0,
    loop: NO_LOOP,
    ...overrides,
  });
}

describe("SendPolicy", () => {
  it("allows a plain send with the right scope", () => {
    expect(evaluate()).toEqual({ kind: "allow" });
  });

  it("rejects a credential without message:send", () => {
    const decision = evaluate({ scopes: ["message:read"] });
    expect(decision).toMatchObject({ kind: "reject", code: "forbidden" });
  });

  it("lets admin stand in for any scope", () => {
    expect(evaluate({ scopes: ["admin"] })).toEqual({ kind: "allow" });
  });

  it("refuses a From address the identity may not use", () => {
    const decision = evaluate({
      identity: identity({ sendAs: "reports-*@mail.example.com" }),
      from: addr("ceo@mail.example.com"),
    });
    expect(decision).toMatchObject({ kind: "reject", code: "send_rejected" });
  });

  it("enforces the recipient allowlist and names who was blocked", () => {
    const decision = evaluate({
      identity: identity({ recipientAllowlist: ["*@corp.com"] }),
      recipients: [addr("ok@corp.com"), addr("nope@elsewhere.com")],
    });
    expect(decision).toMatchObject({ kind: "reject", code: "send_rejected" });
    if (decision.kind === "reject") {
      expect(decision.details["blocked"]).toEqual(["nope@elsewhere.com"]);
    }
  });

  it("treats an empty allowlist as 'may send to nobody'", () => {
    const decision = evaluate({ identity: identity({ recipientAllowlist: [] }) });
    expect(decision.kind).toBe("reject");
  });

  it("refuses suppressed recipients", () => {
    const decision = evaluate({ suppressedRecipients: [addr("user@corp.com")] });
    expect(decision).toMatchObject({ kind: "reject", code: "suppressed_recipient" });
  });

  it("refuses once the identity quota is spent", () => {
    const decision = evaluate({
      identity: identity({ dailySendQuota: 5 }),
      sentInWindow: 5,
    });
    expect(decision).toMatchObject({ kind: "reject", code: "quota_exceeded" });
  });

  it("refuses a send the loop breaker flagged", () => {
    const decision = evaluate({
      loop: { looping: true, reason: "too_many_exchanges", detail: "10 in an hour" },
    });
    expect(decision).toMatchObject({ kind: "reject", code: "loop_detected" });
  });

  it("asks for approval only after every rejecting gate has passed", () => {
    // The ordering that matters: a message that would be rejected must not land
    // in a human's approval queue.
    const approving = identity({ requireApproval: true, dailySendQuota: 1 });
    expect(evaluate({ identity: approving, sentInWindow: 1 })).toMatchObject({
      kind: "reject",
      code: "quota_exceeded",
    });
    expect(evaluate({ identity: approving, sentInWindow: 0 })).toMatchObject({
      kind: "require_approval",
    });
  });

  it("carries the rejection code onto the thrown error", () => {
    const decision = evaluate({ suppressedRecipients: [addr("user@corp.com")] });
    if (decision.kind !== "reject") throw new Error("expected a rejection");
    expect(SendPolicy.toError(decision).code).toBe("suppressed_recipient");
  });
});
