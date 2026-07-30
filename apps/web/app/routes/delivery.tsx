import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Button } from "@web/app/components/ui/button";
import { Card, CardContent } from "@web/app/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@web/app/components/ui/table";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import {
  Bytes,
  CodeBlock,
  Empty,
  Fact,
  Facts,
  Mono,
  PageHeader,
  SectionTitle,
  StatusTag,
  When,
} from "@web/app/ui";
import { ArrowLeftIcon, PaperclipIcon } from "lucide-react";
import { Form, Link, useSearchParams } from "react-router";
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

    return {
      delivery,
      events,
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

export const meta: Route.MetaFunction = ({ matches, loaderData }) => [
  {
    title: translate(localeFromMatches(matches), "delivery.pageTitle", {
      status: loaderData.delivery.status,
    }),
  },
];

export async function action({ context, request, params }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    await services.delivery.approve(caller, Ulid.parse(params.id));
    return { approved: true };
  });
}

export default function DeliveryPage({ loaderData, params }: Route.ComponentProps) {
  const { delivery, events, mayApprove, preview } = loaderData;
  const [search, setSearch] = useSearchParams();
  const showHtml = preview?.hasHtml === true && search.get("view") !== "text";
  const { t, rich } = useT();

  return (
    <>
      {/* The status pill *is* the heading here — the id is the subtitle, and a
          repeated "Delivery <ulid>" in 20px type would push the one word this
          page exists to report below the fold on a phone. The real heading is
          still in the tree for anyone reading it aloud. */}
      <PageHeader
        title={
          <>
            <StatusTag status={delivery.status} />
            <span className="sr-only">{t("delivery.heading", { id: delivery.id })}</span>
          </>
        }
        description={
          <>
            {preview !== null && (
              <span className="mb-1 block text-primary-text">
                {preview.subject === "" ? (
                  <span className="text-hint italic">{t("common.noSubject")}</span>
                ) : (
                  preview.subject
                )}
              </span>
            )}
            <Mono className="text-hint">{delivery.id}</Mono>
          </>
        }
      >
        {delivery.status === "pending_approval" && mayApprove && (
          <Form method="post">
            <Button type="submit" size="sm">
              {t("delivery.approveAndSend")}
            </Button>
          </Form>
        )}
        <Button render={<Link to="/deliveries" />} variant="outline" size="sm">
          <ArrowLeftIcon />
          {t("delivery.all")}
        </Button>
      </PageHeader>

      <Card>
        <CardContent>
          <Facts>
            <Fact label={t("field.recipients")} mono>
              {delivery.recipients.join(", ")}
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
              {delivery.idempotencyKey ?? <span className="text-hint">{t("common.dash")}</span>}
            </Fact>
            {delivery.rejectReason !== null && (
              <Fact label={t("delivery.rejectedBecause")}>
                {/* The reason and the error below are the provider's or the
                    domain's own words, and stay in whatever language they
                    arrived in — paraphrasing a bounce message loses the thing
                    someone is on this page to read. */}
                <span className="text-danger">{delivery.rejectReason}</span>
              </Fact>
            )}
            {delivery.lastError !== null && (
              <Fact label={t("delivery.lastError")}>
                <span className="text-danger">{delivery.lastError}</span>
              </Fact>
            )}
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
            <Fact label={t("field.created")}>
              <When value={delivery.createdAt} />
            </Fact>
            <Fact label={t("delivery.statusChanged")}>
              <When value={delivery.statusChangedAt} />
            </Fact>
          </Facts>
        </CardContent>
      </Card>

      {preview !== null && preview.attachments.length > 0 && (
        <>
          <SectionTitle>{t("message.attachments")}</SectionTitle>
          <Card className="overflow-hidden py-0">
            <Table>
              <TableBody>
                {preview.attachments.map((attachment) => (
                  <TableRow key={`${attachment.filename}:${attachment.bytes}`}>
                    {/* No download link, unlike inbound. The bytes are in the
                        payload blob, and adding a route to stream them back out
                        would be a second way to read message content whose only
                        user is this table. The manifest is what answers "did the
                        invoice go with it". */}
                    <TableCell>
                      <span className="flex items-center gap-2">
                        <PaperclipIcon className="text-hint" />
                        {attachment.filename}
                      </span>
                    </TableCell>
                    <TableCell className="text-secondary-text">{attachment.mime}</TableCell>
                    <TableCell className="text-right">
                      <Bytes value={attachment.bytes} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      {/*
        The body, shown for every status including `pending_approval`.
        That is the point of it being here rather than only on the archived sent
        copy: the sent copy is written at dispatch, so a reviewer deciding
        whether to release a held send would otherwise be approving an id.
      */}
      {preview !== null && (
        <>
          <SectionTitle
            actions={
              preview.hasHtml && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    const next = new URLSearchParams(search);
                    if (showHtml) next.set("view", "text");
                    else next.delete("view");
                    setSearch(next, { preventScrollReset: true });
                  }}
                >
                  {showHtml ? t("message.viewAsText") : t("message.viewAsHtml")}
                </Button>
              )
            }
          >
            {t("message.body")}
          </SectionTitle>

          <Card className="overflow-hidden py-0">
            {showHtml ? (
              // Sandboxed and CSP-bound exactly as inbound mail is; see
              // `delivery-body.tsx` for why outbound gets no discount.
              <iframe
                title={t("message.frameTitle")}
                className="block min-h-96 w-full border-0 bg-white"
                sandbox=""
                referrerPolicy="no-referrer"
                src={`/deliveries/${params.id}/body`}
              />
            ) : (
              <CodeBlock>
                {preview.text ?? (
                  <span className="text-hint italic">{t("message.noTextBody")}</span>
                )}
              </CodeBlock>
            )}
          </Card>
        </>
      )}

      <SectionTitle>{t("delivery.timeline")}</SectionTitle>
      <Card className="overflow-hidden py-0">
        {events.length === 0 ? (
          <Empty>{rich("delivery.noEvents", { queue: <Mono>mailworker-events</Mono> })}</Empty>
        ) : (
          <ol className="m-0 list-none p-4">
            {/*
              Every event is shown, including ones the state machine refused as
              out of order or post-terminal. Such an event did not change the
              delivery, but it is still a fact about what the provider said —
              and someone reading this page is usually reading it *because* that
              fact is the answer.
            */}
            {events.map((event, index) => (
              <li key={event.id} className="relative flex gap-4 pb-5 last:pb-0">
                {/* The rail stops at the last node rather than running past it,
                    so the timeline reads as ended rather than as still loading. */}
                {index < events.length - 1 && (
                  <span
                    aria-hidden="true"
                    className="absolute top-5 bottom-0 left-[3.5px] w-px bg-border"
                  />
                )}
                <span
                  aria-hidden="true"
                  className="relative mt-1.5 size-2 shrink-0 rounded-full bg-neutral"
                />
                <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:flex-row sm:items-baseline sm:gap-4">
                  <div className="flex shrink-0 items-center gap-2">
                    <StatusTag status={event.type} />
                    {event.terminal && (
                      <span className="text-[11px] text-hint uppercase">
                        {t("delivery.terminal")}
                      </span>
                    )}
                  </div>
                  <When value={event.occurredAt} className="shrink-0 text-[13px]" />
                  <div className="min-w-0 text-[13px] break-words text-secondary-text">
                    {event.recipient !== null && <Mono>{event.recipient} </Mono>}
                    {event.smtpCode !== null && <>[{event.smtpCode}] </>}
                    {event.smtpResponse}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
