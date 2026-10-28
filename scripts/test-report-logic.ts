/**
 * test-report-logic — pure readers for `node --test`'s TAP output (MONEY-1489).
 *
 * WHY THIS EXISTS
 * ---------------
 * `--test-timeout` is documented as a per-TEST timeout, and **node treats each
 * FILE as a test**. So it is really a per-file wall-clock budget covering the
 * whole child process — module evaluation included. Verified, not assumed: a
 * file that burns 5s at MODULE SCOPE is cancelled by `--test-timeout=3000`
 * exactly like one that burns it inside `it()`.
 *
 * When a file blows that budget node reports it as CANCELLED, and the cases
 * inside it VANISH from every count while `# fail` stays **0**:
 *
 *     # tests 20858        # fail 0        # cancelled 2
 *
 * That is CI run #729. 122 cases from two `apps/web` files never executed and
 * the only two annotations read `Process completed with exit code 1` and
 * `@usemoney/web#test … exited (1)` — no filename anywhere, while `# fail 0`
 * actively misdirects. Three runs (#713, #727, #729) went undiagnosed that way.
 *
 * WHAT THIS DOES AND DOES NOT ADD
 * -------------------------------
 * Node ALREADY exits 1 on a cancellation (measured on 22.22), so this is not a
 * new gate and must not be described as one. What it adds is ATTRIBUTION: the
 * failing FILE by name, and the word "cancelled" rather than an anonymous
 * exit 1. That is the half that was missing.
 *
 * The case-count FLOOR is the part that catches a genuinely invisible class:
 * cases that were never REGISTERED at all. That one exits **0** with everything
 * green — MONEY-1093 shipped it, where an unquoted `--test` glob silently
 * truncated the file set and 45 files / 3,093 cases never ran while
 * TEST-COVERAGE.md went on counting them. No exit code and no annotation can
 * see that; only comparing the executed count against a recorded floor can.
 *
 * Kept pure (no fs, no spawn) so the whole ladder is testable from fixtures —
 * a source scan cannot assert which of two near-identical expressions is there.
 */

/** One entry node killed at the per-test timeout. */
export interface TimedOutEntry {
  /** Top-level TAP subtest it belongs to — for `node --test <glob>` this is the FILE. */
  readonly file: string;
  /** The entry's own name. Equals `file` when the whole file was killed. */
  readonly name: string;
}

export interface TapSummary {
  /** `# tests N`, or null when the line was absent (a truncated/killed run). */
  readonly tests: number | null;
  readonly suites: number | null;
  readonly pass: number | null;
  readonly fail: number | null;
  readonly cancelled: number | null;
  readonly skipped: number | null;
  /** Entries whose diagnostic block carried `failureType: 'testTimeoutFailure'`. */
  readonly timedOut: readonly TimedOutEntry[];
}

const COUNTER_RE = /^# (tests|suites|pass|fail|cancelled|skipped) (\d+)\s*$/;
/**
 * The `^` is the whole mechanism, not decoration: a NESTED `# Subtest:` is
 * indented, so anchoring at column 0 selects exactly the top-level entries,
 * which under `node --test <glob>` are the FILES. Do not relax this to
 * `/^\s*# Subtest:/` — that would make every inner case overwrite the file
 * attribution and report a case name where a path belongs. There is one guard
 * here rather than two: an earlier `line.startsWith(" ")` check alongside it
 * was provably inert (a mutation removing it changed no behaviour and failed no
 * test), and a second guard that cannot fail is not protection, it is a reason
 * to believe you are protected.
 */
const TOP_SUBTEST_RE = /^# Subtest: (.+)$/;
const NOT_OK_RE = /^(\s*)not ok \d+ - (.+?)\s*$/;
const TIMEOUT_MARKER = "failureType: 'testTimeoutFailure'";

/**
 * A PERFORMANCE bound on the diagnostic scan, and deliberately not described as
 * the correctness guard — that is the `break` on the next `ok`/`not ok` inside
 * the loop, which is what stops a `not ok` with no block from absorbing a later
 * entry's marker. Verified: raising this to 200 fails no test, because the
 * `break` fires first on every real input. It earns its place only for the last
 * entry in a TRUNCATED stream, where there is no following entry to stop at and
 * the scan would otherwise walk to EOF. Node's timeout block is 6 lines
 * (`---`, duration_ms, type, location, failureType, error); 12 is slack.
 */
const DIAGNOSTIC_LOOKAHEAD = 12;

/**
 * Read `node --test`'s TAP stream.
 *
 * Deliberately tolerant: a run the watchdog SIGKILLed leaves a half-written
 * file, and half a report must degrade to `null` counters rather than throw —
 * the caller already has a real failure to report in that case.
 */
export function parseTapSummary(tap: string): TapSummary {
  const lines = tap.split("\n");
  const counters = new Map<string, number>();
  const timedOut: TimedOutEntry[] = [];
  let currentFile = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const counter = COUNTER_RE.exec(line);
    if (counter) {
      counters.set(counter[1] as string, Number(counter[2]));
      continue;
    }

    // Track the enclosing FILE — see TOP_SUBTEST_RE for why `^` is sufficient.
    const sub = TOP_SUBTEST_RE.exec(line);
    if (sub) {
      currentFile = sub[1] as string;
      continue;
    }

    const notOk = NOT_OK_RE.exec(line);
    if (!notOk) continue;

    const end = Math.min(lines.length, i + 1 + DIAGNOSTIC_LOOKAHEAD);
    let isTimeout = false;
    for (let j = i + 1; j < end; j++) {
      const probe = lines[j] ?? "";
      if (probe.includes(TIMEOUT_MARKER)) {
        isTimeout = true;
        break;
      }
      // A new entry starts: this block is over, stop before borrowing its marker.
      if (NOT_OK_RE.test(probe) || /^\s*ok \d+ - /.test(probe)) break;
    }
    if (!isTimeout) continue;

    const name = notOk[2] as string;
    timedOut.push({ file: currentFile || name, name });
  }

  const read = (k: string): number | null => counters.get(k) ?? null;
  return {
    tests: read("tests"),
    suites: read("suites"),
    pass: read("pass"),
    fail: read("fail"),
    cancelled: read("cancelled"),
    skipped: read("skipped"),
    timedOut,
  };
}

export interface RunVerdict {
  readonly ok: boolean;
  /** Human-readable reasons, one per violated rule. Empty when `ok`. */
  readonly problems: readonly string[];
}

/**
 * What the floor counts: cases the run ACCOUNTED FOR — `pass + skipped`.
 *
 * NOT `# pass` alone, and the difference is what keeps this gate from going red
 * on a healthy CI run. Node excludes skipped tests from `# pass` (run #729:
 * 20841 + 2 cancelled + 15 skipped = 20858 tests), and ~77 test files in this
 * repo read `process.env`, so a CASE gated on `RUN_REDIS_TESTS` or a platform
 * can legitimately skip on one machine and run on another. A `# pass` floor
 * measured on a laptop would then fail on the runner for no defect at all — and
 * a merge gate that is red on the day it lands is a gate somebody disables.
 *
 * READ "CASE" LITERALLY — the cover is narrower than it looks, and the review
 * of MONEY-1489 measured the boundary. `it.skip` REGISTERS the case, so node
 * counts it in `# skipped` and `pass + skipped` holds. `describe.skip`, and an
 * `if (process.env.X) { it(...) }` that registers nothing, produce
 * `# tests 0` — indistinguishable from a file whose cases vanished, so the
 * floor FIRES.
 *
 * That is latent rather than live: this repo's only condition-driven skips are
 * `{ skip: <reason> }` on `it`, which node registers and counts, and its three
 * `describe.skip`s are static so they cannot differ laptop-to-CI. Worth knowing
 * before introducing an environment-gated `describe` — the two skip spellings
 * behave OPPOSITELY under this gate.
 *
 * NOT `# tests` either: that counter INCLUDES the cancelled entries, so a run
 * that lost a whole file would have the file's own entry padding the very
 * number meant to notice the loss.
 *
 * `pass + skipped` catches the target class exactly — cases that were never
 * REGISTERED are in neither — and on a green run it equals `# tests`.
 *
 * @returns null when the run produced no countable summary at all.
 */
export function accountedCases(summary: TapSummary): number | null {
  if (summary.pass === null) return null;
  return summary.pass + (summary.skipped ?? 0);
}

/**
 * Judge one workspace invocation.
 *
 * `floor` is the recorded count of cases this invocation is known to execute;
 * `null` means "not recorded yet", which REPORTS and does not fail — a floor
 * nobody has measured must not block a merge, and `yarn test:coverage-check`
 * already fails on an undocumented new test file.
 *
 * The comparison is `accountedCases(summary) < floor`, so ADDING tests is always
 * free and only a DROP needs a deliberate, visible edit to the floors file.
 */
export function evaluateRun(
  summary: TapSummary,
  floor: number | null,
): RunVerdict {
  const problems: string[] = [];

  const cancelled = summary.cancelled ?? 0;
  if (cancelled > 0) {
    const names =
      summary.timedOut.length > 0
        ? summary.timedOut.map((t) =>
            t.file === t.name ? t.file : `${t.file} › ${t.name}`,
          )
        : ["(no timed-out entry named in the TAP stream)"];
    problems.push(
      `${cancelled} CANCELLED — these ran out of wall clock and their cases never ` +
        `executed (node reports them outside "# fail", which is why this reads as 0):\n` +
        names.map((n) => `    - ${n}`).join("\n"),
    );
  }

  if (floor !== null) {
    const accounted = accountedCases(summary);
    if (accounted === null) {
      problems.push(
        `no "# pass" line in the TAP stream, so the ${floor}-case floor could ` +
          `not be checked. A run that cannot be counted is not a run that passed.`,
      );
    } else if (accounted < floor) {
      problems.push(
        `${accounted} cases accounted for (${summary.pass} passed + ` +
          `${summary.skipped ?? 0} skipped), floor is ${floor} — ` +
          `${floor - accounted} case(s) never ran at all. Either something stopped ` +
          `REGISTERING them (a truncated glob, a throwing suite body, a file the ` +
          `pattern no longer matches) or tests were removed; if the removal is ` +
          `intended, lower the floor in scripts/test-case-floors.json in the same commit.`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Key one invocation. A workspace may run the wrapper more than once with different globs. */
export function floorKey(workspace: string, pattern: string): string {
  return pattern ? `${workspace} ${pattern}` : workspace;
}

/**
 * A DEFAULT export as well, and it is not redundant.
 *
 * `scripts/` has no `"type": "module"` above it, so tsx loads this file as CJS.
 * Its consumer `test-timeout.ts` is CJS too and uses the named exports. The
 * TEST, however, lives in `packages/core`, which IS `"type": "module"` — and an
 * ESM `import` of a CJS module gets a namespace of exactly `{ default }`, so
 * named imports fail to LINK with "does not provide an export named …".
 * Measured, not guessed. This keeps one module importable from both sides
 * without renaming it `.mts` (which would force the wrapper async) or moving
 * the test out of the `__tests__/ops/` tree where every other `scripts/` test
 * lives.
 */
export default { parseTapSummary, evaluateRun, floorKey, accountedCases };
