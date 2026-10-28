/**
 * Market Quote — REAL logic test.
 *
 * Exercises the ACTUAL exported symbols from
 * `@/app/api/market/quote/quote-logic` (the pure module the quote route
 * imports) — NOT inline copies:
 *   - parseSymbolList (comma-split / trim / empty-filter)
 *   - validateSymbolListNotEmpty / validateSymbolListSize (count guards)
 *   - validateSymbolParams (symbol|symbols presence)
 *   - resolveExchange (NSE default)
 *   - determineSource (Zerodha-first / Yahoo-fallback label)
 *   - findMissingSymbols (Zerodha → Yahoo fill diff)
 *   - formatSingleQuoteResponse / formatMultiQuoteResponse (response shapes)
 *
 * (Replaces the previous shadow version, which reimplemented every helper
 * inline and asserted the copies.)
 *
 * Source: apps/web/app/api/market/quote/quote-logic.ts
 *         (imported by apps/web/app/api/market/quote/route.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSymbolList,
  validateSymbolListNotEmpty,
  validateSymbolListSize,
  validateSymbolParams,
  resolveExchange,
  determineSource,
  findMissingSymbols,
  formatSingleQuoteResponse,
  formatMultiQuoteResponse,
} from "@/app/api/market/quote/quote-logic";

describe("Market Quote API Logic", () => {
  describe("Symbol list parsing", () => {
    it("should parse single symbol", () => {
      const result = parseSymbolList("RELIANCE");
      assert.deepStrictEqual(result, ["RELIANCE"]);
    });

    it("should parse comma-separated symbols", () => {
      const result = parseSymbolList("RELIANCE,TCS,INFY");
      assert.deepStrictEqual(result, ["RELIANCE", "TCS", "INFY"]);
    });

    it("should trim whitespace around symbols", () => {
      const result = parseSymbolList(" RELIANCE , TCS , INFY ");
      assert.deepStrictEqual(result, ["RELIANCE", "TCS", "INFY"]);
    });

    it("should filter out empty strings from trailing commas", () => {
      const result = parseSymbolList("RELIANCE,TCS,");
      assert.deepStrictEqual(result, ["RELIANCE", "TCS"]);
    });

    it("should filter out empty strings from leading commas", () => {
      const result = parseSymbolList(",RELIANCE,TCS");
      assert.deepStrictEqual(result, ["RELIANCE", "TCS"]);
    });

    it("should filter out empty strings from consecutive commas", () => {
      const result = parseSymbolList("RELIANCE,,TCS");
      assert.deepStrictEqual(result, ["RELIANCE", "TCS"]);
    });

    it("should return empty array for empty string", () => {
      const result = parseSymbolList("");
      assert.deepStrictEqual(result, []);
    });

    it("should return empty array for only commas", () => {
      const result = parseSymbolList(",,,");
      assert.deepStrictEqual(result, []);
    });

    it("should return empty array for only whitespace and commas", () => {
      const result = parseSymbolList(" , , , ");
      assert.deepStrictEqual(result, []);
    });

    it("should handle symbols with dots (e.g. BSE symbols)", () => {
      const result = parseSymbolList("RELIANCE.NS,TCS.NS");
      assert.deepStrictEqual(result, ["RELIANCE.NS", "TCS.NS"]);
    });

    it("should preserve case of symbols", () => {
      const result = parseSymbolList("reliance,Tcs,INFY");
      assert.deepStrictEqual(result, ["reliance", "Tcs", "INFY"]);
    });
  });

  describe("Symbol list validation - empty", () => {
    it("should reject empty symbol list", () => {
      const result = validateSymbolListNotEmpty([]);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("No valid symbols"));
    });

    it("should accept non-empty symbol list", () => {
      const result = validateSymbolListNotEmpty(["RELIANCE"]);
      assert.strictEqual(result.valid, true);
    });

    it("should accept list with multiple symbols", () => {
      const result = validateSymbolListNotEmpty(["RELIANCE", "TCS"]);
      assert.strictEqual(result.valid, true);
    });
  });

  describe("Symbol list validation - size limit", () => {
    it("should reject list with more than 50 symbols", () => {
      const symbols = Array.from({ length: 51 }, (_, i) => `SYM${i}`);
      const result = validateSymbolListSize(symbols);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("Maximum 50"));
    });

    it("should accept list with exactly 50 symbols", () => {
      const symbols = Array.from({ length: 50 }, (_, i) => `SYM${i}`);
      const result = validateSymbolListSize(symbols);
      assert.strictEqual(result.valid, true);
    });

    it("should accept list with 1 symbol", () => {
      const result = validateSymbolListSize(["RELIANCE"]);
      assert.strictEqual(result.valid, true);
    });

    it("should reject list with 100 symbols", () => {
      const symbols = Array.from({ length: 100 }, (_, i) => `SYM${i}`);
      const result = validateSymbolListSize(symbols);
      assert.strictEqual(result.valid, false);
    });
  });

  describe("Symbol/symbols parameter validation", () => {
    it("should fail when both symbol and symbols are null", () => {
      const result = validateSymbolParams(null, null);
      assert.strictEqual(result.valid, false);
      assert.ok(result.error?.includes("'symbol' or 'symbols'"));
    });

    it("should pass when symbol is provided", () => {
      const result = validateSymbolParams("RELIANCE", null);
      assert.strictEqual(result.valid, true);
    });

    it("should pass when symbols is provided", () => {
      const result = validateSymbolParams(null, "RELIANCE,TCS");
      assert.strictEqual(result.valid, true);
    });

    it("should pass when both are provided", () => {
      const result = validateSymbolParams("RELIANCE", "TCS,INFY");
      assert.strictEqual(result.valid, true);
    });

    it("should fail when symbol is empty string and symbols is null", () => {
      const result = validateSymbolParams("", null);
      assert.strictEqual(result.valid, false);
    });

    it("should fail when both are empty strings", () => {
      const result = validateSymbolParams("", "");
      assert.strictEqual(result.valid, false);
    });
  });

  describe("Exchange resolution", () => {
    it("should default to NSE when exchange is null", () => {
      assert.strictEqual(resolveExchange(null), "NSE");
    });

    it("should default to NSE when exchange is empty string", () => {
      assert.strictEqual(resolveExchange(""), "NSE");
    });

    it("should use provided exchange NSE", () => {
      assert.strictEqual(resolveExchange("NSE"), "NSE");
    });

    it("should use provided exchange BSE", () => {
      assert.strictEqual(resolveExchange("BSE"), "BSE");
    });

    it("should pass through an MCX exchange string", () => {
      assert.strictEqual(resolveExchange("MCX"), "MCX");
    });
  });

  describe("Source selection logic", () => {
    it("should return zerodha when credentials exist and data returned", () => {
      assert.strictEqual(determineSource(true, true), "zerodha");
    });

    it("should return yahoo when credentials exist but no data", () => {
      assert.strictEqual(determineSource(true, false), "yahoo");
    });

    it("should return yahoo when no credentials", () => {
      assert.strictEqual(determineSource(false, false), "yahoo");
    });

    it("should return yahoo when no credentials even if data would exist", () => {
      assert.strictEqual(determineSource(false, true), "yahoo");
    });
  });

  describe("Missing symbols detection", () => {
    it("should find symbols missing from Zerodha response", () => {
      const symbolList = ["RELIANCE", "TCS", "INFY"];
      const zerodhaMap = new Map<string, unknown>([
        ["RELIANCE", { price: 2500 }],
      ]);
      const missing = findMissingSymbols(symbolList, zerodhaMap);
      assert.deepStrictEqual(missing, ["TCS", "INFY"]);
    });

    it("should return empty array when all symbols found", () => {
      const symbolList = ["RELIANCE", "TCS"];
      const zerodhaMap = new Map<string, unknown>([
        ["RELIANCE", { price: 2500 }],
        ["TCS", { price: 3500 }],
      ]);
      const missing = findMissingSymbols(symbolList, zerodhaMap);
      assert.deepStrictEqual(missing, []);
    });

    it("should return all symbols when Zerodha map is empty", () => {
      const symbolList = ["RELIANCE", "TCS"];
      const zerodhaMap = new Map<string, unknown>();
      const missing = findMissingSymbols(symbolList, zerodhaMap);
      assert.deepStrictEqual(missing, ["RELIANCE", "TCS"]);
    });

    it("should handle empty symbol list", () => {
      const zerodhaMap = new Map<string, unknown>([
        ["RELIANCE", { price: 2500 }],
      ]);
      const missing = findMissingSymbols([], zerodhaMap);
      assert.deepStrictEqual(missing, []);
    });
  });

  describe("Response formatting", () => {
    it("should format single quote response with all fields", () => {
      const response = formatSingleQuoteResponse(
        { price: 2500, change: 50 },
        "zerodha",
        "active"
      );
      assert.strictEqual(response.success, true);
      assert.deepStrictEqual(response.data, { price: 2500, change: 50 });
      assert.strictEqual(response.source, "zerodha");
      assert.strictEqual(response.brokerStatus, "active");
      assert.ok(typeof response.timestamp === "string");
    });

    it("should format multi quote response with count", () => {
      const quotes = {
        RELIANCE: { price: 2500 },
        TCS: { price: 3500 },
      };
      const response = formatMultiQuoteResponse(quotes, "yahoo", "expired");
      assert.strictEqual(response.success, true);
      assert.strictEqual(response.count, 2);
      assert.strictEqual(response.source, "yahoo");
      assert.strictEqual(response.brokerStatus, "expired");
    });

    it("should have count 0 for empty quotes", () => {
      const response = formatMultiQuoteResponse({}, "yahoo", "none");
      assert.strictEqual(response.count, 0);
    });

    it("should include ISO timestamp", () => {
      const response = formatSingleQuoteResponse(
        { price: 100 },
        "yahoo",
        "active"
      );
      const ts = response.timestamp as string;
      assert.ok(ts.match(/^\d{4}-\d{2}-\d{2}T/));
    });
  });
});
