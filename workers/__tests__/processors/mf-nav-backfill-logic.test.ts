/**
 * MF NAV backfill — params, wall-clock budget, run health — REAL exports
 * (MONEY-1205).
 *
 * Source: workers/src/processors/mf-nav-backfill-logic.ts (imported and CALLED
 * by workers/src/processors/mf-nav-backfill.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  resolveMfNavBackfillParams,
  shouldSleepAfterIndex,
  shouldLogProgress,
  isBudgetExhausted,
  judgeMfNavBackfillHealth,
  reconcileSchemeNav,
  rotatingSlice,
  dayIndex,
  MF_NAV_DISAGREEMENT_TOLERANCE,
  DEFAULT_BATCH_SIZE,
  DEFAULT_DELAY_MS,
  DEFAULT_BUDGET_MS,
  PROGRESS_LOG_EVERY,
  type MfNavBackfillTally,
} from "../../src/processors/mf-nav-backfill-logic";

// ══════════════════════════════════════════════════════════════════════
// Params
// ══════════════════════════════════════════════════════════════════════

describe("resolveMfNavBackfillParams (real export)", () => {
  it("a bare {} is a UNIVERSE sweep — what the nightly scheduler means", () => {
    const p = resolveMfNavBackfillParams({});
    assert.equal(p.universe, true);
    assert.deepEqual(p.schemeCodes, []);
    assert.equal(p.batchSize, DEFAULT_BATCH_SIZE);
    assert.equal(p.batchSize, 200);
    assert.equal(p.delayMs, DEFAULT_DELAY_MS);
    assert.equal(p.budgetMs, DEFAULT_BUDGET_MS);
  });

  it("explicit schemeCodes turn universe mode OFF (a cold read runs one fund)", () => {
    const p = resolveMfNavBackfillParams({
      schemeCodes: ["152387"],
      universe: true,
    });
    assert.equal(
      p.universe,
      false,
      "explicit codes must not trigger a whole-universe sweep",
    );
    assert.deepEqual(p.schemeCodes, ["152387"]);
  });

  it("trims and drops blank scheme codes", () => {
    const p = resolveMfNavBackfillParams({
      schemeCodes: [" 152387 ", "", "   ", "120503"],
    });
    assert.deepEqual(p.schemeCodes, ["152387", "120503"]);
  });

  it("an all-blank schemeCodes list falls back to universe mode", () => {
    const p = resolveMfNavBackfillParams({ schemeCodes: ["", "  "] });
    assert.equal(p.universe, true);
  });

  it("rejects non-positive / non-finite batch sizes rather than running 0 schemes", () => {
    assert.equal(
      resolveMfNavBackfillParams({ batchSize: 0 }).batchSize,
      DEFAULT_BATCH_SIZE,
    );
    assert.equal(
      resolveMfNavBackfillParams({ batchSize: -5 }).batchSize,
      DEFAULT_BATCH_SIZE,
    );
    assert.equal(
      resolveMfNavBackfillParams({ batchSize: Number.NaN }).batchSize,
      DEFAULT_BATCH_SIZE,
    );
    assert.equal(resolveMfNavBackfillParams({ batchSize: 50 }).batchSize, 50);
  });

  it("allows delayMs = 0 (a real choice) but rejects a negative", () => {
    assert.equal(resolveMfNavBackfillParams({ delayMs: 0 }).delayMs, 0);
    assert.equal(
      resolveMfNavBackfillParams({ delayMs: -1 }).delayMs,
      DEFAULT_DELAY_MS,
    );
  });

  it("carries a provenance reason for the logs", () => {
    assert.equal(resolveMfNavBackfillParams({}).reason, "scheduler");
    assert.equal(
      resolveMfNavBackfillParams({ reason: "cold-read" }).reason,
      "cold-read",
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// Budget — the xbrl-sync failure mode, pre-empted
// ══════════════════════════════════════════════════════════════════════

describe("isBudgetExhausted (real export)", () => {
  it("is false before the budget and true at/after it", () => {
    assert.equal(isBudgetExhausted(1_000, 1_000 + 419_999, 420_000), false);
    assert.equal(isBudgetExhausted(1_000, 1_000 + 420_000, 420_000), true);
    assert.equal(isBudgetExhausted(1_000, 1_000 + 999_999, 420_000), true);
  });

  it("the default budget fits inside Pub/Sub's 600s maximum ack deadline", () => {
    // xbrl-sync's STILL-OPEN problem is 900s of work against a 600s deadline.
    // This job stops on the clock instead of trusting a per-item estimate.
    assert.ok(
      DEFAULT_BUDGET_MS < 600_000,
      `budget ${DEFAULT_BUDGET_MS}ms must be under the 600000ms ack deadline`,
    );
    assert.ok(
      DEFAULT_BUDGET_MS >= 300_000,
      "but large enough to make real progress",
    );
  });
});

describe("loop gates (real exports)", () => {
  it("sleeps after every scheme except the last", () => {
    assert.equal(shouldSleepAfterIndex(0, 2), true);
    assert.equal(shouldSleepAfterIndex(1, 2), false);
  });

  it("logs progress every PROGRESS_LOG_EVERY schemes, 1-based", () => {
    assert.equal(PROGRESS_LOG_EVERY, 25);
    assert.equal(shouldLogProgress(24), true);
    assert.equal(shouldLogProgress(0), false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Run health
// ══════════════════════════════════════════════════════════════════════

function tally(over: Partial<MfNavBackfillTally> = {}): MfNavBackfillTally {
  return {
    selected: 0,
    succeeded: 0,
    empty: 0,
    failed: 0,
    alreadyComplete: 0,
    inserted: 0,
    budgetExhausted: false,
    // MONEY-1404 C2 — counted by the run, deliberately NOT read by
    // `judgeMfNavBackfillHealth`: a NAV disagreement between AMFI and MFAPI is
    // a finding for a human, not a reason to fail a run that wrote its rows.
    navCompared: 0,
    navDisagreements: 0,
    ...over,
  };
}

describe("judgeMfNavBackfillHealth (real export)", () => {
  it("selecting nothing is healthy (the seeded steady state)", () => {
    const h = judgeMfNavBackfillHealth(tally({ selected: 0 }));
    assert.equal(h.ok, true);
    assert.equal(h.reason, "nothing-to-do");
  });

  it("EVERY scheme failing => NOT ok (MFAPI unreachable / shape changed)", () => {
    const h = judgeMfNavBackfillHealth(tally({ selected: 200, failed: 200 }));
    assert.equal(h.ok, false);
    assert.equal(h.level, "error");
    assert.equal(h.reason, "all-failed");
  });

  it("wrote rows => ok", () => {
    const h = judgeMfNavBackfillHealth(
      tally({ selected: 200, succeeded: 198, failed: 2, inserted: 120_000 }),
    );
    assert.equal(h.ok, true);
    assert.equal(h.reason, "ok");
  });

  it("everything already complete is healthy, NOT a zero-write failure", () => {
    // The distinction that matters: an upstream that ANSWERED and had nothing
    // new is the goal state, and must never be manufactured into an error.
    const h = judgeMfNavBackfillHealth(
      tally({ selected: 200, alreadyComplete: 200 }),
    );
    assert.equal(h.ok, true);
    assert.equal(h.reason, "nothing-to-do");
  });

  it("schemes with genuinely no upstream history are healthy too", () => {
    const h = judgeMfNavBackfillHealth(tally({ selected: 10, empty: 10 }));
    assert.equal(h.ok, true);
    assert.equal(h.reason, "nothing-to-do");
  });

  it("a mixed batch that somehow wrote ZERO rows is NOT ok", () => {
    const h = judgeMfNavBackfillHealth(
      tally({ selected: 10, succeeded: 4, failed: 1, inserted: 0 }),
    );
    assert.equal(h.ok, false);
    assert.equal(h.reason, "no-rows-written");
  });
});

describe("MONEY-1238 — the wall-clock budget is part of the verdict", () => {
  it("a budget that expires before ANY scheme is an error, not an empty universe", () => {
    // The processor sets `tally.selected = i` when the budget cuts the loop, so
    // a run truncated before the first scheme reports selected: 0 — which used
    // to fall into the "nothing-to-do" rung and announce "No schemes were
    // missing NAV history." Schemes WERE selected and DO need backfill.
    //
    // It is self-perpetuating: if the selection query alone exhausts the
    // budget, every later run repeats it exactly, the backfill never advances,
    // and every run reports success.
    const h = judgeMfNavBackfillHealth({
      selected: 0,
      succeeded: 0,
      empty: 0,
      failed: 0,
      alreadyComplete: 0,
      inserted: 0,
      budgetExhausted: true,
      navCompared: 0,
      navDisagreements: 0,
    });
    assert.equal(h.ok, false);
    assert.equal(h.reason, "budget-starved");
  });

  it("a genuinely empty universe is still healthy", () => {
    // The control. Without it, the rung above could be satisfied by failing
    // every empty run — and "nothing is stale" is the real steady state here.
    const h = judgeMfNavBackfillHealth({
      selected: 0,
      succeeded: 0,
      empty: 0,
      failed: 0,
      alreadyComplete: 0,
      inserted: 0,
      budgetExhausted: false,
      navCompared: 0,
      navDisagreements: 0,
    });
    assert.equal(h.ok, true);
    assert.equal(h.reason, "nothing-to-do");
  });

  it("truncation WITH progress stays healthy but says work remains", () => {
    // Being bounded by Pub/Sub's 600s ack deadline is the DESIGN, not a fault:
    // the next run resumes. What must not happen is silence about it.
    const h = judgeMfNavBackfillHealth({
      selected: 40,
      succeeded: 40,
      empty: 0,
      failed: 0,
      alreadyComplete: 0,
      inserted: 900,
      budgetExhausted: true,
      navCompared: 0,
      navDisagreements: 0,
    });
    assert.equal(h.ok, true);
    assert.match(h.message, /TRUNCATED by the wall-clock budget/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// AMFI vs MFAPI reconcile — MONEY-1404 C2
// ══════════════════════════════════════════════════════════════════════
//
// `MutualFundMaster.nav` is AMFI's (via `mf-sync`); `MfNavHistory.nav` is
// MFAPI.in's (via this job). One quantity, two vendors, and nothing had ever
// compared them — so either could stop, or drift, and the only symptom would be
// a chart that disagreed with the number printed above it.
//
// The dates are the interesting part. AMFI's `navDate` is `new Date(y, m-1, d)`
// (LOCAL midnight) and MFAPI's is `new Date("...T00:00:00.000Z")` (UTC
// midnight). Those are the same instant on Cloud Run (UTC) and 5.5 hours apart
// on a laptop in IST — so an instant-equality match would compare NOTHING in
// development and report a permanently agreeing reconcile.

/** MFAPI's parse: UTC midnight. */
const utcDay = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
/** AMFI's parse: LOCAL midnight, whatever the runner's zone is. */
const localDay = (y: number, m: number, d: number): Date =>
  new Date(y, m - 1, d);

describe("reconcileSchemeNav (real export)", () => {
  it("agreeing vendors on the same day produce a COMPARISON, not silence", () => {
    // The denominator. Without this the disagreement case could pass with a
    // function that returns "no-history-row" for everything.
    //
    // MUTATION: `points.find(...)` -> `undefined` -> RED.
    const r = reconcileSchemeNav(
      { nav: 125.5, navDate: localDay(2026, 9, 12) },
      [
        { date: utcDay("2026-09-11"), nav: 125.0 },
        { date: utcDay("2026-09-12"), nav: 125.5 },
      ],
    );
    assert.equal(r.verdict, "agree");
    assert.equal(r.drift, 0);
  });

  it("matches on the DAY, not the instant — IST-local vs UTC midnight", () => {
    // The whole reason `navDayKey` exists. `localDay` in IST is
    // 2026-09-11T18:30Z, which is not equal to any point's timestamp.
    //
    // MUTATION: compared `date.getTime()` instead of the day key -> RED under
    // TZ=Asia/Kolkata (and green under TZ=UTC, which is exactly the trap: the
    // bug would be invisible in the environment that runs the job).
    const r = reconcileSchemeNav({ nav: 100, navDate: localDay(2026, 9, 12) }, [
      { date: utcDay("2026-09-12"), nav: 100 },
    ]);
    assert.notEqual(
      r.verdict,
      "no-history-row",
      "the day matched but the instants did not — this is the TZ trap",
    );
    assert.equal(r.verdict, "agree");
  });

  it("a gap wider than the tolerance DISAGREES, and reports how wide", () => {
    // MUTATION: `drift > TOLERANCE` -> `drift > 1` -> RED.
    const r = reconcileSchemeNav({ nav: 100, navDate: localDay(2026, 9, 12) }, [
      { date: utcDay("2026-09-12"), nav: 98 },
    ]);
    assert.equal(r.verdict, "disagree");
    assert.equal(r.drift, 0.02);
  });

  it("the tolerance is a CEILING — exactly 0.5% still agrees", () => {
    // Pins the comparison direction, and pins the constant itself: a tolerance
    // silently widened to 5% would make this pass while the one below fails.
    //
    // MUTATION: `>` -> `>=` -> RED.
    assert.equal(MF_NAV_DISAGREEMENT_TOLERANCE, 0.005);
    const at = reconcileSchemeNav(
      { nav: 100, navDate: localDay(2026, 9, 12) },
      [{ date: utcDay("2026-09-12"), nav: 99.5 }],
    );
    assert.equal(at.verdict, "agree");

    const over = reconcileSchemeNav(
      { nav: 100, navDate: localDay(2026, 9, 12) },
      [{ date: utcDay("2026-09-12"), nav: 99.4 }],
    );
    assert.equal(over.verdict, "disagree");
  });

  it("a direction is not a magnitude — MFAPI HIGHER disagrees too", () => {
    // `master - history` without the abs() is negative here, and every
    // `> tolerance` test on a negative number passes. Silent in one direction
    // only, which is the hardest kind to notice.
    //
    // MUTATION: dropped `Math.abs` -> RED.
    const r = reconcileSchemeNav({ nav: 100, navDate: localDay(2026, 9, 12) }, [
      { date: utcDay("2026-09-12"), nav: 104 },
    ]);
    assert.equal(r.verdict, "disagree");
  });

  it("no row on the master's date is NOT a disagreement", () => {
    // Universe mode selects schemes with NO stored history, so a fresh scheme
    // whose upstream history stops short is ordinary. Counting it as a
    // disagreement would make the alarm fire on the job's own steady state.
    const r = reconcileSchemeNav({ nav: 100, navDate: localDay(2026, 9, 12) }, [
      { date: utcDay("2026-09-10"), nav: 100 },
    ]);
    assert.equal(r.verdict, "no-history-row");
    assert.equal(r.drift, null, "an un-compared scheme has no drift to report");
  });

  it("an absent, null or non-positive master NAV is a REASON, never a drift", () => {
    // Every one of these would divide by zero, by null, or by undefined. The
    // named verdict keeps them out of `navCompared`, so the denominator stays
    // honest instead of quietly inflating with schemes nothing was compared for.
    //
    // MUTATION: dropped the `master.nav <= 0` arm -> RED (drift becomes
    // Infinity and the verdict becomes "disagree").
    const points = [{ date: utcDay("2026-09-12"), nav: 100 }];
    for (const master of [
      undefined,
      { nav: null, navDate: localDay(2026, 9, 12) },
      { nav: 100, navDate: null },
      { nav: 0, navDate: localDay(2026, 9, 12) },
      { nav: -5, navDate: localDay(2026, 9, 12) },
      { nav: Number.NaN, navDate: localDay(2026, 9, 12) },
    ]) {
      const r = reconcileSchemeNav(master, points);
      assert.equal(
        r.verdict,
        "no-master-nav",
        `${JSON.stringify(master)} should be un-comparable, got ${r.verdict}`,
      );
      assert.equal(r.drift, null);
    }
  });

  it("an empty history compares nothing", () => {
    const r = reconcileSchemeNav(
      { nav: 100, navDate: localDay(2026, 9, 12) },
      [],
    );
    assert.equal(r.verdict, "no-history-row");
  });
});

describe("mf-nav-backfill wires the reconcile (MONEY-1404 C2)", () => {
  // Same reasoning as the mf-sync wiring scan: a verdict computed and read by
  // nothing is this file's own `budgetExhausted` bug (MONEY-1238).
  const SRC = new URL(
    "../../src/processors/mf-nav-backfill.ts",
    import.meta.url,
  ).pathname;

  it("counts only COMPARED schemes, and emits both counts", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(SRC, "utf8");

    assert.match(src, /reconcileSchemeNav\(/);
    // `drift !== null` is what keeps `navCompared` an honest denominator: the
    // un-comparable verdicts must not inflate it.
    //
    // MUTATION: `result.navCheck.drift !== null` -> `result.navCheck` -> RED.
    assert.match(src, /result\.navCheck\.drift !== null/);
    assert.match(src, /navCompared=\$\{tally\.navCompared\}/);
    assert.match(src, /navDisagreements=\$\{tally\.navDisagreements\}/);
    // And the counts must reach reportJobOutcome, which has no field of its own
    // for them — `skippedReason` is the only channel into the structured line.
    assert.match(src, /nav-disagreements: \$\{tally\.navDisagreements\}/);
    assert.match(src, /skippedReason \? \{ skippedReason \} : \{\}/);
  });

  it("a reconcile that THREW is a counted state, not just a warn", async () => {
    // MONEY-1401 review finding 5(c). The standing pass is best-effort and its
    // catch only warned — so a reconcile that blew up left `navCompared` at the
    // IN-LOOP count, which on a fully-backfilled universe is ZERO. Identical,
    // in `stockbook.mf.nav_compared`, to a pass that ran and honestly found
    // nothing to compare. `job.unhealthy` is the only number that separates
    // them.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(SRC, "utf8");

    // The catch must CAPTURE, not merely log.
    // MUTATION: drop the assignment and keep the console.warn -> RED.
    assert.match(src, /reconcileFailed = error instanceof Error/);

    // …and it must reach the outcome, WITHOUT failing the run: the sync half
    // succeeded, and a throw here redelivers a good backfill.
    // MUTATION: `unhealthy: !health.ok` -> RED (a broken check reads healthy).
    // MUTATION: `unhealthy: true` -> RED (every clean night marked unhealthy).
    assert.match(src, /unhealthy: !health\.ok \|\| reconcileFailed !== null,/);

    const catchAt = src.indexOf("reconcileFailed = error instanceof Error");
    const catchBody = src.slice(catchAt, src.indexOf("\n  }", catchAt));
    assert.doesNotMatch(
      catchBody,
      /\bthrow\b/,
      "a check that fails must not fail the run it was only checking",
    );
  });

  it("the master NAVs are fetched in ONE query for the batch", async () => {
    // A per-scheme `findUnique` inside a loop bounded by a 420s wall clock
    // spends the budget on round trips instead of on backfill.
    //
    // MUTATION: moved the findMany inside the loop -> RED (the `in: schemes`
    // batch form disappears).
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(SRC, "utf8");
    assert.match(src, /where: \{ schemeCode: \{ in: schemes \} \}/);
  });
});

describe("MONEY-1405 — the reconcile population must not drain", () => {
  it("rotatingSlice walks the population instead of re-checking one head", () => {
    // A reconcile with no rotation re-checks the same head for ever — the
    // MONEY-1211 shape. The rotation is derived from the DAY because there is
    // no marker column to stamp: the population is a query result, not a table
    // this job owns.
    // MUTATION: `sorted.slice(0, size)` -> every day returns the same page, RED.
    const pop = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const d0 = rotatingSlice(pop, 3, 0);
    const d1 = rotatingSlice(pop, 3, 1);
    const d2 = rotatingSlice(pop, 3, 2);
    assert.deepEqual(d0, ["s0", "s1", "s2"]);
    assert.deepEqual(d1, ["s3", "s4", "s5"]);
    assert.deepEqual(d2, ["s6", "s7", "s8"]);
    assert.notDeepEqual(d0, d1);
  });

  it("it WRAPS, so a short tail never shrinks the sample", () => {
    // Day 3 of a 10-long population at size 3 starts at index 9 and must wrap,
    // or the last page of every cycle checks one scheme instead of three.
    // MUTATION: drop the wrap concat -> length 1, RED.
    const pop = Array.from({ length: 10 }, (_, i) => `s${i}`);
    assert.deepEqual(rotatingSlice(pop, 3, 3), ["s9", "s0", "s1"]);
  });

  it("a population smaller than the sample is returned whole, not padded", () => {
    assert.deepEqual(rotatingSlice(["a", "b"], 5, 7), ["a", "b"]);
    assert.deepEqual(rotatingSlice([], 5, 7), []);
    assert.deepEqual(rotatingSlice(["a", "b"], 0, 1), []);
  });

  it("a NEGATIVE day index still lands inside the population", () => {
    // Kept as a PROPERTY, not as a guard test. `x % n` is always in (-n, n) and
    // `Array.slice` reads a negative start as an offset from the end, so the
    // rotation is already correct without arithmetic — which is why the
    // `((x % n) + n) % n` guard that used to sit here was removed: no input
    // could distinguish it.
    const pop = Array.from({ length: 10 }, (_, i) => `s${i}`);
    for (const day of [-1, -4, -17, -100]) {
      const got = rotatingSlice(pop, 3, day);
      assert.equal(got.length, 3, `day ${day}`);
      assert.ok(
        got.every((x) => pop.includes(x)),
        `day ${day} produced something outside the population`,
      );
      assert.equal(new Set(got).size, 3, `day ${day} repeated an element`);
    }
  });

  it("dayIndex advances once per day and not within one", () => {
    const a = dayIndex(new Date("2026-09-13T00:30:00Z"));
    const b = dayIndex(new Date("2026-09-13T23:30:00Z"));
    const c = dayIndex(new Date("2026-09-14T00:30:00Z"));
    assert.equal(a, b, "one day is one index");
    assert.equal(c, a + 1, "the next day is the next index");
  });
});

// ══════════════════════════════════════════════════════════════════════
// MONEY-1408 — the series
// ══════════════════════════════════════════════════════════════════════

describe("MONEY-1408 — the reconcile emits a metric series", () => {
  const SRC = new URL(
    "../../src/processors/mf-nav-backfill.ts",
    import.meta.url,
  ).pathname;

  const read = async () => {
    const { readFileSync } = await import("node:fs");
    return readFileSync(SRC, "utf8");
  };

  it("emits BOTH counters, AFTER the standing pass has added to the tally", async () => {
    // The standing pass is where `navCompared` actually comes from on a
    // backfilled universe (400 a night); the in-loop count drains to 0. An
    // emit placed above it would report 0 compared for ever — the exact
    // "compared nothing" reading this series exists to make visible.
    //
    // MUTATION: move the two `incrementCounter` calls above the standing
    // try/catch -> RED (both indices fall below the standing pass).
    // MUTATION: delete either call -> RED (indexOf returns -1).
    const src = await read();
    const standing = src.indexOf("tally.navCompared += standing.compared");
    const compared = src.indexOf('incrementCounter("mf.nav_compared"');
    const disagreements = src.indexOf(
      'incrementCounter("mf.nav_disagreements"',
    );

    assert.ok(standing > 0, "the standing pass no longer adds to the tally");
    assert.ok(
      compared > standing,
      "mf.nav_compared must be emitted after the standing pass, not before",
    );
    assert.ok(
      disagreements > standing,
      "mf.nav_disagreements must be emitted after the standing pass",
    );
  });

  it("emits nav_compared UNCONDITIONALLY — a zero is a real reading", async () => {
    // `workers/src/realtime/main.ts:442` is the shape to avoid:
    // `if (value > 0) incrementCounter(...)`. Applied here it would delete the
    // liveness half — a disagreement series alone cannot separate "0
    // disagreements" from "compared nothing".
    //
    // MUTATION: wrap the emit in `if (tally.navCompared > 0)` -> RED.
    // MUTATION: drop the try/catch -> RED (and a metrics backend that is down
    // would then fail the run it was reporting on).
    const src = await read();
    assert.match(
      src,
      /try \{\s*incrementCounter\("mf\.nav_compared", tally\.navCompared,/,
    );
  });

  it("the summary line reports the same total the metric does", async () => {
    // A template literal is evaluated where it is written. Built beside
    // `health` — above the standing pass — `navCompared=` printed the in-loop
    // count while Datadog received the total, so the operator watching for the
    // series to arrive would be reading 0 in the log beside 400 in the graph.
    //
    // MUTATION: move `const summary =` back above the standing try/catch -> RED.
    const src = await read();
    assert.ok(
      src.indexOf("const summary =") >
        src.indexOf("tally.navCompared += standing.compared"),
      "the summary must be built after the standing pass adds to the tally",
    );
  });

  it("incrementCounter cannot fail the run it is reporting on", async () => {
    // The property the emit depends on, asserted against the REAL package
    // rather than assumed: with no DD_API_KEY, `ensureInit` returns without
    // setting `initialized` and the emit short-circuits.
    //
    // The env is deleted rather than trusted: an initialised `datadog-metrics`
    // installs a 15 s flush `setInterval`, which would orphan this process.
    //
    // MUTATION (proved out-of-tree, against a copy — the package is shared):
    // drop `if (!initialized) return;` -> `datadogMetrics.increment` throws
    // "Datadog API key not found" (datadog-metrics 0.12.1
    // lib/reporters.js:151) -> RED.
    const saved = process.env.DD_API_KEY;
    delete process.env.DD_API_KEY;
    try {
      const { incrementCounter } = await import("@usemoney/datadog/metrics");
      assert.doesNotThrow(() =>
        incrementCounter("mf.nav_compared", 0, { job: "mf-nav-backfill" }),
      );
      assert.doesNotThrow(() =>
        incrementCounter("mf.nav_disagreements", 3, { job: "mf-nav-backfill" }),
      );
    } finally {
      if (saved === undefined) delete process.env.DD_API_KEY;
      else process.env.DD_API_KEY = saved;
    }
  });
});
