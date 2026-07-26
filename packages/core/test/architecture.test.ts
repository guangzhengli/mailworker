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
    // A guard that matches nothing passes vacuously. When imports moved from
    // `../ports/index.ts` to `@/ports/index.ts`, the old substring checks went
    // silently blind — so assert the detector still bites before trusting it.
    expect(referencesLayer("@/ports/index.ts", "ports")).toBe(true);
    expect(referencesLayer("../ports/index.ts", "ports")).toBe(true);
    expect(referencesLayer("../../src/testing/index.ts", "testing")).toBe(true);
    expect(referencesLayer("@/domain/index.ts", "ports")).toBe(false);
    // Must not fire on a filename that merely contains the layer name.
    expect(referencesLayer("@/domain/transporters.ts", "transport")).toBe(false);
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
 * True when `specifier` points into `layer`, in either the `@/layer/…` alias
 * form or a relative `…/layer/…` one. Requires a following slash so that
 * `transporters.ts` does not read as the `transport` layer.
 */
function referencesLayer(specifier: string, layer: string): boolean {
  return new RegExp(`(^@/|/)${layer}/`).test(specifier);
}
