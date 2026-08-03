import { Ulid } from "@mailworker/core";
import { sanitizeHtml } from "@mailworker/mime";
import { page } from "@web/app/auth";
import { bodyFrameResponse } from "@web/app/body-frame.server";
import { localeFromRequest } from "@web/app/i18n/locale.server";
import type { Route } from "./+types/delivery-body";

/**
 * An outbound message's HTML body, for the sandboxed iframe on `/sent/:id`.
 *
 * Same document, same sanitizer, same CSP as inbound — see
 * `body-frame.server.ts` for why outbound gets no discount.
 *
 * One deliberate difference: remote images are never enabled here, so there is
 * no `?images=1`. The privacy argument that motivates the toggle on inbound mail
 * — loading a remote image tells the SENDER when you opened it — has no outbound
 * equivalent, since we are the sender. What is left is a page fetching arbitrary
 * URLs on the reviewer's behalf, with nothing bought for it. The blocked count
 * is passed as zero for the same reason: a note about images the reader has no
 * way to unblock is a dead end.
 */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const preview = await services.delivery.preview(caller, Ulid.parse(params.id));
    const { html } = sanitizeHtml(preview.html ?? "", { allowRemoteImages: false });

    return bodyFrameResponse({
      locale: localeFromRequest(request),
      html,
      parentOrigin: new URL(request.url).origin,
      allowRemoteImages: false,
      blockedRemoteImages: 0,
    });
  });
}
