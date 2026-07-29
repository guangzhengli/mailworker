import { ERROR_CODES } from "@mailworker/contract";
import {
  DEFAULT_LOCALE,
  errorMessage,
  isErrorCode,
  LOCALES,
  negotiate,
  translate,
} from "@web/app/i18n";
import { localeFromRequest } from "@web/app/i18n/locale.server";
import { en } from "@web/app/i18n/locales/en";
import { zh } from "@web/app/i18n/locales/zh";
import { describe, expect, it } from "vitest";

/**
 * What `satisfies Catalog` cannot check, plus the negotiation it knows nothing
 * about.
 *
 * Key parity is a compile-time property already — a missing or invented key in
 * `zh.ts` fails `tsc`, which is the whole reason there is no extraction tool
 * here. These are the two things the type system genuinely cannot see: that a
 * translated message kept the placeholders its English original declared, and
 * that an `Accept-Language` header resolves the way it should.
 */

const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(text: string): ReadonlySet<string> {
  return new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] as string));
}

describe("catalogues", () => {
  it("keeps every placeholder through translation", () => {
    const drift: string[] = [];

    for (const [key, english] of Object.entries(en.messages)) {
      const translated = zh.messages[key as keyof typeof zh.messages];
      const expected = placeholders(english);
      const actual = placeholders(translated);

      const missing = [...expected].filter((name) => !actual.has(name));
      const extra = [...actual].filter((name) => !expected.has(name));

      // A dropped placeholder loses the address or command the sentence was
      // about; an invented one renders as a literal `{foo}` on the page. Both
      // are silent at runtime, which is why they are worth a test.
      if (missing.length > 0) drift.push(`${key}: zh is missing {${missing.join("}, {")}}`);
      if (extra.length > 0) drift.push(`${key}: zh has unknown {${extra.join("}, {")}}`);
    }

    expect(drift).toEqual([]);
  });

  it("covers every wire error code in every locale", () => {
    // `Record<ErrorCode, string>` already makes this a build error. The test is
    // here so that adding a code and running the suite says which locale is
    // short, rather than pointing at a mapped type.
    for (const locale of LOCALES) {
      for (const code of ERROR_CODES) {
        expect(errorMessage(locale, code), `${locale}/${code}`).not.toBe("");
      }
    }
  });

  it("does not leave English in the Chinese catalogue", () => {
    // Deliberate exceptions: brand and product names, and the environment
    // variables and commands a reader has to type verbatim.
    const allowed =
      /Mailworker|MAILWORKER_[A-Z_]+|API|SPF|DKIM|DMARC|Webhook|content type|id|bootstrap admin key|httpOnly|cookie|JavaScript|message/;
    const untranslated = Object.entries(zh.messages)
      .filter(([key, value]) => value === en.messages[key as keyof typeof en.messages])
      .filter(([, value]) => !allowed.test(value))
      // An em dash or a placeholder-only string is the same in both languages.
      .filter(([, value]) => /\p{Script=Latin}/u.test(value));

    expect(untranslated).toEqual([]);
  });
});

describe("negotiate", () => {
  it("falls back to English with no header", () => {
    expect(negotiate(null)).toBe("en");
    expect(negotiate("")).toBe(DEFAULT_LOCALE);
  });

  it("matches on the primary subtag", () => {
    expect(negotiate("zh-CN,zh;q=0.9")).toBe("zh");
    expect(negotiate("en-US,en;q=0.9")).toBe("en");
    // Simplified served to a Traditional reader beats English served to them.
    expect(negotiate("zh-TW")).toBe("zh");
    expect(negotiate("zh-Hant-HK")).toBe("zh");
  });

  it("honours quality values rather than order", () => {
    expect(negotiate("zh;q=0.2,en;q=0.9")).toBe("en");
    expect(negotiate("en;q=0.3,zh;q=0.8")).toBe("zh");
    // q=0 means "not acceptable", so this is a request for Chinese.
    expect(negotiate("en;q=0,zh;q=0.5")).toBe("zh");
  });

  it("skips languages it does not have", () => {
    expect(negotiate("de-DE,fr;q=0.8")).toBe("en");
    expect(negotiate("de-DE,zh;q=0.4")).toBe("zh");
    expect(negotiate("*")).toBe(DEFAULT_LOCALE);
  });
});

describe("localeFromRequest", () => {
  const withHeaders = (headers: Record<string, string>) =>
    new Request("https://mailworker.example/", { headers });

  it("prefers the cookie over the header", () => {
    expect(
      localeFromRequest(withHeaders({ Cookie: "mw_locale=zh", "Accept-Language": "en-US" })),
    ).toBe("zh");
    expect(
      localeFromRequest(withHeaders({ Cookie: "mw_locale=en", "Accept-Language": "zh-CN" })),
    ).toBe("en");
  });

  it("ignores a cookie that is not a locale we ship", () => {
    // The reader who picked a locale a later version dropped gets negotiation,
    // not a crash and not a hardcoded English.
    expect(
      localeFromRequest(withHeaders({ Cookie: "mw_locale=de", "Accept-Language": "zh-CN" })),
    ).toBe("zh");
  });

  it("finds its cookie among others", () => {
    expect(
      localeFromRequest(withHeaders({ Cookie: "mw_session=abc; mw_locale=zh; other=1" })),
    ).toBe("zh");
  });

  it("falls back to the header, then English", () => {
    expect(localeFromRequest(withHeaders({ "Accept-Language": "zh" }))).toBe("zh");
    expect(localeFromRequest(withHeaders({}))).toBe("en");
  });
});

describe("translate", () => {
  it("interpolates by name", () => {
    expect(translate("en", "inboxes.deleteAria", { address: "a@b.c" })).toBe("Delete a@b.c");
    expect(translate("zh", "inboxes.deleteAria", { address: "a@b.c" })).toBe("删除 a@b.c");
  });

  it("returns a plain message untouched", () => {
    expect(translate("en", "nav.inboxes")).toBe("Inboxes");
    expect(translate("zh", "nav.inboxes")).toBe("收件箱");
  });

  it("requires the variables a message declares", () => {
    // @ts-expect-error — `inboxes.deleteAria` contains {address}; omitting it is
    // what this whole typed-catalogue approach exists to catch.
    translate("en", "inboxes.deleteAria");

    // @ts-expect-error — and a misspelled variable is caught the same way.
    translate("en", "inboxes.deleteAria", { addres: "a@b.c" });
  });
});

describe("isErrorCode", () => {
  it("accepts the wire codes and nothing else", () => {
    expect(isErrorCode("inbox_not_found")).toBe(true);
    expect(isErrorCode("internal_error")).toBe(true);
    // What `statusText` used to carry, and what the error boundary must not
    // mistake for a code now that it carries the raw one.
    expect(isErrorCode("inbox not found")).toBe(false);
    expect(isErrorCode("Not Found")).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
  });
});
