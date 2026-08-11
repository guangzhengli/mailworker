import type { MailboxService } from "@core/application";
import type { Harness } from "@core/testing";
import { createHarness, rawEmail, TEST_DOMAIN } from "@core/testing";
import { beforeEach, describe, expect, it } from "vitest";

let h: Harness;
let wait: MailboxService["wait"];
const INBOX = `signup@${TEST_DOMAIN}`;

beforeEach(async () => {
  h = createHarness();
  wait = h.services.mailbox.wait;
  await h.seedInbox(INBOX);
});

async function deliver(body: string, subject = "Verify your email"): Promise<void> {
  await h.services.ingestion.ingest(h.ctx, {
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

describe("mailbox.wait", () => {
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

  it("returns the whole body, leaving the reading to the caller", async () => {
    // The reason there is no server-side extract mode: a code is worthless
    // without the sentence around it, and no regex knows that.
    await deliver("Your code is 483920, but it expired. Request another.");
    const result = await wait(h.ctx, { timeoutMs: 1000 });

    if (result.outcome !== "matched") throw new Error("expected a match");
    expect(result.message.bodyText).toContain("483920");
    expect(result.message.bodyText).toContain("expired");
  });

  it("requires message:read", async () => {
    await expect(wait(h.withScopes(["inbox:read"]), { timeoutMs: 1000 })).rejects.toMatchObject(
      { code: "forbidden" },
    );
  });
});
