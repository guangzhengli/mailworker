import { describe, expect, it } from "vitest";
import type { RfcMessageId, ThreadId } from "@/domain/index.ts";
import { RfcMessageId as Id, ThreadingPolicy } from "@/domain/index.ts";

const id = (value: string): RfcMessageId => Id.parse(value);
const thread = (value: string): ThreadId => value as ThreadId;

describe("ThreadingPolicy", () => {
  it("inherits the thread of the In-Reply-To parent", () => {
    const result = ThreadingPolicy.resolve({
      ownMessageId: id("new@x.com"),
      inReplyTo: id("parent@x.com"),
      references: [],
      known: new Map([["parent@x.com", thread("root@x.com")]]),
    });
    expect(result).toEqual({ threadId: "root@x.com", via: "in_reply_to" });
  });

  it("falls back to References when In-Reply-To is unknown", () => {
    const result = ThreadingPolicy.resolve({
      ownMessageId: id("new@x.com"),
      inReplyTo: id("missing@x.com"),
      references: [id("old@x.com")],
      known: new Map([["old@x.com", thread("root@x.com")]]),
    });
    expect(result).toEqual({ threadId: "root@x.com", via: "references" });
  });

  it("prefers the closest ancestor when several References are known", () => {
    // References runs oldest-first, so the LAST known entry is the nearest
    // parent. A forwarded chain that touches two conversations must join the
    // one it was most recently part of.
    const result = ThreadingPolicy.resolve({
      ownMessageId: id("new@x.com"),
      inReplyTo: null,
      references: [id("ancient@x.com"), id("recent@x.com")],
      known: new Map([
        ["ancient@x.com", thread("threadA@x.com")],
        ["recent@x.com", thread("threadB@x.com")],
      ]),
    });
    expect(result.threadId).toBe("threadB@x.com");
  });

  it("roots a new thread at its own id when no ancestor is known", () => {
    const result = ThreadingPolicy.resolve({
      ownMessageId: id("solo@x.com"),
      inReplyTo: id("stranger@x.com"),
      references: [id("also-unknown@x.com")],
      known: new Map(),
    });
    expect(result).toEqual({ threadId: "solo@x.com", via: "new_thread" });
  });

  it("orders candidate lookups parent-first and deduplicates", () => {
    const candidates = ThreadingPolicy.candidateIds(id("p@x.com"), [
      id("a@x.com"),
      id("b@x.com"),
      id("p@x.com"),
    ]);
    // In-Reply-To first, then References reversed (nearest ancestor first).
    expect(candidates).toEqual(["p@x.com", "b@x.com", "a@x.com"]);
  });

  it("normalizes angle brackets so ids from different headers compare equal", () => {
    expect(Id.parse("<abc@x.com>")).toBe(Id.parse("abc@x.com"));
    expect(Id.parseReferences("<a@x.com> <b@x.com>")).toEqual(["a@x.com", "b@x.com"]);
  });

  it("drops unparseable References entries rather than failing the message", () => {
    // A malformed References header must never block ingestion.
    expect(Id.parseReferences("<good@x.com> garbage <also-bad")).toEqual(["good@x.com"]);
  });
});
