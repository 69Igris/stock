/**
 * MONEY-979 T12 — the US coverage GATE, pinned across two languages.
 *
 * `judgeCoverage` here and `judge_coverage` in
 * `services/us-fundamentals/app/report/coverage.py` compute the same release
 * gate in TypeScript and Python. Two languages computing one gate is exactly
 * how they drift, so both are driven over ONE recorded contract:
 *
 *     services/us-fundamentals/tests/coverage_cases.json
 *
 * This file reads that contract and drives the REAL exported `judgeCoverage`;
 * `services/us-fundamentals/tests/test_coverage_report.py` reads the same file
 * and drives the REAL `judge_coverage`. Neither restates the arithmetic — the
 * JSON holds expected OUTPUT, not a third copy of the rule — so a change to
 * either implementation alone turns one of the two suites red.
 *
 * The contract is hand-authored and deliberately NOT generated. A snapshot
 * regenerated from one side agrees with whichever side ran last, which is the
 * drift it was supposed to catch.
 *
 * MUTATION-VERIFIED. Each `MUTATION:` note names the exact source edit applied,
 * confirmed to turn this file RED, and then reverted byte-identically.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  judgeCoverage,
  US_COVERAGE_TARGET_YEARS,
} from "../../src/us-fundamentals/repository-logic";
import type {
  UsCoverageFiler,
  UsCoverageJudgement,
} from "../../src/us-fundamentals/types";
/**
 * The ops script's own decisions, driven directly.
 *
 * Importable at all because `edgar-coverage-report.ts` calls `main()` ONLY when
 * it is the process entry point — an unguarded call would open a database
 * connection the moment this file imported it. Driving the REAL `decideGate` is
 * the only way to observe the one failure mode a `--fail-under` has: printing a
 * percentage, exiting 0, and being believed.
 *
 * A DYNAMIC import, and it has to be. `packages/core` is `"type": "module"`
 * while the repo root — and therefore `scripts/` — is not, so tsx transpiles the
 * script to CommonJS. A static `import { decideGate } from …` across that
 * boundary resolves the file and then throws
 * `does not provide an export named 'decideGate'` at load time; `await import()`
 * goes through cjs-module-lexer and gets the named exports. Do not "tidy" this
 * back into a static import.
 */
const { decideGate, parseArgs, percentile } =
  await import("../../../../scripts/data/edgar-coverage-report");

/**
 * The acceptance script's pass/fail policy, for the same reason and by the same
 * mechanism.
 *
 * `edgar-acceptance.ts` is the script whose contract is that ABSENCE IS FAILURE,
 * and a script that prints an empty report and exits 0 looks exactly like one
 * that found everything. That is unobservable from outside, so the policy is a
 * pure function and it is driven here.
 */
const { judgeAcceptance, REQUIRED_LEGS, REPORTED_ONLY_LEGS } =
  await import("../../../../scripts/data/edgar-acceptance");

/** CWD is `packages/core` when this suite runs — same convention as `prod-only-sync-coverage.test.ts`. */
const ROOT = join(process.cwd(), "..", "..");
const CONTRACT_FILE = join(
  ROOT,
  "services",
  "us-fundamentals",
  "tests",
  "coverage_cases.json",
);

interface CoverageCase {
  name: string;
  why: string;
  /**
   * Deliberately `unknown[]`, not `UsCoverageFiler[]`.
   *
   * The `dirty_inputs` case carries a numeric string, a `null` and a `1` where
   * the interface says `number` and `boolean`, because those are the shapes
   * that actually arrive from a database and the coercion rules are half the
   * contract. Typing the fixture as `UsCoverageFiler[]` would make the compiler
   * reject the very rows worth testing, and casting each one individually would
   * hide that the cast is what is under test.
   */
  filers: unknown[];
  expected: Record<string, number>;
}

interface Contract {
  targetYears: number;
  cases: CoverageCase[];
}

function readContract(): Contract {
  let raw: string;
  try {
    raw = readFileSync(CONTRACT_FILE, "utf8");
  } catch {
    assert.fail(
      `${CONTRACT_FILE} is missing. It is the shared contract that pins the ` +
        "TypeScript gate to the Python one. If the service moved, update this " +
        "path — do not delete the check, and do not inline the cases here: a " +
        "copy in each language is two contracts, which is the problem.",
    );
  }
  return JSON.parse(raw) as Contract;
}

const contract = readContract();

/** Percentages are doubles; compared with a tolerance so a repeating fraction stays arithmetic. */
const TOLERANCE = 1e-9;

const COUNT_KEYS = [
  "eligible",
  "eligibleCovered",
  "ineligible",
  "ineligibleWithAllAvailable",
  "filers",
] as const;
const PCT_KEYS = ["pct", "overallPct"] as const;

describe("US coverage gate — the shared cross-language contract", () => {
  it("the contract file is present and non-trivial", () => {
    // Without this, deleting the cases turns every assertion below into a
    // vacuous pass over an empty list — the failure mode a shared fixture
    // introduces, and the reason the Python side asserts the same thing.
    assert.ok(
      contract.cases.length >= 8,
      `expected >= 8 shared cases, found ${contract.cases.length}`,
    );
    const names = contract.cases.map((c) => c.name);
    assert.equal(
      new Set(names).size,
      names.length,
      `duplicate case names: ${names.join(", ")}`,
    );
  });

  it("records the same target year count as the implementation", () => {
    // The bar lives in three places — the contract, `repository-logic.ts` and
    // `coverage.py`. Pinning it makes a change in one of them a red test in the
    // other two rather than a silently moved gate.
    assert.equal(contract.targetYears, US_COVERAGE_TARGET_YEARS);
    assert.equal(US_COVERAGE_TARGET_YEARS, 5);
  });

  it("still carries the SPAC case", () => {
    // Named explicitly. It is the ONE case that dies when the denominator is
    // replaced by all filers, so it must not be quietly dropped from the file.
    const spac = contract.cases.find((c) => c.name === "spac_batch");
    assert.ok(spac, "the spac_batch case is the gate's whole reason to exist");
    assert.equal(
      spac.filers.filter((f) => (f as UsCoverageFiler).eligibleForCoverage)
        .length,
      2,
      "spac_batch must keep a small eligible bucket beside a large ineligible one",
    );
  });

  it("every case pins every field of the judgement", () => {
    // A case that omits a key would pass while that key was wrong.
    const keys = Object.keys(judgeCoverage([])).sort();
    for (const c of contract.cases) {
      assert.deepEqual(
        Object.keys(c.expected).sort(),
        keys,
        `case "${c.name}" does not pin every judgement field`,
      );
    }
  });

  /*
   * MUTATION: `pct: eligible === 0 ? 100 : (eligibleCovered / eligible) * 100`
   *   -> `(eligibleCovered / total) * 100` in repository-logic.ts — RED
   *   (spac_batch 100 -> 20).
   * MUTATION: drop the `eligible === 0 ? 100` guard — RED (`empty` yields NaN,
   *   and `NaN` fails both `>=` and `<`, which is why it is asserted rather
   *   than left to a threshold check).
   * MUTATION: `if (held >= atSec) ineligibleWithAllAvailable++`
   *   -> `held >= US_COVERAGE_TARGET_YEARS` — RED (spac_batch overallPct
   *   100 -> 20).
   * MUTATION: `f.eligibleForCoverage === true` -> truthiness — RED
   *   (dirty_inputs eligible 4 -> 5).
   * MUTATION: `held >= US_COVERAGE_TARGET_YEARS` -> `>` — RED
   *   (boundary_exactly_target 50 -> 0).
   */
  for (const c of contract.cases) {
    it(`case: ${c.name}`, () => {
      const actual = judgeCoverage(
        c.filers as readonly UsCoverageFiler[],
      ) as unknown as Record<string, number>;

      for (const key of COUNT_KEYS) {
        assert.equal(
          actual[key],
          c.expected[key],
          `${c.name}.${key} — ${c.why}`,
        );
      }
      for (const key of PCT_KEYS) {
        const diff = Math.abs((actual[key] ?? NaN) - (c.expected[key] ?? NaN));
        assert.ok(
          diff < TOLERANCE,
          `${c.name}.${key}: got ${actual[key]}, contract says ${c.expected[key]} — ${c.why}`,
        );
      }
    });
  }
});

describe("US coverage gate — properties the contract file cannot express", () => {
  it("an empty population scores 100, never NaN", () => {
    // Stated on its own so it cannot be lost with a case-list edit. A NaN here
    // fails SILENTLY IN BOTH DIRECTIONS: `NaN >= 95` is false and so is
    // `NaN < 95`, so a threshold written either way reports the wrong thing
    // without throwing.
    const judged: UsCoverageJudgement = judgeCoverage([]);
    assert.equal(judged.pct, 100);
    assert.equal(judged.overallPct, 100);
    assert.ok(!Number.isNaN(judged.pct));
    assert.equal(
      judged.eligible,
      0,
      "the caller's only way to tell vacuously-satisfied from measured-100",
    );
  });

  it("non-finite year counts floor to zero rather than passing the threshold", () => {
    // JSON cannot express Infinity or NaN, so this is asserted here and in the
    // Python suite separately.
    const judged = judgeCoverage([
      {
        eligibleForCoverage: true,
        fiscalYearsOnFile: 9,
        statementYears: Number.POSITIVE_INFINITY,
      },
      {
        eligibleForCoverage: true,
        fiscalYearsOnFile: 9,
        statementYears: Number.NaN,
      },
    ]);
    assert.equal(judged.eligible, 2);
    // Infinity would otherwise sail past `>= 5` and count as covered on a value
    // that is not a measurement at all.
    assert.equal(judged.eligibleCovered, 0);
    assert.equal(judged.pct, 0);
  });

  it("ten uncovered ineligible filers do not move the gate by a point", () => {
    const eligibleOnly: UsCoverageFiler[] = [
      { eligibleForCoverage: true, fiscalYearsOnFile: 9, statementYears: 9 },
      { eligibleForCoverage: true, fiscalYearsOnFile: 9, statementYears: 1 },
    ];
    const spacs: UsCoverageFiler[] = Array.from({ length: 10 }, () => ({
      eligibleForCoverage: false,
      fiscalYearsOnFile: 2,
      statementYears: 0,
    }));

    assert.equal(
      judgeCoverage(eligibleOnly).pct,
      judgeCoverage([...eligibleOnly, ...spacs]).pct,
    );

    // ...and they ARE visible, in the bucket built for them. Without this half,
    // "excluded from the gate" and "not measured at all" read the same.
    const withSpacs = judgeCoverage([...eligibleOnly, ...spacs]);
    assert.equal(withSpacs.ineligible, 10);
    assert.equal(withSpacs.ineligibleWithAllAvailable, 0);
    assert.ok(withSpacs.overallPct < 100);
  });
});

/* ════════════════════════════════════════════════════════════════════════
   The ops script — scripts/data/edgar-coverage-report.ts
   ═══════════════════════════════════════════════════════════════════════ */

describe("edgar-coverage-report — the --fail-under gate", () => {
  /*
   * MUTATION: `return args.pct < args.failUnder ? FAIL : PASS`
   *   -> always `{verdict: "PASS", exitCode: 0}` — RED. This is the mutation
   *   that matters: a --fail-under that does not fail is a script that prints a
   *   percentage, exits 0, and is believed.
   * MUTATION: `exitCode: 1` on FAIL -> `exitCode: 0` — RED.
   * MUTATION: `args.pct < args.failUnder` -> `<=` — RED (the exactly-at-the-bar
   *   case flips).
   * MUTATION: fold NOT_EVALUATED into PASS — RED.
   */

  it("fails below the bar and sets exit code 1", () => {
    assert.deepEqual(
      decideGate({ status: "MEASURED", pct: 94.99, failUnder: 95 }),
      { verdict: "FAIL", exitCode: 1 },
    );
  });

  it("passes at and above the bar", () => {
    // --fail-under=95 means 95 is ACCEPTABLE. `<=` here would fail a release
    // that met its own target exactly.
    assert.deepEqual(
      decideGate({ status: "MEASURED", pct: 95, failUnder: 95 }),
      {
        verdict: "PASS",
        exitCode: 0,
      },
    );
    assert.deepEqual(
      decideGate({ status: "MEASURED", pct: 99.5, failUnder: 95 }),
      { verdict: "PASS", exitCode: 0 },
    );
  });

  it("with no --fail-under it is a measurement, not a gate", () => {
    assert.deepEqual(
      decideGate({ status: "MEASURED", pct: 3, failUnder: null }),
      { verdict: "NOT_REQUESTED", exitCode: 0 },
    );
  });

  it("an empty population is NOT_EVALUATED — a distinct verdict, not a PASS", () => {
    // Exits 0, because a gate over an empty set is vacuously satisfied. But it
    // must say so: reporting PASS at 95% for a database with nothing in it is
    // the "cached a failure as a success" shape, and NOT_EVALUATED is the
    // distinct value that prevents it.
    const verdicts = [
      decideGate({ status: "NO_DATA", pct: null, failUnder: 95 }),
      decideGate({ status: "NO_DATA", pct: 100, failUnder: 95 }),
      decideGate({ status: "MEASURED", pct: null, failUnder: 95 }),
    ];
    for (const v of verdicts) {
      assert.equal(v.verdict, "NOT_EVALUATED");
      assert.equal(v.exitCode, 0);
    }
  });

  it("a NaN percentage never reads as a pass", () => {
    // `NaN < 95` is false, so a bare comparison would silently PASS. `NaN >= 95`
    // is also false, so writing the check the other way would silently FAIL. The
    // only correct answer is neither.
    assert.equal(
      decideGate({ status: "MEASURED", pct: Number.NaN, failUnder: 95 })
        .verdict,
      "NOT_EVALUATED",
    );
  });
});

describe("edgar-coverage-report — argv", () => {
  /*
   * MUTATION: make an unparseable --fail-under fall back to `null` instead of
   *   throwing — RED. That fallback is the exact failure this parser exists to
   *   prevent: MONEY-1261 lost a chain to `--to 1999-12-31` silently reverting
   *   to a default and walking 18,600 requests instead of 2,600. A parser whose
   *   failure mode is "no gate" is worse than none.
   * MUTATION: accept unknown flags instead of throwing — RED.
   */

  it("accepts both the equals and the space form", () => {
    // `scripts/data/*` uses the space form and `scripts/jobs/tiingo-*` uses the
    // equals form. Two dialects in one repo already cost a release, so this
    // script takes both rather than adding a third rule to remember.
    assert.equal(parseArgs(["--fail-under=95"]).failUnder, 95);
    assert.equal(parseArgs(["--fail-under", "95"]).failUnder, 95);
    assert.equal(parseArgs(["--json"]).json, true);
    assert.equal(parseArgs([]).failUnder, null);
  });

  it("refuses a --fail-under it cannot parse rather than skipping the gate", () => {
    for (const argv of [
      ["--fail-under=abc"],
      ["--fail-under="],
      ["--fail-under"],
      ["--fail-under=-1"],
      ["--fail-under=101"],
      ["--fail-under=NaN"],
      ["--fail-under=Infinity"],
    ]) {
      assert.throws(
        () => parseArgs(argv),
        /--fail-under needs a number/,
        `parseArgs(${JSON.stringify(argv)}) should have thrown`,
      );
    }
  });

  it("refuses an unknown flag", () => {
    assert.throws(() => parseArgs(["--fail-over=95"]), /Unknown option/);
  });
});

describe("edgar-acceptance — absence IS failure", () => {
  /*
   * MUTATION: `exitCode: failures.length === 0 ? 0 : 1` -> always `0` — RED.
   *   THE mutation for this script: an acceptance that exits 0 on missing data
   *   prints an empty report and is believed by CI.
   * MUTATION: treat an unknown leg as reported-only instead of required — RED.
   * MUTATION: count a DEGRADED-but-present leg as a failure — RED (a warning
   *   would become a release blocker).
   * MUTATION: fold `reportedOnlyAbsences` into `failures` — RED (a mega-cap
   *   with no 13D/G would fail the acceptance for a fact about the market).
   */

  /** Every required leg absent — what an EMPTY DATABASE produces. */
  const emptyDatabase = [
    ...REQUIRED_LEGS.map((leg) => ({
      leg,
      subject: "AAPL",
      present: false,
      reason: "NO_ROWS_FOR_QUERY",
    })),
    ...REPORTED_ONLY_LEGS.map((leg) => ({
      leg,
      subject: "AAPL",
      present: false,
      reason: "NO_ROWS_FOR_QUERY",
    })),
  ];

  it("an empty database FAILS, with one named reason per required leg", () => {
    const v = judgeAcceptance(emptyDatabase);
    assert.equal(v.verdict, "FAIL");
    assert.equal(
      v.exitCode,
      1,
      "an acceptance that exits 0 on no data is believed",
    );
    assert.equal(v.failures.length, REQUIRED_LEGS.length);
    assert.deepEqual(
      v.failures.map((f) => f.reason).sort(),
      REQUIRED_LEGS.map((l) => `MISSING_${l}`).sort(),
    );
  });

  it("a reported-only leg's absence is named, never counted as a failure", () => {
    const v = judgeAcceptance(emptyDatabase);
    // Named, not silent: "deliberately not required" and "never looked at"
    // must not read the same.
    assert.deepEqual(v.reportedOnlyAbsences, ["BENEFICIAL AAPL"]);
    assert.ok(!v.failures.some((f) => f.leg === "BENEFICIAL"));
  });

  it("everything present PASSES and exits 0", () => {
    const v = judgeAcceptance(
      REQUIRED_LEGS.map((leg) => ({ leg, subject: "AAPL", present: true })),
    );
    assert.equal(v.verdict, "PASS");
    assert.equal(v.exitCode, 0);
    assert.deepEqual(v.failures, []);
  });

  it("a DEGRADED but present leg is a warning, not a failure", () => {
    // `degraded` is separate from `reason` precisely because a non-empty result
    // can still be an incomplete one — 13F holders with no prior period make
    // every QoQ delta meaningless without making the run broken.
    const v = judgeAcceptance([
      {
        leg: "HOLDERS",
        subject: "AAPL",
        present: true,
        degraded: true,
        reason: "NO_PRIOR_13F_PERIOD",
      },
    ]);
    assert.equal(v.verdict, "PASS");
    assert.equal(v.exitCode, 0);
    assert.equal(v.warnings.length, 1);
    assert.match(v.warnings[0] ?? "", /DEGRADED/);
    assert.match(v.warnings[0] ?? "", /NO_PRIOR_13F_PERIOD/);
  });

  it("a leg nobody classified counts as REQUIRED", () => {
    // Fail-safe direction. A leg added to the script and forgotten in
    // REQUIRED_LEGS must not silently become optional.
    const v = judgeAcceptance([
      {
        leg: "SOMETHING_NEW" as (typeof REQUIRED_LEGS)[number],
        subject: "AAPL",
        present: false,
      },
    ]);
    assert.equal(v.verdict, "FAIL");
    assert.equal(v.failures[0]?.reason, "MISSING_SOMETHING_NEW");
  });

  it("the two point-in-time failures stay distinct", () => {
    // "The seam returned the newer filing" and "there was no restated period to
    // test with" are two different facts; collapsing them would report a data
    // condition as a code defect, or let the second pass as a success.
    const wrongFiling = judgeAcceptance([
      {
        leg: "POINT_IN_TIME",
        subject: "AAPL 2025-06-28",
        present: false,
        detail: "POINT_IN_TIME_RETURNED_NEWER — …",
      },
    ]);
    const nothingToTest = judgeAcceptance([
      {
        leg: "POINT_IN_TIME",
        subject: "AAPL (no restated period found)",
        present: false,
        detail: "POINT_IN_TIME_NO_MULTI_FILING_PERIOD — …",
      },
    ]);
    assert.equal(wrongFiling.exitCode, 1);
    assert.equal(nothingToTest.exitCode, 1);
    assert.notEqual(
      wrongFiling.failures[0]?.detail,
      nothingToTest.failures[0]?.detail,
    );
    assert.match(
      wrongFiling.failures[0]?.detail ?? "",
      /POINT_IN_TIME_RETURNED_NEWER/,
    );
    assert.match(
      nothingToTest.failures[0]?.detail ?? "",
      /POINT_IN_TIME_NO_MULTI_FILING_PERIOD/,
    );
  });
});

describe("edgar-coverage-report — percentile", () => {
  it("an empty sample is null, never zero", () => {
    // A p95 of zero seconds reads as "detection is instant", which is the most
    // flattering possible rendering of "we have never measured it".
    //
    // MUTATION: `return 0` for an empty array — RED.
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([], 95), null);
  });

  it("nearest-rank over a sorted sample", () => {
    const sample = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    assert.equal(percentile(sample, 50), 5);
    assert.equal(percentile(sample, 95), 10);
    assert.equal(percentile(sample, 100), 10);
    assert.equal(percentile([42], 95), 42);
  });
});
