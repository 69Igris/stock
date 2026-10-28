/**
 * MONEY-457: Deterministic comparison scoring tests.
 *
 * Verifies:
 *   1. Same input → same output (determinism — the bug the tool fixes).
 *   2. Per-stock totals match sum of the 7 criterion scores.
 *   3. Peer-relative valuation correctly ranks cheaper stocks higher.
 *   4. Missing metrics fall back to mid-range scores without throwing.
 *   5. Tool wrapper rejects fewer than 2 stocks.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeComparisonScores,
  computeComparisonScoresTool,
  type ComparisonStockMetrics,
} from "@usemoney/research/tools";

// Sample inputs roughly modelled on the user-reported ABB / ACC / ADANIENT
// comparison. Numbers chosen so each stock has a clear strength + weakness.
const SAMPLE_STOCKS: ComparisonStockMetrics[] = [
  {
    symbol: "ABB",
    pe: 88.7,
    pb: 12.1,
    roe: 19.9,
    netMargin: 11.9,
    revenueGrowthYoY: 21.9,
    epsGrowth: 25,
    debtEquity: 0.05,
    currentRatio: 1.6,
    cfNiRatio: 1.18,
    accrualRatio: 0.04,
    rsi: 62,
    sma200Position: "above",
    adx: 28,
    promoterHolding: 75.0,
    promoterHoldingChange: 0,
    promoterPledge: 0,
    institutionalTrend: "rising",
  },
  {
    symbol: "ACC",
    pe: 11.9,
    pb: 1.4,
    roe: 10.9,
    netMargin: 10.6,
    revenueGrowthYoY: -10.2,
    epsGrowth: -8,
    debtEquity: 2.1,
    currentRatio: 0.95,
    cfNiRatio: 0.92,
    accrualRatio: 0.11,
    rsi: 42,
    sma200Position: "below",
    adx: 18,
    promoterHolding: 56.0,
    promoterHoldingChange: -0.5,
    promoterPledge: 0,
    institutionalTrend: "falling",
  },
  {
    symbol: "ADANIENT",
    pe: 36.7,
    pb: 5.4,
    roe: 13.7,
    netMargin: 3.0,
    revenueGrowthYoY: -20.6,
    epsGrowth: -15,
    debtEquity: 119.6,
    currentRatio: 1.1,
    cfNiRatio: 0.6,
    accrualRatio: 0.22,
    rsi: 51,
    sma200Position: "near",
    adx: 22,
    promoterHolding: 73.0,
    promoterHoldingChange: 0,
    promoterPledge: 4,
    institutionalTrend: "flat",
  },
];

describe("computeComparisonScores — deterministic per-stock scoring", () => {
  describe("determinism (the bug this fixes)", () => {
    it("produces identical output for identical input across runs", () => {
      const first = computeComparisonScores(SAMPLE_STOCKS);
      const second = computeComparisonScores(SAMPLE_STOCKS);
      const third = computeComparisonScores(SAMPLE_STOCKS);
      assert.deepEqual(first, second);
      assert.deepEqual(second, third);
    });

    it("is order-independent for the per-stock totals", () => {
      const a = computeComparisonScores(SAMPLE_STOCKS);
      const reversed = computeComparisonScores([...SAMPLE_STOCKS].reverse());
      const aByeSymbol = Object.fromEntries(
        a.stockScores.map((s) => [s.symbol, s.score])
      );
      const reversedBySymbol = Object.fromEntries(
        reversed.stockScores.map((s) => [s.symbol, s.score])
      );
      assert.deepEqual(aByeSymbol, reversedBySymbol);
    });
  });

  describe("structural invariants", () => {
    it("returns one stockScores entry per input stock", () => {
      const out = computeComparisonScores(SAMPLE_STOCKS);
      assert.equal(out.stockScores.length, SAMPLE_STOCKS.length);
      assert.equal(out.perStockBreakdown.length, SAMPLE_STOCKS.length);
    });

    it("per-stock total equals sum of the 7 criterion scores", () => {
      const out = computeComparisonScores(SAMPLE_STOCKS);
      for (const stock of out.perStockBreakdown) {
        const sum = stock.criteria.reduce((acc, c) => acc + c.score, 0);
        assert.equal(
          stock.totalScore,
          sum,
          `${stock.symbol}: totalScore ${stock.totalScore} != sum ${sum}`
        );
      }
    });

    it("each criterion uses the standard maxScore", () => {
      const expected: Record<string, number> = {
        Valuation: 20,
        Profitability: 20,
        Growth: 15,
        "Balance Sheet": 15,
        "Earnings Quality": 10,
        "Momentum & Technicals": 10,
        "Ownership & Governance": 10,
      };
      const out = computeComparisonScores(SAMPLE_STOCKS);
      for (const stock of out.perStockBreakdown) {
        for (const c of stock.criteria) {
          assert.equal(
            c.maxScore,
            expected[c.criterion],
            `${stock.symbol}/${c.criterion}: maxScore ${c.maxScore} != ${expected[c.criterion]}`
          );
        }
      }
    });

    it("totals do not exceed 100 or go below 0", () => {
      const out = computeComparisonScores(SAMPLE_STOCKS);
      for (const s of out.stockScores) {
        assert.ok(s.score >= 0 && s.score <= 100, `${s.symbol}: ${s.score}`);
      }
    });
  });

  describe("scoring sanity", () => {
    it("ranks ACC highest on valuation (lowest PE 11.9x)", () => {
      const out = computeComparisonScores(SAMPLE_STOCKS);
      const vals = out.perStockBreakdown.map((s) => ({
        symbol: s.symbol,
        v: s.criteria.find((c) => c.criterion === "Valuation")!.score,
      }));
      const acc = vals.find((x) => x.symbol === "ACC")!;
      const abb = vals.find((x) => x.symbol === "ABB")!;
      const adani = vals.find((x) => x.symbol === "ADANIENT")!;
      assert.ok(
        acc.v > abb.v,
        `ACC valuation (${acc.v}) should beat ABB (${abb.v})`
      );
      assert.ok(
        acc.v > adani.v,
        `ACC valuation (${acc.v}) should beat ADANIENT (${adani.v})`
      );
    });

    it("ranks ABB highest on balance sheet (D/E 0.05)", () => {
      const out = computeComparisonScores(SAMPLE_STOCKS);
      const bs = out.perStockBreakdown.map((s) => ({
        symbol: s.symbol,
        v: s.criteria.find((c) => c.criterion === "Balance Sheet")!.score,
      }));
      const abb = bs.find((x) => x.symbol === "ABB")!;
      const adani = bs.find((x) => x.symbol === "ADANIENT")!;
      assert.ok(
        abb.v > adani.v,
        `ABB BS (${abb.v}) should beat ADANIENT (${adani.v})`
      );
    });

    it("ranks ADANIENT lowest on earnings quality (high accrual + low CF/NI)", () => {
      const out = computeComparisonScores(SAMPLE_STOCKS);
      const eq = out.perStockBreakdown.map((s) => ({
        symbol: s.symbol,
        v: s.criteria.find((c) => c.criterion === "Earnings Quality")!.score,
      }));
      const adani = eq.find((x) => x.symbol === "ADANIENT")!;
      const abb = eq.find((x) => x.symbol === "ABB")!;
      assert.ok(
        adani.v < abb.v,
        `ADANIENT EQ (${adani.v}) should be lower than ABB (${abb.v})`
      );
    });
  });

  describe("graceful degradation", () => {
    it("handles stocks with missing metrics (defaults to mid-range)", () => {
      const sparse: ComparisonStockMetrics[] = [
        { symbol: "A", pe: 15 },
        { symbol: "B", pe: 25 },
      ];
      const out = computeComparisonScores(sparse);
      assert.equal(out.stockScores.length, 2);
      for (const s of out.stockScores) {
        assert.ok(s.score >= 0 && s.score <= 100);
      }
    });

    it("handles empty stock list (returns empty result)", () => {
      const out = computeComparisonScores([]);
      assert.equal(out.stockScores.length, 0);
      assert.equal(out.perStockBreakdown.length, 0);
    });
  });

  describe("comments are observational (SEBI-clean)", () => {
    it("does not emit BUY / SELL / HOLD / preferred / recommendation tokens", () => {
      const out = computeComparisonScores(SAMPLE_STOCKS);
      for (const stock of out.perStockBreakdown) {
        for (const c of stock.criteria) {
          assert.ok(
            !/\b(buy|sell|hold|strong_buy|strong_sell|avoid|preferred|recommendation|upside|downside|target price)\b/i.test(
              c.comment
            ),
            `${stock.symbol}/${c.criterion} leaked: "${c.comment}"`
          );
        }
      }
    });
  });
});

describe("computeComparisonScoresTool — registered ResearchToolDef", () => {
  // MONEY-1274 (MONEY-1155 #30) — CHANGED from `success: false`. One stock is
  // a thin INPUT, not a failed computation: success:false marks the executor
  // task FAILED and the synthesiser reports it as the analysis engine breaking.
  // Contract is now `success: true` + `available: false` + a reason.
  // See packages/research/src/tools/insufficient-input.ts.
  it("reports UNAVAILABLE with fewer than 2 stocks", async () => {
    const result = await computeComparisonScoresTool.execute({
      stocks: [{ symbol: "A", pe: 15 }],
    });
    assert.equal(result.success, true, "one stock is not a tool failure");
    const d = result.data as Record<string, unknown>;
    assert.equal(d.available, false);
    assert.match(String(d.reason), /at least 2 stocks/i);
  });

  it("[regression] a MISSING stocks array is a caller error, not thin data", async () => {
    // CHANGED by the MONEY-1274 review. This asserted `success: true` +
    // `available: false`, i.e. the same answer as "you gave me one stock" — so
    // a planner that omitted the argument entirely was told the MARKET was
    // thin. It would then accept that as a fact or retry the same malformed
    // call. Absent-or-wrong-type is the CALLER's mistake and must fail the task.
    const result = await computeComparisonScoresTool.execute({
      stocks: undefined,
    });
    assert.equal(result.success, false, "a malformed call must fail the task");
    assert.match(String(result.error), /required/i);
  });

  it("one stock IS thin data — still reported as unavailable", async () => {
    // The other half of the split: the argument arrived in the right shape and
    // simply held too little. That is the case insufficientInput exists for.
    const result = await computeComparisonScoresTool.execute({
      stocks: [{ symbol: "A", pe: 15 }],
    });
    assert.equal(result.success, true);
    const d = result.data as Record<string, unknown>;
    assert.equal(d.available, false);
    assert.equal(d.got, 1, "the shortfall is reported, not just the gap");
  });

  it("returns success on valid input", async () => {
    const result = await computeComparisonScoresTool.execute({
      stocks: SAMPLE_STOCKS,
    });
    assert.equal(result.success, true);
    const data = result.data as {
      stockScores: Array<{ symbol: string; score: number }>;
    };
    assert.equal(data.stockScores.length, SAMPLE_STOCKS.length);
  });
});
