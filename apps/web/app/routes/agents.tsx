import type { Scope } from "@mailworker/core";
import { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { type AnimatedIconHandle, PlusIcon } from "@web/app/components/icons";
import { Button } from "@web/app/components/ui/button";
import { Card, CardContent } from "@web/app/components/ui/card";
import { Checkbox } from "@web/app/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@web/app/components/ui/dialog";
import { Input } from "@web/app/components/ui/input";
import { Label } from "@web/app/components/ui/label";
import { localeFromMatches, translate, useT } from "@web/app/i18n";
import { Callout, Empty, Mono, Note, PageHeader, Tag, When } from "@web/app/ui";
import { useEffect, useRef, useState } from "react";
import { Form, useNavigation } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/agents";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "agents.pageTitle") },
];

/**
 * Agents: an identity and the keys it holds, on one row.
 *
 * These were two pages, which meant the one task anybody performs here — give
 * this agent a credential — required going to one page, remembering a name, and
 * typing it into another. The identity is the business object; a key is a
 * credential it holds in one environment.
 */
const AGENT_SCOPES: readonly Scope[] = [
  "inbox:write",
  "message:read",
  "message:send",
  "inbox:read",
];

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    if (!can(caller, "admin")) {
      return { admin: false as const, agents: [], env: caller.accountId };
    }

    const [identities, keys] = await Promise.all([
      services.identity.listIdentities(caller),
      services.identity.listKeys(caller),
    ]);

    return {
      admin: true as const,
      env: caller.accountId,
      agents: identities.map((identity) => ({
        id: identity.id,
        name: identity.name,
        managed: identity.managed,
        recipientAllowlist: identity.recipientAllowlist,
        dailySendQuota: identity.dailySendQuota,
        requireApproval: identity.requireApproval,
        keys: keys
          .filter((key) => key.identityId === identity.id)
          .map((key) => ({
            id: key.id,
            name: key.name,
            prefix: key.prefix,
            revoked: key.revokedAt !== null,
            lastUsedAt: key.lastUsedAt,
          })),
      })),
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();
    const intent = String(form.get("intent") ?? "");

    if (intent === "revoke") {
      await services.identity.revokeKey(caller, Ulid.parse(String(form.get("keyId"))));
      return { created: null, minted: null };
    }

    if (intent === "key") {
      const identityName = String(form.get("identityName") ?? "");
      const scopes = AGENT_SCOPES.filter((scope) => form.get(`scope:${scope}`) === "on");
      const minted = await services.identity.createKey(caller, {
        name: identityName,
        identityName,
        // `message:read` alone is a key that can do nothing useful; it is also
        // the safe floor if someone unticks everything.
        scopes: scopes.length === 0 ? ["message:read"] : scopes,
      });
      return { created: null, minted: minted.token };
    }

    const allowlist = String(form.get("allowlist") ?? "")
      .split(",")
      .map((glob) => glob.trim())
      .filter((glob) => glob !== "");
    const quota = Number(form.get("quota") ?? 0);

    const identity = await services.identity.createIdentity(caller, {
      name: String(form.get("name") ?? ""),
      ...(allowlist.length === 0 ? {} : { recipientAllowlist: allowlist }),
      ...(Number.isFinite(quota) && quota > 0 ? { dailySendQuota: quota } : {}),
      requireApproval: form.get("requireApproval") === "on",
    });

    return { created: identity.name, minted: null };
  });
}

function MintedKeyDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const { t } = useT();

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("agents.mintedTitle")}</DialogTitle>
          <DialogDescription>{t("agents.mintedDescription")}</DialogDescription>
        </DialogHeader>
        <Mono className="block w-full break-all rounded-control bg-muted px-3 py-2 text-[13px]">
          {token}
        </Mono>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              navigator.clipboard
                .writeText(token)
                .then(() => toast.success(t("agents.copied")))
                .catch(() => toast.error(t("agents.copyFailed")));
            }}
          >
            {t("agents.copy")}
          </Button>
          <Button onClick={onClose}>{t("agents.done")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Agents({ loaderData, actionData }: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const plus = useRef<AnimatedIconHandle>(null);
  const { t } = useT();
  const [dismissed, setDismissed] = useState<string | null>(null);
  const created = actionData?.created ?? null;
  const minted = actionData?.minted ?? null;

  useEffect(() => {
    if (created !== null) toast.success(t("agents.created", { name: created }));
  }, [created, t]);

  if (!loaderData.admin) {
    return (
      <>
        <PageHeader title={t("agents.title")} description={t("agents.description")} />
        <Callout tone="warning">{t("agents.adminOnly")}</Callout>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t("agents.title")} description={t("agents.description")} />

      {minted !== null && minted !== dismissed && (
        <MintedKeyDialog token={minted} onClose={() => setDismissed(minted)} />
      )}

      <Card className="mb-5">
        <CardContent>
          <Form method="post" className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-40 flex-col gap-2">
              <Label htmlFor="name">{t("agents.nameLabel")}</Label>
              <Input id="name" name="name" required placeholder="support-bot" />
            </div>
            <div className="flex min-w-56 flex-1 flex-col gap-2">
              <Label htmlFor="allowlist">{t("agents.allowlistLabel")}</Label>
              <Input
                id="allowlist"
                name="allowlist"
                placeholder={t("agents.allowlistPlaceholder")}
                className="font-mono"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="quota">{t("agents.quotaLabel")}</Label>
              <Input
                id="quota"
                name="quota"
                type="number"
                min={1}
                className="w-28 tabular-nums"
              />
            </div>
            <div className="flex h-9 items-center gap-2 text-sm text-secondary-text">
              <Checkbox id="requireApproval" name="requireApproval" />
              <Label htmlFor="requireApproval" className="font-normal">
                {t("agents.requireApproval")}
              </Label>
            </div>
            <Button
              type="submit"
              disabled={busy}
              onMouseEnter={() => plus.current?.startAnimation()}
              onMouseLeave={() => plus.current?.stopAnimation()}
            >
              <PlusIcon ref={plus} size={16} />
              {t("agents.create")}
            </Button>
          </Form>
        </CardContent>
      </Card>

      {loaderData.agents.length === 0 ? (
        <Card className="overflow-hidden py-0">
          <Empty>{t("agents.empty")}</Empty>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {loaderData.agents.map((agent) => (
            <Card key={agent.id}>
              <CardContent className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-title">{agent.name}</span>
                  {agent.managed && <Tag tone="info">managed</Tag>}
                  {agent.requireApproval && (
                    <Tag tone="warning">{t("agents.approvalRequired")}</Tag>
                  )}
                </div>

                <div className="flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-secondary-text">
                  <span>
                    {t("agents.allowlistLabel")}:{" "}
                    {agent.recipientAllowlist === null
                      ? t("agents.anyone")
                      : agent.recipientAllowlist.length === 0
                        ? t("agents.nobody")
                        : agent.recipientAllowlist.join(", ")}
                  </span>
                  <span>
                    {t("agents.quotaLabel")}:{" "}
                    {agent.dailySendQuota === null
                      ? t("agents.noLimit")
                      : String(agent.dailySendQuota)}
                  </span>
                </div>

                {agent.managed && <Note className="mt-0">{t("agents.managed")}</Note>}

                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  {agent.keys.length === 0 ? (
                    <span className="text-[13px] text-hint">{t("agents.noKeys")}</span>
                  ) : (
                    agent.keys.map((key) => (
                      <div key={key.id} className="flex flex-wrap items-center gap-3">
                        <Mono className="text-[13px]">{key.prefix}</Mono>
                        {key.revoked ? (
                          <>
                            <Tag tone="danger">{t("agents.revoked")}</Tag>
                            <span className="text-[13px] text-hint">
                              {t("agents.revokedNote")}
                            </span>
                          </>
                        ) : (
                          <span className="text-[13px] text-hint">
                            {t("field.lastUsed")}: <When value={key.lastUsedAt} />
                          </span>
                        )}
                        {!key.revoked && (
                          <Form method="post">
                            <input type="hidden" name="intent" value="revoke" />
                            <input type="hidden" name="keyId" value={key.id} />
                            <Button type="submit" variant="ghost" size="xs" disabled={busy}>
                              {t("agents.revoke")}
                            </Button>
                          </Form>
                        )}
                      </div>
                    ))
                  )}

                  {!agent.managed && (
                    <Form method="post" className="flex flex-col gap-2 pt-1">
                      <input type="hidden" name="intent" value="key" />
                      <input type="hidden" name="identityName" value={agent.name} />
                      <div className="flex flex-wrap items-center gap-3">
                        {AGENT_SCOPES.map((scope) => (
                          <div
                            key={scope}
                            className="flex items-center gap-1.5 text-[13px] text-secondary-text"
                          >
                            <Checkbox
                              id={`${agent.id}:${scope}`}
                              name={`scope:${scope}`}
                              defaultChecked
                            />
                            <Label htmlFor={`${agent.id}:${scope}`} className="font-normal">
                              <Mono className="text-[12px]">{scope}</Mono>
                            </Label>
                          </div>
                        ))}
                        <Button type="submit" variant="outline" size="sm" disabled={busy}>
                          {t("agents.newKey")}
                        </Button>
                      </div>
                      {/* Beside the scopes it is about, not at the foot of the
                          page: this is the answer to "why is approval not in
                          this list", and it is only asked here. */}
                      <Note className="mt-0">{t("agents.scopeNote")}</Note>
                    </Form>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
