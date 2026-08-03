import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Enforces the layering rule mechanically instead of by convention.
 *
 * A lint rule would work too, but this runs in the same command as everything
 * else and fails with the offending file named, which is what someone adding a
 * D1 query to a policy actually needs to see.
 */

const SRC = join(import.meta.dirname, "..", "src");

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function importsOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
}

const FORBIDDEN_IN_DOMAIN = [
  "@cloudflare/",
  "cloudflare:",
  "node:",
  "drizzle",
  "hono",
  "postal-mime",
];

describe("layering", () => {
  it("keeps the domain free of infrastructure imports", () => {
    const offenders: string[] = [];
    for (const file of filesUnder(join(SRC, "domain"))) {
      for (const specifier of importsOf(file)) {
        if (FORBIDDEN_IN_DOMAIN.some((banned) => specifier.startsWith(banned))) {
          offenders.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("detects a layer reference in either import style", () => {
    // A guard that matches nothing passes vacuously, and this one has gone
    // blind twice already: once when imports moved from `../ports/…` to
    // `@/ports/…`, and again when the `.ts` extension and the `/index` segment
    // were dropped, which left a barrel import as the bare `@core/ports` this
    // regex used to need a trailing slash to see. Assert it still bites.
    expect(referencesLayer("@core/domain/ports", "ports")).toBe(true);
    expect(referencesLayer("@core/domain/ports/transport", "ports")).toBe(true);
    expect(referencesLayer("../ports", "ports")).toBe(true);
    expect(referencesLayer("../../src/testing", "testing")).toBe(true);
    expect(referencesLayer("@core/domain", "ports")).toBe(false);
    // Must not fire on a filename that merely contains the layer name.
    expect(referencesLayer("@core/domain/transporters", "transport")).toBe(false);
  });

  it("keeps the domain from importing application code", () => {
    const offenders: string[] = [];
    for (const file of filesUnder(join(SRC, "domain"))) {
      for (const specifier of importsOf(file)) {
        if (referencesLayer(specifier, "application")) {
          offenders.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The bounded contexts, as a rule rather than a diagram.
   *
   * Declaring four contexts in prose and then dumping every type into one
   * directory is how "which domain does this belong to" becomes unanswerable.
   * This is the answer, and it fails the build when someone contradicts it.
   *
   *     identity  ←  mailbox  ←  ingestion
   *                     ↑
   *                  delivery
   *
   * Read the arrow as "may import": ingestion knows about mailboxes, mailbox
   * knows nothing about how mail got there. `ports/` is exempt in one
   * direction — it is where the whole domain states its needs, so it names
   * types from every context and no context imports it back.
   */
  const MAY_IMPORT: Readonly<Record<string, readonly string[]>> = {
    identity: [],
    mailbox: ["identity"],
    ingestion: ["mailbox", "identity"],
    delivery: ["mailbox", "identity"],
  };

  it.each(Object.keys(MAY_IMPORT))(
    "keeps the %s context within its dependencies",
    (context) => {
      const allowed = new Set([context, ...MAY_IMPORT[context]!]);
      const offenders: string[] = [];
      for (const file of filesUnder(join(SRC, "domain", context))) {
        for (const specifier of importsOf(file)) {
          const target = contextOf(specifier);
          if (target !== null && !allowed.has(target)) {
            offenders.push(`${relative(SRC, file)} imports ${specifier}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  it("keeps the shared vocabulary from depending on any context", () => {
    // `errors`, `ulid`, `pagination` and `blob-keys` sit under every context.
    // The moment one of them imports a context it has become a fifth context
    // with none of the rules, and the arrows above stop meaning anything.
    // `events` is the deliberate exception: it names facts from all four.
    const offenders: string[] = [];
    for (const file of filesUnder(join(SRC, "domain"))) {
      const name = relative(join(SRC, "domain"), file);
      if (name.includes("/") || name === "events.ts" || name === "index.ts") continue;
      for (const specifier of importsOf(file)) {
        const target = contextOf(specifier);
        if (target !== null) offenders.push(`${name} imports ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("recognises a context in a specifier", () => {
    expect(contextOf("@core/domain/mailbox/inbox")).toBe("mailbox");
    expect(contextOf("@core/domain/identity")).toBe("identity");
    expect(contextOf("@core/domain/errors")).toBe(null);
    expect(contextOf("@core/domain/ports/system")).toBe(null);
    // A barrel import pulls in all four, so it is never allowed inside one.
    expect(contextOf("@core/domain")).toBe("*");
  });

  it("reaches other packages only through their public export", () => {
    // Nothing stops `@mime/parse` from resolving inside this package — the
    // alias map is global. So the encapsulation rule is enforced here instead
    // of relying on resolution to fail: cross-package imports go through
    // `@mailworker/<pkg>`, never into another package's src.
    const offenders: string[] = [];
    for (const file of filesUnder(SRC)) {
      for (const specifier of importsOf(file)) {
        if (isForeignDeepImport(specifier)) {
          offenders.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the application layer off concrete adapters", () => {
    const offenders: string[] = [];
    for (const file of filesUnder(join(SRC, "application"))) {
      for (const specifier of importsOf(file)) {
        if (referencesLayer(specifier, "testing") || specifier.includes("infrastructure")) {
          offenders.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * True when `specifier` points into `layer`, in either the `@core/layer/…`
 * alias form or a relative `…/layer/…` one. The segment must end at a slash or
 * at the end of the specifier — the latter because a barrel import is written
 * `@core/ports`, the former so `domain/transporters` does not read as the
 * `transport` layer.
 */
function referencesLayer(specifier: string, layer: string): boolean {
  return new RegExp(`(^@[a-z]*/|/)${layer}(/|$)`).test(specifier);
}

const CONTEXTS = ["identity", "mailbox", "ingestion", "delivery"] as const;

/**
 * Which bounded context a specifier points into, or null for the shared
 * vocabulary, the ports and anything outside the domain.
 *
 * `"*"` for a bare `@core/domain` barrel import: it drags in all four contexts
 * at once, so from inside a context it is always a violation — and saying so
 * with a distinct marker gives a clearer failure than pretending it is one
 * specific context.
 */
function contextOf(specifier: string): string | null {
  if (specifier === "@core/domain") return "*";
  const match = /^@core\/domain\/([a-z-]+)/.exec(specifier);
  if (match === null) return null;
  return (CONTEXTS as readonly string[]).includes(match[1]!) ? match[1]! : null;
}

/**
 * A path alias pointing into ANOTHER package's source.
 *
 * `@core/*` is this package's own alias; `@mailworker/*` is a public entry
 * point. Anything else `@`-prefixed and local (`@mime/parse`) is a deep
 * import that skips the other package's export map.
 */
function isForeignDeepImport(specifier: string): boolean {
  return /^@/.test(specifier) && !/^@(core\/|mailworker\/)/.test(specifier);
}
