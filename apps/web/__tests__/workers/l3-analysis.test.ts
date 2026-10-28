/**
 * L3 Analysis Worker Tests (workers/src/processors/l3-analysis.ts) — DE-SHADOWED.
 *
 * Previously this file declared inline copies of `COMPREHENSIVE_STOCK_SEGMENTS`,
 * `calculateProgress`, `calculateRefund` and `isSegmentCompleted` and asserted
 * the copies — none imported real source. Two problems:
 *   1. The segment template it pinned is a COPY of the one in
 *      `apps/web/lib/actions/analysis.ts` (the web action that creates the
 *      session), not a worker symbol; asserting a hand-copied constant proves
 *      nothing about shipped code.
 *   2. `calculateRefund` was an INVENTED weaker re-implementation. The real,
 *      finite-guarded refund formula is `computeReservationRefund` in
 *      @usemoney/services (`credit-logic.ts`), which the L3 processor reaches
 *      via `refundReservationCredits`. We assert THAT real export here.
 *
 * The genuinely worker-owned pure logic — the per-segment progress percentage
 * computed inside `processL3Segment` — now lives in
 * `workers/src/processors/l3-analysis-logic.ts` and is exercised below.
 *
 * BUG REGRESSION (MONEY-620): `computeSegmentProgress` collapses a 0 /
 * non-finite `totalSegments` to 0 instead of writing "NaN%" to
 * AnalysisSession.progress.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker progress/idempotency logic. l3-analysis.ts CALLS computeSegmentProgress.
import {
  computeSegmentProgress,
  isSegmentCompleted,
} from "../../../../workers/src/processors/l3-analysis-logic";
// REAL finite-guarded refund formula reached via refundReservationCredits.
import { computeReservationRefund } from "../../../../packages/services/src/credit-logic";

// ── Progress calculation (real export) ──────────────────────────────

describe("l3-analysis-logic.computeSegmentProgress (real export)", () => {
  it("is 0% at segment 0", () => {
    assert.strictEqual(computeSegmentProgress(0, 6), 0);
  });

  it("is 17% at segment 1 of 6", () => {
    assert.strictEqual(computeSegmentProgress(1, 6), 17);
  });

  it("is 50% at segment 3 of 6", () => {
    assert.strictEqual(computeSegmentProgress(3, 6), 50);
  });

  it("is 83% at segment 5 of 6", () => {
    assert.strictEqual(computeSegmentProgress(5, 6), 83);
  });

  // ── BUG REGRESSION: div-by-zero / non-finite must not write NaN% ──

  it("returns 0 (not NaN) when totalSegments is 0", () => {
    const pct = computeSegmentProgress(0, 0);
    assert.strictEqual(Number.isNaN(pct), false);
    assert.strictEqual(pct, 0);
  });

  it("returns 0 (not NaN) for a non-finite totalSegments", () => {
    assert.strictEqual(computeSegmentProgress(2, Number.NaN), 0);
    assert.strictEqual(computeSegmentProgress(2, Number.POSITIVE_INFINITY), 0);
  });

  it("returns 0 for a non-finite segmentIndex", () => {
    assert.strictEqual(computeSegmentProgress(Number.NaN, 6), 0);
  });

  it("clamps the result into [0, 100]", () => {
    assert.strictEqual(computeSegmentProgress(12, 6), 100); // would be 200%
    assert.strictEqual(computeSegmentProgress(-3, 6), 0); // would be -50%
  });
});

// ── Idempotency check (real export) ─────────────────────────────────

describe("l3-analysis-logic.isSegmentCompleted (real export)", () => {
  const segments = [
    { status: "completed" },
    { status: "pending" },
    { status: "running" },
  ];

  it("detects a completed segment", () => {
    assert.strictEqual(isSegmentCompleted(segments, 0), true);
  });

  it("detects a pending segment as not completed", () => {
    assert.strictEqual(isSegmentCompleted(segments, 1), false);
  });

  it("treats an out-of-bounds index as not completed", () => {
    assert.strictEqual(isSegmentCompleted(segments, 10), false);
  });

  it("treats a missing status as not completed", () => {
    assert.strictEqual(isSegmentCompleted([{}], 0), false);
  });
});

// ── Credit refund (REAL @usemoney/services export, reached via the processor) ──

describe("computeReservationRefund (real @usemoney/services export)", () => {
  it("refunds all credits when no segments completed", () => {
    assert.strictEqual(computeReservationRefund(5, 0, 6), 5);
  });

  it("refunds 0 when all segments completed", () => {
    assert.strictEqual(computeReservationRefund(5, 6, 6), 0);
  });

  it("refunds proportionally for partial completion (floored)", () => {
    assert.strictEqual(computeReservationRefund(6, 3, 6), 3); // 50% done
    assert.strictEqual(computeReservationRefund(5, 2, 6), 3); // floor(3.33)
  });

  it("never over-refunds on a 0 totalSegments (would be free credits)", () => {
    const r = computeReservationRefund(5, 0, 0);
    assert.ok(r >= 0 && r <= 5);
  });

  it("never over-refunds on a NEGATIVE completed count", () => {
    const r = computeReservationRefund(10, -50, 6);
    assert.ok(r <= 10, "refund must never exceed credits reserved");
  });

  it("stays finite for a non-finite completed count", () => {
    assert.ok(Number.isFinite(computeReservationRefund(10, Number.NaN, 6)));
  });
});
