import type { CheckStatus } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Empty } from "@web/app/ui";
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

const TONE: Record<CheckStatus, string> = {
  pass: "tag-ok",
  warn: "tag-warn",
  fail: "tag-bad",
  unknown: "",
};

export default function Diagnostics({ loaderData }: Route.ComponentProps) {
  if (!loaderData.isAdmin) {
    return (
      <>
        <div className="page-head">
          <h1>Diagnostics</h1>
        </div>
        <p className="notice">
          Diagnostics are <code>admin</code>-only, and this session is not.
        </p>
      </>
    );
  }

  const { domains, deployment } = loaderData;

  return (
    <>
      <div className="page-head">
        <h1>Diagnostics</h1>
      </div>

      <p className="muted" style={{ marginTop: 0, fontSize: 13, maxWidth: 640 }}>
        The same checks <code>mailworker doctor</code> runs. Everything here fails{" "}
        <em>silently</em> in production: mail that lands in spam because DMARC is missing, an
        inbox that receives nothing because MX points at the old host, a send that works against
        your own address and fails against a customer because the domain is not verified yet.
      </p>

      <h2>Bindings</h2>
      <div className="panel pad">
        <dl className="facts">
          <dt>Email Sending</dt>
          <dd>
            {deployment.sendingConfigured ? (
              <span className="tag tag-ok">bound</span>
            ) : (
              <>
                <span className="tag tag-warn">not bound</span>{" "}
                <span className="muted">
                  Receiving still works — Email Routing is free. Sending needs Workers Paid.
                </span>
              </>
            )}
          </dd>
          <dt>Dispatch queue</dt>
          <dd>
            {deployment.dispatchQueueConfigured ? (
              <span className="tag tag-ok">bound</span>
            ) : (
              <span className="tag tag-bad">not bound</span>
            )}
          </dd>
          <dt>Webhook queue</dt>
          <dd>
            {deployment.webhookQueueConfigured ? (
              <span className="tag tag-ok">bound</span>
            ) : (
              <span className="tag tag-warn">not bound</span>
            )}
          </dd>
        </dl>
      </div>

      <h2>Domains</h2>
      {domains.length === 0 ? (
        <div className="panel">
          <Empty>
            No domains registered yet. Run <code>mailworker deploy</code> to onboard one.
          </Empty>
        </div>
      ) : (
        domains.map((diagnosis) => (
          <div className="panel" key={diagnosis.domain}>
            <div className="pad" style={{ borderBottom: "1px solid var(--border)" }}>
              <span className="mono" style={{ fontSize: 15 }}>
                {diagnosis.domain}
              </span>{" "}
              <span className={`tag ${TONE[diagnosis.status]}`}>{diagnosis.status}</span>
            </div>
            <table>
              <tbody>
                {diagnosis.checks.map((check) => (
                  <tr key={check.name}>
                    <td style={{ width: 110 }}>{check.name}</td>
                    <td style={{ width: 90 }}>
                      <span className={`tag ${TONE[check.status]}`}>{check.status}</span>
                    </td>
                    <td>
                      <div style={{ overflowWrap: "anywhere" }}>{check.detail}</div>
                      {check.fix !== undefined && (
                        <div className="muted" style={{ fontSize: 13, marginTop: 3 }}>
                          Fix: {check.fix}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </>
  );
}
