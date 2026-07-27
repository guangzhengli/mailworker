import { createContext, use, useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "mailworker-theme";

/**
 * The page background per resolved theme, as a literal.
 *
 * Duplicating `--background` from styles.css is deliberate and the duplication
 * is the point: ThemeScript runs before any stylesheet has arrived, so it
 * cannot read a custom property that does not exist yet. Without it the browser
 * paints its own default white in the gap between navigation and CSS — a white
 * flash on every hard reload in dark mode. styles.css remains the source of
 * truth and overrides these the moment it loads.
 */
const PAGE_BG: Record<ResolvedTheme, string> = {
  light: "oklch(0.9700 0.0029 264.5420)",
  dark: "oklch(0.1492 0.0093 263.9667)",
};

type ThemeContextValue = {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => {},
});

export function useTheme() {
  return use(ThemeContext);
}

function resolve(theme: Theme): ResolvedTheme {
  if (theme !== "system") return theme;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function apply(resolved: ResolvedTheme) {
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.style.backgroundColor = PAGE_BG[resolved];
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  /**
   * "system" on both sides of hydration, always.
   *
   * The server cannot know what is in localStorage, so any other initial value
   * would be a guess that React reconciles into a mismatch warning and a
   * one-frame flicker. ThemeScript has already put the correct class on <html>
   * by this point — this state only has to catch up, and the effect below does
   * that after mount without React ever having rendered the wrong thing.
   */
  const [theme, setThemeState] = useState<Theme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("light");

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const initial: Theme =
      stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
    setThemeState(initial);
    setResolvedTheme(resolve(initial));
  }, []);

  /** Only while following the system: an explicit choice must not be overridden. */
  useEffect(() => {
    if (theme !== "system") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const next = resolve("system");
      setResolvedTheme(next);
      apply(next);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    const resolved = resolve(next);
    setThemeState(next);
    setResolvedTheme(resolved);
    localStorage.setItem(STORAGE_KEY, next);
    apply(resolved);
  }, []);

  return <ThemeContext value={{ theme, resolvedTheme, setTheme }}>{children}</ThemeContext>;
}

/**
 * Runs in <head>, before first paint, before hydration.
 *
 * Everything it touches — the class and the inline background — is what the
 * provider above would have set anyway; doing it here just means it happens
 * before the user can see the wrong version. Kept to one statement per line and
 * wrapped in try/catch because a thrown error here blocks the whole document.
 */
export function ThemeScript() {
  const script = `
(function () {
  try {
    var stored = localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
    var dark =
      stored === "dark" ||
      ((!stored || stored === "system") &&
        window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
    document.documentElement.style.backgroundColor = dark
      ? ${JSON.stringify(PAGE_BG.dark)}
      : ${JSON.stringify(PAGE_BG.light)};
  } catch (e) {}
})();
`.trim();

  // biome-ignore lint/security/noDangerouslySetInnerHtml: the script is static except JSON-encoded constants.
  return <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: script }} />;
}
