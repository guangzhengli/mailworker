import { ALL_SCOPES, Scope, Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Empty, When } from "@web/app/ui";
import { Form } from "react-router";
import type { Route } from "./+types/keys";

export const meta: Route.MetaFunction = () => [{ title: "API keys · Mailworker" }];

/** The set an agent should normally get. `message:approve` is never in it. */
const AGENT_DEFAULTS = new Set<string>(["inbox:write", "message:read", "message:send"]);

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    if (!can(caller, "admin")) return { keys: null, identities: null, isAdmin: false as const };

    return {
      keys: await services.identity.listKeys(caller),
      identities: await services.identity.listIdentities(caller),
      isAdmin: true as const,
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();

    if (form.get("intent") === "revoke") {
      await services.identity.revokeKey(caller, Ulid.parse(String(form.get("id"))));
      return { token: null, name: null };
    }

    const identityName = String(form.get("identityName") ?? "").trim();
    const minted = await services.identity.createKey(caller, {
      name: String(form.get("name") ?? "").trim(),
      scopes: Scope.parseList(form.getAll("scopes").map(String)),
      ...(identityName === "" ? {} : { identityName }),
    });

    /**
     * The plaintext, returned to the page exactly once and never stored anywhere
     * that could give it back. It is in the action's result, not in a loader, so
     * a reload of this page does not reproduce it — which is the browser-side
     * version of the same rule `mailworker keys create` follows.
     */
    return { token: minted.token, name: minted.key.name };
  });
}

export default function Keys({ loaderData, actionData }: Route.ComponentProps) {
  if (!loaderData.isAdmin) {
    return (
      <>
        <div className="page-head">
          <h1>API keys</h1>
        </div>
        <p className="notice">
          Key management is <code>admin</code>-only, and this session is not.
        </p>
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>API keys</h1>
      </div>

      {actionData?.token != null && (
        <div className="notice">
          <strong>{actionData.name}</strong> — copy this now. Only the hash is stored, and there
          is no endpoint that reads it back.
          <pre className="body-text" style={{ padding: "8px 0 0", userSelect: "all" }}>
            {actionData.token}
          </pre>
        </div>
      )}

      <div className="panel pad" style={{ marginBottom: 14 }}>
        <Form method="post">
          <div className="row">
            <input
              name="name"
              placeholder="support-bot"
              required
              style={{ width: 180 }}
              aria-label="Key name"
            />
            <select name="identityName" aria-label="Identity" style={{ width: 200 }}>
              <option value="">no identity (account limits only)</option>
              {loaderData.identities.map((identity) => (
                <option key={identity.id} value={identity.name}>
                  {identity.name}
                </option>
              ))}
            </select>
            <button type="submit" className="primary">
              Create key
            </button>
          </div>

          <div className="row" style={{ marginTop: 10 }}>
            {ALL_SCOPES.map((scope) => (
              <label key={scope} className="row" style={{ gap: 5, fontSize: 13 }}>
                <input
                  type="checkbox"
                  name="scopes"
                  value={scope}
                  defaultChecked={AGENT_DEFAULTS.has(scope)}
                  style={{ width: "auto" }}
                />
                <code>{scope}</code>
              </label>
            ))}
          </div>

          <p className="muted" style={{ margin: "10px 0 0", fontSize: 13, maxWidth: 640 }}>
            Leave <code>message:approve</code> unchecked for anything an agent holds. The
            approval queue only means something if the principal being approved and the
            principal approving are different. <code>admin</code> cannot be bound to an identity
            at all — an admin key could edit that identity's own quota, so the metering would be
            optional for the thing being metered.
          </p>
        </Form>
      </div>

      <div className="panel">
        {loaderData.keys.length === 0 ? (
          <Empty>
            No keys yet. The bootstrap admin secret is the only way in until there is one.
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Prefix</th>
                <th>Scopes</th>
                <th>Last used</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {loaderData.keys.map((key) => (
                <tr key={key.id}>
                  <td>{key.name}</td>
                  <td className="mono">{key.prefix}</td>
                  <td className="truncate mono" style={{ fontSize: 12 }}>
                    {key.scopes.join(" ")}
                  </td>
                  <td>
                    <When value={key.lastUsedAt} />
                  </td>
                  <td>
                    {key.revokedAt !== null ? (
                      <span className="tag tag-bad">revoked</span>
                    ) : (
                      <span className="tag tag-ok">active</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {key.revokedAt === null && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="revoke" />
                        <input type="hidden" name="id" value={key.id} />
                        <button type="submit">Revoke</button>
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
        Revoked rather than deleted. After a leak the question is "what did this key do before I
        noticed", and deleting the row is what makes that question unanswerable.
      </p>
    </>
  );
}
