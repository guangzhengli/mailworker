import { can, page } from "@web/app/auth";
import { type AnimatedIconHandle, PlusIcon } from "@web/app/components/icons";
import { Button } from "@web/app/components/ui/button";
import { Card, CardContent } from "@web/app/components/ui/card";
import { Checkbox } from "@web/app/components/ui/checkbox";
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
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import { Empty, Mono, Note, PageHeader, Tag, When } from "@web/app/ui";
import { useEffect, useRef } from "react";
import { Form } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/identities";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "identities.pageTitle") },
];

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    /**
     * `listIdentities` is `admin`-only, so a narrower credential gets the page
     * with an explanation rather than an error boundary. The page still exists
     * because "you cannot see this, and here is why" is more useful than a dead
     * link in the sidebar.
     */
    if (!can(caller, "admin")) {
      return { identities: null, isAdmin: false as const };
    }

    return {
      identities: await services.identity.listIdentities(caller),
      isAdmin: true as const,
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();

    const quota = Number(form.get("quota") ?? "");
    const allowlist = String(form.get("allowlist") ?? "")
      .split(",")
      .map((glob) => glob.trim())
      .filter((glob) => glob !== "");

    const identity = await services.identity.createIdentity(caller, {
      name: String(form.get("name") ?? "").trim(),
      ...(Number.isFinite(quota) && quota > 0 ? { dailySendQuota: quota } : {}),
      ...(allowlist.length > 0 ? { recipientAllowlist: allowlist } : {}),
      requireApproval: form.get("requireApproval") === "on",
    });

    return { created: identity.name };
  });
}

export default function Identities({ loaderData, actionData }: Route.ComponentProps) {
  const plus = useRef<AnimatedIconHandle>(null);
  const created = actionData?.created;
  const { t, rich } = useT();

  useEffect(() => {
    if (created !== undefined) {
      toast.success(t("identities.created", { name: created }), {
        description: t("identities.createdHint"),
      });
    }
  }, [created, t]);

  if (!loaderData.isAdmin) {
    return (
      <>
        <PageHeader title={t("identities.title")} />
        <Card>
          <CardContent className="text-sm text-secondary-text">
            {rich("identities.adminOnly", { admin: <Mono>admin</Mono> })}
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t("identities.title")} description={t("identities.description")} />

      <Note>{t("identities.note")}</Note>

      <Card className="mt-5 mb-5">
        <CardContent>
          <Form method="post" className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-40 flex-col gap-2">
              <Label htmlFor="name">{t("field.name")}</Label>
              <Input
                id="name"
                name="name"
                placeholder="support-bot"
                required
                pattern="[a-z0-9][a-z0-9_-]*"
                className="font-mono"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="quota">{t("field.dailyQuota")}</Label>
              <Input
                id="quota"
                name="quota"
                type="number"
                min={1}
                placeholder={t("identities.accountLimit")}
                className="w-36 tabular-nums"
              />
            </div>

            <div className="flex min-w-56 flex-1 flex-col gap-2">
              <Label htmlFor="allowlist">{t("identities.allowlistLabel")}</Label>
              <Input
                id="allowlist"
                name="allowlist"
                placeholder="*@customer.example.com, ops@…"
                className="font-mono"
              />
            </div>

            <Label className="flex h-9 cursor-pointer items-center gap-2 font-normal">
              <Checkbox name="requireApproval" />
              {t("identities.requireApproval")}
            </Label>

            <Button
              type="submit"
              onMouseEnter={() => plus.current?.startAnimation()}
              onMouseLeave={() => plus.current?.stopAnimation()}
            >
              <PlusIcon ref={plus} size={16} />
              {t("identities.create")}
            </Button>
          </Form>
        </CardContent>
      </Card>

      <Card className="overflow-hidden py-0">
        {loaderData.identities.length === 0 ? (
          <Empty>{t("identities.empty")}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("field.name")}</TableHead>
                <TableHead className="text-right">{t("field.dailyQuota")}</TableHead>
                <TableHead>{t("field.recipients")}</TableHead>
                <TableHead>{t("field.approval")}</TableHead>
                <TableHead>{t("field.created")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loaderData.identities.map((identity) => (
                <TableRow key={identity.id}>
                  <TableCell className="font-mono text-[13px] text-title">
                    {identity.name}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {identity.dailySendQuota ?? (
                      <span className="text-hint tabular-nums">
                        {t("identities.accountLimit")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-0 truncate">
                    {identity.recipientAllowlist === null ? (
                      <span className="text-hint">{t("identities.anyone")}</span>
                    ) : identity.recipientAllowlist.length === 0 ? (
                      /* An empty allowlist is not "no restriction" — it permits
                         nobody, and reading it as the former is how an identity
                         gets shipped that can never send. */
                      <Tag tone="warning">{t("identities.nobody")}</Tag>
                    ) : (
                      <span className="font-mono text-[13px]">
                        {identity.recipientAllowlist.join(", ")}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {identity.requireApproval ? (
                      <Tag tone="warning">{t("identities.approvalRequired")}</Tag>
                    ) : (
                      <span className="text-hint">{t("common.dash")}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <When value={identity.createdAt} />
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
