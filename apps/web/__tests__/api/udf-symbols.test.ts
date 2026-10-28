/**
 * TradingView UDF - Symbol Resolution Endpoint - REAL logic tests.
 *
 * Exercises the ACTUAL exported pure helpers the GET /api/market/udf/symbols
 * handler calls (from `@/app/api/market/udf/symbols/symbols-logic`):
 *
 * - `computeSupportedResolutions` — per-symbol resolution gating by type +
 *   broker-credential status (the Zerodha-only 3m/10m gate)
 * - `parseSymbolPrefix`           — "EXCHANGE:SYMBOL" → prefix + rawSymbol
 * - `isUnsupportedEquityExchange` — NSE/BSE/MF allow-gate
 * - `buildEquitySymbolInfo` / `buildIndexSymbolInfo` / `buildFundSymbolInfo`
 *   — the `LibrarySymbolInfo` builders
 * - `ALL_INTRADAY_RESOLUTIONS` / `ZERODHA_ONLY_RESOLUTIONS` / `DAILY_RESOLUTIONS`
 *
 * (Replaces the previous SHADOW version, which re-declared all of these inline
 * and asserted the copies. The resolution gate + builders were INLINE in
 * route.ts and untestable behind Clerk/Prisma; route.ts now imports & calls
 * them, so this asserts the same code production runs.)
 *
 * Source: apps/web/app/api/market/udf/symbols/route.ts
 *         apps/web/app/api/market/udf/symbols/symbols-logic.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  type ResolvedSymbol,
  ALL_INTRADAY_RESOLUTIONS,
  ZERODHA_ONLY_RESOLUTIONS,
  DAILY_RESOLUTIONS,
  computeSupportedResolutions,
  parseSymbolPrefix,
  isUnsupportedEquityExchange,
  buildEquitySymbolInfo,
  buildIndexSymbolInfo,
  buildFundSymbolInfo,
} from "@/app/api/market/udf/symbols/symbols-logic";

// ============== Test helpers (thin wrappers over the REAL builders) ==========

function buildStockSymbol(
  symbol: string,
  exchange: string,
  hasBrokerCreds: boolean
): ResolvedSymbol {
  return buildEquitySymbolInfo({
    symbol,
    exchange,
    description: symbol,
    type: "stock",
    hasBrokerCreds,
  });
}

function buildEtfSymbol(
  symbol: string,
  exchange: string,
  hasBrokerCreds: boolean
): ResolvedSymbol {
  return buildEquitySymbolInfo({
    symbol,
    exchange,
    description: symbol,
    type: "etf",
    hasBrokerCreds,
  });
}

function buildIndexSymbol(
  symbol: string,
  exchange: string,
  hasBrokerCreds: boolean
): ResolvedSymbol {
  return buildIndexSymbolInfo({
    symbol,
    exchange,
    description: symbol,
    hasBrokerCreds,
  });
}

function buildFundSymbol(
  schemeCode: string,
  schemeName: string,
  amcName: string,
  hasBrokerCreds: boolean
): ResolvedSymbol {
  return buildFundSymbolInfo({
    schemeCode,
    schemeName,
    amcName,
    hasBrokerCreds,
  });
}

// ============== computeSupportedResolutions ==============

describe("computeSupportedResolutions", () => {
  describe("fund type", () => {
    it("returns only daily resolutions regardless of broker creds", () => {
      assert.deepStrictEqual(computeSupportedResolutions("fund", false), [
        "1D",
        "1W",
        "1M",
      ]);
      assert.deepStrictEqual(computeSupportedResolutions("fund", true), [
        "1D",
        "1W",
        "1M",
      ]);
    });

    it("does not include any intraday resolutions", () => {
      const result = computeSupportedResolutions("fund", true);
      for (const r of ALL_INTRADAY_RESOLUTIONS) {
        assert.ok(
          !result.includes(r),
          `fund should not include intraday "${r}"`
        );
      }
    });
  });

  describe("index type", () => {
    it("returns intraday (minus Zerodha-only 3,10) + daily", () => {
      const expected = ["1", "5", "15", "30", "60", "1D", "1W", "1M"];
      assert.deepStrictEqual(
        computeSupportedResolutions("index", false),
        expected
      );
    });

    it("excludes 3 and 10 even WITH broker creds", () => {
      const result = computeSupportedResolutions("index", true);
      assert.ok(!result.includes("3"), "index should not include 3");
      assert.ok(!result.includes("10"), "index should not include 10");
    });

    it("returns the same resolutions regardless of broker creds", () => {
      assert.deepStrictEqual(
        computeSupportedResolutions("index", false),
        computeSupportedResolutions("index", true)
      );
    });
  });

  describe("stock type WITHOUT broker creds", () => {
    it("returns intraday (minus 3,10) + daily", () => {
      const expected = ["1", "5", "15", "30", "60", "1D", "1W", "1M"];
      assert.deepStrictEqual(
        computeSupportedResolutions("stock", false),
        expected
      );
    });

    it("does not include Zerodha-only resolutions", () => {
      const result = computeSupportedResolutions("stock", false);
      assert.ok(
        !result.includes("3"),
        "stock without creds should not include 3"
      );
      assert.ok(
        !result.includes("10"),
        "stock without creds should not include 10"
      );
    });
  });

  describe("stock type WITH broker creds", () => {
    it("returns ALL intraday + daily (including 3 and 10)", () => {
      const expected = [
        "1",
        "3",
        "5",
        "10",
        "15",
        "30",
        "60",
        "1D",
        "1W",
        "1M",
      ];
      assert.deepStrictEqual(
        computeSupportedResolutions("stock", true),
        expected
      );
    });

    it("includes Zerodha-only resolutions 3 and 10", () => {
      const result = computeSupportedResolutions("stock", true);
      assert.ok(result.includes("3"), "stock with creds should include 3");
      assert.ok(result.includes("10"), "stock with creds should include 10");
    });
  });

  describe("etf type behaves same as stock", () => {
    it("without broker creds matches stock without broker creds", () => {
      assert.deepStrictEqual(
        computeSupportedResolutions("etf", false),
        computeSupportedResolutions("stock", false)
      );
    });

    it("with broker creds matches stock with broker creds", () => {
      assert.deepStrictEqual(
        computeSupportedResolutions("etf", true),
        computeSupportedResolutions("stock", true)
      );
    });

    it("includes 3 and 10 only with broker creds", () => {
      const withCreds = computeSupportedResolutions("etf", true);
      const withoutCreds = computeSupportedResolutions("etf", false);
      assert.ok(withCreds.includes("3"));
      assert.ok(withCreds.includes("10"));
      assert.ok(!withoutCreds.includes("3"));
      assert.ok(!withoutCreds.includes("10"));
    });
  });
});

// ============== Symbol prefix parsing ==============

describe("Symbol prefix parsing", () => {
  it('parses "NSE:TCS" into exchange=NSE, symbol=TCS', () => {
    const { prefix, rawSymbol } = parseSymbolPrefix("NSE:TCS");
    assert.strictEqual(prefix, "NSE");
    assert.strictEqual(rawSymbol, "TCS");
  });

  it('parses "BSE:RELIANCE" into exchange=BSE, symbol=RELIANCE', () => {
    const { prefix, rawSymbol } = parseSymbolPrefix("BSE:RELIANCE");
    assert.strictEqual(prefix, "BSE");
    assert.strictEqual(rawSymbol, "RELIANCE");
  });

  it('parses "MF:120503" into prefix=MF, rawSymbol=120503', () => {
    const { prefix, rawSymbol } = parseSymbolPrefix("MF:120503");
    assert.strictEqual(prefix, "MF");
    assert.strictEqual(rawSymbol, "120503");
  });

  it('parses "TCS" (no colon) and defaults to exchange=NSE', () => {
    const { prefix, rawSymbol } = parseSymbolPrefix("TCS");
    assert.strictEqual(prefix, "NSE");
    assert.strictEqual(rawSymbol, "TCS");
  });

  it('parses "UNKNOWN:TCS" into prefix=UNKNOWN (route rejects this later)', () => {
    const { prefix, rawSymbol } = parseSymbolPrefix("UNKNOWN:TCS");
    assert.strictEqual(prefix, "UNKNOWN");
    assert.strictEqual(rawSymbol, "TCS");
    assert.notStrictEqual(prefix, "NSE");
    assert.notStrictEqual(prefix, "BSE");
  });

  it("handles multi-colon edge case (only splits on first colon)", () => {
    const { prefix, rawSymbol } = parseSymbolPrefix("FOO:BAR:BAZ");
    assert.strictEqual(prefix, "FOO");
    assert.strictEqual(rawSymbol, "BAR:BAZ");
  });

  it("handles empty symbol after colon", () => {
    const { prefix, rawSymbol } = parseSymbolPrefix("NSE:");
    assert.strictEqual(prefix, "NSE");
    assert.strictEqual(rawSymbol, "");
  });

  it("handles empty string (no colon) → defaults to NSE with empty symbol", () => {
    const { prefix, rawSymbol } = parseSymbolPrefix("");
    assert.strictEqual(prefix, "NSE");
    assert.strictEqual(rawSymbol, "");
  });
});

// ============== ResolvedSymbol shape for each type ==============

describe("ResolvedSymbol shape", () => {
  describe("stock type", () => {
    it("has IST trading session, has_intraday=true, has_no_volume=false", () => {
      const sym = buildStockSymbol("TCS", "NSE", false);
      assert.strictEqual(sym.session, "0915-1530");
      assert.strictEqual(sym.timezone, "Asia/Kolkata");
      assert.strictEqual(sym.has_intraday, true);
      assert.strictEqual(sym.has_no_volume, false);
    });

    it("does not have visible_plots_set", () => {
      const sym = buildStockSymbol("TCS", "NSE", false);
      assert.strictEqual(sym.visible_plots_set, undefined);
    });

    it("has format='price', minmov=1, pricescale=100", () => {
      const sym = buildStockSymbol("TCS", "NSE", false);
      assert.strictEqual(sym.format, "price");
      assert.strictEqual(sym.minmov, 1);
      assert.strictEqual(sym.pricescale, 100);
    });

    it("has data_status='endofday' without broker creds", () => {
      const sym = buildStockSymbol("TCS", "NSE", false);
      assert.strictEqual(sym.data_status, "endofday");
    });

    it("has data_status='delayed_streaming' with broker creds", () => {
      const sym = buildStockSymbol("TCS", "NSE", true);
      assert.strictEqual(sym.data_status, "delayed_streaming");
    });

    it("builds full_name and ticker as EXCHANGE:SYMBOL", () => {
      const sym = buildStockSymbol("RELIANCE", "BSE", false);
      assert.strictEqual(sym.full_name, "BSE:RELIANCE");
      assert.strictEqual(sym.ticker, "BSE:RELIANCE");
      assert.strictEqual(sym.exchange, "BSE");
    });
  });

  describe("etf type", () => {
    it("has same session/timezone/intraday as stock", () => {
      const etf = buildEtfSymbol("NIFTYBEES", "NSE", false);
      const stock = buildStockSymbol("TCS", "NSE", false);
      assert.strictEqual(etf.session, stock.session);
      assert.strictEqual(etf.timezone, stock.timezone);
      assert.strictEqual(etf.has_intraday, stock.has_intraday);
      assert.strictEqual(etf.has_no_volume, stock.has_no_volume);
    });

    it("type field is 'etf'", () => {
      const sym = buildEtfSymbol("NIFTYBEES", "NSE", false);
      assert.strictEqual(sym.type, "etf");
    });

    it("has pricescale=100 (same as stock)", () => {
      const sym = buildEtfSymbol("NIFTYBEES", "NSE", false);
      assert.strictEqual(sym.pricescale, 100);
    });
  });

  describe("fund type", () => {
    it("has session='24x7' and has_intraday=false", () => {
      const sym = buildFundSymbol("120503", "SBI Blue Chip Fund", "SBI", false);
      assert.strictEqual(sym.session, "24x7");
      assert.strictEqual(sym.has_intraday, false);
    });

    it("has pricescale=10000 (4 decimal places for NAV)", () => {
      const sym = buildFundSymbol("120503", "SBI Blue Chip Fund", "SBI", false);
      assert.strictEqual(sym.pricescale, 10000);
    });

    it("has has_no_volume=true and visible_plots_set='c'", () => {
      const sym = buildFundSymbol("120503", "SBI Blue Chip Fund", "SBI", false);
      assert.strictEqual(sym.has_no_volume, true);
      assert.strictEqual(sym.visible_plots_set, "c");
    });

    it("has data_status='endofday'", () => {
      const sym = buildFundSymbol("120503", "SBI Blue Chip Fund", "SBI", false);
      assert.strictEqual(sym.data_status, "endofday");
    });

    it("uses amcName as listed_exchange, or fallback to 'MF'", () => {
      const withAmc = buildFundSymbol(
        "120503",
        "SBI Blue Chip Fund",
        "SBI Mutual Fund",
        false
      );
      assert.strictEqual(withAmc.listed_exchange, "SBI Mutual Fund");

      const withoutAmc = buildFundSymbol(
        "120503",
        "SBI Blue Chip Fund",
        "",
        false
      );
      assert.strictEqual(withoutAmc.listed_exchange, "MF");
    });

    it("ticker and full_name use MF: prefix", () => {
      const sym = buildFundSymbol("120503", "SBI Blue Chip Fund", "SBI", false);
      assert.strictEqual(sym.ticker, "MF:120503");
      assert.strictEqual(sym.full_name, "MF:120503");
      assert.strictEqual(sym.exchange, "MF");
    });

    it("name is the schemeCode, description is the schemeName", () => {
      const sym = buildFundSymbol("120503", "SBI Blue Chip Fund", "SBI", false);
      assert.strictEqual(sym.name, "120503");
      assert.strictEqual(sym.description, "SBI Blue Chip Fund");
    });
  });

  describe("index type", () => {
    it("has has_no_volume=true and visible_plots_set='c'", () => {
      const sym = buildIndexSymbol("NIFTY50", "NSE", false);
      assert.strictEqual(sym.has_no_volume, true);
      assert.strictEqual(sym.visible_plots_set, "c");
    });

    it("has data_status='delayed_streaming'", () => {
      const sym = buildIndexSymbol("NIFTY50", "NSE", false);
      assert.strictEqual(sym.data_status, "delayed_streaming");
    });

    it("has has_intraday=true (indices get Yahoo intraday data)", () => {
      const sym = buildIndexSymbol("NIFTY50", "NSE", false);
      assert.strictEqual(sym.has_intraday, true);
    });

    it("has IST trading session like stocks", () => {
      const sym = buildIndexSymbol("NIFTY50", "NSE", false);
      assert.strictEqual(sym.session, "0915-1530");
      assert.strictEqual(sym.timezone, "Asia/Kolkata");
    });
  });
});

// ============== Constants ==============

describe("Constants", () => {
  it("ALL_INTRADAY_RESOLUTIONS has 7 entries", () => {
    assert.strictEqual(ALL_INTRADAY_RESOLUTIONS.length, 7);
    assert.deepStrictEqual(ALL_INTRADAY_RESOLUTIONS, [
      "1",
      "3",
      "5",
      "10",
      "15",
      "30",
      "60",
    ]);
  });

  it("ZERODHA_ONLY_RESOLUTIONS contains exactly 3 and 10", () => {
    assert.strictEqual(ZERODHA_ONLY_RESOLUTIONS.size, 2);
    assert.ok(ZERODHA_ONLY_RESOLUTIONS.has("3"));
    assert.ok(ZERODHA_ONLY_RESOLUTIONS.has("10"));
    assert.ok(!ZERODHA_ONLY_RESOLUTIONS.has("1"));
    assert.ok(!ZERODHA_ONLY_RESOLUTIONS.has("5"));
  });

  it("DAILY_RESOLUTIONS has 3 entries", () => {
    assert.strictEqual(DAILY_RESOLUTIONS.length, 3);
    assert.deepStrictEqual(DAILY_RESOLUTIONS, ["1D", "1W", "1M"]);
  });
});

// ============== Unsupported exchange logic ==============

describe("Unsupported exchange prefix detection", () => {
  it("NSE is supported", () => {
    assert.strictEqual(isUnsupportedEquityExchange("NSE"), false);
  });

  it("BSE is supported", () => {
    assert.strictEqual(isUnsupportedEquityExchange("BSE"), false);
  });

  it("MF is handled separately (not unsupported)", () => {
    assert.strictEqual(isUnsupportedEquityExchange("MF"), false);
  });

  it("UNKNOWN is unsupported", () => {
    assert.strictEqual(isUnsupportedEquityExchange("UNKNOWN"), true);
  });

  it("NYSE is unsupported", () => {
    assert.strictEqual(isUnsupportedEquityExchange("NYSE"), true);
  });

  it("empty string is unsupported", () => {
    assert.strictEqual(isUnsupportedEquityExchange(""), true);
  });
});
