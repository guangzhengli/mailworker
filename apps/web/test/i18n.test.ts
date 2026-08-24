import { ERROR_CODES } from "@mailworker/contract";
import { plural, translate } from "@web/app/i18n";
import { en } from "@web/app/i18n/locales/en";
import { zh } from "@web/app/i18n/locales/zh";
import { describe, expect, it } from "vitest";

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function extractPlaceholders(text: string): string[] {
  const matches = text.matchAll(PLACEHOLDER_RE);
  return Array.from(matches, (m) => m[1] as string).sort();
}

describe("i18n message catalogs", () => {
  it("en and zh have identical message keys", () => {
    const enKeys = Object.keys(en.messages).sort();
    const zhKeys = Object.keys(zh.messages).sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("en and zh have identical placeholders for every message", () => {
    for (const key of Object.keys(en.messages) as Array<keyof typeof en.messages>) {
      const enPlaceholders = extractPlaceholders(en.messages[key]);
      const zhPlaceholders = extractPlaceholders(zh.messages[key]);
      expect(zhPlaceholders, `Key ${key} placeholder mismatch`).toEqual(enPlaceholders);
    }
  });

  it("all ERROR_CODES exist in en and zh errors", () => {
    for (const code of ERROR_CODES) {
      expect(en.errors[code], `Missing en error for ${code}`).toBeDefined();
      expect(zh.errors[code], `Missing zh error for ${code}`).toBeDefined();
      expect(en.errors[code].length).toBeGreaterThan(0);
      expect(zh.errors[code].length).toBeGreaterThan(0);
    }
  });

  it("translates text with placeholders", () => {
    expect(translate("en", "common.cancel")).toBe("Cancel");
    expect(translate("zh", "common.cancel")).toBe("取消");
    expect(translate("en", "overview.byAgent", { agent: "support-bot" })).toBe(
      "Agent support-bot",
    );
    expect(translate("zh", "overview.byAgent", { agent: "support-bot" })).toBe(
      "Agent support-bot",
    );
  });

  it("pluralizes correctly", () => {
    expect(plural("en", "body.blocked", 1)).toBe("1 remote image blocked.");
    expect(plural("en", "body.blocked", 3)).toBe("3 remote images blocked.");
    expect(plural("zh", "body.blocked", 1)).toBe("已拦截 1 张远程图片。");
    expect(plural("zh", "body.blocked", 3)).toBe("已拦截 3 张远程图片。");
  });
});
