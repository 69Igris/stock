/**
 * UNIT TEST — NSE instrument-master parsing (MONEY-1085).
 *
 * Exercises the REAL exports from
 * packages/core/src/market-data/instruments/nse-master-logic.ts.
 *
 * The defect these back: the Zerodha dump omits NSE's SME/book-entry series and
 * carries no ISIN, so ~766 NSE closing prices were dropped every trading day.
 * NSE's own master files supply both — but the two files disagree on header
 * style, which is exactly the kind of thing that silently parses to zero rows.
 *
 * Header shapes are reproduced verbatim from the live files (2026-07-27):
 *   EQUITY_L.csv     spaces, and a LEADING space on most headers
 *   SME_EQUITY_L.csv underscores, and a TRAILING comma (empty 8th column)
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  NSE_MASTER_SERIES,
  mergeNseMasterRows,
  normalizeMasterHeader,
  normalizeMasterIsin,
  parseNseMasterCsv,
} from "../../src/market-data/instruments/nse-master-logic";
import {
  NSE_CASH_SERIES,
  NSE_CASH_SERIES_WITHOUT_MASTER,
} from "../../src/market-data/bhavcopy";

/** Live EQUITY_L.csv header, byte-for-byte. */
const MAIN_HEADER =
  "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE";
/** Live SME_EQUITY_L.csv header, byte-for-byte (note the trailing comma). */
const SME_HEADER =
  "SYMBOL,NAME_OF_COMPANY,SERIES,DATE_OF_LISTING,PAID_UP_VALUE,ISIN_NUMBER,FACE_VALUE,";

describe("normalizeMasterHeader", () => {
  test("collapses both files' conventions to one key", () => {
    // This equality is the whole reason one parser can read both files.
    assert.equal(normalizeMasterHeader(" ISIN NUMBER"), "ISINNUMBER");
    assert.equal(normalizeMasterHeader("ISIN_NUMBER"), "ISINNUMBER");
    assert.equal(normalizeMasterHeader("NAME OF COMPANY"), "NAMEOFCOMPANY");
    assert.equal(normalizeMasterHeader("NAME_OF_COMPANY"), "NAMEOFCOMPANY");
    assert.equal(normalizeMasterHeader(" SERIES"), "SERIES");
  });

  test("is case-insensitive and tolerates repeated separators", () => {
    assert.equal(normalizeMasterHeader("market  lot"), "MARKETLOT");
    assert.equal(normalizeMasterHeader("MARKET__LOT"), "MARKETLOT");
  });
});

describe("normalizeMasterIsin", () => {
  test("keeps a real 12-char ISIN, upper-cased", () => {
    assert.equal(normalizeMasterIsin("ine144j01027"), "INE144J01027");
    assert.equal(normalizeMasterIsin("  INE002A01018  "), "INE002A01018");
  });

  test("rejects blanks and placeholders", () => {
    assert.equal(normalizeMasterIsin(""), null);
    assert.equal(normalizeMasterIsin("   "), null);
    assert.equal(normalizeMasterIsin("-"), null);
    assert.equal(normalizeMasterIsin(undefined), null);
    assert.equal(normalizeMasterIsin("INE123"), null); // too short
  });
});

describe("parseNseMasterCsv — main board (EQUITY_L shape)", () => {
  const csv = [
    MAIN_HEADER,
    "20MICRONS,20 Microns Limited,EQ,06-OCT-2008,5,1,INE144J01027,5",
    "AAREYDRUGS,Aarey Drugs Limited,BE,20-JAN-2000,10,1,INE198H01019,10",
    "SOMESURV,Some Surveillance Ltd,BZ,01-JAN-2020,10,1,INE000B01011,10",
    "GILT2030,GOI Loan 2030,GS,01-JAN-2020,100,1,IN0020200070,100",
  ].join("\n");

  test("parses the spaced/leading-space header correctly", () => {
    const rows = parseNseMasterCsv(csv);
    assert.equal(rows.length, 3); // GS dropped
    assert.deepEqual(rows[0], {
      symbol: "20MICRONS",
      name: "20 Microns Limited",
      series: "EQ",
      isin: "INE144J01027",
      marketLot: 1,
    });
  });

  test("keeps the series the price feed needs (BE, BZ)", () => {
    const rows = parseNseMasterCsv(csv);
    assert.deepEqual(
      rows.map((r) => r.series),
      ["EQ", "BE", "BZ"],
    );
  });

  test("drops non-equity series (GS government loans)", () => {
    const rows = parseNseMasterCsv(csv);
    assert.equal(
      rows.find((r) => r.symbol === "GILT2030"),
      undefined,
    );
  });
});

describe("parseNseMasterCsv — SME (SME_EQUITY_L shape)", () => {
  const csv = [
    SME_HEADER,
    "METALIC,Metalic Technoforge Limited,ST,28-Jul-26,10,INE1II801013,10,",
    "AAKAAR,Aakaar Medical Limited,SM,16-Jul-26,10,INE1GYP01013,10,",
    "ODDONE,Odd Series Ltd,SZ,01-Jan-26,10,INE1GFG01011,10,",
  ].join("\n");

  test("parses the underscored header + trailing comma", () => {
    const rows = parseNseMasterCsv(csv);
    assert.equal(rows.length, 2); // SZ dropped
    assert.deepEqual(rows[0], {
      symbol: "METALIC",
      name: "Metalic Technoforge Limited",
      series: "ST",
      isin: "INE1II801013",
      // The SME file has NO MARKET LOT column — must be null, not 0 or NaN.
      marketLot: null,
    });
  });

  test("drops the stray SZ row the live file carries", () => {
    assert.equal(
      parseNseMasterCsv(csv).find((r) => r.series === "SZ"),
      undefined,
    );
  });
});

describe("parseNseMasterCsv — robustness", () => {
  test("returns [] for empty / header-only / non-master input", () => {
    assert.deepEqual(parseNseMasterCsv(""), []);
    assert.deepEqual(parseNseMasterCsv(MAIN_HEADER), []);
    assert.deepEqual(parseNseMasterCsv(SME_HEADER + "\n"), []);
    // A file without SYMBOL/SERIES isn't a master file — bail, don't guess.
    assert.deepEqual(parseNseMasterCsv("A,B,C\n1,2,3"), []);
  });

  test("tolerates CRLF and blank trailing lines", () => {
    const csv = `${MAIN_HEADER}\r\nAAA,Aaa Ltd,EQ,01-JAN-2020,10,1,INE000A01010,10\r\n\r\n`;
    const rows = parseNseMasterCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.series, "EQ"); // \r must not leak into the series
    assert.equal(rows[0]!.isin, "INE000A01010");
  });

  test("keeps a row whose ISIN is blank (symbol still worth having)", () => {
    const csv = `${MAIN_HEADER}\nNOISIN,No Isin Ltd,EQ,01-JAN-2020,10,1,,10`;
    const rows = parseNseMasterCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.isin, null);
  });

  test("skips rows with no symbol", () => {
    const csv = `${MAIN_HEADER}\n,Nameless Ltd,EQ,01-JAN-2020,10,1,INE000A01010,10`;
    assert.deepEqual(parseNseMasterCsv(csv), []);
  });

  test("honours quoted fields so a comma in a company name can't shift columns", () => {
    // If this regressed, the series column would read as part of the name and
    // every such row would be silently dropped by the series filter.
    const csv = `${MAIN_HEADER}\nQCO,"Quoted, Comma Ltd",EQ,01-JAN-2020,10,1,INE000A01010,10`;
    const rows = parseNseMasterCsv(csv);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, "Quoted, Comma Ltd");
    assert.equal(rows[0]!.series, "EQ");
    assert.equal(rows[0]!.isin, "INE000A01010");
  });

  test("upper-cases the symbol so the join key matches bhavcopy's", () => {
    const csv = `${MAIN_HEADER}\nlower,Lower Ltd,EQ,01-JAN-2020,10,1,INE000A01010,10`;
    assert.equal(parseNseMasterCsv(csv)[0]!.symbol, "LOWER");
  });
});

describe("mergeNseMasterRows", () => {
  const main = [
    {
      symbol: "DUP",
      name: "Main Board Ltd",
      series: "EQ",
      isin: "INE1",
      marketLot: 1,
    },
    { symbol: "ONLYMAIN", name: "M", series: "EQ", isin: "INE2", marketLot: 1 },
  ];
  const sme = [
    {
      symbol: "DUP",
      name: "SME Ltd",
      series: "SM",
      isin: "INE1",
      marketLot: null,
    },
    {
      symbol: "ONLYSME",
      name: "S",
      series: "SM",
      isin: "INE3",
      marketLot: null,
    },
  ];

  test("first-wins, so a migrating symbol keeps its main-board entry", () => {
    const merged = mergeNseMasterRows(main, sme);
    assert.equal(merged.length, 3);
    const dup = merged.find((r) => r.symbol === "DUP")!;
    assert.equal(dup.name, "Main Board Ltd");
    assert.equal(dup.series, "EQ");
  });

  test("keeps symbols unique to either set", () => {
    const syms = mergeNseMasterRows(main, sme)
      .map((r) => r.symbol)
      .sort();
    assert.deepEqual(syms, ["DUP", "ONLYMAIN", "ONLYSME"]);
  });

  test("handles empty inputs", () => {
    assert.deepEqual(mergeNseMasterRows([], []), []);
    assert.deepEqual(mergeNseMasterRows(), []);
  });
});

describe("nse-series-drift: prices we ingest must have an instrument source", () => {
  test("every priced NSE series is sourced by the master parser", () => {
    // THE INVARIANT. bhavcopy keeps a series → the join needs an instrument for
    // it → the master parser must accept that series. When these drifted apart,
    // 766 rows/day were fetched and then thrown away. Blank and IT are
    // knowingly unsourced (see NSE_CASH_SERIES_WITHOUT_MASTER).
    const unsourced = [...NSE_CASH_SERIES].filter(
      (s) =>
        !NSE_CASH_SERIES_WITHOUT_MASTER.has(s) && !NSE_MASTER_SERIES.has(s),
    );
    assert.deepEqual(
      unsourced,
      [],
      `these NSE series are priced but have no instrument source, so their ` +
        `bhavcopy rows will silently drop: ${unsourced.join(", ")}`,
    );
  });

  test("the master parser does not claim series the price feed ignores", () => {
    // The reverse drift is cheaper (a few unused instruments) but still means
    // the two lists disagree, which is how the first bug hid.
    const unpriced = [...NSE_MASTER_SERIES].filter(
      (s) => !NSE_CASH_SERIES.has(s),
    );
    assert.deepEqual(
      unpriced,
      [],
      `sourced but never priced: ${unpriced.join(", ")}`,
    );
  });
});
