import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import "./styles.css";

export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Nothing here is public, and a dashboard URL in a referrer log is a
            leak of an inbox id to whatever the caller clicked through to. */}
        <meta name="referrer" content="no-referrer" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
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
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const title = isRouteErrorResponse(error) ? `${error.status} ${error.statusText}` : "Error";
  const detail = isRouteErrorResponse(error)
    ? String(error.data)
    : error instanceof Error
      ? error.message
      : "Something went wrong.";

  return (
    <main className="shell-empty">
      <h1>{title}</h1>
      <p className="muted">{detail}</p>
      <p>
        <a href="/">Back to inboxes</a>
      </p>
    </main>
  );
}
