/**
 * Paper-trading DB pure-logic — REAL exports, no shadows (MONEY-620, task 169).
 *
 * `lib/db/paper.ts` is the LIVE paper-trading data layer (called by
 * `lib/actions/paper.ts`, which the four `app/paper-trading/*` pages drive). It
 * historically kept its OWN un-guarded inline P&L / benchmark / win-rate /
 * averaging math — NOT wired to the `@usemoney/services` helpers. That math is
 * now extracted into `@/lib/db/paper-logic` and `lib/db/paper.ts` CALLS these
 * exports, so the assertions below execute the SAME code production runs (not a
 * copy — the de-shadow contract).
 *
 * Every test feeds adversarial fixtures (0 trades, 0/netted quantity, NaN,
 * ±Infinity, null) at the exact bug classes the live UI renders:
 *   - win-rate div-by-zero (0 closed trades → NaN% → "NaN%" on screen),
 *   - benchmark/alpha non-finite (poisoned + PERSISTED),
 *   - portfolio/performance non-finite poison ("₹NaN" header),
 *   - pnlPercentage Infinity leak (the old `> 0` gate),
 *   - average-into-position divide-by-zero ("netted" legs).
 *
 * Pure & Prisma-free (imports only `@/lib/db/paper-logic`) → exits clean, no
 * orphan. Run: `cd apps/web && node --import tsx --test __tests__/db/paper-logic.test.ts`.
 *
 * Source: apps/web/lib/db/paper-logic.ts (called by lib/db/paper.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  finite,
  pnlPercentage,
  defaultSegmentForAssetType,
  resolveSegment,
  resolveSide,
  assetTypeForInstrumentType,
  positionTypeForSide,
  investedValue,
  currentValue,
  unrealizedPnL,
  realizedPnL,
  benchmarkAndAlpha,
  normalizeCreateValues,
  averageIntoPosition,
  summarizePaperPortfolio,
  calculateWinRate,
  average,
  calculatePerformance,
  type PaperSummaryRow,
  type PaperPerformanceRow,
} from "@/lib/db/paper-logic";

// ===========================================================================
// finite — the poison guard every other helper leans on.
// ===========================================================================

describe("paper-logic finite()", () => {
  it("passes finite numbers through unchanged (incl. negatives and 0)", () => {
    assert.strictEqual(finite(42), 42);
    assert.strictEqual(finite(-7.5), -7.5);
    assert.strictEqual(finite(0), 0);
  });

  it("collapses null/undefined/NaN/±Infinity to the fallback (default 0)", () => {
    assert.strictEqual(finite(null), 0);
    assert.strictEqual(finite(undefined), 0);
    assert.strictEqual(finite(NaN), 0);
    assert.strictEqual(finite(Infinity), 0);
    assert.strictEqual(finite(-Infinity), 0);
  });

  it("honours a custom fallback", () => {
    assert.strictEqual(finite(NaN, -1), -1);
    assert.strictEqual(finite(Infinity, 99), 99);
  });
});

// ===========================================================================
// pnlPercentage — the Infinity-leak fix (old `investedValue > 0` gate).
// ===========================================================================

describe("paper-logic pnlPercentage()", () => {
  it("computes the percentage for finite positive cost basis", () => {
    assert.strictEqual(pnlPercentage(1000, 5000), 20);
    assert.strictEqual(pnlPercentage(-500, 5000), -10);
  });

  it("returns 0 when invested is 0 or negative (no x/0)", () => {
    assert.strictEqual(pnlPercentage(100, 0), 0);
    assert.strictEqual(pnlPercentage(100, -10), 0);
  });

  it("returns 0 (NOT Infinity) when invested is Infinity — `Infinity > 0` leak", () => {
    // The old inline guard `investedValue > 0` is TRUE for Infinity.
    assert.strictEqual(pnlPercentage(100, Infinity), 0);
  });

  it("returns 0 (NOT Infinity) when the P&L is non-finite over a finite basis", () => {
    assert.strictEqual(pnlPercentage(Infinity, 5000), 0);
    assert.strictEqual(pnlPercentage(NaN, 5000), 0);
  });
});

// ===========================================================================
// default-segment / side / assetType derivation (the branching edges).
// ===========================================================================

describe("paper-logic default-segment & side derivation", () => {
  it("maps asset types to default segments", () => {
    assert.strictEqual(defaultSegmentForAssetType("FNO_OPTIONS"), "OPTIONS");
    assert.strictEqual(defaultSegmentForAssetType("FNO_FUTURES"), "FUTURES");
    assert.strictEqual(defaultSegmentForAssetType("STOCK"), "EQUITY");
    assert.strictEqual(defaultSegmentForAssetType("MF"), "EQUITY");
    assert.strictEqual(defaultSegmentForAssetType("anything-else"), "EQUITY");
  });

  it("resolveSegment prefers an explicit segment, else the asset-type default", () => {
    assert.strictEqual(resolveSegment("CUSTOM", "STOCK"), "CUSTOM");
    assert.strictEqual(resolveSegment(undefined, "FNO_OPTIONS"), "OPTIONS");
    assert.strictEqual(resolveSegment(null, "FNO_FUTURES"), "FUTURES");
    assert.strictEqual(resolveSegment("", "STOCK"), "EQUITY"); // "" is falsy
  });

  it("resolveSide prefers side, then positionType, then LONG", () => {
    assert.strictEqual(resolveSide("SHORT", "LONG"), "SHORT");
    assert.strictEqual(resolveSide(undefined, "SHORT"), "SHORT");
    assert.strictEqual(resolveSide(null, null), "LONG");
    assert.strictEqual(resolveSide("", ""), "LONG"); // both falsy
  });

  it("maps order instrumentType to the stored assetType", () => {
    assert.strictEqual(assetTypeForInstrumentType("OPTIONS"), "FNO_OPTIONS");
    assert.strictEqual(assetTypeForInstrumentType("FUTURES"), "FNO_FUTURES");
    assert.strictEqual(assetTypeForInstrumentType("MF"), "MF");
    assert.strictEqual(assetTypeForInstrumentType("EQUITY"), "STOCK");
    assert.strictEqual(assetTypeForInstrumentType("unknown"), "STOCK");
  });

  it("derives positionType LONG for BUY, SHORT otherwise", () => {
    assert.strictEqual(positionTypeForSide("BUY"), "LONG");
    assert.strictEqual(positionTypeForSide("SELL"), "SHORT");
    assert.strictEqual(positionTypeForSide("anything"), "SHORT");
  });
});

// ===========================================================================
// Per-position value / P&L (create + price-update + close).
// ===========================================================================

describe("paper-logic investedValue() / currentValue()", () => {
  it("multiplies qty × price for finite inputs", () => {
    assert.strictEqual(investedValue(10, 250), 2500);
    assert.strictEqual(currentValue(10, 300), 3000);
  });

  it("returns 0 for a NaN/Infinity qty or price (no poison persisted)", () => {
    assert.strictEqual(investedValue(NaN, 250), 0);
    assert.strictEqual(investedValue(10, Infinity), 0);
    assert.strictEqual(currentValue(Infinity, 300), 0);
    assert.strictEqual(currentValue(10, NaN), 0);
  });
});

describe("paper-logic unrealizedPnL()", () => {
  it("LONG = current − invested; SHORT = invested − current", () => {
    assert.strictEqual(unrealizedPnL("LONG", 3000, 2500), 500);
    assert.strictEqual(unrealizedPnL("SHORT", 3000, 2500), -500);
    // any non-LONG positionType is treated as SHORT (mirrors the source ternary)
    assert.strictEqual(unrealizedPnL("WHATEVER", 3000, 2500), -500);
  });

  it("guards non-finite value endpoints to 0", () => {
    assert.strictEqual(unrealizedPnL("LONG", Infinity, 2500), -2500);
    assert.strictEqual(unrealizedPnL("LONG", 3000, NaN), 3000);
    assert.ok(Number.isFinite(unrealizedPnL("SHORT", NaN, Infinity)));
  });
});

describe("paper-logic realizedPnL() on close", () => {
  it("LONG profit & loss; SHORT profit & loss", () => {
    // bought 10 @ 250 (invested 2500), exit 300 → +500
    assert.strictEqual(realizedPnL("LONG", 10, 300, 2500), 500);
    // exit below cost is a real loss, preserved
    assert.strictEqual(realizedPnL("LONG", 10, 200, 2500), -500);
    // SHORT: invested − exitValue
    assert.strictEqual(realizedPnL("SHORT", 10, 200, 2500), 500);
    assert.strictEqual(realizedPnL("SHORT", 10, 300, 2500), -500);
  });

  it("never returns NaN/Infinity for a corrupt exitPrice/qty/invested", () => {
    // exitValue = finite(10 × Infinity) = 0 ⇒ LONG: 0 − 2500 = −2500 (finite).
    assert.strictEqual(realizedPnL("LONG", 10, Infinity, 2500), -2500);
    // exitValue = finite(NaN × 300) = 0 ⇒ LONG: 0 − 2500 = −2500 (finite).
    assert.strictEqual(realizedPnL("LONG", NaN, 300, 2500), -2500);
    // SHORT: invested(NaN→0) − exitValue(3000) = −3000 (finite).
    assert.strictEqual(realizedPnL("SHORT", 10, 300, NaN), -3000);
    // all corrupt ⇒ everything collapses to a finite 0.
    assert.strictEqual(realizedPnL("LONG", Infinity, Infinity, NaN), 0);
    assert.ok(Number.isFinite(realizedPnL("LONG", Infinity, Infinity, NaN)));
  });
});

// ===========================================================================
// benchmark / alpha — the persisted-poison + truthy-gate fix.
// ===========================================================================

describe("paper-logic benchmarkAndAlpha()", () => {
  it("computes benchmark P&L and alpha for finite Nifty data", () => {
    // invested 100000, nifty 20000 → 22000 (+10%) → benchmark 10000
    const r = benchmarkAndAlpha(100000, 15000, 20000, 22000);
    assert.strictEqual(r.benchmarkPnL, 10000);
    assert.strictEqual(r.alpha, 5000); // 15000 − 10000
  });

  it("returns {0,0} when Nifty data is absent (the inline default)", () => {
    assert.deepStrictEqual(benchmarkAndAlpha(100000, 5000, null, 22000), {
      benchmarkPnL: 0,
      alpha: 0,
    });
    assert.deepStrictEqual(benchmarkAndAlpha(100000, 5000, 20000, null), {
      benchmarkPnL: 0,
      alpha: 0,
    });
    assert.deepStrictEqual(benchmarkAndAlpha(100000, 5000, 0, 22000), {
      benchmarkPnL: 0,
      alpha: 0,
    });
  });

  it("does NOT persist a non-finite benchmark when currentNifty is Infinity/NaN", () => {
    // old `if (niftyAtEntry && currentNifty)` truthy-gate let Infinity through.
    const inf = benchmarkAndAlpha(100000, 5000, 20000, Infinity);
    assert.strictEqual(inf.benchmarkPnL, 0);
    assert.strictEqual(inf.alpha, 0);
    const nan = benchmarkAndAlpha(100000, 5000, 20000, NaN);
    assert.strictEqual(nan.benchmarkPnL, 0);
    assert.ok(Number.isFinite(nan.alpha));
  });

  it("guards a non-finite investedValue / positionPnL", () => {
    const r = benchmarkAndAlpha(Infinity, NaN, 20000, 22000);
    assert.ok(Number.isFinite(r.benchmarkPnL));
    assert.ok(Number.isFinite(r.alpha));
  });
});

// ===========================================================================
// normalizeCreateValues — guard the PERSISTED create write.
// ===========================================================================

describe("paper-logic normalizeCreateValues()", () => {
  it("derives invested/current/currentPrice from qty × avg (finite case)", () => {
    assert.deepStrictEqual(
      normalizeCreateValues({ quantity: 10, averagePrice: 250 }),
      {
        quantity: 10,
        averagePrice: 250,
        investedValue: 2500,
        currentPrice: 250,
        currentValue: 2500,
      }
    );
  });

  it("collapses every field to a finite number for NaN/Infinity input", () => {
    const r = normalizeCreateValues({ quantity: Infinity, averagePrice: NaN });
    assert.strictEqual(r.quantity, 0);
    assert.strictEqual(r.averagePrice, 0);
    assert.strictEqual(r.investedValue, 0);
    assert.strictEqual(r.currentPrice, 0);
    assert.strictEqual(r.currentValue, 0);
    for (const v of Object.values(r)) assert.ok(Number.isFinite(v));
  });
});

// ===========================================================================
// averageIntoPosition — the divide-by-zero fix (netted legs).
// ===========================================================================

describe("paper-logic averageIntoPosition()", () => {
  it("averages two same-direction fills (behaviour-preserving)", () => {
    // existing 10 @ 100 (currentPrice 120), add 10 @ 200 → 20 @ 150
    const r = averageIntoPosition(
      { quantity: 10, averagePrice: 100, currentPrice: 120 },
      { quantity: 10, price: 200 }
    );
    assert.strictEqual(r.quantity, 20);
    assert.strictEqual(r.averagePrice, 150);
    assert.strictEqual(r.investedValue, 3000);
    assert.strictEqual(r.currentValue, 2400); // 20 × 120
  });

  it("returns a flat-0 position when the legs net to zero quantity (DIV-BY-ZERO)", () => {
    // existing LONG 10, an opposing fill of -10 → totalQty 0 → newAvgPrice = x/0.
    const r = averageIntoPosition(
      { quantity: 10, averagePrice: 100, currentPrice: 120 },
      { quantity: -10, price: 200 }
    );
    assert.deepStrictEqual(r, {
      quantity: 0,
      averagePrice: 0,
      investedValue: 0,
      currentValue: 0,
    });
    assert.ok(Number.isFinite(r.averagePrice)); // never NaN/Infinity
  });

  it("returns a flat-0 position for two zero-qty fills (0/0)", () => {
    const r = averageIntoPosition(
      { quantity: 0, averagePrice: 0, currentPrice: 0 },
      { quantity: 0, price: 0 }
    );
    assert.deepStrictEqual(r, {
      quantity: 0,
      averagePrice: 0,
      investedValue: 0,
      currentValue: 0,
    });
  });

  it("guards non-finite existing/fill values", () => {
    const r = averageIntoPosition(
      { quantity: NaN, averagePrice: Infinity, currentPrice: NaN },
      { quantity: 10, price: 200 }
    );
    for (const v of Object.values(r)) assert.ok(Number.isFinite(v));
  });
});

// ===========================================================================
// summarizePaperPortfolio — the "₹NaN" header guard + Infinity-pct leak.
// ===========================================================================

describe("paper-logic summarizePaperPortfolio()", () => {
  const row = (o: Partial<PaperSummaryRow>): PaperSummaryRow => ({
    status: "OPEN",
    assetType: "STOCK",
    investedValue: 0,
    currentValue: 0,
    ...o,
  });

  it("sums only OPEN rows; CLOSED rows do not contribute to totals/counts", () => {
    const s = summarizePaperPortfolio([
      row({ investedValue: 1000, currentValue: 1200, assetType: "STOCK" }),
      row({ investedValue: 2000, currentValue: 1800, assetType: "MF" }),
      row({ status: "CLOSED", investedValue: 9999, currentValue: 9999 }),
    ]);
    assert.strictEqual(s.totalInvested, 3000);
    assert.strictEqual(s.totalCurrent, 3000);
    assert.strictEqual(s.totalPnL, 0);
    assert.strictEqual(s.totalPositions, 2);
    assert.strictEqual(s.stockPositions, 1);
    assert.strictEqual(s.mfPositions, 1);
    assert.strictEqual(s.fnoPositions, 0);
  });

  it("counts FNO_FUTURES and FNO_OPTIONS together as fnoPositions", () => {
    const s = summarizePaperPortfolio([
      row({ assetType: "FNO_FUTURES" }),
      row({ assetType: "FNO_OPTIONS" }),
      row({ assetType: "STOCK" }),
    ]);
    assert.strictEqual(s.fnoPositions, 2);
    assert.strictEqual(s.stockPositions, 1);
  });

  it("aggregates benchmarkPnL/alpha/dayPnl across OPEN rows", () => {
    const s = summarizePaperPortfolio([
      row({
        investedValue: 1000,
        currentValue: 1500,
        benchmarkPnL: 200,
        dayPnl: 50,
      }),
      row({
        investedValue: 1000,
        currentValue: 900,
        benchmarkPnL: -100,
        dayPnl: -30,
      }),
    ]);
    assert.strictEqual(s.totalPnL, 400); // (1500+900) − (1000+1000)
    assert.strictEqual(s.benchmarkPnL, 100); // 200 + (−100)
    assert.strictEqual(s.alpha, 300); // 400 − 100
    assert.strictEqual(s.dayPnl, 20); // 50 + (−30)
  });

  it("does NOT poison totals when ONE OPEN row is NaN/Infinity (₹NaN bug)", () => {
    const s = summarizePaperPortfolio([
      row({ investedValue: 1000, currentValue: 1200 }),
      row({
        investedValue: NaN,
        currentValue: Infinity,
        benchmarkPnL: NaN,
        dayPnl: Infinity,
      }),
    ]);
    assert.strictEqual(s.totalInvested, 1000);
    assert.strictEqual(s.totalCurrent, 1200);
    assert.strictEqual(s.totalPnL, 200);
    assert.ok(Number.isFinite(s.benchmarkPnL));
    assert.ok(Number.isFinite(s.alpha));
    assert.ok(Number.isFinite(s.dayPnl));
    assert.ok(Number.isFinite(s.pnlPercentage));
  });

  it("returns 0 pnlPercentage when totalInvested is 0 (empty/zero portfolio)", () => {
    assert.strictEqual(summarizePaperPortfolio([]).pnlPercentage, 0);
    assert.deepStrictEqual(summarizePaperPortfolio([]), {
      totalInvested: 0,
      totalCurrent: 0,
      totalPnL: 0,
      pnlPercentage: 0,
      totalPositions: 0,
      stockPositions: 0,
      fnoPositions: 0,
      mfPositions: 0,
      benchmarkPnL: 0,
      alpha: 0,
      dayPnl: 0,
    });
  });

  it("treats null benchmarkPnL/dayPnl as 0 (no NaN leak)", () => {
    const s = summarizePaperPortfolio([
      row({
        investedValue: 1000,
        currentValue: 1100,
        benchmarkPnL: null,
        dayPnl: null,
      }),
    ]);
    assert.strictEqual(s.benchmarkPnL, 0);
    assert.strictEqual(s.dayPnl, 0);
    assert.strictEqual(s.alpha, 100);
  });
});

// ===========================================================================
// calculateWinRate / average — div-by-zero + poison guards.
// ===========================================================================

describe("paper-logic calculateWinRate()", () => {
  it("is a percentage 0–100 for normal inputs", () => {
    assert.strictEqual(calculateWinRate(1, 2), 50);
    assert.strictEqual(calculateWinRate(3, 4), 75);
    assert.strictEqual(calculateWinRate(0, 5), 0);
  });

  it("returns 0 (NOT NaN) for 0 closed trades — the div-by-zero bug", () => {
    // winners/0 → NaN; NaN.toFixed(1) === "NaN" on the Paper-Trading card.
    assert.strictEqual(calculateWinRate(0, 0), 0);
    assert.ok(!Number.isNaN(calculateWinRate(0, 0)));
    assert.strictEqual(calculateWinRate(5, 0), 0);
  });

  it("guards non-finite operands", () => {
    assert.strictEqual(calculateWinRate(NaN, 4), 0);
    assert.strictEqual(calculateWinRate(2, Infinity), 0);
  });
});

describe("paper-logic average()", () => {
  it("means a list, 0 for empty", () => {
    assert.strictEqual(average([10, 20, 30]), 20);
    assert.strictEqual(average([]), 0);
    assert.strictEqual(average([-100, 100]), 0);
  });

  it("does not let a NaN/Infinity element poison the mean", () => {
    assert.strictEqual(average([10, NaN, 30]), (10 + 0 + 30) / 3);
    assert.ok(Number.isFinite(average([Infinity, 50])));
  });
});

// ===========================================================================
// calculatePerformance — the full performance block (the win-rate / best-worst
// / total-poison guards together).
// ===========================================================================

describe("paper-logic calculatePerformance()", () => {
  const closed = (
    symbol: string,
    realizedPnL: number | null,
    benchmarkPnL: number | null = 0
  ): PaperPerformanceRow => ({ symbol, realizedPnL, benchmarkPnL });

  it("computes the full block for a normal sorted-desc closed set", () => {
    // sorted desc by realizedPnL (as the Prisma query orders)
    const rows = [
      closed("WIN", 500, 100),
      closed("FLAT", 0, 0),
      closed("LOSS", -300, -50),
    ];
    const p = calculatePerformance(rows, 2 /* open */);
    assert.strictEqual(p.totalTrades, 5); // 3 closed + 2 open
    assert.strictEqual(p.closedTrades, 3);
    assert.strictEqual(p.winners, 1);
    assert.strictEqual(p.losers, 1);
    assert.strictEqual(p.winRate, (1 / 3) * 100);
    assert.strictEqual(p.totalRealizedPnL, 200); // 500+0−300
    assert.strictEqual(p.totalBenchmarkPnL, 50); // 100+0−50
    assert.strictEqual(p.totalAlpha, 150); // 200 − 50
    assert.strictEqual(p.avgWin, 500);
    assert.strictEqual(p.avgLoss, -300);
    assert.strictEqual(p.bestTradePnL, 500);
    assert.strictEqual(p.worstTradePnL, -300);
    assert.deepStrictEqual(p.bestTrade, { symbol: "WIN", pnl: 500 });
    assert.deepStrictEqual(p.worstTrade, { symbol: "LOSS", pnl: -300 });
  });

  it("returns an all-zero/null block for NO closed trades (0-trades div-by-zero)", () => {
    const p = calculatePerformance([], 3);
    assert.strictEqual(p.totalTrades, 3);
    assert.strictEqual(p.closedTrades, 0);
    assert.strictEqual(p.winners, 0);
    assert.strictEqual(p.losers, 0);
    assert.strictEqual(p.winRate, 0); // NOT NaN
    assert.ok(!Number.isNaN(p.winRate));
    assert.strictEqual(p.totalRealizedPnL, 0);
    assert.strictEqual(p.totalAlpha, 0);
    assert.strictEqual(p.avgWin, 0);
    assert.strictEqual(p.avgLoss, 0);
    assert.strictEqual(p.bestTradePnL, 0);
    assert.strictEqual(p.worstTradePnL, 0);
    assert.strictEqual(p.bestTrade, null);
    assert.strictEqual(p.worstTrade, null);
  });

  it("does NOT let a NaN/Infinity realizedPnL poison totals / best / worst", () => {
    // a corrupt row used to make Math.max(...allPnls) === NaN and the reduce sum NaN.
    const rows = [
      closed("A", 500),
      closed("BAD", NaN),
      closed("C", Infinity),
      closed("D", -200),
    ];
    const p = calculatePerformance(rows, 0);
    assert.ok(Number.isFinite(p.totalRealizedPnL));
    assert.ok(Number.isFinite(p.bestTradePnL));
    assert.ok(Number.isFinite(p.worstTradePnL));
    assert.ok(Number.isFinite(p.avgWin));
    assert.ok(Number.isFinite(p.avgLoss));
    assert.ok(Number.isFinite(p.winRate));
    // best is the real finite max (500), worst the real finite min (−200);
    // NaN/Infinity rows are neutralised to 0 by finite().
    assert.strictEqual(p.bestTradePnL, 500);
    assert.strictEqual(p.worstTradePnL, -200);
  });

  it("treats null realizedPnL as 0 (not a winner, not a loser, no NaN)", () => {
    const rows = [closed("N", null), closed("W", 100)];
    const p = calculatePerformance(rows, 0);
    assert.strictEqual(p.winners, 1);
    assert.strictEqual(p.losers, 0);
    assert.strictEqual(p.totalRealizedPnL, 100);
    assert.ok(Number.isFinite(p.totalRealizedPnL));
  });

  it("finds best/worst even if the input is NOT sorted desc (robust scan)", () => {
    const rows = [closed("MID", 100), closed("TOP", 900), closed("BOT", -400)];
    const p = calculatePerformance(rows, 0);
    assert.deepStrictEqual(p.bestTrade, { symbol: "TOP", pnl: 900 });
    assert.deepStrictEqual(p.worstTrade, { symbol: "BOT", pnl: -400 });
  });
});
