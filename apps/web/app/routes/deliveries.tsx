import type { DeliveryStatus } from "@mailworker/core";
import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Empty, StatusTag, When } from "@web/app/ui";
import { Form, Link } from "react-router";
import type { Route } from "./+types/deliveries";

export const meta: Route.MetaFunction = () => [{ title: "Deliveries · Mailworker" }];

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

  return (
    <>
      <div className="page-head">
        <h1>Deliveries</h1>
      </div>

      {hasAwaiting && status !== "pending_approval" && (
        <p className="notice">
          Messages are waiting for approval.{" "}
          <Link to="/deliveries?status=pending_approval">Review the queue →</Link>
        </p>
      )}

      <div className="row" style={{ marginBottom: 14 }}>
        {FILTERS.map((filter) => (
          <Link
            key={filter}
            to={filter === "all" ? "/deliveries" : `/deliveries?status=${filter}`}
            className={filter === status ? "" : "muted"}
            style={{ fontSize: 13 }}
          >
            {filter.replaceAll("_", " ")}
          </Link>
        ))}
      </div>

      <div className="panel">
        {deliveries.length === 0 ? (
          <Empty>Nothing sent{status === "all" ? " yet" : ` with status ${status}`}.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Recipients</th>
                <th>Attempts</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => (
                <tr key={delivery.id}>
                  <td>
                    <Link to={`/deliveries/${delivery.id}`}>
                      <StatusTag status={delivery.status} />
                    </Link>
                  </td>
                  <td className="truncate mono">{delivery.recipients.join(", ")}</td>
                  <td className="numeric">{delivery.attempts}</td>
                  <td>
                    <When value={delivery.createdAt} />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {delivery.status === "pending_approval" && mayApprove && (
                      <Form method="post">
                        <input type="hidden" name="id" value={delivery.id} />
                        <button type="submit" className="primary">
                          Approve
                        </button>
                      </Form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!mayApprove && (
        <p className="muted" style={{ marginTop: 12, fontSize: 13 }}>
          This credential cannot approve sends. That separation is the point of the queue — the
          principal being approved and the principal approving have to be different (README).
        </p>
      )}

      {cursor !== null && (
        <p style={{ marginTop: 14 }}>
          <Link
            to={`/deliveries?cursor=${cursor}${status === "all" ? "" : `&status=${status}`}`}
          >
            Older →
          </Link>
        </p>
      )}
    </>
  );
}
