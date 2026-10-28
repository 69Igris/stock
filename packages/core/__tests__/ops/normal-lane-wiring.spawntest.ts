/**
 * The NORMAL test lane is WIRED — MONEY-1317.
 *
 * ## Why this file is in the slow lane, and must stay there
 *
 * It costs a few filesystem reads. Nothing here spawns a process, so on cost
 * alone it belongs in the 30 s lane with everything else — and putting it there
 * would destroy it.
 *
 * `spawntest-lane-wiring.test.ts` states the governing principle and applies it
 * one way: *a check that rides in the lane it is checking cannot report that the
 * lane is gone.* That is why the spawn lane's pin sits in the normal lane. This
 * is the same sentence read backwards. The subject here is the NORMAL lane, so
 * the check has to ride in the SPAWN one.
 *
 * Lane membership is the suffix and nothing else, so "tidying" this file to
 * `.test.ts` because it is fast would silently return the normal lane to having
 * no pin at all. That is the entire defect below.
 *
 * ## The hole this closes
 *
 * `packages/core`'s `test` script is two `node --test` invocations joined by
 * `&&`, and the normal lane carries ~226 of the package's 230 test files
 * against the spawn lane's 4. Every pin pointed at the small one.
 *
 * Mistype the normal glob — `"__tests__/**\/*.tests.ts"` for
 * `"__tests__/**\/*.test.ts"`, one keystroke — and node selects nothing. That is
 * not an error. MEASURED, from packages/core:
 *
 *     $ node --import tsx --test --test-timeout=30000 "__tests__/**\/*.tests.ts"
 *     TAP version 13
 *     1..0
 *     # tests 0
 *     # fail 0
 *     $ echo $?
 *     0
 *
 * Exit 0, so `&&` proceeds; the spawn lane runs its four files and passes; and
 * `yarn test` reports SUCCESS for `packages/core` with ~226 files never
 * executed. The `verify:push` marker is then written against a tree almost
 * nothing was run on.
 *
 * The existing orphan check ("these test files are selected by NEITHER lane")
 * is exactly the assertion that should fire, and in this scenario it cannot: it
 * lives in a `.test.ts` file, so it is one of the ~226 that were not selected.
 * A dead lane cannot report itself. That is the same shape as MONEY-1316's
 * original defect — green because it did not run — and the same shape as the
 * five-month Tickertape block, where a job kept returning 200 and writing zero
 * rows.
 *
 * ## What is pinned
 *
 *   1. the normal invocation exists, and its glob is QUOTED (MONEY-1093)
 *   2. it SELECTS a plausible suite — every `*.test.ts` on disk, and more than
 *      100 of them. A glob is only as good as what it matches, and the count is
 *      the floor that makes a silently-empty selection loud
 *   3. the script's `&&` segments ARE the lanes, and none of them swallows a
 *      failure — asserted here and in the spawn pin, from one shared predicate
 *
 * (2) is the check the typo scenario needs. Asserting the glob's TEXT would not
 * do it: `"__tests__/**\/*.tests.ts"` is a perfectly well-formed quoted glob
 * containing `__tests__`, and it parses as a lane. Only running it against the
 * files on disk tells you it selects zero.
 *
 * The shared machinery lives in `test-lane-harness.ts` — a non-test module, so
 * it joins neither lane — because this pin and its mirror need the identical
 * script parse and glob translation pointed in opposite directions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NORMAL_LANE,
  NORMAL_TEST_FILES,
  SPAWN_LANE,
  TEST_SCRIPT,
  findSegmentIntegrityProblems,
  globToRegExp,
} from "./test-lane-harness";

describe("the normal test lane is wired (MONEY-1317)", () => {
  it("the scan found a normal suite on disk (it is not passing vacuously)", () => {
    // The floor. Every check below compares the lane's glob against this set,
    // and an empty set would satisfy all of them — the same way an empty lane
    // satisfies `node --test`.
    assert.ok(
      NORMAL_TEST_FILES.length > 100,
      `expected packages/core's normal suite (~226 files), found ` +
        `${NORMAL_TEST_FILES.length} *.test.ts files on disk. Either the walk ` +
        `in test-lane-harness.ts has gone blind, or the suite really has ` +
        `collapsed — both are worth stopping for`,
    );
  });

  it("package.json's test script invokes a normal lane, with a QUOTED glob", () => {
    assert.ok(
      NORMAL_LANE !== undefined,
      "packages/core's `test` script has no `node --test` invocation for the " +
        "normal suite. The ~226 *.test.ts files then run in NO lane, and " +
        `yarn test still exits 0. Script was:\n${TEST_SCRIPT}`,
    );
    // MONEY-1093, and it bit this exact glob before. Unquoted, the SHELL
    // expands `**` as a single `*`, so node receives a list of files exactly
    // one directory deep — 45 files / 3,093 cases stopped executing while
    // TEST-COVERAGE.md went on counting them.
    assert.equal(
      NORMAL_LANE!.quoted,
      true,
      `the normal lane's glob must be quoted, so node does the expanding and ` +
        `not bash: ${NORMAL_LANE!.glob}`,
    );
    // Guarded here too. If the SPAWN lane were the one that vanished, this
    // file would not run to say so — but a spawn lane that disappeared while
    // this file still exists means this file is in no lane either, and the
    // mirror in the normal lane reports it. Asserting it from both sides costs
    // one line and removes the assumption.
    assert.ok(
      SPAWN_LANE !== undefined,
      "the spawntest lane is gone — yet this file ran, so it was selected by " +
        "something. Check the globs in packages/core/package.json.",
    );
  });

  it("the normal lane actually SELECTS the normal suite", () => {
    const re = globToRegExp(NORMAL_LANE!.glob);
    const selected = NORMAL_TEST_FILES.filter((f) => re.test(f));

    // Stated as a count first, because this is the number that goes to zero in
    // the typo scenario and the message should say so outright rather than
    // printing 226 missing paths.
    assert.ok(
      selected.length > 100,
      `the normal lane's glob (${NORMAL_LANE!.glob}) selects ` +
        `${selected.length} of the ${NORMAL_TEST_FILES.length} *.test.ts files ` +
        `on disk. node --test over a glob that matches nothing exits 0 printing ` +
        `\`# tests 0\`, so \`&&\` proceeds, the spawn lane passes, and yarn test ` +
        `reports SUCCESS having run almost none of packages/core.`,
    );

    // And then the exact version: not "enough files" but "all of them".
    const missed = NORMAL_TEST_FILES.filter((f) => !re.test(f));
    assert.deepEqual(
      missed,
      [],
      `these files carry the normal-lane suffix but the lane's glob ` +
        `(${NORMAL_LANE!.glob}) does not select them, so nothing runs them`,
    );
  });

  it("every `&&` segment is a lane, and none of them swallows a failure", () => {
    // The same predicate the spawn pin asserts, from `test-lane-harness.ts`.
    // It is checked in both lanes deliberately: the `test` script is one object
    // that both lanes depend on, and a `|| true` can be appended to EITHER
    // invocation — including the one carrying whichever pin would have noticed.
    assert.deepEqual(
      findSegmentIntegrityProblems(),
      [],
      `packages/core's \`test\` script no longer holds the two-lane contract. ` +
        `Script was:\n${TEST_SCRIPT}`,
    );
  });
});
