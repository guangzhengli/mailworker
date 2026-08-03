import { AccountId } from "@mailworker/core";
import { page } from "@web/app/auth";
import { setEnvironmentCookie } from "@web/workers/http/session";
import { redirect } from "react-router";
import type { Route } from "./+types/environment";

/**
 * Switching environments, as a POST.
 *
 * It writes a cookie the server reads when it builds the `Caller`, so it is a
 * state change and not a link. The switch itself is not authorized here — the
 * cookie only names a target, and `callerForToken` is what refuses it unless the
 * credential is `admin` and the environment belongs to the same project. Putting
 * the check there rather than here is what keeps it in force for every request
 * that arrives with the cookie already set.
 */
export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async () => {
    const form = await request.formData();
    const accountId = AccountId.parse(String(form.get("accountId") ?? "").trim());

    // Home rather than back: the page you were on names a row id that belongs to
    // the environment you just left, and a 404 is a poor welcome.
    throw redirect("/", {
      headers: { "Set-Cookie": setEnvironmentCookie(accountId, new URL(request.url)) },
    });
  });
}

export async function loader() {
  throw redirect("/");
}
