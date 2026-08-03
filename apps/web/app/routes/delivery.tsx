import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { BodyViewer } from "@web/app/components/body-viewer";
import { Button } from "@web/app/components/ui/button";
import { Card, CardContent } from "@web/app/components/ui/card";
import { nextStepFor } from "@web/app/deliveries";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import {
  AttachmentList,
  Callout,
  CopyButton,
  Disclosure,
  Empty,
  Fact,
  Facts,
  KeyFact,
  KeyFacts,
  ListCard,
  Mono,
  PageHeader,
  SectionTitle,
  StatusTag,
  Timeline,
  When,
} from "@web/app/ui";
import { ClockIcon, TriangleAlertIcon } from "lucide-react";
import { Form } from "react-router";
import type { Route } from "./+types/delivery";

export async function loader({ context, request, params }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const id = Ulid.parse(params.id);
    const { delivery, events } = await services.delivery.timeline(caller, id);

    /**
     * The payload can be missing — retention swept it, or the send was rejected
     * before one was ever written — and that must not take the page down with
     * it. The timeline is the reason someone is here; the body is the reason
     * they can act on it.
     *
     * As in `message.tsx`, `html` itself never reaches the browser as loader
     * data. Only whether there IS one, so the component knows to mount the
     * frame that fetches it under its own CSP.
     */
    const preview = await services.delivery.preview(caller, id).catch(() => null);

    const agent =
      delivery.identityId === null || !can(caller, "admin")
        ? null
        : ((await services.identity.listIdentities(caller)).find(
            (identity) => identity.id === delivery.identityId,
          )?.name ?? null);

    return {
      delivery,
      events,
      agent,
      mayApprove: can(caller, "message:approve"),
      preview:
        preview === null
          ? null
          : {
              subject: preview.subject,
              from: preview.from,
              to: [...preview.to],
              cc: [...preview.cc],
              bcc: [...preview.bcc],
              text: preview.text,
              hasHtml: preview.html !== null && preview.html.length > 0,
              attachments: [...preview.attachments],
            },
    };
  });
}

export const meta: Route.MetaFunction = ({ matches }) => [
  {
    title: translate(localeFromMatches(matches), "delivery.pageTitle"),
  },
];

export async function action({ context, request, params }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    await services.delivery.approve(caller, Ulid.parse(params.id));
    return { approved: true };
  });
}

export default function DeliveryPage({ loaderData, params }: Route.ComponentProps) {
  const { delivery, events, agent, mayApprove, preview } = loaderData;
  const { t, rich } = useT();
  const nextStep = nextStepFor(delivery.status);

  return (
    <>
      {/*
        The subject is the title. It used to be the status tag, with the subject
        demoted into the description — which made every one of these pages open
        on the same six words and left the reader to work out which message they
        had clicked.
      */}
      <PageHeader
        back={{ to: "/sent", label: t("delivery.all") }}
        title={
          preview === null || preview.subject === "" ? (
            <span className="text-hint italic">{t("common.noSubject")}</span>
          ) : (
            preview.subject
          )
        }
      >
        {delivery.status === "pending_approval" && mayApprove && (
          <Form method="post">
            <Button type="submit" size="sm">
              {t("delivery.approveAndSend")}
            </Button>
          </Form>
        )}
      </PageHeader>

      <KeyFacts>
        <KeyFact label={t("field.status")}>
          <StatusTag status={delivery.status} />
        </KeyFact>
        <KeyFact label={t("field.recipients")} className="lg:col-span-2">
          <span title={delivery.recipients.join(", ")}>
            <Mono>{delivery.recipients.join(", ")}</Mono>
          </span>
        </KeyFact>
        <KeyFact label={t("field.sentBy")}>
          {agent === null ? (
            <span className="text-secondary-text">
              {delivery.source === "console" ? t("sent.byConsole") : t("sent.byAgent")}
            </span>
          ) : (
            <Mono>{agent}</Mono>
          )}
        </KeyFact>
        <KeyFact label={t("field.created")}>
          <When value={delivery.createdAt} />
        </KeyFact>
        <KeyFact label={t("delivery.id")} className="sm:col-span-2">
          <CopyButton value={delivery.id} label={t("common.copyId")} />
        </KeyFact>
      </KeyFacts>

      {/* The two things that need saying out loud, in the order they matter:
          what the provider refused, then what to do about it. */}
      {(delivery.rejectReason !== null || delivery.lastError !== null) && (
        <Callout tone="danger" className="mb-3" icon={<TriangleAlertIcon />}>
          {/* The reason and the error are the provider's or the domain's own
              words, and stay in whatever language they arrived in — paraphrasing
              a bounce message loses the thing someone is on this page to read. */}
          {delivery.rejectReason ?? delivery.lastError}
        </Callout>
      )}

      {nextStep !== null && (
        <Callout
          tone={delivery.status === "deferred" ? "warning" : "info"}
          className="mb-4"
          icon={<ClockIcon />}
        >
          {t(nextStep)}
        </Callout>
      )}

      {/*
        The timeline before the body, which is the one ordering difference from
        `message.tsx` and the reason the two pages are not the same component.
        Nobody opens an inbound message to find out what happened to it; nobody
        opens a delivery for any other reason.
      */}
      <SectionTitle>{t("delivery.timeline")}</SectionTitle>
      <ListCard>
        {events.length === 0 ? (
          <Empty>{rich("delivery.noEvents", { queue: <Mono>mailworker-events</Mono> })}</Empty>
        ) : (
          <Timeline
            events={events.map((event) => ({
              id: event.id,
              type: event.type,
              terminal: event.terminal,
              occurredAt: event.occurredAt,
              recipient: event.recipient,
              smtpCode: event.smtpCode,
              smtpResponse: event.smtpResponse,
            }))}
          />
        )}
      </ListCard>

      {/*
        The body, shown for every status including `pending_approval`.
        That is the point of it being here rather than only on the archived sent
        copy: the sent copy is written at dispatch, so a reviewer deciding
        whether to release a held send would otherwise be approving an id.
      */}
      {preview !== null && (
        <>
          <SectionTitle>{t("message.body")}</SectionTitle>
          <Card className="gap-0 overflow-hidden py-0">
            <BodyViewer
              src={`/sent/${params.id}/body`}
              hasHtml={preview.hasHtml}
              text={preview.text}
            />

            {preview.attachments.length > 0 && (
              <>
                <div className="border-t border-border bg-muted/40 px-4 py-2">
                  <h2 className="text-xs font-medium tracking-wider text-hint uppercase">
                    {t("message.attachments")}
                  </h2>
                </div>
                <AttachmentList
                  items={preview.attachments.map((attachment) => ({
                    key: `${attachment.filename}:${attachment.bytes}`,
                    filename: attachment.filename,
                    mime: attachment.mime,
                    bytes: attachment.bytes,
                  }))}
                />
              </>
            )}
          </Card>
        </>
      )}

      {/*
        Everything that is evidence rather than identity, closed by default. These
        nine rows used to be the first screen of this page, which asked the reader
        for an idempotency key before it would tell them whether the mail arrived.
      */}
      <Card className="mt-8">
        <CardContent>
          <Disclosure summary={t("delivery.technical")}>
            <Facts className="mt-3 border-t border-border pt-3">
              <Fact label={t("delivery.wireStatus")} mono>
                {delivery.status}
              </Fact>
              <Fact label={t("field.attempts")}>
                <span className="tabular-nums">{delivery.attempts}</span>
              </Fact>
              <Fact label={t("delivery.providerId")} mono>
                {delivery.providerMessageId ?? (
                  <span className="text-hint">{t("common.dash")}</span>
                )}
              </Fact>
              <Fact label={t("delivery.idempotencyKey")} mono>
                {delivery.idempotencyKey ?? (
                  <span className="text-hint">{t("common.dash")}</span>
                )}
              </Fact>
              {delivery.approvedBy !== null && (
                <Fact label={t("delivery.approvedBy")}>
                  <Mono>{delivery.approvedBy}</Mono> <When value={delivery.approvedAt} />
                </Fact>
              )}
              {Object.keys(delivery.metadata).length > 0 && (
                <Fact label={t("delivery.metadata")}>
                  {/* Rendered as text, never as markup: these are the caller's own
                      strings and this page has no reason to interpret them. */}
                  <span className="flex flex-wrap gap-x-3 gap-y-1">
                    {Object.entries(delivery.metadata).map(([key, value]) => (
                      <Mono key={key} className="text-[13px]">
                        {key}={value}
                      </Mono>
                    ))}
                  </span>
                </Fact>
              )}
              <Fact label={t("delivery.statusChanged")}>
                <When value={delivery.statusChangedAt} />
              </Fact>
              {delivery.rejectReason !== null && (
                <Fact label={t("delivery.rejectedBecause")}>
                  <span className="text-danger">{delivery.rejectReason}</span>
                </Fact>
              )}
              {delivery.lastError !== null && (
                <Fact label={t("delivery.lastError")}>
                  <span className="text-danger">{delivery.lastError}</span>
                </Fact>
              )}
            </Facts>
          </Disclosure>
        </CardContent>
      </Card>
    </>
  );
}
