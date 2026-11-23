import { PostalMimeParser } from "@mime/parse";
import { describe, expect, it } from "vitest";

const parser = new PostalMimeParser();
const parse = (raw: string) => parser.parse(new TextEncoder().encode(raw));

describe("PostalMimeParser", () => {
  it("exposes mailing-list header values and uses null when absent", async () => {
    const parsed = await parse(
      [
        "From: sender@example.com",
        "To: recipient@example.com",
        "List-Id: Weekly Digest <digest.example.com>",
        "List-Unsubscribe: <mailto:leave@example.com>, <https://example.com/leave>",
        "List-Unsubscribe-Post: List-Unsubscribe=One-Click",
        "",
        "Hello",
      ].join("\r\n"),
    );
    expect(parsed).toMatchObject({
      listId: "Weekly Digest <digest.example.com>",
      listUnsubscribe: "<mailto:leave@example.com>, <https://example.com/leave>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
    });
    await expect(parse("From: sender@example.com\r\n\r\nHello")).resolves.toMatchObject({
      listId: null,
      listUnsubscribe: null,
      listUnsubscribePost: null,
    });
  });

  it("parses a multipart/alternative message into both bodies", async () => {
    const parsed = await parse(
      [
        "From: Alice <alice@corp.com>",
        "To: support@mail.example.com",
        "Subject: Hello",
        "Message-ID: <m1@corp.com>",
        'Content-Type: multipart/alternative; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "plain version",
        "--b1",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>html version</p>",
        "--b1--",
        "",
      ].join("\r\n"),
    );

    expect(parsed.bodyText?.trim()).toBe("plain version");
    expect(parsed.bodyHtml).toContain("html version");
    expect(parsed.rfcMessageId).toBe("m1@corp.com");
  });

  it("decodes an RFC 2047 encoded subject", async () => {
    // A CJK subject arrives base64-wrapped; a consumer must never see the
    // =?UTF-8?B?…?= form.
    const parsed = await parse(
      [
        "From: a@corp.com",
        "To: b@mail.example.com",
        "Subject: =?UTF-8?B?5oiQ5Yqf55m75b2V?=",
        "Message-ID: <cjk@corp.com>",
        "",
        "body",
      ].join("\r\n"),
    );
    expect(parsed.subject).toBe("成功登录");
  });

  it("decodes quoted-printable bodies", async () => {
    const parsed = await parse(
      [
        "From: a@corp.com",
        "To: b@mail.example.com",
        "Subject: qp",
        "Message-ID: <qp@corp.com>",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "your code is =34=38=33=39=32=30",
      ].join("\r\n"),
    );
    expect(parsed.bodyText).toContain("483920");
  });

  it("preserves the display name and extracts the bare address", async () => {
    const parsed = await parse(
      [
        'From: "Cloudflare" <noreply@notify.cloudflare.com>',
        "To: b@mail.example.com",
        "Subject: s",
        "Message-ID: <cf@corp.com>",
        "",
        "body",
      ].join("\r\n"),
    );
    expect(parsed.fromHeader).toBe('"Cloudflare" <noreply@notify.cloudflare.com>');
    expect(parsed.from).toBe("noreply@notify.cloudflare.com");
  });

  it("splits the References header into typed ids", async () => {
    // postal-mime hands this back as ONE raw string; ThreadingPolicy needs a list.
    const parsed = await parse(
      [
        "From: a@corp.com",
        "To: b@mail.example.com",
        "Subject: re",
        "Message-ID: <third@corp.com>",
        "In-Reply-To: <second@corp.com>",
        "References: <first@corp.com> <second@corp.com>",
        "",
        "body",
      ].join("\r\n"),
    );
    expect(parsed.references).toEqual(["first@corp.com", "second@corp.com"]);
    expect(parsed.inReplyTo).toBe("second@corp.com");
  });

  it("reads the FIRST Authentication-Results, not a forged later one", async () => {
    // Each hop prepends its own; the first belongs to the host that actually
    // ran the check. Trusting the last would let the sender assert a pass.
    const parsed = await parse(
      [
        "Authentication-Results: mx.cloudflare.net; spf=fail; dkim=fail; dmarc=fail",
        "Authentication-Results: evil.example; spf=pass; dkim=pass; dmarc=pass",
        "From: a@corp.com",
        "To: b@mail.example.com",
        "Subject: s",
        "Message-ID: <auth@corp.com>",
        "",
        "body",
      ].join("\r\n"),
    );
    expect(parsed.auth).toEqual({ spf: "fail", dkim: "fail", dmarc: "fail" });
  });

  it("extracts attachments with their bytes", async () => {
    const parsed = await parse(
      [
        "From: a@corp.com",
        "To: b@mail.example.com",
        "Subject: invoice",
        "Message-ID: <att@corp.com>",
        'Content-Type: multipart/mixed; boundary="b2"',
        "",
        "--b2",
        "Content-Type: text/plain",
        "",
        "see attached",
        "--b2",
        "Content-Type: application/pdf",
        'Content-Disposition: attachment; filename="invoice.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "SGVsbG8gUERG",
        "--b2--",
        "",
      ].join("\r\n"),
    );

    expect(parsed.attachments).toHaveLength(1);
    const attachment = parsed.attachments[0]!;
    expect(attachment.filename).toBe("invoice.pdf");
    expect(attachment.mime).toBe("application/pdf");
    expect(attachment.inline).toBe(false);
    expect(new TextDecoder().decode(attachment.content)).toBe("Hello PDF");
  });

  it("marks a cid-referenced image inline and unbrackets its Content-ID", async () => {
    const parsed = await parse(
      [
        "From: a@corp.com",
        "To: b@mail.example.com",
        "Subject: logo",
        "Message-ID: <inline@corp.com>",
        'Content-Type: multipart/related; boundary="b3"',
        "",
        "--b3",
        "Content-Type: text/html",
        "",
        '<img src="cid:logo@corp">',
        "--b3",
        "Content-Type: image/png",
        "Content-ID: <logo@corp>",
        "Content-Transfer-Encoding: base64",
        "",
        "iVBORw0KGgo=",
        "--b3--",
        "",
      ].join("\r\n"),
    );

    const image = parsed.attachments[0]!;
    // `cid:` URLs reference the id without brackets, so storing it bracketed
    // would break every lookup.
    expect(image.contentId).toBe("logo@corp");
    expect(image.inline).toBe(true);
  });

  it("survives a message with no Message-ID", async () => {
    const parsed = await parse(
      ["From: a@corp.com", "To: b@mail.example.com", "Subject: s", "", "body"].join("\r\n"),
    );
    // Null here; the ingest use case mints one so the message can be deduplicated.
    expect(parsed.rfcMessageId).toBeNull();
  });

  it("carries Auto-Submitted through for the loop breaker", async () => {
    const parsed = await parse(
      [
        "From: robot@corp.com",
        "To: b@mail.example.com",
        "Subject: Out of office",
        "Message-ID: <ooo@corp.com>",
        "Auto-Submitted: auto-replied",
        "",
        "I am away.",
      ].join("\r\n"),
    );
    expect(parsed.autoSubmitted).toBe("auto-replied");
  });

  it("does not choke on an address group", async () => {
    const parsed = await parse(
      [
        "From: a@corp.com",
        "To: undisclosed-recipients:;",
        "Subject: bcc blast",
        "Message-ID: <group@corp.com>",
        "",
        "body",
      ].join("\r\n"),
    );
    expect(parsed.to).toEqual([]);
  });
});
