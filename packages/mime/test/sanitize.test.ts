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

  it("hardens delivery links", () => {
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

/**
 * Inline CSS, which is how mail is styled.
 *
 * The two halves of this block are the whole trade: the first says a real
 * message keeps looking like itself, the second says the ways CSS reaches the
 * network or the parser are all refused. Neither is worth much without the
 * other.
 */
describe("inline styles", () => {
  it("keeps the declarations a real message is laid out with", () => {
    const { html } = sanitizeHtml(
      '<td style="padding:32px;background:#ffffff;border-radius:8px">x</td>',
    );
    expect(html).toBe('<td style="padding:32px;background:#ffffff;border-radius:8px">x</td>');
  });

  it("keeps presentational table attributes", () => {
    // Not decoration: this IS the layout engine of HTML mail, because it is what
    // Outlook honours.
    const { html } = sanitizeHtml(
      '<table cellpadding="0" cellspacing="0" bgcolor="#f6f9fc" width="600" align="center"><tr valign="top"><td>x</td></tr></table>',
    );
    expect(html).toContain('cellpadding="0"');
    expect(html).toContain('bgcolor="#f6f9fc"');
    expect(html).toContain('width="600"');
    expect(html).toContain('valign="top"');
  });

  it("keeps allowlisted functions, including nested ones", () => {
    const { html } = sanitizeHtml(
      '<div style="color:rgba(0,0,0,.5);width:calc(100% - 20px);background:linear-gradient(to right,rgb(1,2,3),#fff)">x</div>',
    );
    expect(html).toContain("rgba(0,0,0,.5)");
    expect(html).toContain("calc(100% - 20px)");
    expect(html).toContain("linear-gradient(to right,rgb(1,2,3),#fff)");
  });

  it("keeps vendor-prefixed properties", () => {
    const { html } = sanitizeHtml('<div style="-webkit-font-smoothing:antialiased">x</div>');
    expect(html).toContain("-webkit-font-smoothing:antialiased");
  });

  it("drops url() — the way CSS reaches the network", () => {
    // The whole reason `allowRemoteImages` exists. A background image is a read
    // receipt with no UI to consent to it, so unlike an <img> it is not blocked
    // pending a click, it is simply gone.
    const { html } = sanitizeHtml(
      '<div style="color:red;background-image:url(https://tracker.test/x.gif)">x</div>',
    );
    expect(html).toContain("color:red");
    expect(html).not.toContain("url(");
    expect(html).not.toContain("tracker.test");
  });

  it("drops only the offending declaration, not the whole block", () => {
    // A rule block is a layout. Losing all of it over one bad declaration would
    // be the sanitizer deciding the preview is not worth having.
    const { html } = sanitizeHtml(
      '<div style="padding:8px;background:url(https://t.test/x);color:#333">x</div>',
    );
    expect(html).toContain("padding:8px");
    expect(html).toContain("color:#333");
    expect(html).not.toContain("t.test");
  });

  it("refuses a value hidden behind a CSS escape", () => {
    // `\75 rl(…)` reaches the engine as `url(…)`. A scan for the literal text
    // `url(` never sees it, which is why the backslash itself is refused.
    const { html } = sanitizeHtml(
      '<div style="background:\\75 rl(https://tracker.test/x)">x</div>',
    );
    expect(html).not.toContain("tracker.test");
    expect(html).not.toContain("style=");
  });

  it("refuses a value hidden behind a CSS comment", () => {
    // Browsers strip comments before parsing, so this is `url(…)` too.
    const { html } = sanitizeHtml(
      '<div style="background:u/**/rl(https://tracker.test/x)">x</div>',
    );
    expect(html).not.toContain("tracker.test");
  });

  it("refuses an unknown function rather than looking for known-bad ones", () => {
    // Anchoring on the parenthesis is what makes this fail closed: neither name
    // has to be known here to be refused.
    for (const value of [
      "width:expression(alert(1))",
      "behavior:someFuture(1)",
      "-moz-binding:whatever(1)",
    ]) {
      const { html } = sanitizeHtml(`<div style="${value}">x</div>`);
      expect(html).toBe("<div>x</div>");
    }
  });

  it("refuses a url() smuggled through an HTML entity", () => {
    const { html } = sanitizeHtml(
      '<div style="background:&#117;rl(https://tracker.test/x)">x</div>',
    );
    expect(html).not.toContain("tracker.test");
  });

  it("cannot break out of the attribute it is written into", () => {
    const { html } = sanitizeHtml(`<div style='color:red" onmouseover="alert(1)'>x</div>`);
    expect(html).not.toContain("onmouseover");
    // The quote survives only as an entity, so it cannot close the attribute.
    expect(html).not.toMatch(/style="[^"]*"[^>]*=/);
  });

  it("emits no style attribute when nothing survived", () => {
    const { html } = sanitizeHtml('<div style="background:url(https://t.test/x)">x</div>');
    expect(html).toBe("<div>x</div>");
  });

  it("still drops style ELEMENTS, which are a different surface", () => {
    const { html } = sanitizeHtml(
      '<style>@import url(https://tracker.test/x.css);</style><p style="color:red">a</p>',
    );
    expect(html).toBe('<p style="color:red">a</p>');
  });
});
