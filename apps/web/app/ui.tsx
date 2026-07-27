/**
 * The handful of presentational pieces that appear on more than one page.
 *
 * One file rather than a `components/` tree: there are six of them, none has
 * state, and a directory per component would make finding one a navigation
 * problem where it is currently a scroll.
 */

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
export function When({ value }: { value: Date | string | null }) {
  if (value === null) return <span className="muted">—</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()} className="numeric">
      {ABSOLUTE.format(date)}
    </time>
  );
}

export function Relative({ value }: { value: Date | string | null }) {
  if (value === null) return <span className="muted">—</span>;
  const date = typeof value === "string" ? new Date(value) : value;
  return (
    <time dateTime={date.toISOString()} title={date.toISOString()} className="numeric">
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

/** Delivery status, coloured by whether it is a good, pending or bad ending. */
export function StatusTag({ status }: { status: string }) {
  const tone =
    status === "delivered"
      ? "tag-ok"
      : status === "bounced" || status === "failed" || status === "rejected"
        ? "tag-bad"
        : status === "pending_approval" || status === "deferred" || status === "complained"
          ? "tag-warn"
          : "";
  return <span className={`tag ${tone}`}>{status.replaceAll("_", " ")}</span>;
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
    <span className="row" style={{ gap: 5 }}>
      <span
        className={`tag ${trusted ? "tag-ok" : "tag-warn"}`}
        title="SPF/DKIM/DMARC attribution"
      >
        {trusted ? "trusted" : "unverified"}
      </span>
      {injectionRisk && (
        <span className="tag tag-bad" title="The body contains instruction-shaped text">
          injection risk
        </span>
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
    <span className={`live live-${status}`} title={label}>
      <span className="live-dot" aria-hidden="true" />
      {status === "live" ? "live" : status === "connecting" ? "connecting" : "offline"}
    </span>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="pad muted" style={{ textAlign: "center", padding: "40px 16px" }}>
      {children}
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
    <span className="numeric">
      {i === 0 ? n : n.toFixed(1)} {units[i]}
    </span>
  );
}
