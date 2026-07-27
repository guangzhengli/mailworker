import type { CheckStatus } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Card, CardContent } from "@web/app/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@web/app/components/ui/table";
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

export const meta: Route.MetaFunction = () => [{ title: "Diagnostics · Mailworker" }];

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

export default function Diagnostics({ loaderData }: Route.ComponentProps) {
  if (!loaderData.isAdmin) {
    return (
      <>
        <PageHeader title="Diagnostics" />
        <Card>
          <CardContent className="text-sm text-secondary-text">
            Diagnostics are <Mono>admin</Mono>-only, and this session is not.
          </CardContent>
        </Card>
      </>
    );
  }

  const { domains, deployment } = loaderData;

  return (
    <>
      <PageHeader title="Diagnostics" description="The same checks mailworker doctor runs." />

      <Note>
        Everything here fails <em>silently</em> in production: mail that lands in spam because
        DMARC is missing, an inbox that receives nothing because MX points at the old host, a
        send that works against your own address and fails against a customer because the domain
        is not verified yet.
      </Note>

      <SectionTitle>Bindings</SectionTitle>
      <Card>
        <CardContent>
          <Facts>
            <Fact label="Email Sending">
              {deployment.sendingConfigured ? (
                <Tag tone="success">bound</Tag>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <Tag tone="warning">not bound</Tag>
                  <span className="text-[13px] text-hint">
                    Receiving still works — Email Routing is free. Sending needs Workers Paid.
                  </span>
                </span>
              )}
            </Fact>
            <Fact label="Dispatch queue">
              {deployment.dispatchQueueConfigured ? (
                <Tag tone="success">bound</Tag>
              ) : (
                <Tag tone="danger">not bound</Tag>
              )}
            </Fact>
            <Fact label="Webhook queue">
              {deployment.webhookQueueConfigured ? (
                <Tag tone="success">bound</Tag>
              ) : (
                <Tag tone="warning">not bound</Tag>
              )}
            </Fact>
          </Facts>
        </CardContent>
      </Card>

      <SectionTitle>Domains</SectionTitle>
      {domains.length === 0 ? (
        <Card className="py-0">
          <Empty>
            No domains registered yet. Run <Mono>mailworker deploy</Mono> to onboard one.
          </Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {domains.map((diagnosis) => (
            <Card key={diagnosis.domain} className="gap-0 overflow-hidden py-0">
              <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
                <span className="font-mono text-[15px] font-medium text-title">
                  {diagnosis.domain}
                </span>
                <Tag tone={TONE[diagnosis.status]}>{diagnosis.status}</Tag>
              </div>
              <Table>
                <TableBody>
                  {diagnosis.checks.map((check) => (
                    <TableRow key={check.name}>
                      <TableCell className="w-28 align-top font-medium text-title">
                        {check.name}
                      </TableCell>
                      <TableCell className="w-24 align-top">
                        <Tag tone={TONE[check.status]}>{check.status}</Tag>
                      </TableCell>
                      <TableCell className="align-top">
                        <div className="break-words">{check.detail}</div>
                        {check.fix !== undefined && (
                          <div className="mt-1 text-[13px] break-words text-hint">
                            Fix: {check.fix}
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
