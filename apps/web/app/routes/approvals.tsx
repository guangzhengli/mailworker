import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@web/app/components/ui/alert-dialog";
import { Button } from "@web/app/components/ui/button";
import { Card, CardContent } from "@web/app/components/ui/card";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import { localeFromRequest } from "@web/app/i18n/locale.server";
import { Callout, Empty, Mono, PageHeader, Pager, When } from "@web/app/ui";
import { ArrowRightIcon } from "lucide-react";
import { useEffect } from "react";
import { Form, Link, useNavigation } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/approvals";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "approvals.pageTitle") },
];

/**
 * The approval queue, as a queue.
 *
 * It used to be a status filter on the deliveries table with a one-word button
 * per row, which meant the only decision the dashboard exists to support was
 * made without the two things needed to make it: which gate held the message,
 * and what the message says. Both are on the card now, and there is a Reject —
 * a queue you can only say yes to is not a review (DESIGN ADR-10).
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");

    const held = await services.delivery.list(caller, {
      status: "pending_approval",
      ...(cursor === null ? {} : { cursor: Ulid.parse(cursor) }),
    });

    /**
     * The body of every held send, read back so a reviewer decides on the
     * message rather than on an id. This is the reason `readDeliveryBody` exists
     * for non-dispatched deliveries: the archived sent copy is only written at
     * dispatch, which is after the decision being made here.
     */
    const previews = await Promise.all(
      held.items.map(async (delivery) => {
        const preview = await services.delivery.preview(caller, delivery.id).catch(() => null);
        return {
          id: delivery.id,
          recipients: delivery.recipients,
          createdAt: delivery.createdAt,
          identityId: delivery.identityId,
          // `lastError` carries the approval reason for a held send — which gate
          // put it here. It is the single most useful thing on this page.
          heldBecause: delivery.lastError,
          subject: preview?.subject ?? null,
          text: preview?.text ?? null,
        };
      }),
    );

    return {
      held: previews,
      cursor: held.cursor,
      mayApprove: can(caller, "message:approve"),
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();
    const id = Ulid.parse(String(form.get("id")));

    if (form.get("intent") === "reject") {
      const locale = localeFromRequest(request);
      await services.delivery.reject(caller, id, translate(locale, "approvals.rejectReason"));
      return { done: "rejected" as const };
    }

    await services.delivery.approve(caller, id);
    return { done: "approved" as const };
  });
}

export default function Approvals({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const { t } = useT();
  const done = actionData?.done ?? null;

  useEffect(() => {
    if (done === "approved") toast.success(t("approvals.approved"));
    if (done === "rejected") toast.success(t("approvals.rejected"));
  }, [done, t]);

  return (
    <>
      <PageHeader title={t("approvals.title")} description={t("approvals.description")} />

      {/* Above the list, not below it: it explains why the rows have no approve
          button, and an explanation for a missing control has to be readable
          before the reader concludes the page is broken. */}
      {!loaderData.mayApprove && (
        <Callout tone="info" className="mb-4">
          {t("approvals.cannotApprove")}
        </Callout>
      )}

      {loaderData.held.length === 0 ? (
        <Card className="overflow-hidden py-0">
          <Empty>{t("approvals.empty")}</Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {loaderData.held.map((held) => (
            <Card key={held.id}>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-title">
                      {held.subject === null || held.subject === ""
                        ? t("common.noSubject")
                        : held.subject}
                    </div>
                    <Mono className="block truncate text-[13px] text-secondary-text">
                      {held.recipients.join(", ")}
                    </Mono>
                  </div>
                  <When value={held.createdAt} className="shrink-0 text-[13px]" />
                </div>

                {held.heldBecause !== null && (
                  <div className="rounded-control border border-warning-border bg-warning-bg px-3 py-2 text-[13px]">
                    <span className="font-medium text-warning">
                      {t("approvals.heldBecause")}:{" "}
                    </span>
                    <span className="text-body">{held.heldBecause}</span>
                  </div>
                )}

                {held.text !== null && (
                  <pre className="max-h-48 overflow-auto rounded-control bg-muted px-3 py-2 text-[13px] whitespace-pre-wrap text-body">
                    {held.text}
                  </pre>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {loaderData.mayApprove && (
                    <>
                      <Form method="post">
                        <input type="hidden" name="id" value={held.id} />
                        <Button type="submit" size="sm" disabled={busy}>
                          {t("approvals.approve")}
                        </Button>
                      </Form>

                      <AlertDialog>
                        <AlertDialogTrigger
                          render={<Button variant="outline" size="sm" disabled={busy} />}
                        >
                          {t("approvals.reject")}
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t("approvals.rejectTitle")}</AlertDialogTitle>
                            <AlertDialogDescription>
                              {t("approvals.rejectBody", {
                                recipients: held.recipients.join(", "),
                              })}
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                            <Form method="post">
                              <input type="hidden" name="intent" value="reject" />
                              <input type="hidden" name="id" value={held.id} />
                              <AlertDialogAction
                                render={
                                  <Button type="submit" variant="destructive" disabled={busy}>
                                    {t("approvals.rejectConfirm")}
                                  </Button>
                                }
                              />
                            </Form>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </>
                  )}

                  <Button render={<Link to={`/sent/${held.id}`} />} variant="ghost" size="sm">
                    {t("approvals.openDetail")}
                    <ArrowRightIcon />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {loaderData.cursor !== null && <Pager to={`/approvals?cursor=${loaderData.cursor}`} />}
    </>
  );
}
