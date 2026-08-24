import type { CheckStatus } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Card, CardContent, CardHeader, CardTitle } from "@web/app/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@web/app/components/ui/table";
import { localeFromMatches, type MessageKey, translate, useT } from "@web/app/i18n";
import {
  Empty,
  Fact,
  Facts,
  Mono,
  Note,
  PageHeader,
  SectionTitle,
  Tag,
  type Tone,
} from "@web/app/ui";
import type { Route } from "./+types/diagnostics";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "diagnostics.pageTitle") },
];

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services, env }) => {
    if (!can(caller, "admin"))
      return { domains: null, deployment: null, isAdmin: false as const };

    return {
      domains: await services.delivery.diagnose(caller),
      /**
       * Read off the bindings rather than off a config file. The question is
       * "what does this Worker actually have", and a file can say otherwise —
       * which is the failure mode "sending is configured, I checked wrangler.jsonc"
       * describes exactly.
       */
      deployment: {
        sendingConfigured: env.SEND_EMAIL !== undefined,
        dispatchQueueConfigured: env.DISPATCH_QUEUE !== undefined,
        webhookQueueConfigured: env.WEBHOOK_QUEUE !== undefined,
      },
      isAdmin: true as const,
    };
  });
}

/**
 * `unknown` is neutral rather than a warning on purpose: it means the check
 * could not run, not that it found something. Painting it amber would send
 * someone to fix a domain that may be perfectly fine.
 */
const TONE: Record<CheckStatus, Tone> = {
  pass: "success",
  warn: "warning",
  fail: "danger",
  unknown: "neutral",
};

const STATUS_KEYS = {
  pass: "diagnostics.status.pass",
  warn: "diagnostics.status.warn",
  fail: "diagnostics.status.fail",
  unknown: "diagnostics.status.unknown",
} as const satisfies Record<CheckStatus, MessageKey>;

export default function Diagnostics({ loaderData }: Route.ComponentProps) {
  const { t, rich } = useT();

  if (!loaderData.isAdmin) {
    return (
      <>
        <PageHeader title={t("diagnostics.title")} />
        <Card>
          <CardContent className="text-sm text-secondary-text">
            {t("diagnostics.adminOnly")}
          </CardContent>
        </Card>
      </>
    );
  }

  const { domains, deployment } = loaderData;

  return (
    <>
      <PageHeader title={t("diagnostics.title")} description={t("diagnostics.description")} />

      <Note>
        {rich("diagnostics.note", { silently: <em>{t("diagnostics.silently")}</em> })}
      </Note>

      <SectionTitle>{t("diagnostics.bindings")}</SectionTitle>
      <Card>
        <CardContent>
          <Facts>
            <Fact label={t("diagnostics.emailSending")}>
              {deployment.sendingConfigured ? (
                <Tag tone="success">{t("diagnostics.bound")}</Tag>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <Tag tone="warning">{t("diagnostics.notBound")}</Tag>
                  <span className="text-[13px] text-hint">{t("diagnostics.sendingHint")}</span>
                </span>
              )}
            </Fact>
            <Fact label={t("diagnostics.dispatchQueue")}>
              {deployment.dispatchQueueConfigured ? (
                <Tag tone="success">{t("diagnostics.bound")}</Tag>
              ) : (
                <Tag tone="danger">{t("diagnostics.notBound")}</Tag>
              )}
            </Fact>
            <Fact label={t("diagnostics.webhookQueue")}>
              {deployment.webhookQueueConfigured ? (
                <Tag tone="success">{t("diagnostics.bound")}</Tag>
              ) : (
                <Tag tone="warning">{t("diagnostics.notBound")}</Tag>
              )}
            </Fact>
          </Facts>
        </CardContent>
      </Card>

      <SectionTitle>{t("diagnostics.domains")}</SectionTitle>
      {domains.length === 0 ? (
        <Card className="py-0">
          <Empty>
            {rich("diagnostics.noDomains", { command: <Mono>mailworker deploy</Mono> })}
          </Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {domains.map((diagnosis) => (
            <Card key={diagnosis.domain} className="gap-0 overflow-hidden py-0">
              <CardHeader className="flex flex-wrap items-center gap-3 border-b pt-3 [--card-spacing:--spacing(3)]">
                <CardTitle className="font-mono text-[15px] text-title">
                  {diagnosis.domain}
                </CardTitle>
                <Tag tone={TONE[diagnosis.status]}>
                  {diagnosis.status in STATUS_KEYS
                    ? t(STATUS_KEYS[diagnosis.status])
                    : diagnosis.status}
                </Tag>
              </CardHeader>
              <Table>
                <TableBody>
                  {/*
                    A check's name, status, detail and fix are `mailworker
                    doctor`'s own output, rendered verbatim in both locales. This
                    page's promise is "the same checks doctor runs", and a
                    translated detail is one the reader cannot match against the
                    terminal they are about to run it in. Only the label in front
                    of the fix belongs to the dashboard.
                  */}
                  {diagnosis.checks.map((check) => (
                    <TableRow key={check.name}>
                      <TableCell className="w-28 align-top font-medium text-title">
                        {check.name}
                      </TableCell>
                      <TableCell className="w-28 align-top">
                        <Tag tone={TONE[check.status]}>
                          {check.status in STATUS_KEYS
                            ? t(STATUS_KEYS[check.status])
                            : check.status}
                        </Tag>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="break-words">{check.detail}</div>
                        {check.fix !== undefined && (
                          <div className="mt-1 text-[13px] break-words text-hint">
                            {t("diagnostics.fix", { fix: check.fix })}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
