import { ALL_SCOPES, Scope, Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { type AnimatedIconHandle, CopyIcon, PlusIcon } from "@web/app/components/icons";
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
import { CodeBlock, Empty, Mono, Note, PageHeader, Tag, When } from "@web/app/ui";
import { useRef, useState } from "react";
import { Form } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/keys";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "keys.pageTitle") },
];

/** The set an agent should normally get. `message:approve` is never in it. */
const AGENT_DEFAULTS = new Set<string>(["inbox:write", "message:read", "message:send"]);

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    if (!can(caller, "admin")) return { keys: null, identities: null, isAdmin: false as const };

    return {
      keys: await services.identity.listKeys(caller),
      identities: await services.identity.listIdentities(caller),
      isAdmin: true as const,
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();

    if (form.get("intent") === "revoke") {
      await services.identity.revokeKey(caller, Ulid.parse(String(form.get("id"))));
      return { token: null, name: null };
    }

    const identityName = String(form.get("identityName") ?? "").trim();
    const minted = await services.identity.createKey(caller, {
      name: String(form.get("name") ?? "").trim(),
      scopes: Scope.parseList(form.getAll("scopes").map(String)),
      ...(identityName === "" ? {} : { identityName }),
    });

    /**
     * The plaintext, returned to the page exactly once and never stored anywhere
     * that could give it back. It is in the action's result, not in a loader, so
     * a reload of this page does not reproduce it — which is the browser-side
     * version of the same rule `mailworker keys create` follows.
     */
    return { token: minted.token, name: minted.key.name };
  });
}

/**
 * The plaintext key, shown once, in the way that makes copying it the easy path.
 *
 * A modal rather than a banner because this is the only moment the secret
 * exists: a banner scrolls off, and the reader who scrolls past it has lost the
 * key for good. Dismissing it is deliberate — you have to say you are done.
 */
function MintedKey({ token, name }: { token: string; name: string }) {
  const [open, setOpen] = useState(true);
  const icon = useRef<AnimatedIconHandle>(null);
  const { t } = useT();

  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      toast.success(t("keys.copied"));
    } catch {
      // Clipboard access is refused on insecure origins and by some policies.
      // The field is selectable, so say that rather than failing silently.
      toast.error(t("keys.copyFailed"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>{t("keys.mintedDescription")}</DialogDescription>
        </DialogHeader>
        <CodeBlock variant="boxed">{token}</CodeBlock>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t("keys.done")}
          </Button>
          <Button
            onClick={copy}
            onMouseEnter={() => icon.current?.startAnimation()}
            onMouseLeave={() => icon.current?.stopAnimation()}
          >
            <CopyIcon ref={icon} size={16} />
            {t("keys.copy")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Keys({ loaderData, actionData }: Route.ComponentProps) {
  const plus = useRef<AnimatedIconHandle>(null);
  const { t, rich } = useT();

  if (!loaderData.isAdmin) {
    return (
      <>
        <PageHeader title={t("keys.title")} />
        <Card>
          <CardContent className="text-sm text-secondary-text">
            {rich("keys.adminOnly", { admin: <Mono>admin</Mono> })}
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t("keys.title")} description={t("keys.description")} />

      {actionData?.token != null && actionData.name != null && (
        /* Keyed on the token so a second mint remounts the dialog rather than
           reusing the first one's dismissed state. */
        <MintedKey key={actionData.token} token={actionData.token} name={actionData.name} />
      )}

      <Card className="mb-5">
        <CardContent>
          <Form method="post" className="flex flex-col gap-5">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex min-w-44 flex-1 flex-col gap-2">
                <Label htmlFor="name">{t("keys.nameLabel")}</Label>
                <Input id="name" name="name" placeholder="support-bot" required />
              </div>

              <div className="flex min-w-52 flex-col gap-2">
                <Label htmlFor="identityName">{t("keys.identityLabel")}</Label>
                {/* The empty value is a real choice, not a placeholder — a key
                    with no identity sends under the account default — so it is
                    an item in the list with its own label rather than the
                    trigger's empty state. */}
                <Select
                  name="identityName"
                  defaultValue=""
                  items={{
                    "": t("keys.noIdentity"),
                    ...Object.fromEntries(
                      loaderData.identities.map((identity) => [identity.name, identity.name]),
                    ),
                  }}
                >
                  <SelectTrigger id="identityName" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">{t("keys.noIdentity")}</SelectItem>
                    {loaderData.identities.map((identity) => (
                      <SelectItem key={identity.id} value={identity.name}>
                        {identity.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                type="submit"
                onMouseEnter={() => plus.current?.startAnimation()}
                onMouseLeave={() => plus.current?.stopAnimation()}
              >
                <PlusIcon ref={plus} size={16} />
                {t("keys.create")}
              </Button>
            </div>

            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-xs font-medium tracking-wider text-hint uppercase">
                {t("field.scopes")}
              </legend>
              <div className="flex flex-wrap gap-x-5 gap-y-3">
                {ALL_SCOPES.map((scope) => (
                  <Label
                    key={scope}
                    className="flex cursor-pointer items-center gap-2 font-normal"
                  >
                    <Checkbox
                      name="scopes"
                      value={scope}
                      defaultChecked={AGENT_DEFAULTS.has(scope)}
                    />
                    <Mono>{scope}</Mono>
                  </Label>
                ))}
              </div>
            </fieldset>

            <Note>
              {rich("keys.scopesNote", {
                approve: <Mono>message:approve</Mono>,
                admin: <Mono>admin</Mono>,
              })}
            </Note>
          </Form>
        </CardContent>
      </Card>

      <Card className="overflow-hidden py-0">
        {loaderData.keys.length === 0 ? (
          <Empty>{t("keys.empty")}</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("field.name")}</TableHead>
                <TableHead>{t("field.prefix")}</TableHead>
                <TableHead>{t("field.scopes")}</TableHead>
                <TableHead>{t("field.lastUsed")}</TableHead>
                <TableHead>{t("field.state")}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loaderData.keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-medium text-title">{key.name}</TableCell>
                  <TableCell className="font-mono text-[13px]">{key.prefix}</TableCell>
                  <TableCell className="max-w-0 truncate font-mono text-xs text-secondary-text">
                    {key.scopes.join(" ")}
                  </TableCell>
                  <TableCell>
                    <When value={key.lastUsedAt} />
                  </TableCell>
                  <TableCell>
                    <Tag tone={key.revokedAt !== null ? "danger" : "success"}>
                      {key.revokedAt !== null ? t("keys.revoked") : t("keys.active")}
                    </Tag>
                  </TableCell>
                  <TableCell className="text-right">
                    {key.revokedAt === null && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="revoke" />
                        <input type="hidden" name="id" value={key.id} />
                        <Button type="submit" variant="outline" size="sm">
                          {t("keys.revoke")}
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

      <Note>{t("keys.revokedNote")}</Note>
    </>
  );
}
