import { Ulid } from "@mailworker/core";
import { sanitizeHtml } from "@mailworker/mime";
import { page } from "@web/app/auth";
import type { Route } from "./+types/delivery-body";

/**
 * An outbound message's HTML body, for the sandboxed iframe on `deliveries/:id`.
 *
 * The same three stacked controls as `message-body.tsx` — sanitizer, sandboxed
 * frame, CSP — and the reasoning there applies here unchanged. The instinct to
 * relax them because "we composed this message ourselves" is exactly wrong: the
 * body was authored by an agent, from a template, or by interpolating a string
 * that may have come from an inbound message. Outbound is not the same as
 * trusted, and the one page where a human is deciding whether to APPROVE a send
 * is the last place to start assuming it is.
 *
 * One deliberate difference: remote images are never enabled here, so there is
 * no `?images=1`. The privacy argument that motivates the toggle on inbound mail
 * — loading a remote image tells the SENDER when you opened it — has no
 * outbound equivalent, since we are the sender. What is left is a page fetching
 * arbitrary URLs on the reviewer's behalf, with nothing bought for it.
 */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const preview = await services.delivery.preview(caller, Ulid.parse(params.id));
    const { html } = sanitizeHtml(preview.html ?? "", { allowRemoteImages: false });

    const csp = [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "img-src data:",
      "frame-ancestors 'self'",
      "form-action 'none'",
      "base-uri 'none'",
    ].join("; ");

    return new Response(document(html), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": csp,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "private, no-store",
      },
    });
  });
}

function document(html: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 16px;
         font: 15px/1.55 ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
         color: #1c1b19; background: #fff; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  a { color: #a8542a; }
</style></head>
<body>${html}</body></html>`;
}
