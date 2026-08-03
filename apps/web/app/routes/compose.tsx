import { Ulid } from "@mailworker/core";
import { page } from "@web/app/auth";
import { Button } from "@web/app/components/ui/button";
import { Card, CardContent } from "@web/app/components/ui/card";
import { Input } from "@web/app/components/ui/input";
import { Label } from "@web/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/app/components/ui/select";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import { Callout, Mono, Note, PageHeader } from "@web/app/ui";
import { useEffect } from "react";
import { Form, redirect, useNavigation, useSearchParams } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/compose";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "compose.pageTitle") },
];

/**
 * A human sending mail, which the dashboard could not do at all.
 *
 * The gap that made it worth building is inbound: an account already receiving
 * support and contact-us mail could read it and not answer it, so the inbox was
 * half a feature. Reply is the case this is really for; blank compose is what it
 * degrades to.
 *
 * Every send from here is attributed to the managed `console` identity rather
 * than to the session. A dashboard session is usually an admin key, and gate 2
 * exempts `admin` from the sender rule, the recipient allowlist and the quota —
 * so sending as the session would have made this the one unmetered way out of
 * the building (DESIGN ADR-11).
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const url = new URL(request.url);
    const replyTo = url.searchParams.get("reply");

    const inboxes = await services.mailbox.listInboxes(caller, { limit: 100 });

    const quoted =
      replyTo === null
        ? null
        : await services.mailbox.getMessage(caller, Ulid.parse(replyTo)).catch(() => null);

    return {
      // Only addresses that still accept mail: a reply from an expired inbox
      // would be refused at the gate with a puzzling error.
      inboxes: inboxes.items.map((inbox) => ({ id: inbox.id, address: inbox.address })),
      quoted:
        quoted === null
          ? null
          : {
              id: quoted.id,
              inboxId: quoted.inboxId,
              subject: quoted.subject,
              from: quoted.replyTo ?? quoted.from,
              bodyText: quoted.bodyText,
            },
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();

    // Provisioned on first use, so a deployment that never sends from here never
    // grows the row.
    const identity = await services.identity.ensureConsoleIdentity(caller);

    const inReplyTo = String(form.get("inReplyToMessageId") ?? "").trim();
    const result = await services.delivery.send(
      { ...caller, identityId: identity.id },
      {
        from: String(form.get("from") ?? ""),
        to: String(form.get("to") ?? "")
          .split(",")
          .map((address) => address.trim())
          .filter((address) => address !== ""),
        subject: String(form.get("subject") ?? ""),
        text: String(form.get("text") ?? ""),
        ...(inReplyTo === "" ? {} : { inReplyToMessageId: inReplyTo }),
        // Never read from the form: accepting it over the wire would let a
        // caller skip the approval hold by claiming to be a human.
        source: "console",
      },
    );

    throw redirect(`/sent/${result.delivery.id}?sent=1`);
  });
}

export default function Compose({ loaderData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const [search] = useSearchParams();
  const { t, rich } = useT();
  const quoted = loaderData.quoted;

  useEffect(() => {
    if (search.get("sent") === "1") toast.success(t("compose.sent"));
  }, [search, t]);

  if (loaderData.inboxes.length === 0) {
    return (
      <>
        <PageHeader title={t("compose.title")} />
        <Callout tone="warning">{t("compose.noInbox")}</Callout>
      </>
    );
  }

  const defaultFrom =
    quoted === null
      ? loaderData.inboxes[0]!.address
      : (loaderData.inboxes.find((inbox) => inbox.id === quoted.inboxId)?.address ??
        loaderData.inboxes[0]!.address);

  const defaultSubject =
    quoted === null
      ? ""
      : quoted.subject.toLowerCase().startsWith("re:")
        ? quoted.subject
        : `Re: ${quoted.subject}`;

  return (
    <>
      <PageHeader title={quoted === null ? t("compose.title") : t("compose.replyTitle")} />

      {quoted !== null && (
        <Callout tone="info" className="mb-4">
          {t("compose.quoting", {
            subject: quoted.subject === "" ? t("common.noSubject") : quoted.subject,
          })}
        </Callout>
      )}

      <Card>
        <CardContent>
          <Form method="post" className="flex flex-col gap-4">
            {quoted !== null && (
              <input type="hidden" name="inReplyToMessageId" value={quoted.id} />
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="from">{t("compose.from")}</Label>
              <Select
                name="from"
                defaultValue={defaultFrom}
                items={Object.fromEntries(
                  loaderData.inboxes.map((inbox) => [inbox.address, inbox.address]),
                )}
              >
                <SelectTrigger id="from" className="font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {loaderData.inboxes.map((inbox) => (
                    <SelectItem key={inbox.id} value={inbox.address}>
                      {inbox.address}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* Under the field it qualifies: this is about who the send is
                  attributed to, which is what the From address decides. */}
              <Note className="mt-0">
                {rich("compose.consoleNote", { identity: <Mono>console</Mono> })}
              </Note>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="to">{t("compose.to")}</Label>
              <Input
                id="to"
                name="to"
                required
                defaultValue={quoted?.from ?? ""}
                placeholder={t("compose.toPlaceholder")}
                className="font-mono"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="subject">{t("compose.subject")}</Label>
              <Input id="subject" name="subject" required defaultValue={defaultSubject} />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="text">{t("compose.body")}</Label>
              <textarea
                id="text"
                name="text"
                required
                rows={12}
                className="w-full rounded-control border border-border bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-primary"
              />
            </div>

            <div className="flex items-center gap-3">
              <Button type="submit" disabled={busy}>
                {t("compose.send")}
              </Button>
            </div>
          </Form>
        </CardContent>
      </Card>
    </>
  );
}
