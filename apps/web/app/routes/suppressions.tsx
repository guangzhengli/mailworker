import type { SuppressionReason } from "@mailworker/core";
import { EmailAddress } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { type AnimatedIconHandle, BanIcon } from "@web/app/components/icons";
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
import { Empty, PageHeader, Tag, When } from "@web/app/ui";
import { useRef } from "react";
import { Form } from "react-router";
import type { Route } from "./+types/suppressions";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "suppressions.pageTitle") },
];

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

/**
 * The reasons the form offers, in the wire vocabulary — so that what you pick
 * here reads the same as what the table below and the API report back. The
 * underscore is the only thing softened, and the table softens it the same way.
 */
const REASONS = ["manual", "complaint", "hard_bounce", "soft_bounce"] as const;

const REASON_LABELS: Record<string, string> = Object.fromEntries(
  REASONS.map((reason) => [reason, reason.replaceAll("_", " ")]),
);

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
  const { t } = useT();

  return (
    <>
      <PageHeader title={t("suppressions.title")} description={t("suppressions.description")} />

      {maySuppress && (
        <Card className="mb-5">
          <CardContent>
            <Form method="post" className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-56 flex-1 flex-col gap-2">
                <Label htmlFor="address">{t("field.address")}</Label>
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
                <Label htmlFor="reason">{t("field.reason")}</Label>
                <Select name="reason" defaultValue="manual" items={REASON_LABELS}>
                  <SelectTrigger id="reason" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REASONS.map((reason) => (
                      <SelectItem key={reason} value={reason}>
                        {REASON_LABELS[reason]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                type="submit"
                onMouseEnter={() => ban.current?.startAnimation()}
                onMouseLeave={() => ban.current?.stopAnimation()}
              >
                <BanIcon ref={ban} size={16} />
                {t("suppressions.suppress")}
              </Button>
            </Form>
          </CardContent>
        </Card>
      )}

      <Card className="overflow-hidden py-0">
        {entries.length === 0 ? (
          <Empty>{t("suppressions.empty")}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("field.address")}</TableHead>
                <TableHead>{t("field.reason")}</TableHead>
                <TableHead>{t("field.source")}</TableHead>
                <TableHead>{t("field.since")}</TableHead>
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
                          {t("suppressions.remove")}
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
    </>
  );
}
