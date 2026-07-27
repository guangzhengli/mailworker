import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Button } from "@web/app/components/ui/button";
import { Card, CardContent } from "@web/app/components/ui/card";
import { Empty, Fact, Facts, Mono, SectionTitle, StatusTag, When } from "@web/app/ui";
import { ArrowLeftIcon } from "lucide-react";
import { Form, Link } from "react-router";
import type { Route } from "./+types/delivery";

export async function loader({ context, request, params }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const { delivery, events } = await services.delivery.timeline(
      caller,
      Ulid.parse(params.id),
    );
    return { delivery, events, mayApprove: can(caller, "message:approve") };
  });
}

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `Delivery ${loaderData.delivery.status} · Mailworker` },
];

export async function action({ context, request, params }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    await services.delivery.approve(caller, Ulid.parse(params.id));
    return { approved: true };
  });
}

export default function DeliveryPage({ loaderData }: Route.ComponentProps) {
  const { delivery, events, mayApprove } = loaderData;

  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <StatusTag status={delivery.status} />
            <h1 className="sr-only">Delivery {delivery.id}</h1>
          </div>
          <p className="mt-2 truncate font-mono text-[13px] text-hint">{delivery.id}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {delivery.status === "pending_approval" && mayApprove && (
            <Form method="post">
              <Button type="submit" size="sm">
                Approve and send
              </Button>
            </Form>
          )}
          <Button render={<Link to="/deliveries" />} variant="outline" size="sm">
            <ArrowLeftIcon />
            All deliveries
          </Button>
        </div>
      </header>

      <Card>
        <CardContent>
          <Facts>
            <Fact label="Recipients" mono>
              {delivery.recipients.join(", ")}
            </Fact>
            <Fact label="Attempts">
              <span className="tabular-nums">{delivery.attempts}</span>
            </Fact>
            <Fact label="Provider id" mono>
              {delivery.providerMessageId ?? <span className="text-hint">—</span>}
            </Fact>
            <Fact label="Idempotency key" mono>
              {delivery.idempotencyKey ?? <span className="text-hint">—</span>}
            </Fact>
            {delivery.rejectReason !== null && (
              <Fact label="Rejected because">
                <span className="text-danger">{delivery.rejectReason}</span>
              </Fact>
            )}
            {delivery.lastError !== null && (
              <Fact label="Last error">
                <span className="text-danger">{delivery.lastError}</span>
              </Fact>
            )}
            {delivery.approvedBy !== null && (
              <Fact label="Approved by">
                <Mono>{delivery.approvedBy}</Mono> <When value={delivery.approvedAt} />
              </Fact>
            )}
            <Fact label="Created">
              <When value={delivery.createdAt} />
            </Fact>
            <Fact label="Status changed">
              <When value={delivery.statusChangedAt} />
            </Fact>
          </Facts>
        </CardContent>
      </Card>

      <SectionTitle>Timeline</SectionTitle>
      <Card className="overflow-hidden py-0">
        {events.length === 0 ? (
          <Empty>
            No provider events yet. They arrive on the <Mono>mailworker-events</Mono> queue from
            Cloudflare's Email Sending event subscription, usually within a minute.
          </Empty>
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
                      <span className="text-[11px] text-hint uppercase">terminal</span>
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
