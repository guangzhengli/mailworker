import { page } from "@web/app/auth";
import {
  type AnimatedIconHandle,
  ApprovalsIcon,
  FingerprintIcon,
  OverviewIcon as HomeIcon,
  LogoutIcon,
  MailboxIcon,
  MenuIcon,
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
import { type MessageKey, useT } from "@web/app/i18n";
import { cn } from "@web/app/lib/utils";
import { Tag } from "@web/app/ui";
import { CheckIcon, ChevronsUpDownIcon, TriangleAlertIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Form, NavLink, Outlet, useLocation } from "react-router";
import type { Route } from "./+types/shell";

/**
 * The layout every real page sits inside, and the single place authentication is
 * checked for all of them. React Router runs a layout's loader before its
 * children's, so a child page cannot render without this having passed.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller, services }) => {
    // A credential bound to one environment cannot list the others, and asking
    // would be a 403 on every page load rather than a missing dropdown.
    const environments = caller.scopes.includes("admin")
      ? await services.identity.listEnvironments(caller)
      : [];

    const awaiting = await services.delivery.list(caller, {
      status: "pending_approval",
      limit: 1,
    });

    return {
      accountId: caller.accountId,
      mode: caller.mode,
      environments: environments.map((environment) => ({
        id: environment.id,
        env: environment.env,
        name: environment.name,
        mode: environment.mode,
      })),
      hasAwaiting: awaiting.items.length > 0,
    };
  });
}

type LoaderData = Route.ComponentProps["loaderData"];

type IconComponent = React.ComponentType<
  { size?: number; className?: string } & React.RefAttributes<AnimatedIconHandle>
>;

/**
 * `NavKey` rather than the whole `MessageKey` union, because `t()` derives its
 * required variables from the key: given every key in the catalogue it cannot
 * prove this one needs none, and demands an interpolation argument.
 */
type NavKey = Extract<MessageKey, `nav.${string}`>;

interface Section {
  readonly to: string;
  readonly label: NavKey;
  readonly end: boolean;
  readonly Icon: IconComponent;
  readonly badge?: boolean;
}

const SECTIONS: ReadonlyArray<Section> = [
  { to: "/", label: "nav.overview", end: true, Icon: HomeIcon },
  { to: "/approvals", label: "nav.approvals", end: false, Icon: ApprovalsIcon, badge: true },
  { to: "/sent", label: "nav.sent", end: false, Icon: SendIcon },
  { to: "/inbox", label: "nav.inbox", end: false, Icon: MailboxIcon },
  { to: "/agents", label: "nav.agents", end: false, Icon: FingerprintIcon },
  { to: "/settings", label: "nav.settings", end: false, Icon: SettingsGearIcon },
];

/**
 * A nav row whose icon animates from the row's hover, not the icon's own.
 *
 * The registry icons animate on their own `mouseenter`, which on a 200px-wide
 * nav item means the animation only fires in the 18px the glyph occupies — the
 * rest of the row is a dead zone that looks broken.
 */
function NavItem({
  to,
  end,
  label,
  Icon,
  badge,
  onNavigate,
}: Section & { onNavigate?: (() => void) | undefined }) {
  const icon = useRef<AnimatedIconHandle>(null);
  const { t } = useT();

  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      onMouseEnter={() => icon.current?.startAnimation()}
      onMouseLeave={() => icon.current?.stopAnimation()}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-3 rounded-control px-3 py-2 text-sm font-medium transition-colors",
          isActive
            ? "bg-selected text-title"
            : "text-secondary-text hover:bg-hover hover:text-title",
        )
      }
    >
      <Icon ref={icon} size={18} className="shrink-0" />
      <span className="flex-1 truncate">{t(label)}</span>
      {badge === true && <span className="size-2 shrink-0 rounded-full bg-warning" />}
    </NavLink>
  );
}

/**
 * The environment switcher.
 *
 * A form POST rather than a link, because switching writes a cookie the server
 * reads when it builds the `Caller` — and because it is a state change, which is
 * not what a GET is for. A credential bound to one environment sees the label
 * without the chevron: there is nothing to switch to, and a dropdown that opens
 * onto a single disabled row is worse than no dropdown.
 */
function EnvironmentSwitcher({ loaderData }: { loaderData: LoaderData }) {
  const { t } = useT();
  const current =
    loaderData.environments.find((environment) => environment.id === loaderData.accountId) ??
    null;
  const label = current?.name ?? loaderData.accountId;

  if (loaderData.environments.length < 2) {
    return (
      <div className="flex h-8 items-center gap-2 rounded-control border border-border bg-input/30 px-3 text-sm text-secondary-text">
        <span className="truncate">{label}</span>
        <ModeTag mode={loaderData.mode} />
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
          <ModeTag mode={loaderData.mode} />
        </span>
        <ChevronsUpDownIcon className="size-4 shrink-0 text-hint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56">
        {loaderData.environments.map((environment) => (
          <Form method="post" action="/environment" key={environment.id}>
            <input type="hidden" name="accountId" value={environment.id} />
            <DropdownMenuItem
              render={
                <button type="submit" className="w-full">
                  <span className="flex w-full items-center gap-2">
                    <CheckIcon
                      className={cn(
                        "size-4 shrink-0",
                        environment.id === loaderData.accountId ? "opacity-100" : "opacity-0",
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
    <Tag tone={mode === "live" ? "success" : mode === "sandbox" ? "info" : "warning"}>
      {label}
    </Tag>
  );
}

/**
 * The mode banner, and the reason it is passive rather than a confirmation.
 *
 * Anything that asks a person to notice which environment they are in will be
 * ignored on the day it matters. This sits above the content on every page of
 * every non-live environment, costs one line, and cannot be dismissed.
 */
function ModeBanner({ mode }: { mode: LoaderData["mode"] }) {
  const { t } = useT();
  if (mode === "live") return null;

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-4 py-1.5 text-center text-[13px] font-medium",
        mode === "sandbox"
          ? "border-b border-info-border bg-info-bg text-info"
          : "border-b border-warning-border bg-warning-bg text-warning",
      )}
    >
      <TriangleAlertIcon className="size-3.5 shrink-0" />
      <span>{mode === "sandbox" ? t("env.bannerSandbox") : t("env.bannerTest")}</span>
    </div>
  );
}

function SidebarBody({
  loaderData,
  onNavigate,
}: {
  loaderData: LoaderData;
  onNavigate?: (() => void) | undefined;
}) {
  const signOut = useRef<AnimatedIconHandle>(null);
  const { t } = useT();

  return (
    <div className="flex h-full flex-col gap-1 p-3">
      <div className="px-3 pt-3 pb-1">
        <div className="font-semibold tracking-tight text-title">Mailworker</div>
      </div>
      <div className="pb-2">
        <EnvironmentSwitcher loaderData={loaderData} />
      </div>

      <nav className="flex flex-col gap-0.5">
        {SECTIONS.map((section) => (
          <NavItem
            key={section.to}
            {...section}
            badge={section.badge === true && loaderData.hasAwaiting}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div className="flex-1" />

      <Separator className="my-2" />

      <div className="px-3 pb-1">
        <Form method="post" action="/logout">
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="w-full"
            onMouseEnter={() => signOut.current?.startAnimation()}
            onMouseLeave={() => signOut.current?.stopAnimation()}
          >
            <LogoutIcon ref={signOut} size={15} />
            {t("shell.signOut")}
          </Button>
        </Form>
      </div>
    </div>
  );
}

export default function Shell({ loaderData }: Route.ComponentProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const menu = useRef<AnimatedIconHandle>(null);
  const { t } = useT();

  const section = SECTIONS.find((s) =>
    s.end ? location.pathname === s.to : location.pathname.startsWith(s.to),
  );
  const current = section === undefined ? "Mailworker" : t(section.label);

  return (
    <TooltipProvider>
      <div className="min-h-dvh md:grid md:grid-cols-[15rem_minmax(0,1fr)]">
        {/* Desktop rail. Hidden rather than unmounted below md so the drawer owns
            the small-screen case entirely — two nav trees visible at once is how
            duplicate ids and double-fired handlers happen. */}
        <aside className="sticky top-0 hidden h-dvh border-r border-sidebar-border bg-sidebar md:block">
          <SidebarBody loaderData={loaderData} />
        </aside>

        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-sidebar-border bg-sidebar/80 px-3 py-2 backdrop-blur-md md:hidden">
          <Button
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
          <span className="font-medium text-title">{current}</span>
        </header>

        {/*
         * A plain overlay rather than a Dialog: Base UI's Dialog is modal, which
         * traps focus and marks the rest of the page inert — right for a
         * confirmation and wrong for navigation, where every link inside points
         * at content the trap is hiding. Escape and click-outside are the two
         * behaviours that matter, and both are ten lines.
         */}
        {drawerOpen && (
          <div className="fixed inset-0 z-50 md:hidden">
            <button
              type="button"
              aria-label={t("shell.closeNav")}
              className="absolute inset-0 bg-foreground/25 backdrop-blur-[2px]"
              onClick={() => setDrawerOpen(false)}
            />
            <div
              role="dialog"
              aria-label={t("shell.nav")}
              aria-modal="true"
              className="absolute inset-y-0 left-0 w-64 border-r border-sidebar-border bg-sidebar shadow-lg"
              onKeyDown={(event) => {
                if (event.key === "Escape") setDrawerOpen(false);
              }}
            >
              <SidebarBody loaderData={loaderData} onNavigate={() => setDrawerOpen(false)} />
            </div>
          </div>
        )}

        <div className="min-w-0">
          <ModeBanner mode={loaderData.mode} />
          <main className="px-5 py-6 md:px-8 md:py-8">
            <div className="mx-auto max-w-6xl">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
