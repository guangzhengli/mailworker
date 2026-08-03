import { Ulid } from "@mailworker/core";
import { UlidGenerator } from "@web/workers/adapters";
import { describe, expect, it } from "vitest";

describe("UlidGenerator", () => {
  it("mints ids that are strictly increasing inside one millisecond", () => {
    // The property keyset pagination depends on. A plain timestamp+random ULID
    // fails this roughly half the time per adjacent pair, which is how a cursor
    // ends up skipping a message that arrived in the same millisecond.
    const ids = new UlidGenerator();
    const minted = Array.from({ length: 500 }, () => ids.ulid());

    const sorted = [...minted].sort(Ulid.compare);
    expect(minted).toEqual(sorted);
    expect(new Set(minted).size).toBe(minted.length);
  });

  it("mints Message-IDs that parse and carry the sending domain", () => {
    const id = new UlidGenerator().rfcMessageId("mail.example.com");
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}@mail\.example\.com$/);
  });
});
