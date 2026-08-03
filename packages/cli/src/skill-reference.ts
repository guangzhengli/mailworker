import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where the generated copy of `AGENT_HELP` lives, and the markers that delimit
 * it. Shared by the sync script and the test that guards it, so "which file"
 * and "which markers" cannot be answered differently by the writer and the
 * checker.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

export const SKILL_REFERENCE = join(
  HERE,
  "..",
  "..",
  "..",
  "skills",
  "mailworker",
  "references",
  "cli.md",
);

export const BEGIN = "<!-- BEGIN mailworker help --agent -->";
export const END = "<!-- END mailworker help --agent -->";

export const HEADER = `# The \`mailworker\` command surface

**Generated — do not edit by hand.** This is \`mailworker help --agent\` verbatim:
the compact reference the CLI prints for an LLM, listing the whole callable
surface, the argument shapes and the exit codes in one read.

Regenerate after any change to the command surface:

\`\`\`sh
pnpm --filter @mailworker/cli skill:sync
\`\`\`

`;
