import { writeFileSync } from "node:fs";
import { AGENT_HELP } from "@cli/agent-help";
import { BEGIN, END, HEADER, SKILL_REFERENCE } from "@cli/skill-reference";

/**
 * Writes `AGENT_HELP` into the published skill's reference file.
 *
 * The skill and the CLI describe the same surface, so one of them has to be
 * derived from the other or they drift — and a skill that documents a flag the
 * CLI dropped is worse than no skill, because an agent will believe it.
 * `test/skill-reference.test.ts` fails when the file and `AGENT_HELP` disagree,
 * which is what makes running this a step you cannot forget rather than one you
 * are supposed to remember.
 */
writeFileSync(SKILL_REFERENCE, `${HEADER}${BEGIN}\n\n${AGENT_HELP}\n${END}\n`);
process.stdout.write(`${SKILL_REFERENCE}\n`);
