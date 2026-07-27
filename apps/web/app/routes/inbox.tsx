import { Ulid } from "@mailworker/core";
import { page } from "@web/app/auth";
import { useLiveMail } from "@web/app/live";
import { Empty, Live, Provenance, Relative, When } from "@web/app/ui";
import { Form, Link } from "react-router";
import type { Route } from "./+types/inbox";

export async function loader({ context, request, params }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const id = Ulid.parse(params.id);
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");
    const q = url.searchParams.get("q")?.trim() ?? "";

    /**
     * Two round trips rather than one join: the inbox is the page's identity and
     * the messages are its content, and the services that own them are separate
     * on purpose. D1 is local to the Worker, so the second call is microseconds.
     */
    const inbox = await services.mailbox.getInbox(caller, id);
    const page = await services.mailbox.listMessages(caller, {
      inboxId: id,
      ...(q === "" ? {} : { q }),
      ...(cursor === null ? {} : { cursor: Ulid.parse(cursor) }),
    });

    return { inbox, messages: page.items, cursor: page.cursor, q };
  });
}

export const meta: Route.MetaFunction = ({ loaderData }) => [
  { title: `${loaderData.inbox.address} · Mailworker` },
];

export default function InboxPage({ loaderData, params }: Route.ComponentProps) {
  const { inbox, messages, cursor, q } = loaderData;
  // Scoped to this inbox, so a busy account's other mail does not reload this
  // page. The filter is applied server-side; see `app/live.ts`.
  const live = useLiveMail(params.id);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="mono">{inbox.address}</h1>
          <p className="muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
            <span className="tag">{inbox.kind}</span>{" "}
            {inbox.expiresAt === null ? (
              "never expires"
            ) : (
              <>
                expires <Relative value={inbox.expiresAt} />
              </>
            )}
          </p>
        </div>
        <span className="row" style={{ gap: 12 }}>
          <Live status={live} />
          <Link to="/" className="muted">
            ← All inboxes
          </Link>
        </span>
      </div>

      <Form method="get" className="row" style={{ marginBottom: 14 }}>
        <input
          name="q"
          defaultValue={q}
          placeholder="Search subject and body…"
          style={{ maxWidth: 340 }}
          aria-label="Search"
        />
        <button type="submit">Search</button>
        {q !== "" && (
          <Link to={`/inboxes/${params.id}`} className="muted" style={{ fontSize: 13 }}>
            Clear
          </Link>
        )}
      </Form>

      <div className="panel">
        {messages.length === 0 ? (
          <Empty>
            {q === "" ? (
              <>
                Nothing here yet. Mail sent to <code>{inbox.address}</code> will appear the
                moment it lands.
              </>
            ) : (
              <>
                No message matches <code>{q}</code>.
              </>
            )}
          </Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>Subject</th>
                <th>Provenance</th>
                <th>Received</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((message) => (
                <tr key={message.id} style={message.seen ? undefined : { fontWeight: 500 }}>
                  <td className="truncate" style={{ maxWidth: 220 }}>
                    {message.fromHeader}
                  </td>
                  <td className="truncate">
                    <Link to={`/messages/${message.id}`}>
                      {message.subject === "" ? (
                        <span className="muted">(no subject)</span>
                      ) : (
                        message.subject
                      )}
                    </Link>
                    <div className="muted truncate" style={{ fontWeight: 400, fontSize: 13 }}>
                      {message.preview}
                    </div>
                  </td>
                  <td>
                    <Provenance
                      trusted={message.trusted}
                      injectionRisk={message.injectionRisk}
                    />
                  </td>
                  <td>
                    <When value={message.receivedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {cursor !== null && (
        <p style={{ marginTop: 14 }}>
          <Link
            to={`/inboxes/${params.id}?cursor=${cursor}${q === "" ? "" : `&q=${encodeURIComponent(q)}`}`}
          >
            Older →
          </Link>
        </p>
      )}
    </>
  );
}
