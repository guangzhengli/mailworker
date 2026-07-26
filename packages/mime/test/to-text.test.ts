import { PostalMimeParser } from "@mime/parse";
import { htmlToText } from "@mime/to-text";
import { describe, expect, it } from "vitest";

describe("htmlToText", () => {
  it("keeps block elements apart so adjacent words do not fuse", () => {
    expect(htmlToText("<p>123456</p><p>is your code</p>")).toBe("123456\nis your code");
  });

  it("drops script and style CONTENT, not just their tags", () => {
    // The reason this cannot be a regex over `<[^>]+>`: a stylesheet is full of
    // digits, and the OTP extractor would happily return one of them.
    const html = "<style>.a{width:428571px}</style><p>Your code is 903214</p>";
    expect(htmlToText(html)).toBe("Your code is 903214");
  });

  it("decodes entities", () => {
    expect(htmlToText("<p>caf&#233; &amp; code &#8212; 5&nbsp;min</p>")).toBe(
      "café & code — 5 min",
    );
  });

  it("collapses source indentation without losing paragraphs", () => {
    const html = "<div>\n  <p>one</p>\n\n\n  <p>two</p>\n</div>";
    expect(htmlToText(html)).toBe("one\ntwo");
  });

  it("treats a bare < as text", () => {
    expect(htmlToText("5 < 6 and 7 > 6")).toBe("5 < 6 and 7 > 6");
  });
});

describe("PostalMimeParser", () => {
  it("derives a text body for an HTML-only message", async () => {
    // Without this an HTML-only verification mail stores bodyText = null, and
    // `wait --extract otp` times out on a message whose code is right there.
    const raw = new TextEncoder().encode(
      [
        "From: noreply@corp.com",
        "To: agent@mail.example.com",
        "Subject: Verify",
        "Message-ID: <html-only@corp.com>",
        "MIME-Version: 1.0",
        'Content-Type: text/html; charset="utf-8"',
        "",
        "<html><body><p>Your code is <b>481902</b></p></body></html>",
      ].join("\r\n"),
    );

    const parsed = await new PostalMimeParser().parse(raw);
    expect(parsed.bodyText).toBe("Your code is 481902");
  });
});
