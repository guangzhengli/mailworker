import type { SuppressionReason } from "@mailworker/core";
import { EmailAddress } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Empty, When } from "@web/app/ui";
import { Form } from "react-router";
import type { Route } from "./+types/suppressions";

export const meta: Route.MetaFunction = () => [{ title: "Suppressions · Mailworker" }];

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    return {
      entries: await services.delivery.listSuppressions(caller),
      maySuppress: can(caller, "message:send"),
      mayRemove: can(caller, "admin"),
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();
    const address = EmailAddress.parse(String(form.get("address") ?? ""));

    if (form.get("intent") === "remove") {
      await services.delivery.unsuppress(caller, address);
      return { removed: address };
    }

    await services.delivery.suppress(caller, {
      address,
      reason: String(
        form.get("reason") ?? "manual",
      ) as SuppressionReason satisfies SuppressionReason,
      source: "local",
    });
    return { removed: null };
  });
}

export default function Suppressions({ loaderData }: Route.ComponentProps) {
  const { entries, maySuppress, mayRemove } = loaderData;

  return (
    <>
      <div className="page-head">
        <h1>Suppressions</h1>
      </div>

      <p className="muted" style={{ marginTop: 0, fontSize: 13, maxWidth: 640 }}>
        Addresses we refuse to mail. Cloudflare adds hard bounces to its own account-level list
        automatically and we mirror it, so <code>SendPolicy</code> can refuse before the API
        call — which keeps the attempt off the sending reputation and off the bill.
      </p>

      {maySuppress && (
        <div className="panel pad" style={{ marginBottom: 14 }}>
          <Form method="post" className="row">
            <input
              name="address"
              type="email"
              placeholder="someone@example.com"
              required
              style={{ maxWidth: 300 }}
              aria-label="Address"
            />
            <select name="reason" aria-label="Reason" style={{ width: 160 }}>
              <option value="manual">manual</option>
              <option value="complaint">complaint</option>
              <option value="hard_bounce">hard bounce</option>
              <option value="soft_bounce">soft bounce</option>
            </select>
            <button type="submit" className="primary">
              Suppress
            </button>
          </Form>
        </div>
      )}

      <div className="panel">
        {entries.length === 0 ? (
          <Empty>Nothing suppressed. That is the good state.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Reason</th>
                <th>Source</th>
                <th>Since</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.address}>
                  <td className="mono truncate">{entry.address}</td>
                  <td>
                    <span className="tag">{entry.reason.replaceAll("_", " ")}</span>
                  </td>
                  <td className="muted">{entry.source}</td>
                  <td>
                    <When value={entry.createdAt} />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {mayRemove && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove" />
                        <input type="hidden" name="address" value={entry.address} />
                        <button type="submit">Remove</button>
                      </Form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="muted" style={{ marginTop: 12, fontSize: 13, maxWidth: 640 }}>
        Removing an entry is deliberately allowed, even for a hard bounce: an address can be
        fixed, and a suppression list with no way out becomes a list of people you have
        permanently stopped talking to. It needs <code>admin</code> because doing it wrongly
        damages sending reputation for everyone on the deployment.
      </p>
    </>
  );
}
