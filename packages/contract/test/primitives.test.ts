import { durationMs, emailAddress, queryBool, toIso, ulid } from "@contract/primitives";
import { describe, expect, it } from "vitest";

describe("domain scalars", () => {
  it("normalizes through the domain's own parser, not a second grammar", () => {
    // Lowercasing the domain but NOT the local part is a rule that lives in
    // EmailAddress. Seeing it here proves this schema delegates rather than
    // reimplementing — which is the whole reason it is a transform.
    expect(emailAddress.parse("Alice@Example.COM")).toBe("Alice@example.com");
    expect(ulid.parse("01jzzzzzzzzzzzzzzzzzzzzzzz")).toBe("01JZZZZZZZZZZZZZZZZZZZZZZZ");
  });

  it("surfaces the domain's message on a bad value", () => {
    const failure = emailAddress.safeParse("not an address");
    expect(failure.success).toBe(false);
    expect(failure.error?.issues[0]?.message).toContain("not an address");
  });

  it("rejects a ULID with an excluded Crockford letter", () => {
    expect(ulid.safeParse("01ARZ3NDEKTSV4RRFFQ69G5FAI").success).toBe(false);
  });
});

describe("durationMs", () => {
  it("accepts suffixed spans", () => {
    expect(durationMs.parse("500ms")).toBe(500);
    expect(durationMs.parse("30s")).toBe(30_000);
    expect(durationMs.parse("10m")).toBe(600_000);
    expect(durationMs.parse("2h")).toBe(7_200_000);
    expect(durationMs.parse("7d")).toBe(604_800_000);
    expect(durationMs.parse("1.5h")).toBe(5_400_000);
  });

  it("accepts bare milliseconds, so an SDK can pass a computed number", () => {
    expect(durationMs.parse(600_000)).toBe(600_000);
  });

  it("rejects what looks like a duration but is not one", () => {
    for (const input of ["10 minutes", "10", "m10", "0s", "-5m", "1w", ""]) {
      expect(durationMs.safeParse(input).success, input).toBe(false);
    }
  });
});

describe("queryBool", () => {
  it("reads the spellings a shell actually produces", () => {
    expect(queryBool.parse("true")).toBe(true);
    expect(queryBool.parse("1")).toBe(true);
    expect(queryBool.parse("false")).toBe(false);
    expect(queryBool.parse("0")).toBe(false);
  });

  it("refuses to read an unknown string as true", () => {
    // `?seen=no` quietly meaning "seen" would be a miserable bug to find.
    expect(queryBool.safeParse("nope").success).toBe(false);
  });
});

describe("toIso", () => {
  it("keeps null as null", () => {
    expect(toIso(null)).toBeNull();
    expect(toIso(new Date("2026-07-01T12:00:00.000Z"))).toBe("2026-07-01T12:00:00.000Z");
  });
});
