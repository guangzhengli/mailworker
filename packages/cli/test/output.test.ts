import { messageTable } from "@cli/output";
import type { MessageSummaryDto } from "@mailworker/contract";
import { describe, expect, it } from "vitest";

/**
 * Column alignment, which is a display-width question and not a character
 * count.
 *
 * A CJK ideograph occupies two terminal cells. `padEnd` counts UTF-16 code
 * units, so before this every row of Chinese mail overran its column and
 * `mailworker ls` stopped producing a table. Asserting on the width of the text
 * before the subject is the only way to catch that — the string lengths differ
 * between these rows even when the rendering is correct.
 */
function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3041 && code <= 0x33ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0x1f300 && code <= 0x1f64f) ||
      (code >= 0x1f900 && code <= 0x1f9ff);
    width += wide ? 2 : 1;
  }
  return width;
}

const SUBJECT = "SUBJECT-SENTINEL";

function row(from: string): MessageSummaryDto {
  return {
    id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    from,
    fromHeader: from,
    subject: SUBJECT,
    seen: true,
    provenance: { trusted: true },
  } as unknown as MessageSummaryDto;
}

/** Where the subject begins, measured in terminal cells. */
function subjectColumn(from: string): number {
  const line = messageTable([row(from)]);
  return displayWidth(line.slice(0, line.indexOf(SUBJECT)));
}

describe("messageTable", () => {
  it("starts the subject at the same column whatever the script", () => {
    const ascii = subjectColumn("alice@corp.com");

    for (const from of [
      "张伟 <zhangwei@corp.com>",
      "客户支持团队@例子.中国",
      "山田太郎 <yamada@corp.jp>",
      "홍길동 <hong@corp.kr>",
      "😀 <emoji@corp.com>",
      "x@y.z",
    ]) {
      expect(subjectColumn(from), from).toBe(ascii);
    }
  });

  it("keeps the column when a wide value has to be truncated", () => {
    // The ellipsis gets its own cell, and a two-cell glyph cannot be cut in
    // half to make room for it — so the truncation point has to be chosen by
    // width too, not by index.
    const ascii = subjectColumn("alice@corp.com");
    expect(subjectColumn("这是一个非常非常长的中文发件人名字需要被截断掉")).toBe(ascii);
    expect(subjectColumn("a-very-long-ascii-sender-address@example.com")).toBe(ascii);
  });

  it("truncates with an ellipsis rather than silently cutting", () => {
    expect(messageTable([row("这是一个非常非常长的中文发件人名字需要被截断掉")])).toContain(
      "…",
    );
  });
});
