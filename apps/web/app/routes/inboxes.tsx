import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { type AnimatedIconHandle, DeleteIcon, PlusIcon } from "@web/app/components/icons";
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
import { Input } from "@web/app/components/ui/input";
import { Label } from "@web/app/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@web/app/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/app/components/ui/table";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import { Empty, Mono, PageHeader, Pager, Relative, Tag, TextLink, When } from "@web/app/ui";
import { useEffect, useRef } from "react";
import { Form, Link, useNavigation } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/inboxes";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "inboxes.pageTitle") },
];

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");

    const page = await services.mailbox.listInboxes(caller, {
      includeExpired: url.searchParams.get("expired") === "1",
      ...(cursor === null ? {} : { cursor: Ulid.parse(cursor) }),
    });

    return {
      inboxes: page.items,
      cursor: page.cursor,
      includeExpired: url.searchParams.get("expired") === "1",
      mayCreate: can(caller, "inbox:write"),
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();

    if (form.get("intent") === "delete") {
      await services.mailbox.deleteInbox(caller, Ulid.parse(String(form.get("id"))));
      return { created: null };
    }

    const ttlMinutes = Number(form.get("ttlMinutes") ?? 0);
    const persistent = form.get("kind") === "persistent";
    const prefix = String(form.get("prefix") ?? "").trim();

    const inbox = await services.mailbox.createInbox(caller, {
      kind: persistent ? "persistent" : "ephemeral",
      ...(prefix === "" ? {} : { prefix }),
      ...(persistent || !Number.isFinite(ttlMinutes) || ttlMinutes <= 0
        ? {}
        : { ttlMs: ttlMinutes * 60_000 }),
    });

    return { created: inbox.address };
  });
}

/**
 * Deleting an inbox drops its messages, and the old one-click button sat in the
 * same column position on every row — so the miss that lands on the wrong row is
 * silent and unrecoverable. The confirmation names the address it is about to
 * destroy, which is the part that makes it a check rather than a speed bump.
 */
function DeleteInbox({ id, address, busy }: { id: string; address: string; busy: boolean }) {
  const icon = useRef<AnimatedIconHandle>(null);
  const { t, rich } = useT();

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("inboxes.deleteAria", { address })}
            className="text-hint hover:text-danger"
            onMouseEnter={() => icon.current?.startAnimation()}
            onMouseLeave={() => icon.current?.stopAnimation()}
          />
        }
      >
        <DeleteIcon ref={icon} size={16} />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("inboxes.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {rich("inboxes.deleteBody", {
              address: <Mono className="text-body">{address}</Mono>,
            })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <Form method="post">
            <input type="hidden" name="intent" value="delete" />
            <input type="hidden" name="id" value={id} />
            <AlertDialogAction
              render={
                <Button type="submit" variant="destructive" disabled={busy}>
                  {t("inboxes.deleteConfirm")}
                </Button>
              }
            />
          </Form>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function Inboxes({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const created = actionData?.created ?? null;
  const plus = useRef<AnimatedIconHandle>(null);
  const { t, rich } = useT();

  /**
   * The new row appears in the table by itself, so the toast is not what tells
   * you it worked — it is what puts the generated address somewhere you can
   * read it without hunting for the row that just moved.
   */
  useEffect(() => {
    if (created !== null) toast.success(t("inboxes.created"), { description: created });
  }, [created, t]);

  return (
    <>
      <PageHeader title={t("inboxes.title")} description={t("inboxes.description")}>
        <Button
          render={<Link to={loaderData.includeExpired ? "/" : "/?expired=1"} />}
          variant="ghost"
          size="sm"
        >
          {loaderData.includeExpired ? t("inboxes.hideExpired") : t("inboxes.showExpired")}
        </Button>
      </PageHeader>

      {loaderData.mayCreate && (
        <Card className="mb-5">
          <CardContent>
            <Form method="post" className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-48 flex-1 flex-col gap-2">
                <Label htmlFor="prefix">{t("inboxes.prefixLabel")}</Label>
                <Input id="prefix" name="prefix" placeholder="inbox" className="font-mono" />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="kind">{t("field.kind")}</Label>
                {/*
                 * `items` as well as the two `SelectItem`s: the popup is not
                 * mounted on the server, and without the map the trigger renders
                 * the raw value until it opens. The two kinds are the wire
                 * vocabulary, so label and value coincide here — but stating the
                 * map is what keeps the first paint right.
                 */}
                <Select
                  name="kind"
                  defaultValue="ephemeral"
                  items={{ ephemeral: "ephemeral", persistent: "persistent" }}
                >
                  <SelectTrigger id="kind" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ephemeral">ephemeral</SelectItem>
                    <SelectItem value="persistent">persistent</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="ttlMinutes">{t("inboxes.ttlLabel")}</Label>
                <Input
                  id="ttlMinutes"
                  name="ttlMinutes"
                  type="number"
                  min={1}
                  defaultValue={60}
                  className="w-28 tabular-nums"
                />
              </div>

              <Button
                type="submit"
                disabled={busy}
                onMouseEnter={() => plus.current?.startAnimation()}
                onMouseLeave={() => plus.current?.stopAnimation()}
              >
                <PlusIcon ref={plus} size={16} />
                {t("inboxes.create")}
              </Button>
            </Form>
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden py-0">
        {loaderData.inboxes.length === 0 ? (
          <Empty>
            {rich("inboxes.empty", { command: <Mono>mailworker inbox create</Mono> })}
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("field.address")}</TableHead>
                <TableHead>{t("field.kind")}</TableHead>
                <TableHead>{t("field.expires")}</TableHead>
                <TableHead>{t("field.created")}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loaderData.inboxes.map((inbox) => (
                <TableRow key={inbox.id}>
                  <TableCell className="max-w-0 truncate">
                    <TextLink
                      render={<Link to={`/inboxes/${inbox.id}`} />}
                      variant="quiet"
                      className="font-mono text-[13px]"
                    >
                      {inbox.address}
                    </TextLink>
                  </TableCell>
                  <TableCell>
                    <Tag tone={inbox.kind === "persistent" ? "info" : "neutral"}>
                      {inbox.kind}
                    </Tag>
                  </TableCell>
                  <TableCell>
                    <Relative value={inbox.expiresAt} />
                  </TableCell>
                  <TableCell>
                    <When value={inbox.createdAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    {loaderData.mayCreate && (
                      <DeleteInbox id={inbox.id} address={inbox.address} busy={busy} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      {loaderData.cursor !== null && (
        <Pager
          to={`/?cursor=${loaderData.cursor}${loaderData.includeExpired ? "&expired=1" : ""}`}
        />
      )}
    </>
  );
}
