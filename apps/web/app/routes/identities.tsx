import { can, page } from "@web/app/auth";
import { Empty, When } from "@web/app/ui";
import { Form } from "react-router";
import type { Route } from "./+types/identities";

export const meta: Route.MetaFunction = () => [{ title: "Identities · Mailworker" }];

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    /**
     * `listIdentities` is `admin`-only, so a narrower credential gets the page
     * with an explanation rather than an error boundary. The page still exists
     * because "you cannot see this, and here is why" is more useful than a dead
     * link in the sidebar.
     */
    if (!can(caller, "admin")) {
      return { identities: null, isAdmin: false as const };
    }

    return {
      identities: await services.identity.listIdentities(caller),
      isAdmin: true as const,
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();

    const quota = Number(form.get("quota") ?? "");
    const allowlist = String(form.get("allowlist") ?? "")
      .split(",")
      .map((glob) => glob.trim())
      .filter((glob) => glob !== "");

    const identity = await services.identity.createIdentity(caller, {
      name: String(form.get("name") ?? "").trim(),
      ...(Number.isFinite(quota) && quota > 0 ? { dailySendQuota: quota } : {}),
      ...(allowlist.length > 0 ? { recipientAllowlist: allowlist } : {}),
      requireApproval: form.get("requireApproval") === "on",
    });

    return { created: identity.name };
  });
}

export default function Identities({ loaderData, actionData }: Route.ComponentProps) {
  if (!loaderData.isAdmin) {
    return (
      <>
        <div className="page-head">
          <h1>Identities</h1>
        </div>
        <p className="notice">
          Identities are <code>admin</code>-only, and this session is not. That is deliberate:
          the limits an identity carries are exactly the ones the identity must not be able to
          widen.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>Identities</h1>
      </div>

      <p className="muted" style={{ marginTop: 0, fontSize: 13, maxWidth: 640 }}>
        What an agent is allowed to be. A quota, an optional recipient allowlist, and whether
        every send waits for a human. An identity cannot change its own limits — that is the
        whole point of declaring them here rather than in the credential.
      </p>

      {actionData?.created !== undefined && (
        <p className="notice">
          Created <code>{actionData.created}</code>. Mint a key for it on the API keys page.
        </p>
      )}

      <div className="panel pad" style={{ marginBottom: 14 }}>
        <Form method="post" className="row">
          <input
            name="name"
            placeholder="support-bot"
            required
            pattern="[a-z0-9][a-z0-9_-]*"
            style={{ width: 180 }}
            aria-label="Name"
          />
          <input
            name="quota"
            type="number"
            min={1}
            placeholder="daily quota"
            style={{ width: 130 }}
            aria-label="Daily send quota"
          />
          <input
            name="allowlist"
            placeholder="*@customer.example.com, ops@…"
            style={{ maxWidth: 280 }}
            aria-label="Recipient allowlist"
          />
          <label className="row" style={{ gap: 5, fontSize: 13 }}>
            <input type="checkbox" name="requireApproval" style={{ width: "auto" }} />
            require approval
          </label>
          <button type="submit" className="primary">
            Create
          </button>
        </Form>
      </div>

      <div className="panel">
        {loaderData.identities.length === 0 ? (
          <Empty>
            No identities. A key without one is subject only to account-level limits.
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Daily quota</th>
                <th>Recipients</th>
                <th>Approval</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {loaderData.identities.map((identity) => (
                <tr key={identity.id}>
                  <td className="mono">{identity.name}</td>
                  <td className="numeric">
                    {identity.dailySendQuota ?? <span className="muted">account limit</span>}
                  </td>
                  <td className="truncate">
                    {identity.recipientAllowlist === null ? (
                      <span className="muted">anyone</span>
                    ) : identity.recipientAllowlist.length === 0 ? (
                      <span className="tag tag-warn">nobody</span>
                    ) : (
                      <span className="mono">{identity.recipientAllowlist.join(", ")}</span>
                    )}
                  </td>
                  <td>
                    {identity.requireApproval ? (
                      <span className="tag tag-warn">required</span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    <When value={identity.createdAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
