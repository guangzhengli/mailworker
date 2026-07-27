import { clearCookie } from "@web/workers/http/session";
import { redirect } from "react-router";
import type { Route } from "./+types/logout";

/**
 * POST only, and therefore only reachable from a form on our own origin with a
 * `SameSite=Lax` cookie attached. A GET logout is a link any page on the
 * internet can embed in an `<img>` tag to sign a reader out of somewhere else.
 */
export async function action({ request }: Route.ActionArgs) {
  return redirect("/login", { headers: { "Set-Cookie": clearCookie(new URL(request.url)) } });
}

export async function loader() {
  throw redirect("/");
}
