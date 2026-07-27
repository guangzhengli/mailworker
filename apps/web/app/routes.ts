import { index, layout, type RouteConfig, route } from "@react-router/dev/routes";

/**
 * The dashboard is the API's first client, not its core (DESIGN §7.3) — so
 * every page here is a thin read of a service the CLI already drives.
 *
 * Declared rather than derived from the filesystem: the route table is the one
 * place to see the whole surface, and a convention that infers it from file
 * names hides exactly that. Fifteen lines is not a cost worth paying to avoid.
 */
export default [
  /**
   * Outside the shell, because the shell requires a `Caller` and these two are
   * how you get one. Nesting them under it would need an exception in the
   * loader that guards every other page, and a guard with an exception is a
   * guard someone will widen.
   */
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),

  layout("routes/shell.tsx", [
    index("routes/inboxes.tsx"),
    route("inboxes/:id", "routes/inbox.tsx"),
    route("messages/:id", "routes/message.tsx"),
    /**
     * Not a page: the `srcdoc`-free source for the sandboxed iframe in
     * `messages/:id`. It is its own route because it must be served with its
     * own Content-Security-Policy header, and a header is a property of a
     * response — there is no way to give one fragment of a page a different
     * policy from the rest of it.
     */
    route("messages/:id/body", "routes/message-body.tsx"),
    route("messages/:id/attachments/:attachmentId", "routes/attachment.tsx"),

    route("deliveries", "routes/deliveries.tsx"),
    route("deliveries/:id", "routes/delivery.tsx"),
    route("suppressions", "routes/suppressions.tsx"),
    route("identities", "routes/identities.tsx"),
    route("keys", "routes/keys.tsx"),
    route("diagnostics", "routes/diagnostics.tsx"),
  ]),
] satisfies RouteConfig;
