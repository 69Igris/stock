/**
 * useStockSearch Hook Logic Tests
 *
 * De-shadowed (MONEY-620): previously this file re-implemented the hook's pure
 * helpers inline and asserted the copies (and even tested a `deduplicateResults`
 * + a fake debounce model that DON'T exist in the source). It now imports the
 * REAL helpers from `@/hooks/useStockSearch-logic` — the same functions the hook
 * calls — and the non-source fabrications were dropped.
 *
 * Source: apps/web/hooks/useStockSearch-logic.ts (consumed by useStockSearch.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { StockSearchResult, StockWithPrice } from "@/hooks/useStockSearch";
import {
  resolveStockSearchOptions as resolveOptions,
  isQueryEmpty,
  buildSearchParams,
  buildPopularParams,
  extractSymbolsForQuotes,
  mergeWithQuotes,
  createDefaultPriceResult,
  shouldReportError,
} from "@/hooks/useStockSearch-logic";

// ============== MOCK FACTORIES ==============

function createMockSearchResult(
  overrides: Partial<StockSearchResult> = {}
): StockSearchResult {
  return {
    symbol: "RELIANCE",
    name: "Reliance Industries",
    exchange: "NSE",
    type: "EQUITY",
    yahooSymbol: "RELIANCE.NS",
    ...overrides,
  };
}

interface QuoteData {
  price?: number;
  change?: number;
  changePercent?: number;
  volume?: number;
  high?: number;
  low?: number;
}

function createMockQuote(overrides: Partial<QuoteData> = {}): QuoteData {
  return {
    price: 2500.0,
    change: 25.5,
    changePercent: 1.03,
    volume: 5000000,
    high: 2550.0,
    low: 2480.0,
    ...overrides,
  };
}

// ============== TESTS ==============

describe("useStockSearch Hook Logic", () => {
  // -- Options Defaults --

  describe("Options defaults", () => {
    it("should default includeIndices to false", () => {
      assert.strictEqual(resolveOptions({}).includeIndices, false);
    });

    it("should default limit to 20", () => {
      assert.strictEqual(resolveOptions({}).limit, 20);
    });

    it("should default debounceMs to 300", () => {
      assert.strictEqual(resolveOptions({}).debounceMs, 300);
    });

    it("should respect custom includeIndices", () => {
      assert.strictEqual(
        resolveOptions({ includeIndices: true }).includeIndices,
        true
      );
    });

    it("should respect custom limit", () => {
      assert.strictEqual(resolveOptions({ limit: 50 }).limit, 50);
    });

    it("should respect custom debounceMs", () => {
      assert.strictEqual(resolveOptions({ debounceMs: 500 }).debounceMs, 500);
    });

    it("should handle all options provided", () => {
      const opts = resolveOptions({
        includeIndices: true,
        limit: 10,
        debounceMs: 100,
      });
      assert.strictEqual(opts.includeIndices, true);
      assert.strictEqual(opts.limit, 10);
      assert.strictEqual(opts.debounceMs, 100);
    });

    it("should handle empty options object", () => {
      const opts = resolveOptions();
      assert.strictEqual(opts.includeIndices, false);
      assert.strictEqual(opts.limit, 20);
      assert.strictEqual(opts.debounceMs, 300);
    });
  });

  // -- Query Empty Check --

  describe("Query empty check", () => {
    it("should consider empty string as empty", () => {
      assert.strictEqual(isQueryEmpty(""), true);
    });

    it("should consider whitespace-only as empty", () => {
      assert.strictEqual(isQueryEmpty("   "), true);
    });

    it("should consider tab as empty", () => {
      assert.strictEqual(isQueryEmpty("\t"), true);
    });

    it("should consider newline as empty", () => {
      assert.strictEqual(isQueryEmpty("\n"), true);
    });

    it("should consider non-empty string as not empty", () => {
      assert.strictEqual(isQueryEmpty("RELIANCE"), false);
    });

    it("should consider string with leading spaces as not empty", () => {
      assert.strictEqual(isQueryEmpty("  A"), false);
    });

    it("should consider single character as not empty", () => {
      assert.strictEqual(isQueryEmpty("R"), false);
    });
  });

  // -- URL Parameter Building --

  describe("URL parameter building", () => {
    it("should build search params with query", () => {
      const params = buildSearchParams("RELIANCE", 20, false);
      assert.strictEqual(params.q, "RELIANCE");
      assert.strictEqual(params.limit, "20");
      assert.strictEqual(params.includeIndices, "false");
    });

    it("should build popular params without query", () => {
      const params = buildPopularParams(20, true);
      assert.strictEqual(params.limit, "20");
      assert.strictEqual(params.includeIndices, "true");
      assert.strictEqual("q" in params, false);
    });

    it("should convert limit to string", () => {
      assert.strictEqual(buildSearchParams("TCS", 10, true).limit, "10");
    });

    it("should convert includeIndices boolean to string", () => {
      assert.strictEqual(
        buildSearchParams("A", 5, true).includeIndices,
        "true"
      );
    });
  });

  // -- Symbol Extraction for Quotes --

  describe("Symbol extraction for quotes", () => {
    it("should exclude INDEX type results", () => {
      const results: StockSearchResult[] = [
        createMockSearchResult({ symbol: "RELIANCE", type: "EQUITY" }),
        createMockSearchResult({ symbol: "NIFTY 50", type: "INDEX" }),
        createMockSearchResult({ symbol: "TCS", type: "EQUITY" }),
      ];
      const symbols = extractSymbolsForQuotes(results);
      assert.strictEqual(symbols.length, 2);
      assert.ok(!symbols.includes("NIFTY 50"));
    });

    it("should limit to 20 symbols by default", () => {
      const results: StockSearchResult[] = Array.from({ length: 30 }, (_, i) =>
        createMockSearchResult({
          symbol: `STOCK${i}`,
          yahooSymbol: `STOCK${i}.NS`,
        })
      );
      assert.strictEqual(extractSymbolsForQuotes(results).length, 20);
    });

    it("should respect custom maxSymbols", () => {
      const results: StockSearchResult[] = Array.from({ length: 10 }, (_, i) =>
        createMockSearchResult({
          symbol: `STOCK${i}`,
          yahooSymbol: `STOCK${i}.NS`,
        })
      );
      assert.strictEqual(extractSymbolsForQuotes(results, 5).length, 5);
    });

    it("should return empty for all INDEX results", () => {
      const results: StockSearchResult[] = [
        createMockSearchResult({ symbol: "NIFTY 50", type: "INDEX" }),
        createMockSearchResult({ symbol: "SENSEX", type: "INDEX" }),
      ];
      assert.strictEqual(extractSymbolsForQuotes(results).length, 0);
    });

    it("should return empty for empty results", () => {
      assert.strictEqual(extractSymbolsForQuotes([]).length, 0);
    });

    it("should include MF type results", () => {
      const results: StockSearchResult[] = [
        createMockSearchResult({ symbol: "119551", type: "MF" }),
      ];
      const symbols = extractSymbolsForQuotes(results);
      assert.strictEqual(symbols.length, 1);
      assert.strictEqual(symbols[0], "119551");
    });
  });

  // -- Quote Merging --

  describe("Result merging with quotes", () => {
    it("should merge quote data with search result", () => {
      const results = [createMockSearchResult()];
      const quotes = { RELIANCE: createMockQuote() };
      const merged = mergeWithQuotes(results, quotes);
      assert.strictEqual(merged.length, 1);
      assert.strictEqual(merged[0].price, 2500.0);
      assert.strictEqual(merged[0].change, 25.5);
      assert.strictEqual(merged[0].changePercent, 1.03);
      assert.strictEqual(merged[0].volume, 5000000);
      assert.strictEqual(merged[0].dayHigh, 2550.0);
      assert.strictEqual(merged[0].dayLow, 2480.0);
    });

    it("should use 0 defaults when quote is missing", () => {
      const results = [createMockSearchResult()];
      const merged = mergeWithQuotes(results, {});
      assert.strictEqual(merged[0].price, 0);
      assert.strictEqual(merged[0].change, 0);
      assert.strictEqual(merged[0].changePercent, 0);
      assert.strictEqual(merged[0].volume, 0);
      assert.strictEqual(merged[0].dayHigh, 0);
      assert.strictEqual(merged[0].dayLow, 0);
    });

    it("should use 0 for undefined quote fields", () => {
      const results = [createMockSearchResult()];
      const quotes = { RELIANCE: { price: 100 } as QuoteData };
      const merged = mergeWithQuotes(results, quotes);
      assert.strictEqual(merged[0].price, 100);
      assert.strictEqual(merged[0].change, 0);
      assert.strictEqual(merged[0].volume, 0);
    });

    it("should preserve original search result fields", () => {
      const results = [
        createMockSearchResult({
          symbol: "TCS",
          name: "TCS",
          exchange: "NSE",
          yahooSymbol: "TCS.NS",
        }),
      ];
      const quotes = { TCS: createMockQuote({ price: 3000 }) };
      const merged = mergeWithQuotes(results, quotes);
      assert.strictEqual(merged[0].symbol, "TCS");
      assert.strictEqual(merged[0].name, "TCS");
      assert.strictEqual(merged[0].exchange, "NSE");
      assert.strictEqual(merged[0].yahooSymbol, "TCS.NS");
      assert.strictEqual(merged[0].price, 3000);
    });

    it("should handle multiple results with mixed quote availability", () => {
      const results = [
        createMockSearchResult({ symbol: "A", yahooSymbol: "A.NS" }),
        createMockSearchResult({ symbol: "B", yahooSymbol: "B.NS" }),
        createMockSearchResult({ symbol: "C", yahooSymbol: "C.NS" }),
      ];
      const quotes = {
        A: createMockQuote({ price: 100 }),
        C: createMockQuote({ price: 300 }),
      };
      const merged = mergeWithQuotes(results, quotes);
      assert.strictEqual(merged[0].price, 100);
      assert.strictEqual(merged[1].price, 0);
      assert.strictEqual(merged[2].price, 300);
    });

    it("should handle empty results", () => {
      assert.strictEqual(mergeWithQuotes([], {}).length, 0);
    });
  });

  // -- Default Price Result --

  describe("Default price result creation", () => {
    it("should create result with all zero prices", () => {
      const withPrice: StockWithPrice = createDefaultPriceResult(
        createMockSearchResult()
      );
      assert.strictEqual(withPrice.price, 0);
      assert.strictEqual(withPrice.change, 0);
      assert.strictEqual(withPrice.changePercent, 0);
      assert.strictEqual(withPrice.volume, 0);
      assert.strictEqual(withPrice.dayHigh, 0);
      assert.strictEqual(withPrice.dayLow, 0);
    });

    it("should preserve the original search result fields", () => {
      const withPrice = createDefaultPriceResult(
        createMockSearchResult({ symbol: "INFY", name: "Infosys" })
      );
      assert.strictEqual(withPrice.symbol, "INFY");
      assert.strictEqual(withPrice.name, "Infosys");
    });
  });

  // -- Error reporting (the hook's catch guard) --

  describe("shouldReportError", () => {
    it("should report regular Error instances", () => {
      assert.strictEqual(
        shouldReportError(new Error("Something failed")),
        true
      );
    });

    it("should NOT report AbortError (request was cancelled)", () => {
      const err = new DOMException("Aborted", "AbortError");
      assert.strictEqual(shouldReportError(err), false);
    });

    it("should not report non-Error values", () => {
      assert.strictEqual(shouldReportError("string error"), false);
      assert.strictEqual(shouldReportError(null), false);
      assert.strictEqual(shouldReportError(undefined), false);
      assert.strictEqual(shouldReportError(42), false);
    });

    it("should report TypeError", () => {
      assert.strictEqual(
        shouldReportError(new TypeError("Cannot read property")),
        true
      );
    });

    it("should report a custom Error with a non-Abort name", () => {
      const err = new Error("network");
      err.name = "NetworkError";
      assert.strictEqual(shouldReportError(err), true);
    });
  });
});
