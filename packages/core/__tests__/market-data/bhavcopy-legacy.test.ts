/**
 * UNIT TEST — legacy (pre-UDiFF) bhavcopy parsers (MONEY-941 / P3 step 4).
 *
 * Exercises the REAL exports from `market-data/bhavcopy-legacy.ts`:
 *   - `parseOldNseCmBhavcopy`  — the 1994→2024 cash format
 *   - `parseOldNseFoBhavcopy`  — the 2000→2024 derivatives format
 *   - `parseLegacyExpiry`      — the `DD-MMM-YYYY` expiry token
 *
 * Two properties matter more than the happy path:
 *
 *   1. **No ISIN before ~mid-1998.** ISIN is the primary join key to
 *      InstrumentMapping (MONEY-1085 exists because it was never populated), so
 *      an empty cell must become `null` rather than `""` — otherwise every
 *      early row would match every other early row on the ISIN join.
 *   2. **No non-finite money.** These files carry blanks, `-` and `NA` in
 *      numeric columns. `Number("")` is 0 and `Number("-")` is NaN; a 0 close is
 *      indistinguishable from a real crash and a NaN poisons every downstream
 *      average. This repo has been bitten by exactly that class before.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseOldNseCmBhavcopy,
  parseOldNseFoBhavcopy,
  parseLegacyExpiry,
} from "../../src/market-data/bhavcopy-legacy";

const DAY = new Date(Date.UTC(2005, 5, 15, 12, 0, 0)); // 2005-06-15 IST

// Modern-era cash file: ISIN column present.
const CM_WITH_ISIN = [
  "SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP,TOTALTRADES,ISIN",
  "RELIANCE,EQ,560.00,571.90,558.10,569.45,569.00,559.20,1234567,7000.50,15-JUN-2005,45678,INE002A01018",
  "TCS,EQ,1300.00,1325.00,1298.00,1320.10,1319.00,1301.00,222222,2900.10,15-JUN-2005,12345,INE467B01029",
  // Non-equity series must be dropped and tallied, never priced.
  "SOMEBOND,N1,100.00,100.50,99.80,100.10,100.00,100.00,10,1.00,15-JUN-2005,3,INE999Z01011",
].join("\n");

// Pre-1998 file: NO ISIN column at all.
const CM_NO_ISIN = [
  "SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP,TOTALTRADES",
  "RELIANCE,EQ,210.00,215.00,209.00,213.50,213.00,210.00,50000,105.00,02-JAN-1995,900",
].join("\n");

describe("parseOldNseCmBhavcopy", () => {
  it("parses the modern-era cash rows", () => {
    const { rows } = parseOldNseCmBhavcopy(CM_WITH_ISIN, DAY);
    assert.equal(rows.length, 2);
    const rel = rows.find((r) => r.symbol === "RELIANCE")!;
    assert.equal(rel.isin, "INE002A01018");
    assert.equal(rel.close, 569.45);
    assert.equal(rel.open, 560);
    assert.equal(rel.volume, 1234567);
    assert.equal(rel.series, "EQ");
    assert.equal(rel.exchange, "NSE");
    assert.equal(rel.date.toISOString(), "2005-06-15T00:00:00.000Z");
  });

  it("returns null ISIN — never '' — for pre-1998 files", () => {
    // "" would make the ISIN join match every early row against every other.
    const { rows, withoutIsin } = parseOldNseCmBhavcopy(CM_NO_ISIN, DAY);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.isin, null);
    assert.notEqual(rows[0]!.isin, "");
    assert.equal(withoutIsin, 1, "must be counted so the drop tally is honest");
  });

  it("drops non-equity series and TALLIES them by series", () => {
    // MONEY-1085's rule: a dropped row is reported, not silently vanished.
    const { rows, droppedBySeries } = parseOldNseCmBhavcopy(CM_WITH_ISIN, DAY);
    assert.ok(!rows.some((r) => r.symbol === "SOMEBOND"));
    assert.equal(droppedBySeries.N1, 1);
  });

  it("never emits NaN or 0 from blank / '-' / 'NA' money columns", () => {
    const messy = [
      "SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP,TOTALTRADES,ISIN",
      // blank OPEN, '-' HIGH, 'NA' LOW — close is valid
      "ACME,EQ,,-,NA,101.25,101.00,100.00,,,15-JUN-2005,,INE111A01011",
    ].join("\n");
    const { rows } = parseOldNseCmBhavcopy(messy, DAY);
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    for (const v of [r.open, r.high, r.low, r.close, r.volume]) {
      assert.ok(Number.isFinite(v), `non-finite value leaked: ${v}`);
    }
    // Missing OHL fall back to close rather than 0 — a 0 open would read as a
    // 100% intraday move in every downstream chart.
    assert.equal(r.open, 101.25);
    assert.equal(r.high, 101.25);
    assert.equal(r.low, 101.25);
    assert.equal(r.volume, 0);
    assert.equal(r.prevClose, 100);
  });

  it("drops a row with no usable close rather than writing zero", () => {
    const noClose = [
      "SYMBOL,SERIES,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,TOTTRDQTY,TOTTRDVAL,TIMESTAMP,TOTALTRADES,ISIN",
      "GHOST,EQ,10,11,9,,,10,100,1,15-JUN-2005,1,INE222A01011",
    ].join("\n");
    assert.equal(parseOldNseCmBhavcopy(noClose, DAY).rows.length, 0);
  });

  it("returns empty for junk rather than throwing", () => {
    assert.equal(parseOldNseCmBhavcopy("", DAY).rows.length, 0);
    assert.equal(
      parseOldNseCmBhavcopy("not,a,bhavcopy\n1,2,3", DAY).rows.length,
      0,
    );
  });
});

describe("parseLegacyExpiry", () => {
  it("parses DD-MMM-YYYY", () => {
    assert.equal(
      parseLegacyExpiry("29-JUN-2000")!.toISOString(),
      "2000-06-29T00:00:00.000Z",
    );
    assert.equal(
      parseLegacyExpiry("5-jan-2011")!.toISOString(),
      "2011-01-05T00:00:00.000Z",
    );
  });

  it("REJECTS dates that would silently roll over", () => {
    // Date.UTC(2023, 1, 29) is a valid 2023-03-01, so a NaN check accepts
    // 29-FEB and books the contract two days late. Expiry is part of the
    // contract's compound unique key, so a rolled-over date creates a DIFFERENT
    // contract that never matches the real one.
    assert.equal(parseLegacyExpiry("29-FEB-2023"), null);
    assert.equal(parseLegacyExpiry("32-JAN-2023"), null);
    assert.equal(parseLegacyExpiry("31-APR-2023"), null);
    // ...but a real leap day still parses.
    assert.equal(
      parseLegacyExpiry("29-FEB-2024")!.toISOString(),
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("returns null for anything it does not recognise", () => {
    for (const bad of [
      "",
      "2000-06-29",
      "29/06/2000",
      "29-XXX-2000",
      "29-JUN-200",
      "29-JUN-2",
      null,
    ]) {
      assert.equal(parseLegacyExpiry(bad), null);
    }
  });

  it("reads a 2-digit year as 20yy — NSE's regenerated 14-May-2012 file (MONEY-1618)", () => {
    assert.equal(
      parseLegacyExpiry("31-May-12")!.toISOString(),
      "2012-05-31T00:00:00.000Z",
    );
    assert.equal(parseLegacyExpiry("30-Feb-12"), null);
  });
});

/**
 * MONEY-1618. `fo14MAY2012bhav.csv` as NSE regenerated it: CRLF, no trailing
 * header comma, `DD-Mon-YY` expiries and a `*Updated` trailer. Every row was
 * dropped for a null expiry, so 2012-05-14 vanished from `derivatives_eod_in`.
 */
const FO_CSV_REGENERATED = [
  "INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP",
  "FUTIDX,BANKNIFTY,31-May-12,0,XX,9424,9450,9132,9179.7,9179.7,73169,169860.22,2263125,157850,14-May-12",
  "OPTSTK,ZEEL,26-Jul-12,200,PE,0,0,0,71.25,73.75,0,0,0,0,14-May-12",
  "",
  "*Updated",
  "",
].join("\r\n");

describe("parseOldNseFoBhavcopy — the regenerated 2-digit-year file (MONEY-1618)", () => {
  it("keeps every contract row and skips only the trailer", () => {
    const { rows, skipped } = parseOldNseFoBhavcopy(
      FO_CSV_REGENERATED,
      new Date("2012-05-14T00:00:00Z"),
    );
    assert.equal(rows.length, 2);
    assert.equal(skipped, 1);
    assert.equal(rows[0]!.expiry.toISOString(), "2012-05-31T00:00:00.000Z");
    assert.equal(rows[1]!.expiry.toISOString(), "2012-07-26T00:00:00.000Z");
  });
});

const FO_CSV = [
  "INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP",
  "FUTIDX,NIFTY,29-JUN-2005,0,XX,2100.00,2125.00,2095.00,2120.50,2120.50,15000,31800.75,450000,12000,15-JUN-2005",
  "OPTIDX,NIFTY,29-JUN-2005,2100,CE,45.00,52.00,44.00,50.25,50.25,8000,400.10,120000,-3000,15-JUN-2005",
  // unparseable expiry -> skipped, not written with a placeholder
  "FUTSTK,RELIANCE,BADDATE,0,XX,560,571,558,569,569,900,510.3,22000,500,15-JUN-2005",
].join("\n");

describe("parseOldNseFoBhavcopy", () => {
  it("parses futures and options", () => {
    const { rows } = parseOldNseFoBhavcopy(FO_CSV, DAY);
    assert.equal(rows.length, 2);

    const fut = rows.find((r) => r.instrument === "FUTIDX")!;
    assert.equal(fut.symbol, "NIFTY");
    assert.equal(fut.close, 2120.5);
    assert.equal(fut.openInt, 450000);
    assert.equal(fut.oiChange, 12000);
    assert.equal(fut.expiry.toISOString(), "2005-06-29T00:00:00.000Z");

    const opt = rows.find((r) => r.instrument === "OPTIDX")!;
    assert.equal(opt.strike, 2100);
    assert.equal(opt.optionType, "CE");
    assert.equal(opt.oiChange, -3000, "negative OI change must survive");
  });

  it("keeps futures as strike 0 / optionType XX, never null", () => {
    // The DerivativeEOD compound unique includes both columns, and MongoDB
    // treats nulls as distinct — nulls would let duplicate futures rows in.
    const fut = parseOldNseFoBhavcopy(FO_CSV, DAY).rows.find(
      (r) => r.instrument === "FUTIDX",
    )!;
    assert.equal(fut.strike, 0);
    assert.equal(fut.optionType, "XX");
  });

  it("skips and counts rows whose contract identity cannot be built", () => {
    const { rows, skipped } = parseOldNseFoBhavcopy(FO_CSV, DAY);
    assert.ok(!rows.some((r) => r.symbol === "RELIANCE"));
    assert.equal(skipped, 1);
  });

  it("emits only finite prices", () => {
    for (const r of parseOldNseFoBhavcopy(FO_CSV, DAY).rows) {
      for (const v of [r.open, r.high, r.low, r.close, r.volume, r.openInt]) {
        assert.ok(Number.isFinite(v), `non-finite: ${v}`);
      }
    }
  });

  it("returns empty for junk rather than throwing", () => {
    assert.equal(parseOldNseFoBhavcopy("", DAY).rows.length, 0);
  });
});
