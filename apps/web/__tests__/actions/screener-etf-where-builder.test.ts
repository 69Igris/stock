/**
 * Screener ETF - Mongo WHERE-clause builder tests (MONEY-196).
 *
 * Source: apps/web/lib/screener/match-score.ts → `buildEtfScreenWhere`.
 *
 * Where the MF builder is single-table (MutualFundMaster), the ETF
 * builder only handles fields native to InstrumentMapping:
 *   - exchange (equality)
 *   - isActive: true (always)
 *   - instrumentType: in [ETF, REIT, INVIT] (the funds surface — MONEY-1085)
 *   - search OR over symbol (startsWith) + name (contains)
 *
 * AUM, returns 1Y, expense ratio, asset class are MF-master-side and
 * filtered post-fetch in the action body - they don't appear here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildEtfScreenWhere } from "@/lib/screener/match-score";

describe("buildEtfScreenWhere", () => {
  it("returns base ETF predicate when no filters and no query", () => {
    // MONEY-1263 — the base predicate now pins an India VENUE SCOPE. It
    // previously carried no `exchange` key, which was correct while every row
    // in `instrument_mappings` was Indian. The US master writes ~7,600 active
    // ETFs against India's ~541, so an unscoped predicate returns US funds in
    // the majority — no error, just a screener about a different country.
    const where = buildEtfScreenWhere({});
    assert.deepStrictEqual(where, {
      isActive: true,
      exchange: { in: ["NSE", "BSE"] },
      instrumentType: { in: ["ETF", "REIT", "INVIT"] },
    });
  });

  it("locks the funds instrumentType set even with other filters present", () => {
    const where = buildEtfScreenWhere({ exchange: "NSE" });
    assert.deepEqual(where.instrumentType, { in: ["ETF", "REIT", "INVIT"] });
    assert.strictEqual(where.isActive, true);
  });

  describe("Exchange filter", () => {
    it("applies exchange=NSE", () => {
      const where = buildEtfScreenWhere({ exchange: "NSE" });
      assert.strictEqual(where.exchange, "NSE");
    });

    it("applies exchange=BSE", () => {
      const where = buildEtfScreenWhere({ exchange: "BSE" });
      assert.strictEqual(where.exchange, "BSE");
    });

    it("absent exchange falls back to the India venue scope, not to unscoped", () => {
      // MONEY-1263 — this asserted `undefined`, i.e. "match every venue". That
      // is the exact shape that lets US rows through, so the fallback is now a
      // floor rather than an absence. A caller-supplied exchange still wins,
      // which the two cases above assert.
      const where = buildEtfScreenWhere({});
      assert.deepStrictEqual(where.exchange, { in: ["NSE", "BSE"] });
    });
  });

  describe("Search query", () => {
    it("trimmed query becomes OR of symbol(startsWith) + name(contains)", () => {
      const where = buildEtfScreenWhere({}, "  niftybees  ");
      assert.deepStrictEqual(where.OR, [
        { symbol: { startsWith: "NIFTYBEES" } },
        { name: { contains: "niftybees", mode: "insensitive" } },
      ]);
    });

    it("uppercases symbol but leaves name preserved (mongo case-insensitive)", () => {
      const where = buildEtfScreenWhere({}, "GoldBees");
      assert.deepStrictEqual(where.OR, [
        { symbol: { startsWith: "GOLDBEES" } },
        { name: { contains: "GoldBees", mode: "insensitive" } },
      ]);
    });

    it("empty / whitespace-only query is a no-op", () => {
      assert.strictEqual(buildEtfScreenWhere({}, "").OR, undefined);
      assert.strictEqual(buildEtfScreenWhere({}, "   ").OR, undefined);
      assert.strictEqual(buildEtfScreenWhere({}).OR, undefined);
    });
  });

  describe("Filters NOT propagated to where (MF-master-side)", () => {
    it("AUM / returns / expense / assetClass / theme do not appear", () => {
      const where = buildEtfScreenWhere({
        exchange: "NSE",
        assetClass: "equity",
        theme: "Nifty",
        minAum: 100,
        maxAum: 5000,
        minReturns1Y: 10,
        maxReturns1Y: 30,
        minExpenseRatio: 0.05,
        maxExpenseRatio: 0.5,
      });
      // MF-side filters are stripped - they apply post-fetch in the
      // action's merge loop, not in the InstrumentMapping query.
      assert.strictEqual(where.assetClass, undefined);
      assert.strictEqual(where.theme, undefined);
      assert.strictEqual(where.aum, undefined);
      assert.strictEqual(where.returns1Y, undefined);
      assert.strictEqual(where.expenseRatio, undefined);
      // Native fields stay
      assert.strictEqual(where.exchange, "NSE");
      assert.deepEqual(where.instrumentType, { in: ["ETF", "REIT", "INVIT"] });
      assert.strictEqual(where.isActive, true);
    });
  });

  describe("Composite", () => {
    it("exchange + query stack alongside instrumentType + isActive", () => {
      const where = buildEtfScreenWhere({ exchange: "NSE" }, "BANK");
      const keys = Object.keys(where).sort();
      assert.deepStrictEqual(keys, [
        "OR",
        "exchange",
        "instrumentType",
        "isActive",
      ]);
      assert.strictEqual(where.exchange, "NSE");
      assert.deepEqual(where.instrumentType, { in: ["ETF", "REIT", "INVIT"] });
      assert.strictEqual(where.isActive, true);
    });
  });
});
