import { readFileSync } from "node:fs";
import { AGENT_HELP } from "@cli/agent-help";
import { BEGIN, END, SKILL_REFERENCE } from "@cli/skill-reference";
import { describe, expect, it } from "vitest";

/**
 * The published skill carries a copy of `AGENT_HELP`, and a copy is a thing that
 * goes stale. This is the guard: a flag added to the CLI without regenerating
 * the reference fails here, rather than reaching an agent as documentation for a
 * surface that no longer exists.
 */
describe("the skill's CLI reference", () => {
  it("is AGENT_HELP verbatim", () => {
    const contents = readFileSync(SKILL_REFERENCE, "utf8");
    const start = contents.indexOf(BEGIN);
    const end = contents.indexOf(END);

    expect(start, `${SKILL_REFERENCE} is missing its BEGIN marker.`).toBeGreaterThan(-1);
    expect(end, `${SKILL_REFERENCE} is missing its END marker.`).toBeGreaterThan(start);

    const generated = contents.slice(start + BEGIN.length, end).trim();
    expect(generated, "Out of date. Run `pnpm --filter mailworker skill:sync`.").toBe(
      AGENT_HELP.trim(),
    );
  });
});
