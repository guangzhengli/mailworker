import { Ulid } from "@mailworker/core";
import { page } from "@web/app/auth";
import type { Route } from "./+types/attachment";

/**
 * An attachment's bytes.
 *
 * Served as `application/octet-stream` with `Content-Disposition: attachment`,
 * *whatever the message claimed the type was*. Honouring a sender-supplied
 * `Content-Type` here would let a stranger's mail render an HTML document on
 * the dashboard's own origin — which is the one place a sandboxed frame was
 * carefully keeping it out of. The filename is quoted and stripped of the
 * characters that would let it break out of the header.
 */
export async function loader({ context, request, params }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const { meta, content } = await services.mailbox.getAttachment(
      caller,
      Ulid.parse(params.id),
      Ulid.parse(params.attachmentId),
    );

    const filename = (meta.filename ?? "attachment").replaceAll(/["\\\r\n]/g, "_");

    return new Response(content as BodyInit, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(meta.size),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  });
}
