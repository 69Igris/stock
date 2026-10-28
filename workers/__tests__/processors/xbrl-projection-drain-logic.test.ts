/**
 * The XBRL projection drain must TERMINATE, and must not arm itself — MONEY-1235.
 *
 * ## What this file exists to stop
 *
 * `scripts/jobs/xbrl-projection-drain.ts` pages `processXbrlProjectionWrite`
 * until the backlog is gone. Its cursor is `XbrlFiling.projectedAt`, a column
 * the WRITER stamps — so a page advances only because the previous page stamped
 * something. And the writer deliberately stamps neither:
 *
 *   - a dry run (`apply === false` stamps NOTHING AT ALL, so a rehearsal leaves
 *     no trace for the first armed run to skip), nor
 *   - `notDecidedIds` — create-suppressed and no-instrument, because neither is
 *     a property of the FILING, nor
 *   - `failedIds`, which are retried next run with no new bytes.
 *
 * Each of those is a page that reads thousands of filings and moves the cursor
 * zero. A `while (filingsRead > 0)` loop spins on any of them for the job's full
 * 24 h task timeout, writing nothing, and the only evidence is a log that
 * repeats. On the population that matters this is not hypothetical: prod holds
 * 0 QUARTERLY `stock_financials` rows against 71,450 QUARTERLY filings, so
 * without `--create-missing` EVERY quarterly write is a suppressed create and
 * the very first batch is non-advancing.
 *
 * ## Why the tests are here and not against the job file
 *
 * `xbrl-projection-drain.ts` calls `main()` at module top level — the Cloud Run
 * entry-point convention (running the bundle runs the job), shared with
 * `xbrl-backfill.ts`. Importing it would run the job against a real database.
 * The decisions therefore live in `xbrl-projection-drain-logic.mts`, which
 * imports nothing at runtime, and the loop takes its batch runner, its counter
 * and its clock as dependencies — so all five stop reasons are reachable in
 * milliseconds instead of only after several batches against a 90,188-row
 * table.
 */

import { getMessageId, parsePubSubMessage } from "../../src/lib/message";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseDrainArgs,
  resolveDrainApply,
  isDrainArmed,
  decideAfterBatch,
  runDrainLoop,
  accumulate,
  emptyDrainTotals,
  drainExitCode,
  hasFilterMismatch,
  describeDrainOutcome,
  describeDrainStop,
  DEFAULT_DRAIN_LIMIT,
  MAX_DRAIN_LIMIT,
  DEFAULT_MAX_BATCHES,
  DEFAULT_BUDGET_MS,
  type DrainOutcome,
  type DrainLoopState,
  type BatchProgress,
} from "../../../scripts/jobs/xbrl-projection-drain-logic.mjs";
// The REAL result type, not a local shape: a counter renamed in the writer is a
// type error here rather than a silently-zero total.
import type { XbrlProjectionWriteResult } from "../../src/processors/xbrl-projection-writer";

/** A writer result with everything zeroed, overridden per test. */
function result(
  over: Partial<XbrlProjectionWriteResult> = {},
): XbrlProjectionWriteResult {
  return {
    ok: true,
    apply: true,
    createMissing: false,
    filingsRead: 0,
    truncatedByLimit: false,
    deferredByPagination: 0,
    refused: {
      HALF_YEARLY_HAS_NO_BUCKET: 0,
      CUMULATIVE_IS_NOT_A_QUARTER: 0,
      PERIOD_SPAN_CONTRADICTS_TYPE: 0,
      NO_USABLE_PERIOD: 0,
    },
    periods: 0,
    supersededSiblings: 0,
    unreadableFacts: 0,
    refusedScaleSuspect: 0,
    // MONEY-1326 — these EIGHT drifted INTO `XbrlProjectionWriteResult` while
    // this helper stood still, and the comment on the import above promised
    // exactly the protection that was not running: "a counter renamed in the
    // writer is a type error here rather than a silently-zero total". It was
    // not a type error, because nothing ran `tsc` over `workers/__tests__`.
    //
    // `accumulate` sums by walking `Object.entries(result)` and skipping
    // non-numbers, so an absent key is not summed as `undefined` — it never
    // reaches `totals.counters` at all. That is the quieter failure: the drain
    // was modelled against a writer result eight fields narrower than the real
    // one, so no assertion here could reach them and the totals they belong in
    // simply had no such line.
    refusedBasisConflict: 0,
    skippedScaleUnconfirmed: 0,
    skippedScaleCheck: 0,
    scaleContextFetched: 0,
    scaleContextTruncated: false,
    statementsProjected: 0,
    created: 0,
    updated: 0,
    displaced: 0,
    skippedAuthority: 0,
    skippedUnchanged: 0,
    skippedBasisDowngrade: 0,
    skippedStandaloneNoDisplace: 0,
    skippedNoInstrument: 0,
    skippedCreateSuppressed: 0,
    failed: 0,
    // ...and the last three of the eight. Inert for the drain's own decisions
    // (`decideAfterBatch` models advancement from the FAKE TABLE's shrinking
    // `remaining`, never from a stamp counter), but part of the shape this
    // helper claims to produce. NOTE `stampFailed` is a BOOLEAN, not a count —
    // the drifted set was not even type-uniform, which is the other thing a
    // hand-maintained mirror of a 31-field result cannot keep straight.
    stampAttempted: 0,
    stamped: 0,
    stampFailed: false,
    examples: [],
    ...over,
  };
}

/**
 * A fake `xbrl_filings` table that behaves like the real cursor.
 *
 * `remaining` shrinks by `stampPerBatch` only when `apply` is true — which is
 * the property the whole loop turns on. Modelling it (rather than handing the
 * loop a canned sequence of numbers) is what makes the dry-run and
 * non-advancing cases the SAME code path they are in production.
 */
function fakeTable(opts: {
  population: number;
  limit: number;
  apply: boolean;
  /** Filings the writer stamps per batch. 0 models an all-notDecided page. */
  stampPerBatch?: number;
  msPerBatch?: number;
}) {
  let remaining = opts.population;
  let clock = 0;
  const batches: number[] = [];
  return {
    get remaining() {
      return remaining;
    },
    get batches() {
      return batches.length;
    },
    now: () => clock,
    countRemaining: async () => remaining,
    runBatch: async () => {
      const read = Math.min(opts.limit, remaining);
      batches.push(read);
      clock += opts.msPerBatch ?? 1;
      if (opts.apply) {
        const stamped = Math.min(opts.stampPerBatch ?? read, read, remaining);
        remaining -= stamped;
      }
      return result({ filingsRead: read, apply: opts.apply });
    },
  };
}

// ─── Arming ───────────────────────────────────────────────────────────────

describe("arming: the env writes, the flag can only narrow (MONEY-1235)", () => {
  const cases: Array<{
    name: string;
    env: string | undefined;
    apply: boolean;
    dryRun: boolean;
    expect: boolean;
  }> = [
    {
      name: 'env "true" + --apply -> WRITES',
      env: "true",
      apply: true,
      dryRun: false,
      expect: true,
    },
    {
      name: 'env "true" + no --apply -> dry run (the CLI default is safe)',
      env: "true",
      apply: false,
      dryRun: false,
      expect: false,
    },
    {
      name: 'env "true" + --apply + --dry-run -> --dry-run NARROWS',
      env: "true",
      apply: true,
      dryRun: true,
      expect: false,
    },
    {
      name: 'env "false" + --apply -> a FLAG CANNOT ARM',
      env: "false",
      apply: true,
      dryRun: false,
      expect: false,
    },
    {
      name: "env absent + --apply -> a FLAG CANNOT ARM",
      env: undefined,
      apply: true,
      dryRun: false,
      expect: false,
    },
    {
      name: 'env "TRUE" -> literal comparison, not case-insensitive',
      env: "TRUE",
      apply: true,
      dryRun: false,
      expect: false,
    },
    {
      name: 'env "1" -> literal comparison, not truthiness',
      env: "1",
      apply: true,
      dryRun: false,
      expect: false,
    },
    {
      name: 'env " true" -> literal comparison, not trimmed',
      env: " true",
      apply: true,
      dryRun: false,
      expect: false,
    },
    {
      name: 'env "" -> not armed',
      env: "",
      apply: true,
      dryRun: false,
      expect: false,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const env: NodeJS.ProcessEnv =
        c.env === undefined ? {} : { XBRL_PROJECTION_APPLY: c.env };
      assert.equal(
        resolveDrainApply({ apply: c.apply, dryRun: c.dryRun }, env),
        c.expect,
      );
    });
  }

  it('Boolean("false") is true — which is why the literal compare exists', () => {
    // The trap, stated as an executable fact rather than as a comment. A
    // `Boolean(env.XBRL_PROJECTION_APPLY)` implementation would arm the job in
    // the ONE configuration meant to keep it off, and "false" is exactly the
    // value both cloudbuild specs and the drain job spec ship.
    assert.equal(Boolean("false"), true);
    assert.equal(isDrainArmed({ XBRL_PROJECTION_APPLY: "false" }), false);
  });

  it("no combination of flags can write against an unarmed environment", () => {
    // Exhaustive over the CLI half. The environment is the only arm; if any
    // flag pair below returned true, the one-way door (StockFinancials has no
    // `source` in its unique key) would be openable by a keystroke.
    for (const apply of [true, false]) {
      for (const dryRun of [true, false]) {
        for (const env of ["false", "", "1", "TRUE", "yes"]) {
          assert.equal(
            resolveDrainApply(
              { apply, dryRun },
              { XBRL_PROJECTION_APPLY: env },
            ),
            false,
            `apply=${apply} dryRun=${dryRun} env=${JSON.stringify(env)} armed a run`,
          );
        }
        assert.equal(resolveDrainApply({ apply, dryRun }, {}), false);
      }
    }
  });

  it("the processor's own arming rule has not drifted from this one", () => {
    // `isDrainArmed` restates `isProjectionArmed` so the logic module stays
    // importable without Prisma. The restatement is closed from both ends: the
    // job asserts the two agree on the live env at startup, and this reads the
    // processor's source so a change over there goes red HERE, where the
    // duplicate lives.
    const src = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "src",
        "processors",
        "xbrl-projection.ts",
      ),
      "utf8",
    );
    assert.match(
      src,
      /env\.XBRL_PROJECTION_APPLY === "true"/,
      "workers/src/processors/xbrl-projection.ts no longer compares " +
        'XBRL_PROJECTION_APPLY against the literal "true". ' +
        "scripts/jobs/xbrl-projection-drain-logic.mts restates that rule and " +
        "must be changed with it.",
    );
  });
});

// ─── Argument parsing ─────────────────────────────────────────────────────

describe("argument defaults are the SAFE ones (MONEY-1235)", () => {
  it("no arguments = dry run, no creates, both buckets, every symbol", () => {
    const { args, errors } = parseDrainArgs([]);
    assert.deepEqual(errors, []);
    assert.equal(args.apply, false, "--apply must default OFF");
    assert.equal(
      args.createMissing,
      false,
      "--create-missing must default OFF",
    );
    assert.equal(args.dryRun, false);
    assert.equal(args.periodTypes, undefined);
    assert.equal(args.symbols, undefined);
    assert.equal(args.limit, DEFAULT_DRAIN_LIMIT);
    assert.equal(args.maxBatches, DEFAULT_MAX_BATCHES);
    assert.equal(args.budgetMs, DEFAULT_BUDGET_MS);
  });

  it("parses the full flag set", () => {
    const { args, errors } = parseDrainArgs([
      "--apply",
      "--create-missing",
      "--period-types=QUARTERLY,ANNUAL",
      "--limit=200",
      "--symbols=reliance, tcs ,RELIANCE",
      "--max-batches=3",
      "--budget-sec=60",
    ]);
    assert.deepEqual(errors, []);
    assert.equal(args.apply, true);
    assert.equal(args.createMissing, true);
    assert.deepEqual(args.periodTypes, ["QUARTERLY", "ANNUAL"]);
    assert.equal(args.limit, 200);
    // Trimmed, upper-cased and DEDUPED — `symbol: { in: [...] }` with a
    // duplicate is not wrong, but the count is printed and a doubled count
    // reads as a bigger pilot than was actually run.
    assert.deepEqual(args.symbols, ["RELIANCE", "TCS"]);
    assert.equal(args.maxBatches, 3);
    assert.equal(args.budgetMs, 60_000);
  });

  it("an UNKNOWN argument is fatal, not ignored", () => {
    // The asymmetry that makes this worth erroring on: `--aply` parses as "no
    // flags", runs one dry batch, stops with reason `dry-run` and exits 0 —
    // indistinguishable from a deliberate rehearsal. A six-hour founder-invoked
    // window that reports success and writes nothing is the MONEY-1220
    // "merged is not live" shape restated at the command line.
    const { errors } = parseDrainArgs(["--aply", "--create-missing"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /unknown argument "--aply"/);
  });

  it("a mistyped --period-types value is fatal, not silently widened", () => {
    // Dropping the token would widen the run to BOTH buckets — the opposite of
    // what was asked — and the operator would read the wider result as
    // confirmation.
    const { errors, args } = parseDrainArgs(["--period-types=QUATERLY"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /QUATERLY/);
    assert.equal(args.periodTypes, undefined);
  });

  it("HALF_YEARLY is rejected — it has no StockFinancials bucket", () => {
    const { errors } = parseDrainArgs(["--period-types=HALF_YEARLY"]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /HALF_YEARLY/);
  });

  it("an EMPTY --symbols is fatal, never read as 'every symbol'", () => {
    // Silently widening would turn a scoped pilot into a whole-universe write
    // through a unique key with no `source` column.
    const { errors } = parseDrainArgs(["--symbols="]);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /--symbols was given but empty/);
  });

  it("--limit is clamped to the nightly job's own ceiling", () => {
    const over = parseDrainArgs([`--limit=${MAX_DRAIN_LIMIT + 1}`]);
    assert.equal(over.errors.length, 1);
    assert.match(over.errors[0]!, /exceeds the maximum/);
    assert.equal(over.args.limit, DEFAULT_DRAIN_LIMIT);

    assert.deepEqual(parseDrainArgs([`--limit=${MAX_DRAIN_LIMIT}`]).errors, []);
  });

  for (const bad of ["0", "-5", "abc", "1.5", "NaN", "Infinity"]) {
    it(`--limit=${bad} is rejected`, () => {
      const { errors, args } = parseDrainArgs([`--limit=${bad}`]);
      assert.equal(errors.length, 1, `--limit=${bad} was accepted`);
      assert.equal(args.limit, DEFAULT_DRAIN_LIMIT);
    });
  }

  it("--dry-run alone is legal and keeps apply off", () => {
    const { args, errors } = parseDrainArgs(["--dry-run"]);
    assert.deepEqual(errors, []);
    assert.equal(args.dryRun, true);
    assert.equal(args.apply, false);
  });
});

// ─── Termination: the single-step decision ────────────────────────────────

describe("decideAfterBatch: every stop condition (MONEY-1235)", () => {
  const state = (over: Partial<DrainLoopState> = {}): DrainLoopState => ({
    apply: true,
    batchesRun: 1,
    maxBatches: 100,
    elapsedMs: 0,
    budgetMs: 1_000_000,
    ...over,
  });
  const progress = (over: Partial<BatchProgress> = {}): BatchProgress => ({
    filingsRead: 100,
    remainingBefore: 1000,
    remainingAfter: 900,
    ...over,
  });

  it("an advancing page continues", () => {
    assert.equal(decideAfterBatch(state(), progress()), null);
  });

  it("an EMPTY page is `drained`", () => {
    assert.equal(
      decideAfterBatch(state(), progress({ filingsRead: 0 })),
      "drained",
    );
  });

  it("a dry run stops after one batch — it stamps nothing", () => {
    assert.equal(
      decideAfterBatch(
        state({ apply: false }),
        progress({ remainingAfter: 1000 }),
      ),
      "dry-run",
    );
  });

  it("an armed page that did not shrink the population is `no-advance`", () => {
    assert.equal(
      decideAfterBatch(state(), progress({ remainingAfter: 1000 })),
      "no-advance",
    );
  });

  it("a population that GREW is also `no-advance`", () => {
    // xbrl-sync inserting filings mid-drain. Either way the population is not
    // shrinking, which is the only property the loop can converge on.
    assert.equal(
      decideAfterBatch(state(), progress({ remainingAfter: 1200 })),
      "no-advance",
    );
  });

  it("`max-batches` fires at the cap", () => {
    assert.equal(
      decideAfterBatch(state({ batchesRun: 5, maxBatches: 5 }), progress()),
      "max-batches",
    );
  });

  it("`budget` fires at the wall clock", () => {
    assert.equal(
      decideAfterBatch(state({ elapsedMs: 1000, budgetMs: 1000 }), progress()),
      "budget",
    );
  });

  describe("ORDER — a wrong precedence sends the operator to the wrong fix", () => {
    it("`drained` outranks `max-batches` and `budget`", () => {
      // Otherwise a finished run reports PARTIAL and someone re-runs it.
      assert.equal(
        decideAfterBatch(
          state({ batchesRun: 5, maxBatches: 5, elapsedMs: 9e9, budgetMs: 1 }),
          progress({ filingsRead: 0 }),
        ),
        "drained",
      );
    });

    it("`dry-run` outranks `no-advance`", () => {
      // A dry run stamps nothing BY DESIGN, so it always looks like a stalled
      // cursor. Reporting it as a stall would make the normal rehearsal read as
      // a defect — and the "fix" would be to make dry runs stamp, which is
      // exactly what must not happen (the first armed run would then skip
      // everything a rehearsal decided).
      assert.equal(
        decideAfterBatch(
          state({ apply: false }),
          progress({ remainingAfter: 1000 }),
        ),
        "dry-run",
      );
    });

    it("`no-advance` outranks `max-batches` and `budget`", () => {
      // no-advance is terminal and diagnostic; the caps only say "come back
      // later", which would send someone into a re-run loop against a page that
      // can never advance.
      assert.equal(
        decideAfterBatch(
          state({ batchesRun: 5, maxBatches: 5, elapsedMs: 9e9, budgetMs: 1 }),
          progress({ remainingAfter: 1000 }),
        ),
        "no-advance",
      );
    });
  });
});

// ─── Termination: the loop ────────────────────────────────────────────────

describe("runDrainLoop terminates (MONEY-1235)", () => {
  it("drains a finite population and stops on the empty page", async () => {
    const t = fakeTable({ population: 250, limit: 100, apply: true });
    const outcome = await runDrainLoop(
      { apply: true, maxBatches: 50, budgetMs: 1e9 },
      { runBatch: t.runBatch, countRemaining: t.countRemaining, now: t.now },
    );
    assert.equal(outcome.stop, "drained");
    // 100 + 100 + 50, then one empty page to observe the drain.
    assert.equal(outcome.totals.batches, 4);
    assert.equal(outcome.remainingAtStart, 250);
    assert.equal(outcome.remainingAtEnd, 0);
    assert.equal(drainExitCode(outcome), 0);
    assert.equal(hasFilterMismatch(outcome), false);
  });

  it("a DRY RUN stops after ONE batch instead of re-reading page 1 forever", async () => {
    // The failure this is here for: `apply:false` means the writer stamps
    // nothing, so `remaining` never moves and a naive loop reads the identical
    // 2000 filings until the 24h task timeout.
    const t = fakeTable({ population: 90_188, limit: 2000, apply: false });
    const outcome = await runDrainLoop(
      { apply: false, maxBatches: 200, budgetMs: 1e9 },
      { runBatch: t.runBatch, countRemaining: t.countRemaining, now: t.now },
    );
    assert.equal(outcome.stop, "dry-run");
    assert.equal(outcome.totals.batches, 1);
    assert.equal(outcome.remainingAtEnd, 90_188);
    // A rehearsal that did what an unarmed run is supposed to do is a SUCCESS.
    assert.equal(drainExitCode(outcome), 0);
  });

  it("an ARMED but non-advancing page stops instead of spinning", async () => {
    // The production shape: --create-missing OFF against a quarterly population
    // with zero incumbent rows. Every filing is create-suppressed, which the
    // writer deliberately does NOT stamp (it is a property of the RUN, not the
    // filing), so the page never changes.
    const t = fakeTable({
      population: 71_450,
      limit: 2000,
      apply: true,
      stampPerBatch: 0,
    });
    const outcome = await runDrainLoop(
      { apply: true, maxBatches: 200, budgetMs: 1e9 },
      { runBatch: t.runBatch, countRemaining: t.countRemaining, now: t.now },
    );
    assert.equal(outcome.stop, "no-advance");
    assert.equal(outcome.totals.batches, 1);
    assert.equal(outcome.remainingAtStart, 71_450);
    assert.equal(outcome.remainingAtEnd, 71_450);
    assert.equal(drainExitCode(outcome), 1);
  });

  it("a page that PARTLY advances keeps going — the guard is not trigger-happy", async () => {
    // Real drains leave residue: a few no-instrument filings sit at the front of
    // every page in symbol order. As long as SOMETHING is stamped, the loop must
    // continue, or the guard would end every run on batch 1.
    const t = fakeTable({
      population: 100,
      limit: 50,
      apply: true,
      stampPerBatch: 40,
    });
    const outcome = await runDrainLoop(
      { apply: true, maxBatches: 50, budgetMs: 1e9 },
      { runBatch: t.runBatch, countRemaining: t.countRemaining, now: t.now },
    );
    // 100 -> 60 -> 20 -> 0 (third batch reads 20, stamps 20), then empty page.
    assert.equal(outcome.stop, "drained");
    assert.equal(outcome.totals.batches, 4);
    assert.equal(outcome.remainingAtEnd, 0);
  });

  it("stops on `max-batches` and reports the run as PARTIAL", async () => {
    const t = fakeTable({ population: 1_000_000, limit: 100, apply: true });
    const outcome = await runDrainLoop(
      { apply: true, maxBatches: 3, budgetMs: 1e9 },
      { runBatch: t.runBatch, countRemaining: t.countRemaining, now: t.now },
    );
    assert.equal(outcome.stop, "max-batches");
    assert.equal(outcome.totals.batches, 3);
    assert.equal(outcome.remainingAtEnd, 1_000_000 - 300);
    assert.equal(drainExitCode(outcome), 1);
  });

  it("stops on the wall-clock `budget`", async () => {
    const t = fakeTable({
      population: 1_000_000,
      limit: 100,
      apply: true,
      msPerBatch: 400,
    });
    const outcome = await runDrainLoop(
      { apply: true, maxBatches: 200, budgetMs: 1000 },
      { runBatch: t.runBatch, countRemaining: t.countRemaining, now: t.now },
    );
    assert.equal(outcome.stop, "budget");
    // 400, 800 -> continue; 1200 >= 1000 -> stop. The budget is checked BETWEEN
    // batches and cannot interrupt one, which is why the task timeout has to
    // stay above budget + one batch.
    assert.equal(outcome.totals.batches, 3);
    assert.equal(outcome.elapsedMs, 1200);
    assert.equal(drainExitCode(outcome), 1);
  });

  it("maxBatches < 1 runs ZERO batches", async () => {
    // A caller that passes 0 means 0. Running "just one" would be a write the
    // caller did not ask for.
    let ran = 0;
    const outcome = await runDrainLoop(
      { apply: true, maxBatches: 0, budgetMs: 1e9 },
      {
        runBatch: async () => {
          ran++;
          return result({ filingsRead: 100 });
        },
        countRemaining: async () => 500,
        now: () => 0,
      },
    );
    assert.equal(ran, 0);
    assert.equal(outcome.stop, "max-batches");
    assert.equal(outcome.totals.batches, 0);
  });

  it("an empty population drains on batch 1 without writing", async () => {
    const t = fakeTable({ population: 0, limit: 2000, apply: true });
    const outcome = await runDrainLoop(
      { apply: true, maxBatches: 200, budgetMs: 1e9 },
      { runBatch: t.runBatch, countRemaining: t.countRemaining, now: t.now },
    );
    assert.equal(outcome.stop, "drained");
    assert.equal(outcome.totals.batches, 1);
    assert.equal(drainExitCode(outcome), 0);
  });

  it("reports every batch through onBatch, with before/after counts", async () => {
    const t = fakeTable({ population: 150, limit: 100, apply: true });
    const seen: BatchProgress[] = [];
    await runDrainLoop(
      { apply: true, maxBatches: 50, budgetMs: 1e9 },
      {
        runBatch: t.runBatch,
        countRemaining: t.countRemaining,
        now: t.now,
        onBatch: (_i, _r, p) => seen.push(p),
      },
    );
    assert.deepEqual(seen, [
      { filingsRead: 100, remainingBefore: 150, remainingAfter: 50 },
      { filingsRead: 50, remainingBefore: 50, remainingAfter: 0 },
      { filingsRead: 0, remainingBefore: 0, remainingAfter: 0 },
    ]);
  });
});

// ─── Accumulation + reporting ─────────────────────────────────────────────

describe("accumulation sums the writer's OWN vocabulary (MONEY-1235)", () => {
  it("sums every numeric counter across batches, by scanning not listing", () => {
    // Scanned rather than enumerated for the reason describeNoWriteReason
    // gives: the hand-written list is what failed there — seven names, three
    // counters added in the same ticket missed, one of them firing on 29.5% of
    // winner periods.
    const totals = emptyDrainTotals();
    accumulate(
      totals,
      result({ filingsRead: 100, created: 10, skippedCreateSuppressed: 5 }),
    );
    accumulate(
      totals,
      result({ filingsRead: 40, created: 4, skippedNoInstrument: 2 }),
    );
    assert.equal(totals.batches, 2);
    assert.equal(totals.counters.filingsRead, 140);
    assert.equal(totals.counters.created, 14);
    assert.equal(totals.counters.skippedCreateSuppressed, 5);
    assert.equal(totals.counters.skippedNoInstrument, 2);
  });

  it("a counter ADDED to the writer is totalled with no edit here", () => {
    // The self-closing property, asserted rather than asserted-about. A future
    // `skippedSomethingNew` is summed the day it appears.
    const totals = emptyDrainTotals();
    const withNew = {
      ...result({ filingsRead: 1 }),
      skippedSomethingNew: 7,
    } as unknown as XbrlProjectionWriteResult;
    accumulate(totals, withNew);
    accumulate(totals, withNew);
    assert.equal(totals.counters.skippedSomethingNew, 14);
  });

  it("sums the nested refusal record and counts truncated / not-ok batches", () => {
    const totals = emptyDrainTotals();
    accumulate(
      totals,
      result({
        truncatedByLimit: true,
        ok: false,
        refused: {
          HALF_YEARLY_HAS_NO_BUCKET: 3,
          CUMULATIVE_IS_NOT_A_QUARTER: 1,
          PERIOD_SPAN_CONTRADICTS_TYPE: 0,
          NO_USABLE_PERIOD: 0,
        },
      }),
    );
    accumulate(
      totals,
      result({
        refused: {
          HALF_YEARLY_HAS_NO_BUCKET: 2,
          CUMULATIVE_IS_NOT_A_QUARTER: 0,
          PERIOD_SPAN_CONTRADICTS_TYPE: 0,
          NO_USABLE_PERIOD: 0,
        },
      }),
    );
    assert.equal(totals.refused.HALF_YEARLY_HAS_NO_BUCKET, 5);
    assert.equal(totals.refused.CUMULATIVE_IS_NOT_A_QUARTER, 1);
    assert.equal(totals.truncatedBatches, 1);
    assert.equal(totals.notOkBatches, 1);
    // `refused` is a nested object, so its keys must NOT also land in
    // `counters` — a double-counted refusal would inflate the summary.
    assert.equal(totals.counters.HALF_YEARLY_HAS_NO_BUCKET, undefined);
  });

  it("caps examples so a common outcome cannot crowd out the rare ones", () => {
    const totals = emptyDrainTotals();
    for (let i = 0; i < 10; i++) {
      accumulate(
        totals,
        result({
          examples: Array.from({ length: 10 }, (_, j) => `e${i}-${j}`),
        }),
      );
    }
    assert.equal(totals.examples.length, 20);
  });
});

describe("outcome reporting (MONEY-1235)", () => {
  const outcome = (over: Partial<DrainOutcome> = {}): DrainOutcome => ({
    stop: "drained",
    apply: true,
    totals: emptyDrainTotals(),
    remainingAtStart: 100,
    remainingAtEnd: 0,
    elapsedMs: 60_000,
    ...over,
  });

  it("`drained` with rows LEFT is a filter mismatch, not a finished run", () => {
    // MONEY-1234's exact defect one level up: countUnprojectedFilings asked
    // `{ projectedAt: null }`, which matches nothing on Mongo, and printed a
    // permanent all-clear over a 90,188-filing backlog. If the writer's page is
    // empty while the count still sees rows, the two filters have diverged.
    const o = outcome({ remainingAtEnd: 42 });
    assert.equal(hasFilterMismatch(o), true);
    assert.equal(drainExitCode(o), 1);
    assert.match(
      describeDrainStop(o, { createMissing: true, limit: 2000 }),
      /DIVERGED/,
    );
  });

  it("any per-row failure forces a non-zero exit even on a clean drain", () => {
    const totals = emptyDrainTotals();
    accumulate(totals, result({ filingsRead: 10, failed: 1 }));
    assert.equal(drainExitCode(outcome({ totals })), 1);
  });

  it("the summary always names the stop reason and both remaining counts", () => {
    // ONE structured summary, including the zero case: a job that selects rows
    // and writes none has to be legible in a log line rather than inferred from
    // a table that stopped growing.
    const totals = emptyDrainTotals();
    accumulate(totals, result({ filingsRead: 2000, created: 1500 }));
    const line = describeDrainOutcome(
      outcome({ stop: "budget", totals, remainingAtEnd: 88_000 }),
    );
    assert.match(line, /stop=budget/);
    assert.match(line, /read=2000/);
    assert.match(line, /created=1500/);
    assert.match(line, /remaining 100 -> 88000/);
  });

  it("the `no-advance` message names --create-missing as the likely cause", () => {
    const o = outcome({ stop: "no-advance", remainingAtEnd: 71_450 });
    const off = describeDrainStop(o, { createMissing: false, limit: 2000 });
    assert.match(off, /create-missing is OFF/);
    assert.match(off, /every quarterly write is a CREATE/i);

    const on = describeDrainStop(o, { createMissing: true, limit: 2000 });
    assert.match(on, /skippedNoInstrument/);
  });

  it("the `dry-run` message says ONE batch is by design, not a truncation", () => {
    const msg = describeDrainStop(outcome({ stop: "dry-run" }), {
      createMissing: true,
      limit: 2000,
    });
    assert.match(msg, /XBRL_PROJECTION_APPLY=true/);
    assert.match(msg, /--apply/);
  });

  it("every DrainStop has a message — no unreachable member", () => {
    for (const stop of [
      "drained",
      "dry-run",
      "no-advance",
      "max-batches",
      "budget",
    ] as const) {
      const msg = describeDrainStop(outcome({ stop }), {
        createMissing: false,
        limit: 2000,
      });
      assert.ok(msg.length > 40, `${stop} has no real message`);
    }
  });
});

// ─── The wiring the job cannot prove about itself ─────────────────────────

describe("the drain job is actually shippable (MONEY-1235)", () => {
  const ROOT = join(import.meta.dirname, "..", "..", "..");
  const jobSrcRaw = readFileSync(
    join(ROOT, "scripts", "jobs", "xbrl-projection-drain.ts"),
    "utf8",
  );

  /**
   * Drop block comments and whole-line `//` comments.
   *
   * Load-bearing for the hand-copy assertion below, and not incidental tidying:
   * it tripped on its own documentation the first time it ran, because the
   * comment EXPLAINING why `{ projectedAt: null }` must not be restated reads
   * exactly like a restatement. `job-build-provenance.test.ts` hit the identical
   * trap with `ARG DD_VERSION=unknown`, and recorded the lesson: a guard that
   * fails on prose it cannot tell apart from code gets its regex loosened by the
   * next person, and loosening is how it stops covering the real thing.
   *
   * Only WHOLE-LINE `//` are dropped — a trailing `//` inside a string literal
   * is not worth the quote-tracking, and dropping the rest of a code line would
   * make this guard blind to something real.
   */
  const jobSrc = jobSrcRaw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");

  it("workers/tsup.config.ts emits dist/xbrl-projection-drain.js", () => {
    // Without the entry the Cloud Run job starts and dies instantly with
    // "Cannot find module /app/dist/xbrl-projection-drain.js" — the whole
    // failure the entry exists to prevent, and one nothing else here can see.
    const tsup = readFileSync(join(ROOT, "workers", "tsup.config.ts"), "utf8");
    assert.match(
      tsup,
      /"xbrl-projection-drain":\s*"\.\.\/scripts\/jobs\/xbrl-projection-drain\.ts"/,
    );
  });

  it("the job passes unprojectedOnly — without it the cursor never moves", () => {
    // MONEY-1211's constant-ordering defect: selection is `[symbol asc,
    // periodEnd desc] take: limit` over a table that only grows at the end, so
    // without the filter every batch receives the identical first page forever.
    assert.match(jobSrc, /unprojectedOnly:\s*true/);
  });

  it("the job reuses UNPROJECTED_FILING_WHERE instead of hand-copying it", () => {
    // The hand-copy is what MONEY-1234 shipped: a second `{ projectedAt: null }`
    // that matches nothing on Mongo, in the diagnostic whose whole job was to
    // detect that class of bug.
    assert.match(jobSrc, /UNPROJECTED_FILING_WHERE/);
    assert.doesNotMatch(
      jobSrc,
      /projectedAt:\s*null/,
      "the drain job must not restate the unprojected filter — import " +
        "UNPROJECTED_FILING_WHERE from the writer",
    );
  });

  it("the job reuses describeNoWriteReason for a zero-write batch", () => {
    assert.match(jobSrc, /describeNoWriteReason\(/);
  });

  it("the job reports its build provenance", () => {
    // Cloud Run JOBS pin their image at provision time and a deploy of the
    // SERVICE does not move them. `job-build-provenance.test.ts` enforces this
    // across every tsup entry; asserted here too so the drain job's own suite
    // fails on the drain job's own omission.
    assert.match(
      jobSrc,
      /reportBuildProvenance\(\s*log\s*,\s*"xbrl-projection-drain"\s*\)/,
    );
  });

  /**
   * The setup script with its `#` comment lines and its trailing heredoc
   * removed.
   *
   * BOTH removals are load-bearing, and each one closed a mutation that went
   * GREEN while the guard was written against the raw source:
   *
   *   - `--max-retries=0` deleted from `deploy_args` still matched, because the
   *     run-book heredoc PRINTS `retry --max-retries=0` in its summary.
   *   - `if [ -z "$IMAGE" ]` inverted to `-n` — i.e. the fail-closed guard made
   *     fail-OPEN — still matched, because the assertion was reading the echoed
   *     error MESSAGE rather than the condition that reaches it.
   *
   * A guard an ops script can satisfy by talking about itself is not a guard.
   * Same lesson `job-build-provenance.test.ts` records for `stripYamlComments`,
   * one layer over: strip the prose, then assert against what actually runs.
   */
  const setupSrc = (() => {
    const raw = readFileSync(
      join(ROOT, "scripts", "ops", "setup-xbrl-projection-drain-job.sh"),
      "utf8",
    );
    const heredoc = raw.indexOf("cat <<EOF");
    const code = heredoc === -1 ? raw : raw.slice(0, heredoc);
    return code
      .split("\n")
      .map((line) => (/^\s*#/.test(line) ? "" : line))
      .join("\n");
  })();

  it("the setup script ships XBRL_PROJECTION_APPLY PRESENT, defaulting to false", () => {
    // Absent and "false" must never be the same state — that is how
    // MF_METADATA_PROVIDER disabled its own job silently for months
    // (MONEY-1214). And the default must be DISARMED: this job opens the
    // one-way door (StockFinancials has no `source` in its unique key).
    assert.match(setupSrc, /^APPLY_ENV_VALUE="false"$/m);
    assert.match(
      setupSrc,
      /--set-env-vars="XBRL_PROJECTION_APPLY=\$\{APPLY_ENV_VALUE\}/,
    );
  });

  it("the job spec refuses retries on an irreversible write path", () => {
    // Anchored to its own line inside deploy_args, not merely present in the
    // file: a retry re-runs the whole drain unattended, straight back into
    // whatever killed the task.
    assert.match(setupSrc, /^\s+--max-retries=0$/m);
  });

  it("the image is resolved from the LIVE service and FAILS CLOSED", () => {
    // Cloud Run JOBS pin their image at provision time and a deploy of the
    // SERVICE does not move them (MONEY-1205: feed-parse-prod ran a 10-day-old
    // image nightly, exited 0, and left bond_master/bond_eod at 0 rows).
    assert.match(setupSrc, /run services describe "\$SERVICE_NAME"/);
    // The CONDITION and the EXIT, matched as one block — not each separately.
    // An empty IMAGE reaching `jobs deploy` is read as "keep whatever is
    // there", which silently preserves the stale pin this script exists to
    // move. Deleting the `exit 1` from THIS block passed a bare
    // `/^\s+exit 1$/m`, because the usage/`*)` branch has an `exit 1` of its
    // own — the same "satisfied by something else in the file" gap as the
    // heredoc one above, and the reason the block is matched whole.
    assert.match(
      setupSrc,
      /if \[ -z "\$IMAGE" \]; then[\s\S]{0,400}?\n\s+exit 1\n\s*fi/,
    );
  });

  it("the drain job never acquires a Cloud Scheduler trigger", () => {
    // It is an irreversible write path, and once drained it would select
    // nothing every night — indistinguishable from a broken selector.
    assert.doesNotMatch(setupSrc, /scheduler jobs (create|update)/);
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1235 — the ROUTES must decode the Pub/Sub envelope                    */
/* -------------------------------------------------------------------------- */

describe("xbrl routes decode the Pub/Sub envelope", () => {
  const ROOT = join(import.meta.dirname, "..", "..", "..");
  const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
  /** LINE comments before BLOCK — MONEY-1143. */
  const strip = (s: string): string =>
    s.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

  for (const route of ["xbrl-projection", "xbrl-ratios"]) {
    it(`${route} calls parsePubSubMessage, not the raw body`, () => {
      // THE DEFECT. Pub/Sub push delivers `{message:{data:"<base64>"}}` — the
      // subscription is created WITHOUT `--push-no-wrapper`, which appears
      // nowhere in this repo. Reading fields off the raw body therefore yields
      // `undefined` for every one of them, silently:
      //
      //   {"periodTypes":["ANNUAL"]}   -> undefined -> BOTH buckets run
      //   {"symbols":[...],"limit":200} -> whole universe at the default 500
      //   {"createMissing":true}        -> false, so no CREATE ever happens
      //
      // 49 of the 60 routes here already did this correctly; these two did not,
      // which made the nightly ANNUAL scoping inert and would have turned the
      // runbook's "scoped pilot" into an unscoped ARMED whole-universe write.
      const src = strip(read(`workers/src/routes/${route}.ts`));
      assert.match(
        src,
        /parsePubSubMessage</,
        `${route} reads the raw body; every message field would be undefined`,
      );
      assert.doesNotMatch(
        src,
        /const raw = \(body \?\? \{\}\)/,
        `${route} still reads the undecoded body`,
      );
    });
  }

  it("REGRESSION: decoding a real envelope recovers the fields", () => {
    // Behavioural, not textual — the one link the wired suite asserted only as
    // source text was the decode itself.
    const payload = {
      periodTypes: ["ANNUAL"],
      symbols: ["TCS", "INFY"],
      limit: 200,
      createMissing: true,
    };
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
        messageId: "12345",
      },
      subscription: "xbrl-projection-prod-push",
    };
    const decoded = parsePubSubMessage<Record<string, unknown>>(envelope);
    assert.deepEqual(decoded.periodTypes, ["ANNUAL"]);
    assert.deepEqual(decoded.symbols, ["TCS", "INFY"]);
    assert.equal(decoded.limit, 200);
    assert.equal(decoded.createMissing, true);
    assert.equal(getMessageId(envelope), "12345");
  });

  it("a direct JSON body (local dev / curl) still works", () => {
    const direct = { periodTypes: ["QUARTERLY"], limit: 10 };
    const decoded = parsePubSubMessage<Record<string, unknown>>(direct);
    assert.deepEqual(decoded.periodTypes, ["QUARTERLY"]);
    assert.equal(decoded.limit, 10);
  });
});
