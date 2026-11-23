import { index, layout, type RouteConfig, route } from "@react-router/dev/routes";

/**
 * Two halves: mail, which is what a person opens this for every day, and the
 * console, which is configuration and investigation.
 *
 * Declared rather than derived from the filesystem: the route table is the one
 * place to see the whole surface.
 */
export default [
  /** Outside the shell, because the shell requires a `Caller` and these are how you get one. */
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),
  route("locale", "routes/locale.tsx"),

  layout("routes/shell.tsx", [
    index("routes/home.tsx"),

    route("environment", "routes/environment.tsx"),

    route("mail", "routes/mail.tsx", [route(":messageId", "routes/mail-message.tsx")]),
    route("approvals", "routes/approvals.tsx"),
    route("compose", "routes/compose.tsx"),

    /** Resource routes for a message's body and attachments; each needs its own CSP. */
    route("messages/:id", "routes/message.tsx"),
    route("messages/:id/body", "routes/message-body.tsx"),
    route("messages/:id/attachments/:attachmentId", "routes/attachment.tsx"),
    /** Superseded by `/mail`; kept so old links and bookmarks still land. */
    route("inbox", "routes/inbox.tsx"),

    route("status", "routes/overview.tsx"),
    route("sent", "routes/sent.tsx"),
    route("sent/:id", "routes/delivery.tsx"),
    route("sent/:id/body", "routes/delivery-body.tsx"),
    route("inboxes", "routes/inboxes.tsx"),
    route("agents", "routes/agents.tsx"),
    route("settings", "routes/settings.tsx"),
    route("settings/suppressions", "routes/suppressions.tsx"),
    route("settings/diagnostics", "routes/diagnostics.tsx"),
  ]),
] satisfies RouteConfig;
