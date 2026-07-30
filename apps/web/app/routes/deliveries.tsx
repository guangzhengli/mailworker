import type { DeliveryStatus } from "@mailworker/core";
import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Button } from "@web/app/components/ui/button";
import { Card } from "@web/app/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/app/components/ui/table";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import {
  Callout,
  Empty,
  FilterTab,
  FilterTabs,
  Note,
  PageHeader,
  Pager,
  StatusTag,
  When,
} from "@web/app/ui";
import { ArrowRightIcon, TriangleAlertIcon } from "lucide-react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/deliveries";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "deliveries.pageTitle") },
];

const FILTERS: readonly (DeliveryStatus | "all")[] = [
  "all",
  "pending_approval",
  "queued",
  "dispatched",
  "delivered",
  "deferred",
  "bounced",
  "failed",
  "rejected",
];

function asStatus(value: string | null): DeliveryStatus | null {
  return value !== null && FILTERS.includes(value as DeliveryStatus)
    ? (value as DeliveryStatus)
    : null;
}

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const url = new URL(request.url);
    const status = asStatus(url.searchParams.get("status"));
    const cursor = url.searchParams.get("cursor");

    const page = await services.delivery.list(caller, {
      ...(status === null ? {} : { status }),
      ...(cursor === null ? {} : { cursor: Ulid.parse(cursor) }),
    });

    /**
     * A separate count rather than a filter of the page above: the approval queue
     * is the thing a person opens this screen to act on, and burying it behind
     * "you are on page three of dispatched" is how a message sits unreleased for
     * a day.
     */
    const awaiting = await services.delivery.list(caller, {
      status: "pending_approval",
      limit: 1,
    });

    return {
      deliveries: page.items,
      cursor: page.cursor,
      status: status ?? "all",
      hasAwaiting: awaiting.items.length > 0,
      mayApprove: can(caller, "message:approve"),
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();
    await services.delivery.approve(caller, Ulid.parse(String(form.get("id"))));
    return { approved: true };
  });
}

export default function Deliveries({ loaderData }: Route.ComponentProps) {
  const { deliveries, cursor, status, hasAwaiting, mayApprove } = loaderData;
  const { t } = useT();

  return (
    <>
      <PageHeader title={t("deliveries.title")} description={t("deliveries.description")} />

      {hasAwaiting && status !== "pending_approval" && (
        <Callout
          tone="warning"
          className="mb-4"
          icon={<TriangleAlertIcon />}
          actions={
            <Button
              render={<Link to="/deliveries?status=pending_approval" />}
              variant="outline"
              size="sm"
            >
              {t("deliveries.review")}
              <ArrowRightIcon />
            </Button>
          }
        >
          {t("deliveries.awaiting")}
        </Callout>
      )}

      <FilterTabs>
        {FILTERS.map((filter) => (
          <FilterTab
            key={filter}
            to={filter === "all" ? "/deliveries" : `/deliveries?status=${filter}`}
            active={filter === status}
          >
            {/* The statuses stay in the wire vocabulary — see `locales/en.ts`.
                "all" is this page's own word, so it is translated. */}
            {filter === "all" ? t("deliveries.filterAll") : filter.replaceAll("_", " ")}
          </FilterTab>
        ))}
      </FilterTabs>

      <Card className="overflow-hidden py-0">
        {deliveries.length === 0 ? (
          <Empty>
            {status === "all"
              ? t("deliveries.emptyAll")
              : t("deliveries.emptyFiltered", { status })}
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("field.status")}</TableHead>
                <TableHead>{t("field.recipients")}</TableHead>
                <TableHead className="text-right">{t("field.attempts")}</TableHead>
                <TableHead>{t("field.created")}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {deliveries.map((delivery) => (
                <TableRow key={delivery.id}>
                  <TableCell>
                    <Link to={`/deliveries/${delivery.id}`} className="inline-block">
                      <StatusTag status={delivery.status} />
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-0 truncate font-mono text-[13px]">
                    {delivery.recipients.join(", ")}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{delivery.attempts}</TableCell>
                  <TableCell>
                    <When value={delivery.createdAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    {delivery.status === "pending_approval" && mayApprove && (
                      <Form method="post">
                        <input type="hidden" name="id" value={delivery.id} />
                        <Button type="submit" size="sm">
                          {t("deliveries.approve")}
                        </Button>
                      </Form>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {!mayApprove && <Note>{t("deliveries.cannotApprove")}</Note>}

      {cursor !== null && (
        <Pager
          to={`/deliveries?cursor=${cursor}${status === "all" ? "" : `&status=${status}`}`}
        />
      )}
    </>
  );
}
