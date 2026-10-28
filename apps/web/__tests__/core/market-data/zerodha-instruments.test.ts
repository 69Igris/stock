/**
 * Zerodha Instrument Provider Tests
 *
 * Tests the REAL pure utility functions and provider logic in:
 *   packages/core/src/market-data/instruments/zerodha-instruments-logic.ts
 *   packages/core/src/market-data/instruments/zerodha-instruments.ts (provider)
 *
 * Imports the real exports (no inline reimplementation). These helpers are
 * consumed by ZerodhaInstrumentProvider, so this exercises production code.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INSTRUMENT_TYPE_MAP,
  isETF,
  isSyntheticInstrument,
  parseCSV,
  parseInstrumentCsv,
  extractBaseSymbol,
  shouldInclude,
  mapCSVRowToRaw as mapCSVRow,
  type ZerodhaCSVRow,
} from "@usemoney/core/market-data/instruments/zerodha-instruments-logic";
import {
  buildYahooSymbolForInstrument,
  ZerodhaInstrumentProvider,
} from "@usemoney/core/market-data";

// The real provider exposes mapToUpsert as an instance method. Construct once
// (constructor only warns if no API key, never throws) and reuse.
const provider = new ZerodhaInstrumentProvider("test-api-key");
const mapToUpsert = (raw: ReturnType<typeof mapCSVRow>) =>
  provider.mapToUpsert(raw);

// Helper to build a mock CSV header
const CSV_HEADER =
  "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange";

function makeCsvRow(overrides: Partial<ZerodhaCSVRow>): string {
  const defaults: ZerodhaCSVRow = {
    instrument_token: "123",
    exchange_token: "456",
    tradingsymbol: "RELIANCE",
    name: "Reliance Industries",
    last_price: "2500.00",
    expiry: "",
    strike: "0",
    tick_size: "0.05",
    lot_size: "1",
    instrument_type: "EQ",
    segment: "NSE",
    exchange: "NSE",
  };
  const row = { ...defaults, ...overrides };
  return [
    row.instrument_token,
    row.exchange_token,
    row.tradingsymbol,
    row.name,
    row.last_price,
    row.expiry,
    row.strike,
    row.tick_size,
    row.lot_size,
    row.instrument_type,
    row.segment,
    row.exchange,
  ].join(",");
}

describe("Zerodha Instrument Provider (real source)", () => {
  // ────────────────────────────────────────────────────────────────
  // INSTRUMENT_TYPE_MAP
  // ────────────────────────────────────────────────────────────────
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

    it("should map CE to OPTIONS (call option)", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["CE"], "OPTIONS");
    });

    it("should map PE to OPTIONS (put option)", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["PE"], "OPTIONS");
    });

    it("should map IF to INDEX", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["IF"], "INDEX");
    });

    it("should return undefined for an unknown type", () => {
      assert.strictEqual(INSTRUMENT_TYPE_MAP["UNKNOWN"], undefined);
      assert.strictEqual(INSTRUMENT_TYPE_MAP["MF"], undefined);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // isETF
  // ────────────────────────────────────────────────────────────────
  describe("isETF", () => {
    describe("known ETF symbols", () => {
      it("should detect NIFTYBEES", () => {
        assert.strictEqual(isETF("NIFTYBEES", "Nippon India Nifty BeES"), true);
      });

      it("should detect GOLDBEES", () => {
        assert.strictEqual(isETF("GOLDBEES", "Nippon India Gold BeES"), true);
      });

      it("should detect LIQUIDBEES", () => {
        assert.strictEqual(
          isETF("LIQUIDBEES", "Nippon India Liquid BeES"),
          true
        );
      });

      it("should detect BANKBEES", () => {
        assert.strictEqual(isETF("BANKBEES", "Nippon India Bank BeES"), true);
      });

      it("should detect SILVERBEES", () => {
        assert.strictEqual(
          isETF("SILVERBEES", "Nippon India Silver BeES"),
          true
        );
      });

      it("should detect BHARAT22", () => {
        assert.strictEqual(isETF("BHARAT22", "Bharat 22 ETF"), true);
      });

      it("should detect CPSEETF", () => {
        assert.strictEqual(isETF("CPSEETF", "CPSE ETF"), true);
      });

      it("should detect N100", () => {
        assert.strictEqual(isETF("N100", "Motilal Nasdaq 100"), true);
      });

      it("should detect MAFANG", () => {
        assert.strictEqual(isETF("MAFANG", "Mirae FANG+ ETF"), true);
      });

      it("should detect ITBEES", () => {
        assert.strictEqual(isETF("ITBEES", "Nippon India IT BeES"), true);
      });

      it("should detect MID150BEES", () => {
        assert.strictEqual(
          isETF("MID150BEES", "Nippon India Midcap 150"),
          true
        );
      });

      it("should detect MOVALUE", () => {
        assert.strictEqual(isETF("MOVALUE", "Motilal Oswal Value"), true);
      });
    });

    describe("suffix pattern detection", () => {
      it("should detect symbols ending with BEES", () => {
        assert.strictEqual(isETF("NEWBEES", "Some BEES ETF"), true);
      });

      it("should detect symbols ending with ETF", () => {
        assert.strictEqual(isETF("SOMEETF", "Some Fund ETF"), true);
      });

      it("should detect symbols ending with ETF50", () => {
        assert.strictEqual(isETF("NIFTETF50", "Nifty ETF 50"), true);
      });

      it("should detect symbols ending with ETFN50", () => {
        assert.strictEqual(isETF("SOMESETFN50", "Some ETF N50"), true);
      });
    });

    describe("name-based detection", () => {
      it("should detect ETF when name contains ' ETF'", () => {
        assert.strictEqual(isETF("RANDOMSYMBOL", "SBI Nifty 50 ETF"), true);
      });

      it("should detect ETF when name contains 'Exchange Traded Fund'", () => {
        assert.strictEqual(
          isETF("RANDOMSYMBOL", "SBI Exchange Traded Fund"),
          true
        );
      });

      it("should detect ETF when name contains 'Exchange Traded'", () => {
        assert.strictEqual(isETF("RANDOMSYMBOL", "SBI Exchange Traded"), true);
      });

      it("should be case-insensitive for name checks", () => {
        assert.strictEqual(
          isETF("RANDOMSYMBOL", "sbi nifty 50 etf fund"),
          true
        );
      });
    });

    describe("non-ETF stocks", () => {
      it("should NOT detect RELIANCE as ETF", () => {
        assert.strictEqual(isETF("RELIANCE", "Reliance Industries"), false);
      });

      it("should NOT detect TCS as ETF", () => {
        assert.strictEqual(isETF("TCS", "Tata Consultancy Services"), false);
      });

      it("should NOT detect HDFCBANK as ETF", () => {
        assert.strictEqual(isETF("HDFCBANK", "HDFC Bank Limited"), false);
      });

      it("should NOT detect INFY as ETF", () => {
        assert.strictEqual(isETF("INFY", "Infosys Limited"), false);
      });

      it("should NOT detect stock whose name mentions 'Effluent Treatment' (no ' ETF')", () => {
        assert.strictEqual(
          isETF("WASTECORP", "Waste Effluent Treatment Corp"),
          false
        );
      });
    });

    describe("case insensitivity", () => {
      it("should detect lowercase niftybees", () => {
        assert.strictEqual(isETF("niftybees", "Nippon India Nifty BeES"), true);
      });

      it("should detect mixed-case GoldBees", () => {
        assert.strictEqual(isETF("GoldBees", "Nippon India Gold BeES"), true);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // isSyntheticInstrument
  // ────────────────────────────────────────────────────────────────
  describe("isSyntheticInstrument", () => {
    describe("symbol-based detection", () => {
      it("should detect symbol ending with INAV", () => {
        assert.strictEqual(
          isSyntheticInstrument("NIFTYBEESINAV", "Nifty BeES INAV"),
          true
        );
      });

      it("should detect GOLDBEESINAV", () => {
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
    });

    describe("name-based detection", () => {
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
    });

    describe("non-synthetic instruments", () => {
      it("should NOT detect RELIANCE as synthetic", () => {
        assert.strictEqual(
          isSyntheticInstrument("RELIANCE", "Reliance Industries"),
          false
        );
      });

      it("should NOT detect NIFTYBEES (ETF, not INAV)", () => {
        assert.strictEqual(
          isSyntheticInstrument("NIFTYBEES", "Nippon India Nifty BeES"),
          false
        );
      });

      it("should NOT detect HDFCBANK as synthetic", () => {
        assert.strictEqual(
          isSyntheticInstrument("HDFCBANK", "HDFC Bank Limited"),
          false
        );
      });

      it("should NOT detect instrument with 'NAV' in middle of name (not INAV)", () => {
        assert.strictEqual(
          isSyntheticInstrument("NAVNEET", "Navneet Education"),
          false
        );
      });
    });

    describe("case insensitivity", () => {
      it("should detect lowercase inav suffix", () => {
        assert.strictEqual(
          isSyntheticInstrument("goldbeesinav", "gold bees"),
          true
        );
      });

      it("should detect mixed case INAV in name", () => {
        assert.strictEqual(
          isSyntheticInstrument("STOCK", "inav of some etf"),
          true
        );
      });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // parseCSV
  // ────────────────────────────────────────────────────────────────
  describe("parseCSV", () => {
    it("should parse a valid CSV with header row and one data row", () => {
      const csv = [CSV_HEADER, makeCsvRow({})].join("\n");
      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]!.tradingsymbol, "RELIANCE");
      assert.strictEqual(rows[0]!.exchange, "NSE");
      assert.strictEqual(rows[0]!.instrument_type, "EQ");
    });

    it("should parse multiple data rows", () => {
      const csv = [
        CSV_HEADER,
        makeCsvRow({ tradingsymbol: "RELIANCE", instrument_token: "100" }),
        makeCsvRow({ tradingsymbol: "TCS", instrument_token: "200" }),
        makeCsvRow({ tradingsymbol: "INFY", instrument_token: "300" }),
      ].join("\n");

      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 3);
      assert.strictEqual(rows[0]!.tradingsymbol, "RELIANCE");
      assert.strictEqual(rows[1]!.tradingsymbol, "TCS");
      assert.strictEqual(rows[2]!.tradingsymbol, "INFY");
    });

    it("should return empty array for header-only CSV", () => {
      const rows = parseCSV(CSV_HEADER);
      assert.strictEqual(rows.length, 0);
    });

    it("should return empty array for empty string", () => {
      const rows = parseCSV("");
      assert.strictEqual(rows.length, 0);
    });

    it("should return empty array for single newline", () => {
      const rows = parseCSV("\n");
      assert.strictEqual(rows.length, 0);
    });

    it("should skip rows with wrong column count", () => {
      const csv = [
        CSV_HEADER,
        "123,456,RELIANCE", // Only 3 columns, should be skipped
        makeCsvRow({ tradingsymbol: "TCS" }),
      ].join("\n");

      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]!.tradingsymbol, "TCS");
    });

    it("should skip empty lines in the middle", () => {
      const csv = [
        CSV_HEADER,
        makeCsvRow({ tradingsymbol: "RELIANCE" }),
        "",
        makeCsvRow({ tradingsymbol: "TCS" }),
      ].join("\n");

      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 2);
    });

    it("should trim whitespace from values", () => {
      const csv = [
        CSV_HEADER,
        " 123 , 456 , RELIANCE , Reliance Industries , 2500.00 ,  , 0 , 0.05 , 1 , EQ , NSE , NSE ",
      ].join("\n");

      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]!.tradingsymbol, "RELIANCE");
      assert.strictEqual(rows[0]!.instrument_type, "EQ");
      assert.strictEqual(rows[0]!.exchange, "NSE");
    });

    it("should handle F&O row with expiry and strike", () => {
      const csv = [
        CSV_HEADER,
        makeCsvRow({
          tradingsymbol: "NIFTY25JAN25000CE",
          name: "NIFTY",
          expiry: "2025-01-30",
          strike: "25000",
          lot_size: "50",
          instrument_type: "CE",
          segment: "NFO-OPT",
          exchange: "NFO",
        }),
      ].join("\n");

      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]!.tradingsymbol, "NIFTY25JAN25000CE");
      assert.strictEqual(rows[0]!.strike, "25000");
      assert.strictEqual(rows[0]!.lot_size, "50");
      assert.strictEqual(rows[0]!.instrument_type, "CE");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // MONEY-1205 — quoted cells, and the drop that must never be silent
  //
  // These fixtures exist because the ORIGINAL ones did not contain a single
  // quote character. That shadow is why the bug shipped: `parseCSV` used
  // `line.split(",")`, Kite quotes its `name` column on 106,262 of 114,427
  // lines, and 13,287 of 26,669 prod instrument names were stored WITH the
  // literal quotes — 540 of 541 active ETFs among them — while every test
  // passed. A fixture that cannot express the defect cannot catch it.
  //
  // The bytes below are real: this is the actual SBIETFQLTY line from
  // https://api.kite.trade/instruments, fetched 2026-08-18.
  // ────────────────────────────────────────────────────────────────
  describe("parseCSV — quoted cells (MONEY-1205)", () => {
    it("strips the quotes Kite puts around `name` (the real defect)", () => {
      const csv = [
        CSV_HEADER,
        '1847809,7218,SBIETFQLTY,"SBI NIFTY 200 QUALITY 30 ETF",0,,0,0.01,1,EQ,NSE,NSE',
      ].join("\n");

      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 1);
      // The whole point: no leading/trailing quote character survives.
      assert.strictEqual(rows[0]!.name, "SBI NIFTY 200 QUALITY 30 ETF");
      assert.ok(
        !rows[0]!.name.includes('"'),
        "name must not carry a literal quote character"
      );
      // And the columns to its right are still themselves.
      assert.strictEqual(rows[0]!.tradingsymbol, "SBIETFQLTY");
      assert.strictEqual(rows[0]!.instrument_type, "EQ");
      assert.strictEqual(rows[0]!.exchange, "NSE");
      assert.strictEqual(rows[0]!.tick_size, "0.01");
    });

    it("keeps a quoted `name` containing a comma as ONE field", () => {
      // Zero such rows exist in today's dump, so this is the LATENT half of the
      // bug: under `split(",")` this line yields 13 fields, fails the
      // field-count check, and the instrument disappears from the universe with
      // no log line at all.
      const csv = [
        CSV_HEADER,
        '111,222,ARE&M,"AMARA RAJA ENERGY & MOBILITY, LTD",0,,0,0.05,1,EQ,NSE,NSE',
      ].join("\n");

      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 1, "the row must NOT be dropped");
      assert.strictEqual(
        rows[0]!.name,
        "AMARA RAJA ENERGY & MOBILITY, LTD",
        "the comma is part of the name, not a delimiter"
      );
      // Nothing shifted right.
      assert.strictEqual(rows[0]!.tradingsymbol, "ARE&M");
      assert.strictEqual(rows[0]!.instrument_type, "EQ");
      assert.strictEqual(rows[0]!.segment, "NSE");
      assert.strictEqual(rows[0]!.exchange, "NSE");
    });

    it('reads a doubled "" inside a quoted cell as one literal quote', () => {
      const csv = [
        CSV_HEADER,
        '333,444,QUOTED,"THE ""BIG"" COMPANY",0,,0,0.05,1,EQ,NSE,NSE',
      ].join("\n");

      const rows = parseCSV(csv);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]!.name, 'THE "BIG" COMPANY');
      assert.strictEqual(rows[0]!.exchange, "NSE");
    });

    it("quoted and unquoted cells parse to the SAME value", () => {
      // Kite quotes `name` on some rows and not others; the two forms must be
      // indistinguishable downstream, or the same company differs by exchange.
      const quoted = parseCSV(
        [CSV_HEADER, '1,2,ABB,"ABB INDIA",0,,0,0.05,1,EQ,NSE,NSE'].join("\n")
      );
      const bare = parseCSV(
        [CSV_HEADER, "1,2,ABB,ABB INDIA,0,,0,0.05,1,EQ,NSE,NSE"].join("\n")
      );
      assert.deepStrictEqual(quoted[0], bare[0]);
      assert.strictEqual(quoted[0]!.name, "ABB INDIA");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // MONEY-1205 — every data line is accounted for
  // ────────────────────────────────────────────────────────────────
  describe("parseInstrumentCsv — row-count parity in vs out", () => {
    const invariant = (csv: string) => {
      const r = parseInstrumentCsv(csv);
      const dropped = Object.values(r.reasons).reduce((a, b) => a + b, 0);
      assert.strictEqual(
        r.rows.length + dropped,
        r.dataLines,
        `rows(${r.rows.length}) + dropped(${dropped}) must equal ` +
          `dataLines(${r.dataLines})`
      );
      return r;
    };

    it("accounts for every line when all rows are good", () => {
      const csv = [
        CSV_HEADER,
        makeCsvRow({ tradingsymbol: "RELIANCE" }),
        '1,2,ABB,"ABB INDIA",0,,0,0.05,1,EQ,NSE,NSE',
        '3,4,ARE&M,"AMARA RAJA, LTD",0,,0,0.05,1,EQ,NSE,NSE',
      ].join("\n");

      const r = invariant(csv);
      assert.strictEqual(r.dataLines, 3);
      assert.strictEqual(r.rows.length, 3, "no row may be dropped");
      assert.deepStrictEqual(r.reasons, {}, "and nothing may be counted");
    });

    it("COUNTS a malformed row rather than dropping it silently", () => {
      const csv = [
        CSV_HEADER,
        "123,456,RELIANCE", // 3 columns, not 12
        makeCsvRow({ tradingsymbol: "TCS" }),
      ].join("\n");

      const r = invariant(csv);
      assert.strictEqual(r.dataLines, 2);
      assert.strictEqual(r.rows.length, 1);
      // The regression that matters: a drop must be VISIBLE.
      assert.deepStrictEqual(r.reasons, { "field-count": 1 });
    });

    it("does not count blank lines as data or as rejections", () => {
      const csv = [
        CSV_HEADER,
        makeCsvRow({ tradingsymbol: "RELIANCE" }),
        "",
        "   ",
        makeCsvRow({ tradingsymbol: "TCS" }),
      ].join("\n");

      const r = invariant(csv);
      assert.strictEqual(r.dataLines, 2);
      assert.strictEqual(r.rows.length, 2);
      assert.deepStrictEqual(r.reasons, {});
    });

    it("parseCSV stays the rows-only view of parseInstrumentCsv", () => {
      const csv = [
        CSV_HEADER,
        '1,2,ABB,"ABB INDIA",0,,0,0.05,1,EQ,NSE,NSE',
        "bad,row",
      ].join("\n");
      assert.deepStrictEqual(parseCSV(csv), parseInstrumentCsv(csv).rows);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // extractBaseSymbol
  // ────────────────────────────────────────────────────────────────
  describe("extractBaseSymbol", () => {
    it("should return symbol as-is for NSE equity", () => {
      assert.strictEqual(extractBaseSymbol("RELIANCE", "NSE"), "RELIANCE");
    });

    it("should return symbol as-is for BSE equity", () => {
      assert.strictEqual(extractBaseSymbol("TCS", "BSE"), "TCS");
    });

    it("should return full symbol for NSE even if it looks like F&O", () => {
      assert.strictEqual(
        extractBaseSymbol("NIFTY25JANFUT", "NSE"),
        "NIFTY25JANFUT"
      );
    });

    it("should extract base from NFO futures symbol", () => {
      assert.strictEqual(extractBaseSymbol("NIFTY25JANFUT", "NFO"), "NIFTY");
    });

    it("should extract base from NFO options symbol", () => {
      assert.strictEqual(
        extractBaseSymbol("RELIANCE25JAN2500CE", "NFO"),
        "RELIANCE"
      );
    });

    it("should handle M&M style symbols in F&O", () => {
      assert.strictEqual(extractBaseSymbol("M&M25JANFUT", "NFO"), "M&M");
    });

    it("should extract base from MCX futures", () => {
      assert.strictEqual(
        extractBaseSymbol("CRUDEOIL25JANFUT", "MCX"),
        "CRUDEOIL"
      );
    });

    it("should extract GOLD from MCX options", () => {
      assert.strictEqual(extractBaseSymbol("GOLD25FEB6000CE", "MCX"), "GOLD");
    });

    it("should extract SILVER from MCX futures", () => {
      assert.strictEqual(extractBaseSymbol("SILVER25MARFUT", "MCX"), "SILVER");
    });

    it("should extract BANKNIFTY from BFO", () => {
      assert.strictEqual(
        extractBaseSymbol("BANKNIFTY25JAN50000CE", "BFO"),
        "BANKNIFTY"
      );
    });

    it("should return full symbol if no alphabetic prefix match (edge case)", () => {
      assert.strictEqual(extractBaseSymbol("12345", "NFO"), "12345");
    });
  });

  // ────────────────────────────────────────────────────────────────
  // buildYahooSymbolForInstrument
  // ────────────────────────────────────────────────────────────────
  describe("buildYahooSymbolForInstrument", () => {
    it("should append .NS for NSE EQUITY", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("RELIANCE", "NSE", "EQUITY"),
        "RELIANCE.NS"
      );
    });

    it("should append .BO for BSE EQUITY", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("TCS", "BSE", "EQUITY"),
        "TCS.BO"
      );
    });

    it("should append .NS for NSE ETF", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("NIFTYBEES", "NSE", "ETF"),
        "NIFTYBEES.NS"
      );
    });

    it("should append .BO for BSE ETF", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("GOLDBEES", "BSE", "ETF"),
        "GOLDBEES.BO"
      );
    });

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

    it("should default to .NS for unknown exchange with EQUITY type", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("SOMESTOCK", "UNKNOWN", "EQUITY"),
        "SOMESTOCK.NS"
      );
    });

    it("should handle symbols with special characters like M&M", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("M&M", "NSE", "EQUITY"),
        "M&M.NS"
      );
    });

    it("should handle symbols with hyphens", () => {
      assert.strictEqual(
        buildYahooSymbolForInstrument("KESORAMIND-BE", "NSE", "EQUITY"),
        "KESORAMIND-BE.NS"
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // shouldInclude (exchange filtering)
  // ────────────────────────────────────────────────────────────────
  describe("shouldInclude (exchange and type filtering)", () => {
    function makeRow(overrides: Partial<ZerodhaCSVRow>): ZerodhaCSVRow {
      return {
        instrument_token: "123",
        exchange_token: "456",
        tradingsymbol: "RELIANCE",
        name: "Reliance Industries",
        last_price: "2500.00",
        expiry: "",
        strike: "0",
        tick_size: "0.05",
        lot_size: "1",
        instrument_type: "EQ",
        segment: "NSE",
        exchange: "NSE",
        ...overrides,
      };
    }

    it("should include NSE EQ instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "NSE", instrument_type: "EQ" })),
        true
      );
    });

    it("should include BSE EQ instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "BSE", instrument_type: "EQ" })),
        true
      );
    });

    it("should include NSE BE (trade-to-trade) instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "NSE", instrument_type: "BE" })),
        true
      );
    });

    it("should include NSE BL instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "NSE", instrument_type: "BL" })),
        true
      );
    });

    it("should include NSE SM instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "NSE", instrument_type: "SM" })),
        true
      );
    });

    it("should include NSE ST instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "NSE", instrument_type: "ST" })),
        true
      );
    });

    it("should include NFO FUT instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "NFO", instrument_type: "FUT" })),
        true
      );
    });

    it("should include NFO CE instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "NFO", instrument_type: "CE" })),
        true
      );
    });

    it("should include NFO PE instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "NFO", instrument_type: "PE" })),
        true
      );
    });

    it("should include BFO FUT instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "BFO", instrument_type: "FUT" })),
        true
      );
    });

    it("should include MCX FUT instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "MCX", instrument_type: "FUT" })),
        true
      );
    });

    it("should include MCX CE instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "MCX", instrument_type: "CE" })),
        true
      );
    });

    it("should include MCX PE instruments", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "MCX", instrument_type: "PE" })),
        true
      );
    });

    it("should include IF (index) instruments from any supported exchange", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "NSE", instrument_type: "IF" })),
        true
      );
    });

    it("should exclude unsupported exchanges like CDS", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "CDS", instrument_type: "EQ" })),
        false
      );
    });

    it("should exclude unsupported exchanges like NCDEX", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "NCDEX", instrument_type: "FUT" })),
        false
      );
    });

    it("should exclude NSE instruments that are NOT equity series (e.g., FUT on NSE)", () => {
      assert.strictEqual(
        shouldInclude(makeRow({ exchange: "NSE", instrument_type: "FUT" })),
        false
      );
    });

    it("should exclude INAV synthetic instruments from NSE", () => {
      assert.strictEqual(
        shouldInclude(
          makeRow({
            exchange: "NSE",
            instrument_type: "EQ",
            tradingsymbol: "NIFTYBEESINAV",
            name: "Nifty BeES INAV",
          })
        ),
        false
      );
    });

    it("should exclude INAV instruments detected by name", () => {
      assert.strictEqual(
        shouldInclude(
          makeRow({
            exchange: "NSE",
            instrument_type: "EQ",
            tradingsymbol: "SOMESTOCK",
            name: "Indicative NAV of Some ETF",
          })
        ),
        false
      );
    });
  });

  // ────────────────────────────────────────────────────────────────
  // mapCSVRow (field mapping)
  // ────────────────────────────────────────────────────────────────
  describe("mapCSVRow (field mapping)", () => {
    it("should map basic equity row correctly", () => {
      const row: ZerodhaCSVRow = {
        instrument_token: "738561",
        exchange_token: "2885",
        tradingsymbol: "RELIANCE",
        name: "Reliance Industries",
        last_price: "2500.00",
        expiry: "",
        strike: "0",
        tick_size: "0.05",
        lot_size: "1",
        instrument_type: "EQ",
        segment: "NSE",
        exchange: "NSE",
      };

      const mapped = mapCSVRow(row);
      assert.strictEqual(mapped.symbol, "RELIANCE");
      assert.strictEqual(mapped.exchange, "NSE");
      assert.strictEqual(mapped.name, "Reliance Industries");
      assert.strictEqual(mapped.tradingSymbol, "RELIANCE");
      assert.strictEqual(mapped.instrumentType, "EQUITY");
      assert.strictEqual(mapped.series, "EQ");
      assert.strictEqual(mapped.lotSize, 1);
      assert.strictEqual(mapped.tickSize, 0.05);
      assert.strictEqual(mapped.zerodhaToken, 738561);
      assert.strictEqual(mapped.isin, undefined);
    });

    it("should detect ETF and set instrumentType to ETF", () => {
      const row: ZerodhaCSVRow = {
        instrument_token: "100001",
        exchange_token: "200",
        tradingsymbol: "NIFTYBEES",
        name: "Nippon India Nifty BeES",
        last_price: "250.00",
        expiry: "",
        strike: "0",
        tick_size: "0.01",
        lot_size: "1",
        instrument_type: "EQ",
        segment: "NSE",
        exchange: "NSE",
      };

      const mapped = mapCSVRow(row);
      assert.strictEqual(mapped.instrumentType, "ETF");
      assert.strictEqual(mapped.symbol, "NIFTYBEES");
    });

    it("should map F&O row with correct base symbol and options fields", () => {
      const row: ZerodhaCSVRow = {
        instrument_token: "999888",
        exchange_token: "777",
        tradingsymbol: "NIFTY25JAN25000CE",
        name: "NIFTY",
        last_price: "150.00",
        expiry: "2025-01-30",
        strike: "25000",
        tick_size: "0.05",
        lot_size: "50",
        instrument_type: "CE",
        segment: "NFO-OPT",
        exchange: "NFO",
      };

      const mapped = mapCSVRow(row);
      assert.strictEqual(mapped.symbol, "NIFTY");
      assert.strictEqual(mapped.exchange, "NFO");
      assert.strictEqual(mapped.instrumentType, "OPTIONS");
      assert.strictEqual(mapped.optionType, "CE");
      assert.strictEqual(mapped.lotSize, 50);
      assert.strictEqual(mapped.strikePrice, 25000);
      assert.ok(mapped.expiryDate instanceof Date);
      assert.strictEqual(mapped.segmentCode, "NFO-OPT");
    });

    it("should map PE options correctly", () => {
      const row: ZerodhaCSVRow = {
        instrument_token: "999889",
        exchange_token: "778",
        tradingsymbol: "RELIANCE25JAN2500PE",
        name: "RELIANCE",
        last_price: "10.00",
        expiry: "2025-01-30",
        strike: "2500",
        tick_size: "0.05",
        lot_size: "250",
        instrument_type: "PE",
        segment: "NFO-OPT",
        exchange: "NFO",
      };

      const mapped = mapCSVRow(row);
      assert.strictEqual(mapped.instrumentType, "OPTIONS");
      assert.strictEqual(mapped.optionType, "PE");
      assert.strictEqual(mapped.symbol, "RELIANCE");
    });

    it("should map futures correctly with no optionType", () => {
      const row: ZerodhaCSVRow = {
        instrument_token: "888777",
        exchange_token: "666",
        tradingsymbol: "NIFTY25JANFUT",
        name: "NIFTY",
        last_price: "24500.00",
        expiry: "2025-01-30",
        strike: "0",
        tick_size: "0.05",
        lot_size: "50",
        instrument_type: "FUT",
        segment: "NFO-FUT",
        exchange: "NFO",
      };

      const mapped = mapCSVRow(row);
      assert.strictEqual(mapped.instrumentType, "FUTURES");
      assert.strictEqual(mapped.optionType, undefined);
      assert.strictEqual(mapped.symbol, "NIFTY");
    });

    it("should use tradingsymbol as name when name is empty", () => {
      const row: ZerodhaCSVRow = {
        instrument_token: "111",
        exchange_token: "222",
        tradingsymbol: "CUSTOMSYMBOL",
        name: "",
        last_price: "100.00",
        expiry: "",
        strike: "0",
        tick_size: "0.05",
        lot_size: "1",
        instrument_type: "EQ",
        segment: "NSE",
        exchange: "NSE",
      };

      const mapped = mapCSVRow(row);
      assert.strictEqual(mapped.name, "CUSTOMSYMBOL");
    });

    it("should handle missing lot_size and tick_size gracefully", () => {
      const row: ZerodhaCSVRow = {
        instrument_token: "111",
        exchange_token: "222",
        tradingsymbol: "TEST",
        name: "Test Stock",
        last_price: "100.00",
        expiry: "",
        strike: "",
        tick_size: "",
        lot_size: "",
        instrument_type: "EQ",
        segment: "NSE",
        exchange: "NSE",
      };

      const mapped = mapCSVRow(row);
      assert.strictEqual(mapped.lotSize, undefined);
      assert.strictEqual(mapped.tickSize, undefined);
      assert.strictEqual(mapped.strikePrice, undefined);
      assert.strictEqual(mapped.expiryDate, undefined);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // mapToUpsert (Prisma-compatible output) — real provider method
  // ────────────────────────────────────────────────────────────────
  describe("mapToUpsert (Prisma-compatible mapping)", () => {
    it("should produce upsert fields from a raw equity instrument", () => {
      const raw = mapCSVRow({
        instrument_token: "738561",
        exchange_token: "2885",
        tradingsymbol: "RELIANCE",
        name: "Reliance Industries",
        last_price: "2500.00",
        expiry: "",
        strike: "0",
        tick_size: "0.05",
        lot_size: "1",
        instrument_type: "EQ",
        segment: "NSE",
        exchange: "NSE",
      });

      const upsert = mapToUpsert(raw);

      assert.strictEqual(upsert.symbol, "RELIANCE");
      assert.strictEqual(upsert.exchange, "NSE");
      assert.strictEqual(upsert.name, "Reliance Industries");
      assert.strictEqual(upsert.tradingSymbol, "RELIANCE");
      assert.strictEqual(upsert.instrumentType, "EQUITY");
      assert.strictEqual(upsert.isActive, true);
      assert.strictEqual(upsert.zerodhaToken, 738561);
    });

    it("should set isin to undefined (not in Zerodha CSV)", () => {
      const raw = mapCSVRow({
        instrument_token: "123",
        exchange_token: "456",
        tradingsymbol: "TCS",
        name: "TCS Limited",
        last_price: "3500.00",
        expiry: "",
        strike: "0",
        tick_size: "0.05",
        lot_size: "1",
        instrument_type: "EQ",
        segment: "NSE",
        exchange: "NSE",
      });

      const upsert = mapToUpsert(raw);
      assert.strictEqual(upsert.isin, undefined);
    });
  });
});
