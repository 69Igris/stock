/**
 * Zerodha Instrument Parser Tests
 *
 * Tests for the pure utility functions in zerodha-instruments.ts:
 * - isETF: detects ETFs from symbol/name heuristics
 * - isSyntheticInstrument: detects INAV/synthetic instruments
 * - parseCSV: parses Zerodha CSV format
 * - extractBaseSymbol: extracts underlying from F&O symbols
 * - buildYahooSymbolForInstrument: builds Yahoo symbols from exchange
 * - INSTRUMENT_TYPE_MAP: maps Zerodha types to canonical types
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// De-shadowed: import the REAL parsers/heuristics from core's
// zerodha-instruments-logic (the instrument-sync pipeline calls these).
import {
  INSTRUMENT_TYPE_MAP,
  isETF,
  isSyntheticInstrument,
  parseCSV,
  extractBaseSymbol,
  buildYahooSymbol,
  type ZerodhaCSVRow,
} from "@usemoney/core/market-data/instruments/zerodha-instruments-logic";

/**
 * Build a ZerodhaCSVRow fixture so we can exercise the REAL
 * `buildYahooSymbol(row)` (which keys off exchange + instrument_type)
 * through the old (symbol, exchange, instrumentType) call shape.
 */
function rowFor(
  tradingsymbol: string,
  exchange: string,
  instrument_type: string
): ZerodhaCSVRow {
  return {
    instrument_token: "0",
    exchange_token: "0",
    tradingsymbol,
    name: tradingsymbol,
    last_price: "0",
    expiry: "",
    strike: "0",
    tick_size: "0",
    lot_size: "0",
    instrument_type,
    segment: exchange,
    exchange,
  };
}

function buildYahooSymbolForInstrument(
  symbol: string,
  exchange: string,
  instrumentType: string
): string {
  // Map the legacy canonical instrumentType back to a Zerodha CSV
  // instrument_type / exchange so the real buildYahooSymbol runs.
  if (instrumentType === "FUTURES") {
    return buildYahooSymbol(rowFor(symbol, "NFO", "FUT"));
  }
  if (instrumentType === "OPTIONS") {
    return buildYahooSymbol(rowFor(symbol, "NFO", "CE"));
  }
  if (instrumentType === "INDEX") {
    return buildYahooSymbol(rowFor(symbol, exchange, "IF"));
  }
  return buildYahooSymbol(rowFor(symbol, exchange, "EQ"));
}

// ── Tests ────────────────────────────────────────────────────────

describe("Zerodha Instrument Parser", () => {
  describe("INSTRUMENT_TYPE_MAP", () => {
    it("should map EQ to EQUITY", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["EQ"], "EQUITY");
    });

    it("should map BE to EQUITY", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["BE"], "EQUITY");
    });

    it("should map BL to EQUITY", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["BL"], "EQUITY");
    });

    it("should map SM to EQUITY", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["SM"], "EQUITY");
    });

    it("should map ST to EQUITY", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["ST"], "EQUITY");
    });

    it("should map FUT to FUTURES", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["FUT"], "FUTURES");
    });

    it("should map CE to OPTIONS", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["CE"], "OPTIONS");
    });

    it("should map PE to OPTIONS", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["PE"], "OPTIONS");
    });

    it("should map IF to INDEX", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["IF"], "INDEX");
    });

    it("should return undefined for unknown types", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["UNKNOWN"], undefined);
    });
  });

  describe("isETF", () => {
    it("should detect NIFTYBEES as ETF", () => {
      assert.strictEqual(isETF("NIFTYBEES", "Nippon India Nifty BeES"), true);
    });

    it("should detect GOLDBEES as ETF", () => {
      assert.strictEqual(isETF("GOLDBEES", "Nippon India Gold BeES"), true);
    });

    it("should detect LIQUIDBEES as ETF", () => {
      assert.strictEqual(isETF("LIQUIDBEES", "Nippon India Liquid BeES"), true);
    });

    it("should detect BANKBEES as ETF", () => {
      assert.strictEqual(isETF("BANKBEES", "Nippon India Bank BeES"), true);
    });

    it("should detect SILVERBEES as ETF", () => {
      assert.strictEqual(isETF("SILVERBEES", "Nippon India Silver BeES"), true);
    });

    it("should detect ETF by suffix pattern (ends with BEES)", () => {
      assert.strictEqual(isETF("NEWBEES", "Some New ETF BEES"), true);
    });

    it("should detect ETF by suffix pattern (ends with ETF)", () => {
      assert.strictEqual(isETF("SOMEETF", "Some New ETF"), true);
    });

    it("should detect ETF by name containing 'ETF'", () => {
      assert.strictEqual(isETF("SOMESTOCK", "SBI Nifty 50 ETF"), true);
    });

    it("should detect ETF by name containing 'Exchange Traded Fund'", () => {
      assert.strictEqual(isETF("SOMESTOCK", "SBI Exchange Traded Fund"), true);
    });

    it("should detect ETF by name containing 'Exchange Traded'", () => {
      assert.strictEqual(isETF("SOMESTOCK", "SBI Exchange Traded"), true);
    });

    it("should NOT detect RELIANCE as ETF", () => {
      assert.strictEqual(isETF("RELIANCE", "Reliance Industries"), false);
    });

    it("should NOT detect TCS as ETF", () => {
      assert.strictEqual(isETF("TCS", "Tata Consultancy Services"), false);
    });

    it("should NOT detect HDFCBANK as ETF", () => {
      assert.strictEqual(isETF("HDFCBANK", "HDFC Bank Limited"), false);
    });

    it("should be case insensitive for symbols", () => {
      assert.strictEqual(isETF("niftybees", "Nippon India Nifty BeES"), true);
    });

    it("should detect known ETF symbols from the set", () => {
      assert.strictEqual(isETF("BHARAT22", "Bharat 22 ETF"), true);
      assert.strictEqual(isETF("CPSEETF", "CPSE ETF"), true);
      assert.strictEqual(isETF("N100", "Motilal Nasdaq 100"), true);
    });
  });

  describe("isSyntheticInstrument", () => {
    it("should detect NIFTYBEESINAV", () => {
      assert.strictEqual(
        isSyntheticInstrument("NIFTYBEESINAV", "Nifty BeES INAV"),
        true
      );
    });

    it("should detect symbol ending with INAV", () => {
      assert.strictEqual(
        isSyntheticInstrument("GOLDBEESINAV", "Gold BeES"),
        true
      );
    });

    it("should detect symbol containing -INAV", () => {
      assert.strictEqual(
        isSyntheticInstrument("NIFTYBEES-INAV", "Nifty BeES INAV"),
        true
      );
    });

    it("should detect symbol containing _INAV", () => {
      assert.strictEqual(isSyntheticInstrument("NIFTYBEES_INAV", ""), true);
    });

    it("should detect name containing INAV", () => {
      assert.strictEqual(
        isSyntheticInstrument("SOMESTOCK", "iNAV of Nifty BeES"),
        true
      );
    });

    it("should detect name containing 'Indicative NAV'", () => {
      assert.strictEqual(
        isSyntheticInstrument("SOMESTOCK", "Indicative NAV tracker"),
        true
      );
    });

    it("should detect name containing 'Indicative Net Asset'", () => {
      assert.strictEqual(
        isSyntheticInstrument(
          "SOMESTOCK",
          "Indicative Net Asset Value tracker"
        ),
        true
      );
    });

    it("should NOT detect RELIANCE as synthetic", () => {
      assert.strictEqual(
        isSyntheticInstrument("RELIANCE", "Reliance Industries"),
        false
      );
    });

    it("should NOT detect NIFTYBEES as synthetic (it's an ETF)", () => {
      assert.strictEqual(
        isSyntheticInstrument("NIFTYBEES", "Nippon India Nifty BeES"),
        false
      );
    });

    it("should be case insensitive", () => {
      assert.strictEqual(
        isSyntheticInstrument("goldbeesinav", "gold bees"),
        true
      );
    });
  });

  describe("parseCSV", () => {
    it("should parse a valid CSV with header and rows", () => {
      const csv = [
        "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange",
        "123,456,RELIANCE,Reliance Industries,2500.00,,0,0.05,1,EQ,NSE,NSE",
      ].join("\n");

      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].tradingsymbol, "RELIANCE");
      assert.strictEqual(rows[0].exchange, "NSE");
      assert.strictEqual(rows[0].instrument_type, "EQ");
    });

    it("should parse multiple rows", () => {
      const csv = [
        "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange",
        "123,456,RELIANCE,Reliance Industries,2500.00,,0,0.05,1,EQ,NSE,NSE",
        "789,101,TCS,TCS Limited,3500.00,,0,0.05,1,EQ,NSE,NSE",
      ].join("\n");

      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 2);
      assert.strictEqual(rows[0].tradingsymbol, "RELIANCE");
      assert.strictEqual(rows[1].tradingsymbol, "TCS");
    });

    it("should return empty for header-only CSV", () => {
      const csv = "instrument_token,tradingsymbol";
      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 0);
    });

    it("should return empty for empty string", () => {
      const rows = parseCSV("");
      assert.strictEqual(rows.length, 0);
    });

    it("should skip rows with wrong column count", () => {
      const csv = [
        "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange",
        "123,456,RELIANCE", // Only 3 columns, should be skipped
        "789,101,TCS,TCS Limited,3500.00,,0,0.05,1,EQ,NSE,NSE",
      ].join("\n");

      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].tradingsymbol, "TCS");
    });

    it("should trim whitespace from values", () => {
      const csv = [
        "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange",
        " 123 , 456 , RELIANCE , Reliance Industries , 2500.00 ,  , 0 , 0.05 , 1 , EQ , NSE , NSE ",
      ].join("\n");

      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].tradingsymbol, "RELIANCE");
      assert.strictEqual(rows[0].instrument_type, "EQ");
    });
  });

  describe("extractBaseSymbol", () => {
    it("should return symbol as-is for NSE equity", () => {
      assert.strictEqual(extractBaseSymbol("RELIANCE", "NSE"), "RELIANCE");
    });

    it("should return symbol as-is for BSE equity", () => {
      assert.strictEqual(extractBaseSymbol("TCS", "BSE"), "TCS");
    });

    it("should extract base symbol from NFO futures", () => {
      assert.strictEqual(extractBaseSymbol("NIFTY25JANFUT", "NFO"), "NIFTY");
    });

    it("should extract base symbol from NFO options", () => {
      assert.strictEqual(
        extractBaseSymbol("RELIANCE25JAN2500CE", "NFO"),
        "RELIANCE"
      );
    });

    it("should handle M&M style symbols in F&O", () => {
      assert.strictEqual(extractBaseSymbol("M&M25JANFUT", "NFO"), "M&M");
    });

    it("should handle MCX futures", () => {
      assert.strictEqual(
        extractBaseSymbol("CRUDEOIL25JANFUT", "MCX"),
        "CRUDEOIL"
      );
    });

    it("should handle symbols with only alphabetic prefix", () => {
      assert.strictEqual(extractBaseSymbol("GOLD25FEB6000CE", "MCX"), "GOLD");
    });
  });

  describe("buildYahooSymbolForInstrument", () => {
    it("should build .NS suffix for NSE equity", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("RELIANCE", "NSE", "EQUITY"),
        "RELIANCE.NS"
      );
    });

    it("should build .BO suffix for BSE equity", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("TCS", "BSE", "EQUITY"),
        "TCS.BO"
      );
    });

    it("should build .NS suffix for NSE ETF", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("NIFTYBEES", "NSE", "ETF"),
        "NIFTYBEES.NS"
      );
    });

    it("should return empty for FUTURES", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("NIFTY", "NFO", "FUTURES"),
        ""
      );
    });

    it("should return empty for OPTIONS", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("RELIANCE", "NFO", "OPTIONS"),
        ""
      );
    });

    it("should return empty for INDEX", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("NIFTY 50", "NSE", "INDEX"),
        ""
      );
    });

    it("should default to .NS for unknown exchange", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("SOMESTOCK", "UNKNOWN", "EQUITY"),
        "SOMESTOCK.NS"
      );
    });

    it("should handle symbols with special characters", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("M&M", "NSE", "EQUITY"),
        "M&M.NS"
      );
    });

    it("should strip the trailing series suffix when building the Yahoo symbol", () => {
      // The REAL buildYahooSymbol strips a trailing "-<SERIES>" (e.g. -BE)
      // because Yahoo keys on the base ticker. The old inline shadow omitted
      // this strip and wrongly expected "KESORAMIND-BE.NS".
      assert.strictEqual(
        buildYahooSymbolForInstrument("KESORAMIND-BE", "NSE", "EQUITY"),
        "KESORAMIND.NS"
      );
    });
  });
});

/**
 * MONEY-1207 — the quoted-name canary, in the SECOND copy of this suite.
 *
 * `apps/web/__tests__/core/market-data/zerodha-instruments.test.ts` covers the
 * same parser and got the real quoted-cell cases. This file is not a subset of
 * it (35 cases live only here), so it stays — but its fixtures contained ZERO
 * quote characters, which is precisely why a `line.split(",")` parser survived
 * review while storing 13,287 names WITH their quotes. A duplicate suite that
 * cannot fail on the defect its twin now catches is worse than no suite: it
 * reads as coverage.
 */
describe("parseCSV — RFC-4180 quoted cells (MONEY-1207 canary)", () => {
  it("strips the quotes Kite actually sends around `name`", () => {
    // The real line from https://api.kite.trade/instruments.
    const csv = [
      "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange",
      '1847809,7218,SBIETFQLTY,"SBI NIFTY 200 QUALITY 30 ETF",0,,0,0.01,1,EQ,NSE,NSE',
    ].join("\n");
    const rows = parseCSV(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, "SBI NIFTY 200 QUALITY 30 ETF");
    assert.doesNotMatch(
      rows[0]!.name,
      /"/,
      "a literal quote survived the parse"
    );
  });

  it("keeps a comma that lives INSIDE a quoted name, and does not drop the row", () => {
    const csv = [
      "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange",
      '1,2,ACME,"ACME INDUSTRIES, LIMITED",0,,0,0.01,1,EQ,NSE,NSE',
    ].join("\n");
    const rows = parseCSV(csv);
    assert.equal(
      rows.length,
      1,
      "the row was dropped by a field-count mismatch"
    );
    assert.equal(rows[0]!.name, "ACME INDUSTRIES, LIMITED");
  });
});
