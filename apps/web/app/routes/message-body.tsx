import { Ulid } from "@mailworker/core";
import { sanitizeHtml } from "@mailworker/mime";
import { page } from "@web/app/auth";
import type { Route } from "./+types/message-body";

/**
 * The HTML body, served as its own document for the sandboxed iframe.
 *
 * Three separate controls stack here, and none of them is trusted to be the
 * only one:
 *
 *   1. `sanitizeHtml` drops scripts, event handlers, unsafe schemes and — by
 *      default — remote image sources. Sanitizers get bypassed; this is the
 *      layer least deserving of confidence.
 *   2. The frame is `sandbox`ed with no `allow-same-origin` (see
 *      `message.tsx`), so anything that survived runs in an opaque origin with
 *      no access to the dashboard.
 *   3. This CSP, which the browser enforces regardless of what the markup says.
 *
 * It is a resource route rather than a page: it returns a `Response`, has no
 * component, and therefore never gets React Router's document shell wrapped
 * around it.
 */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const message = await services.mailbox.getMessage(caller, Ulid.parse(params.id));

    const allowRemoteImages = new URL(request.url).searchParams.get("images") === "1";
    const { html, blockedRemoteImages } = sanitizeHtml(message.bodyHtml ?? "", {
      allowRemoteImages,
    });

    /**
     * `img-src` is the one directive that changes with the reader's choice, and
     * it is the reason remote images are off by default: loading one tells the
     * sender the exact moment a message was opened, and from which IP. The
     * `data:` source stays permitted either way — inline images arrived with the
     * message and report to nobody.
     */
    const imgSrc = allowRemoteImages ? "data: https:" : "data:";
    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      `img-src ${imgSrc}`,
      "frame-ancestors 'self'",
      "form-action 'none'",
      "base-uri 'none'",
    ].join("; ");

    return new Response(document(html, blockedRemoteImages, allowRemoteImages), {
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
  });
}

function document(html: string, blocked: number, allowRemoteImages: boolean): string {
  const note =
    blocked > 0 && !allowRemoteImages
      ? `<p class="blocked">${blocked} remote image${blocked === 1 ? "" : "s"} blocked.</p>`
      : "";

  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 16px; font: 15px/1.55 ui-sans-serif, system-ui, sans-serif;
         color: #1c1b19; background: #fff; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #a8542a; }
  .blocked { margin: 0 0 14px; padding: 7px 10px; border-radius: 6px;
             background: #f6ece5; color: #6d6a64; font-size: 13px; }
</style></head>
<body>${note}${html}</body></html>`;
}
