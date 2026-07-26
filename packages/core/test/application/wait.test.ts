import { ingestInboundEmail, waitForMessage } from "@core/application/index.ts";
import { Extract } from "@core/domain/index.ts";
import type { Harness } from "@core/testing/index.ts";
import { createHarness, rawEmail, TEST_DOMAIN } from "@core/testing/index.ts";
import { beforeEach, describe, expect, it } from "vitest";

let h: Harness;
let wait: ReturnType<typeof waitForMessage>;
const INBOX = `signup@${TEST_DOMAIN}`;

beforeEach(async () => {
  h = createHarness();
  wait = waitForMessage(h.deps);
  await h.seedInbox(INBOX);
});

async function deliver(body: string, subject = "Verify your email"): Promise<void> {
  await ingestInboundEmail(h.deps)(h.ctx, {
    recipient: INBOX,
    envelopeFrom: "noreply@service.com",
    raw: rawEmail({
      from: "noreply@service.com",
      to: INBOX,
      subject,
      body,
      messageId: `${Math.random()}@service.com`,
    }),
  });
}

describe("waitForMessage", () => {
  it("returns a timeout as an outcome, not an error", async () => {
    const result = await wait(h.ctx, { timeoutMs: 1000 });
    // The CLI turns this into exit code 4, so a script can tell "no mail yet"
    // apart from "your request was wrong".
    expect(result.outcome).toBe("timeout");
  });

  it("matches on subject", async () => {
    await deliver("hello", "Your receipt");
    const result = await wait(h.ctx, { subject: "receipt", timeoutMs: 1000 });
    expect(result.outcome).toBe("matched");
  });

  it("matches on a regular expression over subject and body", async () => {
    await deliver("Your code is 483920.");
    const result = await wait(h.ctx, { match: "code is \\d+", timeoutMs: 1000 });
    expect(result.outcome).toBe("matched");
  });

  it("rejects an invalid regex up front rather than mid-wait", async () => {
    await expect(wait(h.ctx, { match: "([unclosed", timeoutMs: 1000 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("refuses a timeout beyond the ceiling", async () => {
    await expect(wait(h.ctx, { timeoutMs: 60 * 60 * 1000 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  it("extracts the OTP so a caller needs no second step", async () => {
    await deliver("Your verification code is 483920. It expires in 10 minutes.");
    const result = await wait(h.ctx, { extract: "otp", timeoutMs: 1000 });

    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") return;
    expect(result.extracted).toBe("483920");
  });

  it("extracts the first link", async () => {
    await deliver("Confirm at https://service.com/verify?t=abc123. Thanks!");
    const result = await wait(h.ctx, { extract: "link", timeoutMs: 1000 });

    if (result.outcome !== "matched") throw new Error("expected a match");
    // The trailing period must not ride along into the URL.
    expect(result.extracted).toBe("https://service.com/verify?t=abc123");
  });

  it("requires message:read", async () => {
    await expect(wait(h.withScopes(["inbox:read"]), { timeoutMs: 1000 })).rejects.toMatchObject(
      { code: "forbidden" },
    );
  });
});

describe("Extract", () => {
  it("prefers a labelled code over an unrelated number", () => {
    expect(Extract.otp("Order 12 shipped. Your code is 998877.")).toBe("998877");
  });

  it("handles the 'X is your code' phrasing", () => {
    expect(Extract.otp("483920 is your Twitter confirmation code")).toBe("483920");
  });

  it("returns null when there is nothing code-like", () => {
    expect(Extract.otp("Thanks for signing up!")).toBeNull();
  });

  it("keeps balanced parentheses inside a URL", () => {
    expect(Extract.links("see https://en.wikipedia.org/wiki/Foo_(bar) now")).toEqual([
      "https://en.wikipedia.org/wiki/Foo_(bar)",
    ]);
  });

  it("deduplicates repeated links", () => {
    expect(Extract.links("a https://x.com/1 b https://x.com/1")).toEqual(["https://x.com/1"]);
  });
});
