import {
  decodeStoredMessageBody,
  encodeStoredMessageBody,
  MESSAGE_INDEX_TEXT_BYTES,
  truncateUtf8,
} from "@core/domain";
import { describe, expect, it } from "vitest";

describe("stored message bodies", () => {
  it("truncates on a UTF-8 boundary measured in bytes", () => {
    const value = "你".repeat(MESSAGE_INDEX_TEXT_BYTES);
    const truncated = truncateUtf8(value, MESSAGE_INDEX_TEXT_BYTES);
    expect(new TextEncoder().encode(truncated!).byteLength).toBeLessThanOrEqual(
      MESSAGE_INDEX_TEXT_BYTES,
    );
    expect(truncated?.endsWith("�")).toBe(false);
  });

  it("round-trips nullable text and HTML without changing the public body shape", () => {
    const body = { bodyText: "hello", bodyHtml: null };
    expect(decodeStoredMessageBody(encodeStoredMessageBody(body))).toEqual(body);
  });

  it("rejects corrupt or incorrectly shaped body objects", () => {
    expect(() => decodeStoredMessageBody(new TextEncoder().encode("not-json"))).toThrow();
    expect(() =>
      decodeStoredMessageBody(new TextEncoder().encode('{"bodyText":42,"bodyHtml":null}')),
    ).toThrow();
  });
});
