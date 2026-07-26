import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Enforces ADR-5 mechanically instead of by convention.
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
    expect(referencesLayer("@core/ports", "ports")).toBe(true);
    expect(referencesLayer("@core/ports/transport", "ports")).toBe(true);
    expect(referencesLayer("../ports", "ports")).toBe(true);
    expect(referencesLayer("../../src/testing", "testing")).toBe(true);
    expect(referencesLayer("@core/domain", "ports")).toBe(false);
    // Must not fire on a filename that merely contains the layer name.
    expect(referencesLayer("@core/domain/transporters", "transport")).toBe(false);
  });

  it("keeps the domain from importing ports or application code", () => {
    const offenders: string[] = [];
    for (const file of filesUnder(join(SRC, "domain"))) {
      for (const specifier of importsOf(file)) {
        if (referencesLayer(specifier, "ports") || referencesLayer(specifier, "application")) {
          offenders.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
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
