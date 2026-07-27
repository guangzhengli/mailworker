/**
 * The presentational pieces that appear on more than one page.
 *
 * One file rather than a `components/` tree: none of these has state, and a
 * directory per component would make finding one a navigation problem where it
 * is currently a scroll. `components/ui/` is different — that is vendored
 * registry code, and keeping it separate is what makes it re-syncable.
 */

import { cn } from "@web/app/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

const ABSOLUTE = new Intl.DateTimeFormat("en-GB", {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
});

/**
 * UTC, always, and labelled as such.
 *
 * Rendered on the server, where the reader's timezone is unknown — a local
 * time formatted from a server guess is wrong in a way that is invisible, and
 * this is a log-reading tool where an hour's error changes the conclusion. The
 * `title` carries the ISO string for anyone who needs to paste it.
 */
export function When({
  value,
  className,
}: {
  value: Date | string | null;
  className?: string;
}) {
  if (value === null) return <span className="text-hint">—</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toISOString()}
      className={cn("text-secondary-text tabular-nums", className)}
    >
      {ABSOLUTE.format(date)}
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
  if (value === null) return <span className="text-hint">—</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toISOString()}
      className={cn("text-secondary-text tabular-nums whitespace-nowrap", className)}
    >
      {ago(date)}
    </time>
  );
}

function ago(date: Date): string {
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  const future = seconds < 0;
  const n = Math.abs(seconds);
  const [value, unit] =
    n < 60
      ? [n, "s"]
      : n < 3600
        ? [Math.round(n / 60), "m"]
        : n < 86400
          ? [Math.round(n / 3600), "h"]
          : [Math.round(n / 86400), "d"];
  return future ? `in ${value}${unit}` : `${value}${unit} ago`;
}

/**
 * The status vocabulary, as colour.
 *
 * Three tones rather than two, because "not delivered" splits into an ending
 * and a waiting: `bounced` is over and `deferred` is still retrying, and a
 * table that paints them the same red tells the reader to go chase something
 * that is already handling itself.
 */
const toneVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-control border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        success: "border-success-border bg-success-bg text-success",
        warning: "border-warning-border bg-warning-bg text-warning",
        danger: "border-danger-border bg-danger-bg text-danger",
        info: "border-info-border bg-info-bg text-info",
        neutral: "border-neutral-border bg-neutral-bg text-neutral",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type Tone = NonNullable<VariantProps<typeof toneVariants>["tone"]>;

export function Tag({
  tone,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof toneVariants>) {
  return (
    <span className={cn(toneVariants({ tone }), className)} {...props}>
      {children}
    </span>
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
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Tag tone={trusted ? "success" : "warning"} title="SPF/DKIM/DMARC attribution">
        {trusted ? "trusted" : "unverified"}
      </Tag>
      {injectionRisk && (
        <Tag tone="danger" title="The body contains instruction-shaped text">
          injection risk
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
  const label =
    status === "live"
      ? "Live — new mail appears by itself"
      : status === "connecting"
        ? "Connecting to the live feed"
        : "Not connected — reload to see new mail";

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
      {status}
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
  title: string;
  description?: string;
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

/** A section heading inside a page. */
export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-8 mb-3 text-xs font-medium tracking-wider text-hint uppercase">
      {children}
    </h2>
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

/**
 * The paragraph that explains why a screen behaves the way it does.
 *
 * Several pages end with one, and they are load-bearing — "this credential
 * cannot approve sends" is the answer to a question the reader is about to ask
 * support. Constrained to a reading measure and set below body weight so it
 * reads as commentary rather than as an alert.
 */
export function Note({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 max-w-prose text-[13px] leading-relaxed text-hint">{children}</p>;
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
  return (
    <div className="mt-4 flex justify-center">
      <a
        href={to}
        className="rounded-control border border-border px-3 py-1.5 text-sm text-secondary-text transition-colors hover:bg-hover hover:text-title"
      >
        Older
      </a>
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

export function filterTabClass(active: boolean): string {
  return cn(
    "shrink-0 rounded-control px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
    active
      ? "bg-selected font-medium text-title"
      : "text-secondary-text hover:bg-hover hover:text-title",
  );
}
