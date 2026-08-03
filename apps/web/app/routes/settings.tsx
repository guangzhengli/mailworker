import type { AccountMode } from "@mailworker/core";
import { can, page } from "@web/app/auth";
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
import { LOCALES, localeFromMatches, type MessageKey, translate, useT } from "@web/app/i18n";
import { LOCALE_NAMES, useLocaleSwitch } from "@web/app/i18n/switch";
import { cn } from "@web/app/lib/utils";
import { type Theme, useTheme } from "@web/app/theme";
import { Mono, Note, PageHeader, SectionTitle, Tag } from "@web/app/ui";
import { ArrowRightIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useEffect } from "react";
import { Form, Link, useNavigation } from "react-router";
import { toast } from "sonner";
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
  return await page(context, request, async ({ caller, services }) => {
    const admin = can(caller, "admin");
    const environments = admin ? await services.identity.listEnvironments(caller) : [];

    return {
      subject: caller.subject,
      scopes: caller.scopes,
      accountId: caller.accountId,
      admin,
      environments: environments.map((environment) => ({
        id: environment.id,
        name: environment.name,
        mode: environment.mode,
      })),
    };
  });
}

export async function action({ context, request }: Route.ActionArgs) {
  return await page(context, request, async ({ caller, services }) => {
    const form = await request.formData();
    const environment = await services.identity.createEnvironment(caller, {
      env: String(form.get("env") ?? ""),
      mode: String(form.get("mode") ?? "sandbox") as AccountMode,
    });
    return { created: environment.name };
  });
}

function Group({ children }: { children: React.ReactNode }) {
  return <Card className="gap-0 divide-y divide-border/70 py-0">{children}</Card>;
}

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

const MODES: ReadonlyArray<{
  value: AccountMode;
  label: Extract<MessageKey, `settings.mode${string}`>;
}> = [
  { value: "live", label: "settings.modeLive" },
  { value: "sandbox", label: "settings.modeSandbox" },
  { value: "test", label: "settings.modeTest" },
];

export default function Settings({ loaderData, actionData }: Route.ComponentProps) {
  const { t } = useT();
  const busy = useNavigation().state !== "idle";
  const created = actionData?.created ?? null;

  useEffect(() => {
    if (created !== null) toast.success(t("settings.envCreated", { name: created }));
  }, [created, t]);

  return (
    <>
      <PageHeader title={t("settings.title")} />

      {loaderData.admin && (
        <>
          <SectionTitle>{t("settings.environments")}</SectionTitle>
          <Note className="mt-0 mb-3">{t("settings.environmentsDescription")}</Note>
          <Group>
            {loaderData.environments.map((environment) => (
              <Row
                key={environment.id}
                label={environment.name}
                description={t(
                  MODES.find((mode) => mode.value === environment.mode)?.label ??
                    "settings.modeLive",
                )}
              >
                <Tag
                  tone={
                    environment.mode === "live"
                      ? "success"
                      : environment.mode === "sandbox"
                        ? "info"
                        : "warning"
                  }
                >
                  {environment.mode}
                </Tag>
              </Row>
            ))}
          </Group>

          <Card className="mt-3 mb-5">
            <CardContent>
              <Form method="post" className="flex flex-wrap items-end gap-3">
                <div className="flex min-w-40 flex-1 flex-col gap-2">
                  <Label htmlFor="env">{t("settings.envNameLabel")}</Label>
                  <Input id="env" name="env" required placeholder="development" />
                </div>
                <div className="flex flex-col gap-2">
                  <Label htmlFor="mode">{t("settings.envModeLabel")}</Label>
                  <Select
                    name="mode"
                    defaultValue="sandbox"
                    items={{ live: "live", sandbox: "sandbox", test: "test" }}
                  >
                    <SelectTrigger id="mode" className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODES.map((mode) => (
                        <SelectItem key={mode.value} value={mode.value}>
                          {mode.value}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" disabled={busy}>
                  {t("settings.addEnvironment")}
                </Button>
              </Form>
            </CardContent>
          </Card>
        </>
      )}

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
        <Row label={t("field.scopes")} description={t("settings.scopesNote")}>
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

      <SectionTitle>{t("nav.settings")}</SectionTitle>
      <Group>
        {/* Addresses live here rather than in the nav for the same reason
            suppressions do: creating one is setup, and reading what arrives at
            it — which is the daily task — is a different page (ADR-10). */}
        <Row label={t("settings.addresses")} description={t("settings.addressesDescription")}>
          <Button render={<Link to="/inboxes" />} variant="outline" size="sm">
            {t("settings.open")}
            <ArrowRightIcon />
          </Button>
        </Row>
        <Row
          label={t("settings.suppressions")}
          description={t("settings.suppressionsDescription")}
        >
          <Button render={<Link to="/settings/suppressions" />} variant="outline" size="sm">
            {t("settings.open")}
            <ArrowRightIcon />
          </Button>
        </Row>
        <Row
          label={t("settings.diagnostics")}
          description={t("settings.diagnosticsDescription")}
        >
          <Button render={<Link to="/settings/diagnostics" />} variant="outline" size="sm">
            {t("settings.open")}
            <ArrowRightIcon />
          </Button>
        </Row>
      </Group>
    </>
  );
}
