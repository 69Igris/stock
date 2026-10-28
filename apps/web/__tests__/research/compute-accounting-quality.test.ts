/**
 * Accounting Quality Tool Tests
 * (packages/research/src/tools/compute-accounting-quality.ts)
 *
 * De-shadowed (MONEY-620 / task 185): the previous version reimplemented a
 * SIMPLIFIED Beneish M-Score inline (GMI/AQI/DEPI collapsed to constants)
 * and asserted that copy. The real, registered tool computes the full GMI,
 * AQI and DEPI indices, so exact M-Scores differ. This file now drives the
 * real `computeAccountingQualityTool.execute()` and asserts the actual
 * verdicts/flags/overall-quality contract, plus required-field validation
 * and the div-by-zero guards.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeAccountingQualityTool,
  type AccountingQualityResult,
} from "@usemoney/research/tools/compute-accounting-quality";

async function run(
  params: Record<string, unknown>
): Promise<AccountingQualityResult> {
  const out = await computeAccountingQualityTool.execute(params);
  assert.strictEqual(out.success, true, out.error);
  return out.data as AccountingQualityResult;
}

describe("Accounting Quality Tool (real)", () => {
  describe("Required-field validation", () => {
    it("rejects when revenue is missing", async () => {
      const out = await computeAccountingQualityTool.execute({
        prevRevenue: 100,
        netIncome: 10,
        totalAssets: 200,
      });
      assert.strictEqual(out.success, false);
      assert.match(out.error ?? "", /required/);
    });

    it("accepts netIncome === 0 (only nullish is rejected)", async () => {
      // Guard is `netIncome == null`, so a literal 0 must pass.
      const r = await run({
        revenue: 100,
        prevRevenue: 100,
        netIncome: 0,
        totalAssets: 200,
      });
      assert.ok(["good", "warning", "red_flag"].includes(r.overallQuality));
    });
  });

  describe("Altman Z-Score", () => {
    it("should detect distress zone (Z < 1.81)", async () => {
      const r = await run({
        revenue: 100,
        prevRevenue: 100,
        netIncome: -50,
        totalAssets: 200,
        currentAssets: 30,
        currentLiabilities: 150,
        totalLiabilities: 180,
        retainedEarnings: -100,
        operatingIncome: -50,
        marketCap: 50,
      });
      assert.strictEqual(r.zScoreVerdict, "distress");
    });

    it("should detect safe zone for healthy company", async () => {
      const r = await run({
        revenue: 1000,
        prevRevenue: 900,
        netIncome: 100,
        totalAssets: 500,
        currentAssets: 300,
        currentLiabilities: 100,
        totalLiabilities: 200,
        retainedEarnings: 200,
        operatingIncome: 150,
        marketCap: 2000,
      });
      assert.strictEqual(r.zScoreVerdict, "safe");
    });
  });

  describe("Red flags", () => {
    it("should flag receivables growing faster than revenue", async () => {
      const r = await run({
        revenue: 1100,
        prevRevenue: 1000,
        netIncome: 100,
        totalAssets: 500,
        receivables: 200,
        prevReceivables: 100,
        marketCap: 2000,
        currentAssets: 300,
        currentLiabilities: 100,
        totalLiabilities: 200,
        retainedEarnings: 200,
        operatingIncome: 150,
      });
      assert.ok(r.flags.some((f) => f.includes("Receivables")));
    });

    it("should flag inventory buildup", async () => {
      const r = await run({
        revenue: 1050,
        prevRevenue: 1000,
        netIncome: 100,
        totalAssets: 500,
        inventory: 200,
        prevInventory: 100,
        marketCap: 2000,
        currentAssets: 300,
        currentLiabilities: 100,
        totalLiabilities: 200,
        retainedEarnings: 200,
        operatingIncome: 150,
      });
      assert.ok(r.flags.some((f) => f.includes("Inventory")));
    });

    it("should not be red_flag for a healthy company", async () => {
      const r = await run({
        revenue: 1100,
        prevRevenue: 1000,
        netIncome: 100,
        totalAssets: 500,
        receivables: 110,
        prevReceivables: 100,
        inventory: 55,
        prevInventory: 50,
        operatingCashFlow: 120,
        marketCap: 2000,
        currentAssets: 300,
        currentLiabilities: 100,
        totalLiabilities: 200,
        retainedEarnings: 200,
        operatingIncome: 150,
      });
      assert.notStrictEqual(r.overallQuality, "red_flag");
    });
  });

  describe("Overall quality", () => {
    it("should be red_flag when Z-Score is distress", async () => {
      const r = await run({
        revenue: 100,
        prevRevenue: 100,
        netIncome: -50,
        totalAssets: 200,
        currentAssets: 30,
        currentLiabilities: 150,
        totalLiabilities: 180,
        retainedEarnings: -100,
        operatingIncome: -50,
        marketCap: 50,
      });
      assert.strictEqual(r.overallQuality, "red_flag");
    });
  });

  describe("Numeric outputs are finite (div-by-zero guards)", () => {
    it("returns finite mScore/zScore even with sparse inputs", async () => {
      // Only the 4 required fields; everything else defaults. The many
      // `x > 0 ? ... : 1/0` guards must keep both scores finite.
      const r = await run({
        revenue: 500,
        prevRevenue: 400,
        netIncome: 20,
        totalAssets: 1000,
      });
      assert.ok(Number.isFinite(r.mScore), `mScore not finite: ${r.mScore}`);
      assert.ok(Number.isFinite(r.zScore), `zScore not finite: ${r.zScore}`);
    });

    it("survives prevReceivables defaulting from receivables (no NaN)", async () => {
      // receivables given, prevReceivables omitted → defaults to receivables,
      // so receivables/prevReceivables ratio is 1 (no 0/0).
      const r = await run({
        revenue: 600,
        prevRevenue: 500,
        netIncome: 30,
        totalAssets: 800,
        receivables: 120,
      });
      assert.ok(Number.isFinite(r.mScore));
      assert.ok(Number.isFinite(r.zScore));
    });
  });
});
