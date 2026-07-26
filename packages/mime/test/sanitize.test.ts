import { sanitizeHtml } from "@mime/sanitize";
import { describe, expect, it } from "vitest";

describe("sanitizeHtml", () => {
  it("keeps ordinary formatting", () => {
    const { html } = sanitizeHtml("<p>Hello <strong>world</strong></p>");
    expect(html).toBe("<p>Hello <strong>world</strong></p>");
  });

  it("drops script tags along with their content", () => {
    const { html, droppedTags } = sanitizeHtml(
      '<p>hi</p><script>alert("x")</script><p>bye</p>',
    );
    expect(html).toBe("<p>hi</p><p>bye</p>");
    expect(droppedTags).toContain("script");
  });

  it("is not fooled by a nested-tag script smuggle", () => {
    // The classic defeat of regex-based stripping: removing the inner
    // `<script>` splices the outer one back together.
    const { html } = sanitizeHtml("<scr<script>ipt>alert(1)</scr</script>ipt>");
    // No script ELEMENT survives, which is the thing that matters. The payload
    // text remains as escaped body text — that is correct, and matches how a
    // browser tokenizes this (it reads `<script` as an attribute of a `scr` tag).
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html).not.toMatch(/<[a-zA-Z]/);
  });

  it("drops style tags, which can load remote resources", () => {
    const { html } = sanitizeHtml(
      "<style>body{background:url(http://tracker/x)}</style><p>a</p>",
    );
    expect(html).toBe("<p>a</p>");
  });

  it("strips event handler attributes", () => {
    const { html } = sanitizeHtml('<img src="http://x/a.png" onerror="alert(1)">');
    expect(html).not.toContain("onerror");
  });

  it("refuses javascript: hrefs", () => {
    const { html } = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(html).not.toContain("javascript");
    expect(html).toContain("click");
  });

  it("refuses a javascript: href hidden behind entities", () => {
    // Reaches the browser as `javascript:` — checking the undecoded string is
    // the bypass this guards.
    const { html } = sanitizeHtml('<a href="&#106;avascript&colon;alert(1)">x</a>');
    expect(html.toLowerCase()).not.toContain("javascript");
  });

  it("refuses a javascript: href broken up by control characters", () => {
    const { html } = sanitizeHtml('<a href="java\tscript:alert(1)">x</a>');
    expect(html.toLowerCase()).not.toContain("javascript");
  });

  it("refuses data: urls", () => {
    const { html } = sanitizeHtml('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(html).not.toContain("data:");
  });

  it("blocks remote images by default and reports the count", () => {
    const result = sanitizeHtml('<img src="https://tracker.example/pixel.gif">');
    // A remote image is a read receipt the recipient never agreed to.
    expect(result.blockedRemoteImages).toBe(1);
    expect(result.html).toContain("data-blocked-src");
    // Must carry no loadable `src`. Matched on the attribute boundary, since
    // `data-blocked-src=` itself ends in the substring `src=`.
    expect(result.html).not.toMatch(/(^|\s)src=/);
  });

  it("allows remote images when explicitly asked", () => {
    const result = sanitizeHtml('<img src="https://cdn.example/logo.png">', {
      allowRemoteImages: true,
    });
    expect(result.blockedRemoteImages).toBe(0);
    expect(result.html).toContain('src="https://cdn.example/logo.png"');
  });

  it("always allows cid: images, which leak nothing", () => {
    const result = sanitizeHtml('<img src="cid:logo@example">');
    expect(result.blockedRemoteImages).toBe(0);
    expect(result.html).toContain('src="cid:logo@example"');
  });

  it("hardens outbound links", () => {
    const { html } = sanitizeHtml('<a href="https://example.com">x</a>');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
  });

  it("unwraps unknown containers but keeps their text", () => {
    const { html } = sanitizeHtml("<iframe><p>fallback</p></iframe>");
    expect(html).toBe("<p>fallback</p>");
  });

  it("drops comments, including conditional ones", () => {
    const { html } = sanitizeHtml("<!--[if IE]><script>x</script><![endif]--><p>a</p>");
    expect(html).toBe("<p>a</p>");
  });

  it("closes tags left open so a truncated message cannot swallow the page", () => {
    const { html } = sanitizeHtml("<div><p>unterminated");
    expect(html).toBe("<div><p>unterminated</p></div>");
  });

  it("treats a bare < as text", () => {
    const { html } = sanitizeHtml("2 < 3 and 4 > 3");
    expect(html).toBe("2 &lt; 3 and 4 &gt; 3");
  });

  it("keeps table structure", () => {
    const { html } = sanitizeHtml('<table><tr><td colspan="2">a</td></tr></table>');
    expect(html).toContain("<table>");
    expect(html).toContain('colspan="2"');
  });

  it("survives an unclosed quote in an attribute", () => {
    const result = sanitizeHtml('<a href="https://x.com>text</a>');
    expect(result.html).not.toContain("javascript");
  });
});
