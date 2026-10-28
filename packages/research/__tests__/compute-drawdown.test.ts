/**
 * Drawdown tool — negative / edge / insufficient-data coverage.
 *
 * De-shadow guarantee: imports and executes the REAL exported
 * `computeDrawdownTool` and asserts ITS output. Expected constants were derived
 * from the real tool on fixed fixtures, then pinned.
 *
 * Source under test: packages/research/src/tools/compute-drawdown.ts
 *
 * Real bugs found & fixed in source while writing these:
 *  - a ZERO peak made drawdown `±Infinity` (0/0 → NaN), serialized `null`;
 *  - a NEGATIVE peak flipped the sign so a deeper loss read as a positive
 *    "drawdown" (e.g. a -200% loss reported as currentDrawdown +2).
 * Both are now domain-guarded to a finite 0; asserted below.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { computeDrawdownTool } from "../src/tools/compute-drawdown";
import type { DrawdownResult } from "../src/types";

type Point = { date: string; value: number };

function series(values: number[]): Point[] {
  return values.map((value, i) => ({
    date: `2025-01-${String(i + 1).padStart(2, "0")}`,
    value,
  }));
}

async function ok(valueSeries: Point[]): Promise<DrawdownResult> {
  const out = await computeDrawdownTool.execute({ valueSeries });
  assert.equal(out.success, true, out.error);
  return out.data as DrawdownResult;
}

function assertAllFinite(d: DrawdownResult): void {
  assert.ok(Number.isFinite(d.maxDrawdown), `maxDrawdown ${d.maxDrawdown}`);
  assert.ok(
    Number.isFinite(d.currentDrawdown),
    `currentDrawdown ${d.currentDrawdown}`,
  );
  if (d.recoveryDays !== null) {
    assert.ok(
      Number.isFinite(d.recoveryDays),
      `recoveryDays ${d.recoveryDays}`,
    );
  }
  for (const p of d.underwaterPeriods) {
    assert.ok(Number.isFinite(p.depth), `uw depth ${p.depth}`);
    assert.ok(Number.isFinite(p.durationDays), `uw dur ${p.durationDays}`);
  }
}

describe("computeDrawdownTool — insufficient data", () => {
  // MONEY-1274 (MONEY-1155 #30) — these asserted `success: false`, which is
  // what made a THIN INPUT read as a FAILED COMPUTATION. The executor marks a
  // success:false task as failed and the synthesiser lists it under "FAILED /
  // UNAVAILABLE SOURCES", so a run that merely fetched too little data was
  // reported to the user as the analysis engine breaking.
  //
  // The tool did not fail: it correctly declined to compute a drawdown from
  // four points. The contract is now `success: true` + `available: false` +
  // a reason — matching the 27 other compute tools that already did this.
  //
  // These assertions are STRONGER than before: they pin the reason AND that no
  // fabricated number is returned, where the old ones only checked a boolean.

  test("empty series → unavailable, not a failure", async () => {
    const out = await computeDrawdownTool.execute({ valueSeries: [] });
    assert.equal(out.success, true, "an empty input is not a tool failure");
    const d = out.data as Record<string, unknown>;
    assert.equal(d.available, false);
    assert.match(String(d.reason), /At least 5 data points/);
    assert.equal(d.got, 0);
    assert.equal(d.maxDrawdown, undefined, "must not invent a drawdown");
  });

  test("4 points → unavailable (boundary)", async () => {
    const out = await computeDrawdownTool.execute({
      valueSeries: series([100, 90, 95, 92]),
    });
    assert.equal(out.success, true);
    const d = out.data as Record<string, unknown>;
    assert.equal(d.available, false);
    assert.equal(d.got, 4, "the shortfall is reported, not just the failure");
  });

  test("exactly 5 points → success (boundary)", async () => {
    const d = await ok(series([100, 90, 95, 92, 110]));
    assertAllFinite(d);
  });

  test("undefined series → unavailable", async () => {
    // An omitted series is still "nothing to compute from" rather than a
    // caller error worth failing the run over — the planner routinely calls
    // this after a fetch that returned no history.
    const out = await computeDrawdownTool.execute({});
    assert.equal(out.success, true);
    const d = out.data as Record<string, unknown>;
    assert.equal(d.available, false);
  });
});

describe("computeDrawdownTool — computed values (pinned to real tool)", () => {
  test("V-shaped recovery has correct maxDD, recovery and current DD", async () => {
    // 100 → 80 → 60 (trough) → 90 → 120 (new peak) → 110.
    const d = await ok(series([100, 80, 60, 90, 120, 110]));
    assert.equal(d.maxDrawdown, -0.4); // (60-100)/100
    assert.equal(d.maxDrawdownStart, "2025-01-01");
    assert.equal(d.maxDrawdownEnd, "2025-01-03");
    assert.equal(d.recoveryDays, 2); // 60(idx2) → 120(idx4) recovers past 100
    assert.equal(d.currentDrawdown, -0.0833); // (110-120)/120
    assertAllFinite(d);
  });

  test("monotonic uptrend → no drawdown", async () => {
    const d = await ok(series([100, 110, 120, 130, 140]));
    assert.equal(d.maxDrawdown, 0);
    assert.equal(d.currentDrawdown, 0);
    assert.equal(d.underwaterPeriods.length, 0);
    assertAllFinite(d);
  });

  test("flat series → zero drawdown, no underwater periods", async () => {
    const d = await ok(series([100, 100, 100, 100, 100]));
    assert.equal(d.maxDrawdown, 0);
    assert.equal(d.currentDrawdown, 0);
    assert.equal(d.underwaterPeriods.length, 0);
    assertAllFinite(d);
  });

  test("never recovers → recoveryDays null, current DD negative", async () => {
    // Declines and ends below peak → currentDrawdown < 0, no recovery.
    const d = await ok(series([100, 80, 70, 60, 50]));
    assert.equal(d.recoveryDays, null);
    assert.ok(d.currentDrawdown < 0);
    assert.equal(d.maxDrawdown, -0.5); // (50-100)/100
    assertAllFinite(d);
  });

  test("underwater periods are capped to 5 and sorted by depth", async () => {
    // Many small dips between peaks → ensure <= 5 and ascending depth.
    const d = await ok(
      series([
        100, 95, 101, 96, 102, 97, 103, 98, 104, 99, 105, 90, 106, 80, 107,
      ]),
    );
    assert.ok(d.underwaterPeriods.length <= 5);
    for (let i = 1; i < d.underwaterPeriods.length; i++) {
      assert.ok(
        d.underwaterPeriods[i]!.depth >= d.underwaterPeriods[i - 1]!.depth,
        "underwater periods must be sorted ascending by depth",
      );
    }
    assertAllFinite(d);
  });
});

describe("computeDrawdownTool — out-of-domain value series (finite, no leak)", () => {
  // BUG (FIXED): a zero peak produced -Infinity drawdown and `null` depth.
  test("value drops below a ZERO peak → finite (no Infinity/NaN)", async () => {
    const d = await ok([
      { date: "d1", value: 0 },
      { date: "d2", value: -10 },
      { date: "d3", value: -5 },
      { date: "d4", value: -20 },
      { date: "d5", value: 0 },
    ]);
    assert.equal(d.maxDrawdown, 0); // peak<=0 → guarded to 0
    assert.equal(d.currentDrawdown, 0);
    assertAllFinite(d);
  });

  // BUG (FIXED): an all-negative declining series divided by a negative peak
  // flipped signs → currentDrawdown reported +2 (a +200% "gain" from a loss).
  test("all-negative declining series → finite, non-positive readings", async () => {
    const d = await ok([
      { date: "d1", value: -100 },
      { date: "d2", value: -150 },
      { date: "d3", value: -200 },
      { date: "d4", value: -250 },
      { date: "d5", value: -300 },
    ]);
    assert.equal(d.maxDrawdown, 0); // negative peak → guarded, never sign-flips
    assert.equal(d.currentDrawdown, 0);
    assert.ok(d.maxDrawdown <= 0);
    assert.ok(d.currentDrawdown <= 0);
    assertAllFinite(d);
  });
});
