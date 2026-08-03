import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { EmailAddress } from "@mailworker/core";
import { Badge } from "@web/app/components/ui/badge";
import { Button } from "@web/app/components/ui/button";
import { Card } from "@web/app/components/ui/card";
import { Input } from "@web/app/components/ui/input";
import { Table, TableBody, TableCell, TableRow } from "@web/app/components/ui/table";
import { useT } from "@web/app/i18n";
import { formatAbsolute, formatRelative } from "@web/app/i18n/format";
import { cn } from "@web/app/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  PaperclipIcon,
  SearchIcon,
} from "lucide-react";
import { useState } from "react";
import { Form, Link } from "react-router";

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
  quiet,
}: {
  trusted: boolean;
  injectionRisk: boolean;
  /**
   * Draw only what is wrong.
   *
   * A listing where every row carries a green "verified sender" tag has spent
   * its loudest signal on its most ordinary case, and the two rows that are
   * actually unverified no longer stand out from the forty that are fine. On a
   * detail page the positive statement is worth making — someone is reading one
   * message and deciding whether to act on it — so `quiet` is off there.
   */
  quiet?: boolean;
}) {
  const { t } = useT();
  if (quiet === true && trusted && !injectionRisk) return null;

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {!(quiet === true && trusted) && (
        <Tag tone={trusted ? "success" : "warning"} title={t("provenance.attribution")}>
          {trusted ? t("provenance.trusted") : t("provenance.unverified")}
        </Tag>
      )}
      {injectionRisk && (
        <Tag tone="danger" title={t("provenance.injectionRiskTitle")}>
          {t("provenance.injectionRisk")}
        </Tag>
      )}
    </span>
  );
}

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

/**
 * An empty table, with the way out of being empty.
 *
 * A list that has nothing in it is the one state where the reader has no next
 * click, so `action` is not decoration — the previous version was a single grey
 * sentence, which left "create an inbox" discoverable only from a form that is
 * no longer on the page.
 */
export function Empty({
  icon,
  children,
  action,
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
      {icon !== undefined && (
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-hint [&>svg]:size-5">
          {icon}
        </span>
      )}
      <p className="m-0 max-w-prose text-sm text-secondary-text">{children}</p>
      {action}
    </div>
  );
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
 * The page's title block, and — on a detail page — the way back out of it.
 *
 * `back` renders above the title rather than as another button in the action
 * row, because it is not one of the things this page can do. Detail pages used
 * to spend a primary-sized button on "All sent" / "Inbox" sitting next to
 * Approve, which put the way out and the irreversible action the same distance
 * from the cursor.
 */
export function PageHeader({
  title,
  description,
  back,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  back?: { to: string; label: string };
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-6">
      {back !== undefined && (
        <Link
          to={back.to}
          className="mb-2.5 inline-flex items-center gap-1 text-[13px] text-secondary-text transition-colors hover:text-title"
        >
          <ChevronLeftIcon className="size-3.5" />
          {back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-title">{title}</h1>
          {description && <p className="mt-1 text-sm text-secondary-text">{description}</p>}
        </div>
        {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
      </div>
    </header>
  );
}

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

export function Facts({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-5 gap-y-3 text-sm",
        className,
      )}
    >
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

export function Mono({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <span className={cn("font-mono text-[13px]", className)}>{children}</span>;
}

/**
 * An address header, with the authenticated part in front.
 *
 * A display name is a string the sender typed and nothing verifies it — SPF,
 * DKIM and DMARC all authenticate the domain, never the name attached to it, so
 * a message from `billing@evil.example` can call itself "PayPal Security" and
 * be perfectly well-signed. Mail clients lead with the name; this page leads
 * with the address and demotes the name to a grey aside, because the question
 * being asked here is who actually sent this.
 *
 * The untouched header stays in `title` — the decomposition is a reading aid,
 * not a claim to have improved on the original.
 */
export function Addresses({ header, className }: { header: string; className?: string }) {
  const { t } = useT();
  const entries = EmailAddress.parseHeaderList(header);
  if (entries.length === 0) return <span className="text-hint">{t("common.dash")}</span>;

  return (
    <span
      className={cn("inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5", className)}
      title={header}
    >
      {entries.map((entry, index) => (
        <span
          // A header that names the same address twice is showing two entries
          // that really are indistinguishable; position is all that is left.
          // biome-ignore lint/suspicious/noArrayIndexKey: nothing else distinguishes them
          key={`${index}-${entry.raw}`}
          className="inline-flex min-w-0 items-baseline gap-1.5"
        >
          <span className="truncate font-mono text-[13px]">
            {entry.address ?? entry.raw}
            {index < entries.length - 1 && <span className="text-hint">,</span>}
          </span>
          {entry.name !== null && (
            <span className="truncate text-[13px] text-hint">{entry.name}</span>
          )}
        </span>
      ))}
    </span>
  );
}

/**
 * A closed-by-default section, as a native `<details>`.
 *
 * No component from the registry, because the platform element is already the
 * whole feature: it is keyboard operable, it is announced as a disclosure, and
 * it opens with JavaScript disabled — which matters here, since what it hides
 * is the evidence you go looking for when something else on the page is broken.
 */
export function Disclosure({
  summary,
  children,
  className,
}: {
  summary: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <details className={cn("group", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-secondary-text transition-colors hover:text-title [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      {children}
    </details>
  );
}

const textLinkVariants = cva(
  "inline-flex items-center gap-1.5 transition-colors [&>svg]:size-3.5 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "text-primary hover:underline",
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
        plain: "p-4 break-words text-body",
        boxed:
          "rounded-control border border-border bg-muted px-3 py-2.5 break-all text-title select-all",
      },
    },
    defaultVariants: { variant: "plain" },
  },
);

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
 * The frame every listing sits in: one card, no padding of its own, the table
 * bleeding to its edges.
 *
 * Four pages were repeating the same three classes, and the one that got them
 * subtly wrong is the one that looked broken.
 */
export function ListCard({ children }: { children: React.ReactNode }) {
  return <Card className="overflow-hidden py-0">{children}</Card>;
}

/**
 * The cell a row is really about: what it is, and underneath in a quieter voice,
 * what tells it apart from the row above.
 *
 * Two lines rather than two columns because the second line is a recognition
 * aid, not a field — giving a preview or a recipient list its own column means
 * sizing a column for text with no natural width, and every listing then has to
 * truncate the thing the reader came to read.
 *
 * The whole block is the link. A row whose only navigable target is a few words
 * of subject makes the reader aim.
 */
export function PrimaryCell({
  to,
  title,
  secondary,
  strong,
}: {
  to: string;
  title: React.ReactNode;
  secondary?: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <Link to={to} className="group block min-w-0">
      <div
        className={cn(
          "truncate group-hover:text-primary group-hover:underline",
          strong === true ? "font-medium text-title" : "text-body",
        )}
      >
        {title}
      </div>
      {secondary !== undefined && (
        <div className="mt-0.5 truncate text-[13px] text-hint">{secondary}</div>
      )}
    </Link>
  );
}

/**
 * The facts a detail page is identified by, across the top rather than down the
 * side.
 *
 * A vertical `<Facts>` list of nine rows costs a screen before the page says
 * anything, and the reader scans a column of labels to find one value. These are
 * the three or four that answer "which message is this" — everything that is
 * evidence rather than identity belongs in the disclosure at the bottom.
 */
export function KeyFacts({ children }: { children: React.ReactNode }) {
  return (
    <dl className="mb-6 grid grid-cols-2 gap-x-6 gap-y-4 border-b border-border pb-5 sm:grid-cols-3 lg:grid-cols-4">
      {children}
    </dl>
  );
}

export function KeyFact({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="mb-1 text-[11px] font-medium tracking-wider text-hint uppercase">
        {label}
      </dt>
      <dd className="m-0 min-w-0 truncate text-sm text-title">{children}</dd>
    </div>
  );
}

/**
 * An id, and the only thing anyone does with an id.
 *
 * Every detail page in this dashboard shows at least one identifier that exists
 * to be pasted somewhere else — into a support thread, a `mailworker status`, a
 * provider's dashboard. Selecting a truncated monospace string by hand is the
 * step that was missing.
 */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useT();

  return (
    <button
      type="button"
      title={value}
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex max-w-full items-center gap-1.5 rounded-control border border-border bg-muted px-2 py-1 font-mono text-[12px] text-secondary-text transition-colors hover:text-title"
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <CheckIcon className="size-3.5 shrink-0 text-success" />
      ) : (
        <CopyIcon className="size-3.5 shrink-0 text-hint" />
      )}
      <span className="sr-only">{copied ? t("common.copied") : label}</span>
    </button>
  );
}

/**
 * A GET form over the listing's own URL.
 *
 * `hidden` inputs rather than a merge in the submit handler: a plain form
 * submission replaces the whole query string, so a search typed while a filter
 * tab is active would otherwise silently clear the tab.
 */
export function SearchForm({
  action,
  value,
  placeholder,
  label,
  keep,
  children,
}: {
  action: string;
  value: string;
  placeholder: string;
  label: string;
  keep?: Readonly<Record<string, string | null>>;
  children?: React.ReactNode;
}) {
  const { t } = useT();

  return (
    <Form method="get" action={action} className="flex flex-1 flex-wrap items-center gap-2">
      {Object.entries(keep ?? {}).map(([name, kept]) =>
        kept === null ? null : <input key={name} type="hidden" name={name} value={kept} />,
      )}
      <div className="relative min-w-56 flex-1 sm:max-w-sm">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-hint" />
        <Input
          name="q"
          defaultValue={value}
          placeholder={placeholder}
          aria-label={label}
          className="pl-9"
        />
      </div>
      {children}
      <Button type="submit" variant="outline" size="sm">
        {t("common.search")}
      </Button>
      {value !== "" && (
        <Button render={<Link to={action} />} variant="ghost" size="sm">
          {t("common.clear")}
        </Button>
      )}
    </Form>
  );
}

/** The row above a listing: filter tabs on the left, search and actions right. */
export function Toolbar({ children }: { children: React.ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">{children}</div>;
}

export function FilterTabs({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {children}
    </div>
  );
}

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

export interface TimelineEvent {
  readonly id: string;
  readonly type: string;
  readonly terminal: boolean;
  readonly occurredAt: Date | string;
  readonly recipient: string | null;
  readonly smtpCode: string | null;
  readonly smtpResponse: string | null;
}

/**
 * What happened to a send, in the provider's own words.
 *
 * The node carries the event's tone rather than a uniform grey dot: on a page
 * whose reason for existing is usually a failure, the shape of the history —
 * three retries then a bounce — should be readable before any of it is.
 *
 * Every event is shown, including ones the state machine refused as out of order
 * or post-terminal. Such an event did not change the delivery, but it is still a
 * fact about what the provider said, and someone reading this page is usually
 * reading it *because* that fact is the answer.
 */
export function Timeline({ events }: { events: readonly TimelineEvent[] }) {
  const { t } = useT();

  return (
    <ol className="m-0 list-none p-4">
      {events.map((event, index) => (
        <li key={event.id} className="relative flex gap-3.5 pb-5 last:pb-0">
          {/* The rail stops at the last node rather than running past it, so the
              timeline reads as ended rather than as still loading. */}
          {index < events.length - 1 && (
            <span
              aria-hidden="true"
              className="absolute top-6 bottom-0 left-[11px] w-px bg-border"
            />
          )}
          <span
            aria-hidden="true"
            className={cn(
              "relative mt-0.5 flex size-[23px] shrink-0 items-center justify-center rounded-full border",
              toneVariants({ tone: DELIVERY_TONES[event.type] ?? "neutral" }),
            )}
          >
            <span className="size-1.5 rounded-full bg-current" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1 pt-0.5">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-medium text-sm text-title">
                {event.type.replaceAll("_", " ")}
              </span>
              <When value={event.occurredAt} className="text-[13px]" />
              {event.terminal && (
                <span className="text-[11px] tracking-wider text-hint uppercase">
                  {t("delivery.terminal")}
                </span>
              )}
            </div>
            {(event.recipient !== null || event.smtpResponse !== null) && (
              <div className="min-w-0 text-[13px] break-words text-secondary-text">
                {event.recipient !== null && <Mono>{event.recipient} </Mono>}
                {event.smtpCode !== null && <>[{event.smtpCode}] </>}
                {event.smtpResponse}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface AttachmentRow {
  readonly key: string;
  readonly filename: string;
  readonly mime: string;
  readonly bytes: number;
  /**
   * Absent for outbound, where the bytes live in the payload blob and a route to
   * stream them back out would be a second way to read message content whose
   * only user is this table. The manifest is what answers "did the invoice go
   * with it".
   */
  readonly href?: string;
}

export function AttachmentList({ items }: { items: readonly AttachmentRow[] }) {
  return (
    <Table>
      <TableBody>
        {items.map((attachment) => (
          <TableRow key={attachment.key}>
            <TableCell>
              {attachment.href === undefined ? (
                <span className="flex items-center gap-2">
                  <PaperclipIcon className="size-3.5 shrink-0 text-hint" />
                  {attachment.filename}
                </span>
              ) : (
                <TextLink render={<Link to={attachment.href} />} variant="quiet">
                  <PaperclipIcon className="text-hint" />
                  {attachment.filename}
                </TextLink>
              )}
            </TableCell>
            <TableCell className="text-secondary-text">{attachment.mime}</TableCell>
            <TableCell className="text-right">
              <Bytes value={attachment.bytes} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
