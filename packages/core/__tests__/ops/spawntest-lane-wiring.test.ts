/**
 * The `.spawntest.ts` lane is WIRED — MONEY-1316.
 *
 * ## What this file is for
 *
 * `packages/core` runs `node --test` TWICE. The normal lane keeps
 * `--test-timeout=30000`; a second lane runs the expensive, process-spawning
 * files at `--test-timeout=180000`. A file is put in the slow lane by RENAMING
 * it to `*.spawntest.ts` — the suffix is the entire wiring, and the two globs
 * are disjoint because `*.test.ts` cannot match a name ending `.spawntest.ts`.
 *
 * That is a good arrangement and a dangerous one, for the same reason: nothing
 * about a `.spawntest.ts` file says whether anything runs it. Delete the second
 * invocation from `package.json`, mistype the glob, or leave the quotes off it,
 * and those files stop executing. There is no error. `yarn test` exits 0, the
 * `verify:push` marker gets written, and four files covering the path that can
 * DELETE a QA collection have silently left the suite.
 *
 * That is the ORIGINAL MONEY-1316 defect, one level up. The file-level timeout
 * was already a case of "green does not mean it ran" — an over-running file is
 * CANCELLED rather than failed, so it prints `not ok` while `# fail` stays 0.
 * Moving those files into a lane fixes that and buys a new way for a run to be
 * green without them. So the lane needs a pin, and the pin has to live in the
 * NORMAL lane (hence `.test.ts`), because a check that rides in the lane it is
 * checking cannot report that the lane is gone.
 *
 * ## The mirror, and why half of this was missing — MONEY-1317
 *
 * That principle was stated here and applied in ONE direction. The NORMAL lane
 * had no pin at all, and it is the lane carrying ~226 of the package's 230 test
 * files. Mistype ITS glob — `"__tests__/**\/*.tests.ts"` — and `node --test`
 * selects nothing, which is not an error: MEASURED, it exits 0 printing
 * `# tests 0`, `&&` proceeds, the spawn lane passes, and `yarn test` reports
 * SUCCESS for `packages/core` having executed four files. The orphan check
 * below would have caught it, and could not: in exactly that scenario this file
 * is one of the ~226 that were not selected.
 *
 * The mirror therefore lives in the other lane, by the same rule that put this
 * file in this one: `normal-lane-wiring.spawntest.ts`.
 *
 * NOTE what that does to the vacuity floor below. Before MONEY-1317 the spawn
 * lane held only the four expensive files, so `SPAWNTEST_FILES.length > 0` was
 * a real question. The mirror is itself a `.spawntest.ts` file, so the answer
 * is now structurally yes and the floor's live value has shrunk to "this lane
 * is never a no-op" — which it does still prove, and which is now guaranteed by
 * construction rather than discovered. What it no longer detects is the four
 * spawning files being renamed BACK into the 30 s lane; nothing here does, and
 * that is MONEY-1316's original cancellation bug rather than this file's
 * subject. Left as an honest, smaller claim rather than quietly relied on for
 * more than it covers.
 *
 * ## What is pinned
 *
 *   1. the invocation exists, and its glob is QUOTED
 *   2. every `*.spawntest.ts` on disk lands in EXACTLY ONE lane — and so does
 *      every `*.test.ts`, which is the direction that catches a file falling
 *      out of both
 *   3. the slow lane's `--test-timeout` is >= the per-suite ceiling the harness
 *      declares, both numbers READ FROM SOURCE
 *   4. the script's `&&` segments ARE the lanes, and none of them swallows a
 *      failure (MONEY-1317)
 *
 * (1) is where the quoting matters. MONEY-1093: an unquoted `**` is expanded by
 * the SHELL as a single `*`, so `__tests__/**\/*.test.ts` reaches node as a list
 * of files exactly one directory deep. It failed asymmetrically — where the
 * shell glob matched nothing the literal pattern reached node, whose own glob IS
 * recursive, and everything ran; where it matched something the shell won and
 * truncated the set. 45 files / 3,093 cases never executed while the coverage
 * doc counted them.
 *
 * (3) is the drift guard. `SPAWNING_SUITE = { timeout: 180_000 }` and the lane's
 * `--test-timeout=180000` are one decision written in two places; lowering
 * either alone reproduces exactly the state MONEY-1316 started in, where the
 * suites had 180 s and the file containing them had 30 s. Neither number is
 * hardcoded here — both are parsed from the files that own them, so this test
 * asserts a RELATIONSHIP rather than a copy of a constant.
 *
 * (4) is the one every other check is blind to, in BOTH lanes. Everything above
 * asks whether the lane is there and selects the right files; none of it asks
 * whether the shell still cares that it failed. `parseLanes` splits on `&&`, so
 * ` || true` on either invocation leaves the segment parsing as a perfectly
 * healthy lane — right glob, right quoting, right timeout — while the suite's
 * verdict is discarded and `verify:push` writes its marker over a red run.
 *
 * The machinery all four checks share lives in `test-lane-harness.ts`, a
 * non-test module, because the mirror needs exactly the same reasoning pointed
 * the other way and two copies of a glob translator drifting apart would let
 * each lane's pin pass over an interpretation the other's rejects.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_FILES,
  NORMAL_LANE,
  NORMAL_TEST_FILES,
  SPAWNTEST_FILES,
  SPAWN_LANE,
  TESTS_DIR,
  TEST_SCRIPT,
  findSegmentIntegrityProblems,
  globToRegExp,
} from "./test-lane-harness";

// The suite harness whose per-suite ceiling check (3) reads. Not the lane
// harness imported above — that one is this file's own machinery.
const SPAWN_SUITE_HARNESS = join(
  TESTS_DIR,
  "market-data",
  "sync-prod-to-qa-sample-harness.ts",
);

describe("the .spawntest.ts lane is wired (MONEY-1316)", () => {
  it("the scan found real files (it is not passing vacuously)", () => {
    // MEASURED: `node --test "<glob matching nothing>"` exits 0 with `# tests 0`
    // — an empty lane is a silent no-op, not an error. So if the last
    // `.spawntest.ts` file is ever renamed away, every check below would pass
    // over an empty set and the dead lane would sit in package.json unnoticed.
    // This is the floor that forces the decision to be a deliberate one.
    assert.ok(
      SPAWNTEST_FILES.length > 0,
      "no *.spawntest.ts files on disk — if the lane was retired, retire this " +
        "test and the package.json invocation with it, rather than leaving a " +
        "check that can never fail in front of a lane that runs nothing",
    );
    assert.ok(
      NORMAL_TEST_FILES.length > 100,
      `expected the normal suite, found ${NORMAL_TEST_FILES.length} *.test.ts files`,
    );
  });

  it("package.json's test script invokes a spawntest lane", () => {
    assert.ok(
      SPAWN_LANE !== undefined,
      "packages/core's `test` script has no `node --test` invocation whose " +
        "glob selects *.spawntest.ts. Those files then run in NO lane, and " +
        `yarn test still exits 0. Script was:\n${TEST_SCRIPT}`,
    );
    assert.ok(NORMAL_LANE !== undefined, "the normal 30s lane is gone");
  });

  it("both lanes' globs are QUOTED (MONEY-1093)", () => {
    // Unquoted, the shell expands `**` as a single `*` and hands node a
    // truncated file list — silently, and only in the workspaces where the
    // shell glob happens to match something.
    assert.equal(
      SPAWN_LANE?.quoted,
      true,
      `the spawntest glob must be quoted: ${SPAWN_LANE?.glob}`,
    );
    assert.equal(
      NORMAL_LANE?.quoted,
      true,
      `the normal glob must be quoted: ${NORMAL_LANE?.glob}`,
    );
  });

  it("every *.spawntest.ts on disk is selected by the spawntest lane", () => {
    const re = globToRegExp(SPAWN_LANE!.glob);
    const missed = SPAWNTEST_FILES.filter((f) => !re.test(f));
    assert.deepEqual(
      missed,
      [],
      `these files carry the slow-lane suffix but the lane's glob ` +
        `(${SPAWN_LANE!.glob}) does not select them, so nothing runs them`,
    );
    assert.equal(
      SPAWNTEST_FILES.filter((f) => re.test(f)).length,
      SPAWNTEST_FILES.length,
    );
  });

  it("the two lanes are disjoint and together cover every test file", () => {
    const spawnRe = globToRegExp(SPAWN_LANE!.glob);
    const normalRe = globToRegExp(NORMAL_LANE!.glob);

    // A file in BOTH lanes runs twice — wasteful, and it would let a file be
    // "covered" by the fast lane while timing out there.
    const inBoth = ALL_FILES.filter((f) => spawnRe.test(f) && normalRe.test(f));
    assert.deepEqual(inBoth, [], "these files are selected by BOTH lanes");

    // The direction that matters: a test file in NEITHER lane is a file that
    // does not run, and no count anywhere would show it.
    const orphaned = [...SPAWNTEST_FILES, ...NORMAL_TEST_FILES].filter(
      (f) => !spawnRe.test(f) && !normalRe.test(f),
    );
    assert.deepEqual(
      orphaned,
      [],
      "these test files are selected by NEITHER lane — they never execute",
    );
  });

  it("the spawntest lane's timeout is >= the harness's per-suite ceiling", () => {
    // Both numbers are read from the files that own them. Hardcoding 180000
    // here would make this test a THIRD copy of the constant, and the failure
    // it exists to catch is precisely two copies drifting apart.
    const harness = readFileSync(SPAWN_SUITE_HARNESS, "utf8");
    const declared = /SPAWNING_SUITE\s*=\s*\{\s*timeout:\s*([\d_]+)\s*\}/.exec(
      harness,
    );
    assert.ok(
      declared !== null,
      "SPAWNING_SUITE's timeout is no longer readable from " +
        "sync-prod-to-qa-sample-harness.ts — this check went blind",
    );
    const suiteTimeout = Number(declared[1]!.replace(/_/g, ""));
    assert.ok(
      suiteTimeout > 0,
      `parsed a nonsense suite timeout: ${declared[1]}`,
    );

    assert.ok(
      SPAWN_LANE!.timeoutMs >= suiteTimeout,
      `the spawntest lane runs at --test-timeout=${SPAWN_LANE!.timeoutMs} while ` +
        `the suites inside it declare ${suiteTimeout}ms. The FILE-level test ` +
        `node creates per file would be cancelled before its own suites are — ` +
        `which reports \`not ok\` with \`# fail\` still 0, the exact state ` +
        `MONEY-1316 started in.`,
    );
  });

  it("every `&&` segment is a lane, and none of them swallows a failure", () => {
    // Asserted in BOTH pins, from the one predicate in `test-lane-harness.ts`.
    // Deliberately duplicated across the lanes rather than owned by one of
    // them: the script is a single object that BOTH lanes depend on, and a
    // check that lives in only one lane goes dark the moment that lane does.
    // MEASURED: with ` || true` appended to either invocation, every other
    // assertion in this file still passes.
    assert.deepEqual(
      findSegmentIntegrityProblems(),
      [],
      `packages/core's \`test\` script no longer holds the two-lane contract. ` +
        `Script was:\n${TEST_SCRIPT}`,
    );
  });
});
