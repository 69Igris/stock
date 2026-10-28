/**
 * MONEY-1489 — the two readers that turn `node --test`'s TAP into a verdict.
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS
 * -----------------------------------
 * The TAP below is the REAL shape of CI run #729 (`apps/web` shard), trimmed:
 * `# fail 0` sitting beside `# cancelled 2`, the two killed files reported as
 * unindented `not ok` entries whose diagnostic block says
 * `failureType: 'testTimeoutFailure'`, and 122 cases simply absent from every
 * counter. Three runs went undiagnosed against exactly this text, so it is what
 * the parser is pinned to rather than a hand-written approximation.
 *
 * The polarity cases matter as much as the happy path. `evaluateRun` is the
 * only thing standing between "45 files never executed" and a green merge
 * (MONEY-1093), and a check that has never been seen to FAIL is not a check —
 * so both rules are asserted in both directions, including the two ways this
 * could be vacuous: a floor of `null` must not fail, and `pass === floor` must
 * not fail either (it is a floor, not an equality).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
// TWO deliberate spellings here, both of which a tidy-up would break:
//
//   - the DEFAULT import, because `scripts/` is CJS (no `"type": "module"`
//     above it) while this package is ESM, so an ESM `import` of it yields a
//     namespace of exactly `{ default }` and named imports fail to LINK with
//     "does not provide an export named …". See the module's own default export.
//   - NO `.ts` extension, because `tsconfig.test.json` type-checks this tree
//     and rejects one with TS5097 unless `allowImportingTsExtensions` is on.
//     Both forms resolve identically at runtime under tsx.
import logic from "../../../../scripts/test-report-logic";

const { parseTapSummary, evaluateRun, floorKey, accountedCases } = logic;

/** Trimmed from the real run #729 log. Indentation is load-bearing — see below. */
const REAL_CI_TAP = [
  "TAP version 13",
  "# Subtest: __tests__/cache/wrapper.test.ts",
  "ok 1 - __tests__/cache/wrapper.test.ts",
  "  ---",
  "  duration_ms: 3310.1",
  "  type: 'test'",
  "  ...",
  "# Subtest: __tests__/actions/broker-sync-action-e2e.test.ts",
  "not ok 7 - __tests__/actions/broker-sync-action-e2e.test.ts",
  "  ---",
  "  duration_ms: 30004.313633",
  "  type: 'test'",
  "  location: '/home/runner/work/stockbook-monorepo/apps/web/__tests__/actions/broker-sync-action-e2e.test.ts:1:1'",
  "  failureType: 'testTimeoutFailure'",
  "  error: 'test timed out after 30000ms'",
  "  code: 'ERR_TEST_FAILURE'",
  "  ...",
  "# Subtest: __tests__/actions/coupon.test.ts",
  "not ok 12 - __tests__/actions/coupon.test.ts",
  "  ---",
  "  duration_ms: 30002.1",
  "  type: 'test'",
  "  failureType: 'testTimeoutFailure'",
  "  error: 'test timed out after 30000ms'",
  "  ...",
  "1..12",
  "# tests 20858",
  "# suites 4079",
  "# pass 20841",
  "# fail 0",
  "# cancelled 2",
  "# skipped 15",
  "# todo 0",
  "# duration_ms 607123.4",
].join("\n");

describe("MONEY-1489 parseTapSummary — the shape that went undiagnosed three times", () => {
  it("reads every counter, including the cancelled count that `# fail 0` hides", () => {
    const s = parseTapSummary(REAL_CI_TAP);
    assert.equal(s.tests, 20858);
    assert.equal(s.suites, 4079);
    assert.equal(s.pass, 20841);
    assert.equal(
      s.fail,
      0,
      "the misdirecting counter — must be read, not ignored",
    );
    assert.equal(s.cancelled, 2);
    assert.equal(s.skipped, 15);
  });

  it("NAMES both killed files — the half CI never printed", () => {
    const s = parseTapSummary(REAL_CI_TAP);
    assert.deepEqual(
      s.timedOut.map((t) => t.file),
      [
        "__tests__/actions/broker-sync-action-e2e.test.ts",
        "__tests__/actions/coupon.test.ts",
      ],
    );
  });

  it("does NOT report an ordinary assertion failure as a timeout", () => {
    const tap = [
      "# Subtest: __tests__/a.test.ts",
      "not ok 1 - __tests__/a.test.ts",
      "  ---",
      "  failureType: 'testCodeFailure'",
      "  error: 'Expected values to be strictly equal'",
      "  ...",
      "# tests 1",
      "# fail 1",
      "# cancelled 0",
    ].join("\n");
    const s = parseTapSummary(tap);
    assert.equal(s.fail, 1);
    assert.deepEqual(s.timedOut, [], "a real failure is not a cancellation");
  });

  it("attributes a cancelled SUBTEST to its enclosing file, not to the subtest's own name", () => {
    // A nested `# Subtest:` is INDENTED. Treating it as a file would overwrite
    // the attribution and report a case name where a path belongs.
    const tap = [
      "# Subtest: __tests__/outer.test.ts",
      "    # Subtest: slow inner case",
      "    not ok 3 - slow inner case",
      "      ---",
      "      failureType: 'testTimeoutFailure'",
      "      ...",
      "not ok 1 - __tests__/outer.test.ts",
      "  ---",
      "  failureType: 'testCodeFailure'",
      "  ...",
      "# tests 4",
      "# cancelled 1",
    ].join("\n");
    const s = parseTapSummary(tap);
    assert.equal(s.timedOut.length, 1);
    assert.equal(s.timedOut[0]?.file, "__tests__/outer.test.ts");
    assert.equal(s.timedOut[0]?.name, "slow inner case");
  });

  it("a `not ok` with no diagnostic block does not borrow the NEXT entry's timeout marker", () => {
    const tap = [
      "# Subtest: __tests__/a.test.ts",
      "not ok 1 - __tests__/a.test.ts",
      "# Subtest: __tests__/b.test.ts",
      "not ok 2 - __tests__/b.test.ts",
      "  ---",
      "  failureType: 'testTimeoutFailure'",
      "  ...",
      "# cancelled 1",
    ].join("\n");
    const s = parseTapSummary(tap);
    assert.deepEqual(
      s.timedOut.map((t) => t.file),
      ["__tests__/b.test.ts"],
      "only b timed out; a must not inherit b's marker",
    );
  });

  it("degrades to null counters on a truncated stream rather than throwing", () => {
    // What the SIGKILL watchdog leaves behind. The caller already has a real
    // failure to report; half a report must not become an exception.
    const s = parseTapSummary(
      "TAP version 13\n# Subtest: __tests__/a.test.ts\nok 1 - ",
    );
    assert.equal(s.pass, null);
    assert.equal(s.cancelled, null);
    assert.deepEqual(s.timedOut, []);
  });
});

describe("MONEY-1489 evaluateRun — both rules, both polarities", () => {
  const healthy = parseTapSummary(
    "# tests 21\n# pass 21\n# fail 0\n# cancelled 0",
  );

  it("passes a healthy run with a floor it meets exactly (a FLOOR, not an equality)", () => {
    const v = evaluateRun(healthy, 21);
    assert.equal(v.ok, true);
    assert.deepEqual(v.problems, []);
  });

  it("passes when MORE cases ran than the floor — adding tests is always free", () => {
    assert.equal(evaluateRun(healthy, 15).ok, true);
  });

  it("FAILS, and names the files, when anything was cancelled", () => {
    const v = evaluateRun(parseTapSummary(REAL_CI_TAP), null);
    assert.equal(v.ok, false);
    const joined = v.problems.join("\n");
    assert.match(joined, /2 CANCELLED/);
    assert.match(joined, /broker-sync-action-e2e\.test\.ts/);
    assert.match(joined, /coupon\.test\.ts/);
  });

  it("FAILS below the floor — the MONEY-1093 class, which exits 0 and reads green", () => {
    // 4 of 21 cases ran; fail 0, cancelled 0. Nothing else in the toolchain
    // can see this: node exits 0 and every counter agrees with itself.
    const dropped = parseTapSummary(
      "# tests 4\n# pass 4\n# fail 0\n# cancelled 0",
    );
    const v = evaluateRun(dropped, 21);
    assert.equal(v.ok, false);
    assert.match(
      v.problems.join("\n"),
      /4 cases accounted for \(4 passed \+ 0 skipped\), floor is 21 — 17 case\(s\) never ran at all/,
    );
  });

  it("a SKIPPED case still counts toward the floor — the gate must not fire on a healthy skip", () => {
    // This is the false-red the floor would otherwise produce: ~77 test files
    // read process.env, so a suite gated on RUN_REDIS_TESTS legitimately skips
    // on one machine and runs on another. Node excludes skipped from `# pass`,
    // so a `# pass`-based floor measured on a laptop would fail on the runner
    // for no defect at all.
    const withSkips = parseTapSummary(
      "# tests 21\n# pass 15\n# fail 0\n# cancelled 0\n# skipped 6",
    );
    assert.equal(accountedCases(withSkips), 21);
    assert.equal(evaluateRun(withSkips, 21).ok, true);
  });

  it("does NOT let a cancelled file's own entry pad the count (`# tests` would)", () => {
    // `# tests` counts the killed FILE as one test, so it reads 5 here while
    // only 4 cases were accounted for. Using it as the floor metric would let
    // the loss partly hide inside the number meant to notice it.
    const cancelled = parseTapSummary(
      "# tests 5\n# pass 4\n# fail 0\n# cancelled 1\n# skipped 0",
    );
    assert.equal(cancelled.tests, 5);
    assert.equal(accountedCases(cancelled), 4);
  });

  it("does NOT fail an unrecorded floor — a number nobody measured must not block a merge", () => {
    const dropped = parseTapSummary(
      "# tests 4\n# pass 4\n# fail 0\n# cancelled 0",
    );
    assert.equal(evaluateRun(dropped, null).ok, true);
  });

  it("FAILS when a floor exists but the run produced no countable `# pass`", () => {
    // Not-measured is not passed: a truncated stream must not satisfy a floor.
    const truncated = parseTapSummary("TAP version 13\n");
    const v = evaluateRun(truncated, 21);
    assert.equal(v.ok, false);
    assert.match(v.problems.join("\n"), /could not be checked/);
  });

  it("reports BOTH problems when a run is cancelled AND short", () => {
    const v = evaluateRun(parseTapSummary(REAL_CI_TAP), 99999);
    assert.equal(
      v.problems.length,
      2,
      "one rule must not short-circuit the other",
    );
  });
});

describe("MONEY-1489 floorKey — one workspace can invoke the wrapper twice", () => {
  it("separates @usemoney/core's two globs, so one floor cannot satisfy both", () => {
    const a = floorKey("@usemoney/core", "__tests__/**/*.test.ts");
    const b = floorKey("@usemoney/core", "__tests__/**/*.spawntest.ts");
    assert.notEqual(a, b);
    assert.equal(a, "@usemoney/core __tests__/**/*.test.ts");
  });

  it("falls back to the bare workspace name when no pattern is available", () => {
    assert.equal(floorKey("@usemoney/logger", ""), "@usemoney/logger");
  });
});
