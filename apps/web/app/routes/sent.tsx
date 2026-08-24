import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
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
import { BUCKET_LABEL, BUCKETS, isBucket, statusesIn } from "@web/app/deliveries";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import {
  Addresses,
  Empty,
  FilterTab,
  FilterTabs,
  ListCard,
  Mono,
  PageHeader,
  Pager,
  PrimaryCell,
  Relative,
  SearchForm,
  StatusTag,
  Toolbar,
} from "@web/app/ui";
import { ChevronsUpDownIcon, PenLineIcon, SendIcon } from "lucide-react";
import { Link } from "react-router";
import type { Route } from "./+types/sent";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "sent.pageTitle") },
];

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const url = new URL(request.url);
    const raw = url.searchParams.get("bucket");
    const bucket = isBucket(raw) ? raw : null;
    const cursor = url.searchParams.get("cursor");
    const agent = url.searchParams.get("agent");
    const q = url.searchParams.get("q")?.trim() ?? "";

    const listed = await services.delivery.list(caller, {
      ...(bucket === null ? {} : { statusIn: statusesIn(bucket) }),
      ...(agent === null ? {} : { identityId: Ulid.parse(agent) }),
      ...(q === "" ? {} : { q }),
      ...(cursor === null ? {} : { cursor: Ulid.parse(cursor) }),
    });

    /**
     * Who sent it, by name.
     *
     * The old column was a two-value tag — `console` or `agent` — which spent a
     * whole column to repeat what the filter tabs already say. Which agent is the
     * question this product is for, and it is also the filter you reach for when
     * one of them starts bouncing. Listing identities needs `admin`, so a scoped
     * credential falls back to the tag it always had.
     */
    const identities = can(caller, "admin")
      ? (await services.identity.listIdentities(caller)).map((identity) => ({
          id: identity.id,
          name: identity.name,
        }))
      : [];
    const nameOf = new Map(identities.map((identity) => [identity.id, identity.name]));

    /**
     * The subject and sender, which are in the payload blob rather than on the
     * row. Recipients are not: the envelope list is on the delivery itself, so
     * the To column survives a payload the retention sweep has already taken.
     *
     * One read per row is the cost of showing what a person uses to recognise a
     * message. R2 reads are parallel and the page is 25 rows.
     */
    const rows = await Promise.all(
      listed.items.map(async (delivery) => {
        const preview = await services.delivery.preview(caller, delivery.id).catch(() => null);
        return {
          id: delivery.id,
          status: delivery.status,
          source: delivery.source,
          agent:
            delivery.identityId === null ? null : (nameOf.get(delivery.identityId) ?? null),
          recipients: delivery.recipients,
          createdAt: delivery.createdAt,
          subject: preview?.subject ?? null,
          from: preview?.from ?? null,
        };
      }),
    );

    return {
      rows,
      cursor: listed.cursor,
      bucket,
      agent,
      q,
      identities,
      mayCompose: can(caller, "admin"),
    };
  });
}

export default function Sent({ loaderData }: Route.ComponentProps) {
  const { rows, cursor, bucket, agent, q, identities } = loaderData;
  const { t, rich } = useT();

  /** Every control on this page narrows the same list, so each keeps the others. */
  const to = (changes: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const merged: Record<string, string | null> = { bucket, agent, q, ...changes };
    for (const [key, value] of Object.entries(merged)) {
      if (value !== null && value !== "") params.set(key, value);
    }
    const query = params.toString();
    return query === "" ? "/sent" : `/sent?${query}`;
  };

  const activeAgent = identities.find((identity) => identity.id === agent) ?? null;

  return (
    <>
      <PageHeader title={t("sent.title")} description={t("sent.description")}>
        {loaderData.mayCompose && (
          <Button render={<Link to="/compose" />} size="sm">
            <PenLineIcon />
            {t("sent.compose")}
          </Button>
        )}
      </PageHeader>

      <Toolbar>
        <SearchForm
          action="/sent"
          value={q}
          placeholder={t("sent.searchPlaceholder")}
          label={t("sent.searchLabel")}
          keep={{ bucket, agent }}
        />
      </Toolbar>

      <Toolbar>
        {/* Four buckets, not ten wire statuses. The status is still on every row —
            it is what you grep for — but choosing what to look at should not
            require knowing the state machine. */}
        <FilterTabs>
          <FilterTab to={to({ bucket: null, cursor: null })} active={bucket === null}>
            {t("sent.bucket.all")}
          </FilterTab>
          {BUCKETS.map((candidate) => (
            <FilterTab
              key={candidate}
              to={to({ bucket: candidate, cursor: null })}
              active={bucket === candidate}
            >
              {t(BUCKET_LABEL[candidate])}
            </FilterTab>
          ))}
        </FilterTabs>

        {identities.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline" size="sm" className="ml-auto">
                  {activeAgent === null ? t("sent.allAgents") : activeAgent.name}
                  <ChevronsUpDownIcon className="text-hint" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem render={<Link to={to({ agent: null, cursor: null })} />}>
                {t("sent.allAgents")}
              </DropdownMenuItem>
              {identities.map((identity) => (
                <DropdownMenuItem
                  key={identity.id}
                  render={<Link to={to({ agent: identity.id, cursor: null })} />}
                >
                  {identity.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </Toolbar>

      <ListCard>
        {rows.length === 0 ? (
          <Empty
            icon={<SendIcon />}
            action={
              loaderData.mayCompose && bucket === null && agent === null && q === "" ? (
                <Button render={<Link to="/compose" />} size="sm" variant="outline">
                  {t("sent.compose")}
                </Button>
              ) : (
                <Button render={<Link to="/sent" />} size="sm" variant="ghost">
                  {t("sent.clearFilters")}
                </Button>
              )
            }
          >
            {q !== ""
              ? rich("sent.noMatch", { query: <Mono>{q}</Mono> })
              : bucket === null && agent === null
                ? t("sent.emptyAll")
                : t("sent.emptyBucket")}
          </Empty>
        ) : (
          <Table className="table-fixed min-w-4xl">
            {/* `min-w-` rather than letting six columns crush: below it the
                wrapper's `overflow-x-auto` scrolls, which keeps every address
                readable instead of ellipsing all of them at once. */}
            <TableHeader>
              <TableRow>
                <TableHead className="w-[22%]">{t("field.subject")}</TableHead>
                <TableHead className="w-[20%]">{t("field.from")}</TableHead>
                <TableHead className="w-[20%]">{t("field.to")}</TableHead>
                <TableHead className="w-[13%]">{t("field.result")}</TableHead>
                <TableHead className="w-[14%]">{t("field.agent")}</TableHead>
                <TableHead className="w-[11%] text-right">{t("field.created")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <PrimaryCell
                      to={`/sent/${row.id}`}
                      strong
                      title={
                        row.subject === null || row.subject === "" ? (
                          <span className="text-hint italic">{t("common.noSubject")}</span>
                        ) : (
                          row.subject
                        )
                      }
                    />
                  </TableCell>
                  <TableCell className="overflow-hidden">
                    {row.from === null ? (
                      <span className="text-hint">{t("common.dash")}</span>
                    ) : (
                      <Addresses
                        header={row.from}
                        bare
                        className="flex flex-nowrap text-secondary-text"
                      />
                    )}
                  </TableCell>
                  <TableCell className="overflow-hidden">
                    <Addresses
                      header={row.recipients.join(", ")}
                      bare
                      className="flex flex-nowrap text-secondary-text"
                    />
                  </TableCell>
                  <TableCell>
                    <StatusTag status={row.status} />
                  </TableCell>
                  <TableCell className="overflow-hidden truncate">
                    {row.agent !== null ? (
                      <Mono className="text-secondary-text">{row.agent}</Mono>
                    ) : row.source === "console" ? (
                      <Mono className="text-secondary-text">console</Mono>
                    ) : (
                      <span className="text-[13px] text-hint">{t("sent.byAgent")}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {/* Relative, not the absolute UTC stamp the detail pages use:
                        a listing is scanned, and "3d ago" is read at a glance
                        where an ISO date has to be subtracted. The exact instant
                        is one hover away, in the title. */}
                    <Relative value={row.createdAt} />
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
