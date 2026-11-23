import { Button } from "@web/app/components/ui/button";
import { Toaster } from "@web/app/components/ui/sonner";
import { errorMessage, isErrorCode, LocaleProvider, useT } from "@web/app/i18n";
import { localeFromRequest } from "@web/app/i18n/locale.server";
import { ThemeProvider, ThemeScript } from "@web/app/theme";
import { MotionConfig } from "motion/react";
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";
import type { Route } from "./+types/root";
import "./styles.css";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" },
];

/**
 * The locale, resolved once per request, before anything renders.
 *
 * It has to be here rather than per page: the language is a property of the
 * document — `<html lang>`, the error boundary, the shell — and a page-level
 * loader would resolve it after the layout above it had already rendered.
 */
export function loader({ request }: Route.LoaderArgs) {
  return { locale: localeFromRequest(request) };
}

export function Layout({ children }: { children: React.ReactNode }) {
  /**
   * Not `loaderData`: `Layout` also wraps the error boundary, and when the root
   * loader itself is what threw there is no data to destructure. The hook
   * returns undefined in that case and English is the honest fallback.
   */
  const locale = useRouteLoaderData<typeof loader>("root")?.locale ?? "en";

  return (
    /**
     * `suppressHydrationWarning` on <html> only, and only because ThemeScript
     * adds a class the server did not render. Scoped to this one element so a
     * genuine mismatch anywhere below still surfaces.
     */
    <html lang={locale} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Nothing here is public, and a dashboard URL in a referrer log is a
            leak of an inbox id to whatever the caller clicked through to.

            `same-origin` and not `no-referrer`, which is the stronger-sounding
            value and the broken one: under `no-referrer` the browser serialises
            the `Origin` of a same-origin form POST as the literal `null`
            (Fetch, "append a request Origin header"), and React Router reads a
            `null` origin as a cross-site action and aborts every mutation.
            `same-origin` still sends no `Referer` at all to a third party,
            which is the whole of what the leak above is about. */}
        <meta name="referrer" content="same-origin" />
        <Meta />
        <Links />
        <ThemeScript />
      </head>
      <body>
        <LocaleProvider locale={locale}>
          <ThemeProvider>
            <MotionConfig reducedMotion="user">
              {children}
              <Toaster position="top-center" />
            </MotionConfig>
          </ThemeProvider>
        </LocaleProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * The message, not the stack.
 *
 * A dashboard error is usually a domain error that already carries a sentence
 * written for a person — "This credential lacks the admin scope" — and printing
 * a stack over it would bury the one useful line. In development React Router
 * still logs the full error to the console, which is where a stack belongs.
 *
 * Two lines rather than one, once the codes are translated: the localised
 * sentence says what class of thing went wrong, and the domain's own message
 * below it names the id or the address it went wrong on. Neither substitutes for
 * the other, and the catalogue's English is written as a paraphrase precisely so
 * that seeing both is not reading the same words twice.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const { t, locale } = useT();
  const routed = isRouteErrorResponse(error);
  const code = routed && isErrorCode(error.statusText) ? error.statusText : null;

  const title = routed
    ? `${error.status} ${error.statusText.replaceAll("_", " ")}`
    : t("boundary.title");

  const detail =
    code !== null
      ? errorMessage(locale, code)
      : routed
        ? String(error.data)
        : error instanceof Error
          ? error.message
          : t("boundary.fallback");

  const specifics = code !== null && routed ? String(error.data) : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-title">{title}</h1>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-secondary-text">{detail}</p>
        {specifics !== null && specifics !== detail && (
          <p className="font-mono text-xs text-hint">{specifics}</p>
        )}
      </div>
      <Button render={<Link to="/" />} variant="outline" size="sm">
        {t("boundary.back")}
      </Button>
    </main>
  );
}
