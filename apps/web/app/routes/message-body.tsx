import { Ulid } from "@mailworker/core";
import { sanitizeHtml } from "@mailworker/mime";
import { page } from "@web/app/auth";
import { bodyFrameResponse } from "@web/app/body-frame.server";
import { localeFromRequest } from "@web/app/i18n/locale.server";
import type { Route } from "./+types/message-body";

/**
 * An inbound message's HTML body, served as its own document.
 *
 * The sanitizer, the sandbox and the CSP that stand between this markup and the
 * dashboard are described in `body-frame.server.ts`, which this shares with the
 * outbound route.
 *
 * It is a resource route rather than a page: it returns a `Response`, has no
 * component, and therefore never gets React Router's document shell wrapped
 * around it.
 */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const message = await services.mailbox.getMessage(caller, Ulid.parse(params.id));

    const url = new URL(request.url);
    const allowRemoteImages = url.searchParams.get("images") === "1";
    const { html, blockedRemoteImages } = sanitizeHtml(message.bodyHtml ?? "", {
      allowRemoteImages,
    });

    /**
     * Off the request, not off a React context: this route returns a `Response`
     * and has no component, so there is no provider above it. The cookie the
     * dashboard set is on this request too — the frame is a same-origin
     * subresource — so the blocked-images note matches the page around it.
     */
    return bodyFrameResponse({
      locale: localeFromRequest(request),
      html,
      parentOrigin: url.origin,
      allowRemoteImages,
      blockedRemoteImages,
    });
  });
}
