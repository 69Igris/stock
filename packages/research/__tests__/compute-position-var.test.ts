/**
 * Single-position VaR tool — MONEY-806 varConfig coverage.
 *
 * De-shadow guarantee: imports and executes the REAL exported
 * `computePositionVarTool` and asserts ITS output. Relationships (selected
 * percentile, horizon scaling) are derived from the tool's own emitted fields,
 * so a regression in the source flips an assertion.
 *
 * Source under test: packages/research/src/tools/compute-position-var.ts
 *
 * MONEY-806: confidence (95|99) was inert and the multi-day scale was hardcoded
 * to sqrt(10). The tool now reads params.varConfig.{confidence,horizonDays}:
 * confidence promotes the chosen percentile as the primary VaR, horizonDays
 * drives the sqrt-of-time scaling. Defaults (95, 10 days) reproduce the old
 * output exactly when varConfig is absent.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  computePositionVarTool,
  type PositionVarResult,
} from "../src/tools/compute-position-var";

/**
 * Build a deterministic return series with enough observations (>= 40) and a
 * clear left tail so VaR95/99 differ. 60 returns: a few large negatives plus
 * many small positives.
 */
function returnSeries(): number[] {
  const out: number[] = [];
  // 3 big losses at the tail
  out.push(-0.08, -0.06, -0.05);
  // 57 small positive moves
  for (let i = 0; i < 57; i++) out.push(0.004);
  return out;
}

async function run(extra: Record<string, unknown>): Promise<PositionVarResult> {
  const out = await computePositionVarTool.execute({
    returns: returnSeries(),
    symbol: "TEST",
    ...extra,
  });
  assert.equal(out.success, true, out.error);
  const d = out.data as PositionVarResult;
  assert.equal(d.available, true, JSON.stringify(d));
  return d;
}

describe("computePositionVarTool — MONEY-806 confidence selection", () => {
  test("absent varConfig → defaults to confidence 95, horizon 10 days", async () => {
    const d = await run({});
    assert.equal(d.selectedConfidence, 95);
    assert.equal(d.horizonDays, 10);
    // selectedVaR1d mirrors the 95% historical percentile.
    assert.equal(d.selectedVaR1d, d.historicalVaR95);
  });

  test("confidence 95 → primary VaR is the 95% percentile", async () => {
    const d = await run({ varConfig: { confidence: 95 } });
    assert.equal(d.selectedConfidence, 95);
    assert.equal(d.selectedVaR1d, d.historicalVaR95);
  });

  test("confidence 99 → primary VaR switches to the (worse) 99% percentile", async () => {
    const d99 = await run({ varConfig: { confidence: 99 } });
    assert.equal(d99.selectedConfidence, 99);
    assert.equal(d99.selectedVaR1d, d99.historicalVaR99);
    // 99% VaR is at least as severe (more negative) as 95%.
    assert.ok(
      (d99.historicalVaR99 ?? 0) <= (d99.historicalVaR95 ?? 0),
      `var99 ${d99.historicalVaR99} should be <= var95 ${d99.historicalVaR95}`,
    );
  });

  test("invalid confidence (90) falls back to 95", async () => {
    const d = await run({ varConfig: { confidence: 90 } });
    assert.equal(d.selectedConfidence, 95);
  });
});

describe("computePositionVarTool — MONEY-806 horizonDays scaling", () => {
  test("horizonDays=1 → horizon VaR equals the 1-day VaR (scale 1)", async () => {
    const d = await run({ varConfig: { confidence: 95, horizonDays: 1 } });
    assert.equal(d.horizonDays, 1);
    // sqrt(1)=1 → horizon-scaled equals the 1-day selected VaR.
    assert.equal(d.selectedVaRHorizon, d.selectedVaR1d);
  });

  test("horizonDays=10 (default) scales by sqrt(10)", async () => {
    const d1 = await run({ varConfig: { confidence: 95, horizonDays: 1 } });
    const d10 = await run({ varConfig: { confidence: 95, horizonDays: 10 } });
    assert.equal(d10.horizonDays, 10);
    // The 10-day selected VaR ≈ 1-day × sqrt(10). Compare on the raw % field
    // the tool emits (both pct2-rounded), allowing a 1-dp rounding tolerance.
    const expected = (d1.selectedVaR1d ?? 0) * Math.sqrt(10);
    assert.ok(
      Math.abs((d10.selectedVaRHorizon ?? 0) - expected) < 0.05,
      `10-day ${d10.selectedVaRHorizon} vs expected ${expected}`,
    );
    // The legacy historicalVaR95_10d field now also follows horizonDays=10.
    assert.equal(d10.selectedVaRHorizon, d10.historicalVaR95_10d);
  });

  test("horizonDays drives the legacy *_10d fields (no longer hardcoded sqrt(10))", async () => {
    // With horizonDays=4 (scale 2), the *_10d field should be ~2x the 1-day.
    const d = await run({ varConfig: { confidence: 95, horizonDays: 4 } });
    assert.equal(d.horizonDays, 4);
    const oneDay = d.historicalVaR95 ?? 0;
    const scaled = d.historicalVaR95_10d ?? 0;
    assert.ok(
      Math.abs(scaled - oneDay * 2) < 0.05,
      `scaled ${scaled} should be ~2x ${oneDay}`,
    );
  });

  test("invalid horizonDays (<1 or NaN) falls back to 10", async () => {
    const dZero = await run({ varConfig: { confidence: 95, horizonDays: 0 } });
    assert.equal(dZero.horizonDays, 10);
  });
});

describe("computePositionVarTool — MONEY-806 selected INR amounts", () => {
  test("positionValue → selected INR amounts present and track the percentile", async () => {
    const d95 = await run({
      positionValue: 100000,
      varConfig: { confidence: 95, horizonDays: 10 },
    });
    const d99 = await run({
      positionValue: 100000,
      varConfig: { confidence: 99, horizonDays: 10 },
    });
    assert.ok(typeof d95.selectedVarAmount1d === "number");
    assert.ok(typeof d95.selectedVarAmountHorizon === "number");
    // Horizon amount (10-day) is larger than 1-day for the same confidence.
    assert.ok(
      (d95.selectedVarAmountHorizon ?? 0) > (d95.selectedVarAmount1d ?? 0),
    );
    // 99% INR amount is at least the 95% amount (worse tail).
    assert.ok((d99.selectedVarAmount1d ?? 0) >= (d95.selectedVarAmount1d ?? 0));
  });

  test("no positionValue → selected INR amounts omitted", async () => {
    const d = await run({ varConfig: { confidence: 95 } });
    assert.equal(d.selectedVarAmount1d, undefined);
    assert.equal(d.selectedVarAmountHorizon, undefined);
  });
});

describe("computePositionVarTool — back-compat (varConfig absent ≡ old output)", () => {
  test("default run still emits the legacy fields with sqrt(10) scaling", async () => {
    const d = await run({ positionValue: 100000 });
    // Legacy fields unchanged: *_10d is the 1-day × sqrt(10).
    const oneDay = d.historicalVaR95 ?? 0;
    const expected = oneDay * Math.sqrt(10);
    assert.ok(
      Math.abs((d.historicalVaR95_10d ?? 0) - expected) < 0.05,
      `legacy 10d ${d.historicalVaR95_10d} vs ${expected}`,
    );
    assert.ok(typeof d.var95Amount10d === "number");
  });
});
