/**
 * Screener MF - Mongo WHERE-clause builder tests (MONEY-196).
 *
 * Source: apps/web/lib/screener/match-score.ts → `buildMfScreenWhere`.
 *
 * The action calls this pure function then passes the result straight to
 * `prisma.mutualFundMaster.findMany`. Pinning the shape here means the
 * server action can be reasoned about without booting Prisma.
 *
 * Why categorical equality + numeric $gte/$lte split:
 *   - MongoDB indexes on MutualFundMaster cover category, amcName, plan,
 *     riskLevel, fundType (each indexed individually). Equality matches
 *     hit those indexes directly.
 *   - aum / returns / expenseRatio are scanned with range comparators.
 *   - Text search uses { contains, mode: "insensitive" } - Mongo does a
 *     regex scan; this is fine for ~14k funds.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildMfScreenWhere,
  type MfScreenFilters,
} from "@/lib/screener/match-score";

describe("buildMfScreenWhere", () => {
  it("default where carries isActive + navDate freshness gate", () => {
    const where = buildMfScreenWhere({});
    assert.strictEqual(where.isActive, true);
    // navDate gate is a 30-day rolling cutoff; assert shape, not value
    assert.ok(
      where.navDate &&
        typeof (where.navDate as { gte: Date }).gte === "object" &&
        (where.navDate as { gte: Date }).gte instanceof Date
    );
  });

  describe("Categorical filters", () => {
    it("category becomes equality match", () => {
      const where = buildMfScreenWhere({ category: "Large Cap" });
      assert.strictEqual(where.category, "Large Cap");
    });

    it("amcName becomes equality match when amcAny absent", () => {
      const where = buildMfScreenWhere({ amcName: "SBI" });
      assert.strictEqual(where.amcName, "SBI");
    });

    it("amcAny becomes Mongo `in` clause", () => {
      const where = buildMfScreenWhere({ amcAny: ["SBI", "HDFC", "Axis"] });
      assert.deepStrictEqual(where.amcName, { in: ["SBI", "HDFC", "Axis"] });
    });

    it("amcAny takes precedence over amcName when both set", () => {
      const where = buildMfScreenWhere({
        amcName: "ICICI",
        amcAny: ["SBI", "HDFC"],
      });
      assert.deepStrictEqual(where.amcName, { in: ["SBI", "HDFC"] });
    });

    it("empty amcAny array falls through to amcName equality", () => {
      const where = buildMfScreenWhere({
        amcAny: [],
        amcName: "ICICI",
      });
      assert.strictEqual(where.amcName, "ICICI");
    });

    it("plan + fundType become equality matches; riskLevel expands to bucket", () => {
      const where = buildMfScreenWhere({
        plan: "DIRECT",
        riskLevel: "High",
        fundType: "equity",
      });
      assert.strictEqual(where.plan, "DIRECT");
      // Risk picker's "High" bucket covers the SEBI 6-level scale's
      // top three rungs so any of those riskLevel values match.
      assert.deepStrictEqual(where.riskLevel, {
        in: ["Moderately High", "High", "Very High"],
      });
      assert.strictEqual(where.fundType, "equity");
    });

    it("riskLevel='Low' expands to Low + Low to Moderate", () => {
      const where = buildMfScreenWhere({ riskLevel: "Low" });
      assert.deepStrictEqual(where.riskLevel, {
        in: ["Low", "Low to Moderate"],
      });
    });

    it("riskLevel='Moderate' covers the middle of the SEBI scale", () => {
      const where = buildMfScreenWhere({ riskLevel: "Moderate" });
      assert.deepStrictEqual(where.riskLevel, {
        in: ["Low to Moderate", "Moderate", "Moderately High"],
      });
    });

    it("unrecognised riskLevel passes through verbatim (AI-built filters)", () => {
      const where = buildMfScreenWhere({ riskLevel: "Very High" });
      assert.strictEqual(where.riskLevel, "Very High");
    });
  });

  describe("Numeric ranges", () => {
    it("AUM band → $gte + $lte", () => {
      const where = buildMfScreenWhere({ minAum: 100, maxAum: 5000 });
      assert.deepStrictEqual(where.aum, { gte: 100, lte: 5000 });
    });

    it("AUM min-only → $gte without $lte", () => {
      const where = buildMfScreenWhere({ minAum: 1000 });
      assert.deepStrictEqual(where.aum, { gte: 1000 });
    });

    it("AUM max-only → $lte without $gte", () => {
      const where = buildMfScreenWhere({ maxAum: 5000 });
      assert.deepStrictEqual(where.aum, { lte: 5000 });
    });

    it("zero is a valid filter value (not coerced to undefined)", () => {
      const where = buildMfScreenWhere({ minReturns1Y: 0 });
      assert.deepStrictEqual(where.returns1Y, { gte: 0 });
    });

    it("returns 1Y / 3Y / 5Y stack into separate where keys", () => {
      const where = buildMfScreenWhere({
        minReturns1Y: 10,
        minReturns3Y: 12,
        minReturns5Y: 14,
      });
      assert.deepStrictEqual(where.returns1Y, { gte: 10 });
      assert.deepStrictEqual(where.returns3Y, { gte: 12 });
      assert.deepStrictEqual(where.returns5Y, { gte: 14 });
    });

    it("expense ratio band", () => {
      const where = buildMfScreenWhere({
        minExpenseRatio: 0.1,
        maxExpenseRatio: 0.5,
      });
      assert.deepStrictEqual(where.expenseRatio, { gte: 0.1, lte: 0.5 });
    });

    it("absent numeric filters do NOT add empty clauses", () => {
      const where = buildMfScreenWhere({});
      assert.strictEqual(where.aum, undefined);
      assert.strictEqual(where.returns1Y, undefined);
      assert.strictEqual(where.expenseRatio, undefined);
    });
  });

  describe("Text query (search)", () => {
    it("trimmed query becomes case-insensitive OR over schemeName/amcName", () => {
      const where = buildMfScreenWhere({}, "  SBI  ");
      assert.deepStrictEqual(where.OR, [
        { schemeName: { contains: "SBI", mode: "insensitive" } },
        { amcName: { contains: "SBI", mode: "insensitive" } },
      ]);
    });

    it("empty / whitespace-only query is a no-op", () => {
      assert.strictEqual(buildMfScreenWhere({}, "").OR, undefined);
      assert.strictEqual(buildMfScreenWhere({}, "   ").OR, undefined);
      assert.strictEqual(buildMfScreenWhere({}).OR, undefined);
    });

    it("query stacks alongside categorical + numeric filters", () => {
      const where = buildMfScreenWhere(
        {
          category: "Large Cap",
          plan: "DIRECT",
          minAum: 1000,
        },
        "Bluechip"
      );
      // categoricals
      assert.strictEqual(where.category, "Large Cap");
      assert.strictEqual(where.plan, "DIRECT");
      // numeric
      assert.deepStrictEqual(where.aum, { gte: 1000 });
      // search
      assert.ok(Array.isArray(where.OR));
      assert.strictEqual((where.OR as unknown[]).length, 2);
      // base
      assert.strictEqual(where.isActive, true);
    });
  });

  describe("Composite shape", () => {
    it("a fully-loaded filter produces every expected key", () => {
      const filters: MfScreenFilters = {
        category: "Mid Cap",
        amcAny: ["SBI", "HDFC"],
        plan: "DIRECT",
        riskLevel: "High",
        fundType: "equity",
        minAum: 500,
        maxAum: 50_000,
        minReturns1Y: 10,
        minReturns3Y: 12,
        minReturns5Y: 14,
        minExpenseRatio: 0.1,
        maxExpenseRatio: 1.0,
      };
      const where = buildMfScreenWhere(filters, "compounder");
      const keys = Object.keys(where).sort();
      assert.deepStrictEqual(keys, [
        "OR",
        "amcName",
        "aum",
        "category",
        "expenseRatio",
        "fundType",
        "isActive",
        "navDate",
        "plan",
        "returns1Y",
        "returns3Y",
        "returns5Y",
        "riskLevel",
      ]);
    });
  });
});
