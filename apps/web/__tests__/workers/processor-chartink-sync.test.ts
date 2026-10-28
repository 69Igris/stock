/**
 * Workers - Processor: Chartink Strategy Sync Tests — DE-SHADOWED.
 *
 * Previously this file re-declared an inline `CHARTINK_CATEGORIES` copy and the
 * `data.categories || CHARTINK_CATEGORIES.map(...)` default inline, then asserted
 * the copies — a shadow (the real `CHARTINK_CATEGORIES` was a module-private
 * const). The source now EXPORTS `CHARTINK_CATEGORIES`, `DEFAULT_CHARTINK_DELAY_MS`
 * and `resolveChartinkCategoryIds` (which `processChartinkStrategySync` CALLS),
 * and this test asserts those REAL exports.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// REAL worker source under test (no shadow).
import {
  CHARTINK_CATEGORIES,
  DEFAULT_CHARTINK_DELAY_MS,
  resolveChartinkCategoryIds,
} from "../../../../workers/src/processors/chartink-strategy-sync";

describe("Workers - Processor: Chartink Strategy Sync", () => {
  describe("CHARTINK_CATEGORIES (real export)", () => {
    it("has 9 categories", () => {
      assert.strictEqual(CHARTINK_CATEGORIES.length, 9);
    });

    it("each category has id, name, and a chartink.com url", () => {
      for (const cat of CHARTINK_CATEGORIES) {
        assert.ok(cat.id.length > 0);
        assert.ok(cat.name.length > 0);
        assert.ok(cat.url.startsWith("https://chartink.com/"));
      }
    });

    it("has no duplicate IDs", () => {
      const ids = CHARTINK_CATEGORIES.map((c) => c.id);
      assert.strictEqual(new Set(ids).size, ids.length);
    });

    it("includes bullish, bearish, volume, fundamental", () => {
      const ids = new Set(CHARTINK_CATEGORIES.map((c) => c.id));
      assert.ok(ids.has("bullish"));
      assert.ok(ids.has("bearish"));
      assert.ok(ids.has("volume"));
      assert.ok(ids.has("fundamental"));
    });
  });

  describe("resolveChartinkCategoryIds (real export)", () => {
    it("defaults to all 9 category ids when none requested", () => {
      const ids = resolveChartinkCategoryIds(undefined);
      assert.strictEqual(ids.length, 9);
      assert.deepStrictEqual(
        ids,
        CHARTINK_CATEGORIES.map((c) => c.id)
      );
    });

    it("falls back to all ids for an empty array (real || semantics)", () => {
      // The live processor uses `data.categories || ...`; an empty array is
      // falsy-equivalent here (length 0) and falls through to all categories.
      assert.strictEqual(resolveChartinkCategoryIds([]).length, 9);
    });

    it("returns the requested ids when provided", () => {
      assert.deepStrictEqual(
        resolveChartinkCategoryIds(["bullish", "bearish"]),
        ["bullish", "bearish"]
      );
    });
  });

  describe("DEFAULT_CHARTINK_DELAY_MS (real export)", () => {
    it("is 2000", () => {
      assert.strictEqual(DEFAULT_CHARTINK_DELAY_MS, 2000);
    });
  });

  describe("Category filtering against the real list", () => {
    it("filters to the selected categories only", () => {
      const selected = ["rsi", "macd"];
      const toProcess = CHARTINK_CATEGORIES.filter((c) =>
        selected.includes(c.id)
      );
      assert.strictEqual(toProcess.length, 2);
    });

    it("a non-matching filter selects none", () => {
      const toProcess = CHARTINK_CATEGORIES.filter((c) =>
        (["does-not-exist"] as string[]).includes(c.id)
      );
      assert.strictEqual(toProcess.length, 0);
    });
  });
});
