import { can, page } from "@web/app/auth";
import { Button } from "@web/app/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@web/app/components/ui/card";
import { statusesIn } from "@web/app/deliveries";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import {
  Empty,
  Mono,
  PageHeader,
  Relative,
  SectionTitle,
  StatusTag,
  Tag,
  type Tone,
  When,
} from "@web/app/ui";
import {
  ActivityIcon,
  ArrowRightIcon,
  BotIcon,
  CheckCircle2Icon,
  CircleIcon,
  InboxIcon,
  SendIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Link } from "react-router";
import type { Route } from "./+types/overview";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "overview.pageTitle") },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The human control plane.
 *
 * Totals come from a dedicated aggregate projection; the bounded entity lists
 * below are previews only. This distinction is important: a page of five recent
 * sends is useful activity, but it is never a count.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services, container, env }) => {
    const generatedAt = new Date();
    const since = new Date(generatedAt.getTime() - DAY_MS);
    const admin = can(caller, "admin");

    const [
      summary,
      approvals,
      problems,
      recentMail,
      recentSends,
      diagnosis,
      identities,
      agentPulse,
      readiness,
    ] = await Promise.all([
      container.dashboard.summary(caller, since, generatedAt),
      services.delivery.list(caller, {
        status: "pending_approval",
        order: "asc",
        limit: 3,
      }),
      services.delivery.list(caller, {
        statusIn: statusesIn("problem"),
        limit: 3,
      }),
      services.mailbox.listMessages(caller, { direction: "inbound", limit: 5 }),
      services.delivery.list(caller, { limit: 5 }),
      admin ? services.delivery.diagnose(caller) : Promise.resolve(null),
      admin ? services.identity.listIdentities(caller) : Promise.resolve([]),
      admin ? container.dashboard.agentPulse(caller, since) : Promise.resolve(null),
      admin ? container.dashboard.readiness(caller, generatedAt) : Promise.resolve(null),
    ]);

    const identityNames = new Map(identities.map((identity) => [identity.id, identity.name]));
    const attention = await Promise.all(
      [...problems.items, ...approvals.items].map(async (delivery) => {
        const preview = await services.delivery.preview(caller, delivery.id).catch(() => null);
        return {
          id: delivery.id,
          kind:
            delivery.status === "pending_approval"
              ? ("approval" as const)
              : ("problem" as const),
          status: delivery.status,
          subject: preview?.subject ?? null,
          recipients: delivery.recipients,
          reason: delivery.rejectReason ?? delivery.lastError,
          agent:
            delivery.identityId === null
              ? delivery.source === "console"
                ? "console"
                : null
              : (identityNames.get(delivery.identityId) ?? delivery.identityId),
          at:
            delivery.status === "pending_approval"
              ? delivery.createdAt
              : delivery.statusChangedAt,
        };
      }),
    );

    const activity = [
      ...recentMail.items.map((message) => ({
        kind: "inbound" as const,
        id: message.id,
        at: message.receivedAt,
        subject: message.subject,
        secondary: message.fromHeader,
        status: null,
      })),
      ...recentSends.items.map((delivery) => ({
        kind: "outbound" as const,
        id: delivery.id,
        at: delivery.updatedAt,
        subject: null,
        secondary: delivery.recipients.join(", "),
        status: delivery.status,
      })),
    ]
      .sort((left, right) => right.at.getTime() - left.at.getTime())
      .slice(0, 8);

    const domainHealth =
      diagnosis === null
        ? null
        : {
            domains: diagnosis.length,
            failing: diagnosis
              .flatMap((domain) => domain.checks)
              .filter((check) => check.status === "fail").length,
            warnings: diagnosis
              .flatMap((domain) => domain.checks)
              .filter((check) => check.status === "warn").length,
            unknown: diagnosis
              .flatMap((domain) => domain.checks)
              .filter((check) => check.status === "unknown").length,
          };

    return {
      generatedAt,
      mode: caller.mode,
      summary,
      attention,
      activity,
      agentPulse,
      readiness,
      isNew:
        readiness !== null &&
        summary.totalDeliveries === 0 &&
        summary.totalMessages === 0 &&
        (readiness.domains === 0 ||
          readiness.activeInboxes === 0 ||
          readiness.agents === 0 ||
          readiness.activeKeys === 0),
      health: {
        domain: domainHealth,
        sendingConfigured: caller.mode === "sandbox" || env.SEND_EMAIL !== undefined,
        sendingRequired: caller.mode !== "sandbox",
        dispatchConfigured: env.DISPATCH_QUEUE !== undefined,
        webhookConfigured: env.WEBHOOK_QUEUE !== undefined,
      },
    };
  });
}

function Stat({
  label,
  value,
  to,
  tone,
  detail,
}: {
  label: string;
  value: number;
  to: string;
  tone?: "warning" | "danger";
  detail: string;
}) {
  return (
    <Card>
      <CardContent className="py-4">
        <Link to={to} className="group block rounded-control focus-visible:outline-2">
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
          <div className="mt-1 text-xs text-hint">{detail}</div>
        </Link>
      </CardContent>
    </Card>
  );
}

function HealthRow({
  label,
  detail,
  tone,
  status,
}: {
  label: string;
  detail: string;
  tone: Tone;
  status: string;
}) {
  return (
    <li className="flex items-start justify-between gap-4 py-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium text-title">{label}</span>
        <span className="mt-0.5 block text-xs text-hint">{detail}</span>
      </span>
      <Tag tone={tone} className="mt-0.5 shrink-0">
        {status}
      </Tag>
    </li>
  );
}

function Readiness({ loaderData }: { loaderData: Route.ComponentProps["loaderData"] }) {
  const { t, rich } = useT();
  const readiness = loaderData.readiness;
  if (!loaderData.isNew || readiness === null) return null;

  const steps = [
    {
      done: readiness.domains > 0,
      title: t("overview.readyDomain"),
      detail: rich("overview.readyDomainDetail", { command: <Mono>mailworker deploy</Mono> }),
      to: "/settings/diagnostics",
    },
    {
      done: readiness.activeInboxes > 0,
      title: t("overview.readyInbox"),
      detail: t("overview.readyInboxDetail"),
      to: "/inboxes",
    },
    {
      done: readiness.agents > 0,
      title: t("overview.readyAgent"),
      detail: t("overview.readyAgentDetail"),
      to: "/agents",
    },
    {
      done: readiness.activeKeys > 0,
      title: t("overview.readyKey"),
      detail: t("overview.readyKeyDetail"),
      to: "/agents",
    },
  ];
  const next = steps.find((step) => !step.done) ?? steps[steps.length - 1]!;

  return (
    <Card className="mb-6 border-info-border bg-info-bg/40">
      <CardHeader>
        <CardTitle className="text-base text-title">{t("overview.readyTitle")}</CardTitle>
        <p className="text-sm text-secondary-text">{t("overview.readyDescription")}</p>
      </CardHeader>
      <CardContent className="grid gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <ol className="grid gap-3 sm:grid-cols-2">
          {steps.map((step) => (
            <li key={step.title} className="flex items-start gap-2.5">
              {step.done ? (
                <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-success" />
              ) : (
                <CircleIcon className="mt-0.5 size-4 shrink-0 text-hint" />
              )}
              <span>
                <span className="block text-sm font-medium text-title">{step.title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-hint">
                  {step.detail}
                </span>
              </span>
            </li>
          ))}
        </ol>
        <Button render={<Link to={next.to} />} size="sm">
          {t("overview.continueSetup")}
          <ArrowRightIcon />
        </Button>
      </CardContent>
    </Card>
  );
}

type OverviewData = Route.ComponentProps["loaderData"];
type DomainHealth = OverviewData["health"]["domain"];

function OverviewSection({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0">
      <SectionTitle actions={actions} className="mt-0 min-h-7">
        {title}
      </SectionTitle>
      {children}
    </section>
  );
}

function AttentionPanel({ data, domain }: { data: OverviewData; domain: DomainHealth }) {
  const { t } = useT();
  const shownApprovals = data.attention.filter((item) => item.kind === "approval").length;

  return (
    <OverviewSection
      title={t("overview.needsAttention")}
      actions={
        data.summary.pendingApproval > shownApprovals ? (
          <Button render={<Link to="/approvals" />} variant="ghost" size="xs">
            {t("overview.viewAll")}
          </Button>
        ) : undefined
      }
    >
      <Card className="overflow-hidden py-0">
        {data.attention.length === 0 && (domain?.failing ?? 0) === 0 ? (
          <div className="flex items-center gap-3 px-4 py-5 text-sm text-secondary-text">
            <CheckCircle2Icon className="size-5 shrink-0 text-success" />
            {t("overview.attentionClear")}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {(domain?.failing ?? 0) > 0 && (
              <li>
                <Link
                  to="/settings/diagnostics"
                  className="flex items-start gap-3 px-4 py-3.5 hover:bg-hover"
                >
                  <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-title">
                      {t("overview.domainChecksFailing", { count: domain?.failing ?? 0 })}
                    </span>
                    <span className="mt-0.5 block text-xs text-hint">
                      {t("overview.domainChecksAction")}
                    </span>
                  </span>
                  <ArrowRightIcon className="mt-0.5 size-4 shrink-0 text-hint" />
                </Link>
              </li>
            )}
            {data.attention.map((item) => (
              <li key={item.id}>
                <Link
                  to={item.kind === "approval" ? "/approvals" : `/sent/${item.id}`}
                  className="flex items-start gap-3 px-4 py-3.5 hover:bg-hover"
                >
                  {item.kind === "approval" ? (
                    <ShieldAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
                  ) : (
                    <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium text-title">
                        {item.subject === null || item.subject === ""
                          ? item.recipients.join(", ")
                          : item.subject}
                      </span>
                      {item.kind === "problem" && <StatusTag status={item.status} />}
                    </span>
                    <span className="mt-1 block truncate text-xs text-hint">
                      {item.agent === null
                        ? t("overview.unassignedAgent")
                        : t("overview.byAgent", { agent: item.agent })}
                      {item.reason === null ? "" : ` · ${item.reason}`}
                    </span>
                  </span>
                  <Relative value={item.at} className="shrink-0 text-xs" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </OverviewSection>
  );
}

function ActivityPanel({ data }: { data: OverviewData }) {
  const { t } = useT();

  return (
    <OverviewSection
      title={t("overview.activity")}
      actions={
        <span className="flex items-center gap-2 text-xs text-hint">
          <ActivityIcon className="size-3.5" />
          {t("overview.latestActivity")}
        </span>
      }
    >
      <Card className="overflow-hidden py-0">
        {data.activity.length === 0 ? (
          <Empty>{t("overview.noActivity")}</Empty>
        ) : (
          <ul className="divide-y divide-border">
            {data.activity.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                <Link
                  to={
                    item.kind === "inbound" ? `/mail/${item.id}?view=all` : `/sent/${item.id}`
                  }
                  className="flex items-start gap-3 px-4 py-3.5 hover:bg-hover"
                >
                  {item.kind === "inbound" ? (
                    <InboxIcon className="mt-0.5 size-4 shrink-0 text-info" />
                  ) : (
                    <SendIcon className="mt-0.5 size-4 shrink-0 text-secondary-text" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-title">
                      {item.kind === "inbound"
                        ? item.subject === ""
                          ? t("common.noSubject")
                          : item.subject
                        : item.secondary}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-hint">
                      {item.kind === "inbound" ? item.secondary : t("overview.outboundEvent")}
                    </span>
                  </span>
                  {item.status === null ? (
                    <Relative value={item.at} className="shrink-0 text-xs" />
                  ) : (
                    <StatusTag status={item.status} />
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </OverviewSection>
  );
}

function HealthPanel({
  data,
  domain,
  domainTone,
  domainStatus,
}: {
  data: OverviewData;
  domain: DomainHealth;
  domainTone: Tone;
  domainStatus: string;
}) {
  const { t } = useT();

  return (
    <OverviewSection title={t("overview.runtimeHealth")}>
      <Card className="py-0">
        <CardContent className="px-4">
          <ul className="divide-y divide-border">
            <HealthRow
              label={t("overview.healthDomains")}
              detail={
                domain === null
                  ? t("overview.healthLimitedDetail")
                  : t("overview.healthDomainDetail", { count: domain.domains })
              }
              tone={domainTone}
              status={domainStatus}
            />
            <HealthRow
              label={t("overview.healthSending")}
              detail={
                data.health.sendingRequired
                  ? t("overview.healthSendingDetail")
                  : t("overview.healthSandboxDetail")
              }
              tone={data.health.sendingConfigured ? "success" : "danger"}
              status={
                data.health.sendingConfigured
                  ? t("overview.healthReady")
                  : t("overview.healthMissing")
              }
            />
            <HealthRow
              label={t("overview.healthDispatch")}
              detail={t("overview.healthDispatchDetail")}
              tone={data.health.dispatchConfigured ? "success" : "danger"}
              status={
                data.health.dispatchConfigured
                  ? t("overview.healthReady")
                  : t("overview.healthMissing")
              }
            />
            <HealthRow
              label={t("overview.healthWebhooks")}
              detail={t("overview.healthWebhooksDetail")}
              tone={data.health.webhookConfigured ? "success" : "neutral"}
              status={
                data.health.webhookConfigured
                  ? t("overview.healthReady")
                  : t("overview.healthOptional")
              }
            />
          </ul>
          <Button
            render={<Link to="/settings/diagnostics" />}
            variant="ghost"
            size="xs"
            className="mt-1 mb-3"
          >
            {t("overview.openDiagnostics")}
            <ArrowRightIcon />
          </Button>
        </CardContent>
      </Card>
    </OverviewSection>
  );
}

function AgentPanel({ data }: { data: OverviewData }) {
  const { t } = useT();

  return (
    <OverviewSection
      title={t("overview.agentPulse")}
      actions={
        <Button render={<Link to="/agents" />} variant="ghost" size="xs">
          {t("overview.manageAgents")}
        </Button>
      }
    >
      <Card className="overflow-hidden py-0">
        {data.agentPulse === null ? (
          <Empty icon={<BotIcon />}>{t("overview.agentLimited")}</Empty>
        ) : data.agentPulse.length === 0 ? (
          <Empty
            icon={<BotIcon />}
            action={
              <Button render={<Link to="/agents" />} variant="outline" size="sm">
                {t("overview.createAgent")}
              </Button>
            }
          >
            {t("overview.noAgents")}
          </Empty>
        ) : (
          <ul className="divide-y divide-border">
            {data.agentPulse.map((agent) => (
              <li key={agent.id} className="flex items-start gap-3 px-4 py-3.5">
                <BotIcon className="mt-0.5 size-4 shrink-0 text-hint" />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <Mono className="font-medium text-title">{agent.name}</Mono>
                    {agent.requireApproval && (
                      <Tag tone="warning">{t("overview.approvalOn")}</Tag>
                    )}
                    {agent.problems > 0 && (
                      <Tag tone="danger">
                        {t("overview.agentProblems", { count: agent.problems })}
                      </Tag>
                    )}
                  </span>
                  <span className="mt-1 block text-xs text-hint">
                    {agent.dailySendQuota === null
                      ? t("overview.agentUnlimited", { used: agent.quotaUsed })
                      : t("overview.agentQuota", {
                          used: agent.quotaUsed,
                          quota: agent.dailySendQuota,
                        })}
                    {agent.pendingApproval > 0
                      ? ` · ${t("overview.agentWaiting", { count: agent.pendingApproval })}`
                      : ""}
                  </span>
                </span>
                <Relative value={agent.lastActivityAt} className="shrink-0 text-xs" />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </OverviewSection>
  );
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { t } = useT();
  const domain = loaderData.health.domain;
  const domainTone: Tone =
    domain === null || domain.domains === 0
      ? "neutral"
      : domain.failing > 0
        ? "danger"
        : domain.warnings > 0 || domain.unknown > 0
          ? "warning"
          : "success";
  const domainStatus =
    domain === null
      ? t("overview.healthLimited")
      : domain.domains === 0
        ? t("overview.healthNotSet")
        : domain.failing > 0
          ? t("overview.healthFailing")
          : domain.warnings > 0 || domain.unknown > 0
            ? t("overview.healthWarning")
            : t("overview.healthHealthy");

  return (
    <>
      <PageHeader title={t("overview.title")} description={t("overview.description")}>
        <span aria-live="polite" className="text-xs text-hint">
          {t("overview.generatedAt")} <When value={loaderData.generatedAt} />
        </span>
      </PageHeader>

      <Readiness loaderData={loaderData} />

      <div className="mb-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label={t("overview.awaiting")}
          value={loaderData.summary.pendingApproval}
          to="/approvals"
          tone="warning"
          detail={t("overview.currentBacklog")}
        />
        <Stat
          label={t("overview.inboundWindow")}
          value={loaderData.summary.inbound}
          to="/mail"
          detail={t("overview.past24Hours")}
        />
        <Stat
          label={t("overview.outboundWindow")}
          value={loaderData.summary.outbound}
          to="/sent"
          detail={t("overview.deliveredWindow", { count: loaderData.summary.delivered })}
        />
        <Stat
          label={t("overview.problemsWindow")}
          value={loaderData.summary.problems}
          to="/sent?bucket=problem"
          tone="danger"
          detail={t("overview.past24Hours")}
        />
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.45fr)_minmax(19rem,0.85fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <AttentionPanel data={loaderData} domain={domain} />
          <ActivityPanel data={loaderData} />
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <HealthPanel
            data={loaderData}
            domain={domain}
            domainTone={domainTone}
            domainStatus={domainStatus}
          />
          <AgentPanel data={loaderData} />
        </div>
      </div>
    </>
  );
}
