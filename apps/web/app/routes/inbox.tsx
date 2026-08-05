import { Ulid } from "@mailworker/core";
import { page } from "@web/app/auth";
import { Button } from "@web/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@web/app/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/app/components/ui/table";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import { cn } from "@web/app/lib/utils";
import { useLiveMail } from "@web/app/live";
import {
  Addresses,
  Empty,
  ListCard,
  Live,
  Mono,
  PageHeader,
  Pager,
  PrimaryCell,
  Relative,
  SearchForm,
  Toolbar,
} from "@web/app/ui";
import { ChevronsUpDownIcon, InboxIcon } from "lucide-react";
import { Link } from "react-router";
import type { Route } from "./+types/inbox";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "inbox.pageTitle") },
];

/**
 * Everything that arrived, across every address.
 *
 * The dashboard used to make the inbox *address* the way in to reading mail, so
 * "did the verification code land" could not be answered without first knowing
 * which of a dozen addresses it was sent to. An address is configuration; the
 * mail is the content. This is the content page, and `/inboxes` is now where
 * addresses are managed.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const q = url.searchParams.get("q")?.trim() ?? "";
    const inbox = url.searchParams.get("inbox");

    /**
     * `direction: "inbound"` is load-bearing here in a way it never was on the
     * per-inbox page: the messages table also holds the archived copy of every
     * outbound send, and an unfiltered listing would show each of them twice —
     * once here and once under Sent.
     */
    const listed = await services.mailbox.listMessages(caller, {
      direction: "inbound",
      ...(inbox === null ? {} : { inboxId: Ulid.parse(inbox) }),
      ...(q === "" ? {} : { q }),
      ...(cursor === null ? {} : { cursor: Ulid.parse(cursor) }),
    });

    /**
     * Expired addresses included: their mail is still here, so the filter menu
     * has to be able to name them.
     */
    const inboxes = await services.mailbox.listInboxes(caller, { includeExpired: true });

    return {
      messages: listed.items.map((message) => ({
        id: message.id,
        subject: message.subject,
        fromHeader: message.fromHeader,
        toHeader: message.toHeader,
        seen: message.seen,
        receivedAt: message.receivedAt,
      })),
      cursor: listed.cursor,
      q,
      inbox,
      inboxes: inboxes.items.map((row) => ({ id: row.id, address: row.address })),
    };
  });
}

export default function Inbox({ loaderData }: Route.ComponentProps) {
  const { messages, cursor, q, inbox, inboxes } = loaderData;
  // Scoped to one address when the filter is on, so a busy account's other mail
  // does not reload this page. The filter is applied server-side; see `app/live.ts`.
  const live = useLiveMail(inbox ?? undefined);
  const { t, rich } = useT();

  const to = (changes: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const merged: Record<string, string | null> = { q, inbox, ...changes };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== null && value !== "") params.set(key, value);
    }
    const query = params.toString();
    return query === "" ? "/inbox" : `/inbox?${query}`;
  };

  const activeInbox = inboxes.find((row) => row.id === inbox) ?? null;

  return (
    <>
      <PageHeader title={t("inbox.title")} description={t("inbox.description")}>
        <Live status={live} />
        <Button render={<Link to="/inboxes" />} variant="outline" size="sm">
          {t("inbox.manageAddresses")}
        </Button>
      </PageHeader>

      <Toolbar>
        <SearchForm
          action="/inbox"
          value={q}
          placeholder={t("inbox.searchPlaceholder")}
          label={t("inbox.searchLabel")}
          keep={{ inbox }}
        />

        {inboxes.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm">
                  <span className="max-w-48 truncate">
                    {activeInbox === null ? t("inbox.allAddresses") : activeInbox.address}
                  </span>
                  <ChevronsUpDownIcon className="text-hint" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
              <DropdownMenuItem render={<Link to={to({ inbox: null, cursor: null })} />}>
                {t("inbox.allAddresses")}
              </DropdownMenuItem>
              {inboxes.map((row) => (
                <DropdownMenuItem
                  key={row.id}
                  render={<Link to={to({ inbox: row.id, cursor: null })} />}
                >
                  <span className="font-mono text-[13px]">{row.address}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </Toolbar>

      <ListCard>
        {messages.length === 0 ? (
          <Empty
            icon={<InboxIcon />}
            action={
              q === "" && inbox === null ? (
                <Button render={<Link to="/inboxes" />} size="sm" variant="outline">
                  {t("inbox.manageAddresses")}
                </Button>
              ) : (
                <Button render={<Link to="/inbox" />} size="sm" variant="ghost">
                  {t("sent.clearFilters")}
                </Button>
              )
            }
          >
            {q === "" ? t("inbox.empty") : rich("inbox.noMatch", { query: <Mono>{q}</Mono> })}
          </Empty>
        ) : (
          <Table className="table-fixed">
            {/* `table-fixed` so the percentages below are obeyed. Auto layout
                widens whichever column happens to hold the longest address and
                starves the rest, which is what made From and To unreadable. */}
            <TableHeader>
              <TableRow>
                <TableHead className="w-[28%]">{t("field.subject")}</TableHead>
                <TableHead className="w-[29%]">{t("field.from")}</TableHead>
                <TableHead className="w-[29%]">{t("field.to")}</TableHead>
                <TableHead className="w-[14%] text-right">{t("field.received")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {messages.map((message) => (
                <TableRow key={message.id}>
                  <TableCell>
                    <div className="flex min-w-0 items-center gap-2.5">
                      {/* Unread as a mark rather than only as weight: bold alone
                          is invisible in a list where half the subjects are long
                          enough to truncate anyway. */}
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          message.seen ? "bg-transparent" : "bg-primary",
                        )}
                        title={message.seen ? undefined : t("inbox.unread")}
                      />
                      <PrimaryCell
                        to={`/messages/${message.id}`}
                        strong={!message.seen}
                        title={
                          message.subject === "" ? (
                            <span className="text-hint italic">{t("common.noSubject")}</span>
                          ) : (
                            message.subject
                          )
                        }
                      />
                    </div>
                  </TableCell>
                  {/* `flex` rather than the component's default `inline-flex`:
                      only a block-level flex container takes the fixed cell
                      width, which is what lets its children truncate instead of
                      overflowing. */}
                  <TableCell className="overflow-hidden">
                    <Addresses
                      header={message.fromHeader}
                      bare
                      className={cn(
                        "flex flex-nowrap",
                        message.seen ? "text-body" : "font-medium text-title",
                      )}
                    />
                  </TableCell>
                  <TableCell className="overflow-hidden">
                    <Addresses
                      header={message.toHeader}
                      bare
                      className="flex flex-nowrap text-secondary-text"
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <Relative value={message.receivedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </ListCard>

      {cursor !== null && <Pager to={to({ cursor })} />}
    </>
  );
}
