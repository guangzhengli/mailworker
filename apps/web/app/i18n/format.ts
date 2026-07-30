import type { Locale } from "@web/app/i18n";

/**
 * Dates and relative times, per locale, via the platform.
 *
 * workerd ships full ICU, so this needs no data and no dependency: the same
 * option bags that produced `29 Jul 2026, 10:30:00` in English produce
 * `2026年7月29日 10:30:00` in Chinese. Verified in the workerd test pool rather
 * than assumed — Workers having complete locale data is the premise the whole
 * no-library decision rests on.
 */

/** The BCP 47 tag to format with. `en-GB` because the day-month order was the existing choice. */
const TAGS: Readonly<Record<Locale, string>> = { en: "en-GB", zh: "zh-CN" };

/** Exposed so `plural()` in `i18n/index.tsx` can reach `Intl.PluralRules` with the same tag. */
export function localeTag(locale: Locale): string {
  return TAGS[locale];
}

/**
 * Formatters are immutable and expensive to construct, so they are cached at
 * module scope. Safe in a reused isolate for exactly the reason a locale
 * singleton is not: there is nothing per-request in them, and the locale is part
 * of the cache key rather than hidden state.
 */
const absolute = new Map<Locale, Intl.DateTimeFormat>();
const relative = new Map<Locale, Intl.RelativeTimeFormat>();

function absoluteFor(locale: Locale): Intl.DateTimeFormat {
  const hit = absolute.get(locale);
  if (hit !== undefined) return hit;
  const made = new Intl.DateTimeFormat(TAGS[locale], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  });
  absolute.set(locale, made);
  return made;
}

function relativeFor(locale: Locale): Intl.RelativeTimeFormat {
  const hit = relative.get(locale);
  if (hit !== undefined) return hit;
  /**
   * `narrow` and `numeric: "always"` reproduce the hand-written formatter this
   * replaced, to the byte: `5m ago`, `3h ago`, `in 2d`. Chinese gets 5分钟前.
   *
   * `numeric: "auto"` would give "yesterday" and 明天, which read better in prose
   * and worse in a log table where every other row is a number.
   */
  const made = new Intl.RelativeTimeFormat(TAGS[locale], {
    style: "narrow",
    numeric: "always",
  });
  relative.set(locale, made);
  return made;
}

/**
 * UTC, always, and labelled as such in the UI.
 *
 * Rendered on the server, where the reader's timezone is unknown — a local time
 * formatted from a server guess is wrong in a way that is invisible, and this is
 * a log-reading tool where an hour's error changes the conclusion. Localising
 * the format does not change the zone.
 */
export function formatAbsolute(locale: Locale, date: Date): string {
  return absoluteFor(locale).format(date);
}

const UNITS: ReadonlyArray<{
  readonly limit: number;
  readonly per: number;
  readonly unit: Intl.RelativeTimeFormatUnit;
}> = [
  { limit: 60, per: 1, unit: "second" },
  { limit: 3600, per: 60, unit: "minute" },
  { limit: 86400, per: 3600, unit: "hour" },
  { limit: Number.POSITIVE_INFINITY, per: 86400, unit: "day" },
];

export function formatRelative(locale: Locale, date: Date, now: Date = new Date()): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const magnitude = Math.abs(seconds);
  const chosen = UNITS.find(({ limit }) => magnitude < limit) ?? UNITS[UNITS.length - 1];
  if (chosen === undefined) return "";
  // Rounded before it is signed, so that -90s and +90s both read as 2 of a unit.
  const value = Math.round(magnitude / chosen.per) * Math.sign(seconds);
  return relativeFor(locale).format(value, chosen.unit);
}
