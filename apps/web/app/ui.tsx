/**
 * The presentational pieces that appear on more than one page.
 *
 * One file rather than a `components/` tree: none of these has state, and a
 * directory per component would make finding one a navigation problem where it
 * is currently a scroll. `components/ui/` is different — that is vendored
 * registry code, and keeping it separate is what makes it re-syncable.
 */

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { Badge } from "@web/app/components/ui/badge";
import { Button } from "@web/app/components/ui/button";
import { useT } from "@web/app/i18n";
import { formatAbsolute, formatRelative } from "@web/app/i18n/format";
import { cn } from "@web/app/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { Link } from "react-router";

/**
 * UTC, always, and labelled as such.
 *
 * Rendered on the server, where the reader's timezone is unknown — a local
 * time formatted from a server guess is wrong in a way that is invisible, and
 * this is a log-reading tool where an hour's error changes the conclusion. The
 * `title` carries the ISO string for anyone who needs to paste it. Localising
 * the format does not change the zone; see `i18n/format.ts`.
 */
export function When({
  value,
  className,
}: {
  value: Date | string | null;
  className?: string;
}) {
  const { t, locale } = useT();
  if (value === null) return <span className="text-hint">{t("common.dash")}</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toISOString()}
      className={cn("text-secondary-text tabular-nums", className)}
    >
      {formatAbsolute(locale, date)}
    </time>
  );
}

export function Relative({
  value,
  className,
}: {
  value: Date | string | null;
  className?: string;
}) {
  const { t, locale } = useT();
  if (value === null) return <span className="text-hint">{t("common.dash")}</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toISOString()}
      className={cn("text-secondary-text tabular-nums whitespace-nowrap", className)}
    >
      {formatRelative(locale, date)}
    </time>
  );
}

/**
 * The status vocabulary, as colour.
 *
 * Three tones rather than two, because "not delivered" splits into an ending
 * and a waiting: `bounced` is over and `deferred` is still retrying, and a
 * table that paints them the same red tells the reader to go chase something
 * that is already handling itself.
 */
const TONE_CLASS = {
  success: "border-success-border bg-success-bg text-success",
  warning: "border-warning-border bg-warning-bg text-warning",
  danger: "border-danger-border bg-danger-bg text-danger",
  info: "border-info-border bg-info-bg text-info",
  neutral: "border-neutral-border bg-neutral-bg text-neutral",
} as const;

export type Tone = keyof typeof TONE_CLASS;

const toneVariants = cva("", {
  variants: { tone: TONE_CLASS },
  defaultVariants: { tone: "neutral" },
});

/**
 * A status word, in one of the five tones.
 *
 * The geometry comes from `components/ui/badge` and only the colours are ours,
 * so a tag and a button of the same height still look like they were drawn by
 * the same hand — which is what a second, parallel pill implementation loses.
 */
export function Tag({
  tone,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof Badge>, "variant"> & VariantProps<typeof toneVariants>) {
  return (
    <Badge variant="outline" className={cn(toneVariants({ tone }), className)} {...props}>
      {children}
    </Badge>
  );
}

const calloutVariants = cva(
  "flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm",
  {
    variants: { tone: TONE_CLASS },
    defaultVariants: { tone: "info" },
  },
);

/**
 * The banner that has to be read before the content under it.
 *
 * The injection warning, the unreleased-approvals prompt and the login form's
 * refusals were three separately hand-drawn boxes that happened to agree; one
 * component with the same tone vocabulary as `Tag` means they cannot drift, and
 * that a fourth one does not get invented. `actions` is right-aligned because a
 * banner that asks you to go somewhere should put the door on the far side of
 * the sentence.
 */
export function Callout({
  tone,
  icon,
  actions,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof calloutVariants> & {
    icon?: React.ReactNode;
    actions?: React.ReactNode;
  }) {
  return (
    <div className={cn(calloutVariants({ tone }), className)} {...props}>
      <span className="flex min-w-0 items-start gap-2">
        {icon !== undefined && <span className="mt-px shrink-0 [&>svg]:size-4">{icon}</span>}
        <span className="min-w-0">{children}</span>
      </span>
      {actions}
    </div>
  );
}

const DELIVERY_TONES: Record<string, Tone> = {
  delivered: "success",
  bounced: "danger",
  failed: "danger",
  rejected: "danger",
  complained: "warning",
  deferred: "warning",
  pending_approval: "warning",
};

/** Delivery status, coloured by whether it is a good, pending or bad ending. */
export function StatusTag({ status }: { status: string }) {
  return <Tag tone={DELIVERY_TONES[status] ?? "neutral"}>{status.replaceAll("_", " ")}</Tag>;
}

/**
 * The two provenance flags, together, because they answer different questions
 * and reading one without the other is how they get misused (AGENTS.md).
 * `trusted` says the domain is attributable; it never says the contents are
 * safe to act on, which is what `injectionRisk` is warning about.
 */
export function Provenance({
  trusted,
  injectionRisk,
}: {
  trusted: boolean;
  injectionRisk: boolean;
}) {
  const { t } = useT();
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Tag tone={trusted ? "success" : "warning"} title={t("provenance.attribution")}>
        {trusted ? t("provenance.trusted") : t("provenance.unverified")}
      </Tag>
      {injectionRisk && (
        <Tag tone="danger" title={t("provenance.injectionRiskTitle")}>
          {t("provenance.injectionRisk")}
        </Tag>
      )}
    </span>
  );
}

/**
 * Whether this page is currently being told about new mail.
 *
 * Worth the pixels because the absence of the indicator and the absence of mail
 * look identical: a reader watching an empty inbox needs to know which of "no
 * mail has arrived" and "nothing would reach me if it had" they are looking at.
 */
export function Live({ status }: { status: "connecting" | "live" | "offline" }) {
  const { t } = useT();
  const label =
    status === "live"
      ? t("live.liveTitle")
      : status === "connecting"
        ? t("live.connectingTitle")
        : t("live.offlineTitle");

  return (
    <span className="inline-flex items-center gap-2 text-xs text-secondary-text" title={label}>
      <span className="relative flex size-2">
        {/* The halo only runs while connected. An idle pulse on a dead feed is
            the exact false reassurance this indicator exists to prevent. */}
        {status === "live" && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
        )}
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            status === "live" && "bg-success",
            status === "connecting" && "bg-warning",
            status === "offline" && "bg-danger",
          )}
        />
      </span>
      {status === "live"
        ? t("live.live")
        : status === "connecting"
          ? t("live.connecting")
          : t("live.offline")}
    </span>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-14 text-center text-sm text-secondary-text">{children}</div>;
}

export function Bytes({ value }: { value: number }) {
  const units = ["B", "KB", "MB"];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return (
    <span className="tabular-nums whitespace-nowrap">
      {i === 0 ? n : n.toFixed(1)}
      <span className="text-hint"> {units[i]}</span>
    </span>
  );
}

/**
 * Every page opens the same way: what this is, then what you can do to it.
 *
 * Shared so that the eleventh page cannot invent its own heading size — which
 * is the failure mode a design system exists to prevent, and the one that no
 * amount of tokens prevents on its own.
 */
export function PageHeader({
  title,
  description,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-title">{title}</h1>
        {description && <p className="mt-1 text-sm text-secondary-text">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  );
}

/**
 * A section heading inside a page, with room for the controls that belong to
 * that section — the message body's text/HTML switch is the reason `actions`
 * exists, and building that row by hand is how the second one ends up a
 * different size.
 */
export function SectionTitle({
  children,
  actions,
}: {
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mt-8 mb-3 flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xs font-medium tracking-wider text-hint uppercase">{children}</h2>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Label/value pairs — message headers, delivery metadata, key details.
 *
 * A grid rather than a two-column table so the value column can wrap a long
 * Message-ID without the label column growing to match it.
 */
export function Facts({ children }: { children: React.ReactNode }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-5 gap-y-3 text-sm">
      {children}
    </dl>
  );
}

export function Fact({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-secondary-text">{label}</dt>
      <dd className={cn("m-0 min-w-0 break-words text-body", mono && "font-mono text-[13px]")}>
        {children}
      </dd>
    </>
  );
}

/** Inline monospace, for ids and addresses that get pasted into a terminal. */
export function Mono({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cn("font-mono text-[13px]", className)}>{children}</span>;
}

const textLinkVariants = cva(
  "inline-flex items-center gap-1.5 transition-colors [&>svg]:size-3.5 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        /** A link that is offering an action — a download, a filtered view. */
        default: "text-primary hover:underline",
        /** A link that is the row's content: reads as text, behaves as a link. */
        quiet: "text-title hover:text-primary hover:underline",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

/**
 * A link in running text or in a table cell.
 *
 * `render` rather than a `to` prop, following the registry's own convention: the
 * download and raw-message links must be real navigations to a resource route,
 * while a link between two dashboard pages should stay client-side, and only the
 * caller knows which it is — `<TextLink href>` for the former,
 * `<TextLink render={<Link to=… />}>` for the latter.
 */
export function TextLink({
  className,
  variant,
  render,
  ...props
}: useRender.ComponentProps<"a"> & VariantProps<typeof textLinkVariants>) {
  return useRender({
    defaultTagName: "a",
    props: mergeProps<"a">({ className: cn(textLinkVariants({ variant }), className) }, props),
    render,
    state: { slot: "text-link" },
  });
}

const codeBlockVariants = cva(
  "m-0 overflow-x-auto font-mono text-[13px] leading-relaxed whitespace-pre-wrap",
  {
    variants: {
      variant: {
        /** Fills its card: a message body, a log. */
        plain: "p-4 break-words text-body",
        /**
         * A value to be taken away, so it is a boxed field rather than a
         * paragraph: `select-all` makes one click enough, and `break-all` keeps
         * a 60-character key inside the box instead of widening the dialog.
         */
        boxed:
          "rounded-control border border-border bg-muted px-3 py-2.5 break-all text-title select-all",
      },
    },
    defaultVariants: { variant: "plain" },
  },
);

/** Preformatted monospace: message bodies and minted keys. */
export function CodeBlock({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<"pre"> & VariantProps<typeof codeBlockVariants>) {
  return (
    <pre className={cn(codeBlockVariants({ variant }), className)} {...props}>
      {children}
    </pre>
  );
}

/**
 * The paragraph that explains why a screen behaves the way it does.
 *
 * Several pages end with one, and they are load-bearing — "this credential
 * cannot approve sends" is the answer to a question the reader is about to ask
 * support. Constrained to a reading measure and set below body weight so it
 * reads as commentary rather than as an alert.
 */
export function Note({ className, children, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("mt-3 max-w-prose text-[13px] leading-relaxed text-hint", className)}
      {...props}
    >
      {children}
    </p>
  );
}

/**
 * Keyset pagination, forward only.
 *
 * There is no "Newer" because there is no back cursor to build it from — the
 * ULID cursor points one way (ADR-2). Browser back is the return path, and
 * offering a control that would have to re-query from the top to fake it would
 * be slower than the button the browser already has.
 */
export function Pager({ to }: { to: string }) {
  const { t } = useT();
  return (
    <div className="mt-4 flex justify-center">
      <Button render={<Link to={to} />} variant="outline" size="sm">
        {t("common.older")}
      </Button>
    </div>
  );
}

/**
 * A row of mutually exclusive filters.
 *
 * Scrolls rather than wraps: nine delivery statuses wrap to two lines at tablet
 * width, and a control strip that changes height as you filter makes the table
 * below it jump every time.
 */
export function FilterTabs({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {children}
    </div>
  );
}

/**
 * One filter in that row.
 *
 * A `Button` rather than a bare styled link — this was a class helper, which is
 * the shape a control takes right before someone applies it to something that is
 * not a link and gets a control that looks right and behaves differently. The
 * selected one keeps its background on hover: a tab that lightens under the
 * pointer reads as "not currently applied".
 */
export function FilterTab({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Button
      render={<Link to={to} />}
      variant="ghost"
      size="sm"
      className={cn(
        "shrink-0",
        active ? "bg-selected font-medium text-title hover:bg-selected" : "text-secondary-text",
      )}
    >
      {children}
    </Button>
  );
}
