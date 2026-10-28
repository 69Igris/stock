/**
 * Screener Match Score - MF + ETF helpers (MONEY-196 finish).
 *
 * Source: apps/web/lib/screener/match-score.ts
 *   - computeMfMatchScore (MutualFundMaster screener)
 *   - computeEtfMatchScore (ETF screener - InstrumentMapping ⨝ MFMaster)
 *
 * Same invariants as `computeMatchScore` for stocks:
 *   - 0-100 integer score
 *   - 100 when no filter is active (everything matches)
 *   - per-filter scores in [0,1] averaged into the composite
 *   - missing values are excluded from the mean (no penalty for null data)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeMfMatchScore,
  computeEtfMatchScore,
  type MfScreenFilters,
  type EtfScreenFilters,
} from "@/lib/screener/match-score";

// ── Test fixtures ──────────────────────────────────────────────────

const MF_BASE = {
  category: "Large Cap",
  amcName: "SBI",
  plan: "DIRECT",
  riskLevel: "High",
  fundType: "equity",
  aum: 5000,
  returns1Y: 18.5,
  returns3Y: 14.2,
  returns5Y: 12.6,
  expenseRatio: 0.5,
};

const ETF_BASE = {
  exchange: "NSE",
  assetClass: "equity",
  name: "Nippon ETF Nifty 50 BeES",
  aum: 12500,
  returns1Y: 14.2,
  expenseRatio: 0.05,
};

// ══════════════════════ MF tests ═══════════════════════════════════

describe("computeMfMatchScore", () => {
  it("returns 100 when no filter is active (empty rule = match-all)", () => {
    assert.strictEqual(computeMfMatchScore(MF_BASE, {}), 100);
  });

  describe("Categorical filters", () => {
    it("scores 100 on exact category match", () => {
      const filters: MfScreenFilters = { category: "Large Cap" };
      assert.strictEqual(computeMfMatchScore(MF_BASE, filters), 100);
    });

    it("scores 0 on category mismatch", () => {
      const filters: MfScreenFilters = { category: "Mid Cap" };
      assert.strictEqual(computeMfMatchScore(MF_BASE, filters), 0);
    });

    it("scores 100 when amcAny includes the row's amcName", () => {
      const filters: MfScreenFilters = { amcAny: ["SBI", "HDFC", "Axis"] };
      assert.strictEqual(computeMfMatchScore(MF_BASE, filters), 100);
    });

    it("scores 0 when amcAny excludes the row's amcName", () => {
      const filters: MfScreenFilters = { amcAny: ["HDFC", "ICICI"] };
      assert.strictEqual(computeMfMatchScore(MF_BASE, filters), 0);
    });

    it("amcAny takes precedence over amcName when both set", () => {
      const filters: MfScreenFilters = {
        amcName: "ICICI",
        amcAny: ["SBI"],
      };
      assert.strictEqual(computeMfMatchScore(MF_BASE, filters), 100);
    });

    it("matches plan + riskLevel + fundType together", () => {
      const filters: MfScreenFilters = {
        plan: "DIRECT",
        riskLevel: "High",
        fundType: "equity",
      };
      assert.strictEqual(computeMfMatchScore(MF_BASE, filters), 100);
    });
  });

  describe("Numeric filters", () => {
    it("scores 100 inside an AUM band exactly at midpoint", () => {
      const filters: MfScreenFilters = { minAum: 4000, maxAum: 6000 };
      // Midpoint = 5000, halfWidth = 1000 → distance 0 → 1.0
      assert.strictEqual(computeMfMatchScore(MF_BASE, filters), 100);
    });

    it("scores 0 when AUM falls below the floor", () => {
      const filters: MfScreenFilters = { minAum: 10_000 };
      assert.strictEqual(computeMfMatchScore(MF_BASE, filters), 0);
    });

    it("scores 100 for returns1Y above the floor (open-ended)", () => {
      const filters: MfScreenFilters = { minReturns1Y: 12 };
      assert.strictEqual(computeMfMatchScore(MF_BASE, filters), 100);
    });

    it("scores 0 for expenseRatio above the cap", () => {
      const filters: MfScreenFilters = { maxExpenseRatio: 0.3 };
      assert.strictEqual(computeMfMatchScore(MF_BASE, filters), 0);
    });
  });

  describe("Composite + null handling", () => {
    it("averages multiple filter scores into the composite", () => {
      // category passes (1.0), aum passes inside band (1.0), but
      // returns1Y < min (0). Mean = (1+1+0)/3 = 0.667 → 67.
      const filters: MfScreenFilters = {
        category: "Large Cap",
        minAum: 4000,
        maxAum: 6000,
        minReturns1Y: 25,
      };
      assert.strictEqual(computeMfMatchScore(MF_BASE, filters), 67);
    });

    it("excludes filters from the mean when row value is null", () => {
      // Row missing returns1Y → that filter doesn't count.
      const row = { ...MF_BASE, returns1Y: null };
      const filters: MfScreenFilters = {
        category: "Large Cap",
        minReturns1Y: 25, // would have been a 0
      };
      // Only category counts → 1.0 → 100.
      assert.strictEqual(computeMfMatchScore(row, filters), 100);
    });

    it("treats `null` value with categorical filter as no-data", () => {
      const row = { ...MF_BASE, riskLevel: null };
      const filters: MfScreenFilters = { riskLevel: "High" };
      // riskLevel filter excluded → composite = 100.
      assert.strictEqual(computeMfMatchScore(row, filters), 100);
    });
  });
});

// ══════════════════════ ETF tests ══════════════════════════════════

describe("computeEtfMatchScore", () => {
  it("returns 100 when no filter is active", () => {
    assert.strictEqual(computeEtfMatchScore(ETF_BASE, {}), 100);
  });

  describe("Exchange + asset class", () => {
    it("scores 100 on exchange match", () => {
      const filters: EtfScreenFilters = { exchange: "NSE" };
      assert.strictEqual(computeEtfMatchScore(ETF_BASE, filters), 100);
    });

    it("scores 0 on exchange mismatch", () => {
      const filters: EtfScreenFilters = { exchange: "BSE" };
      assert.strictEqual(computeEtfMatchScore(ETF_BASE, filters), 0);
    });

    it("scores 100 on asset class match", () => {
      const filters: EtfScreenFilters = { assetClass: "equity" };
      assert.strictEqual(computeEtfMatchScore(ETF_BASE, filters), 100);
    });
  });

  describe("Theme substring matching", () => {
    it("scores 100 when theme appears in ETF name (case-insensitive)", () => {
      const filters: EtfScreenFilters = { theme: "nifty" };
      assert.strictEqual(computeEtfMatchScore(ETF_BASE, filters), 100);
    });

    it("scores 100 for partial token like 'BeES'", () => {
      const filters: EtfScreenFilters = { theme: "BeES" };
      assert.strictEqual(computeEtfMatchScore(ETF_BASE, filters), 100);
    });

    it("scores 0 when theme is not found in name", () => {
      const filters: EtfScreenFilters = { theme: "gold" };
      assert.strictEqual(computeEtfMatchScore(ETF_BASE, filters), 0);
    });

    it("ignores empty theme string entirely (no filter active)", () => {
      const filters: EtfScreenFilters = { theme: "" };
      assert.strictEqual(computeEtfMatchScore(ETF_BASE, filters), 100);
    });
  });

  describe("Numeric filters", () => {
    it("scores 100 for AUM above floor", () => {
      const filters: EtfScreenFilters = { minAum: 1000 };
      assert.strictEqual(computeEtfMatchScore(ETF_BASE, filters), 100);
    });

    it("scores 0 for expense ratio above cap", () => {
      const filters: EtfScreenFilters = { maxExpenseRatio: 0.02 };
      assert.strictEqual(computeEtfMatchScore(ETF_BASE, filters), 0);
    });

    it("composite averages: theme pass + AUM pass + 1Y miss", () => {
      // 3 filters: theme=Nifty (1), minAum=1000 (1), minReturns1Y=20 (0)
      // mean = 2/3 = 0.667 → 67
      const filters: EtfScreenFilters = {
        theme: "Nifty",
        minAum: 1000,
        minReturns1Y: 20,
      };
      assert.strictEqual(computeEtfMatchScore(ETF_BASE, filters), 67);
    });
  });

  describe("Null handling", () => {
    it("ignores AUM filter when row.aum is null", () => {
      const row = { ...ETF_BASE, aum: null };
      const filters: EtfScreenFilters = { minAum: 50_000 };
      // Only filter active is AUM - null row value excludes it →
      // no scores → 100.
      assert.strictEqual(computeEtfMatchScore(row, filters), 100);
    });

    it("theme filter still applies even when other rows are null", () => {
      const row = { ...ETF_BASE, aum: null, returns1Y: null };
      const filters: EtfScreenFilters = { theme: "BeES" };
      assert.strictEqual(computeEtfMatchScore(row, filters), 100);
    });
  });
});
