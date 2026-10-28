/**
 * Instrument Types & Constants Tests
 *
 * Tests the REAL instrument type definitions and constants:
 *   packages/core/src/market-data/instruments/types.ts
 *     → SUPPORTED_EXCHANGES, YAHOO_SUFFIX_MAP
 *   packages/core/src/market-data/instruments/zerodha-instruments.ts
 *     → buildYahooSymbolForInstrument, isETF, ETF_SUFFIX_PATTERNS, KNOWN_ETF_SYMBOLS
 *
 * Imports the real exports (no inline reimplementation). The pure helpers are
 * re-exported from zerodha-instruments and consumed by the provider, so this is
 * the exact code production runs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_EXCHANGES,
  YAHOO_SUFFIX_MAP,
  buildYahooSymbolForInstrument,
} from "@usemoney/core/market-data";
import {
  isETF,
  ETF_SUFFIX_PATTERNS,
  KNOWN_ETF_SYMBOLS,
} from "@usemoney/core/market-data/instruments/zerodha-instruments-logic";

describe("Instrument Types & Constants (real source)", () => {
  // ────────────────────────────────────────────────────────────────
  // SUPPORTED_EXCHANGES
  // ────────────────────────────────────────────────────────────────
  describe("SUPPORTED_EXCHANGES", () => {
    it("should contain exactly 5 exchanges", () => {
      assert.strictEqual(SUPPORTED_EXCHANGES.length, 5);
    });

    it("should include NSE (National Stock Exchange)", () => {
      assert.ok(SUPPORTED_EXCHANGES.includes("NSE"));
    });

    it("should include BSE (Bombay Stock Exchange)", () => {
      assert.ok(SUPPORTED_EXCHANGES.includes("BSE"));
    });

    it("should include NFO (NSE F&O)", () => {
      assert.ok(SUPPORTED_EXCHANGES.includes("NFO"));
    });

    it("should include BFO (BSE F&O)", () => {
      assert.ok(SUPPORTED_EXCHANGES.includes("BFO"));
    });

    it("should include MCX (Multi Commodity Exchange)", () => {
      assert.ok(SUPPORTED_EXCHANGES.includes("MCX"));
    });

    it("should NOT include CDS (Currency Derivatives)", () => {
      assert.ok(!(SUPPORTED_EXCHANGES as readonly string[]).includes("CDS"));
    });

    it("should NOT include NCDEX", () => {
      assert.ok(!(SUPPORTED_EXCHANGES as readonly string[]).includes("NCDEX"));
    });

    it("should have all values as uppercase strings", () => {
      for (const exchange of SUPPORTED_EXCHANGES) {
        assert.strictEqual(exchange, exchange.toUpperCase());
        assert.strictEqual(typeof exchange, "string");
      }
    });

    it("should have no duplicate entries", () => {
      const uniqueExchanges = new Set(SUPPORTED_EXCHANGES);
      assert.strictEqual(uniqueExchanges.size, SUPPORTED_EXCHANGES.length);
    });

    it("should have NSE as the first entry", () => {
      assert.strictEqual(SUPPORTED_EXCHANGES[0], "NSE");
    });

    it("should have BSE as the second entry", () => {
      assert.strictEqual(SUPPORTED_EXCHANGES[1], "BSE");
    });

    it("should have MCX as the last entry", () => {
      assert.strictEqual(
        SUPPORTED_EXCHANGES[SUPPORTED_EXCHANGES.length - 1],
        "MCX"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // YAHOO_SUFFIX_MAP
  // ────────────────────────────────────────────────────────────────
  describe("YAHOO_SUFFIX_MAP", () => {
    it("should have exactly 2 entries", () => {
      assert.strictEqual(Object.keys(YAHOO_SUFFIX_MAP).length, 2);
    });

    it("should map NSE to .NS", () => {
      assert.strictEqual(YAHOO_SUFFIX_MAP["NSE"], ".NS");
    });

    it("should map BSE to .BO", () => {
      assert.strictEqual(YAHOO_SUFFIX_MAP["BSE"], ".BO");
    });

    it("should NOT have a mapping for NFO", () => {
      assert.strictEqual(YAHOO_SUFFIX_MAP["NFO"], undefined);
    });

    it("should NOT have a mapping for BFO", () => {
      assert.strictEqual(YAHOO_SUFFIX_MAP["BFO"], undefined);
    });

    it("should NOT have a mapping for MCX", () => {
      assert.strictEqual(YAHOO_SUFFIX_MAP["MCX"], undefined);
    });

    it("should have suffix values starting with a dot", () => {
      for (const suffix of Object.values(YAHOO_SUFFIX_MAP)) {
        assert.ok(
          suffix.startsWith("."),
          `Suffix "${suffix}" should start with a dot`
        );
      }
    });

    it("should have suffix values of 3 characters (.XX)", () => {
      for (const [exchange, suffix] of Object.entries(YAHOO_SUFFIX_MAP)) {
        assert.strictEqual(
          suffix.length,
          3,
          `Suffix for ${exchange} should be 3 chars, got "${suffix}"`
        );
      }
    });
  });

  // ────────────────────────────────────────────────────────────────
  // buildYahooSymbolForInstrument - NSE stocks
  // ────────────────────────────────────────────────────────────────
  describe("buildYahooSymbolForInstrument - NSE stocks", () => {
    it("should build RELIANCE.NS for NSE EQUITY", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("RELIANCE", "NSE", "EQUITY"),
        "RELIANCE.NS"
      );
    });

    it("should build TCS.NS for NSE EQUITY", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("TCS", "NSE", "EQUITY"),
        "TCS.NS"
      );
    });

    it("should build INFY.NS for NSE EQUITY", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("INFY", "NSE", "EQUITY"),
        "INFY.NS"
      );
    });

    it("should build HDFCBANK.NS for NSE EQUITY", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("HDFCBANK", "NSE", "EQUITY"),
        "HDFCBANK.NS"
      );
    });

    it("should build M&M.NS for NSE EQUITY (symbol with ampersand)", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("M&M", "NSE", "EQUITY"),
        "M&M.NS"
      );
    });

    it("should build NIFTYBEES.NS for NSE ETF", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("NIFTYBEES", "NSE", "ETF"),
        "NIFTYBEES.NS"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // buildYahooSymbolForInstrument - BSE stocks
  // ────────────────────────────────────────────────────────────────
  describe("buildYahooSymbolForInstrument - BSE stocks", () => {
    it("should build TCS.BO for BSE EQUITY", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("TCS", "BSE", "EQUITY"),
        "TCS.BO"
      );
    });

    it("should build RELIANCE.BO for BSE EQUITY", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("RELIANCE", "BSE", "EQUITY"),
        "RELIANCE.BO"
      );
    });

    it("should build GOLDBEES.BO for BSE ETF", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("GOLDBEES", "BSE", "ETF"),
        "GOLDBEES.BO"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // buildYahooSymbolForInstrument - F&O and INDEX (empty results)
  // ────────────────────────────────────────────────────────────────
  describe("buildYahooSymbolForInstrument - F&O and INDEX", () => {
    it("should return empty string for FUTURES", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("NIFTY", "NFO", "FUTURES"),
        ""
      );
    });

    it("should return empty string for OPTIONS", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("RELIANCE", "NFO", "OPTIONS"),
        ""
      );
    });

    it("should return empty string for INDEX", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("NIFTY 50", "NSE", "INDEX"),
        ""
      );
    });

    it("should return empty for FUTURES on MCX", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("GOLD", "MCX", "FUTURES"),
        ""
      );
    });

    it("should return empty for OPTIONS on BFO", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("BANKNIFTY", "BFO", "OPTIONS"),
        ""
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // buildYahooSymbolForInstrument - Edge cases
  // ────────────────────────────────────────────────────────────────
  describe("buildYahooSymbolForInstrument - Edge cases", () => {
    it("should default to .NS for unknown exchange with EQUITY type", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("STOCK", "UNKNOWN", "EQUITY"),
        "STOCK.NS"
      );
    });

    it("should default to .NS for empty exchange with EQUITY type", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("STOCK", "", "EQUITY"),
        "STOCK.NS"
      );
    });

    it("should handle empty symbol with NSE exchange", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("", "NSE", "EQUITY"),
        ".NS"
      );
    });

    it("should handle symbol with hyphens", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("KESORAMIND-BE", "NSE", "EQUITY"),
        "KESORAMIND-BE.NS"
      );
    });

    it("should handle single character symbol", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("A", "NSE", "EQUITY"),
        "A.NS"
      );
    });

    it("should handle numeric-like symbol", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("3MINDIA", "NSE", "EQUITY"),
        "3MINDIA.NS"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // ETF Detection patterns
  // ────────────────────────────────────────────────────────────────
  describe("ETF Detection", () => {
    it("should detect all KNOWN_ETF_SYMBOLS", () => {
      for (const symbol of Array.from(KNOWN_ETF_SYMBOLS)) {
        assert.strictEqual(
          isETF(symbol, ""),
          true,
          `Known ETF "${symbol}" should be detected`
        );
      }
    });

    it("should have exactly 48 known ETF symbols", () => {
      assert.strictEqual(KNOWN_ETF_SYMBOLS.size, 48);
    });

    it("should have 3 ETF suffix patterns", () => {
      assert.strictEqual(ETF_SUFFIX_PATTERNS.length, 3);
    });

    it("should detect any symbol ending with BEES via suffix pattern", () => {
      assert.strictEqual(isETF("NEWBEES", "Some Name"), true);
      assert.strictEqual(isETF("XBEES", "Some Name"), true);
    });

    it("should detect any symbol ending with ETF via suffix pattern", () => {
      assert.strictEqual(isETF("NEWETF", "Some Name"), true);
    });

    it("should NOT detect regular stocks as ETF", () => {
      assert.strictEqual(isETF("RELIANCE", "Reliance Industries"), false);
      assert.strictEqual(isETF("TCS", "Tata Consultancy Services"), false);
      assert.strictEqual(isETF("INFY", "Infosys Limited"), false);
      assert.strictEqual(isETF("HDFCBANK", "HDFC Bank"), false);
    });

    it("should be case-insensitive for symbol checks", () => {
      assert.strictEqual(isETF("niftybees", ""), true);
      assert.strictEqual(isETF("GoldBees", ""), true);
      assert.strictEqual(isETF("liquidbees", ""), true);
    });

    it("should detect via name containing ' ETF'", () => {
      assert.strictEqual(isETF("UNKNOWN", "SBI Nifty 50 ETF"), true);
    });

    it("should detect via name containing 'Exchange Traded Fund'", () => {
      assert.strictEqual(isETF("UNKNOWN", "SBI Exchange Traded Fund"), true);
    });

    it("should NOT detect name with 'Effluent' (no ' ETF' match)", () => {
      assert.strictEqual(isETF("WASTECORP", "Waste Effluent Treatment"), false);
    });
  });
});
