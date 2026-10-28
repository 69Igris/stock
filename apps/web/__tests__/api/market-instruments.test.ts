/**
 * Market Search API - REAL route-input + post-processing pipeline tests.
 *
 * Exercises the ACTUAL exported helpers the GET /api/market/search handler
 * calls (from `@/app/api/market/search/search-logic`), NOT inline copies:
 *
 *   - parseSearchLimit / parseTypes / parseIncludeIndices / isQueryValid /
 *     getWantedTypes  (route input shaping)
 *   - filterIndianYahooResults  (the NSE/BSE-only Yahoo gate)
 *   - dedupeResults → rankSearchResults → resolveSearchSource  (the real
 *     post-processing pipeline the route runs on combined rows)
 *
 * (Replaces the previous SHADOW version, which reimplemented parseSearchQuery /
 * deduplicateResults / sortSearchResults / isIndianMarket / formatSearchResponse
 * inline. Those copies had DIVERGED from the route — e.g. the shadow deduped
 * equities by `yahooSymbol` while the real route dedupes by base symbol with
 * NSE preference — so they could stay green while production broke. This now
 * asserts the same code production runs.)
 *
 * Source: apps/web/app/api/market/search/route.ts
 *         apps/web/app/api/market/search/search-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type SearchResultItem,
  type YahooSearchRow,
  parseSearchLimit,
  parseTypes,
  parseIncludeIndices,
  isQueryValid,
  getWantedTypes,
  filterIndianYahooResults,
  dedupeResults,
  rankSearchResults,
  resolveSearchSource,
} from "@/app/api/market/search/search-logic";

// --- parseSearchLimit (incl. the finite-guard regression) ---

describe("parseSearchLimit", () => {
  it("defaults to 10 when null", () => {
    assert.strictEqual(parseSearchLimit(null), 10);
  });

  it("defaults to 10 when empty string", () => {
    assert.strictEqual(parseSearchLimit(""), 10);
  });

  it("parses a valid number", () => {
    assert.strictEqual(parseSearchLimit("20"), 20);
  });

  it("caps at 50", () => {
    assert.strictEqual(parseSearchLimit("100"), 50);
  });

  it("returns exactly 50 for '50'", () => {
    assert.strictEqual(parseSearchLimit("50"), 50);
  });

  it("handles '1'", () => {
    assert.strictEqual(parseSearchLimit("1"), 1);
  });

  it("handles '0'", () => {
    assert.strictEqual(parseSearchLimit("0"), 0);
  });

  it("REGRESSION: non-numeric clamps to 10, never NaN (no poison into take:/slice)", () => {
    // A malformed ?limit=abc used to yield NaN, which flowed into
    // `prisma … take: NaN` and `Array.slice(0, NaN)` (dropping ALL results).
    assert.strictEqual(parseSearchLimit("xyz"), 10);
    assert.ok(Number.isFinite(parseSearchLimit("xyz")));
  });
});

// --- query validity (drives the "show popular" branch) ---

describe("isQueryValid", () => {
  it("null query is invalid → route returns popular", () => {
    assert.strictEqual(isQueryValid(null), false);
  });

  it("empty string is invalid", () => {
    assert.strictEqual(isQueryValid(""), false);
  });

  it("single character is valid", () => {
    assert.strictEqual(isQueryValid("r"), true);
  });

  it("multi-character query is valid", () => {
    assert.strictEqual(isQueryValid("reliance"), true);
  });
});

// --- parseTypes ---

describe("parseTypes", () => {
  it("returns empty array for null", () => {
    assert.deepStrictEqual(parseTypes(null), []);
  });

  it("returns empty array for empty string", () => {
    assert.deepStrictEqual(parseTypes(""), []);
  });

  it("parses a single type", () => {
    assert.deepStrictEqual(parseTypes("EQUITY"), ["EQUITY"]);
  });

  it("parses multiple types", () => {
    assert.deepStrictEqual(parseTypes("EQUITY,INDEX,MF"), [
      "EQUITY",
      "INDEX",
      "MF",
    ]);
  });

  it("filters empty parts", () => {
    assert.deepStrictEqual(parseTypes("EQUITY,,INDEX"), ["EQUITY", "INDEX"]);
  });
});

// --- parseIncludeIndices ---

describe("parseIncludeIndices", () => {
  it("returns true for null", () => {
    assert.strictEqual(parseIncludeIndices(null), true);
  });

  it("returns true for 'true'", () => {
    assert.strictEqual(parseIncludeIndices("true"), true);
  });

  it("returns false only for the literal 'false'", () => {
    assert.strictEqual(parseIncludeIndices("false"), false);
  });

  it("returns true for empty string", () => {
    assert.strictEqual(parseIncludeIndices(""), true);
  });

  it("returns true for an arbitrary string", () => {
    assert.strictEqual(parseIncludeIndices("yes"), true);
  });
});

// --- getWantedTypes ---

describe("getWantedTypes", () => {
  it("empty filter wants everything", () => {
    assert.deepStrictEqual(getWantedTypes([]), {
      wantEquity: true,
      wantMF: true,
      wantIndex: true,
      wantETF: true,
      wantDebt: true,
    });
  });

  it("ETF turns on wantEquity (shared instrument-search path) and wantETF", () => {
    const w = getWantedTypes(["ETF"]);
    assert.strictEqual(w.wantEquity, true);
    assert.strictEqual(w.wantETF, true);
    assert.strictEqual(w.wantMF, false);
    assert.strictEqual(w.wantIndex, false);
  });

  it("MF-only does not turn on equity/index", () => {
    const w = getWantedTypes(["MF"]);
    assert.strictEqual(w.wantMF, true);
    assert.strictEqual(w.wantEquity, false);
    assert.strictEqual(w.wantIndex, false);
  });
});

// --- filterIndianYahooResults (the real NSE/BSE-only gate) ---

describe("filterIndianYahooResults", () => {
  function yahoo(
    symbol: string,
    exchange: string,
    yahooSymbol = symbol
  ): YahooSearchRow {
    return { symbol, name: symbol, exchange, type: "EQUITY", yahooSymbol };
  }

  it("keeps .NS / .BO suffixed symbols", () => {
    const rows = [yahoo("RELIANCE.NS", "NSI"), yahoo("RELIANCE.BO", "BOM")];
    const filtered = filterIndianYahooResults(rows);
    assert.strictEqual(filtered.length, 2);
  });

  it("drops a US-listed symbol", () => {
    const rows = [yahoo("AAPL", "NMS")];
    const filtered = filterIndianYahooResults(rows);
    assert.strictEqual(filtered.length, 0);
  });

  it("keeps NSE/BSE-exchange rows even without a suffix", () => {
    const rows = [yahoo("TCS", "NSE"), yahoo("INFY", "BSE")];
    const filtered = filterIndianYahooResults(rows);
    assert.strictEqual(filtered.length, 2);
  });
});

// --- dedupeResults → rankSearchResults → resolveSearchSource pipeline ---

describe("post-processing pipeline (real dedupe + rank + source)", () => {
  function eq(
    symbol: string,
    exchange: string,
    name: string,
    yahooSymbol: string
  ): SearchResultItem {
    return {
      symbol,
      name,
      exchange,
      type: "EQUITY",
      yahooSymbol,
      instrumentType: "EQUITY",
    };
  }

  it("dedupes the SAME equity across NSE/BSE down to one row (NSE preferred)", () => {
    // The real route dedupes equities by BASE symbol with NSE preference — the
    // old shadow keyed by yahooSymbol and would have kept BOTH.
    const presorted = [
      eq("RELIANCE", "NSE", "Reliance", "RELIANCE.NS"),
      eq("RELIANCE", "BSE", "Reliance", "RELIANCE.BO"),
    ];
    const unique = dedupeResults(presorted, []);
    assert.strictEqual(unique.length, 1);
    assert.strictEqual(unique[0].exchange, "NSE");
  });

  it("filters by requested types during dedupe", () => {
    const rows: SearchResultItem[] = [
      eq("RELIANCE", "NSE", "Reliance", "RELIANCE.NS"),
      {
        symbol: "NIFTY 50",
        name: "Nifty 50",
        exchange: "NSE",
        type: "INDEX",
        yahooSymbol: "^NSEI",
        instrumentType: "INDEX",
      },
    ];
    const unique = dedupeResults(rows, ["EQUITY"]);
    assert.strictEqual(unique.length, 1);
    assert.strictEqual(unique[0].symbol, "RELIANCE");
  });

  it("rankSearchResults puts the exact-symbol match first", () => {
    const rows = [
      eq("RELIND", "NSE", "Reliance Ind", "RELIND.NS"),
      eq("RELIANCE", "NSE", "Reliance", "RELIANCE.NS"),
    ];
    const ranked = rankSearchResults(rows, "RELIANCE", false);
    assert.strictEqual(ranked[0].symbol, "RELIANCE");
  });

  it("rankSearchResults floats indices above equities (non-exact)", () => {
    const rows: SearchResultItem[] = [
      eq("RELIANCE", "NSE", "Reliance", "RELIANCE.NS"),
      {
        symbol: "NIFTY 50",
        name: "Nifty 50",
        exchange: "NSE",
        type: "INDEX",
        yahooSymbol: "^NSEI",
        instrumentType: "INDEX",
      },
    ];
    const ranked = rankSearchResults(rows, "OTHER", false);
    assert.strictEqual(ranked[0].type, "INDEX");
  });

  it("resolveSearchSource labels atlas / db+yahoo / yahoo correctly", () => {
    assert.strictEqual(resolveSearchSource(true, 0), "atlas");
    assert.strictEqual(resolveSearchSource(false, 3), "db+yahoo");
    assert.strictEqual(resolveSearchSource(false, 0), "yahoo");
  });
});
