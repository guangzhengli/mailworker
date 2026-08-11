#!/usr/bin/env node
import { run } from "@cli/main";

/**
 * The executable. Nothing but the process boundary lives here — argv in, exit
 * code out — so that `run` stays a function a test can call with a fake client
 * and assert on, rather than something that can only be observed by spawning a
 * shell.
 *
 * `exitCode` rather than `process.exit()`: exiting immediately truncates stdout
 * when it is a pipe, which is exactly the case that matters —
 * `BODY=$(mailworker wait --text)` would intermittently come back truncated.
 */
process.exitCode = await run(process.argv.slice(2));
