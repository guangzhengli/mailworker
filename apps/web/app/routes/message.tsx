import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { BodyViewer } from "@web/app/components/body-viewer";
import { Button } from "@web/app/components/ui/button";
import { Card, CardContent } from "@web/app/components/ui/card";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import {
  Addresses,
  AttachmentList,
  Bytes,
  Callout,
  CopyButton,
  Disclosure,
  Fact,
  Facts,
  KeyFact,
  KeyFacts,
  Mono,
  PageHeader,
  Provenance,
  When,
} from "@web/app/ui";
import { ReplyIcon, TriangleAlertIcon } from "lucide-react";
import { Link } from "react-router";
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

    const inbox = await services.mailbox.getInbox(caller, message.inboxId).catch(() => null);

    return {
      message: {
        ...message,
        // The body is not sent to the browser as data. It is served separately,
        // into a sandboxed frame, under its own CSP — see `message-body.tsx`.
        bodyHtml: null,
        hasHtml: message.bodyHtml !== null && message.bodyHtml.length > 0,
      },
      inboxAddress: inbox?.address ?? null,
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
  const { message, inboxAddress } = loaderData;
  const { t, rich } = useT();

  return (
    <>
      <PageHeader
        back={{ to: "/inbox", label: t("message.backToInbox") }}
        title={
          message.subject === "" ? (
            <span className="text-hint italic">{t("common.noSubject")}</span>
          ) : (
            message.subject
          )
        }
      >
        {/* Reply is what turns an inbox receiving support mail into one that can
            answer it. It sends as the inbox's own address, under the same gates
            (DESIGN ADR-11). */}
        <Button render={<Link to={`/compose?reply=${message.id}`} />} size="sm">
          <ReplyIcon />
          {t("message.reply")}
        </Button>
      </PageHeader>

      <KeyFacts>
        <KeyFact label={t("field.from")} className="sm:col-span-2">
          <Addresses header={message.fromHeader} className="text-title" />
        </KeyFact>
        <KeyFact label={t("field.to")}>
          <Addresses header={message.toHeader} className="text-secondary-text" />
        </KeyFact>
        <KeyFact label={t("field.received")}>
          <When value={message.receivedAt} />
        </KeyFact>
        <KeyFact label={t("field.provenance")} className="sm:col-span-2">
          <Provenance trusted={message.trusted} injectionRisk={message.injectionRisk} />
        </KeyFact>
        {inboxAddress !== null && (
          <KeyFact label={t("field.receivedAt")} className="sm:col-span-2">
            <Link
              to={`/inbox?inbox=${message.inboxId}`}
              className="font-mono text-[13px] text-secondary-text hover:text-primary hover:underline"
            >
              {inboxAddress}
            </Link>
          </KeyFact>
        )}
      </KeyFacts>

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

      {/*
        The body first, unlike `/sent/:id` where the timeline leads. Nobody opens
        an inbound message to find out what happened to it — what it says is the
        whole errand, and everything that is evidence rather than content sits in
        the disclosure underneath.
      */}
      <Card className="gap-0 overflow-hidden py-0">
        <BodyViewer
          src={`/messages/${params.id}/body`}
          hasHtml={message.hasHtml}
          text={message.bodyText}
          images
          raw={{
            href: `/v1/messages/${params.id}/raw`,
            hint: rich("message.downloadHint", {
              command: <Mono className="text-xs">mailworker get {params.id} --raw</Mono>,
            }),
          }}
        />

        {message.attachments.length > 0 && (
          <>
            <div className="border-t border-border bg-muted/40 px-4 py-2">
              <h2 className="text-xs font-medium tracking-wider text-hint uppercase">
                {t("message.attachments")}
              </h2>
            </div>
            <AttachmentList
              items={message.attachments.map((attachment) => ({
                key: attachment.id,
                filename: attachment.filename ?? t("message.unnamedAttachment"),
                mime: attachment.mime ?? t("message.unknownType"),
                bytes: attachment.size,
                href: `/messages/${params.id}/attachments/${attachment.id}`,
              }))}
            />
          </>
        )}
      </Card>

      <Card className="mt-6">
        <CardContent>
          <Disclosure summary={t("message.details")}>
            <Facts className="mt-3 border-t border-border pt-3">
              {message.replyTo !== null && (
                <Fact label={t("message.replyTo")}>
                  <Addresses header={message.replyTo} />
                </Fact>
              )}
              <Fact label={t("message.authentication")}>
                {t("message.authSummary", {
                  spf: message.auth.spf,
                  dkim: message.auth.dkim,
                  dmarc: message.auth.dmarc,
                })}
              </Fact>
              {message.trustReasons.length > 0 && (
                <Fact label={t("message.why")}>
                  {/* The reasons are the trust engine's own identifiers, and stay
                      in its vocabulary for the same reason the statuses do. */}
                  <span className="text-secondary-text">{message.trustReasons.join(", ")}</span>
                </Fact>
              )}
              <Fact label={t("message.messageId")}>
                <CopyButton value={message.rfcMessageId} label={t("common.copyId")} />
              </Fact>
              <Fact label={t("message.size")}>
                <Bytes value={message.size} />
              </Fact>
            </Facts>
          </Disclosure>
        </CardContent>
      </Card>
    </>
  );
}
