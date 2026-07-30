import { ERROR_CODES, type ErrorCode } from "@mailworker/contract";
import { localeTag } from "@web/app/i18n/format";
import { type Catalog, en } from "@web/app/i18n/locales/en";
import { zh } from "@web/app/i18n/locales/zh";
import { createContext, Fragment, use, useMemo } from "react";

/**
 * No library, and no module-level mutable state — the two are related.
 *
 * `i18next` and Lingui both hang the active locale off a module singleton
 * (`changeLanguage`, `i18n.activate`). A Worker isolate is reused across
 * concurrent requests, so a singleton locale is a value one request can observe
 * another request setting: reader A asks for Chinese and reader B gets a Chinese
 * page. Avoiding it means a per-request instance and a provider, which is most
 * of what those libraries' server adapters do.
 *
 * Here the locale arrives as root loader data and flows down through context, so
 * there is nothing global to race. What the libraries would otherwise buy —
 * plurals, dates, relative times, number formats — workerd already ships as full
 * ICU (verified: `Intl.RelativeTimeFormat("zh-CN")` gives 5分钟前), and ADR-8
 * measured `react-i18next` at roughly 2 MB transitively, above the `mimetext`
 * budget the same ADR already declined.
 */

export const LOCALES = ["en", "zh"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

const CATALOGS: Readonly<Record<Locale, Catalog>> = { en, zh };

export type MessageKey = keyof typeof en.messages;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Every `{placeholder}` in a message, as a union of names, at compile time.
 *
 * This is what makes `t("inboxes.deleteAria")` fail to typecheck while
 * `t("inboxes.deleteAria", { address })` passes — and, more usefully, what makes
 * a renamed placeholder an error at every call site rather than a stray
 * `{address}` rendered to the page.
 */
type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

type VarsFor<K extends MessageKey> = Placeholders<(typeof en.messages)[K]>;

/** `[never]` rather than a bare `extends never`, which distributes and is always false. */
type TextArgs<K extends MessageKey> = [VarsFor<K>] extends [never]
  ? []
  : [vars: Readonly<Record<VarsFor<K>, string | number>>];

type NodeArgs<K extends MessageKey> = [VarsFor<K>] extends [never]
  ? []
  : [vars: Readonly<Record<VarsFor<K>, React.ReactNode>>];

const PLACEHOLDER = /\{(\w+)\}/g;

function template(locale: Locale, key: MessageKey): string {
  // The English catalog is the source of truth for which keys exist, so a
  // translation that somehow lacks one still renders a sentence rather than a
  // key. `satisfies Catalog` means this cannot happen at build time; it is here
  // for the locale loaded from a cookie that a future version no longer ships.
  return CATALOGS[locale].messages[key] ?? en.messages[key];
}

function fill(text: string, vars: Readonly<Record<string, string | number>>): string {
  return text.replaceAll(PLACEHOLDER, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  );
}

/** The string form. For `aria-label`, `title`, `<meta>` and anywhere a ReactNode will not do. */
export function translate<K extends MessageKey>(
  locale: Locale,
  key: K,
  ...args: TextArgs<K>
): string {
  const vars = args[0] as Record<string, string | number> | undefined;
  const text = template(locale, key);
  if (vars === undefined) return text;
  return fill(text, vars);
}

/** `K` minus its `.one`/`.other` suffix, distributing so a union of keys gives a union of stems. */
type StemOf<K, Suffix extends string> = K extends `${infer Stem}.${Suffix}` ? Stem : never;

/**
 * A key that exists in both an `.one` and an `.other` form.
 *
 * `Extract` of the two stem unions is set intersection over string literals, so
 * adding only half a pair — `body.blocked.other` with no `.one` — leaves the stem
 * out of this type and fails the call site rather than falling back at runtime.
 */
export type PluralKey = Extract<StemOf<MessageKey, "one">, StemOf<MessageKey, "other">>;

const pluralRules = new Map<Locale, Intl.PluralRules>();

function rulesFor(locale: Locale): Intl.PluralRules {
  const hit = pluralRules.get(locale);
  if (hit !== undefined) return hit;
  const made = new Intl.PluralRules(localeTag(locale));
  pluralRules.set(locale, made);
  return made;
}

/**
 * A count and the sentence that agrees with it.
 *
 * The category comes from `Intl.PluralRules`, not from `count === 1`: English
 * happens to split at one, Chinese does not split at all, and a locale added
 * later may want `few` and `many`. Any category the catalog does not carry falls
 * back to `.other`, which every plural key is required to have.
 */
export function plural(locale: Locale, key: PluralKey, count: number): string {
  const category = rulesFor(locale).select(count);
  const candidate = `${key}.${category}`;
  const chosen = (candidate in en.messages ? candidate : `${key}.other`) as MessageKey;
  return fill(template(locale, chosen), { count });
}

/**
 * The rich form: placeholders may be React nodes.
 *
 * Several sentences embed a `<Mono>` command or a code name mid-clause. Splitting
 * them into three catalog entries would leave a translator reordering fragments
 * they cannot see the shape of — Chinese puts the verb elsewhere — so the whole
 * sentence stays one entry and the markup is passed in.
 */
export function interpolate<K extends MessageKey>(
  locale: Locale,
  key: K,
  ...args: NodeArgs<K>
): React.ReactNode {
  const vars = args[0] as Record<string, React.ReactNode> | undefined;
  const text = template(locale, key);
  if (vars === undefined) return text;

  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] as string;
    if (!(name in vars)) continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<Fragment key={`${name}-${match.index}`}>{vars[name]}</Fragment>);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

export function errorMessage(locale: Locale, code: ErrorCode): string {
  return CATALOGS[locale].errors[code] ?? en.errors[code];
}

/**
 * Whether a string is a wire error code.
 *
 * `app/auth.ts` puts the code in a thrown `Response`'s `statusText`, which is
 * the only channel React Router's `isRouteErrorResponse` exposes besides the
 * status and the body — and the body is the domain's own sentence, which the
 * error boundary still shows.
 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Picks a locale from an `Accept-Language` header.
 *
 * Quality values are honoured because a browser configured with English first
 * and Chinese second means it; `zh-TW` and `zh-Hant` match `zh` on the primary
 * subtag, which is a deliberate simplification — this catalog is Simplified, and
 * serving it to a Traditional reader is better than serving them English.
 */
export function negotiate(acceptLanguage: string | null): Locale {
  if (acceptLanguage === null) return DEFAULT_LOCALE;

  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      const quality = q === undefined ? 1 : Number.parseFloat(q.trim().slice(2));
      return {
        tag: (tag ?? "").trim().toLowerCase(),
        q: Number.isFinite(quality) ? quality : 0,
      };
    })
    .filter((entry) => entry.tag.length > 0 && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    if (tag === "*") return DEFAULT_LOCALE;
    const primary = tag.split("-")[0];
    const hit = LOCALES.find((locale) => locale === primary);
    if (hit !== undefined) return hit;
  }
  return DEFAULT_LOCALE;
}

/**
 * The locale for a `meta` function, which is not a component and so cannot use
 * the hook below.
 *
 * React Router hands `meta` the matched routes and their loader data, and the
 * root's carries the locale — so a page title is translated from the same value
 * the page body used, rather than from a second negotiation that could disagree.
 *
 * The field is `loaderData`, not `data`. Both names appear in React Router's own
 * API — `useMatches` gives `UIMatch.data` — but `MetaMatch` uses `loaderData`,
 * and reading the wrong one silently returns English for every page title while
 * the page body translates correctly. Hence the parameter requires `loaderData`
 * rather than accepting it optionally: if a future version renames it again, the
 * call sites stop compiling instead of quietly reverting to English.
 */
export function localeFromMatches(
  // `| undefined` because React Router's generated `Matches` includes it for the
  // routes a given path did not match. `loaderData` stays required on the rest,
  // which is what keeps a rename from compiling.
  matches: ReadonlyArray<{ readonly id: string; readonly loaderData: unknown } | undefined>,
): Locale {
  const rootData = matches.find((match) => match?.id === "root")?.loaderData;
  if (typeof rootData === "object" && rootData !== null && "locale" in rootData) {
    const locale = (rootData as { locale: unknown }).locale;
    if (isLocale(locale)) return locale;
  }
  return DEFAULT_LOCALE;
}

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: React.ReactNode;
}) {
  return <LocaleContext value={locale}>{children}</LocaleContext>;
}

export function useLocale(): Locale {
  return use(LocaleContext);
}

/**
 * The hook every component uses. Returns both forms plus the locale, because a
 * component that needs one of them usually needs another in the same JSX.
 *
 * Memoised on the locale, and that matters beyond saving two closures: without
 * it `t` is a new function identity on every render, so any `useEffect` that
 * honestly lists it as a dependency would re-run on every render. That is not
 * hypothetical — the toast on the inboxes page is exactly such an effect, and it
 * would fire again on each re-render while its action data was still present.
 */
export function useT() {
  const locale = useLocale();
  return useMemo(
    () => ({
      locale,
      t: <K extends MessageKey>(key: K, ...args: TextArgs<K>) =>
        translate(locale, key, ...args),
      rich: <K extends MessageKey>(key: K, ...args: NodeArgs<K>) =>
        interpolate(locale, key, ...args),
    }),
    [locale],
  );
}
