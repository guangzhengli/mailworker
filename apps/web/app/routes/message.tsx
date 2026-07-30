import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { Button } from "@web/app/components/ui/button";
import { Card, CardContent } from "@web/app/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@web/app/components/ui/table";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import {
  Bytes,
  Callout,
  CodeBlock,
  Fact,
  Facts,
  Mono,
  PageHeader,
  Provenance,
  SectionTitle,
  TextLink,
  When,
} from "@web/app/ui";
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

export const meta: Route.MetaFunction = ({ matches, loaderData }) => {
  const locale = localeFromMatches(matches);
  return [
    {
      title: translate(locale, "message.pageTitle", {
        subject: loaderData.message.subject || translate(locale, "common.noSubject"),
      }),
    },
  ];
};

export default function MessagePage({ loaderData, params }: Route.ComponentProps) {
  const { message } = loaderData;
  const [search, setSearch] = useSearchParams();
  const showImages = search.get("images") === "1";
  const showHtml = message.hasHtml && search.get("view") !== "text";
  const { t, rich } = useT();

  return (
    <>
      <PageHeader
        title={
          message.subject === "" ? (
            <span className="text-hint italic">{t("common.noSubject")}</span>
          ) : (
            message.subject
          )
        }
        description={
          <>
            <Mono>{message.fromHeader}</Mono> → <Mono>{message.toHeader}</Mono>
          </>
        }
      >
        <Button
          render={<Link to={`/inboxes/${message.inboxId}`} />}
          variant="outline"
          size="sm"
        >
          <ArrowLeftIcon />
          {t("message.inbox")}
        </Button>
      </PageHeader>

      {/*
        Stated on the page, not just in AGENTS.md. A human reading a message here
        is one click from doing whatever it asks, and "trusted" next to a
        convincing request is exactly the combination that gets acted on.
      */}
      {message.injectionRisk && (
        <Callout tone="danger" className="mb-5" icon={<TriangleAlertIcon />}>
          {t("message.injectionWarning")}
        </Callout>
      )}

      <Card>
        <CardContent>
          <Facts>
            <Fact label={t("field.from")} mono>
              {message.fromHeader}
            </Fact>
            <Fact label={t("field.to")} mono>
              {message.toHeader}
            </Fact>
            {message.replyTo !== null && (
              <Fact label={t("message.replyTo")} mono>
                {message.replyTo}
              </Fact>
            )}
            <Fact label={t("field.received")}>
              <When value={message.receivedAt} />
            </Fact>
            <Fact label={t("field.provenance")}>
              <span className="flex flex-wrap items-center gap-2">
                <Provenance trusted={message.trusted} injectionRisk={message.injectionRisk} />
                <span className="text-[13px] text-hint">
                  {t("message.authSummary", {
                    spf: message.auth.spf,
                    dkim: message.auth.dkim,
                    dmarc: message.auth.dmarc,
                  })}
                </span>
              </span>
            </Fact>
            {message.trustReasons.length > 0 && (
              <Fact label={t("message.why")}>
                {/* The reasons are the trust engine's own identifiers, and stay
                    in its vocabulary for the same reason the statuses do. */}
                <span className="text-secondary-text">{message.trustReasons.join(", ")}</span>
              </Fact>
            )}
            <Fact label={t("message.messageId")} mono>
              {message.rfcMessageId}
            </Fact>
            <Fact label={t("message.size")}>
              <Bytes value={message.size} />
            </Fact>
            <Fact label={t("message.raw")}>
              <span className="flex flex-wrap items-baseline gap-2">
                <TextLink href={`/v1/messages/${params.id}/raw`}>
                  <DownloadIcon />
                  {t("message.download")}
                </TextLink>
                <span className="text-xs text-hint">
                  {rich("message.downloadHint", {
                    command: <Mono className="text-xs">mailworker get {params.id} --raw</Mono>,
                  })}
                </span>
              </span>
            </Fact>
          </Facts>
        </CardContent>
      </Card>

      {message.attachments.length > 0 && (
        <>
          <SectionTitle>{t("message.attachments")}</SectionTitle>
          <Card className="overflow-hidden py-0">
            <Table>
              <TableBody>
                {message.attachments.map((attachment) => (
                  <TableRow key={attachment.id}>
                    <TableCell>
                      <TextLink
                        render={
                          <Link to={`/messages/${params.id}/attachments/${attachment.id}`} />
                        }
                        variant="quiet"
                      >
                        <PaperclipIcon className="text-hint" />
                        {attachment.filename ?? t("message.unnamedAttachment")}
                      </TextLink>
                    </TableCell>
                    <TableCell className="text-secondary-text">
                      {attachment.mime ?? t("message.unknownType")}
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

      <SectionTitle
        actions={
          <>
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
                {showHtml ? t("message.viewAsText") : t("message.viewAsHtml")}
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
                {t("message.loadImages")}
              </Button>
            )}
          </>
        }
      >
        {t("message.body")}
      </SectionTitle>

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
            title={t("message.frameTitle")}
            className="block min-h-96 w-full border-0 bg-white"
            sandbox=""
            referrerPolicy="no-referrer"
            src={`/messages/${params.id}/body${showImages ? "?images=1" : ""}`}
          />
        ) : (
          <CodeBlock>
            {message.bodyText ?? (
              <span className="text-hint italic">{t("message.noTextBody")}</span>
            )}
          </CodeBlock>
        )}
      </Card>
    </>
  );
}
