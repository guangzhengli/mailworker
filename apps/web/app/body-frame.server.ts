import { type Locale, plural } from "@web/app/i18n";

/**
 * The document a message body is served as, for the sandboxed iframe that shows
 * it — inbound on `/messages/:id/body`, outbound on `/sent/:id/body`.
 *
 * Three separate controls stack here, and none of them is trusted to be the only
 * one:
 *
 *   1. `sanitizeHtml`, upstream of this function, drops scripts, event handlers,
 *      unsafe schemes and — by default — remote image sources. Sanitizers get
 *      bypassed; this is the layer least deserving of confidence.
 *   2. The frame is `sandbox`ed with no `allow-same-origin` (see
 *      `components/body-viewer.tsx`), so anything that survived runs in an
 *      opaque origin with no access to the dashboard.
 *   3. This CSP, which the browser enforces regardless of what the markup says.
 *
 * The frame does run one script of ours — the height reporter that lets the page
 * scroll once instead of nesting a scrollbar inside a scrollbar. That is why the
 * sandbox carries `allow-scripts` and why `script-src` is a per-response nonce
 * rather than `'none'`: the nonce is the narrower rule of the two. A `<script>`
 * the sanitizer let through has no nonce and does not execute, an `onclick=`
 * never executes because a nonce does not cover attributes, and even if one
 * somehow did, the opaque origin still stands between it and this page.
 *
 * Outbound shares every line of this. The instinct to relax it because "we
 * composed this message ourselves" is exactly wrong: the body was authored by an
 * agent, from a template, or by interpolating a string that may have come from
 * an inbound message. Outbound is not the same as trusted, and the one page
 * where a human is deciding whether to APPROVE a send is the last place to start
 * assuming it is.
 */
export interface BodyFrameOptions {
  readonly locale: Locale;
  /** Already sanitized. This function never sees raw message HTML. */
  readonly html: string;
  /** Where `postMessage` is allowed to send the measured height. */
  readonly parentOrigin: string;
  readonly allowRemoteImages: boolean;
  readonly blockedRemoteImages: number;
}

export function bodyFrameResponse(options: BodyFrameOptions): Response {
  const nonce = crypto.randomUUID();

  /**
   * `img-src` is the one directive that changes with the reader's choice, and it
   * is the reason remote images are off by default: loading one tells the sender
   * the exact moment a message was opened, and from which IP. The `data:` source
   * stays permitted either way — inline images arrived with the message and
   * report to nobody.
   */
  const csp = [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `script-src 'nonce-${nonce}'`,
    `img-src ${options.allowRemoteImages ? "data: https:" : "data:"}`,
    "frame-ancestors 'self'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");

  return new Response(document(options, nonce), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      // A message body is stable forever but is also somebody's mail; caching it
      // in a shared proxy would be caching a private document under a URL that
      // only a cookie protects.
      "Cache-Control": "private, no-store",
    },
  });
}

function document(options: BodyFrameOptions, nonce: string): string {
  const note =
    options.blockedRemoteImages > 0 && !options.allowRemoteImages
      ? `<p class="blocked">${plural(options.locale, "body.blocked", options.blockedRemoteImages)}</p>`
      : "";

  /**
   * `lang` on the frame's own root, because it is a document of its own and does
   * not inherit the dashboard's. Without it the CJK font stack below never
   * applies and the note renders in whatever the browser guesses.
   *
   * `overflow-x: auto` on the body rather than the wrapping the page does: mail
   * is full of fixed 600px table layouts, and a narrow viewport should give the
   * body its own horizontal scroll instead of shoving the dashboard sideways.
   */
  return `<!doctype html>
<html lang="${options.locale}"><head><meta charset="utf-8">
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 16px; overflow-x: auto;
         font: 15px/1.55 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
         color: #1c1b19; background: #fff; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #a8542a; }
  .blocked { margin: 0 0 14px; padding: 7px 10px; border-radius: 6px;
             background: #f6ece5; color: #6d6a64; font-size: 13px; }
</style></head>
<body>${note}${options.html}${heightReporter(nonce, options.parentOrigin)}</body></html>`;
}

/**
 * Tells the parent how tall this document is, so the frame can be sized to its
 * content and the page keeps a single scrollbar.
 *
 * `ResizeObserver` rather than a one-shot measurement on load, because the two
 * things that most change a mail's height happen after it: remote images
 * arriving once the reader allows them, and a web font settling. The parent
 * clamps whatever number this sends, so a body that reports a nonsense height
 * degrades to an ordinary scrolling frame rather than a mile of blank page.
 */
function heightReporter(nonce: string, parentOrigin: string): string {
  return `<script nonce="${nonce}">
(function () {
  var last = -1;
  function report() {
    var height = Math.ceil(document.documentElement.scrollHeight);
    if (height === last) return;
    last = height;
    parent.postMessage({ mailworkerBodyHeight: height }, ${JSON.stringify(parentOrigin)});
  }
  report();
  addEventListener("load", report);
  new ResizeObserver(report).observe(document.body);
})();
</script>`;
}
