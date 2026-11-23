import type { Ulid } from "@mailworker/core";
import { can, page } from "@web/app/auth";
import { ComposeProvider, useCompose } from "@web/app/components/compose-panel";
import {
  type AnimatedIconHandle,
  ApprovalsIcon,
  FingerprintIcon,
  LogoutIcon,
  MailboxIcon,
  MenuIcon,
  OverviewIcon,
  SendIcon,
  SettingsGearIcon,
} from "@web/app/components/icons";
import { Button } from "@web/app/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@web/app/components/ui/dropdown-menu";
import { Separator } from "@web/app/components/ui/separator";
import { TooltipProvider } from "@web/app/components/ui/tooltip";
import { statusesIn } from "@web/app/deliveries";
import { type MessageKey, useT } from "@web/app/i18n";
import { cn } from "@web/app/lib/utils";
import { folderOf, labelTone, mailHref, readFilters } from "@web/app/mail";
import { Tag } from "@web/app/ui";
import type { MailCounts } from "@web/workers/adapters";
import {
  AtSignIcon,
  BellOffIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  InboxIcon,
  LayersIcon,
  MailWarningIcon,
  PenLineIcon,
  PlusIcon,
  StarIcon,
  TimerIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, Link, Outlet, useLocation, useSearchParams } from "react-router";
import type { Route } from "./+types/shell";

/** The layout every real page sits inside, and the single place authentication is checked. */
export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services, container }) => {
    const admin = caller.scopes.includes("admin");
    const now = new Date();

    // Each block only when the session may read it: a narrow key must still be
    // able to open the pages its scopes allow.
    const readsMail = can(caller, "message:read");
    const readsInboxes = can(caller, "inbox:read");
    // Muted addresses fold into one entry, so the sidebar only lists what a
    // person reads; paging keeps them from crowding out the rest.
    const watchedAddresses = async () => {
      const items = [];
      let cursor: Ulid | null = null;
      do {
        const page = await services.mailbox.listInboxes(caller, {
          kind: "persistent",
          muted: false,
          limit: 100,
          ...(cursor === null ? {} : { cursor }),
        });
        items.push(...page.items);
        cursor = page.cursor;
      } while (cursor !== null && items.length < 500);
      return items;
    };
    const [environments, counts, labels, addresses] = await Promise.all([
      // A credential bound to one environment cannot list the others.
      admin ? services.identity.listEnvironments(caller) : Promise.resolve([]),
      readsMail
        ? container.dashboard.mailCounts(caller, now, statusesIn("problem"))
        : Promise.resolve(NO_COUNTS),
      readsMail ? services.mailbox.listLabels(caller) : Promise.resolve([]),
      readsInboxes ? watchedAddresses() : Promise.resolve([]),
    ]);

    return {
      accountId: caller.accountId,
      mode: caller.mode,
      environments: environments.map((environment) => ({
        id: environment.id,
        env: environment.env,
        name: environment.name,
        mode: environment.mode,
      })),
      admin,
      mayApprove:
        caller.identityId === null &&
        (caller.scopes.includes("admin") || caller.scopes.includes("message:approve")),
      counts,
      labels: labels.map((label) => ({
        id: label.id,
        name: label.name,
        unread: label.unreadCount,
        total: label.messageCount,
        lastUsedAt: label.lastUsedAt,
      })),
      addresses: [...addresses]
        .sort(
          (left, right) =>
            left.domain.localeCompare(right.domain) ||
            left.address.localeCompare(right.address),
        )
        .map((inbox) => ({
          id: inbox.id,
          address: inbox.address,
          localPart: inbox.localPart,
          domain: inbox.domain,
          displayName: inbox.displayName,
        })),
    };
  });
}

const NO_COUNTS: MailCounts = {
  inboxUnread: 0,
  unreadByInbox: {},
  activeEphemeralInboxes: 0,
  mutedPersistentInboxes: 0,
  pendingApproval: 0,
  problems: 0,
};

export type ShellData = Route.ComponentProps["loaderData"];

type IconComponent = React.ComponentType<
  { size?: number; className?: string } & React.RefAttributes<AnimatedIconHandle>
>;

type NavKey = Extract<MessageKey, `nav.${string}`>;

const CONSOLE_PREFIXES = ["/status", "/sent", "/inboxes", "/agents", "/settings"] as const;

function isConsolePath(pathname: string): boolean {
  return CONSOLE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

const LABELS_SHOWN = 8;

function SideLink({
  to,
  active,
  label,
  Icon,
  count,
  tone,
  title,
  onNavigate,
}: {
  to: string;
  active: boolean;
  label: React.ReactNode;
  Icon?: IconComponent | React.ComponentType<{ className?: string }>;
  count?: number;
  tone?: "warning" | "danger";
  title?: string;
  onNavigate?: (() => void) | undefined;
}) {
  const icon = useRef<AnimatedIconHandle>(null);

  return (
    <Link
      to={to}
      title={title}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      onMouseEnter={() => icon.current?.startAnimation?.()}
      onMouseLeave={() => icon.current?.stopAnimation?.()}
      className={cn(
        "flex h-8 items-center gap-2.5 rounded-control px-3 text-sm transition-colors",
        active
          ? "bg-selected font-medium text-title"
          : "text-secondary-text hover:bg-hover hover:text-title",
      )}
    >
      {Icon !== undefined && (
        <Icon
          {...({ ref: icon, size: 16 } as Record<string, unknown>)}
          className="size-4 shrink-0"
        />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            "shrink-0 text-xs tabular-nums",
            tone === "danger"
              ? "font-medium text-danger"
              : tone === "warning"
                ? "font-medium text-warning"
                : active
                  ? "font-semibold text-title"
                  : "font-medium text-secondary-text",
          )}
        >
          {count > 999 ? "999+" : count}
        </span>
      )}
    </Link>
  );
}

function Group({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5 pt-4">
      <div className="flex items-center justify-between px-3 pb-1">
        <span className="text-[11px] font-medium tracking-wider text-hint uppercase">
          {title}
        </span>
        {action}
      </div>
      {children}
    </div>
  );
}

function ModeSwitch({
  console: inConsole,
  onNavigate,
}: {
  console: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  const { t } = useT();
  const item = (active: boolean) =>
    cn(
      "flex h-7 flex-1 items-center justify-center rounded-[calc(var(--radius-control)-2px)] text-[13px] transition-colors",
      active
        ? "bg-card font-medium text-title shadow-xs ring-1 ring-foreground/10 dark:bg-popover"
        : "text-secondary-text hover:text-title",
    );
  return (
    <nav aria-label={t("shell.mode")} className="flex gap-0.5 rounded-control bg-muted p-0.5">
      <Link
        to="/mail"
        className={item(!inConsole)}
        aria-current={!inConsole ? "page" : undefined}
        onClick={onNavigate}
      >
        {t("shell.modeMail")}
      </Link>
      <Link
        to="/status"
        className={item(inConsole)}
        aria-current={inConsole ? "page" : undefined}
        onClick={onNavigate}
      >
        {t("shell.modeConsole")}
      </Link>
    </nav>
  );
}

function MailNav({
  data,
  onNavigate,
}: {
  data: ShellData;
  onNavigate?: (() => void) | undefined;
}) {
  const { t } = useT();
  const location = useLocation();
  const [search] = useSearchParams();
  const compose = useCompose();
  const [allLabels, setAllLabels] = useState(false);

  const onMail = location.pathname === "/mail" || location.pathname.startsWith("/mail/");
  const filters = readFilters(search);
  const folder = onMail ? folderOf(filters) : null;
  const domains = new Set(data.addresses.map((address) => address.domain));
  const labels = allLabels ? data.labels : data.labels.slice(0, LABELS_SHOWN);

  return (
    <>
      {compose.available && (
        <Button
          className="mt-3 w-full justify-start gap-2"
          onClick={() => {
            compose.open();
            onNavigate?.();
          }}
        >
          <PenLineIcon />
          {t("shell.compose")}
        </Button>
      )}

      <nav aria-label={t("shell.folders")} className="flex flex-col gap-0.5 pt-3">
        <SideLink
          to="/mail"
          active={folder === "inbox"}
          label={t("mail.view.inbox")}
          Icon={MailboxIcon}
          count={data.counts.inboxUnread}
          onNavigate={onNavigate}
        />
        <SideLink
          to={mailHref({ view: "starred" })}
          active={folder === "starred"}
          label={t("mail.view.starred")}
          Icon={StarIcon}
          onNavigate={onNavigate}
        />
        <SideLink
          to={mailHref({ view: "sent" })}
          active={folder === "sent"}
          label={t("mail.view.sent")}
          Icon={SendIcon}
          onNavigate={onNavigate}
        />
        <SideLink
          to={mailHref({ view: "all" })}
          active={folder === "all"}
          label={t("mail.view.all")}
          Icon={LayersIcon}
          onNavigate={onNavigate}
        />
        {data.mayApprove &&
          (data.counts.pendingApproval > 0 || location.pathname === "/approvals") && (
            <SideLink
              to="/approvals"
              active={location.pathname === "/approvals"}
              label={t("nav.approvals")}
              Icon={ApprovalsIcon}
              count={data.counts.pendingApproval}
              tone="warning"
              onNavigate={onNavigate}
            />
          )}
        {data.counts.problems > 0 && (
          <SideLink
            to="/sent?bucket=problem"
            active={false}
            label={t("shell.failed")}
            Icon={MailWarningIcon}
            count={data.counts.problems}
            tone="danger"
            onNavigate={onNavigate}
          />
        )}
      </nav>

      {data.labels.length > 0 && (
        <Group title={t("shell.labels")}>
          {labels.map((label) => (
            <SideLink
              key={label.id}
              to={mailHref({ view: "all", label: label.name })}
              active={onMail && filters.label?.toLowerCase() === label.name.toLowerCase()}
              label={
                <span className="flex items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className={cn("size-2 shrink-0 rounded-full", labelTone(label.name))}
                  />
                  <span className="truncate">{label.name}</span>
                </span>
              }
              count={label.unread}
              onNavigate={onNavigate}
            />
          ))}
          {data.labels.length > LABELS_SHOWN && (
            <button
              type="button"
              onClick={() => setAllLabels((open) => !open)}
              className="h-7 rounded-control px-3 text-left text-[13px] text-hint hover:text-title"
            >
              {allLabels
                ? t("shell.fewerLabels")
                : t("shell.moreLabels", { count: data.labels.length - LABELS_SHOWN })}
            </button>
          )}
        </Group>
      )}

      <Group
        title={t("shell.addresses")}
        action={
          <Link
            to="/inboxes"
            onClick={onNavigate}
            aria-label={t("shell.newAddress")}
            title={t("shell.newAddress")}
            className="rounded-sm text-hint hover:text-title"
          >
            <PlusIcon className="size-3.5" />
          </Link>
        }
      >
        {[...domains].map((domain) => (
          <div key={domain} className="flex flex-col gap-0.5">
            {domains.size > 1 && (
              <div className="truncate px-3 pt-1.5 text-[11px] text-hint" title={domain}>
                @{domain}
              </div>
            )}
            {data.addresses
              .filter((address) => address.domain === domain)
              .map((address) => (
                <SideLink
                  key={address.id}
                  to={mailHref({ view: "all", inbox: address.id })}
                  active={onMail && filters.inbox === address.id}
                  label={`${address.localPart}@`}
                  title={address.address}
                  Icon={AtSignIcon}
                  count={data.counts.unreadByInbox[address.id] ?? 0}
                  onNavigate={onNavigate}
                />
              ))}
          </div>
        ))}
        {data.counts.mutedPersistentInboxes > 0 && (
          <SideLink
            to="/inboxes?kind=persistent&muted=1"
            active={false}
            label={t("shell.mutedAddresses")}
            Icon={BellOffIcon}
            count={data.counts.mutedPersistentInboxes}
            onNavigate={onNavigate}
          />
        )}
        {data.counts.activeEphemeralInboxes > 0 && (
          <SideLink
            to="/inboxes?kind=ephemeral"
            active={false}
            label={t("shell.temporary")}
            Icon={TimerIcon}
            count={data.counts.activeEphemeralInboxes}
            onNavigate={onNavigate}
          />
        )}
        {data.addresses.length === 0 &&
          data.counts.activeEphemeralInboxes === 0 &&
          data.counts.mutedPersistentInboxes === 0 && (
            <Link
              to="/inboxes"
              onClick={onNavigate}
              className="px-3 py-1 text-[13px] text-secondary-text hover:text-title"
            >
              {t("shell.addAddress")}
            </Link>
          )}
      </Group>
    </>
  );
}

const CONSOLE_SECTIONS: ReadonlyArray<{
  to: string;
  label: NavKey;
  Icon: IconComponent | React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
}> = [
  { to: "/status", label: "nav.status", Icon: OverviewIcon },
  { to: "/sent", label: "nav.deliveries", Icon: SendIcon },
  { to: "/inboxes", label: "nav.addresses", Icon: InboxIcon },
  { to: "/agents", label: "nav.agents", Icon: FingerprintIcon, adminOnly: true },
  { to: "/settings", label: "nav.settings", Icon: SettingsGearIcon },
];

function ConsoleNav({
  data,
  onNavigate,
}: {
  data: ShellData;
  onNavigate?: (() => void) | undefined;
}) {
  const { t } = useT();
  const location = useLocation();

  return (
    <nav aria-label={t("shell.console")} className="flex flex-col gap-0.5 pt-3">
      {CONSOLE_SECTIONS.filter((section) => section.adminOnly !== true || data.admin).map(
        (section) => (
          <SideLink
            key={section.to}
            to={section.to}
            active={
              location.pathname === section.to || location.pathname.startsWith(`${section.to}/`)
            }
            label={t(section.label)}
            Icon={section.Icon}
            onNavigate={onNavigate}
          />
        ),
      )}
    </nav>
  );
}

/**
 * The environment switcher. A form POST rather than a link, because switching
 * writes the cookie the server reads when it builds the `Caller`.
 */
function EnvironmentSwitcher({ data }: { data: ShellData }) {
  const { t } = useT();
  const current =
    data.environments.find((environment) => environment.id === data.accountId) ?? null;
  const label = current?.name ?? data.accountId;

  if (data.environments.length < 2) {
    return (
      <div className="flex h-8 items-center gap-2 rounded-control border border-border bg-input/30 px-3 text-sm text-secondary-text">
        <span className="truncate">{label}</span>
        <ModeTag mode={data.mode} />
      </div>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-between rounded-control"
            aria-label={t("env.switch")}
          />
        }
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{label}</span>
          <ModeTag mode={data.mode} />
        </span>
        <ChevronsUpDownIcon className="size-4 shrink-0 text-hint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        {data.environments.map((environment) => (
          <Form method="post" action="/environment" key={environment.id}>
            <input type="hidden" name="accountId" value={environment.id} />
            <DropdownMenuItem
              render={
                <button type="submit" className="w-full">
                  <span className="flex w-full items-center gap-2">
                    <CheckIcon
                      className={cn(
                        "size-4 shrink-0",
                        environment.id === data.accountId ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="flex-1 truncate text-left">{environment.name}</span>
                    <ModeTag mode={environment.mode} />
                  </span>
                </button>
              }
            />
          </Form>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ModeTag({ mode }: { mode: string }) {
  const { t } = useT();
  const label =
    mode === "live"
      ? t("env.modeLive")
      : mode === "sandbox"
        ? t("env.modeSandbox")
        : t("env.modeTest");
  return (
    <Tag tone={mode === "live" ? "neutral" : mode === "sandbox" ? "info" : "warning"}>
      {label}
    </Tag>
  );
}

function SidebarBody({
  data,
  onNavigate,
}: {
  data: ShellData;
  onNavigate?: (() => void) | undefined;
}) {
  const signOut = useRef<AnimatedIconHandle>(null);
  const location = useLocation();
  const { t } = useT();
  const inConsole = isConsolePath(location.pathname);

  return (
    <div className="flex h-full flex-col p-3">
      <div className="px-3 pt-2 pb-3">
        <span className="font-semibold tracking-tight text-title">Mailworker</span>
      </div>
      <div className="flex flex-col gap-2">
        <EnvironmentSwitcher data={data} />
        <ModeSwitch console={inConsole} onNavigate={onNavigate} />
      </div>

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 pb-3">
        {inConsole ? (
          <ConsoleNav data={data} onNavigate={onNavigate} />
        ) : (
          <MailNav data={data} onNavigate={onNavigate} />
        )}
      </div>

      <Separator className="mb-2" />
      <Form method="post" action="/logout" className="px-1">
        <Button
          type="submit"
          variant="ghost"
          size="sm"
          className="w-full justify-start text-secondary-text"
          onMouseEnter={() => signOut.current?.startAnimation()}
          onMouseLeave={() => signOut.current?.stopAnimation()}
        >
          <LogoutIcon ref={signOut} size={15} />
          {t("shell.signOut")}
        </Button>
      </Form>
    </div>
  );
}

function useDrawer(open: boolean, close: () => void) {
  const drawer = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () =>
      Array.from(
        drawer.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
    const frame = requestAnimationFrame(() => (focusable()[0] ?? drawer.current)?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      opener.current?.focus();
    };
  }, [open, close]);

  return { drawer, opener };
}

export default function Shell({ loaderData }: Route.ComponentProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const close = useRef(() => setDrawerOpen(false)).current;
  const { drawer, opener } = useDrawer(drawerOpen, close);
  const menu = useRef<AnimatedIconHandle>(null);
  const location = useLocation();
  const { t } = useT();
  const onMail = location.pathname === "/mail" || location.pathname.startsWith("/mail/");

  return (
    <TooltipProvider>
      <ComposeProvider enabled={loaderData.admin}>
        <div className="min-h-dvh md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="sticky top-0 hidden h-dvh border-r border-sidebar-border bg-sidebar md:block">
            <SidebarBody data={loaderData} />
          </aside>

          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-sidebar-border bg-sidebar/80 px-3 py-2 backdrop-blur-md md:hidden">
            <Button
              ref={opener}
              variant="ghost"
              size="icon-sm"
              aria-label={t("shell.openNav")}
              aria-expanded={drawerOpen}
              onClick={() => setDrawerOpen(true)}
              onMouseEnter={() => menu.current?.startAnimation()}
              onMouseLeave={() => menu.current?.stopAnimation()}
            >
              <MenuIcon ref={menu} size={18} />
            </Button>
            <span className="font-medium text-title">Mailworker</span>
            <span className="ml-auto">
              <ModeTag mode={loaderData.mode} />
            </span>
          </header>

          {/* A plain overlay rather than a modal Dialog: navigation must not mark
              the page it links into as inert. */}
          {drawerOpen && (
            <div className="fixed inset-0 z-50 md:hidden">
              <button
                type="button"
                tabIndex={-1}
                aria-label={t("shell.closeNav")}
                className="absolute inset-0 bg-foreground/25 backdrop-blur-[2px]"
                onClick={close}
              />
              <div
                ref={drawer}
                role="dialog"
                aria-label={t("shell.nav")}
                aria-modal="true"
                tabIndex={-1}
                className="absolute inset-y-0 left-0 w-64 border-r border-sidebar-border bg-sidebar shadow-lg"
              >
                <SidebarBody data={loaderData} onNavigate={close} />
              </div>
            </div>
          )}

          <div className="min-w-0">
            {onMail ? (
              <main>
                <Outlet />
              </main>
            ) : (
              <main className="px-5 py-6 md:px-8 md:py-8">
                <div className="mx-auto max-w-6xl">
                  <Outlet />
                </div>
              </main>
            )}
          </div>
        </div>
      </ComposeProvider>
    </TooltipProvider>
  );
}
