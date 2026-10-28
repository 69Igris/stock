/**
 * useMarketData Hook Logic Tests
 *
 * De-shadowed (MONEY-620): previously this file re-implemented the hook's pure
 * transforms inline and asserted the copies (plus a `deduplicateSymbols`,
 * `getNextStatus` and `createSymbolsKey` that DON'T exist in the source — the
 * hook filters via `filterValidSymbols`, sets status inline, and joins symbols
 * only in a dep array). It now imports the REAL helpers from
 * `@/hooks/useMarketData-logic` — the same functions the hook + useQuote call.
 * The fabrications were replaced with real-`filterValidSymbols` coverage.
 *
 * Source: apps/web/hooks/useMarketData-logic.ts (consumed by useMarketData.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { QuoteData } from "@/hooks/useMarketData";
import {
  resolveMarketDataOptions as resolveOptions,
  filterValidSymbols,
  buildQuoteParams,
  parseQuoteData,
  transformQuoteResponse as transformApiResponse,
  extractSingleQuote,
  extractMarketDataError as extractErrorMessage,
  isValidPollingInterval,
  type RawApiQuote,
} from "@/hooks/useMarketData-logic";

// ============== MOCK FACTORIES ==============

function createMockRawQuote(overrides: Partial<RawApiQuote> = {}): RawApiQuote {
  return {
    symbol: "RELIANCE",
    exchange: "NSE",
    name: "Reliance Industries Ltd",
    price: 2485.5,
    change: 32.75,
    changePercent: 1.33,
    open: 2460.0,
    high: 2500.0,
    low: 2450.0,
    previousClose: 2452.75,
    volume: 8500000,
    timestamp: "2026-02-24T10:30:00.000Z",
    ...overrides,
  };
}

// ============== TESTS ==============

describe("useMarketData Hook Logic", () => {
  // -- Options Defaults --

  describe("Options defaults", () => {
    it("should default interval to 10000ms", () => {
      assert.strictEqual(resolveOptions({}).interval, 10000);
    });

    it("should default enablePolling to true", () => {
      assert.strictEqual(resolveOptions({}).enablePolling, true);
    });

    it("should default exchange to NSE", () => {
      assert.strictEqual(resolveOptions({}).exchange, "NSE");
    });

    it("should respect custom interval", () => {
      assert.strictEqual(resolveOptions({ interval: 5000 }).interval, 5000);
    });

    it("should respect enablePolling set to false", () => {
      assert.strictEqual(
        resolveOptions({ enablePolling: false }).enablePolling,
        false
      );
    });

    it("should respect BSE exchange", () => {
      assert.strictEqual(resolveOptions({ exchange: "BSE" }).exchange, "BSE");
    });

    it("should handle undefined options gracefully", () => {
      const opts = resolveOptions();
      assert.strictEqual(opts.interval, 10000);
      assert.strictEqual(opts.enablePolling, true);
      assert.strictEqual(opts.exchange, "NSE");
    });
  });

  // -- URL Construction --

  describe("URL construction", () => {
    it("should build correct params with single symbol", () => {
      const params = buildQuoteParams(["RELIANCE"], "NSE");
      assert.strictEqual(params.get("symbols"), "RELIANCE");
      assert.strictEqual(params.get("exchange"), "NSE");
    });

    it("should join multiple symbols with comma", () => {
      const params = buildQuoteParams(["RELIANCE", "TCS", "INFY"], "NSE");
      assert.strictEqual(params.get("symbols"), "RELIANCE,TCS,INFY");
    });

    it("should use BSE exchange when specified", () => {
      const params = buildQuoteParams(["RELIANCE"], "BSE");
      assert.strictEqual(params.get("exchange"), "BSE");
    });

    it("should handle empty symbols array", () => {
      const params = buildQuoteParams([], "NSE");
      assert.strictEqual(params.get("symbols"), "");
      assert.strictEqual(params.get("exchange"), "NSE");
    });

    it("should produce valid URLSearchParams encoding", () => {
      const params = buildQuoteParams(["A&B"], "NSE");
      assert.strictEqual(params.get("symbols"), "A&B");
      assert.strictEqual(params.get("exchange"), "NSE");
    });
  });

  // -- Valid Symbol Filtering (the hook's real guard) --

  describe("filterValidSymbols", () => {
    it("should keep non-empty string symbols", () => {
      assert.deepStrictEqual(filterValidSymbols(["RELIANCE", "TCS"]), [
        "RELIANCE",
        "TCS",
      ]);
    });

    it("should drop undefined entries (stale placeholders)", () => {
      assert.deepStrictEqual(
        filterValidSymbols(["RELIANCE", undefined, "TCS"]),
        ["RELIANCE", "TCS"]
      );
    });

    it("should drop empty + whitespace-only entries", () => {
      assert.deepStrictEqual(
        filterValidSymbols(["RELIANCE", "", "   ", "TCS"]),
        ["RELIANCE", "TCS"]
      );
    });

    it("should return empty for an all-blank list (avoids symbols=,,,, → 400)", () => {
      assert.deepStrictEqual(filterValidSymbols(["", "  ", undefined]), []);
    });

    it("should handle an empty array", () => {
      assert.deepStrictEqual(filterValidSymbols([]), []);
    });
  });

  // -- Quote Data Parsing --

  describe("Quote data parsing", () => {
    it("should parse raw quote into QuoteData with Date timestamp", () => {
      const parsed = parseQuoteData(createMockRawQuote());
      assert.strictEqual(parsed.symbol, "RELIANCE");
      assert.strictEqual(parsed.price, 2485.5);
      assert.ok(parsed.timestamp instanceof Date);
    });

    it("should correctly convert ISO timestamp string to Date", () => {
      const parsed = parseQuoteData(
        createMockRawQuote({ timestamp: "2026-02-24T10:30:00.000Z" })
      );
      assert.strictEqual(
        parsed.timestamp.toISOString(),
        "2026-02-24T10:30:00.000Z"
      );
    });

    it("should preserve optional fields when present", () => {
      const parsed = parseQuoteData(
        createMockRawQuote({
          marketCap: 1500000000000,
          pe: 28.5,
          eps: 87.2,
          week52High: 2800.0,
          week52Low: 2100.0,
        })
      );
      assert.strictEqual(parsed.marketCap, 1500000000000);
      assert.strictEqual(parsed.pe, 28.5);
      assert.strictEqual(parsed.eps, 87.2);
      assert.strictEqual(parsed.week52High, 2800.0);
      assert.strictEqual(parsed.week52Low, 2100.0);
    });

    it("should leave optional fields undefined when absent", () => {
      const raw = createMockRawQuote();
      delete raw.marketCap;
      delete raw.pe;
      delete raw.eps;
      const parsed = parseQuoteData(raw);
      assert.strictEqual(parsed.marketCap, undefined);
      assert.strictEqual(parsed.pe, undefined);
      assert.strictEqual(parsed.eps, undefined);
    });
  });

  // -- API Response Transformation --

  describe("API response transformation", () => {
    it("should transform single-symbol response into Map", () => {
      const map = transformApiResponse({ RELIANCE: createMockRawQuote() });
      assert.strictEqual(map.size, 1);
      assert.ok(map.has("RELIANCE"));
    });

    it("should transform multi-symbol response into Map", () => {
      const map = transformApiResponse({
        RELIANCE: createMockRawQuote({ symbol: "RELIANCE" }),
        TCS: createMockRawQuote({ symbol: "TCS", price: 3500 }),
        INFY: createMockRawQuote({ symbol: "INFY", price: 1800 }),
      });
      assert.strictEqual(map.size, 3);
      assert.strictEqual(map.get("TCS")?.price, 3500);
      assert.strictEqual(map.get("INFY")?.price, 1800);
    });

    it("should handle empty response object", () => {
      assert.strictEqual(transformApiResponse({}).size, 0);
    });

    it("should convert all timestamp strings to Date objects", () => {
      const map = transformApiResponse({
        A: createMockRawQuote({
          symbol: "A",
          timestamp: "2026-01-15T09:00:00.000Z",
        }),
        B: createMockRawQuote({
          symbol: "B",
          timestamp: "2026-01-15T09:05:00.000Z",
        }),
      });
      assert.ok(map.get("A")?.timestamp instanceof Date);
      assert.ok(map.get("B")?.timestamp instanceof Date);
      assert.notDeepStrictEqual(
        map.get("A")?.timestamp,
        map.get("B")?.timestamp
      );
    });
  });

  // -- Error Message Extraction --

  describe("Error message extraction", () => {
    it("should extract message from Error instance", () => {
      assert.strictEqual(
        extractErrorMessage(new Error("Network timeout")),
        "Network timeout"
      );
    });

    it("should return 'Unknown error' for string", () => {
      assert.strictEqual(extractErrorMessage("some string"), "Unknown error");
    });

    it("should return 'Unknown error' for null", () => {
      assert.strictEqual(extractErrorMessage(null), "Unknown error");
    });

    it("should return 'Unknown error' for undefined", () => {
      assert.strictEqual(extractErrorMessage(undefined), "Unknown error");
    });

    it("should extract message from TypeError", () => {
      assert.strictEqual(
        extractErrorMessage(new TypeError("Cannot read properties")),
        "Cannot read properties"
      );
    });
  });

  // -- Single Quote Extraction (useQuote) --

  describe("Single quote extraction (useQuote logic)", () => {
    it("should return the matching quote from the map", () => {
      const map = new Map<string, QuoteData>();
      map.set("TCS", parseQuoteData(createMockRawQuote({ symbol: "TCS" })));
      assert.strictEqual(extractSingleQuote(map, "TCS")?.symbol, "TCS");
    });

    it("should return null when symbol is not in the map", () => {
      assert.strictEqual(
        extractSingleQuote(new Map<string, QuoteData>(), "INFY"),
        null
      );
    });

    it("should return null from empty map", () => {
      assert.strictEqual(extractSingleQuote(new Map(), "RELIANCE"), null);
    });
  });

  // -- Polling Interval Validation (the hook's setInterval guard) --

  describe("Polling interval validation", () => {
    it("should accept positive interval", () => {
      assert.strictEqual(isValidPollingInterval(10000), true);
    });

    it("should reject zero interval (would peg the CPU)", () => {
      assert.strictEqual(isValidPollingInterval(0), false);
    });

    it("should reject negative interval", () => {
      assert.strictEqual(isValidPollingInterval(-1000), false);
    });

    it("should reject Infinity", () => {
      assert.strictEqual(isValidPollingInterval(Infinity), false);
    });

    it("should reject NaN (coerces to setInterval 0)", () => {
      assert.strictEqual(isValidPollingInterval(NaN), false);
    });
  });
});
