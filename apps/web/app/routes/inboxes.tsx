import { isDomainError, Ulid } from "@mailworker/core";
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
import { Checkbox } from "@web/app/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { mailHref } from "@web/app/mail";
import {
  Empty,
  FilterTab,
  FilterTabs,
  ListCard,
  Mono,
  PageHeader,
  Pager,
  Relative,
  Tag,
  TextLink,
  When,
} from "@web/app/ui";
import { BellIcon, BellOffIcon, MailboxIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, Link, useFetcher, useNavigation } from "react-router";
import { toast } from "sonner";
import type { Route } from "./+types/inboxes";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "inboxes.pageTitle") },
];

export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const url = new URL(request.url);
    const cursor = url.searchParams.get("cursor");

    const rawKind = url.searchParams.get("kind");
    const kind: "persistent" | "ephemeral" | null =
      rawKind === "persistent" || rawKind === "ephemeral" ? rawKind : null;
    const muted = kind === "persistent" && url.searchParams.get("muted") === "1";

    const page = await services.mailbox.listInboxes(caller, {
      includeExpired: url.searchParams.get("expired") === "1",
      ...(kind === null ? {} : { kind }),
      ...(muted ? { muted } : {}),
      ...(cursor === null ? {} : { cursor: Ulid.parse(cursor) }),
    });

    return {
      inboxes: page.items,
      cursor: page.cursor,
      kind,
      muted,
      includeExpired: url.searchParams.get("expired") === "1",
      mayCreate: can(caller, "inbox:write"),
      domains: await services.mailbox.listDomains(caller),
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();

    if (form.get("intent") === "delete") {
      await services.mailbox.deleteInbox(caller, Ulid.parse(String(form.get("id"))));
      return { created: null, taken: null };
    }

    if (form.get("intent") === "mute") {
      await services.mailbox.updateInbox(caller, Ulid.parse(String(form.get("id"))), {
        muted: form.get("muted") === "1",
      });
      return { created: null, taken: null };
    }

    const ttlMinutes = Number(form.get("ttlMinutes") ?? 0);
    const persistent = form.get("kind") === "persistent";
    const domain = String(form.get("domain") ?? "").trim();
    const name = String(form.get("localPart") ?? "")
      .trim()
      .toLowerCase();

    const naming =
      name === "" ? {} : form.get("random") === null ? { localPart: name } : { prefix: name };

    try {
      const inbox = await services.mailbox.createInbox(caller, {
        kind: persistent ? "persistent" : "ephemeral",
        muted: form.get("watched") === null,
        ...naming,
        ...(domain === "" ? {} : { domain }),
        ...(persistent || !Number.isFinite(ttlMinutes) || ttlMinutes <= 0
          ? {}
          : { ttlMs: ttlMinutes * 60_000 }),
      });

      return { created: inbox.address, taken: null };
    } catch (error) {
      // Reported beside the field rather than on the error boundary, which would
      // replace the page and lose what was typed.
      if (isDomainError(error) && error.code === "address_taken") {
        return { created: null, taken: String(error.details["address"] ?? name) };
      }
      throw error;
    }
  });
}

/**
 * Creating an address, in a dialog.
 *
 * It used to be a seven-control form pinned above the table, on a page whose
 * usual reason for being open is to look something up. A form that is only
 * needed occasionally but is always on screen pushes the content down the page
 * every single visit, which is the trade the wrong way round.
 */
function NewInbox({
  domains,
  taken,
  created,
  busy,
}: {
  domains: readonly string[];
  taken: string | null;
  created: string | null;
  busy: boolean;
}) {
  const plus = useRef<AnimatedIconHandle>(null);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"persistent" | "ephemeral">("persistent");
  const [watched, setWatched] = useState(true);

  useEffect(() => {
    if (created === null) return;
    setOpen(false);
    setKind("persistent");
    setWatched(true);
  }, [created]);
  const { t } = useT();

  // Reopened by the failed submission itself, so the address that was rejected
  // is still in the field with the error beside it.
  useEffect(() => {
    if (taken !== null) setOpen(true);
  }, [taken]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            size="sm"
            onMouseEnter={() => plus.current?.startAnimation()}
            onMouseLeave={() => plus.current?.stopAnimation()}
          />
        }
      >
        <PlusIcon ref={plus} size={16} />
        {t("inboxes.create")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("inboxes.create")}</DialogTitle>
          <DialogDescription>{t("inboxes.createHint")}</DialogDescription>
        </DialogHeader>

        <Form method="post" className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="localPart">{t("inboxes.nameLabel")}</Label>
            <div className="flex items-center gap-1.5">
              <Input
                id="localPart"
                name="localPart"
                placeholder={t("inboxes.namePlaceholder")}
                className="font-mono"
                aria-describedby={taken === null ? undefined : "localPart-error"}
              />
              {domains.length > 1 ? (
                <Select
                  name="domain"
                  defaultValue={domains[0]}
                  items={Object.fromEntries(domains.map((domain) => [domain, `@${domain}`]))}
                >
                  <SelectTrigger id="domain" className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {domains.map((domain) => (
                      <SelectItem key={domain} value={domain}>
                        @{domain}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Mono className="shrink-0 text-hint">@{domains[0] ?? ""}</Mono>
              )}
            </div>
            {taken !== null && (
              <p id="localPart-error" role="alert" className="text-danger text-xs">
                {t("inboxes.taken", { address: taken })}
              </p>
            )}
            <div className="mt-1 flex items-center gap-2">
              <Checkbox id="random" name="random" />
              <Label htmlFor="random" className="font-normal text-hint">
                {t("inboxes.randomSuffix")}
              </Label>
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
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
                value={kind}
                onValueChange={(value) => {
                  const next = value === "ephemeral" ? "ephemeral" : "persistent";
                  setKind(next);
                  setWatched(next === "persistent");
                }}
                items={{
                  ephemeral: t("inboxes.kindEphemeral"),
                  persistent: t("inboxes.kindPersistent"),
                }}
              >
                <SelectTrigger id="kind" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ephemeral">{t("inboxes.kindEphemeral")}</SelectItem>
                  <SelectItem value="persistent">{t("inboxes.kindPersistent")}</SelectItem>
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
                disabled={kind === "persistent"}
                className="w-28 tabular-nums"
              />
            </div>
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="watched"
              name="watched"
              checked={watched}
              onCheckedChange={(checked) => setWatched(checked === true)}
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="watched">{t("inboxes.watchedLabel")}</Label>
              <span className="text-xs text-hint">{t("inboxes.watchedHint")}</span>
            </div>
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button type="submit" disabled={busy}>
              {t("inboxes.create")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
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
  const taken = actionData?.taken ?? null;
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
        {loaderData.mayCreate && (
          <NewInbox domains={loaderData.domains} taken={taken} created={created} busy={busy} />
        )}
      </PageHeader>

      <div className="flex flex-wrap items-start justify-between gap-x-4">
        <FilterTabs>
          {(
            [
              [null, false, "inboxes.kindAll"],
              ["persistent", false, "inboxes.kindPersistent"],
              ["persistent", true, "inboxes.kindMuted"],
              ["ephemeral", false, "inboxes.kindEphemeral"],
            ] as const
          ).map(([kind, muted, label]) => (
            <FilterTab
              key={label}
              to={inboxesHref({ kind, muted, expired: loaderData.includeExpired })}
              active={loaderData.kind === kind && loaderData.muted === muted}
            >
              {t(label)}
            </FilterTab>
          ))}
        </FilterTabs>
        <Button
          render={
            <Link
              to={inboxesHref({
                kind: loaderData.kind,
                muted: loaderData.muted,
                expired: !loaderData.includeExpired,
              })}
            />
          }
          variant="ghost"
          size="sm"
        >
          {loaderData.includeExpired ? t("inboxes.hideExpired") : t("inboxes.showExpired")}
        </Button>
      </div>

      <ListCard>
        {loaderData.inboxes.length === 0 ? (
          <Empty icon={<MailboxIcon />}>
            {rich("inboxes.empty", { command: <Mono>mailworker inbox create</Mono> })}
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("field.address")}</TableHead>
                <TableHead className="w-32">{t("field.kind")}</TableHead>
                <TableHead className="w-36">{t("inboxes.inInbox")}</TableHead>
                <TableHead className="w-40">{t("field.expires")}</TableHead>
                <TableHead className="w-44">{t("field.created")}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {loaderData.inboxes.map((inbox) => (
                <TableRow key={inbox.id}>
                  {/* The address links to its mail, not to a page about itself.
                      An address has no detail worth a page — what someone wants
                      after finding the row is to read what came to it. */}
                  <TableCell className="max-w-0 truncate">
                    <TextLink
                      render={<Link to={mailHref({ view: "all", inbox: inbox.id })} />}
                      variant="quiet"
                      className="font-mono text-[13px]"
                    >
                      {inbox.address}
                    </TextLink>
                  </TableCell>
                  <TableCell>
                    <Tag tone={inbox.kind === "persistent" ? "info" : "neutral"}>
                      {inbox.kind === "persistent"
                        ? t("inboxes.kindPersistent")
                        : t("inboxes.kindEphemeral")}
                    </Tag>
                  </TableCell>
                  <TableCell>
                    <MuteToggle
                      id={inbox.id}
                      muted={inbox.muted}
                      editable={loaderData.mayCreate}
                      busy={busy}
                    />
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
      </ListCard>

      {loaderData.cursor !== null && (
        <Pager
          to={inboxesHref({
            kind: loaderData.kind,
            muted: loaderData.muted,
            expired: loaderData.includeExpired,
            cursor: loaderData.cursor,
          })}
        />
      )}
    </>
  );
}

function inboxesHref({
  kind,
  muted = false,
  expired,
  cursor,
}: {
  kind: "persistent" | "ephemeral" | null;
  muted?: boolean;
  expired: boolean;
  cursor?: string | null;
}): string {
  const params = new URLSearchParams();
  if (kind !== null) params.set("kind", kind);
  if (muted) params.set("muted", "1");
  if (expired) params.set("expired", "1");
  if (cursor !== undefined && cursor !== null) params.set("cursor", cursor);
  const query = params.toString();
  return query === "" ? "/inboxes" : `/inboxes?${query}`;
}

function MuteToggle({
  id,
  muted,
  editable,
  busy,
}: {
  id: string;
  muted: boolean;
  editable: boolean;
  busy: boolean;
}) {
  const { t } = useT();
  const fetcher = useFetcher();
  const pending = fetcher.formData?.get("muted");
  const shown = pending === undefined || pending === null ? muted : pending === "1";
  const label = shown ? t("inboxes.muted") : t("inboxes.watched");
  if (!editable) {
    return <span className="text-[13px] text-secondary-text">{label}</span>;
  }
  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="mute" />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="muted" value={shown ? "0" : "1"} />
      <Button
        type="submit"
        variant="ghost"
        size="xs"
        disabled={busy || fetcher.state !== "idle"}
        title={shown ? t("mail.unmuteHint") : t("mail.muteHint")}
        className={shown ? "text-hint" : "text-body"}
      >
        {shown ? <BellOffIcon /> : <BellIcon />}
        {label}
      </Button>
    </fetcher.Form>
  );
}
