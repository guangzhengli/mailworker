import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Empty, Relative, When } from "@web/app/ui";
import { Form, Link, useNavigation } from "react-router";
import type { Route } from "./+types/inboxes";

export const meta: Route.MetaFunction = () => [{ title: "Inboxes · Mailworker" }];

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");

    const page = await services.mailbox.listInboxes(caller, {
      includeExpired: url.searchParams.get("expired") === "1",
      ...(cursor === null ? {} : { cursor: Ulid.parse(cursor) }),
    });

    return {
      inboxes: page.items,
      cursor: page.cursor,
      includeExpired: url.searchParams.get("expired") === "1",
      mayCreate: can(caller, "inbox:write"),
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();

    if (form.get("intent") === "delete") {
      await services.mailbox.deleteInbox(caller, Ulid.parse(String(form.get("id"))));
      return { created: null };
    }

    const ttlMinutes = Number(form.get("ttlMinutes") ?? 0);
    const persistent = form.get("kind") === "persistent";
    const prefix = String(form.get("prefix") ?? "").trim();

    const inbox = await services.mailbox.createInbox(caller, {
      kind: persistent ? "persistent" : "ephemeral",
      ...(prefix === "" ? {} : { prefix }),
      ...(persistent || !Number.isFinite(ttlMinutes) || ttlMinutes <= 0
        ? {}
        : { ttlMs: ttlMinutes * 60_000 }),
    });

    return { created: inbox.address };
  });
}

export default function Inboxes({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";

  return (
    <>
      <div className="page-head">
        <h1>Inboxes</h1>
        <Link to={loaderData.includeExpired ? "/" : "/?expired=1"} className="muted">
          {loaderData.includeExpired ? "Hide expired" : "Show expired"}
        </Link>
      </div>

      {actionData?.created != null && (
        <p className="notice">
          Created <code>{actionData.created}</code>
        </p>
      )}

      {loaderData.mayCreate && (
        <div className="panel pad" style={{ marginBottom: 16 }}>
          <Form method="post" className="row">
            <input
              name="prefix"
              placeholder="prefix (default: inbox)"
              style={{ width: 200 }}
              aria-label="Address prefix"
            />
            <select name="kind" aria-label="Kind" style={{ width: 140 }}>
              <option value="ephemeral">ephemeral</option>
              <option value="persistent">persistent</option>
            </select>
            <input
              name="ttlMinutes"
              type="number"
              min={1}
              defaultValue={60}
              style={{ width: 110 }}
              aria-label="TTL in minutes"
            />
            <span className="muted" style={{ fontSize: 13 }}>
              minutes
            </span>
            <button type="submit" className="primary" disabled={busy}>
              Create
            </button>
          </Form>
        </div>
      )}

      <div className="panel">
        {loaderData.inboxes.length === 0 ? (
          <Empty>
            No inboxes yet. Create one above, or run <code>mailworker inbox create</code>.
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Kind</th>
                <th>Expires</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loaderData.inboxes.map((inbox) => (
                <tr key={inbox.id}>
                  <td className="truncate">
                    <Link to={`/inboxes/${inbox.id}`} className="mono">
                      {inbox.address}
                    </Link>
                  </td>
                  <td>
                    <span className="tag">{inbox.kind}</span>
                  </td>
                  <td>
                    <Relative value={inbox.expiresAt} />
                  </td>
                  <td>
                    <When value={inbox.createdAt} />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {loaderData.mayCreate && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="id" value={inbox.id} />
                        <button type="submit" disabled={busy}>
                          Delete
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

      {loaderData.cursor !== null && (
        <p style={{ marginTop: 14 }}>
          <Link
            to={`/?cursor=${loaderData.cursor}${loaderData.includeExpired ? "&expired=1" : ""}`}
          >
            Older →
          </Link>
        </p>
      )}
    </>
  );
}
