import { Button } from "@web/app/components/ui/button";
import { LOCALES, type Locale, useT } from "@web/app/i18n";
import { Form, useLocation } from "react-router";

/**
 * How each locale names itself, long and short.
 *
 * Endonyms, never translated: a reader looking for their own language has to
 * recognise it in the language they already read, which is the one thing a
 * translated language name cannot do. The short form is what fits in a 32px
 * button.
 */
export const LOCALE_NAMES: Readonly<
  Record<Locale, { readonly long: string; readonly short: string }>
> = {
  en: { long: "English", short: "EN" },
  zh: { long: "中文", short: "中" },
};

/**
 * The parts of a language switch that must not be written twice.
 *
 * `?return=` is the security-relevant half — `routes/locale.tsx` only honours a
 * same-origin path — and `useLocation` is where it comes from rather than the
 * `Referer` header: the path the reader is looking at is a thing this component
 * already knows, and asking the browser for it instead would make the switch
 * depend on a header that the document's referrer policy is free to strip.
 */
export function useLocaleSwitch(): {
  readonly locale: Locale;
  readonly next: Locale;
  readonly action: string;
} {
  const { locale } = useT();
  const location = useLocation();

  const next = (LOCALES.find((candidate) => candidate !== locale) ?? locale) as Locale;
  const returnTo = `${location.pathname}${location.search}`;

  return { locale, next, action: `/locale?return=${encodeURIComponent(returnTo)}` };
}

/**
 * The text form, for pages outside the shell.
 *
 * `login.tsx` has no `TooltipProvider` and no sidebar to put an icon button in,
 * but it is the one page a reader sees before they have a session — so it is the
 * page where being unable to switch language matters most.
 */
export function LocaleSwitchLink({ className }: { className?: string }) {
  const { next, action } = useLocaleSwitch();

  return (
    <Form method="post" action={action} className={className}>
      <Button
        type="submit"
        variant="link"
        size="xs"
        className="text-hint underline decoration-dotted underline-offset-2 hover:text-secondary-text"
      >
        {LOCALE_NAMES[next].long}
      </Button>
    </Form>
  );
}
