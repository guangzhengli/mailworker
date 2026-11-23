import { EmailAddress, isDomainError, Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { BodyViewer } from "@web/app/components/body-viewer";
import { type ComposeResult, useCompose } from "@web/app/components/compose-panel";
import { LabelPicker } from "@web/app/components/label-picker";
import { LabelChip, submitOnModEnter, useMessageUpdater } from "@web/app/components/mail-ui";
import { Button } from "@web/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@web/app/components/ui/dropdown-menu";
import { Textarea } from "@web/app/components/ui/textarea";
import { errorMessage, isErrorCode, localeFromMatches, translate, useT } from "@web/app/i18n";
import { cn } from "@web/app/lib/utils";
import { mailHref, readFilters, replySubject, senderName } from "@web/app/mail";
import { Bytes, Fact, Facts, Relative, StatusTag, When } from "@web/app/ui";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  BellIcon,
  BellOffIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DownloadIcon,
  EllipsisIcon,
  MailIcon,
  MailMinusIcon,
  MessageSquareTextIcon,
  PaperclipIcon,
  ReplyIcon,
  ShieldAlertIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/mail-message";

const THREAD_LIMIT = 30;

export const meta: Route.MetaFunction = ({ matches, loaderData }) => {
  const locale = localeFromMatches(matches);
  return [
    {
      title: translate(locale, "message.pageTitle", {
        subject: loaderData?.message.subject || translate(locale, "common.noSubject"),
      }),
    },
  ];
};

export async function loader({ context, request, params }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services, container }) => {
    const message = await services.mailbox.getMessage(caller, Ulid.parse(params.messageId));

    const [thread, notes, inbox, identities] = await Promise.all([
      services.mailbox.getThread(caller, message.threadId).catch(() => [message]),
      services.mailbox.listNotes(caller, message.id),
      services.mailbox.getInbox(caller, message.inboxId).catch(() => null),
      can(caller, "admin") ? services.identity.listIdentities(caller) : Promise.resolve([]),
    ]);

    const recent = thread.slice(-THREAD_LIMIT);
    const shown = recent.some((entry) => entry.id === message.id)
      ? recent
      : [...recent, message];
    const outbound = shown
      .filter((entry) => entry.direction === "outbound")
      .map((entry) => entry.id);
    const deliveries =
      outbound.length === 0
        ? new Map<string, { id: string; status: string }>()
        : await container.dashboard.deliveriesForMessages(caller, outbound);
    const names = new Map(identities.map((identity) => [identity.id, identity.name]));
    const admin = can(caller, "admin");

    return {
      message: {
        id: message.id,
        subject: message.subject,
        direction: message.direction,
        seen: message.seen,
        starred: message.starred,
        archived: message.archivedAt !== null,
        labels: [...message.labels],
        trusted: message.trusted,
        trustReasons: [...message.trustReasons],
        listId: message.listId,
        unsubscribe: message.unsubscribe,
      },
      hiddenEarlier: thread.length - recent.length,
      thread: shown.map((entry) => ({
        id: entry.id,
        direction: entry.direction,
        fromHeader: entry.fromHeader,
        toHeader: entry.toHeader,
        cc: [...entry.cc],
        from: entry.from,
        replyTo: entry.replyTo,
        subject: entry.subject,
        receivedAt: entry.receivedAt,
        hasHtml: (entry.bodyHtml ?? "").trim() !== "",
        // Only the bodies that open expanded are sent; the rest load when picked.
        bodyText:
          entry.id === message.id || entry.id === shown[shown.length - 1]?.id
            ? entry.bodyText
            : null,
        bodyLoaded: entry.id === message.id || entry.id === shown[shown.length - 1]?.id,
        preview: (entry.bodyText ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
        attachments: entry.attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.filename,
          mime: attachment.mime,
          size: attachment.size,
        })),
        auth: entry.auth,
        rfcMessageId: entry.rfcMessageId,
        size: entry.size,
        hasRaw: entry.rawKey !== null,
        agent: entry.identityId === null ? null : (names.get(entry.identityId) ?? null),
        delivery: deliveries.get(entry.id) ?? null,
      })),
      notes: notes.map((note) => ({
        id: note.id,
        body: note.body,
        createdAt: note.createdAt,
        author:
          note.authorIdentityId === null
            ? note.authorSubject
            : (names.get(note.authorIdentityId) ?? note.authorSubject),
        byAgent: note.authorIdentityId !== null,
        deletable: admin || note.authorSubject === caller.subject,
      })),
      inbox:
        inbox === null ? null : { id: inbox.id, address: inbox.address, muted: inbox.muted },
      mayCompose: admin,
      mayManageInbox: can(caller, "inbox:write"),
    };
  });
}

type NoteResult =
  | { readonly ok: true }
  | { readonly error: { readonly code: string; readonly message: string } };

export async function action({ context, request, params }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }): Promise<NoteResult> => {
    const form = await request.formData();
    try {
      if (form.get("intent") === "delete-note") {
        await services.mailbox.deleteNote(caller, Ulid.parse(String(form.get("note"))));
      } else {
        await services.mailbox.addNote(
          caller,
          Ulid.parse(params.messageId),
          String(form.get("body") ?? ""),
        );
      }
      return { ok: true };
    } catch (error) {
      if (isDomainError(error)) return { error: { code: error.code, message: error.message } };
      throw error;
    }
  });
}

type Data = Route.ComponentProps["loaderData"];
type Entry = Data["thread"][number];

export default function MailMessage({ loaderData }: Route.ComponentProps) {
  const { message, thread, notes, inbox } = loaderData;
  const { t } = useT();
  const [search] = useSearchParams();
  const filters = readFilters(search);
  const listHref = mailHref(filters, null, { cursor: search.get("cursor") });
  const navigate = useNavigate();
  const updater = useMessageUpdater();
  const seen = useFetcher();
  const scroller = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set([message.id, thread[thread.length - 1]?.id ?? message.id]),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opened message
  useEffect(() => {
    setExpanded(new Set([message.id, thread[thread.length - 1]?.id ?? message.id]));
    // Its own fetcher: a star or archive clicked right after opening must not
    // interrupt this submission, or the other way round.
    if (!message.seen)
      seen.submit({ id: message.id, seen: "1" }, { method: "post", action: "/mail" });
  }, [message.id]);

  // Only jump within a conversation. For a single message, or the first one,
  // the subject, warnings and notes above it are what should be seen first.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opened message
  useEffect(() => {
    if (thread.length > 1 && thread[0]?.id !== message.id) {
      document.getElementById(`message-${message.id}`)?.scrollIntoView({ block: "start" });
    } else {
      scroller.current?.scrollTo({ top: 0 });
    }
  }, [message.id]);

  const archive = () => {
    const detail = { id: message.id, handled: false };
    window.dispatchEvent(new CustomEvent("mail:archive", { detail }));
    if (!detail.handled) updater.update([message.id], { archived: !message.archived });
  };

  const replyTarget =
    [...thread].reverse().find((entry) => entry.direction === "inbound") ??
    thread[thread.length - 1]!;

  return (
    <article className="flex min-h-0 w-full flex-col">
      <div className="flex items-center gap-1 border-b border-border bg-card px-2 py-1.5">
        <Button
          render={<Link to={listHref} />}
          variant="ghost"
          size="icon-sm"
          aria-label={t("mail.backToList")}
          title={t("mail.backToList")}
          className="lg:hidden"
        >
          <ArrowLeftIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={message.archived ? t("mail.unarchive") : t("mail.archive")}
          title={`${message.archived ? t("mail.unarchive") : t("mail.archive")} (e)`}
          onClick={archive}
        >
          {message.archived ? <ArchiveRestoreIcon /> : <ArchiveIcon />}
        </Button>
        {message.direction === "inbound" && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("mail.markUnread")}
            title={`${t("mail.markUnread")} (u)`}
            onClick={() => {
              updater.update([message.id], { seen: false });
              navigate(listHref);
            }}
          >
            <MailIcon />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-pressed={message.starred}
          aria-label={message.starred ? t("mail.unstar") : t("mail.star")}
          title={`${message.starred ? t("mail.unstar") : t("mail.star")} (s)`}
          onClick={() => updater.update([message.id], { starred: !message.starred })}
        >
          <StarIcon className={cn(message.starred && "fill-warning text-warning")} />
        </Button>
        <LabelPicker
          applied={message.labels}
          onAdd={(name) => updater.update([message.id], { addLabel: [name] })}
          onRemove={(name) => updater.update([message.id], { removeLabel: [name] })}
        />

        <span className="flex-1" />

        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label={t("mail.more")} />}
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            {inbox !== null && loaderData.mayManageInbox && (
              <DropdownMenuItem
                onClick={() => updater.mute(inbox.id, !inbox.muted, inbox.address)}
              >
                {inbox.muted ? <BellIcon /> : <BellOffIcon />}
                {inbox.muted
                  ? t("mail.unmuteAddress", { address: inbox.address })
                  : t("mail.muteAddress", { address: inbox.address })}
              </DropdownMenuItem>
            )}
            {inbox !== null && (
              <DropdownMenuItem
                render={<Link to={mailHref({ view: "all", inbox: inbox.id })} />}
              >
                <MailIcon />
                {t("mail.allFromAddress", { address: inbox.address })}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-5 md:px-6">
          <header className="flex flex-col gap-2">
            <h1 className="m-0 text-xl font-semibold tracking-tight break-words text-title">
              {message.subject === "" ? (
                <span className="text-hint italic">{t("common.noSubject")}</span>
              ) : (
                message.subject
              )}
            </h1>
            {message.labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {message.labels.map((label) => (
                  <LabelChip
                    key={label}
                    name={label}
                    onRemove={() => updater.update([message.id], { removeLabel: [label] })}
                  />
                ))}
              </div>
            )}
          </header>

          {message.direction === "inbound" && !message.trusted && (
            <div
              className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-[13px] text-body"
              title={message.trustReasons.join(", ")}
            >
              <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
              <span>{t("mail.untrusted")}</span>
            </div>
          )}

          {message.unsubscribe !== null && (
            <Unsubscribe listId={message.listId} unsubscribe={message.unsubscribe} />
          )}

          <Notes key={`notes-${message.id}`} notes={notes} />

          {loaderData.hiddenEarlier > 0 && (
            <p className="m-0 text-center text-xs text-hint">
              {t("mail.earlierHidden", { count: loaderData.hiddenEarlier })}
            </p>
          )}

          <ol className="m-0 flex list-none flex-col gap-2 p-0">
            {thread.map((entry) => (
              <ThreadEntry
                key={entry.id}
                entry={entry}
                href={mailHref(filters, entry.id, { cursor: search.get("cursor") })}
                open={expanded.has(entry.id)}
                current={entry.id === message.id}
                onToggle={() =>
                  setExpanded((set) => {
                    const copy = new Set(set);
                    if (copy.has(entry.id)) copy.delete(entry.id);
                    else copy.add(entry.id);
                    return copy;
                  })
                }
              />
            ))}
          </ol>

          {loaderData.mayCompose && inbox !== null && (
            <ReplyBox
              key={`reply-${message.id}`}
              target={replyTarget}
              from={inbox.address}
              subject={message.subject}
            />
          )}
        </div>
      </div>
    </article>
  );
}

function Unsubscribe({
  listId,
  unsubscribe,
}: {
  listId: string | null;
  unsubscribe: NonNullable<Data["message"]["unsubscribe"]>;
}) {
  const { t } = useT();
  const href = unsubscribe.https ?? unsubscribe.mailto;
  if (href === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-secondary-text">
      <MailMinusIcon className="size-4 shrink-0 text-hint" />
      <span className="min-w-0 flex-1 truncate">
        {listId === null ? t("mail.listMail") : t("mail.listMailFrom", { list: listId })}
      </span>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="font-medium text-primary hover:underline"
      >
        {t("mail.unsubscribe")}
      </a>
    </div>
  );
}

function Notes({ notes }: { notes: Data["notes"] }) {
  const { t, locale } = useT();
  const fetcher = useFetcher<NoteResult>();
  const [adding, setAdding] = useState(false);
  const form = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || result === undefined) return;
    if ("error" in result) {
      toast.error(
        isErrorCode(result.error.code)
          ? errorMessage(locale, result.error.code)
          : result.error.message,
      );
    } else {
      form.current?.reset();
      setAdding(false);
    }
  }, [fetcher.data, fetcher.state, locale]);

  if (notes.length === 0 && !adding) {
    return (
      <button
        type="button"
        onClick={() => setAdding(true)}
        className="inline-flex items-center gap-1.5 self-start text-[13px] text-secondary-text hover:text-title"
      >
        <MessageSquareTextIcon className="size-4" />
        {t("notes.add")}
      </button>
    );
  }

  return (
    <section
      aria-label={t("notes.title")}
      className="rounded-lg border border-info-border bg-info-bg/40"
    >
      <ul className="m-0 flex list-none flex-col divide-y divide-info-border p-0">
        {notes.map((note) => (
          <li key={note.id} className="group flex gap-3 px-3 py-2.5">
            <MessageSquareTextIcon className="mt-0.5 size-4 shrink-0 text-info" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-xs text-secondary-text">
                <span className="font-medium text-title">{note.author}</span>
                {note.byAgent && <span className="text-hint">{t("notes.agent")}</span>}
                <Relative value={note.createdAt} className="text-xs" />
              </div>
              <p className="m-0 mt-0.5 text-[13px] whitespace-pre-wrap break-words text-body">
                {note.body}
              </p>
            </div>
            {note.deletable && (
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="delete-note" />
                <input type="hidden" name="note" value={note.id} />
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("notes.delete")}
                  disabled={fetcher.state !== "idle"}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                >
                  <Trash2Icon />
                </Button>
              </fetcher.Form>
            )}
          </li>
        ))}
      </ul>
      {adding ? (
        <fetcher.Form
          ref={form}
          method="post"
          className="flex flex-col gap-2 border-t border-info-border p-3"
        >
          <Textarea
            name="body"
            required
            maxLength={4000}
            rows={3}
            onKeyDown={submitOnModEnter}
            autoFocus
            placeholder={t("notes.placeholder")}
            aria-label={t("notes.placeholder")}
            className="bg-card"
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={fetcher.state !== "idle"}>
              {t("notes.save")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </fetcher.Form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="w-full border-t border-info-border px-3 py-2 text-left text-[13px] text-secondary-text hover:text-title"
        >
          {t("notes.add")}
        </button>
      )}
    </section>
  );
}

function ThreadEntry({
  entry,
  href,
  open,
  current,
  onToggle,
}: {
  entry: Entry;
  href: string;
  open: boolean;
  current: boolean;
  onToggle: () => void;
}) {
  const { t } = useT();
  const from = EmailAddress.parseHeaderList(entry.fromHeader);
  const name = senderName(from);
  const address = from[0]?.address ?? null;

  if (!open) {
    const summary = (
      <>
        <span className="w-40 shrink-0 truncate text-sm font-medium text-title">{name}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-hint">{entry.preview}</span>
        <Relative value={entry.receivedAt} className="shrink-0 text-xs" />
      </>
    );
    const className =
      "flex w-full items-baseline gap-3 rounded-lg border border-border bg-card px-4 py-2.5 text-left hover:bg-hover";
    return (
      <li id={`message-${entry.id}`}>
        {entry.bodyLoaded ? (
          <button type="button" onClick={onToggle} className={className}>
            {summary}
          </button>
        ) : (
          <Link to={href} className={className}>
            {summary}
          </Link>
        )}
      </li>
    );
  }

  return (
    <li
      id={`message-${entry.id}`}
      className={cn(
        "overflow-hidden rounded-lg border bg-card",
        current ? "border-border shadow-xs" : "border-border",
      )}
    >
      {/* Not a button: addresses here are copied often, and a button swallows the selection. */}
      <div className="flex w-full items-start gap-3 px-4 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold text-title">{name}</span>
            {address !== null && address !== name && (
              <span className="font-mono text-xs text-hint">&lt;{address}&gt;</span>
            )}
            {entry.agent !== null && (
              <span className="text-xs text-secondary-text">
                ·{" "}
                {entry.direction === "outbound"
                  ? t("mail.viaAgent", { agent: entry.agent })
                  : t("mail.ownedBy", { agent: entry.agent })}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-xs text-secondary-text" title={entry.toHeader}>
            {t("mail.toLine", { to: entry.toHeader })}
            {entry.cc.length > 0 && ` · ${t("mail.ccLine", { cc: entry.cc.join(", ") })}`}
          </div>
        </div>
        <When value={entry.receivedAt} className="shrink-0 text-xs" />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-expanded="true"
          aria-label={t("mail.collapse")}
          title={t("mail.collapse")}
          onClick={onToggle}
          className="-mt-0.5 shrink-0"
        >
          <ChevronUpIcon />
        </Button>
      </div>

      {entry.delivery !== null && (
        <div className="flex items-center gap-2 px-4 pb-2 text-xs text-secondary-text">
          <StatusTag status={entry.delivery.status} />
          <Link to={`/sent/${entry.delivery.id}`} className="hover:text-title hover:underline">
            {t("mail.deliveryTimeline")}
          </Link>
        </div>
      )}

      <div className="border-t border-border">
        <BodyViewer
          src={`/messages/${entry.id}/body`}
          hasHtml={entry.hasHtml}
          text={entry.bodyText}
          images={entry.direction === "inbound"}
          local
          {...(entry.hasRaw ? { raw: { href: `/v1/messages/${entry.id}/raw` } } : {})}
        />
      </div>

      {entry.attachments.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-2 border-t border-border p-3">
          {entry.attachments.map((attachment) => (
            <li key={attachment.id}>
              <a
                href={`/messages/${entry.id}/attachments/${attachment.id}`}
                download
                className="flex items-center gap-2 rounded-control border border-border px-2.5 py-1.5 text-[13px] text-body hover:bg-hover"
              >
                <PaperclipIcon className="size-3.5 text-hint" />
                <span className="max-w-56 truncate">
                  {attachment.filename ?? t("message.unnamedAttachment")}
                </span>
                <span className="text-xs text-hint">
                  <Bytes value={attachment.size} />
                </span>
                <DownloadIcon className="size-3.5 text-hint" />
              </a>
            </li>
          ))}
        </ul>
      )}

      <details className="group border-t border-border px-4 py-2">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-hint hover:text-title [&::-webkit-details-marker]:hidden">
          <ChevronDownIcon className="size-3.5 -rotate-90 transition-transform group-open:rotate-0" />
          {t("message.details")}
        </summary>
        <Facts className="mt-2">
          {entry.replyTo !== null && <Fact label={t("message.replyTo")}>{entry.replyTo}</Fact>}
          <Fact label={t("message.authentication")}>
            {t("message.authSummary", {
              spf: entry.auth.spf,
              dkim: entry.auth.dkim,
              dmarc: entry.auth.dmarc,
            })}
          </Fact>
          <Fact label={t("message.messageId")}>
            <span className="font-mono text-xs break-all">{entry.rfcMessageId}</span>
          </Fact>
          <Fact label={t("message.size")}>
            <Bytes value={entry.size} />
          </Fact>
        </Facts>
      </details>
    </li>
  );
}

function ReplyBox({ target, from, subject }: { target: Entry; from: string; subject: string }) {
  const { t, locale } = useT();
  const compose = useCompose();
  const fetcher = useFetcher<ComposeResult>();
  const [open, setOpen] = useState(false);
  const text = useRef<HTMLTextAreaElement>(null);
  const to =
    target.direction === "inbound"
      ? (target.replyTo ?? target.from ?? "")
      : EmailAddress.parseHeaderList(target.toHeader)
          .map((entry) => entry.address ?? entry.raw)
          .join(", ");

  useEffect(() => {
    if (open) text.current?.focus();
  }, [open]);

  useEffect(() => {
    const onReply = () => {
      setOpen(true);
      requestAnimationFrame(() => text.current?.focus());
    };
    window.addEventListener("mail:reply", onReply);
    return () => window.removeEventListener("mail:reply", onReply);
  }, []);

  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || result === undefined) return;
    if ("sent" in result) {
      toast.success(t("compose.sentToast"), {
        action: <Link to={`/sent/${result.sent}`}>{t("compose.viewDelivery")}</Link>,
      });
      setOpen(false);
    } else {
      toast.error(
        isErrorCode(result.error.code)
          ? errorMessage(locale, result.error.code)
          : t("mail.updateFailed"),
        {
          description: result.error.message,
        },
      );
    }
  }, [fetcher.data, fetcher.state, locale, t]);

  if (!open) {
    return (
      <Button variant="outline" className="self-start" onClick={() => setOpen(true)}>
        <ReplyIcon />
        {t("message.reply")}
      </Button>
    );
  }

  return (
    <fetcher.Form
      method="post"
      action="/compose"
      className="overflow-hidden rounded-lg border border-border bg-card shadow-xs"
    >
      <input type="hidden" name="stay" value="1" />
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      <input type="hidden" name="subject" value={replySubject(subject)} />
      <input type="hidden" name="inReplyToMessageId" value={target.id} />
      <div className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs text-secondary-text">
        <ReplyIcon className="size-3.5" />
        <span className="truncate">{t("mail.replyingTo", { to, from })}</span>
      </div>
      <Textarea
        ref={text}
        name="text"
        required
        rows={6}
        onKeyDown={submitOnModEnter}
        aria-label={t("compose.body")}
        className="rounded-none border-0 px-4 py-3 shadow-none focus-visible:ring-0"
      />
      <div className="flex items-center gap-2 border-t border-border px-4 py-2">
        <Button type="submit" size="sm" disabled={fetcher.state !== "idle"}>
          {fetcher.state !== "idle" ? t("compose.sending") : t("compose.send")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            compose.open({
              from,
              to,
              subject: replySubject(subject),
              text: text.current?.value ?? "",
              inReplyToMessageId: target.id,
            });
            setOpen(false);
          }}
        >
          {t("mail.openInComposer")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setOpen(false)}
        >
          {t("common.cancel")}
        </Button>
      </div>
    </fetcher.Form>
  );
}
