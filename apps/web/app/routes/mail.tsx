import { EmailAddress, isDomainError, Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { useCompose } from "@web/app/components/compose-panel";
import { LabelPicker } from "@web/app/components/label-picker";
import {
  LabelChip,
  type MailActionResult,
  type MessageChange,
  useMessageUpdater,
} from "@web/app/components/mail-ui";
import { Button } from "@web/app/components/ui/button";
import { Checkbox } from "@web/app/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@web/app/components/ui/dropdown-menu";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import { cn } from "@web/app/lib/utils";
import { useLiveMail } from "@web/app/live";
import {
  labelTone,
  type MailFilters,
  mailHref,
  queryFor,
  readFilters,
  senderName,
  VIEW_LABEL,
} from "@web/app/mail";
import { Live, Relative, StatusTag, Tag } from "@web/app/ui";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BellIcon,
  BellOffIcon,
  ChevronsUpDownIcon,
  InboxIcon,
  MailIcon,
  MailOpenIcon,
  MessageSquareTextIcon,
  PaperclipIcon,
  SearchIcon,
  StarIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, Outlet, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/mail";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "mail.pageTitle") },
];

const PAGE_SIZE = 50;

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services, container }) => {
    const url = new URL(request.url);
    const filters = readFilters(url.searchParams);
    const cursor = url.searchParams.get("cursor");

    const listed = await services.mailbox.listMessages(caller, {
      ...queryFor(filters),
      ...(filters.inbox === null ? {} : { inboxId: Ulid.parse(filters.inbox) }),
      ...(filters.agent === null ? {} : { identityId: Ulid.parse(filters.agent) }),
      ...(cursor === null ? {} : { cursor: Ulid.parse(cursor) }),
      limit: PAGE_SIZE,
    });

    const outbound = listed.items
      .filter((message) => message.direction === "outbound")
      .map((message) => message.id);

    const [deliveries, inbox, identities] = await Promise.all([
      outbound.length === 0
        ? Promise.resolve(new Map<string, { id: string; status: string }>())
        : container.dashboard.deliveriesForMessages(caller, outbound),
      filters.inbox === null
        ? Promise.resolve(null)
        : services.mailbox.getInbox(caller, Ulid.parse(filters.inbox)).catch(() => null),
      can(caller, "admin") ? services.identity.listIdentities(caller) : Promise.resolve([]),
    ]);

    return {
      filters,
      cursor,
      next: listed.cursor,
      messages: listed.items.map((message) => ({
        id: message.id,
        direction: message.direction,
        fromHeader: message.fromHeader,
        toHeader: message.toHeader,
        recipient: message.envelopeRecipient ?? message.to[0] ?? null,
        subject: message.subject,
        preview: message.preview,
        receivedAt: message.receivedAt,
        seen: message.seen,
        starred: message.starred,
        archived: message.archivedAt !== null,
        labels: [...message.labels],
        attachmentCount: message.attachmentCount,
        noteCount: message.noteCount,
        delivery: deliveries.get(message.id) ?? null,
      })),
      inbox:
        inbox === null
          ? null
          : {
              id: inbox.id,
              address: inbox.address,
              displayName: inbox.displayName,
              muted: inbox.muted,
              kind: inbox.kind,
            },
      agents: identities.map((identity) => ({ id: identity.id, name: identity.name })),
      mayManageInbox: can(caller, "inbox:write"),
    };
  });
}

/**
 * State changes for one or many messages, and muting an address. Posted by
 * fetchers from the list, the reading pane and the keyboard, so it answers with
 * data rather than a redirect and reports failures inline.
 */
export async function action({ context, request }: Route.ActionArgs) {
  return await page(
    context,
    request,
    async ({ caller, services }): Promise<MailActionResult> => {
      const form = await request.formData();
      const flag = (name: string) => {
        const value = form.get(name);
        return value === null ? undefined : value === "1";
      };
      const names = (name: string) =>
        form
          .getAll(name)
          .map((value) => String(value).trim())
          .filter((value) => value !== "");

      try {
        if (form.get("intent") === "mute") {
          await services.mailbox.updateInbox(caller, Ulid.parse(String(form.get("inbox"))), {
            muted: form.get("muted") === "1",
          });
          return { ok: true };
        }

        const seen = flag("seen");
        const starred = flag("starred");
        const archived = flag("archived");
        const addLabels = names("addLabel");
        const removeLabels = names("removeLabel");
        await services.mailbox.updateMessages(
          caller,
          form.getAll("id").map((id) => Ulid.parse(String(id))),
          {
            ...(seen === undefined ? {} : { seen }),
            ...(starred === undefined ? {} : { starred }),
            ...(archived === undefined ? {} : { archived }),
            ...(addLabels.length === 0 ? {} : { addLabels }),
            ...(removeLabels.length === 0 ? {} : { removeLabels }),
          },
        );
        return { ok: true };
      } catch (error) {
        if (isDomainError(error))
          return { error: { code: error.code, message: error.message } };
        throw error;
      }
    },
  );
}

type LoaderData = Route.ComponentProps["loaderData"];
type Row = LoaderData["messages"][number];

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest(
      'input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"]',
    ) !== null
  );
}

export default function Mail({ loaderData }: Route.ComponentProps) {
  const { filters, cursor, messages, next, inbox, agents } = loaderData;
  const { t } = useT();
  const params = useParams();
  const openId = params["messageId"] ?? null;
  const navigate = useNavigate();
  const compose = useCompose();
  const live = useLiveMail(filters.inbox ?? undefined);
  const updater = useMessageUpdater();
  const search = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const listKey = JSON.stringify([filters, cursor]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new listing clears the selection
  useEffect(() => setSelected(new Set()), [listKey]);

  const hrefFor = (id: string | null) => mailHref(filters, id, { cursor });
  const index = openId === null ? -1 : messages.findIndex((message) => message.id === openId);
  const current = index === -1 ? null : messages[index]!;
  const selectedRows = messages.filter((message) => selected.has(message.id));

  const setArchived = (ids: readonly string[], archived: boolean) => {
    updater.update(ids, { archived });
    toast.success(
      !archived
        ? t("mail.unarchivedToast")
        : ids.length === 1
          ? t("mail.archivedToast")
          : t("mail.archivedManyToast", { count: ids.length }),
      {
        action: {
          label: t("mail.undo"),
          onClick: () => updater.update(ids, { archived: !archived }),
        },
      },
    );
  };

  const archiveAndAdvance = (row: Row) => {
    setArchived([row.id], !row.archived);
    if (filters.view === "inbox" && !row.archived && openId === row.id) {
      const position = messages.findIndex((message) => message.id === row.id);
      const following = messages[position + 1] ?? messages[position - 1] ?? null;
      navigate(hrefFor(following?.id ?? null), { replace: true });
    }
  };

  /** The reading pane's archive button, so it advances exactly like `e` does. */
  useEffect(() => {
    const onArchive = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; handled: boolean }>).detail;
      const row = messages.find((message) => message.id === detail.id);
      if (row === undefined) return;
      detail.handled = true;
      archiveAndAdvance(row);
    };
    window.addEventListener("mail:archive", onArchive);
    return () => window.removeEventListener("mail:archive", onArchive);
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const go = (row: Row | undefined) => row !== undefined && navigate(hrefFor(row.id));
      switch (event.key) {
        case "j":
          go(index === -1 ? messages[0] : messages[index + 1]);
          break;
        case "k":
          go(index === -1 ? messages[0] : messages[index - 1]);
          break;
        case "s":
          if (current !== null) updater.update([current.id], { starred: !current.starred });
          break;
        case "e":
          if (current !== null) archiveAndAdvance(current);
          break;
        case "u":
          if (current !== null) {
            updater.update([current.id], { seen: false });
            navigate(hrefFor(null));
          }
          break;
        case "x":
          if (current !== null) {
            setSelected((set) => toggle(set, current.id));
          }
          break;
        case "r":
          if (current !== null) window.dispatchEvent(new CustomEvent("mail:reply"));
          break;
        case "c":
          if (compose.available) compose.open();
          break;
        case "/":
          event.preventDefault();
          search.current?.focus();
          break;
        case "Escape":
          if (selected.size > 0) setSelected(new Set());
          else if (openId !== null) navigate(hrefFor(null));
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="flex h-[calc(100dvh-49px)] min-h-0 md:h-dvh">
      <section
        aria-label={t("mail.listLabel")}
        className={cn(
          "min-h-0 min-w-0 flex-col border-r border-border bg-card",
          openId === null
            ? "flex flex-1 lg:max-w-[26rem] xl:max-w-[30rem]"
            : "hidden lg:flex lg:w-[22rem] lg:flex-none xl:w-[26rem] 2xl:w-[30rem]",
        )}
      >
        <ListHeader
          data={loaderData}
          live={live}
          searchRef={search}
          onMute={(muted) => inbox !== null && updater.mute(inbox.id, muted, inbox.address)}
        />

        {selectedRows.length > 0 ? (
          <BulkBar
            rows={selectedRows}
            total={messages.length}
            onSelectAll={() => setSelected(new Set(messages.map((message) => message.id)))}
            onClear={() => setSelected(new Set())}
            update={(change) => {
              const ids = selectedRows.map((row) => row.id);
              if (change.archived !== undefined) {
                setArchived(ids, change.archived);
                setSelected(new Set());
              } else {
                updater.update(ids, change);
              }
            }}
          />
        ) : (
          <FilterBar filters={filters} agents={agents} />
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {cursor !== null && (
            <Link
              to={mailHref(filters)}
              className="block border-b border-border px-4 py-2 text-center text-[13px] text-secondary-text hover:bg-hover hover:text-title"
            >
              {t("mail.latest")}
            </Link>
          )}
          {messages.length === 0 ? (
            <EmptyList filters={filters} />
          ) : (
            <ul className="m-0 list-none divide-y divide-border p-0">
              {messages.map((row) => (
                <MessageRow
                  key={row.id}
                  row={row}
                  href={hrefFor(row.id)}
                  open={row.id === openId}
                  selected={selected.has(row.id)}
                  selecting={selected.size > 0}
                  showRecipient={filters.inbox === null}
                  onSelect={() => setSelected((set) => toggle(set, row.id))}
                  onStar={() => updater.update([row.id], { starred: !row.starred })}
                />
              ))}
            </ul>
          )}

          {next !== null && (
            <div className="flex justify-center p-4">
              <Button
                render={<Link to={mailHref(filters, null, { cursor: next })} />}
                variant="outline"
                size="sm"
              >
                {t("common.older")}
              </Button>
            </div>
          )}
        </div>
      </section>

      <section
        aria-label={t("mail.paneLabel")}
        className={cn(
          "min-h-0 min-w-0 flex-1 bg-background",
          openId === null ? "hidden lg:flex" : "flex",
        )}
      >
        {openId === null ? <EmptyPane /> : <Outlet />}
      </section>
    </div>
  );
}

function toggle(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const copy = new Set(set);
  if (copy.has(id)) copy.delete(id);
  else copy.add(id);
  return copy;
}

function ListHeader({
  data,
  live,
  searchRef,
  onMute,
}: {
  data: LoaderData;
  live: ReturnType<typeof useLiveMail>;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onMute: (muted: boolean) => void;
}) {
  const { t } = useT();
  const { filters, inbox } = data;

  const title =
    inbox !== null ? (
      <span className="truncate font-mono text-[15px]" title={inbox.address}>
        {inbox.address}
      </span>
    ) : filters.label !== null ? (
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className={cn("size-2.5 shrink-0 rounded-full", labelTone(filters.label))}
        />
        <span className="truncate">{filters.label}</span>
      </span>
    ) : (
      t(VIEW_LABEL[filters.view])
    );

  return (
    <div className="flex flex-col gap-3 border-b border-border px-4 pt-4 pb-3">
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="m-0 flex min-w-0 flex-1 items-center gap-2 text-lg font-semibold tracking-tight text-title">
          {title}
          {inbox?.muted === true && <Tag>{t("mail.muted")}</Tag>}
        </h1>
        <Live status={live} />
      </div>

      {inbox !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <DirectionTabs filters={filters} />
          <span className="flex-1" />
          {data.mayManageInbox && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onMute(!inbox.muted)}
              title={inbox.muted ? t("mail.unmuteHint") : t("mail.muteHint")}
            >
              {inbox.muted ? <BellIcon /> : <BellOffIcon />}
              {inbox.muted ? t("mail.unmute") : t("mail.mute")}
            </Button>
          )}
        </div>
      )}

      <Form method="get" action="/mail" className="relative">
        {Object.entries({
          // Searching from the inbox looks everywhere: the mail someone is
          // hunting for is often on a muted or temporary address.
          view: filters.view === "inbox" ? "all" : filters.view,
          inbox: filters.inbox,
          dir: filters.dir,
          label: filters.label,
          agent: filters.agent,
          unread: filters.unread ? "1" : null,
        }).map(([name, value]) =>
          value === null ? null : <input key={name} type="hidden" name={name} value={value} />,
        )}
        <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-hint" />
        <input
          ref={searchRef}
          name="q"
          type="search"
          defaultValue={filters.q}
          key={filters.q}
          placeholder={
            filters.inbox !== null ||
            filters.label !== null ||
            filters.view === "starred" ||
            filters.view === "sent"
              ? t("mail.searchScoped")
              : t("mail.searchAll")
          }
          aria-label={t("mail.searchLabel")}
          className="h-9 w-full rounded-control border border-border bg-background pr-3 pl-9 text-sm outline-none placeholder:text-hint focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
        />
      </Form>
    </div>
  );
}

function DirectionTabs({ filters }: { filters: MailFilters }) {
  const { t } = useT();
  const tabs = [
    { dir: null, label: t("mail.dirAll") },
    { dir: "in" as const, label: t("mail.dirIn") },
    { dir: "out" as const, label: t("mail.dirOut") },
  ];
  return (
    <div className="flex gap-0.5 rounded-control bg-muted p-0.5">
      {tabs.map((tab) => (
        <Link
          key={tab.label}
          to={mailHref({ ...filters, dir: tab.dir })}
          aria-current={filters.dir === tab.dir ? "page" : undefined}
          className={cn(
            "rounded-[calc(var(--radius-control)-2px)] px-2.5 py-0.5 text-[13px]",
            filters.dir === tab.dir
              ? "bg-card font-medium text-title shadow-xs ring-1 ring-foreground/10 dark:bg-popover"
              : "text-secondary-text hover:text-title",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

function Chip({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      aria-pressed={active}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[13px] transition-colors",
        active
          ? "border-primary/40 bg-primary/10 text-title"
          : "border-border text-secondary-text hover:bg-hover hover:text-title",
      )}
    >
      {children}
    </Link>
  );
}

function FilterBar({
  filters,
  agents,
}: {
  filters: MailFilters;
  agents: LoaderData["agents"];
}) {
  const { t } = useT();
  const agent = agents.find((candidate) => candidate.id === filters.agent) ?? null;
  const narrowed = filters.unread || filters.agent !== null || filters.q !== "";

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-4 py-2">
      <Chip to={mailHref({ ...filters, unread: !filters.unread })} active={filters.unread}>
        {t("mail.filterUnread")}
      </Chip>

      {agents.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[13px] transition-colors",
                  agent !== null
                    ? "border-primary/40 bg-primary/10 text-title"
                    : "border-border text-secondary-text hover:bg-hover hover:text-title",
                )}
              />
            }
          >
            <span className="max-w-36 truncate">{agent?.name ?? t("mail.filterAgent")}</span>
            <ChevronsUpDownIcon className="size-3.5 text-hint" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            <DropdownMenuItem render={<Link to={mailHref({ ...filters, agent: null })} />}>
              {t("mail.anyAgent")}
            </DropdownMenuItem>
            {agents.map((candidate) => (
              <DropdownMenuItem
                key={candidate.id}
                render={<Link to={mailHref({ ...filters, agent: candidate.id })} />}
              >
                {candidate.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {narrowed && (
        <Link
          to={mailHref({ ...filters, unread: false, agent: null, q: "" })}
          className="ml-auto inline-flex items-center gap-1 text-[13px] text-secondary-text hover:text-title"
        >
          <XIcon className="size-3.5" />
          {t("mail.clearFilters")}
        </Link>
      )}
    </div>
  );
}

function BulkBar({
  rows,
  total,
  onSelectAll,
  onClear,
  update,
}: {
  rows: readonly Row[];
  total: number;
  onSelectAll: () => void;
  onClear: () => void;
  update: (change: MessageChange) => void;
}) {
  const { t } = useT();
  const allRead = rows.every((row) => row.seen);
  const allStarred = rows.every((row) => row.starred);
  const allArchived = rows.every((row) => row.archived);
  const applied = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows)
      for (const label of row.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
    return [...counts.entries()]
      .filter(([, count]) => count === rows.length)
      .map(([label]) => label);
  }, [rows]);

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-border bg-selected/60 px-3 py-1.5">
      <Checkbox
        checked={rows.length === total}
        indeterminate={rows.length < total}
        onCheckedChange={(checked) => (checked ? onSelectAll() : onClear())}
        aria-label={t("mail.selectAll")}
        className="mx-1"
      />
      <span className="mr-1 text-[13px] text-title tabular-nums">
        {t("mail.selected", { count: rows.length })}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        title={allArchived ? t("mail.unarchive") : t("mail.archive")}
        aria-label={allArchived ? t("mail.unarchive") : t("mail.archive")}
        onClick={() => update({ archived: !allArchived })}
      >
        {allArchived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title={allRead ? t("mail.markUnread") : t("mail.markRead")}
        aria-label={allRead ? t("mail.markUnread") : t("mail.markRead")}
        onClick={() => update({ seen: !allRead })}
      >
        {allRead ? <MailIcon /> : <MailOpenIcon />}
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title={allStarred ? t("mail.unstar") : t("mail.star")}
        aria-label={allStarred ? t("mail.unstar") : t("mail.star")}
        onClick={() => update({ starred: !allStarred })}
      >
        <StarIcon className={cn(allStarred && "fill-warning text-warning")} />
      </Button>
      <LabelPicker
        applied={applied}
        onAdd={(name) => update({ addLabel: [name] })}
        onRemove={(name) => update({ removeLabel: [name] })}
      />
      <Button
        variant="ghost"
        size="icon-sm"
        className="ml-auto"
        aria-label={t("mail.clearSelection")}
        title={t("mail.clearSelection")}
        onClick={onClear}
      >
        <XIcon />
      </Button>
    </div>
  );
}

function MessageRow({
  row,
  href,
  open,
  selected,
  selecting,
  showRecipient,
  onSelect,
  onStar,
}: {
  row: Row;
  href: string;
  open: boolean;
  selected: boolean;
  selecting: boolean;
  showRecipient: boolean;
  onSelect: () => void;
  onStar: () => void;
}) {
  const { t } = useT();
  const outbound = row.direction === "outbound";
  const who = outbound
    ? t("mail.toPrefix", { to: senderName(EmailAddress.parseHeaderList(row.toHeader)) })
    : senderName(EmailAddress.parseHeaderList(row.fromHeader));
  const unread = !row.seen && !outbound;

  return (
    <li
      className={cn(
        "group relative flex gap-2 py-2.5 pr-4 pl-2 transition-colors",
        open ? "bg-selected" : selected ? "bg-selected/60" : "hover:bg-hover",
      )}
    >
      <Link
        to={href}
        aria-current={open ? "true" : undefined}
        aria-label={`${who}: ${row.subject || t("common.noSubject")}`}
        className="absolute inset-0 z-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      />

      <div className="relative z-10 flex w-7 shrink-0 flex-col items-center gap-1.5 pt-0.5">
        <Checkbox
          checked={selected}
          onCheckedChange={onSelect}
          aria-label={t("mail.select")}
          className={cn(
            !selected &&
              !selecting &&
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100",
          )}
        />
        <button
          type="button"
          onClick={onStar}
          aria-pressed={row.starred}
          aria-label={row.starred ? t("mail.unstar") : t("mail.star")}
          className={cn(
            "rounded-sm text-hint hover:text-warning focus-visible:outline-2 focus-visible:outline-ring",
            row.starred && "text-warning",
          )}
        >
          <StarIcon className={cn("size-4", row.starred && "fill-warning")} />
        </button>
      </div>

      <div className="pointer-events-none relative z-0 min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {unread && (
            <span
              aria-hidden="true"
              className="size-2 shrink-0 self-center rounded-full bg-primary"
            />
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm",
              unread ? "font-semibold text-title" : "text-body",
            )}
          >
            {who}
          </span>
          <Relative value={row.receivedAt} className="shrink-0 text-xs" />
        </div>
        <div
          className={cn(
            "truncate text-[13px]",
            unread ? "font-medium text-title" : "text-body",
          )}
        >
          {row.subject === "" ? (
            <span className="text-hint italic">{t("common.noSubject")}</span>
          ) : (
            row.subject
          )}
        </div>
        {row.preview !== "" && (
          <div className="truncate text-[13px] text-hint">{row.preview}</div>
        )}
        {showRecipient && !outbound && row.recipient !== null && (
          <div
            className="mt-0.5 truncate font-mono text-[11px] text-hint"
            title={row.recipient}
          >
            → {row.recipient}
          </div>
        )}

        {(row.labels.length > 0 ||
          row.attachmentCount > 0 ||
          row.noteCount > 0 ||
          row.delivery !== null ||
          row.archived) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {row.delivery !== null && <StatusTag status={row.delivery.status} />}
            {row.labels.slice(0, 3).map((label) => (
              <LabelChip key={label} name={label} />
            ))}
            {row.labels.length > 3 && (
              <span className="text-xs text-hint">+{row.labels.length - 3}</span>
            )}
            {row.archived && <span className="text-xs text-hint">{t("mail.archivedTag")}</span>}
            {row.attachmentCount > 0 && (
              <PaperclipIcon
                aria-label={t("mail.hasAttachments")}
                className="size-3.5 text-hint"
              />
            )}
            {row.noteCount > 0 && (
              <MessageSquareTextIcon
                aria-label={t("mail.hasNotes")}
                className="size-3.5 text-hint"
              />
            )}
          </div>
        )}
      </div>
    </li>
  );
}

function EmptyList({ filters }: { filters: MailFilters }) {
  const { t } = useT();
  const searching = filters.q !== "" || filters.unread || filters.agent !== null;
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-hint">
        <InboxIcon className="size-5" />
      </span>
      <p className="m-0 max-w-72 text-sm text-secondary-text">
        {searching
          ? t("mail.noMatch")
          : filters.view === "inbox" && filters.inbox === null
            ? t("mail.inboxZero")
            : t("mail.empty")}
      </p>
      {searching ? (
        <div className="flex flex-wrap justify-center gap-2">
          {filters.q !== "" &&
            (filters.view !== "all" || filters.inbox !== null || filters.label !== null) && (
              <Button
                render={<Link to={mailHref({ view: "all", q: filters.q })} />}
                variant="outline"
                size="sm"
              >
                {t("mail.searchEverywhere", { query: filters.q })}
              </Button>
            )}
          <Button
            render={<Link to={mailHref({ ...filters, q: "", unread: false, agent: null })} />}
            variant="ghost"
            size="sm"
          >
            {t("mail.clearFilters")}
          </Button>
        </div>
      ) : (
        filters.view === "inbox" &&
        filters.inbox === null && (
          <>
            <p className="m-0 max-w-72 text-xs text-hint">{t("mail.inboxZeroHint")}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                render={<Link to={mailHref({ view: "all" })} />}
                variant="outline"
                size="sm"
              >
                {t("mail.viewAll")}
              </Button>
              <Button render={<Link to="/inboxes" />} variant="ghost" size="sm">
                {t("mail.manageAddresses")}
              </Button>
            </div>
          </>
        )
      )}
    </div>
  );
}

function EmptyPane() {
  const { t } = useT();
  const keys: ReadonlyArray<[string, string]> = [
    ["j / k", t("mail.keyNav")],
    ["s", t("mail.keyStar")],
    ["e", t("mail.keyArchive")],
    ["r", t("mail.keyReply")],
    ["c", t("mail.keyCompose")],
    ["/", t("mail.keySearch")],
  ];
  return (
    <div className="m-auto flex flex-col items-center gap-4 p-8 text-center">
      <MailOpenIcon className="size-8 text-hint" />
      <p className="m-0 text-sm text-secondary-text">{t("mail.pickOne")}</p>
      <dl className="m-0 grid grid-cols-[auto_auto] gap-x-3 gap-y-1 text-xs text-hint">
        {keys.map(([key, label]) => (
          <div key={key} className="contents">
            <dt className="text-right">
              <kbd className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-secondary-text">
                {key}
              </kbd>
            </dt>
            <dd className="m-0 text-left">{label}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
