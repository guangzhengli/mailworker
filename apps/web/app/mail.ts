import type { MessageKey } from "@web/app/i18n";

export const VIEWS = ["inbox", "starred", "sent", "all"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABEL: Readonly<Record<View, Extract<MessageKey, `mail.view.${string}`>>> = {
  inbox: "mail.view.inbox",
  starred: "mail.view.starred",
  sent: "mail.view.sent",
  all: "mail.view.all",
};

export type Direction = "in" | "out";

/** Everything that decides which messages the list shows. Lives in the URL. */
export interface MailFilters {
  readonly view: View;
  readonly inbox: string | null;
  readonly dir: Direction | null;
  readonly label: string | null;
  readonly agent: string | null;
  readonly unread: boolean;
  readonly q: string;
}

const EMPTY: MailFilters = {
  view: "inbox",
  inbox: null,
  dir: null,
  label: null,
  agent: null,
  unread: false,
  q: "",
};

function isView(value: string | null): value is View {
  return value !== null && (VIEWS as readonly string[]).includes(value);
}

export function readFilters(search: URLSearchParams): MailFilters {
  const view = search.get("view");
  const dir = search.get("dir");
  const text = (name: string) => {
    const value = search.get(name)?.trim() ?? "";
    return value === "" ? null : value;
  };
  return {
    view: isView(view) ? view : "inbox",
    inbox: text("inbox"),
    dir: dir === "in" || dir === "out" ? dir : null,
    label: text("label"),
    agent: text("agent"),
    unread: search.get("unread") === "1",
    q: text("q") ?? "",
  };
}

/** The list query a view stands for, before ids are parsed. */
export function queryFor(filters: MailFilters) {
  const base =
    filters.view === "inbox"
      ? {
          direction: "inbound" as const,
          archived: false,
          // Picking an address is an explicit choice to look at it, muted or not.
          ...(filters.inbox === null ? { muted: false } : {}),
        }
      : filters.view === "starred"
        ? { starred: true }
        : filters.view === "sent"
          ? { direction: "outbound" as const }
          : {};

  return {
    ...base,
    ...(filters.dir === null
      ? {}
      : { direction: filters.dir === "in" ? ("inbound" as const) : ("outbound" as const) }),
    ...(filters.label === null ? {} : { label: filters.label }),
    ...(filters.unread ? { seen: false } : {}),
    ...(filters.q === "" ? {} : { q: filters.q }),
  };
}

export function searchFor(
  filters: Partial<MailFilters>,
  extra: Readonly<Record<string, string | null>> = {},
): string {
  const merged = { ...EMPTY, ...filters };
  const params = new URLSearchParams();
  if (merged.view !== "inbox") params.set("view", merged.view);
  if (merged.inbox !== null) params.set("inbox", merged.inbox);
  if (merged.dir !== null) params.set("dir", merged.dir);
  if (merged.label !== null) params.set("label", merged.label);
  if (merged.agent !== null) params.set("agent", merged.agent);
  if (merged.unread) params.set("unread", "1");
  if (merged.q !== "") params.set("q", merged.q);
  for (const [key, value] of Object.entries(extra)) {
    if (value !== null && value !== "") params.set(key, value);
  }
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

export function mailHref(
  filters: Partial<MailFilters>,
  messageId?: string | null,
  extra?: Readonly<Record<string, string | null>>,
): string {
  const path = messageId === undefined || messageId === null ? "/mail" : `/mail/${messageId}`;
  return `${path}${searchFor(filters, extra)}`;
}

/** The folder a filter set reads as in the sidebar, if it is one. */
export function folderOf(filters: MailFilters): View | null {
  return filters.inbox === null &&
    filters.label === null &&
    filters.agent === null &&
    filters.dir === null
    ? filters.view
    : null;
}

const LABEL_TONES = [
  "bg-chart-1",
  "bg-chart-2",
  "bg-chart-3",
  "bg-chart-4",
  "bg-chart-5",
] as const;

/** Stable colour per label name, so a label looks the same everywhere it appears. */
export function labelTone(name: string): string {
  let hash = 0;
  for (const char of name.toLowerCase()) hash = (hash * 31 + char.codePointAt(0)!) | 0;
  return LABEL_TONES[Math.abs(hash) % LABEL_TONES.length]!;
}

export function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

/** Display name if the header has one, else the bare address. */
export function senderName(
  entries: ReadonlyArray<{ name: string | null; address: string | null; raw: string }>,
): string {
  const first = entries[0];
  if (first === undefined) return "";
  return first.name ?? first.address ?? first.raw;
}
