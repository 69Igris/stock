/**
 * Staleness Configuration Tests
 *
 * Exercises the REAL staleness config + helper exported from
 * packages/core/src/market-data/staleness.ts (via
 * `@usemoney/core/market-data/staleness`): `STALENESS` and `isStale` (`SYNC_TIERS` was deleted by MONEY-1238 — it was a dead second tiering table contradicting `sync-tiers.ts`).
 * No inline reimplementation.
 *
 * Divergence the old shadow hid: its inline `STALENESS` had only 7 keys and
 * asserted `Object.keys === 7`. The REAL table has 11 (it also tracks the
 * stock-document doc-types: stock_documents, stock_docs_financial,
 * stock_docs_quarterly, stock_docs_annual). Counts + longest/shortest checks
 * below pin the real 11-key table.
 *
 * Edge-case the shadow never touched: `isStale` does `Date.now() -
 * fetchedAt.getTime()`. For an Invalid Date, `getTime()` is NaN, so the
 * comparison `NaN > maxAgeMs` is false — i.e. an Invalid Date is reported as
 * FRESH (not stale). That real (slightly surprising) behaviour is pinned below.
 *
 * Source: packages/core/src/market-data/staleness.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { STALENESS, isStale } from "@usemoney/core/market-data/staleness";

// ── Helper constants ────────────────────────────────────────────

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

// ── Tests ────────────────────────────────────────────────────────

describe("Staleness Configuration (real @usemoney/core exports)", () => {
  describe("STALENESS config", () => {
    it("should have all expected data type keys", () => {
      const expected = [
        "financials_annual",
        "financials_quarterly",
        "ratios",
        "peers",
        "shareholding",
        "news",
        "profile",
        "stock_documents",
        "stock_docs_financial",
        "stock_docs_quarterly",
        "stock_docs_annual",
      ];
      for (const key of expected) {
        assert.ok(STALENESS[key], `Missing key: ${key}`);
      }
    });

    it("should have exactly 11 staleness keys", () => {
      assert.strictEqual(Object.keys(STALENESS).length, 11);
    });

    it("should track the stock-document doc-types the shadow omitted", () => {
      assert.strictEqual(
        STALENESS["stock_docs_financial"]!.maxAgeMs,
        7 * MS_PER_DAY
      );
      assert.strictEqual(
        STALENESS["stock_docs_quarterly"]!.maxAgeMs,
        30 * MS_PER_DAY
      );
      assert.strictEqual(
        STALENESS["stock_docs_annual"]!.maxAgeMs,
        90 * MS_PER_DAY
      );
      assert.strictEqual(
        STALENESS["stock_documents"]!.maxAgeMs,
        30 * MS_PER_DAY
      );
    });

    it("should have maxAgeMs and label for every entry", () => {
      for (const [key, config] of Object.entries(STALENESS)) {
        assert.ok(
          typeof config.maxAgeMs === "number",
          `${key}: maxAgeMs should be a number`
        );
        assert.ok(config.maxAgeMs > 0, `${key}: maxAgeMs should be positive`);
        assert.ok(
          typeof config.label === "string",
          `${key}: label should be a string`
        );
        assert.ok(config.label.length > 0, `${key}: label should not be empty`);
      }
    });

    it("news should have 30 minute threshold", () => {
      assert.strictEqual(STALENESS.news!.maxAgeMs, 30 * MS_PER_MINUTE);
    });

    it("ratios should have 24 hour threshold", () => {
      assert.strictEqual(STALENESS.ratios!.maxAgeMs, 24 * MS_PER_HOUR);
    });

    it("annual financials should have 90 day threshold", () => {
      assert.strictEqual(
        STALENESS.financials_annual!.maxAgeMs,
        90 * MS_PER_DAY
      );
    });

    it("quarterly financials should have 30 day threshold", () => {
      assert.strictEqual(
        STALENESS.financials_quarterly!.maxAgeMs,
        30 * MS_PER_DAY
      );
    });

    it("peers should have 30 day threshold", () => {
      assert.strictEqual(STALENESS.peers!.maxAgeMs, 30 * MS_PER_DAY);
    });

    it("shareholding should have 30 day threshold", () => {
      assert.strictEqual(STALENESS.shareholding!.maxAgeMs, 30 * MS_PER_DAY);
    });

    it("profile should have 90 day threshold", () => {
      assert.strictEqual(STALENESS.profile!.maxAgeMs, 90 * MS_PER_DAY);
    });

    it("news should be the shortest threshold", () => {
      const newsTTL = STALENESS.news!.maxAgeMs;
      for (const [key, config] of Object.entries(STALENESS)) {
        if (key !== "news") {
          assert.ok(
            config.maxAgeMs >= newsTTL,
            `${key} should be >= news threshold`
          );
        }
      }
    });

    it("annual financials, profile and stock_docs_annual should be the longest-lived (90d)", () => {
      const annualMs = STALENESS.financials_annual!.maxAgeMs;
      assert.strictEqual(STALENESS.profile!.maxAgeMs, annualMs);
      assert.strictEqual(STALENESS["stock_docs_annual"]!.maxAgeMs, annualMs);
      for (const config of Object.values(STALENESS)) {
        assert.ok(config.maxAgeMs <= annualMs);
      }
    });
  });

  describe("isStale", () => {
    it("should return true for null fetchedAt", () => {
      assert.strictEqual(isStale(null, "ratios"), true);
    });

    it("should return true for undefined fetchedAt", () => {
      assert.strictEqual(isStale(undefined, "ratios"), true);
    });

    it("should return true for unknown threshold key", () => {
      assert.strictEqual(isStale(new Date(), "nonexistent_key"), true);
    });

    it("should report an Invalid Date as FRESH (NaN comparison) — documents real behaviour", () => {
      // getTime() on an Invalid Date is NaN; `NaN > maxAgeMs` is false, so the
      // real isStale returns false (treats it as not-stale). Pinned so any
      // future change to invalid-date handling is a deliberate, visible choice.
      assert.strictEqual(isStale(new Date("not-a-real-date"), "ratios"), false);
      assert.strictEqual(isStale(new Date(NaN), "news"), false);
    });

    it("should return false for recently fetched data (ratios)", () => {
      const oneHourAgo = new Date(Date.now() - 1 * MS_PER_HOUR);
      assert.strictEqual(isStale(oneHourAgo, "ratios"), false);
    });

    it("should return true for stale ratios (>24h)", () => {
      const twoDaysAgo = new Date(Date.now() - 2 * MS_PER_DAY);
      assert.strictEqual(isStale(twoDaysAgo, "ratios"), true);
    });

    it("should return false for recent news (<30min)", () => {
      const tenMinAgo = new Date(Date.now() - 10 * MS_PER_MINUTE);
      assert.strictEqual(isStale(tenMinAgo, "news"), false);
    });

    it("should return true for stale news (>30min)", () => {
      const oneHourAgo = new Date(Date.now() - MS_PER_HOUR);
      assert.strictEqual(isStale(oneHourAgo, "news"), true);
    });

    it("should return false for recent annual financials (<90d)", () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY);
      assert.strictEqual(isStale(thirtyDaysAgo, "financials_annual"), false);
    });

    it("should return true for stale annual financials (>90d)", () => {
      const hundredDaysAgo = new Date(Date.now() - 100 * MS_PER_DAY);
      assert.strictEqual(isStale(hundredDaysAgo, "financials_annual"), true);
    });

    it("should handle exact boundary correctly (stale at exact threshold)", () => {
      const exactThreshold = new Date(
        Date.now() - STALENESS.ratios!.maxAgeMs - 1
      );
      assert.strictEqual(isStale(exactThreshold, "ratios"), true);
    });

    it("should return false for data just within news threshold (29 min)", () => {
      const justWithin = new Date(Date.now() - 29 * MS_PER_MINUTE);
      assert.strictEqual(isStale(justWithin, "news"), false);
    });

    it("should return true for data just beyond news threshold (31 min)", () => {
      const justBeyond = new Date(Date.now() - 31 * MS_PER_MINUTE);
      assert.strictEqual(isStale(justBeyond, "news"), true);
    });

    it("should handle Date.now() as fetchedAt (just fetched)", () => {
      const now = new Date();
      assert.strictEqual(isStale(now, "news"), false);
      assert.strictEqual(isStale(now, "ratios"), false);
      assert.strictEqual(isStale(now, "financials_annual"), false);
    });

    it("should handle very old date (epoch)", () => {
      const epoch = new Date(0);
      assert.strictEqual(isStale(epoch, "news"), true);
      assert.strictEqual(isStale(epoch, "ratios"), true);
      assert.strictEqual(isStale(epoch, "financials_annual"), true);
    });

    it("should return true for null fetchedAt with every threshold key", () => {
      for (const key of Object.keys(STALENESS)) {
        assert.strictEqual(
          isStale(null, key),
          true,
          `null should be stale for ${key}`
        );
      }
    });

    it("should return false for just-fetched data with every threshold key", () => {
      const now = new Date();
      for (const key of Object.keys(STALENESS)) {
        assert.strictEqual(
          isStale(now, key),
          false,
          `just-fetched should not be stale for ${key}`
        );
      }
    });
  });
});
