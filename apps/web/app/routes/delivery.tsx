import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Empty, StatusTag, When } from "@web/app/ui";
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
      <div className="page-head">
        <div>
          <h1>
            <StatusTag status={delivery.status} />
          </h1>
          <p className="muted mono" style={{ margin: "6px 0 0", fontSize: 13 }}>
            {delivery.id}
          </p>
        </div>
        <Link to="/deliveries" className="muted">
          ← All deliveries
        </Link>
      </div>

      {delivery.status === "pending_approval" && mayApprove && (
        <Form method="post" style={{ marginBottom: 14 }}>
          <button type="submit" className="primary">
            Approve and send
          </button>
        </Form>
      )}

      <div className="panel pad">
        <dl className="facts">
          <dt>Recipients</dt>
          <dd className="mono">{delivery.recipients.join(", ")}</dd>
          <dt>Attempts</dt>
          <dd className="numeric">{delivery.attempts}</dd>
          <dt>Provider id</dt>
          <dd className="mono">
            {delivery.providerMessageId ?? <span className="muted">—</span>}
          </dd>
          <dt>Idempotency key</dt>
          <dd className="mono">
            {delivery.idempotencyKey ?? <span className="muted">—</span>}
          </dd>
          {delivery.rejectReason !== null && (
            <>
              <dt>Rejected because</dt>
              <dd>{delivery.rejectReason}</dd>
            </>
          )}
          {delivery.lastError !== null && (
            <>
              <dt>Last error</dt>
              <dd>{delivery.lastError}</dd>
            </>
          )}
          {delivery.approvedBy !== null && (
            <>
              <dt>Approved by</dt>
              <dd className="mono">
                {delivery.approvedBy} <When value={delivery.approvedAt} />
              </dd>
            </>
          )}
          <dt>Created</dt>
          <dd>
            <When value={delivery.createdAt} />
          </dd>
          <dt>Status changed</dt>
          <dd>
            <When value={delivery.statusChangedAt} />
          </dd>
        </dl>
      </div>

      <h2>Timeline</h2>
      <div className="panel">
        {events.length === 0 ? (
          <Empty>
            No provider events yet. They arrive on the <code>mailworker-events</code> queue from
            Cloudflare's Email Sending event subscription, usually within a minute.
          </Empty>
        ) : (
          <ul className="timeline">
            {/*
              Every event is shown, including ones the state machine refused as
              out of order or post-terminal. Such an event did not change the
              delivery, but it is still a fact about what the provider said —
              and someone reading this page is usually reading it *because* that
              fact is the answer.
            */}
            {events.map((event) => (
              <li key={event.id}>
                <span>
                  <When value={event.occurredAt} />
                </span>
                <span>
                  <StatusTag status={event.type} />
                  {event.terminal && (
                    <span className="muted" style={{ fontSize: 11 }}>
                      {" "}
                      terminal
                    </span>
                  )}
                </span>
                <span className="muted" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                  {event.recipient !== null && <span className="mono">{event.recipient} </span>}
                  {event.smtpCode !== null && <>[{event.smtpCode}] </>}
                  {event.smtpResponse}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
