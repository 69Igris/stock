/**
 * Symbol Mapper Tests
 *
 * Tests for NSE/BSE to Yahoo Finance symbol mapping.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  toYahooSymbol,
  fromYahooSymbol,
  toYahooSymbols,
  isIndex,
  isValidSymbol,
  normalizeSymbol,
  getAvailableIndices,
  getPopularYahooSymbols,
  INDEX_MAPPINGS,
  POPULAR_STOCKS,
} from "../../lib/market/symbol-mapper";

describe("Symbol Mapper", () => {
  describe("toYahooSymbol", () => {
    it("should convert NSE stock to Yahoo format", () => {
      const result = toYahooSymbol("RELIANCE", "NSE");
      assert.strictEqual(result, "RELIANCE.NS");
    });

    it("should convert BSE stock to Yahoo format", () => {
      const result = toYahooSymbol("RELIANCE", "BSE");
      assert.strictEqual(result, "RELIANCE.BO");
    });

    it("should default to NSE exchange", () => {
      const result = toYahooSymbol("TCS");
      assert.strictEqual(result, "TCS.NS");
    });

    it("should handle lowercase symbols", () => {
      const result = toYahooSymbol("infy", "NSE");
      assert.strictEqual(result, "INFY.NS");
    });

    it("should handle symbols with whitespace", () => {
      const result = toYahooSymbol("  HDFC  ", "NSE");
      assert.strictEqual(result, "HDFC.NS");
    });

    it("should convert NIFTY 50 to Yahoo index symbol", () => {
      const result = toYahooSymbol("NIFTY 50");
      assert.strictEqual(result, "^NSEI");
    });

    it("should convert SENSEX to Yahoo index symbol", () => {
      const result = toYahooSymbol("SENSEX");
      assert.strictEqual(result, "^BSESN");
    });

    it("should convert BANKNIFTY to Yahoo index symbol", () => {
      const result = toYahooSymbol("BANKNIFTY");
      assert.strictEqual(result, "^NSEBANK");
    });

    it("should convert NIFTY BANK to Yahoo index symbol", () => {
      const result = toYahooSymbol("NIFTY BANK");
      assert.strictEqual(result, "^NSEBANK");
    });

    it("should return already formatted Yahoo NSE symbol unchanged", () => {
      const result = toYahooSymbol("RELIANCE.NS");
      assert.strictEqual(result, "RELIANCE.NS");
    });

    it("should return already formatted Yahoo BSE symbol unchanged", () => {
      const result = toYahooSymbol("RELIANCE.BO");
      assert.strictEqual(result, "RELIANCE.BO");
    });

    it("should return Yahoo index symbol unchanged", () => {
      const result = toYahooSymbol("^NSEI");
      assert.strictEqual(result, "^NSEI");
    });

    it("should handle NIFTY IT index", () => {
      const result = toYahooSymbol("NIFTY IT");
      assert.strictEqual(result, "^CNXIT");
    });

    it("should handle INDIA VIX index", () => {
      const result = toYahooSymbol("INDIA VIX");
      assert.strictEqual(result, "^INDIAVIX");
    });
  });

  describe("fromYahooSymbol", () => {
    it("should parse NSE Yahoo symbol", () => {
      const result = fromYahooSymbol("RELIANCE.NS");
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.exchange, "NSE");
      assert.strictEqual(result.yahooSymbol, "RELIANCE.NS");
    });

    it("should parse BSE Yahoo symbol", () => {
      const result = fromYahooSymbol("RELIANCE.BO");
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.exchange, "BSE");
      assert.strictEqual(result.yahooSymbol, "RELIANCE.BO");
    });

    it("should parse NIFTY index symbol", () => {
      const result = fromYahooSymbol("^NSEI");
      assert.strictEqual(result.symbol, "NIFTY 50");
      assert.strictEqual(result.exchange, "NSE");
      assert.strictEqual(result.yahooSymbol, "^NSEI");
    });

    it("should parse SENSEX index symbol", () => {
      const result = fromYahooSymbol("^BSESN");
      assert.strictEqual(result.symbol, "SENSEX");
      assert.strictEqual(result.exchange, "BSE");
      assert.strictEqual(result.yahooSymbol, "^BSESN");
    });

    it("should parse BANK NIFTY index symbol", () => {
      const result = fromYahooSymbol("^NSEBANK");
      assert.strictEqual(result.symbol, "NIFTY BANK");
      assert.strictEqual(result.exchange, "NSE");
    });

    it("should handle unknown index symbol", () => {
      const result = fromYahooSymbol("^UNKNOWN");
      assert.strictEqual(result.symbol, "^UNKNOWN");
      assert.strictEqual(result.exchange, "NSE");
      assert.strictEqual(result.yahooSymbol, "^UNKNOWN");
    });

    it("should handle symbol without suffix as NSE", () => {
      const result = fromYahooSymbol("RELIANCE");
      assert.strictEqual(result.symbol, "RELIANCE");
      assert.strictEqual(result.exchange, "NSE");
    });
  });

  describe("toYahooSymbols", () => {
    it("should convert array of symbols to Yahoo format", () => {
      const result = toYahooSymbols(["RELIANCE", "TCS", "INFY"], "NSE");
      assert.deepStrictEqual(result, ["RELIANCE.NS", "TCS.NS", "INFY.NS"]);
    });

    it("should convert array of symbols to BSE format", () => {
      const result = toYahooSymbols(["RELIANCE", "TCS"], "BSE");
      assert.deepStrictEqual(result, ["RELIANCE.BO", "TCS.BO"]);
    });

    it("should handle empty array", () => {
      const result = toYahooSymbols([]);
      assert.deepStrictEqual(result, []);
    });

    it("should handle mixed indices and stocks", () => {
      const result = toYahooSymbols(["RELIANCE", "NIFTY 50", "TCS"], "NSE");
      assert.deepStrictEqual(result, ["RELIANCE.NS", "^NSEI", "TCS.NS"]);
    });
  });

  describe("isIndex", () => {
    it("should return true for NIFTY 50", () => {
      assert.strictEqual(isIndex("NIFTY 50"), true);
    });

    it("should return true for SENSEX", () => {
      assert.strictEqual(isIndex("SENSEX"), true);
    });

    it("should return true for BANKNIFTY", () => {
      assert.strictEqual(isIndex("BANKNIFTY"), true);
    });

    it("should return true for Yahoo index format", () => {
      assert.strictEqual(isIndex("^NSEI"), true);
    });

    it("should return false for regular stock", () => {
      assert.strictEqual(isIndex("RELIANCE"), false);
    });

    it("should return false for stock with Yahoo suffix", () => {
      assert.strictEqual(isIndex("RELIANCE.NS"), false);
    });

    it("should handle case insensitivity", () => {
      assert.strictEqual(isIndex("nifty 50"), true);
      assert.strictEqual(isIndex("sensex"), true);
    });
  });

  describe("isValidSymbol", () => {
    it("should return true for valid stock symbol", () => {
      assert.strictEqual(isValidSymbol("RELIANCE"), true);
    });

    it("should return true for symbol with numbers", () => {
      assert.strictEqual(isValidSymbol("M&M"), true);
    });

    it("should return true for symbol with hyphen", () => {
      assert.strictEqual(isValidSymbol("HDFC-BE"), true);
    });

    it("should return true for symbol with underscore", () => {
      assert.strictEqual(isValidSymbol("NIFTY_50"), true);
    });

    it("should return true for index name with space", () => {
      assert.strictEqual(isValidSymbol("NIFTY 50"), true);
    });

    it("should return false for empty string", () => {
      assert.strictEqual(isValidSymbol(""), false);
    });

    it("should return false for symbol with special characters", () => {
      assert.strictEqual(isValidSymbol("RELI@NCE"), false);
    });

    it("should return false for symbol with dollar sign", () => {
      assert.strictEqual(isValidSymbol("$RELIANCE"), false);
    });
  });

  describe("normalizeSymbol", () => {
    it("should convert to uppercase", () => {
      assert.strictEqual(normalizeSymbol("reliance"), "RELIANCE");
    });

    it("should trim whitespace", () => {
      assert.strictEqual(normalizeSymbol("  RELIANCE  "), "RELIANCE");
    });

    it("should normalize multiple spaces", () => {
      assert.strictEqual(normalizeSymbol("NIFTY  50"), "NIFTY 50");
    });

    it("should handle mixed case and whitespace", () => {
      assert.strictEqual(normalizeSymbol("  nifty   50  "), "NIFTY 50");
    });
  });

  describe("getAvailableIndices", () => {
    it("should return an array of indices", () => {
      const indices = getAvailableIndices();
      assert.ok(Array.isArray(indices));
      assert.ok(indices.length > 0);
    });

    it("should include NIFTY 50", () => {
      const indices = getAvailableIndices();
      const nifty = indices.find((i) => i.name === "NIFTY 50");
      assert.ok(nifty);
      assert.strictEqual(nifty?.yahooSymbol, "^NSEI");
    });

    it("should include SENSEX", () => {
      const indices = getAvailableIndices();
      const sensex = indices.find((i) => i.name === "SENSEX");
      assert.ok(sensex);
      assert.strictEqual(sensex?.yahooSymbol, "^BSESN");
    });

    it("should have name and yahooSymbol for each index", () => {
      const indices = getAvailableIndices();
      indices.forEach((index) => {
        assert.ok(index.name);
        assert.ok(index.yahooSymbol);
        assert.ok(index.yahooSymbol.startsWith("^"));
      });
    });
  });

  describe("getPopularYahooSymbols", () => {
    it("should return an array of Yahoo symbols", () => {
      const symbols = getPopularYahooSymbols();
      assert.ok(Array.isArray(symbols));
      assert.ok(symbols.length > 0);
    });

    it("should have all symbols with .NS suffix", () => {
      const symbols = getPopularYahooSymbols();
      symbols.forEach((symbol) => {
        assert.ok(symbol.endsWith(".NS"), `${symbol} should end with .NS`);
      });
    });

    it("should include RELIANCE.NS", () => {
      const symbols = getPopularYahooSymbols();
      assert.ok(symbols.includes("RELIANCE.NS"));
    });

    it("should include TCS.NS", () => {
      const symbols = getPopularYahooSymbols();
      assert.ok(symbols.includes("TCS.NS"));
    });

    it("should have same length as POPULAR_STOCKS", () => {
      const symbols = getPopularYahooSymbols();
      assert.strictEqual(symbols.length, POPULAR_STOCKS.length);
    });
  });

  describe("INDEX_MAPPINGS", () => {
    it("should have NIFTY 50 mapping", () => {
      assert.strictEqual(INDEX_MAPPINGS["NIFTY 50"], "^NSEI");
    });

    it("should have SENSEX mapping", () => {
      assert.strictEqual(INDEX_MAPPINGS["SENSEX"], "^BSESN");
    });

    it("should have BSE SENSEX as alias", () => {
      assert.strictEqual(INDEX_MAPPINGS["BSE SENSEX"], "^BSESN");
    });

    it("should have multiple NIFTY aliases", () => {
      assert.strictEqual(INDEX_MAPPINGS["NIFTY"], "^NSEI");
      assert.strictEqual(INDEX_MAPPINGS["NIFTY50"], "^NSEI");
    });

    it("should have NIFTY BANK mapping", () => {
      assert.strictEqual(INDEX_MAPPINGS["NIFTY BANK"], "^NSEBANK");
    });

    it("should have all Yahoo symbols starting with ^", () => {
      Object.values(INDEX_MAPPINGS).forEach((yahooSymbol) => {
        assert.ok(
          yahooSymbol.startsWith("^"),
          `${yahooSymbol} should start with ^`
        );
      });
    });
  });

  describe("POPULAR_STOCKS", () => {
    it("should have at least 10 stocks", () => {
      assert.ok(POPULAR_STOCKS.length >= 10);
    });

    it("should have symbol, name, and exchange for each stock", () => {
      POPULAR_STOCKS.forEach((stock) => {
        assert.ok(stock.symbol, "Stock should have symbol");
        assert.ok(stock.name, "Stock should have name");
        assert.ok(stock.exchange, "Stock should have exchange");
      });
    });

    it("should have all stocks on NSE", () => {
      POPULAR_STOCKS.forEach((stock) => {
        assert.strictEqual(stock.exchange, "NSE");
      });
    });

    it("should include major companies", () => {
      const symbols = POPULAR_STOCKS.map((s) => s.symbol);
      assert.ok(symbols.includes("RELIANCE"));
      assert.ok(symbols.includes("TCS"));
      assert.ok(symbols.includes("HDFCBANK"));
      assert.ok(symbols.includes("INFY"));
    });
  });
});
