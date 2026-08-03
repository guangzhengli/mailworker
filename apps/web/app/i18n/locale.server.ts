import { DEFAULT_LOCALE, isLocale, type Locale, negotiate } from "@web/app/i18n";

/**
 * Where the chosen locale lives, and why it is a cookie rather than
 * localStorage.
 *
 * `app/theme.tsx` keeps the theme in localStorage and fixes the page up in a
 * blocking `<script>` before first paint. That works for a CSS class and cannot
 * work for text: the HTML is rendered on the server, so the server has to know
 * the language before it renders anything. A client-side switch would mean
 * shipping English, hydrating, and then swapping every string — a visible flash
 * plus a hydration mismatch on every load.
 *
 * A cookie is sent with the request, so the very first byte of HTML is already
 * in the right language.
 */

const COOKIE_NAME = "mw_locale";
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

export function localeFromRequest(request: Request): Locale {
  const stored = readCookie(request.headers.get("Cookie"), COOKIE_NAME);
  if (isLocale(stored)) return stored;
  return negotiate(request.headers.get("Accept-Language"));
}

/**
 * `HttpOnly` because nothing in the browser needs to read this — the rendered
 * page is already in the right language, and the locale is in root loader data
 * for anything that needs to branch. `SameSite=Lax` still sends it on a
 * top-level navigation from an external link, which is the case that matters.
 * `Secure` is conditional for the same reason as the session cookie: `vite dev`
 * serves http, and a `Secure` cookie there is silently never stored.
 */
export function setLocaleCookie(locale: Locale, url: URL): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${COOKIE_NAME}=${locale}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${ONE_YEAR_SECONDS}`;
}

export function localeOrDefault(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Same parser as `workers/http/session.ts`, kept local so this module has no dependency on it. */
function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}
