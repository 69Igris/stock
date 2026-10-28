/**
 * MONEY-1263: the deactivation sweep must be OBSERVABLE on the job result.
 *
 * Two defects, one visible symptom (`deactivated: 0`, always):
 *
 *   (a) `InstrumentSyncResult.deactivated` was assigned the literal `0` in
 *       `syncFromProvider` and never reassigned. Grep found no `deactivated =`
 *       and no `deactivated +=` in the file. The real count reached a
 *       `console.log` and `marketDataSyncLog.metadata` and went no further —
 *       while `us-instrument-master-sync.ts` was ALREADY forwarding this field
 *       into `reportJobOutcome`, so the nightly job outcome reported a hard 0
 *       whatever the sweep did.
 *
 *   (b) A breaker REFUSAL was indistinguishable from a quiet night. Both are
 *       `deactivated: 0`. `judgeDeactivationSweep` genuinely refuses an
 *       oversized sweep — the ~20,804-row wrong-exchange-scope catastrophe —
 *       but its refusal reached an operator only as console prose, which no
 *       monitor can key on.
 *
 * The cases below drive the REAL `attributeSweepToResults` and the REAL
 * `judgeDeactivationSweep`. Both are pure (no Prisma, no clock, no env), which
 * is why this file needs no database seam.
 *
 * MUTATION-VERIFIED. Against the pre-fix source (`target.deactivated` never
 * assigned) the "(a)" block goes red; against a build where the refusal fields
 * are dropped the "(b)" block goes red. A test that passes on broken source is
 * worthless, and this repo has a documented history of exactly that.
 *
 * Source: packages/core/src/market-data/instruments/instrument-sync.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  attributeSweepToResults,
  judgeDeactivationSweep,
  MAX_DEACTIVATION_RATIO,
  DEACTIVATION_FLOOR,
} from "../../src/market-data/instruments/instrument-sync";
import type { InstrumentSyncResult } from "../../src/market-data/instruments/types";

function providerResult(name: string): InstrumentSyncResult {
  return {
    provider: name,
    totalFetched: 100,
    upserted: 100,
    failed: 0,
    deactivated: 0,
    errors: [],
  };
}

describe("MONEY-1263 (a) - the real sweep count reaches the result", () => {
  it("a sweep of 12 is reported as 12, not 0", () => {
    // The headline. This is the assertion the pre-fix source cannot satisfy:
    // `deactivated` was a literal 0 with no assignment anywhere.
    const results = [providerResult("zerodha")];
    attributeSweepToResults(results, {
      deactivated: 12,
      refusedCandidates: 0,
    });
    assert.equal(results[0]!.deactivated, 12);
  });

  it("the SUM across providers is the run total, counted ONCE", () => {
    // The sweep is run-level: it happens after the provider loop, over the
    // UNION of every provider's symbols. Stamping the total onto every element
    // would make an aggregator report N x the real number — a worse lie than 0,
    // because it scales with provider count and looks measured.
    const results = [providerResult("zerodha"), providerResult("nse-master")];
    attributeSweepToResults(results, {
      deactivated: 40,
      refusedCandidates: 0,
    });
    const total = results.reduce((s, r) => s + r.deactivated, 0);
    assert.equal(
      total,
      40,
      "the run total was double-counted across providers",
    );
    assert.equal(
      results[1]!.deactivated,
      0,
      "the second provider was credited too",
    );
  });

  it("results[0] is right for the single-provider callers", () => {
    // `us-instrument-master-sync` does `const [providerResult] = await
    // syncInstruments(...)`, so first-element attribution has to be the whole
    // run for that caller.
    const results = [providerResult("tiingo")];
    attributeSweepToResults(results, { deactivated: 7, refusedCandidates: 0 });
    const [first] = results;
    assert.equal(first!.deactivated, 7);
  });

  it("a genuinely quiet sweep still reports 0", () => {
    // The fix must not manufacture a number where there is none.
    const results = [providerResult("zerodha")];
    attributeSweepToResults(results, { deactivated: 0, refusedCandidates: 0 });
    assert.equal(results[0]!.deactivated, 0);
    assert.equal(results[0]!.deactivationRefused, undefined);
    assert.deepEqual(results[0]!.errors, []);
  });
});

describe("MONEY-1263 (b) - a REFUSAL is a distinct observable state", () => {
  const reason =
    "refusing to deactivate 4000 of 20804 active row(s) (19.2%, ceiling 10%).";

  it("a QUIET NIGHT and a REFUSAL are distinguishable — the both-zero case", () => {
    // The whole point of the ticket, and deliberately the HARDEST pairing:
    // both runs deactivated ZERO rows. Comparing a refusal against a run that
    // swept 12 would pass on `deactivated` alone and prove nothing — the defect
    // was never that 0 and 12 look alike, it was that the routine zero and the
    // catastrophic zero look alike.
    const quiet = [providerResult("zerodha")];
    attributeSweepToResults(quiet, { deactivated: 0, refusedCandidates: 0 });

    const refused = [providerResult("zerodha")];
    attributeSweepToResults(refused, {
      deactivated: 0,
      refusedReason: reason,
      refusedCandidates: 4000,
    });

    // Same headline number on both — that is the premise, not the bug.
    assert.equal(quiet[0]!.deactivated, 0);
    assert.equal(refused[0]!.deactivated, 0);

    const observable = (r: InstrumentSyncResult) => ({
      deactivated: r.deactivated,
      refused: r.deactivationRefused ?? false,
      refusedCount: r.deactivationRefusedCount ?? 0,
      errorCount: r.errors.length,
    });

    assert.notDeepEqual(
      observable(quiet[0]!),
      observable(refused[0]!),
      "a quiet night and a refused 4,000-row sweep are the SAME observable state",
    );
  });

  it("a refusal is machine-readable, not only prose", () => {
    // A monitor cannot key on a console line. These two fields are what makes
    // the refusal alertable.
    const results = [providerResult("zerodha")];
    attributeSweepToResults(results, {
      deactivated: 0,
      refusedReason: reason,
      refusedCandidates: 4000,
    });
    assert.equal(results[0]!.deactivationRefused, true);
    assert.equal(results[0]!.deactivationRefusedCount, 4000);
  });

  it("the reason SENTENCE rides errors[], which is already surfaced", () => {
    // `us-instrument-master-sync` pushes `providerResult.errors` into the
    // outcome, where it reaches the operator as `skippedReason`. Reusing that
    // channel beats inventing a new one nothing reads.
    const results = [providerResult("zerodha")];
    attributeSweepToResults(results, {
      deactivated: 0,
      refusedReason: reason,
      refusedCandidates: 4000,
    });
    assert.equal(results[0]!.errors.length, 1);
    assert.equal(results[0]!.errors[0], reason);
  });

  it("a refusal on an EMPTY provider list is not dropped on the floor", () => {
    // The most dangerous run of all: no providers means no symbols, so EVERY
    // active row is a deactivation candidate. With no result element to stamp,
    // a naive implementation silently discards the refusal.
    const results: InstrumentSyncResult[] = [];
    attributeSweepToResults(results, {
      deactivated: 0,
      refusedReason: reason,
      refusedCandidates: 20804,
    });
    assert.equal(results.length, 1, "the refusal had nowhere to land");
    assert.equal(results[0]!.deactivationRefused, true);
    assert.equal(results[0]!.deactivationRefusedCount, 20804);
    assert.match(results[0]!.provider, /no providers/i);
  });

  it("does not mark a refusal when there was none", () => {
    // Guards the inverse mutation: hard-coding `deactivationRefused = true`
    // would pass every case above and make the field meaningless.
    const results = [providerResult("zerodha")];
    attributeSweepToResults(results, { deactivated: 3, refusedCandidates: 0 });
    assert.notEqual(results[0]!.deactivationRefused, true);
  });
});

describe("MONEY-1263 - the breaker verdict the reporting is built on", () => {
  // These pin that the refusal path is REACHABLE with realistic numbers — a
  // reporting test for a branch nothing can enter would be vacuous.
  it("refuses the wrong-exchange-scope catastrophe", () => {
    const v = judgeDeactivationSweep({
      candidates: 20804,
      activePopulation: 20804,
    });
    assert.equal(v.proceed, false);
    assert.ok(
      v.reason && v.reason.length > 0,
      "a refusal must carry a sentence",
    );
  });

  it("allows a routine handful of delistings", () => {
    const v = judgeDeactivationSweep({
      candidates: 12,
      activePopulation: 20804,
    });
    assert.equal(v.proceed, true);
    assert.equal(v.reason, undefined);
  });

  it("the constants the ratio is judged against are the real ones", () => {
    // Pins that this file is testing the shipped thresholds, not its own.
    assert.equal(MAX_DEACTIVATION_RATIO, 0.1);
    assert.equal(DEACTIVATION_FLOOR, 50);
  });

  it("end to end: a refused verdict becomes a refused RESULT", () => {
    // The seam. Verdict in, observable job result out — the hop that did not
    // exist before this ticket.
    const candidates = 4000;
    const verdict = judgeDeactivationSweep({
      candidates,
      activePopulation: 20804,
    });
    assert.equal(verdict.proceed, false);

    const results = [providerResult("zerodha")];
    attributeSweepToResults(results, {
      // A refused sweep deactivates nothing — that is the point of refusing.
      deactivated: 0,
      refusedReason: verdict.reason,
      refusedCandidates: candidates,
    });

    assert.equal(results[0]!.deactivated, 0);
    assert.equal(results[0]!.deactivationRefused, true);
    assert.equal(results[0]!.deactivationRefusedCount, candidates);
    assert.equal(results[0]!.errors[0], verdict.reason);
  });
});
