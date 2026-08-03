import { can, page } from "@web/app/auth";
import { Button } from "@web/app/components/ui/button";
import { Card, CardContent } from "@web/app/components/ui/card";
import { statusesIn } from "@web/app/deliveries";
import { localeFromMatches, plural, translate, useT } from "@web/app/i18n";
import { Callout, Empty, Mono, PageHeader, SectionTitle, StatusTag, When } from "@web/app/ui";
import { ArrowRightIcon, TriangleAlertIcon } from "lucide-react";
import { Link } from "react-router";
import type { Route } from "./+types/overview";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "overview.pageTitle") },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The landing page, and the one that decides whether this reads as a product or
 * as a database front-end.
 *
 * It answers the five questions someone actually opens the dashboard with — is
 * setup done, is anything waiting on me, did today's mail go out, did anything
 * break, what just arrived — none of which any single table could answer
 * before.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const since = new Date(Date.now() - DAY_MS);

    const [waiting, problems, inboxes, recentSends] = await Promise.all([
      services.delivery.list(caller, { status: "pending_approval", limit: 50 }),
      services.delivery.list(caller, { statusIn: statusesIn("problem"), limit: 50 }),
      services.mailbox.listInboxes(caller, { limit: 50 }),
      services.delivery.list(caller, { limit: 5 }),
    ]);

    // The newest mail across every inbox. Listing without an inbox filter is
    // what makes this "what just arrived" rather than "what arrived in the inbox
    // you happened to open".
    const recentMail = await services.mailbox.listMessages(caller, {
      direction: "inbound",
      limit: 5,
    });

    /**
     * Diagnostics is admin-only, so a narrower session gets no setup card rather
     * than a card that cannot load. `sandbox` is exempt from the sending checks
     * — it sends without a binding by design.
     */
    const diagnosis = can(caller, "admin") ? await services.delivery.diagnose(caller) : null;
    const failing =
      diagnosis === null
        ? 0
        : diagnosis
            .flatMap((domain) => domain.checks)
            .filter((check) => check.status === "fail").length;

    const sentToday = recentSends.items.filter(
      (delivery) => delivery.createdAt.getTime() >= since.getTime(),
    ).length;

    return {
      waiting: waiting.items.length,
      problemsToday: problems.items.filter(
        (delivery) => delivery.createdAt.getTime() >= since.getTime(),
      ).length,
      inboxes: inboxes.items.length,
      sentToday,
      recentMail: recentMail.items,
      recentSends: recentSends.items,
      failing,
      hasChecks: diagnosis !== null,
    };
  });
}

function Stat({
  label,
  value,
  to,
  tone,
}: {
  label: string;
  value: number;
  to: string;
  tone?: "warning" | "danger";
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <Link to={to} className="group block">
          <div className="text-[13px] text-secondary-text group-hover:text-title">{label}</div>
          <div
            className={
              tone === "danger" && value > 0
                ? "mt-1 text-2xl font-semibold tabular-nums text-danger"
                : tone === "warning" && value > 0
                  ? "mt-1 text-2xl font-semibold tabular-nums text-warning"
                  : "mt-1 text-2xl font-semibold tabular-nums text-title"
            }
          >
            {value}
          </div>
        </Link>
      </CardContent>
    </Card>
  );
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { t, locale } = useT();

  return (
    <>
      <PageHeader title={t("overview.title")} />

      {loaderData.hasChecks && loaderData.failing > 0 && (
        <Callout
          tone="warning"
          className="mb-4"
          icon={<TriangleAlertIcon />}
          actions={
            <Button render={<Link to="/settings/diagnostics" />} variant="outline" size="sm">
              {t("overview.runChecks")}
              <ArrowRightIcon />
            </Button>
          }
        >
          {plural(locale, "overview.setupIncomplete", loaderData.failing)}
        </Callout>
      )}

      {loaderData.waiting > 0 && (
        <Callout
          tone="warning"
          className="mb-4"
          icon={<TriangleAlertIcon />}
          actions={
            <Button render={<Link to="/approvals" />} variant="outline" size="sm">
              {t("nav.approvals")}
              <ArrowRightIcon />
            </Button>
          }
        >
          {t("overview.awaitingHeld")}
        </Callout>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t("overview.awaiting")}
          value={loaderData.waiting}
          to="/approvals"
          tone="warning"
        />
        <Stat label={t("overview.sentToday")} value={loaderData.sentToday} to="/sent" />
        <Stat
          label={t("overview.problemsToday")}
          value={loaderData.problemsToday}
          to="/sent?bucket=problem"
          tone="danger"
        />
        <Stat label={t("overview.inboxCount")} value={loaderData.inboxes} to="/inboxes" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <SectionTitle
            actions={
              <Button render={<Link to="/inbox" />} variant="ghost" size="xs">
                {t("overview.viewAll")}
              </Button>
            }
          >
            {t("overview.recentMail")}
          </SectionTitle>
          <Card className="overflow-hidden py-0">
            {loaderData.recentMail.length === 0 ? (
              <Empty>{t("overview.noRecentMail")}</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {loaderData.recentMail.map((message) => (
                  <li key={message.id}>
                    <Link
                      to={`/messages/${message.id}`}
                      className="flex items-baseline gap-3 px-4 py-3 hover:bg-hover"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-title">
                          {message.subject === "" ? t("common.noSubject") : message.subject}
                        </span>
                        <span className="block truncate text-[13px] text-hint">
                          {message.fromHeader}
                        </span>
                      </span>
                      <When value={message.receivedAt} className="shrink-0 text-[13px]" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div>
          <SectionTitle
            actions={
              <Button render={<Link to="/sent" />} variant="ghost" size="xs">
                {t("overview.viewAll")}
              </Button>
            }
          >
            {t("overview.recentSends")}
          </SectionTitle>
          <Card className="overflow-hidden py-0">
            {loaderData.recentSends.length === 0 ? (
              <Empty>{t("overview.noRecentSends")}</Empty>
            ) : (
              <ul className="divide-y divide-border">
                {loaderData.recentSends.map((delivery) => (
                  <li key={delivery.id}>
                    <Link
                      to={`/sent/${delivery.id}`}
                      className="flex items-baseline gap-3 px-4 py-3 hover:bg-hover"
                    >
                      <span className="min-w-0 flex-1">
                        <Mono className="block truncate text-[13px]">
                          {delivery.recipients.join(", ")}
                        </Mono>
                      </span>
                      <StatusTag status={delivery.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
