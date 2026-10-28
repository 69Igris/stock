/**
 * Stock Sector Helper Tests
 *
 * Tests for the buildYahooSymbol helper used in the
 * getOrEnrichSectorAction server action.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Real helper used by getOrEnrichSectorAction (no inline copy).
import { buildYahooSymbol } from "@/lib/actions/stock-sector-logic";

// ── Tests ────────────────────────────────────────────────────────

describe("Stock Sector Helpers", () => {
  describe("buildYahooSymbol", () => {
    it("should append .NS for NSE exchange", () => {
      assert.strictEqual(buildYahooSymbol("RELIANCE", "NSE"), "RELIANCE.NS");
    });

    it("should append .BO for BSE exchange", () => {
      assert.strictEqual(buildYahooSymbol("RELIANCE", "BSE"), "RELIANCE.BO");
    });

    it("should handle lowercase nse", () => {
      assert.strictEqual(buildYahooSymbol("TCS", "nse"), "TCS.NS");
    });

    it("should handle lowercase bse", () => {
      assert.strictEqual(buildYahooSymbol("TCS", "bse"), "TCS.BO");
    });

    it("should handle mixed case BSe", () => {
      assert.strictEqual(buildYahooSymbol("INFY", "BSe"), "INFY.BO");
    });

    it("should default to .NS for unknown exchange", () => {
      assert.strictEqual(buildYahooSymbol("INFY", "MCX"), "INFY.NS");
    });

    it("should default to .NS for empty exchange", () => {
      assert.strictEqual(buildYahooSymbol("INFY", ""), "INFY.NS");
    });

    it("should handle symbols with hyphens", () => {
      assert.strictEqual(
        buildYahooSymbol("KESORAMIND-BE", "NSE"),
        "KESORAMIND-BE.NS"
      );
    });

    it("should handle symbols with ampersands", () => {
      assert.strictEqual(buildYahooSymbol("M&M", "NSE"), "M&M.NS");
    });

    it("should handle single character symbols", () => {
      assert.strictEqual(buildYahooSymbol("L", "BSE"), "L.BO");
    });
  });
});
