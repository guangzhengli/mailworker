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

  it("keeps the domain from importing ports or application code", () => {
    const offenders: string[] = [];
    for (const file of filesUnder(join(SRC, "domain"))) {
      for (const specifier of importsOf(file)) {
        if (specifier.includes("../ports") || specifier.includes("../application")) {
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
        if (specifier.includes("../testing") || specifier.includes("infrastructure")) {
          offenders.push(`${file} imports ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
