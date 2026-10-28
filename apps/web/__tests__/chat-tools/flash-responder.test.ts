/**
 * Flash Responder Tests (lib/chat-tools/flash-responder.ts)
 *
 * Tests for:
 *   - Definition query detection
 *   - Financial data extraction (metadata filtering)
 *   - Data quality assessment
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed (MONEY-620): assert the REAL pure helpers, now in
// flash-responder-logic.ts (flash-responder.ts imports & calls them). Importing
// them caught a drift: the old inline extractFinancialData copy lacked the
// Yahoo `{ raw }`-wrapper branch the source handles, so `{ raw: N }`-only
// fields were silently dropped by the test but kept in production.
import {
  isDefinitionQuery,
  extractFinancialData,
} from "@/lib/chat-tools/flash-responder-logic";

// ── Tests ──────────────────────────────────────────────────────────

describe("Flash Responder", () => {
  describe("isDefinitionQuery", () => {
    it("should detect PE ratio definition", () => {
      assert.ok(isDefinitionQuery("What is PE ratio?"));
    });

    it("should detect MACD definition", () => {
      assert.ok(isDefinitionQuery("What is MACD?"));
    });

    it("should detect SIP definition", () => {
      assert.ok(isDefinitionQuery("What is a SIP?"));
    });

    it("should detect mutual fund definition", () => {
      assert.ok(isDefinitionQuery("What is a mutual fund?"));
    });

    it("should NOT detect stock queries as definitions", () => {
      assert.ok(!isDefinitionQuery("What is RELIANCE PE?"));
    });

    it("should NOT detect action queries as definitions", () => {
      assert.ok(!isDefinitionQuery("Should I buy TCS?"));
    });

    it("should detect LTCG definition", () => {
      assert.ok(isDefinitionQuery("What is LTCG?"));
    });

    it("should detect advance tax definition", () => {
      assert.ok(isDefinitionQuery("What is advance tax?"));
    });
  });

  describe("extractFinancialData - metadata filtering", () => {
    it("should filter out metadata fields", () => {
      const data = {
        priceHint: 2,
        quoteType: "EQUITY",
        symbol: "BIHSPONG.NS",
        exchange: "NSI",
        market: "in_market",
        shortName: "BIHSPONG IND",
        longName: "Bihspong Industries Ltd",
      };
      const result = extractFinancialData(data);
      assert.strictEqual(result.items.length, 0);
      assert.strictEqual(result.isRich, false);
    });

    it("should extract real financial data from nested modules", () => {
      const data = {
        financialData: {
          totalRevenue: { raw: 230000000000, fmt: "₹23,000 Cr" },
          netIncome: { raw: 15000000000, fmt: "₹1,500 Cr" },
          ebitda: { raw: 30000000000, fmt: "₹3,000 Cr" },
          profitMargins: { raw: 0.12, fmt: "12%" },
        },
      };
      const result = extractFinancialData(data);
      assert.strictEqual(result.items.length, 4);
      assert.strictEqual(result.isRich, true);
    });

    it("should return isRich=false when fewer than 3 financial fields", () => {
      const data = {
        price: {
          regularMarketPrice: { raw: 125, fmt: "125.00" },
          regularMarketChange: { raw: -2.5, fmt: "-2.50" },
        },
      };
      const result = extractFinancialData(data);
      assert.strictEqual(result.isRich, false);
    });

    it("should handle mixed metadata + financial data", () => {
      const data = {
        quoteType: "EQUITY",
        symbol: "TCS.NS",
        maxAge: 86400,
        financialData: {
          maxAge: 86400,
          totalRevenue: { raw: 2300000000000, fmt: "₹2,30,000 Cr" },
          revenueGrowth: { raw: 0.15, fmt: "15%" },
          grossMargins: { raw: 0.42, fmt: "42%" },
          operatingMargins: { raw: 0.25, fmt: "25%" },
        },
      };
      const result = extractFinancialData(data);
      // Only financial fields from financialData module (not metadata)
      assert.strictEqual(result.items.length, 4);
      assert.strictEqual(result.isRich, true);
    });

    it("should handle completely empty data", () => {
      const result = extractFinancialData({});
      assert.strictEqual(result.items.length, 0);
      assert.strictEqual(result.isRich, false);
    });

    it("should handle scalar top-level financial values", () => {
      const data = {
        regularMarketPrice: 2500,
        regularMarketChange: -15.5,
        regularMarketVolume: 5000000,
      };
      const result = extractFinancialData(data);
      assert.strictEqual(result.items.length, 3);
      assert.strictEqual(result.isRich, true);
    });

    // Regression: the `{ raw }`-only wrapper branch the old shadow dropped.
    it("should extract `{ raw }`-only fields (no fmt) the shadow ignored", () => {
      const data = {
        financialData: {
          totalRevenue: { raw: 230000000000 },
          netIncome: { raw: 15000000000 },
          ebitda: { raw: 30000000000 },
        },
      };
      const result = extractFinancialData(data);
      assert.strictEqual(result.items.length, 3);
      assert.strictEqual(result.isRich, true);
      // raw numbers are localised to en-IN.
      assert.strictEqual(result.items[0].label, "Total Revenue");
      assert.strictEqual(
        result.items[0].value,
        (230000000000).toLocaleString("en-IN")
      );
    });

    it("should fall back to 'N/A' for a raw wrapper holding null", () => {
      const data = {
        financialData: {
          totalRevenue: { raw: null },
          netIncome: { raw: 1 },
          ebitda: { raw: 2 },
        },
      };
      const result = extractFinancialData(data);
      assert.strictEqual(result.items[0].value, "N/A");
    });
  });
});
