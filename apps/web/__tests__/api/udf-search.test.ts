/**
 * TradingView UDF - Symbol Search Endpoint - REAL logic tests.
 *
 * Exercises the ACTUAL exported pure helpers the GET /api/market/udf/search
 * handler calls (from `@/app/api/market/udf/search/search-logic`):
 *
 * - `computeTypeFilters`      — typeFilter → wantsEquities / wantsFunds
 * - `computeExchangeFilters`  — exchangeFilter → wantsExchangeNseBse / wantsExchangeMf
 * - `computeSearchLimit`      — limit param → default 30 / cap 100 / NaN fallback
 * - `instrumentTypeToTvType`  — instrument type → TradingView type
 * - `isNumericCode`           — MF query numeric-vs-text classification
 * - `shouldIncludeEquity`     — per-instrument type-filter gate
 * - `buildEquityResultItem` / `buildMfResultItem` — result-item builders
 *
 * (Replaces the previous SHADOW version, which re-declared all of these inline
 * and asserted the copies. The transforms were INLINE in route.ts and
 * untestable behind Clerk/Prisma; route.ts now imports & calls them, so this
 * asserts the same code production runs.)
 *
 * Source: apps/web/app/api/market/udf/search/route.ts
 *         apps/web/app/api/market/udf/search/search-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeTypeFilters,
  computeExchangeFilters,
  computeSearchLimit,
  instrumentTypeToTvType,
  isNumericCode,
  shouldIncludeEquity,
  buildEquityResultItem,
  buildMfResultItem,
} from "@/app/api/market/udf/search/search-logic";

// ============== SearchSymbolResultItem shape ==============

describe("SearchSymbolResultItem shape", () => {
  it("has all required fields for an equity result", () => {
    const item = buildEquityResultItem({
      symbol: "TCS",
      exchange: "NSE",
      name: "Tata Consultancy Services Ltd",
      instrumentType: "EQUITY",
    });
    assert.strictEqual(item.symbol, "TCS");
    assert.strictEqual(item.full_name, "NSE:TCS");
    assert.strictEqual(item.description, "Tata Consultancy Services Ltd");
    assert.strictEqual(item.exchange, "NSE");
    assert.strictEqual(item.ticker, "NSE:TCS");
    assert.strictEqual(item.type, "stock");
  });

  it("full_name format is EXCHANGE:SYMBOL", () => {
    const item = buildEquityResultItem({
      symbol: "RELIANCE",
      exchange: "BSE",
      name: "Reliance Industries",
      instrumentType: "EQUITY",
    });
    assert.strictEqual(item.full_name, "BSE:RELIANCE");
  });

  it("ticker format is EXCHANGE:SYMBOL", () => {
    const item = buildEquityResultItem({
      symbol: "INFY",
      exchange: "NSE",
      name: "Infosys Ltd",
      instrumentType: "EQUITY",
    });
    assert.strictEqual(item.ticker, "NSE:INFY");
  });

  it("has all required fields for a MF result", () => {
    const item = buildMfResultItem({
      schemeCode: "120503",
      schemeName: "SBI Blue Chip Fund - Regular Plan - Growth",
      amcName: "SBI Mutual Fund",
    });
    assert.strictEqual(item.symbol, "120503");
    assert.strictEqual(item.full_name, "MF:120503");
    assert.strictEqual(
      item.description,
      "SBI Blue Chip Fund - Regular Plan - Growth (SBI Mutual Fund)"
    );
    assert.strictEqual(item.exchange, "MF");
    assert.strictEqual(item.ticker, "MF:120503");
    assert.strictEqual(item.type, "fund");
  });
});

// ============== Type filtering logic ==============

describe("Type filtering logic", () => {
  it('typeFilter="" → wants all (equities + funds)', () => {
    const { wantsEquities, wantsFunds } = computeTypeFilters("");
    assert.strictEqual(wantsEquities, true);
    assert.strictEqual(wantsFunds, true);
  });

  it('typeFilter="stock" → wantsEquities=true, wantsFunds=false', () => {
    const { wantsEquities, wantsFunds } = computeTypeFilters("stock");
    assert.strictEqual(wantsEquities, true);
    assert.strictEqual(wantsFunds, false);
  });

  it('typeFilter="etf" → wantsEquities=true, wantsFunds=false', () => {
    const { wantsEquities, wantsFunds } = computeTypeFilters("etf");
    assert.strictEqual(wantsEquities, true);
    assert.strictEqual(wantsFunds, false);
  });

  it('typeFilter="fund" → wantsEquities=false, wantsFunds=true', () => {
    const { wantsEquities, wantsFunds } = computeTypeFilters("fund");
    assert.strictEqual(wantsEquities, false);
    assert.strictEqual(wantsFunds, true);
  });

  it('typeFilter="index" → wantsEquities=true, wantsFunds=false', () => {
    const { wantsEquities, wantsFunds } = computeTypeFilters("index");
    assert.strictEqual(wantsEquities, true);
    assert.strictEqual(wantsFunds, false);
  });

  it("is case-insensitive (STOCK → same as stock)", () => {
    const { wantsEquities, wantsFunds } = computeTypeFilters("STOCK");
    assert.strictEqual(wantsEquities, true);
    assert.strictEqual(wantsFunds, false);
  });

  it("unknown type filter wants neither equities nor funds", () => {
    const { wantsEquities, wantsFunds } = computeTypeFilters("crypto");
    assert.strictEqual(wantsEquities, false);
    assert.strictEqual(wantsFunds, false);
  });
});

// ============== Exchange filtering logic ==============

describe("Exchange filtering logic", () => {
  it('exchangeFilter="" → wants all', () => {
    const { wantsExchangeNseBse, wantsExchangeMf } = computeExchangeFilters("");
    assert.strictEqual(wantsExchangeNseBse, true);
    assert.strictEqual(wantsExchangeMf, true);
  });

  it('exchangeFilter="NSE" → wantsExchangeNseBse=true, wantsExchangeMf=false', () => {
    const { wantsExchangeNseBse, wantsExchangeMf } =
      computeExchangeFilters("NSE");
    assert.strictEqual(wantsExchangeNseBse, true);
    assert.strictEqual(wantsExchangeMf, false);
  });

  it('exchangeFilter="BSE" → wantsExchangeNseBse=true, wantsExchangeMf=false', () => {
    const { wantsExchangeNseBse, wantsExchangeMf } =
      computeExchangeFilters("BSE");
    assert.strictEqual(wantsExchangeNseBse, true);
    assert.strictEqual(wantsExchangeMf, false);
  });

  it('exchangeFilter="MF" → wantsExchangeNseBse=false, wantsExchangeMf=true', () => {
    const { wantsExchangeNseBse, wantsExchangeMf } =
      computeExchangeFilters("MF");
    assert.strictEqual(wantsExchangeNseBse, false);
    assert.strictEqual(wantsExchangeMf, true);
  });

  it("is case-insensitive (nse → same as NSE)", () => {
    const { wantsExchangeNseBse, wantsExchangeMf } =
      computeExchangeFilters("nse");
    assert.strictEqual(wantsExchangeNseBse, true);
    assert.strictEqual(wantsExchangeMf, false);
  });

  it("unknown exchange wants neither", () => {
    const { wantsExchangeNseBse, wantsExchangeMf } =
      computeExchangeFilters("NYSE");
    assert.strictEqual(wantsExchangeNseBse, false);
    assert.strictEqual(wantsExchangeMf, false);
  });
});

// ============== Limit handling ==============

describe("Limit handling", () => {
  it("default limit is 30 when param is null", () => {
    assert.strictEqual(computeSearchLimit(null), 30);
  });

  it('default limit is 30 when param is empty string ""', () => {
    assert.strictEqual(computeSearchLimit(""), 30);
  });

  it("max limit is capped at 100", () => {
    assert.strictEqual(computeSearchLimit("200"), 100);
    assert.strictEqual(computeSearchLimit("999"), 100);
    assert.strictEqual(computeSearchLimit("101"), 100);
  });

  it("limit=100 is allowed (not capped)", () => {
    assert.strictEqual(computeSearchLimit("100"), 100);
  });

  it("normal values pass through", () => {
    assert.strictEqual(computeSearchLimit("10"), 10);
    assert.strictEqual(computeSearchLimit("50"), 50);
    assert.strictEqual(computeSearchLimit("1"), 1);
  });

  it('parseInt("abc") → NaN → defaults to 30', () => {
    assert.strictEqual(computeSearchLimit("abc"), 30);
  });

  it('parseInt("0") → 0 which is falsy → defaults to 30', () => {
    assert.strictEqual(computeSearchLimit("0"), 30);
  });

  it("negative values are allowed (Math.min with 100 still returns negative)", () => {
    // parseInt("-5") = -5, -5 || 30 → -5 is truthy, Math.min(-5, 100) = -5
    // The route would just return no results for negative limit, so this is fine.
    assert.strictEqual(computeSearchLimit("-5"), -5);
  });
});

// ============== Instrument type → TV type mapping ==============

describe("Instrument type to TradingView type mapping", () => {
  it('ETF → "etf"', () => {
    assert.strictEqual(instrumentTypeToTvType("ETF"), "etf");
  });

  it('INDEX → "index"', () => {
    assert.strictEqual(instrumentTypeToTvType("INDEX"), "index");
  });

  it('EQUITY → "stock"', () => {
    assert.strictEqual(instrumentTypeToTvType("EQUITY"), "stock");
  });

  it('any other string → "stock" (fallback)', () => {
    assert.strictEqual(instrumentTypeToTvType("BOND"), "stock");
    assert.strictEqual(instrumentTypeToTvType("DERIVATIVE"), "stock");
    assert.strictEqual(instrumentTypeToTvType(""), "stock");
    assert.strictEqual(instrumentTypeToTvType("unknown"), "stock");
  });

  it("is case-sensitive (etf lowercase does NOT map to etf)", () => {
    // The source checks === "ETF", not case-insensitive
    assert.strictEqual(instrumentTypeToTvType("etf"), "stock");
    assert.strictEqual(instrumentTypeToTvType("index"), "stock");
  });
});

// ============== MF search query classification ==============

describe("MF search query classification", () => {
  it("numeric query → searches by schemeCode prefix", () => {
    assert.strictEqual(isNumericCode("120503"), true);
    assert.strictEqual(isNumericCode("0"), true);
    assert.strictEqual(isNumericCode("999999"), true);
  });

  it("non-numeric query → searches schemeName + amcName", () => {
    assert.strictEqual(isNumericCode("SBI"), false);
    assert.strictEqual(isNumericCode("HDFC Blue Chip"), false);
    assert.strictEqual(isNumericCode("axis"), false);
  });

  it("mixed alphanumeric is NOT numeric", () => {
    assert.strictEqual(isNumericCode("120abc"), false);
    assert.strictEqual(isNumericCode("SBI123"), false);
  });

  it("empty string is NOT numeric", () => {
    assert.strictEqual(isNumericCode(""), false);
  });

  it("string with spaces is NOT numeric", () => {
    assert.strictEqual(isNumericCode("120 503"), false);
  });

  it("decimal is NOT numeric (regex only matches digits)", () => {
    assert.strictEqual(isNumericCode("12.5"), false);
  });
});

// ============== MF result item shape ==============

describe("MF result items", () => {
  it('always have exchange="MF"', () => {
    const item = buildMfResultItem({
      schemeCode: "120503",
      schemeName: "SBI Blue Chip Fund",
      amcName: "SBI",
    });
    assert.strictEqual(item.exchange, "MF");
  });

  it('always have type="fund"', () => {
    const item = buildMfResultItem({
      schemeCode: "120503",
      schemeName: "SBI Blue Chip Fund",
      amcName: "SBI",
    });
    assert.strictEqual(item.type, "fund");
  });

  it("ticker uses MF: prefix", () => {
    const item = buildMfResultItem({
      schemeCode: "120503",
      schemeName: "SBI Blue Chip Fund",
      amcName: "SBI",
    });
    assert.strictEqual(item.ticker, "MF:120503");
  });

  it("description includes schemeName and amcName in parens", () => {
    const item = buildMfResultItem({
      schemeCode: "120503",
      schemeName: "SBI Blue Chip Fund - Regular Plan - Growth",
      amcName: "SBI Mutual Fund",
    });
    assert.strictEqual(
      item.description,
      "SBI Blue Chip Fund - Regular Plan - Growth (SBI Mutual Fund)"
    );
  });

  it("symbol is the schemeCode (not schemeName)", () => {
    const item = buildMfResultItem({
      schemeCode: "120503",
      schemeName: "SBI Blue Chip Fund",
      amcName: "SBI",
    });
    assert.strictEqual(item.symbol, "120503");
  });
});

// ============== Equity result filtering by specific type ==============

describe("Equity result type-specific filtering", () => {
  // The route gates each instrument: if (typeFilter && typeFilter !== tvType) skip.

  it('typeFilter="stock" includes EQUITY instruments', () => {
    assert.strictEqual(shouldIncludeEquity("stock", "EQUITY"), true);
  });

  it('typeFilter="stock" excludes ETF instruments', () => {
    assert.strictEqual(shouldIncludeEquity("stock", "ETF"), false);
  });

  it('typeFilter="stock" excludes INDEX instruments', () => {
    assert.strictEqual(shouldIncludeEquity("stock", "INDEX"), false);
  });

  it('typeFilter="etf" includes only ETF instruments', () => {
    assert.strictEqual(shouldIncludeEquity("etf", "ETF"), true);
    assert.strictEqual(shouldIncludeEquity("etf", "EQUITY"), false);
    assert.strictEqual(shouldIncludeEquity("etf", "INDEX"), false);
  });

  it('typeFilter="index" includes only INDEX instruments', () => {
    assert.strictEqual(shouldIncludeEquity("index", "INDEX"), true);
    assert.strictEqual(shouldIncludeEquity("index", "EQUITY"), false);
    assert.strictEqual(shouldIncludeEquity("index", "ETF"), false);
  });

  it('typeFilter="" (empty) includes all instruments', () => {
    assert.strictEqual(shouldIncludeEquity("", "EQUITY"), true);
    assert.strictEqual(shouldIncludeEquity("", "ETF"), true);
    assert.strictEqual(shouldIncludeEquity("", "INDEX"), true);
  });
});

// ============== Combined filter scenarios ==============

describe("Combined type + exchange filter scenarios", () => {
  function wouldSearchEquities(
    typeFilter: string,
    exchangeFilter: string
  ): boolean {
    const { wantsEquities } = computeTypeFilters(typeFilter);
    const { wantsExchangeNseBse } = computeExchangeFilters(exchangeFilter);
    return wantsEquities && wantsExchangeNseBse;
  }

  function wouldSearchFunds(
    typeFilter: string,
    exchangeFilter: string
  ): boolean {
    const { wantsFunds } = computeTypeFilters(typeFilter);
    const { wantsExchangeMf } = computeExchangeFilters(exchangeFilter);
    return wantsFunds && wantsExchangeMf;
  }

  it("no filters → searches both equities and funds", () => {
    assert.strictEqual(wouldSearchEquities("", ""), true);
    assert.strictEqual(wouldSearchFunds("", ""), true);
  });

  it('type=stock, exchange="" → equities only', () => {
    assert.strictEqual(wouldSearchEquities("stock", ""), true);
    assert.strictEqual(wouldSearchFunds("stock", ""), false);
  });

  it('type=fund, exchange="" → funds only', () => {
    assert.strictEqual(wouldSearchEquities("fund", ""), false);
    assert.strictEqual(wouldSearchFunds("fund", ""), true);
  });

  it('type="", exchange=NSE → equities only (MF excluded by exchange)', () => {
    assert.strictEqual(wouldSearchEquities("", "NSE"), true);
    assert.strictEqual(wouldSearchFunds("", "NSE"), false);
  });

  it('type="", exchange=MF → funds only (equities excluded by exchange)', () => {
    assert.strictEqual(wouldSearchEquities("", "MF"), false);
    assert.strictEqual(wouldSearchFunds("", "MF"), true);
  });

  it("type=fund, exchange=NSE → searches nothing (conflicting filters)", () => {
    assert.strictEqual(wouldSearchEquities("fund", "NSE"), false);
    assert.strictEqual(wouldSearchFunds("fund", "NSE"), false);
  });

  it("type=stock, exchange=MF → searches nothing (conflicting filters)", () => {
    assert.strictEqual(wouldSearchEquities("stock", "MF"), false);
    assert.strictEqual(wouldSearchFunds("stock", "MF"), false);
  });

  it("type=stock, exchange=BSE → equities on BSE only", () => {
    assert.strictEqual(wouldSearchEquities("stock", "BSE"), true);
    assert.strictEqual(wouldSearchFunds("stock", "BSE"), false);
  });
});

describe("instrumentTypeToTvType — DEBT (MONEY-1093)", () => {
  it("labels a bond a bond, not a stock", () => {
    // DEBT used to fall through to "stock", so a G-Sec appeared in the
    // TradingView symbol search as a share — on the surface where a user picks
    // what to trade. The value must match what the UDF config declares in
    // symbols_types, or the search filter cannot offer it.
    assert.equal(instrumentTypeToTvType("DEBT"), "bond");
  });

  it("leaves the other mappings alone", () => {
    assert.equal(instrumentTypeToTvType("ETF"), "etf");
    assert.equal(instrumentTypeToTvType("INDEX"), "index");
    assert.equal(instrumentTypeToTvType("EQUITY"), "stock");
    assert.equal(instrumentTypeToTvType("ANYTHING_ELSE"), "stock");
  });
});

describe("MONEY-1177 — chart search resolves a retired ticker", () => {
  it("describes the rename so the result does not look like a mismatch", () => {
    const item = buildEquityResultItem(
      {
        symbol: "ETERNAL",
        exchange: "NSE",
        name: "Eternal Limited",
        instrumentType: "EQUITY",
        previousSymbols: ["ZOMATO"],
      },
      "ZOMATO"
    );
    assert.strictEqual(item.description, "Eternal Limited (formerly ZOMATO)");
    // The ticker itself must stay the CURRENT one — TradingView uses it to
    // resolve the symbol and fetch history.
    assert.strictEqual(item.ticker, "NSE:ETERNAL");
    assert.strictEqual(item.symbol, "ETERNAL");
  });

  it("leaves a direct hit untouched, and works with no query at all", () => {
    const base = {
      symbol: "TCS",
      exchange: "NSE",
      name: "Tata Consultancy",
      instrumentType: "EQUITY",
    };
    assert.strictEqual(
      buildEquityResultItem(base, "TCS").description,
      "Tata Consultancy"
    );
    assert.strictEqual(
      buildEquityResultItem(base).description,
      "Tata Consultancy"
    );
  });
});
