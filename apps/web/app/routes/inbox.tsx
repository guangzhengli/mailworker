import { Ulid } from "@mailworker/core";
import { page } from "@web/app/auth";
import { Button } from "@web/app/components/ui/button";
import { Card } from "@web/app/components/ui/card";
import { Input } from "@web/app/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/app/components/ui/table";
import { cn } from "@web/app/lib/utils";
import { useLiveMail } from "@web/app/live";
import { Empty, Live, Mono, Pager, Provenance, Relative, Tag, When } from "@web/app/ui";
import { ArrowLeftIcon, SearchIcon } from "lucide-react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/inbox";

export async function loader({ context, request, params }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const id = Ulid.parse(params.id);
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const q = url.searchParams.get("q")?.trim() ?? "";

    /**
     * Two round trips rather than one join: the inbox is the page's identity and
     * the messages are its content, and the services that own them are separate
     * on purpose. D1 is local to the Worker, so the second call is microseconds.
     */
    const inbox = await services.mailbox.getInbox(caller, id);
    const page = await services.mailbox.listMessages(caller, {
      inboxId: id,
      ...(q === "" ? {} : { q }),
      ...(cursor === null ? {} : { cursor: Ulid.parse(cursor) }),
    });

    return { inbox, messages: page.items, cursor: page.cursor, q };
  });
}

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `${loaderData.inbox.address} · Mailworker` },
];

export default function InboxPage({ loaderData, params }: Route.ComponentProps) {
  const { inbox, messages, cursor, q } = loaderData;
  // Scoped to this inbox, so a busy account's other mail does not reload this
  // page. The filter is applied server-side; see `app/live.ts`.
  const live = useLiveMail(params.id);

  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate font-mono text-lg font-semibold tracking-tight text-title">
            {inbox.address}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-secondary-text">
            <Tag tone={inbox.kind === "persistent" ? "info" : "neutral"}>{inbox.kind}</Tag>
            {inbox.expiresAt === null ? (
              "never expires"
            ) : (
              <span>
                expires <Relative value={inbox.expiresAt} />
              </span>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <Live status={live} />
          <Button render={<Link to="/" />} variant="outline" size="sm">
            <ArrowLeftIcon />
            All inboxes
          </Button>
        </div>
      </header>

      <Form method="get" className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1 sm:max-w-sm">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-hint" />
          <Input
            name="q"
            defaultValue={q}
            placeholder="Search subject and body…"
            aria-label="Search"
            className="pl-9"
          />
        </div>
        <Button type="submit" variant="outline" size="sm">
          Search
        </Button>
        {q !== "" && (
          <Button render={<Link to={`/inboxes/${params.id}`} />} variant="ghost" size="sm">
            Clear
          </Button>
        )}
      </Form>

      <Card className="overflow-hidden py-0">
        {messages.length === 0 ? (
          <Empty>
            {q === "" ? (
              <>
                Nothing here yet. Mail sent to <Mono>{inbox.address}</Mono> will appear the
                moment it lands.
              </>
            ) : (
              <>
                No message matches <Mono>{q}</Mono>.
              </>
            )}
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>From</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead>Provenance</TableHead>
                <TableHead>Received</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {messages.map((message) => (
                <TableRow key={message.id}>
                  <TableCell className="max-w-56 truncate">
                    {/* Unread is carried by weight on the sender and subject
                        only. Bolding the whole row, timestamps included, is
                        what turns a list into a wall. */}
                    <span className={cn(message.seen ? "text-body" : "font-medium text-title")}>
                      {message.fromHeader}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-0">
                    <Link to={`/messages/${message.id}`} className="group block min-w-0">
                      <div
                        className={cn(
                          "truncate group-hover:text-primary group-hover:underline",
                          message.seen ? "text-body" : "font-medium text-title",
                        )}
                      >
                        {message.subject === "" ? (
                          <span className="text-hint italic">(no subject)</span>
                        ) : (
                          message.subject
                        )}
                      </div>
                      <div className="truncate text-[13px] text-hint">{message.preview}</div>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Provenance
                      trusted={message.trusted}
                      injectionRisk={message.injectionRisk}
                    />
                  </TableCell>
                  <TableCell>
                    <When value={message.receivedAt} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {cursor !== null && (
        <Pager
          to={`/inboxes/${params.id}?cursor=${cursor}${q === "" ? "" : `&q=${encodeURIComponent(q)}`}`}
        />
      )}
    </>
  );
}
