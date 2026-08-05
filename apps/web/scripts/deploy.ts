/**
 * `vite build && wrangler deploy` plus the steps that are mechanical enough to
 * automate — and a hard stop in front of the two that are not.
 *
 * The bare pair is correct for a code-only change, which is most of them.
 * Everything below exists because a handful of changes need one extra step in a
 * specific order, and the cost of getting that order wrong is production
 * errors for the length of a deploy, or mail that never goes out. The rule this
 * follows throughout: automate what has one right answer, refuse what needs a
 * decision. Never guess in between.
 *
 *   pnpm ship
 *   pnpm ship --dry-run     # guards and plan only, nothing is changed
 *
 * `ship`, not `deploy`, because `pnpm deploy` is a pnpm built-in: it parses the
 * flags itself and `--dry-run` never reaches this file — which is how a dry run
 * shipped a real deploy once already. The `deploy` script still points here for
 * muscle memory, but flags only survive as `pnpm run deploy -- --dry-run`.
 *
 * What it will not do, ever: create a resource for a new binding, or decide
 * that a queue payload change is safe. Those are `update-mailworker`'s.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(WEB_DIR, "wrangler.jsonc");
const MIGRATIONS = join(WEB_DIR, "migrations");
const DB = "mailworker";
const WORKER = "mailworker";

/** Deploy is a mutation; --dry-run stops after the plan. */
const DRY_RUN = process.argv.includes("--dry-run");

/**
 * SQL that the still-running old code could trip over.
 *
 * Matched on the statement text because that is the only signal available —
 * drizzle does not label its output. Deliberately over-eager: a false positive
 * costs one `-- mailworker: after-deploy` line, a false negative costs an
 * outage. `__new_` catches drizzle's table-rebuild, which is how SQLite spells
 * every column drop and constraint change.
 */
const DESTRUCTIVE = [
  /\bDROP\s+TABLE\b/i,
  /\bDROP\s+COLUMN\b/i,
  /\bRENAME\s+(TO|COLUMN)\b/i,
  /__new_/i,
];

/** Opt out of the ordering guess, per file. */
const AFTER_DEPLOY_MARKER = /^--\s*mailworker:\s*after-deploy\b/im;

function run(command: string, args: string[], capture = false): string {
  const output = execFileSync(command, args, {
    cwd: WEB_DIR,
    encoding: "utf8",
    stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit",
  });
  return output ?? "";
}

const wrangler = (args: string[], capture = false) =>
  run("./node_modules/.bin/wrangler", args, capture);

function fail(reason: string, fix: string[]): never {
  console.error(`\n✗ ${reason}\n`);
  for (const line of fix) console.error(`  ${line}`);
  console.error("");
  process.exit(1);
}

/**
 * The two edits this repo keeps out of git on purpose.
 *
 * They live only in the working tree, so any checkout, stash or fresh clone
 * loses them — and the resulting deploy fails in a way that does not name the
 * cause. Checking the raw text rather than parsing JSONC because that is all
 * this needs, and a comment-stripping parser is one more thing to be wrong.
 */
function checkConfig(): void {
  const text = readFileSync(CONFIG, "utf8");

  if (text.includes("PLACEHOLDER_RUN_MAILWORKER_DEPLOY")) {
    fail("wrangler.jsonc still carries the placeholder database_id.", [
      "The real id is not committed. Restore it:",
      '  "database_id": "<the uuid from `wrangler d1 list`>"',
    ]);
  }

  if (/"new_classes"/.test(text)) {
    fail("wrangler.jsonc uses new_classes, not new_sqlite_classes.", [
      "Cloudflare no longer creates KV-backed Durable Object namespaces, and",
      "MessageWaiter is already registered as SQLite. Change it back to:",
      '  "new_sqlite_classes": ["MessageWaiter"]',
    ]);
  }
}

/**
 * Every bound Durable Object class must appear somewhere in the migration
 * history, or the deploy fails with an error that does not say which class.
 *
 * Reads the config wrangler itself resolved during the build — plain JSON, no
 * comments, and the same bytes that are about to ship.
 */
function checkDurableObjects(): void {
  const resolved = join(WEB_DIR, "build/server/wrangler.json");
  if (!existsSync(resolved)) return;

  const config = JSON.parse(readFileSync(resolved, "utf8"));
  const bound: string[] = (config.durable_objects?.bindings ?? []).map(
    (binding: { class_name: string }) => binding.class_name,
  );
  const migrated = new Set<string>();
  for (const entry of config.migrations ?? []) {
    for (const name of entry.new_sqlite_classes ?? []) migrated.add(name);
    for (const name of entry.new_classes ?? []) migrated.add(name);
    for (const rename of entry.renamed_classes ?? []) migrated.add(rename.to);
  }

  const missing = bound.filter((name) => !migrated.has(name));
  if (missing.length > 0) {
    const tag = `v${(config.migrations?.length ?? 0) + 1}`;
    fail(`Durable Object class not in any migration: ${missing.join(", ")}`, [
      "Append an entry to migrations[] in wrangler.jsonc — the history is",
      "append-only, so add to it rather than editing what is there:",
      `  { "tag": "${tag}", "new_sqlite_classes": ${JSON.stringify(missing)} }`,
      "",
      "A rename is `renamed_classes`, and `wrangler rollback` cannot undo either.",
    ]);
  }
}

interface MigrationPlan {
  readonly before: string[];
  readonly after: string[];
}

/**
 * Split the unapplied migrations by which side of the deploy they belong on.
 *
 * Expand/contract: additive DDL goes first, because old code ignores a column
 * it does not know about. Destructive DDL goes last, because the old code is
 * still running and still querying what is about to disappear. Getting it
 * backwards is errors for the length of the deploy, which is why an
 * unclassifiable file stops here instead of picking a side.
 */
function planMigrations(): MigrationPlan {
  const listed = wrangler(["d1", "migrations", "list", DB, "--remote"], true);
  if (/No migrations to apply/i.test(listed)) return { before: [], after: [] };

  const pending = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith(".sql") && listed.includes(name))
    .sort();

  const before: string[] = [];
  const after: string[] = [];
  const ambiguous: string[] = [];

  for (const name of pending) {
    const sql = readFileSync(join(MIGRATIONS, name), "utf8");
    if (AFTER_DEPLOY_MARKER.test(sql)) {
      after.push(name);
    } else if (DESTRUCTIVE.some((pattern) => pattern.test(sql))) {
      ambiguous.push(name);
    } else {
      before.push(name);
    }
  }

  if (ambiguous.length > 0) {
    fail(
      `Migration looks destructive, so its order is not mine to guess: ${ambiguous.join(", ")}`,
      [
        "A dropped column, a dropped table, a rename or a drizzle table-rebuild",
        "must run AFTER the deploy — the old code is still querying it until then.",
        "",
        "If that is what this is, put this on the first line of the file:",
        "  -- mailworker: after-deploy",
        "",
        "If it is additive and only matched the pattern by accident, say so the",
        "same way — the marker only moves it after the deploy, which is safe for",
        "an additive change too.",
        "",
        "Take an export first either way; a successful migration can still be the",
        "wrong one, and this is the only copy you control:",
        `  wrangler d1 export ${DB} --remote --output backup.sql`,
      ],
    );
  }

  return { before, after };
}

/**
 * The version to roll back to, written down before it stops being obvious.
 *
 * After the deploy it is one entry down a list; before, it is unambiguous.
 */
function recordRollbackTarget(): string | null {
  const status = wrangler(["deployments", "status", "--name", WORKER], true);
  const version = /Version\(s\):\s*\(100%\)\s*([0-9a-f-]{36})/.exec(status)?.[1] ?? null;
  if (version === null) return null;

  const target = join(WEB_DIR, ".wrangler", "previous-version-id");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${version}\n`);
  return version;
}

/**
 * The one thing here that only warns.
 *
 * At the moment of a deploy the dispatch queue may still hold messages the old
 * code enqueued, which the new consumer will read. A shape it cannot parse
 * retries three times and lands in the DLQ — for dispatch, that is mail that
 * never went out. No static check can tell a compatible interface edit from an
 * incompatible one, so this points at the file and stops pretending.
 */
function warnOnQueuePayload(): void {
  const changed = run(
    "git",
    ["status", "--porcelain", "workers/adapters/queues.ts"],
    true,
  ).trim();
  if (changed === "") return;

  console.warn("\n⚠ workers/adapters/queues.ts has uncommitted changes.");
  console.warn("  If QueuedDispatch changed shape, this deploy needs to be two:");
  console.warn("  first a consumer reading both shapes, then the producer once the");
  console.warn("  queue has drained. A shape the new consumer cannot read is mail lost");
  console.warn("  to the DLQ. `toQueuedDispatch` is where the tolerance lives.\n");
}

/** Where to prove the deploy landed. The workers.dev name is not always reachable. */
function deploymentUrl(): string | null {
  if (process.env.MAILWORKER_DEPLOY_URL !== undefined) return process.env.MAILWORKER_DEPLOY_URL;
  const route = /"pattern":\s*"([^"]+)"/.exec(readFileSync(CONFIG, "utf8"))?.[1];
  return route === undefined ? null : `https://${route}`;
}

/**
 * A deploy that printed "Deployed" is not a deploy that works.
 *
 * 401 from `/v1` is the pass: the router is alive and correctly refusing an
 * unauthenticated request. Retried because routes and assets propagate after
 * the deploy prints, and the transient failure reads exactly like a real one.
 */
async function smokeTest(url: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const response = await fetch(`${url}/v1`);
      if (response.status === 401) {
        console.log(`✓ ${url}/v1 → 401`);
        return;
      }
      console.log(`  ${url}/v1 → ${response.status}, retrying…`);
    } catch (error) {
      console.log(`  ${url} unreachable (${String(error)}), retrying…`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.error(`\n⚠ ${url}/v1 never answered 401. The deploy may still be fine —`);
  console.error("  check the URL by hand before rolling back.");
  console.error(`  Rollback: wrangler rollback $(cat .wrangler/previous-version-id)\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  checkConfig();
  const plan = planMigrations();
  warnOnQueuePayload();

  console.log("\nPlan:");
  if (plan.before.length > 0) console.log(`  migrate (additive)  ${plan.before.join(", ")}`);
  console.log("  build");
  console.log("  deploy");
  if (plan.after.length > 0) console.log(`  migrate (destructive) ${plan.after.join(", ")}`);
  if (plan.before.length === 0 && plan.after.length === 0)
    console.log("  (no migrations pending)");

  if (DRY_RUN) {
    console.log("\n--dry-run: nothing was changed.\n");
    return;
  }

  const rollbackTo = recordRollbackTarget();
  if (rollbackTo !== null) console.log(`\nRollback target: ${rollbackTo}`);

  if (plan.before.length > 0) {
    wrangler(["d1", "migrations", "apply", DB, "--remote"]);
  }

  // Never skipped. assets.directory points at build/client, so a deploy without
  // a build ships new Worker code beside the previous dashboard bundle — a
  // mismatch that reads as a caching bug.
  run("./node_modules/.bin/vite", ["build"]);
  checkDurableObjects();
  wrangler(["deploy"]);

  if (plan.after.length > 0) {
    wrangler(["d1", "migrations", "apply", DB, "--remote"]);
  }

  const url = deploymentUrl();
  if (url === null) {
    console.log("\nNo route in wrangler.jsonc; set MAILWORKER_DEPLOY_URL to smoke-test.\n");
    return;
  }
  await smokeTest(url);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
