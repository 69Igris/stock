#!/usr/bin/env node
/**
 * test-timeout — hard wall-clock guard around `node --test`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `node --test <300+ files>` spawns one child process per test file. With a
 * large suite the *orchestrator* can wedge (a child that never reaps, or pipe
 * back-pressure) and spin at 100% CPU indefinitely. The per-test
 * `--test-timeout` and `--test-force-exit` flags only govern *individual*
 * tests, so a wedged run can keep going for HOURS and orphan — we observed an
 * 11-hour run pegging a CPU core after a session was abandoned.
 *
 * This wrapper spawns the real test command in its OWN process group and
 * SIGKILLs the entire group after a hard deadline, so a run can never orphan
 * again regardless of any node-test-runner bug. The wrapper's own event loop
 * stays healthy (it does nothing but wait), so its timer always fires even
 * when the child is wedged.
 *
 * USAGE (from a workspace dir, see each package.json "test" script):
 *   node --import tsx ../../scripts/test-timeout.ts <args forwarded to `node`>
 *
 * Configure the cap with TEST_TIMEOUT_MS (default 900000 = 15 min). The normal
 * full web suite finishes in a few minutes, so 15 min is generous head-room
 * while still guaranteeing a wedged run dies.
 *
 * IT ALSO READS THE RUN (MONEY-1489)
 * ----------------------------------
 * All 21 workspace `test` scripts already route through here (22 invocations —
 * `@usemoney/core` runs the wrapper twice, once per glob), so this is the one
 * place that can see every run — in CI *and* under `yarn verify:push`, which
 * the same defect bit on the same day. It is also BELOW turbo, so the TAP it
 * reads is unprefixed: a `^not ok` grep at the workflow level would be blind in
 * the multi-workspace shard, where turbo prefixes every line and the pattern
 * has to be `:test: *not ok`.
 *
 * Two things are checked after the child exits, both in `test-report-logic.ts`:
 *
 *   1. CANCELLED FILES ARE NAMED. Node already exits 1 on a cancellation, so
 *      this adds attribution rather than a gate: `# fail 0` alongside
 *      `# cancelled 2` is what left runs #713/#727/#729 undiagnosed.
 *   2. A PER-INVOCATION CASE FLOOR (scripts/test-case-floors.json). This is the
 *      one that catches cases which were never REGISTERED — MONEY-1093's
 *      unquoted glob dropped 45 files / 3,093 cases at exit **0**, with every
 *      counter green and TEST-COVERAGE.md still counting them.
 *
 * The human-facing reporter is unchanged: node's own default is re-stated
 * explicitly (spec on a TTY, tap otherwise) and a SECOND tap reporter is teed
 * to a temp file, which is what gets parsed. stdout stays byte-identical.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseTapSummary,
  evaluateRun,
  floorKey,
  accountedCases,
} from "./test-report-logic";

const TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS) || 15 * 60 * 1000;
const forwarded = process.argv.slice(2);

if (forwarded.length === 0) {
  process.stderr.write("[test-timeout] no command to run\n");
  process.exit(2);
}

/** `scripts/`, derived from argv[1] so it works whether tsx loads us as ESM or CJS. */
const SCRIPTS_DIR = path.dirname(process.argv[1] ?? "");
const FLOORS_FILE = path.join(SCRIPTS_DIR, "test-case-floors.json");

/**
 * Tee a machine-readable TAP copy to a temp file.
 *
 * Inserted directly after `--test`, which is a boolean flag and always present:
 * node stops parsing its own options at the first positional, and `--import tsx`
 * puts a bare `tsx` in argv, so "first arg not starting with -" is not a usable
 * anchor. When `--test` is absent we instrument nothing and behave exactly as
 * before — a wrapper must never be the reason a command fails to start.
 *
 * Same for a caller that already names its own `--test-reporter`: reporters and
 * destinations pair up POSITIONALLY, so appending to someone else's list would
 * mis-pair theirs. No workspace does this today; the check is here so that the
 * first one to try gets its own reporter rather than a corrupted one.
 */
const testFlagAt = forwarded.indexOf("--test");
const callerHasReporter = forwarded.some((a) =>
  a.startsWith("--test-reporter"),
);
const instrument = testFlagAt !== -1 && !callerHasReporter;
const tapDir = instrument ? mkdtempSync(path.join(tmpdir(), "um-tap-")) : null;
const tapPath = tapDir === null ? null : path.join(tapDir, "run.tap");

const spawnArgs = [...forwarded];
if (tapPath !== null) {
  spawnArgs.splice(
    testFlagAt + 1,
    0,
    // Re-state node's own default so adding the second reporter does not
    // silently replace it.
    `--test-reporter=${process.stdout.isTTY ? "spec" : "tap"}`,
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${tapPath}`,
  );
}

const child = spawn(process.execPath, spawnArgs, {
  stdio: "inherit",
  // Own process group so we can signal the whole tree, not just the direct
  // child (node --test fans out into per-file worker processes).
  detached: true,
});

let killedByWatchdog = false;

const watchdog = setTimeout(() => {
  killedByWatchdog = true;
  const secs = Math.round(TIMEOUT_MS / 1000);
  process.stderr.write(
    `\n[test-timeout] ✖ test run exceeded ${secs}s — SIGKILLing process group ${child.pid}.\n` +
      `[test-timeout]   wall-clock guard against orphaned/wedged suites (see scripts/README.md).\n`,
  );
  killGroup("SIGKILL");
}, TIMEOUT_MS);
// Do not let the watchdog itself keep the process alive — the live child
// handle does that. If the child exits cleanly we exit immediately.
watchdog.unref();

function killGroup(signal: NodeJS.Signals): void {
  if (child.pid == null) return;
  try {
    // Negative pid → signal the whole process group (requires detached:true).
    process.kill(-child.pid, signal);
  } catch {
    /* group already gone */
  }
  try {
    child.kill(signal);
  } catch {
    /* direct child already dead */
  }
}

// Forward Ctrl-C / termination to the child group so manual aborts are clean.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => killGroup(sig));
}

child.on("error", (err) => {
  clearTimeout(watchdog);
  cleanupTap();
  process.stderr.write(
    `[test-timeout] failed to spawn test runner: ${err.message}\n`,
  );
  process.exit(1);
});

child.on("exit", (code, signal) => {
  clearTimeout(watchdog);
  if (killedByWatchdog) {
    cleanupTap();
    // Conventional timeout exit code (matches GNU `timeout`).
    process.exit(124);
  }
  if (signal) {
    cleanupTap();
    // Re-raise so the caller sees the real termination cause.
    process.kill(process.pid, signal);
    return;
  }
  const childCode = code ?? 1;
  const reportOk = reportRun();
  cleanupTap();
  // Never mask the child's own verdict: a green report cannot rescue a red run.
  process.exit(childCode !== 0 ? childCode : reportOk ? 0 : 1);
});

/** The workspace we were invoked from — yarn sets cwd to the package dir. */
function workspaceName(): string {
  try {
    const pkg: unknown = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    );
    const name = (pkg as { name?: unknown }).name;
    return typeof name === "string" ? name : path.basename(process.cwd());
  } catch {
    return path.basename(process.cwd());
  }
}

function readFloor(key: string): number | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(FLOORS_FILE, "utf8"));
    const floors = (raw as { floors?: unknown }).floors;
    if (typeof floors !== "object" || floors === null) return null;
    const value = (floors as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** Surface a failure in the GitHub run page. A step summary is a FILE, so turbo's line prefix cannot break it. */
function writeStepSummary(body: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    appendFileSync(file, body);
  } catch {
    /* summaries are best-effort; never fail a run over one */
  }
}

/** @returns false when the run violated a rule (cancelled files, or under the floor). */
function reportRun(): boolean {
  if (tapPath === null) return true;

  let tap: string;
  try {
    tap = readFileSync(tapPath, "utf8");
  } catch {
    // No TAP at all: the child never got far enough to write one. Its own exit
    // code is the honest signal, so say nothing rather than invent a verdict.
    return true;
  }

  const summary = parseTapSummary(tap);
  const pattern = forwarded[forwarded.length - 1] ?? "";
  const key = floorKey(workspaceName(), pattern.startsWith("-") ? "" : pattern);

  // A FLOOR ONLY MEANS ANYTHING FOR A WHOLE-WORKSPACE GLOB RUN. `run-smoke.ts`
  // wraps this same script but passes an explicit FILE LIST from
  // smoke-list.txt, so its "pattern" is one file path and its case count is a
  // hand-picked subset that moves whenever that manifest is edited. Offering a
  // floor there would invite someone to paste a number that means nothing —
  // and enforcing one would fail the smoke tier the next time a line is
  // removed from the manifest. The CANCELLED check still applies to every run;
  // it is the floor alone that is scoped to globs.
  const isGlobRun = pattern.includes("*");
  const floor = isGlobRun ? readFloor(key) : null;
  const verdict = evaluateRun(summary, floor);

  // Printed on EVERY run, pass or fail: this is the number the floors file is
  // made of, so it must never be something you have to make a run fail to see.
  const accounted = accountedCases(summary);
  process.stderr.write(
    `[test-timeout] ${key} — ${accounted ?? "?"} cases ` +
      `(${summary.pass ?? "?"} passed, ${summary.skipped ?? 0} skipped, ` +
      `${summary.cancelled ?? 0} cancelled), floor ` +
      `${floor ?? (isGlobRun ? "not recorded" : "n/a — file-list run")}\n`,
  );
  if (floor === null && isGlobRun) {
    // A STARVED RUN MUST NOT BECOME THE BASELINE. Measured on this machine:
    // two consecutive `yarn verify:push` runs of @usemoney/core, same code,
    // reported 7907 and then 7842 accounted cases — the difference is entirely
    // files killed at the 30s per-file budget under parallel contention. A
    // floor pasted from the second would sit BELOW both and catch nothing,
    // which is the quiet way this gate turns into decoration. So the
    // paste-ready line is only offered when the run lost nothing.
    // A FAILING run is starved too — MONEY-1489 review, finding 4. A failure
    // lands in `# fail`, not `# pass`, so `accounted` is short by exactly the
    // number of failures and a floor pasted from it sits permanently below the
    // healthy count. The cancelled guard above and this one are the same
    // principle applied to the two ways a run can under-count; guarding only
    // one of them is how the rule becomes decorative in the other direction.
    const lostFiles = summary.cancelled ?? 0;
    const lostCases = summary.fail ?? 0;
    process.stderr.write(
      lostFiles === 0 && lostCases === 0
        ? `[test-timeout]   no floor recorded. Add one to scripts/test-case-floors.json:\n` +
            `[test-timeout]     ${JSON.stringify(key)}: ${accounted ?? 0},\n`
        : `[test-timeout]   no floor recorded, and NOT offering one from this run — ` +
            `it lost ${lostFiles} file(s) to the per-file timeout and ` +
            `${lostCases} case(s) to failures, so ${accounted ?? 0} is a ` +
            `starved count. Re-measure on a clean, green run.\n`,
    );
  }

  if (verdict.ok) return true;

  const header = `[test-timeout] ✖ ${key}`;
  const body = verdict.problems.map((p) => `[test-timeout]   ${p}`).join("\n");
  process.stderr.write(`\n${header}\n${body}\n`);
  writeStepSummary(
    `### Test run refused — \`${key}\`\n\n` +
      verdict.problems.map((p) => `- ${p}`).join("\n") +
      "\n\n",
  );
  return false;
}

function cleanupTap(): void {
  if (tapDir === null) return;
  try {
    rmSync(tapDir, { recursive: true, force: true });
  } catch {
    /* temp dir; the OS will reap it */
  }
}
