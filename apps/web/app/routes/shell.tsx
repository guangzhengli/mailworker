import { page } from "@web/app/auth";
import { Form, NavLink, Outlet } from "react-router";
import type { Route } from "./+types/shell";

/**
 * The layout every real page sits inside — and, more importantly, the single
 * place authentication is checked for all of them.
 *
 * React Router runs a layout's loader before its children's, so a child page
 * cannot render without this having passed. That is why the guard lives here
 * rather than being repeated per route: the version that is repeated is the
 * version where the eleventh page forgets.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller }) => {
    return { subject: caller.subject, scopes: caller.scopes, accountId: caller.accountId };
  });
}

const SECTIONS = [
  { to: "/", label: "Inboxes", end: true },
  { to: "/deliveries", label: "Deliveries", end: false },
  { to: "/suppressions", label: "Suppressions", end: false },
  { to: "/identities", label: "Identities", end: false },
  { to: "/keys", label: "API keys", end: false },
  { to: "/diagnostics", label: "Diagnostics", end: false },
] as const;

export default function Shell({ loaderData }: Route.ComponentProps) {
  return (
    <div className="shell">
      <nav className="shell-nav">
        <div className="shell-brand">
          Mailworker
          <small>{loaderData.accountId}</small>
        </div>

        {SECTIONS.map((section) => (
          <NavLink
            key={section.to}
            to={section.to}
            end={section.end}
            className={({ isActive }) => (isActive ? "active" : "")}
          >
            {section.label}
          </NavLink>
        ))}

        <div className="shell-nav-spacer" />

        <div className="shell-who">
          <div className="mono">{loaderData.subject}</div>
          <div style={{ margin: "4px 0 10px" }}>{loaderData.scopes.join(" · ")}</div>
          <Form method="post" action="/logout">
            <button type="submit">Sign out</button>
          </Form>
        </div>
      </nav>

      <main className="shell-main">
        <Outlet />
      </main>
    </div>
  );
}
