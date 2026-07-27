import type { SuppressionReason } from "@mailworker/core";
import { EmailAddress } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { type AnimatedIconHandle, BanIcon } from "@web/app/components/icons";
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
import { Empty, Mono, Note, PageHeader, Tag, When } from "@web/app/ui";
import { useRef } from "react";
import { Form } from "react-router";
import type { Route } from "./+types/suppressions";

export const meta: Route.MetaFunction = () => [{ title: "Suppressions · Mailworker" }];

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    return {
      entries: await services.delivery.listSuppressions(caller),
      maySuppress: can(caller, "message:send"),
      mayRemove: can(caller, "admin"),
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();
    const address = EmailAddress.parse(String(form.get("address") ?? ""));

    if (form.get("intent") === "remove") {
      await services.delivery.unsuppress(caller, address);
      return { removed: address };
    }

    await services.delivery.suppress(caller, {
      address,
      reason: String(
        form.get("reason") ?? "manual",
      ) as SuppressionReason satisfies SuppressionReason,
      source: "local",
    });
    return { removed: null };
  });
}

/** Bounces are a fact about the address; manual entries are a decision about it. */
const REASON_TONES = {
  hard_bounce: "danger",
  soft_bounce: "warning",
  complaint: "danger",
  manual: "neutral",
} as const;

export default function Suppressions({ loaderData }: Route.ComponentProps) {
  const { entries, maySuppress, mayRemove } = loaderData;
  const ban = useRef<AnimatedIconHandle>(null);

  return (
    <>
      <PageHeader title="Suppressions" description="Addresses we refuse to mail." />

      <Note>
        Cloudflare adds hard bounces to its own account-level list automatically and we mirror
        it, so <Mono>SendPolicy</Mono> can refuse before the API call — which keeps the attempt
        off the sending reputation and off the bill.
      </Note>

      {maySuppress && (
        <Card className="mt-5 mb-5">
          <CardContent>
            <Form method="post" className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-56 flex-1 flex-col gap-2">
                <Label htmlFor="address">Address</Label>
                <Input
                  id="address"
                  name="address"
                  type="email"
                  placeholder="someone@example.com"
                  required
                  className="font-mono"
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="reason">Reason</Label>
                <select
                  id="reason"
                  name="reason"
                  className="h-9 rounded-control border border-border bg-input/30 px-3 text-sm text-body outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <option value="manual">manual</option>
                  <option value="complaint">complaint</option>
                  <option value="hard_bounce">hard bounce</option>
                  <option value="soft_bounce">soft bounce</option>
                </select>
              </div>

              <Button
                type="submit"
                onMouseEnter={() => ban.current?.startAnimation()}
                onMouseLeave={() => ban.current?.stopAnimation()}
              >
                <BanIcon ref={ban} size={16} />
                Suppress
              </Button>
            </Form>
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden py-0">
        {entries.length === 0 ? (
          <Empty>Nothing suppressed. That is the good state.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Address</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Since</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.address}>
                  <TableCell className="max-w-0 truncate font-mono text-[13px] text-title">
                    {entry.address}
                  </TableCell>
                  <TableCell>
                    <Tag tone={REASON_TONES[entry.reason] ?? "neutral"}>
                      {entry.reason.replaceAll("_", " ")}
                    </Tag>
                  </TableCell>
                  <TableCell className="text-secondary-text">{entry.source}</TableCell>
                  <TableCell>
                    <When value={entry.createdAt} />
                  </TableCell>
                  <TableCell className="text-right">
                    {mayRemove && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove" />
                        <input type="hidden" name="address" value={entry.address} />
                        <Button type="submit" variant="outline" size="sm">
                          Remove
                        </Button>
                      </Form>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <Note>
        Removing an entry is deliberately allowed, even for a hard bounce: an address can be
        fixed, and a suppression list with no way out becomes a list of people you have
        permanently stopped talking to. It needs <Mono>admin</Mono> because doing it wrongly
        damages sending reputation for everyone on the deployment.
      </Note>
    </>
  );
}
