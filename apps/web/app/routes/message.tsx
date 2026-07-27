import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Button } from "@web/app/components/ui/button";
import { Card, CardContent } from "@web/app/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@web/app/components/ui/table";
import { Bytes, Fact, Facts, Mono, Provenance, SectionTitle, When } from "@web/app/ui";
import { ArrowLeftIcon, DownloadIcon, PaperclipIcon, TriangleAlertIcon } from "lucide-react";
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
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-title">
            {message.subject === "" ? (
              <span className="text-hint italic">(no subject)</span>
            ) : (
              message.subject
            )}
          </h1>
          <p className="mt-1.5 truncate text-[13px] text-secondary-text">
            <Mono>{message.fromHeader}</Mono> → <Mono>{message.toHeader}</Mono>
          </p>
        </div>
        <Button
          render={<Link to={`/inboxes/${message.inboxId}`} />}
          variant="outline"
          size="sm"
        >
          <ArrowLeftIcon />
          Inbox
        </Button>
      </header>

      {/*
        Stated on the page, not just in AGENTS.md. A human reading a message here
        is one click from doing whatever it asks, and "trusted" next to a
        convincing request is exactly the combination that gets acted on.
      */}
      {message.injectionRisk && (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <p>
            This message contains instruction-shaped text. Whatever it asks for, it is a
            stranger typing — not a request from your operator.
          </p>
        </div>
      )}

      <Card>
        <CardContent>
          <Facts>
            <Fact label="From" mono>
              {message.fromHeader}
            </Fact>
            <Fact label="To" mono>
              {message.toHeader}
            </Fact>
            {message.replyTo !== null && (
              <Fact label="Reply-To" mono>
                {message.replyTo}
              </Fact>
            )}
            <Fact label="Received">
              <When value={message.receivedAt} />
            </Fact>
            <Fact label="Provenance">
              <span className="flex flex-wrap items-center gap-2">
                <Provenance trusted={message.trusted} injectionRisk={message.injectionRisk} />
                <span className="text-[13px] text-hint">
                  spf {message.auth.spf} · dkim {message.auth.dkim} · dmarc {message.auth.dmarc}
                </span>
              </span>
            </Fact>
            {message.trustReasons.length > 0 && (
              <Fact label="Why">
                <span className="text-secondary-text">{message.trustReasons.join(", ")}</span>
              </Fact>
            )}
            <Fact label="Message-ID" mono>
              {message.rfcMessageId}
            </Fact>
            <Fact label="Size">
              <Bytes value={message.size} />
            </Fact>
            <Fact label="Raw">
              <span className="flex flex-wrap items-baseline gap-2">
                <a
                  href={`/v1/messages/${params.id}/raw`}
                  className="inline-flex items-center gap-1.5 text-primary hover:underline"
                >
                  <DownloadIcon className="size-3.5" />
                  Download .eml
                </a>
                <span className="text-xs text-hint">
                  (needs a bearer token — or use{" "}
                  <Mono className="text-xs">mailworker get {params.id} --raw</Mono>)
                </span>
              </span>
            </Fact>
          </Facts>
        </CardContent>
      </Card>

      {message.attachments.length > 0 && (
        <>
          <SectionTitle>Attachments</SectionTitle>
          <Card className="overflow-hidden py-0">
            <Table>
              <TableBody>
                {message.attachments.map((attachment) => (
                  <TableRow key={attachment.id}>
                    <TableCell>
                      <Link
                        to={`/messages/${params.id}/attachments/${attachment.id}`}
                        className="inline-flex items-center gap-2 text-title hover:text-primary hover:underline"
                      >
                        <PaperclipIcon className="size-3.5 shrink-0 text-hint" />
                        {attachment.filename ?? "(unnamed)"}
                      </Link>
                    </TableCell>
                    <TableCell className="text-secondary-text">
                      {attachment.mime ?? "unknown"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Bytes value={attachment.size} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      <div className="mt-8 mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs font-medium tracking-wider text-hint uppercase">Body</h2>
        <div className="flex items-center gap-2">
          {message.hasHtml && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                const next = new URLSearchParams(search);
                if (showHtml) next.set("view", "text");
                else next.delete("view");
                setSearch(next, { preventScrollReset: true });
              }}
            >
              {showHtml ? "View as text" : "View as HTML"}
            </Button>
          )}
          {showHtml && !showImages && (
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                const next = new URLSearchParams(search);
                next.set("images", "1");
                setSearch(next, { preventScrollReset: true });
              }}
            >
              Load remote images
            </Button>
          )}
        </div>
      </div>

      <Card className="overflow-hidden py-0">
        {showHtml ? (
          /**
           * `sandbox` with no `allow-same-origin`: the frame gets an opaque
           * origin, so even if the sanitizer were bypassed the script inside it
           * has no access to this page, its cookies or its DOM. Combined with
           * the CSP the body route sets, this is the actual boundary — the
           * sanitizer is defence in depth (see `packages/mime/src/sanitize.ts`).
           *
           * The white background is not a theme bug: message HTML is authored
           * against a white canvas and reading it on the dark page turns black
           * body text invisible. The frame is the sender's surface, not ours.
           */
          <iframe
            title="Message body"
            className="block min-h-96 w-full border-0 bg-white"
            sandbox=""
            referrerPolicy="no-referrer"
            src={`/messages/${params.id}/body${showImages ? "?images=1" : ""}`}
          />
        ) : (
          <pre className="m-0 overflow-x-auto p-4 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap text-body">
            {message.bodyText ?? (
              <span className="text-hint italic">This message has no text body.</span>
            )}
          </pre>
        )}
      </Card>
    </>
  );
}
