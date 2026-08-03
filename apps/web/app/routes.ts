import { index, layout, type RouteConfig, route } from "@react-router/dev/routes";

/**
 * Organised by what someone came here to do, not by which table backs it
 * (DESIGN ADR-10). Suppressions and diagnostics are not destinations — one is
 * the consequence of a failed send, the other a setup check — so they sit under
 * settings and are linked from where they matter.
 *
 * Declared rather than derived from the filesystem: the route table is the one
 * place to see the whole surface, and a convention that infers it from file
 * names hides exactly that.
 */
export default [
  /**
   * Outside the shell, because the shell requires a `Caller` and these are how
   * you get one. Nesting them would need an exception in the loader that guards
   * every other page, and a guard with an exception is a guard someone widens.
   */
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("locale", "routes/locale.tsx"),

  layout("routes/shell.tsx", [
    index("routes/overview.tsx"),

    route("environment", "routes/environment.tsx"),

    route("approvals", "routes/approvals.tsx"),

    route("sent", "routes/sent.tsx"),
    route("sent/:id", "routes/delivery.tsx"),
    /** Its own route because it needs its own Content-Security-Policy header. */
    route("sent/:id/body", "routes/delivery-body.tsx"),

    /**
     * Mail that arrived, across every address — and, separately, the addresses
     * themselves. Splitting them is ADR-10 applied one level down: an address is
     * configuration, and making it the way in to reading mail meant "did the
     * code arrive" could not be asked without first knowing where it was sent.
     */
    route("inbox", "routes/inbox.tsx"),
    route("inboxes", "routes/inboxes.tsx"),
    route("messages/:id", "routes/message.tsx"),
    route("messages/:id/body", "routes/message-body.tsx"),
    route("messages/:id/attachments/:attachmentId", "routes/attachment.tsx"),
    route("compose", "routes/compose.tsx"),

    route("agents", "routes/agents.tsx"),

    route("settings", "routes/settings.tsx"),
    route("settings/suppressions", "routes/suppressions.tsx"),
    route("settings/diagnostics", "routes/diagnostics.tsx"),
  ]),
] satisfies RouteConfig;
