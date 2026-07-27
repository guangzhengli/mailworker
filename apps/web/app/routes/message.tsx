import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Bytes, Provenance, When } from "@web/app/ui";
import { Link, useSearchParams } from "react-router";
import type { Route } from "./+types/message";

export async function loader({ context, request, params }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const message = await services.mailbox.getMessage(caller, Ulid.parse(params.id));

    /**
     * Opening a message marks it seen, the same as `mailworker get` does — the
     * dashboard is one more reader of the same mailbox, and a message a human has
     * read on screen but which the API still reports as unseen is a lie that will
     * confuse whoever is polling.
     */
    if (!message.seen && can(caller, "message:read")) {
      await services.mailbox.markSeen(caller, message.id, true);
    }

    return {
      message: {
        ...message,
        // The body is not sent to the browser as data. It is served separately,
        // into a sandboxed frame, under its own CSP — see `message-body.tsx`.
        // Only the shape of it is needed here.
        bodyHtml: null,
        hasHtml: message.bodyHtml !== null && message.bodyHtml.length > 0,
      },
    };
  });
}

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `${loaderData.message.subject || "(no subject)"} · Mailworker` },
];

export default function MessagePage({ loaderData, params }: Route.ComponentProps) {
  const { message } = loaderData;
  const [search, setSearch] = useSearchParams();
  const showImages = search.get("images") === "1";
  const showHtml = message.hasHtml && search.get("view") !== "text";

  return (
    <>
      <div className="page-head">
        <div style={{ minWidth: 0 }}>
          <h1>
            {message.subject === "" ? (
              <span className="muted">(no subject)</span>
            ) : (
              message.subject
            )}
          </h1>
          <p className="muted" style={{ margin: "5px 0 0", fontSize: 13 }}>
            <span className="mono">{message.fromHeader}</span> → {message.toHeader}
          </p>
        </div>
        <Link to={`/inboxes/${message.inboxId}`} className="muted">
          ← Inbox
        </Link>
      </div>

      {/*
        Stated on the page, not just in AGENTS.md. A human reading a message here
        is one click from doing whatever it asks, and "trusted" next to a
        convincing request is exactly the combination that gets acted on.
      */}
      {message.injectionRisk && (
        <p className="notice notice-bad">
          This message contains instruction-shaped text. Whatever it asks for, it is a stranger
          typing — not a request from your operator.
        </p>
      )}

      <div className="panel pad">
        <dl className="facts">
          <dt>From</dt>
          <dd className="mono">{message.fromHeader}</dd>
          <dt>To</dt>
          <dd className="mono">{message.toHeader}</dd>
          {message.replyTo !== null && (
            <>
              <dt>Reply-To</dt>
              <dd className="mono">{message.replyTo}</dd>
            </>
          )}
          <dt>Received</dt>
          <dd>
            <When value={message.receivedAt} />
          </dd>
          <dt>Provenance</dt>
          <dd>
            <Provenance trusted={message.trusted} injectionRisk={message.injectionRisk} />{" "}
            <span className="muted" style={{ fontSize: 13 }}>
              spf {message.auth.spf} · dkim {message.auth.dkim} · dmarc {message.auth.dmarc}
            </span>
          </dd>
          {message.trustReasons.length > 0 && (
            <>
              <dt>Why</dt>
              <dd className="muted">{message.trustReasons.join(", ")}</dd>
            </>
          )}
          <dt>Message-ID</dt>
          <dd className="mono">{message.rfcMessageId}</dd>
          <dt>Size</dt>
          <dd>
            <Bytes value={message.size} />
          </dd>
          <dt>Raw</dt>
          <dd>
            <a href={`/v1/messages/${params.id}/raw`} className="muted">
              Download .eml
            </a>{" "}
            <span className="muted" style={{ fontSize: 12 }}>
              (needs a bearer token — or use <code>mailworker get {params.id} --raw</code>)
            </span>
          </dd>
        </dl>
      </div>

      {message.attachments.length > 0 && (
        <>
          <h2>Attachments</h2>
          <div className="panel">
            <table>
              <tbody>
                {message.attachments.map((attachment) => (
                  <tr key={attachment.id}>
                    <td>
                      <Link to={`/messages/${params.id}/attachments/${attachment.id}`}>
                        {attachment.filename ?? "(unnamed)"}
                      </Link>
                    </td>
                    <td className="muted">{attachment.mime ?? "unknown"}</td>
                    <td className="numeric">
                      <Bytes value={attachment.size} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>
        <span className="row" style={{ justifyContent: "space-between" }}>
          <span>Body</span>
          <span className="row" style={{ gap: 6, textTransform: "none", letterSpacing: 0 }}>
            {message.hasHtml && (
              <button
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(search);
                  if (showHtml) next.set("view", "text");
                  else next.delete("view");
                  setSearch(next, { preventScrollReset: true });
                }}
              >
                {showHtml ? "View as text" : "View as HTML"}
              </button>
            )}
            {showHtml && !showImages && (
              <button
                type="button"
                onClick={() => {
                  const next = new URLSearchParams(search);
                  next.set("images", "1");
                  setSearch(next, { preventScrollReset: true });
                }}
              >
                Load remote images
              </button>
            )}
          </span>
        </span>
      </h2>

      <div className="panel">
        {showHtml ? (
          /**
           * `sandbox` with no `allow-same-origin`: the frame gets an opaque
           * origin, so even if the sanitizer were bypassed the script inside it
           * has no access to this page, its cookies or its DOM. Combined with
           * the CSP the body route sets, this is the actual boundary — the
           * sanitizer is defence in depth (see `packages/mime/src/sanitize.ts`).
           */
          <iframe
            title="Message body"
            className="body-frame"
            sandbox=""
            referrerPolicy="no-referrer"
            src={`/messages/${params.id}/body${showImages ? "?images=1" : ""}`}
          />
        ) : (
          <pre className="body-text">
            {message.bodyText ?? <span className="muted">This message has no text body.</span>}
          </pre>
        )}
      </div>
    </>
  );
}
