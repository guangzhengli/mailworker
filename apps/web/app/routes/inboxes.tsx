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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@web/app/components/ui/table";
import { Empty, Mono, PageHeader, Relative, Tag, When } from "@web/app/ui";
import { useEffect, useRef } from "react";
import { Form, Link, useNavigation } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/inboxes";

export const meta: Route.MetaFunction = () => [{ title: "Inboxes · Mailworker" }];

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

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Delete ${address}`}
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
          <AlertDialogTitle>Delete this inbox?</AlertDialogTitle>
          <AlertDialogDescription>
            <Mono className="text-body">{address}</Mono> and every message it holds are removed.
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Form method="post">
            <input type="hidden" name="intent" value="delete" />
            <input type="hidden" name="id" value={id} />
            <AlertDialogAction
              render={
                <Button type="submit" variant="destructive" disabled={busy}>
                  Delete inbox
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

  /**
   * The new row appears in the table by itself, so the toast is not what tells
   * you it worked — it is what puts the generated address somewhere you can
   * read it without hunting for the row that just moved.
   */
  useEffect(() => {
    if (created !== null) toast.success("Inbox created", { description: created });
  }, [created]);

  return (
    <>
      <PageHeader title="Inboxes" description="Addresses that accept mail for this account.">
        <Button
          render={<Link to={loaderData.includeExpired ? "/" : "/?expired=1"} />}
          variant="ghost"
          size="sm"
        >
          {loaderData.includeExpired ? "Hide expired" : "Show expired"}
        </Button>
      </PageHeader>

      {loaderData.mayCreate && (
        <Card className="mb-5">
          <CardContent>
            <Form method="post" className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-48 flex-1 flex-col gap-2">
                <Label htmlFor="prefix">Address prefix</Label>
                <Input id="prefix" name="prefix" placeholder="inbox" className="font-mono" />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="kind">Kind</Label>
                {/*
                 * A native select, not the Base UI one. This form is a plain
                 * POST that works with scripting off, and the styled trigger
                 * only submits a value once its JavaScript has run. Two options
                 * do not justify trading that away.
                 */}
                <select
                  id="kind"
                  name="kind"
                  className="h-9 rounded-control border border-border bg-input/30 px-3 text-sm text-body outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <option value="ephemeral">ephemeral</option>
                  <option value="persistent">persistent</option>
                </select>
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="ttlMinutes">TTL (minutes)</Label>
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
                Create inbox
              </Button>
            </Form>
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden py-0">
        {loaderData.inboxes.length === 0 ? (
          <Empty>
            No inboxes yet. Create one above, or run <Mono>mailworker inbox create</Mono>.
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Address</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loaderData.inboxes.map((inbox) => (
                <TableRow key={inbox.id}>
                  <TableCell className="max-w-0 truncate">
                    <Link
                      to={`/inboxes/${inbox.id}`}
                      className="font-mono text-[13px] text-title hover:text-primary hover:underline"
                    >
                      {inbox.address}
                    </Link>
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
        <div className="mt-4 flex justify-center">
          <Button
            render={
              <Link
                to={`/?cursor=${loaderData.cursor}${loaderData.includeExpired ? "&expired=1" : ""}`}
              />
            }
            variant="outline"
            size="sm"
          >
            Older
          </Button>
        </div>
      )}
    </>
  );
}
