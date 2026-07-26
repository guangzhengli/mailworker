import type { BuildMimeSpec, EmailAddress, RfcMessageId } from "@mailworker/core";
import { encodeHeaderValue, Rfc5322Builder } from "@mime/build.ts";
import { PostalMimeParser } from "@mime/parse.ts";
import { describe, expect, it } from "vitest";

const builder = new Rfc5322Builder();
const parser = new PostalMimeParser();

function spec(overrides: Partial<BuildMimeSpec> = {}): BuildMimeSpec {
  return {
    from: "agent@mail.example.com" as EmailAddress,
    fromName: null,
    to: ["user@corp.com" as EmailAddress],
    cc: [],
    subject: "Report",
    text: "Body text",
    html: null,
    messageId: "build1@mail.example.com" as RfcMessageId,
    inReplyTo: null,
    references: [],
    date: new Date("2026-07-01T12:00:00Z"),
    headers: {},
    ...overrides,
  };
}

const build = async (overrides: Partial<BuildMimeSpec> = {}) =>
  new TextDecoder().decode(await builder.build(spec(overrides)));

describe("Rfc5322Builder", () => {
  it("uses CRLF line endings", async () => {
    const raw = await build();
    // LF-only output breaks header parsing in strict readers.
    expect(raw).toContain("\r\n");
    expect(raw.split("\r\n").join("")).not.toContain("\n");
  });

  it("writes an RFC 5322 date", async () => {
    expect(await build()).toContain("Date: Wed, 01 Jul 2026 12:00:00 +0000");
  });

  it("brackets the Message-ID", async () => {
    expect(await build()).toContain("Message-ID: <build1@mail.example.com>");
  });

  it("emits multipart/alternative with plain before html", async () => {
    const raw = await build({ text: "plain", html: "<p>rich</p>" });
    expect(raw).toContain("multipart/alternative");
    // RFC 2046: least-rich first, because a client picks the last part it groks.
    expect(raw.indexOf("text/plain")).toBeLessThan(raw.indexOf("text/html"));
  });

  it("round-trips through the parser", async () => {
    const raw = await builder.build(
      spec({ subject: "Round trip", text: "plain body", html: "<p>rich body</p>" }),
    );
    const parsed = await parser.parse(raw);

    expect(parsed.subject).toBe("Round trip");
    expect(parsed.rfcMessageId).toBe("build1@mail.example.com");
    expect(parsed.from).toBe("agent@mail.example.com");
    expect(parsed.bodyText?.trim()).toBe("plain body");
    expect(parsed.bodyHtml).toContain("rich body");
  });

  it("round-trips a Chinese subject and body", async () => {
    // The case that motivated the encoded-word work: a CJK subject must survive
    // the trip and come back decoded, not as =?UTF-8?B?…?=.
    const raw = await builder.build(
      spec({ subject: "成功登录你的账户", text: "你的验证码是 483920。" }),
    );
    const parsed = await parser.parse(raw);

    expect(parsed.subject).toBe("成功登录你的账户");
    expect(parsed.bodyText?.trim()).toBe("你的验证码是 483920。");
  });

  it("round-trips a long Chinese subject without splitting a character", async () => {
    // An encoded word caps at 75 chars, so a long subject spans several. Cutting
    // mid-codepoint renders as mojibake in every client.
    const subject = "这是一个非常长的主题".repeat(8);
    const parsed = await parser.parse(await builder.build(spec({ subject })));
    expect(parsed.subject).toBe(subject);
  });

  it("keeps encoded words within the 75-character limit", async () => {
    const encoded = encodeHeaderValue("这是一个非常长的主题".repeat(8));
    for (const word of encoded.split("\r\n ")) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it("leaves an ASCII subject unencoded", async () => {
    expect(encodeHeaderValue("Plain ASCII subject")).toBe("Plain ASCII subject");
  });

  it("round-trips threading headers", async () => {
    const raw = await builder.build(
      spec({
        inReplyTo: "second@corp.com" as RfcMessageId,
        references: ["first@corp.com", "second@corp.com"] as RfcMessageId[],
      }),
    );
    const parsed = await parser.parse(raw);
    expect(parsed.inReplyTo).toBe("second@corp.com");
    expect(parsed.references).toEqual(["first@corp.com", "second@corp.com"]);
  });

  it("passes custom headers through", async () => {
    const raw = await build({ headers: { "Auto-Submitted": "auto-replied" } });
    expect(raw).toContain("Auto-Submitted: auto-replied");
  });

  it("refuses to let a custom header duplicate a structural one", async () => {
    // Two From headers make the message ambiguous, and which one wins is
    // reader-dependent — a spoofing surface, not a formatting nit.
    const raw = await build({ headers: { From: "attacker@evil.com", "Content-Type": "x/y" } });
    expect(raw.match(/^From: /gm)).toHaveLength(1);
    expect(raw).not.toContain("attacker@evil.com");
  });

  it("encodes a non-ASCII display name", async () => {
    const raw = await build({ fromName: "客服团队" });
    expect(raw).toContain("=?UTF-8?B?");
    const parsed = await parser.parse(new TextEncoder().encode(raw));
    expect(parsed.fromHeader).toContain("客服团队");
  });

  it("folds a long References chain", async () => {
    const references = Array.from(
      { length: 12 },
      (_, i) => `msg-${i}@mail.example.com`,
    ) as RfcMessageId[];
    const raw = await build({ references });
    const parsed = await parser.parse(new TextEncoder().encode(raw));
    expect(parsed.references).toEqual(references);
    // No line may exceed the RFC 5322 ceiling.
    for (const line of raw.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });
});
