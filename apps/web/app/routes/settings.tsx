import { page } from "@web/app/auth";
import { Button } from "@web/app/components/ui/button";
import { Card } from "@web/app/components/ui/card";
import { LOCALES, localeFromMatches, type MessageKey, translate, useT } from "@web/app/i18n";
import { LOCALE_NAMES, useLocaleSwitch } from "@web/app/i18n/switch";
import { cn } from "@web/app/lib/utils";
import { type Theme, useTheme } from "@web/app/theme";
import { Mono, Note, PageHeader, SectionTitle, Tag } from "@web/app/ui";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Form } from "react-router";
import type { Route } from "./+types/settings";

export const meta: Route.MetaFunction = ({ matches }) => [
  { title: translate(localeFromMatches(matches), "settings.pageTitle") },
];

/**
 * The only page whose content is the reader rather than the account.
 *
 * The loader still goes through `page()` — not because there is anything secret
 * on it, but because the identity it displays has to be the one the server
 * believes in. A settings page that rendered a subject from client state would
 * be a settings page that keeps showing the old one after a session expires.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  return await page(context, request, async ({ caller }) => {
    return { subject: caller.subject, scopes: caller.scopes, accountId: caller.accountId };
  });
}

/**
 * A group of settings, drawn as one card with hairlines between the rows.
 *
 * The divider belongs to the group rather than to the row: a row that drew its
 * own top border would need the first one to know it is first, which is the
 * rule everybody forgets when they insert a row in the middle.
 */
function Group({ children }: { children: React.ReactNode }) {
  return <Card className="gap-0 divide-y divide-border/70 py-0">{children}</Card>;
}

/**
 * One setting: what it is on the left, the control that changes it on the right.
 *
 * Wraps rather than truncates at narrow widths — the description is the half
 * that explains what the control on the right will do, so losing it to an
 * ellipsis loses the row's meaning while keeping its switch.
 */
function Row({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-5 py-4">
      <div className="min-w-0">
        <div className="text-sm font-medium text-title">{label}</div>
        {description !== undefined && (
          <p className="mt-0.5 max-w-prose text-[13px] leading-relaxed text-hint">
            {description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * A choice between two or three named options, shown all at once.
 *
 * A select would hide the alternatives behind a click, and these are settings
 * whose options are the explanation — "System" only means something next to the
 * two things it is choosing between.
 *
 * A `fieldset` rather than a `div role="group"`: it is the element that grouping
 * role exists to imitate, and the row already carries the visible label, so the
 * accessible name goes on as `aria-label` instead of a `legend` that would draw
 * the word twice.
 */
function Segmented({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-full bg-muted p-0.5"
    >
      {children}
    </fieldset>
  );
}

/**
 * `dark:bg-popover` rather than a single `bg-card`: in light mode the card sits
 * above the muted track, and in dark mode it sits below it, so the one token
 * that reads as "raised" on one theme reads as a hole on the other. Popover is
 * the step above muted in the dark ramp, which is the same relationship.
 */
function Segment({
  active,
  className,
  children,
  ...props
}: React.ComponentProps<typeof Button> & { active: boolean }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-pressed={active}
      className={cn(
        "gap-1.5 rounded-full px-3 text-[13px]",
        active
          ? "bg-card text-title shadow-xs ring-1 ring-foreground/10 hover:bg-card dark:bg-popover"
          : "text-secondary-text hover:bg-transparent hover:text-title",
        className,
      )}
      {...props}
    >
      {children}
    </Button>
  );
}

/**
 * `Extract` rather than the whole `MessageKey` union, for the same reason the
 * nav table narrows: `t()` derives a message's required variables from its key,
 * and given every key it cannot prove these three take none.
 */
type ThemeKey = Extract<MessageKey, `settings.theme${string}`>;

const THEMES: ReadonlyArray<{
  value: Theme;
  label: ThemeKey;
  Icon: typeof SunIcon;
}> = [
  { value: "light", label: "settings.themeLight", Icon: SunIcon },
  { value: "dark", label: "settings.themeDark", Icon: MoonIcon },
  { value: "system", label: "settings.themeSystem", Icon: MonitorIcon },
];

/**
 * The theme is a browser preference, not an account one, so this control is
 * client-only by nature — the server has no way to know what is in localStorage
 * and renders "System" selected until the provider's mount effect corrects it.
 * That one frame is the same trade `ThemeProvider` already documents, and the
 * page it happens on is already painted in the right colours by `ThemeScript`.
 */
function ThemeChoice() {
  const { theme, setTheme } = useTheme();
  const { t } = useT();

  return (
    <Segmented label={t("settings.theme")}>
      {THEMES.map(({ value, label, Icon }) => (
        <Segment
          key={value}
          active={theme === value}
          onClick={() => setTheme(value)}
          type="button"
        >
          <Icon className="size-3.5" />
          {t(label)}
        </Segment>
      ))}
    </Segmented>
  );
}

/**
 * Submit buttons, not a client-side toggle.
 *
 * Each option posts its own locale to `/locale`, which sets the cookie and sends
 * the browser back here — so the next render is server-side in the new language
 * rather than a re-translation of what this page had already hydrated. It also
 * means the control works with JavaScript off, which the theme one cannot.
 */
function LanguageChoice() {
  const { locale, action } = useLocaleSwitch();
  const { t } = useT();

  return (
    <Form method="post" action={action}>
      <Segmented label={t("settings.language")}>
        {LOCALES.map((candidate) => (
          <Segment
            key={candidate}
            active={candidate === locale}
            type="submit"
            name="locale"
            value={candidate}
          >
            {LOCALE_NAMES[candidate].long}
          </Segment>
        ))}
      </Segmented>
    </Form>
  );
}

export default function Settings({ loaderData }: Route.ComponentProps) {
  const { t } = useT();

  return (
    <>
      <PageHeader title={t("settings.title")} description={t("settings.description")} />

      <SectionTitle>{t("settings.general")}</SectionTitle>
      <Group>
        <Row label={t("settings.theme")} description={t("settings.themeDescription")}>
          <ThemeChoice />
        </Row>
        <Row label={t("settings.language")} description={t("settings.languageDescription")}>
          <LanguageChoice />
        </Row>
      </Group>

      <SectionTitle>{t("settings.account")}</SectionTitle>
      <Group>
        <Row label={t("settings.signedInAs")}>
          <Mono className="text-title">{loaderData.subject}</Mono>
        </Row>
        {/*
         * The scopes are the answer to "why was that button a 403", which is why
         * they are on a page at all rather than left to the API — but they are
         * reference material, read once, and the sidebar was charging every
         * screen for them.
         */}
        <Row label={t("field.scopes")}>
          {loaderData.scopes.length === 0 ? (
            <span className="text-hint">{t("common.dash")}</span>
          ) : (
            <span className="flex flex-wrap justify-end gap-1.5">
              {loaderData.scopes.map((scope) => (
                <Tag key={scope}>{scope}</Tag>
              ))}
            </span>
          )}
        </Row>
        <Row label={t("settings.accountId")}>
          <Mono className="text-title">{loaderData.accountId}</Mono>
        </Row>
      </Group>

      <Note>{t("settings.scopesNote")}</Note>
    </>
  );
}
