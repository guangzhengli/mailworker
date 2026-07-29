import { page } from "@web/app/auth";
import {
  type AnimatedIconHandle,
  BanIcon,
  FingerprintIcon,
  KeySquareIcon,
  LogoutIcon,
  MailboxIcon,
  MenuIcon,
  SendIcon,
  StethoscopeIcon,
  SunMoonIcon,
} from "@web/app/components/icons";
import { Button } from "@web/app/components/ui/button";
import { Separator } from "@web/app/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@web/app/components/ui/tooltip";
import { type MessageKey, useT } from "@web/app/i18n";
import { LOCALE_NAMES, useLocaleSwitch } from "@web/app/i18n/switch";
import { cn } from "@web/app/lib/utils";
import { useTheme } from "@web/app/theme";
import { useRef, useState } from "react";
import { Form, NavLink, Outlet, useLocation } from "react-router";
import type { Route } from "./+types/shell";

/**
 * The layout every real page sits inside — and, more importantly, the single
 * place authentication is checked for all of them.
 *
 * React Router runs a layout's loader before its children's, so a child page
 * cannot render without this having passed. That is why the guard lives here
 * rather than being repeated per route: the version that is repeated is the
 * version where the eleventh page forgets.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller }) => {
    return { subject: caller.subject, scopes: caller.scopes, accountId: caller.accountId };
  });
}

type IconComponent = React.ComponentType<
  { size?: number; className?: string } & React.RefAttributes<AnimatedIconHandle>
>;

/**
 * The nav, with message keys rather than labels.
 *
 * A module constant cannot call a hook, and translating at the point of render
 * is what keeps this a static table — the alternative is building the array
 * inside the component on every render, for six rows that never change.
 *
 * `NavKey` rather than the whole `MessageKey` union, because `t()` derives its
 * required variables from the key: given every key in the catalogue it cannot
 * prove this one needs none, and demands an interpolation argument. Narrowing to
 * the `nav.` keys — none of which take variables — is both what makes the call
 * typecheck and a truer statement of what belongs in this table.
 */
type NavKey = Extract<MessageKey, `nav.${string}`>;

const SECTIONS: ReadonlyArray<{
  to: string;
  label: NavKey;
  end: boolean;
  Icon: IconComponent;
}> = [
  { to: "/", label: "nav.inboxes", end: true, Icon: MailboxIcon },
  { to: "/deliveries", label: "nav.deliveries", end: false, Icon: SendIcon },
  { to: "/suppressions", label: "nav.suppressions", end: false, Icon: BanIcon },
  { to: "/identities", label: "nav.identities", end: false, Icon: FingerprintIcon },
  { to: "/keys", label: "nav.keys", end: false, Icon: KeySquareIcon },
  { to: "/diagnostics", label: "nav.diagnostics", end: false, Icon: StethoscopeIcon },
];

/**
 * A nav row whose icon animates from the row's hover, not the icon's own.
 *
 * The registry icons animate on their own `mouseenter`, which on a 200px-wide
 * nav item means the animation only fires in the 18px the glyph occupies — the
 * rest of the row is a dead zone that looks broken. Passing a ref switches them
 * to controlled mode, and the row drives them instead.
 */
function NavItem({
  to,
  end,
  label,
  Icon,
  onNavigate,
}: {
  to: string;
  end: boolean;
  label: NavKey;
  Icon: IconComponent;
  onNavigate?: (() => void) | undefined;
}) {
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
      <span className="truncate">{t(label)}</span>
    </NavLink>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const icon = useRef<AnimatedIconHandle>(null);
  const { t } = useT();
  const next = resolvedTheme === "dark" ? "light" : "dark";
  const label = next === "dark" ? t("shell.themeToDark") : t("shell.themeToLight");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            onClick={() => setTheme(next)}
            onMouseEnter={() => icon.current?.startAnimation()}
            onMouseLeave={() => icon.current?.stopAnimation()}
          />
        }
      >
        <SunMoonIcon ref={icon} size={16} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The language switch: a form, not a client-side toggle.
 *
 * A POST sets the cookie and the next render is server-side in the new language.
 * A client-side switch would have to re-translate everything it had already
 * hydrated and would still leave the following hard navigation to guess.
 */
function LocaleToggle() {
  const { t } = useT();
  const { next, action } = useLocaleSwitch();

  return (
    <Form method="post" action={action}>
      <input type="hidden" name="locale" value={next} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="submit"
              variant="ghost"
              size="icon-sm"
              aria-label={t("shell.languageSwitch")}
              className="text-[11px] font-medium"
            />
          }
        >
          {LOCALE_NAMES[next].short}
        </TooltipTrigger>
        <TooltipContent>
          {t("shell.language")}: {LOCALE_NAMES[next].long}
        </TooltipContent>
      </Tooltip>
    </Form>
  );
}

function SidebarBody({
  loaderData,
  onNavigate,
}: {
  loaderData: Route.ComponentProps["loaderData"];
  onNavigate?: (() => void) | undefined;
}) {
  const signOut = useRef<AnimatedIconHandle>(null);
  const { t } = useT();

  return (
    <div className="flex h-full flex-col gap-1 p-3">
      <div className="flex items-center justify-between px-3 py-3">
        <div className="min-w-0">
          <div className="font-semibold tracking-tight text-title">Mailworker</div>
          <div className="truncate font-mono text-[11px] text-hint">{loaderData.accountId}</div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <LocaleToggle />
          <ThemeToggle />
        </div>
      </div>

      <nav className="flex flex-col gap-0.5">
        {SECTIONS.map((section) => (
          <NavItem key={section.to} {...section} onNavigate={onNavigate} />
        ))}
      </nav>

      <div className="flex-1" />

      <Separator className="my-2" />

      <div className="px-3 pb-1">
        <div
          className="truncate font-mono text-[11px] text-secondary-text"
          title={loaderData.subject}
        >
          {loaderData.subject}
        </div>
        {/* The scopes are here rather than on a settings page because they are
            the answer to "why was that button 403" — which is a question asked
            while looking at the button, not while looking for a settings page. */}
        <div className="mt-1 mb-3 text-[11px] text-hint">{loaderData.scopes.join(" · ")}</div>
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
        {/* Desktop rail. Hidden rather than unmounted below md so the drawer
            owns the small-screen case entirely — two nav trees visible at once
            is how duplicate ids and double-fired handlers happen. */}
        <aside className="sticky top-0 hidden h-dvh border-r border-sidebar-border bg-sidebar md:block">
          <SidebarBody loaderData={loaderData} />
        </aside>

        {/* Mobile top bar. */}
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
         * A plain overlay rather than a Dialog.
         *
         * Base UI's Dialog is modal: it traps focus and marks the rest of the
         * page inert, which is right for a confirmation and wrong for
         * navigation — every link inside it points at content the trap is
         * currently hiding. Escape and click-outside are the two behaviours
         * that actually matter here, and both are ten lines.
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

        <main className="min-w-0 px-5 py-6 md:px-8 md:py-8">
          <div className="mx-auto max-w-6xl">
            <Outlet />
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}
