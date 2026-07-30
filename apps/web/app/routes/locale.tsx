import { isLocale } from "@web/app/i18n";
import { setLocaleCookie } from "@web/app/i18n/locale.server";
import { redirect } from "react-router";
import type { Route } from "./+types/locale";

/**
 * Switching language, as a plain form POST.
 *
 * No JavaScript is involved: the cookie is set, the browser is sent back where
 * it was, and the next render is server-side in the new language. A client-side
 * switch would have to re-render every string it had already hydrated, and would
 * still leave the next hard navigation to guess.
 *
 * POST for the same reason as `/logout`: a GET that changes a persistent
 * preference is a link any page can embed in an `<img>` tag.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const locale = form.get("locale");

  if (!isLocale(locale)) {
    // An unknown locale is a bad request, not a reason to reset the preference to
    // English — the reader who is on Chinese would lose it to a typo'd form.
    return redirect(safeReturn(request));
  }

  return redirect(safeReturn(request), {
    headers: { "Set-Cookie": setLocaleCookie(locale, new URL(request.url)) },
  });
}

export async function loader() {
  throw redirect("/");
}

/**
 * Where to go back to, from the query string rather than the `Referer` header —
 * the referrer policy in `root.tsx` decides whether `Referer` arrives at all,
 * so a switch that depended on it would break the next time that value changed.
 *
 * Same rule as login's `?next=`: only a same-origin path survives, and anything
 * else collapses to `/`. Parsing against the request URL and comparing origins
 * is the check that catches `//evil.com`, which a string test reads as relative.
 */
function safeReturn(request: Request): string {
  const raw = new URL(request.url).searchParams.get("return");
  if (raw === null) return "/";
  try {
    const target = new URL(raw, request.url);
    if (target.origin !== new URL(request.url).origin) return "/";
    return `${target.pathname}${target.search}`;
  } catch {
    return "/";
  }
}
