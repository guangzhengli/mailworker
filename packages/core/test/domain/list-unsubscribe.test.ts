import { LabelName, ListUnsubscribe } from "@core/domain";
import { describe, expect, it } from "vitest";

const POST = "List-Unsubscribe=One-Click";

describe("ListUnsubscribe", () => {
  it("selects the first HTTPS and mailto URIs and ignores comments and folding", () => {
    expect(
      ListUnsubscribe.parse(
        "(fake <https://invalid.example> (nested)) <http://example.com/old>, " +
          "<MAILTO:leave@example.com?subject=unsubscribe> (email),\r\n " +
          "< https://example.com/\r\n leave?token=a,b >, <https://example.com/other>",
        ` ${POST}  `,
      ),
    ).toEqual({
      https: "https://example.com/leave?token=a,b",
      mailto: "MAILTO:leave@example.com?subject=unsubscribe",
      oneClick: true,
    });
  });

  it.each([
    null,
    "<http://example.com/leave>",
    "<javascript:alert(1)>",
    "https://example.com/leave",
    "unparseable, <https://example.com/leave>",
    "<https://>",
  ])("ignores an unsupported or malformed list (%s)", (header) => {
    expect(ListUnsubscribe.parse(header, POST)).toBeNull();
  });

  it("requires both the post marker and an HTTPS URI to indicate one-click", () => {
    expect(ListUnsubscribe.parse("<mailto:leave@example.com>", POST)).toMatchObject({
      https: null,
      oneClick: false,
    });
    expect(ListUnsubscribe.parse("<https://example.com/leave>", null)).toMatchObject({
      oneClick: false,
    });
    expect(
      ListUnsubscribe.parse("<https://example.com/leave>", `${POST}; other=true`),
    ).toMatchObject({ oneClick: false });
  });
});

describe("LabelName", () => {
  it("normalizes display names and uses case-insensitive NFC keys", () => {
    expect(LabelName.parse("  Cafe\u0301   Requests  ")).toBe("Café Requests");
    expect(LabelName.key("  CAFÉ   Requests  ")).toBe("café requests");
  });

  it.each(["", "  ", "system:internal", "SYSTEM:internal", "a\0b", "a\u0085b", "a".repeat(41)])(
    "rejects reserved, empty, oversized and control-containing names (%s)",
    (name) =>
      expect(() => LabelName.parse(name)).toThrow(
        expect.objectContaining({ code: "invalid_argument" }),
      ),
  );
});
