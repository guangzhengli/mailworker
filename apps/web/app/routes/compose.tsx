import { isDomainError, Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import type { ComposeResult } from "@web/app/components/compose-panel";
import { useCompose } from "@web/app/components/compose-panel";
import { Button } from "@web/app/components/ui/button";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import { localeFromRequest } from "@web/app/i18n/locale.server";
import { replySubject } from "@web/app/mail";
import { Callout, PageHeader } from "@web/app/ui";
import { useEffect } from "react";
import { Link, redirect } from "react-router";
import type { Route } from "./+types/compose";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "compose.pageTitle") },
];

/**
 * Every send from the dashboard is attributed to the managed `console` identity
 * rather than to the session: a session is usually an admin key,
 * and admin is exempt from the sender rule, the allowlist and the quota.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    if (!can(caller, "admin")) throw new Response("Admin access required.", { status: 403 });
    const url = new URL(request.url);
    const replyTo = url.searchParams.get("reply");

    const inboxes = await services.mailbox.listInboxes(caller, { limit: 100 });
    const quoted =
      replyTo === null
        ? null
        : await services.mailbox.getMessage(caller, Ulid.parse(replyTo)).catch(() => null);

    return {
      inboxes: [...inboxes.items]
        .sort(
          (left, right) =>
            Number(right.kind === "persistent") - Number(left.kind === "persistent") ||
            left.address.localeCompare(right.address),
        )
        .map((inbox) => ({ id: inbox.id, address: inbox.address })),
      quoted:
        quoted === null
          ? null
          : {
              id: quoted.id,
              inboxId: quoted.inboxId,
              subject: quoted.subject,
              to: quoted.replyTo ?? quoted.from,
            },
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }): Promise<ComposeResult> => {
    if (!can(caller, "admin")) throw new Response("Admin access required.", { status: 403 });
    const form = await request.formData();
    const stay = form.get("stay") === "1";
    const field = (name: string) => String(form.get(name) ?? "").trim();
    const addresses = (name: string) =>
      field(name)
        .split(/[,;\s]+/)
        .filter((address) => address !== "");

    const attachments = await Promise.all(
      form
        .getAll("attachments")
        .filter((value): value is File => value instanceof File && value.size > 0)
        .map(async (file) => ({
          filename: file.name,
          mime: file.type === "" ? "application/octet-stream" : file.type,
          content: toBase64(new Uint8Array(await file.arrayBuffer())),
          inline: false,
          contentId: null,
        })),
    );

    const identity = await services.identity.ensureConsoleIdentity(caller);
    const inReplyTo = field("inReplyToMessageId");
    const replaces = field("replaces");
    const cc = addresses("cc");
    const bcc = addresses("bcc");
    const replyTo = field("replyTo");

    try {
      // Checked before sending, so a draft someone else already approved or
      // rejected does not get a second, human-written copy sent after it.
      if (replaces !== "") {
        const { delivery } = await services.delivery.timeline(caller, Ulid.parse(replaces));
        if (delivery.status !== "pending_approval") {
          return {
            error: {
              code: "invalid_state_transition",
              message: `Delivery ${replaces} is ${delivery.status}, no longer awaiting approval.`,
            },
          };
        }
      }

      const result = await services.delivery.send(
        { ...caller, identityId: identity.id },
        {
          from: field("from"),
          to: addresses("to"),
          ...(cc.length === 0 ? {} : { cc }),
          ...(bcc.length === 0 ? {} : { bcc }),
          ...(replyTo === "" ? {} : { replyTo }),
          subject: field("subject"),
          text: String(form.get("text") ?? ""),
          ...(inReplyTo === "" ? {} : { inReplyToMessageId: inReplyTo }),
          ...(attachments.length === 0 ? {} : { attachments }),
          // Never read from the form: accepting it over the wire would let a
          // caller skip the approval hold by claiming to be a human.
          source: "console",
        },
      );

      // Sent first, withdrawn second: if the send is refused, the agent's draft
      // is still in the queue rather than lost.
      let replaced: string | null = null;
      if (replaces !== "") {
        replaced = await services.delivery
          .reject(
            caller,
            Ulid.parse(replaces),
            translate(localeFromRequest(request), "approvals.replacedReason", {
              id: result.delivery.id,
            }),
          )
          .then(() => replaces)
          .catch(() => null);
      }

      if (!stay) throw redirect(`/sent/${result.delivery.id}?sent=1`);
      return { sent: result.delivery.id, replaced };
    } catch (error) {
      if (stay && isDomainError(error)) {
        return { error: { code: error.code, message: error.message } };
      }
      throw error;
    }
  });
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** A direct link to `/compose` opens the panel; the page itself is only its backdrop. */
export default function Compose({ loaderData }: Route.ComponentProps) {
  const { t } = useT();
  const compose = useCompose();
  const { quoted, inboxes } = loaderData;

  useEffect(() => {
    if (quoted === null) {
      compose.open();
      return;
    }
    const from = inboxes.find((inbox) => inbox.id === quoted.inboxId)?.address;
    compose.open({
      ...(from === undefined ? {} : { from }),
      ...(quoted.to === null ? {} : { to: quoted.to }),
      subject: replySubject(quoted.subject),
      inReplyToMessageId: quoted.id,
    });
  }, [compose, quoted, inboxes]);

  return (
    <>
      <PageHeader title={quoted === null ? t("compose.title") : t("compose.replyTitle")} />
      {inboxes.length === 0 ? (
        <Callout tone="warning">{t("compose.noInbox")}</Callout>
      ) : (
        <Button render={<Link to="/mail" />} variant="outline" size="sm">
          {t("compose.backToMail")}
        </Button>
      )}
    </>
  );
}
