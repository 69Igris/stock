/**
 * UNIT TEST — Bhavcopy parse + URL builders + ZIP (MONEY-851).
 *
 * Exercises the REAL exported helpers from
 * packages/core/src/market-data/bhavcopy.ts (no shadow copies):
 *   - `parseUdiffBhavcopy`  — BSE + NSE UDiFF column maps → normalized rows
 *                             (ISIN present, OHLC/volume, equity-only filter)
 *   - `parseNseIndicesCsv`  — NSE all-indices close → IndexCloseRow[]
 *   - date→URL builders     — `toBhavcopyDateToken` / `toIndicesDateToken` /
 *                             `buildBseBhavcopyUrl` / `buildNseBhavcopyUrl` /
 *                             `buildNseIndicesUrl`
 *   - `unzipSingleEntry`    — STORED (method 0) + DEFLATE (method 8) single-
 *                             entry ZIP → CSV string
 *
 * These are pure functions, so no network/Prisma is touched. The HTTP fetchers
 * (`fetchBseBhavcopy` etc.) are thin wrappers over these + `fetch`; their
 * 404→[] contract is asserted via the logic test's day-resolution + here we
 * assert the parse layer they delegate to.
 *
 * MONEY-1100 P4.2 adds the valuation/activity columns to the indices parser.
 * Those cases run against __tests__/fixtures/ind_close_all.sample.csv — bytes
 * cut verbatim from a REAL archived `ind_close_all_26112018.csv`, so the header
 * text, the `-` placeholders and NSE's leading-dot decimals (`.97`, `.48`) are
 * the published ones rather than a hand-written approximation of them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseUdiffBhavcopy,
  parseNseIndicesCsv,
  unzipSingleEntry,
  toBhavcopyDateToken,
  toIndicesDateToken,
  buildBseBhavcopyUrl,
  buildNseBhavcopyUrl,
  buildNseIndicesUrl,
} from "../../src/market-data/bhavcopy";

// A trading day anchored at UTC noon so IST conversion is stable.
const DAY = new Date(Date.UTC(2026, 5, 18, 12, 0, 0)); // 2026-06-18 IST

const IND_CLOSE_ALL_CSV = readFileSync(
  join(import.meta.dirname, "..", "fixtures", "ind_close_all.sample.csv"),
  "utf-8",
);
// The fixture's own trading day (26-11-2018), UTC noon for the same reason.
const IND_DAY = new Date(Date.UTC(2018, 10, 26, 12, 0, 0));

// ── UDiFF header shared by BSE + NSE cash-market bhavcopy ──────────────
const UDIFF_HEADER =
  "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs," +
  "XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric," +
  "LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst," +
  "ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty," +
  "Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4";

function udiffRow(o: {
  finType?: string;
  isin: string;
  symbol: string;
  series: string;
  open?: string;
  high?: string;
  low?: string;
  close: string;
  prevClose?: string;
  volume?: string;
}): string {
  return [
    "2026-06-18", // TradDt
    "2026-06-18", // BizDt
    "CM",
    "DELT",
    o.finType ?? "STK", // FinInstrmTp
    "100000",
    o.isin, // ISIN
    o.symbol, // TckrSymb
    o.series, // SctySrs
    "", // XpryDt
    "",
    "0",
    "",
    o.symbol, // FinInstrmNm
    o.open ?? "", // OpnPric
    o.high ?? "", // HghPric
    o.low ?? "", // LwPric
    o.close, // ClsPric
    o.close, // LastPric
    o.prevClose ?? "", // PrvsClsgPric
    "0",
    "0",
    "0",
    "0",
    o.volume ?? "0", // TtlTradgVol
    "0",
    "0",
    "F1",
    "1",
    "",
    "",
    "",
    "",
    "",
  ].join(",");
}

describe("bhavcopy date → URL builders", () => {
  it("formats the bhavcopy filename token as IST YYYYMMDD", () => {
    assert.equal(toBhavcopyDateToken(DAY), "20260618");
  });

  it("formats the indices filename token as IST DDMMYYYY", () => {
    assert.equal(toIndicesDateToken(DAY), "18062026");
  });

  it("keeps the IST calendar day for a late-UTC timestamp", () => {
    // 2026-06-18 20:00 UTC = 2026-06-19 01:30 IST → next IST day.
    const lateUtc = new Date(Date.UTC(2026, 5, 18, 20, 0, 0));
    assert.equal(toBhavcopyDateToken(lateUtc), "20260619");
  });

  it("builds the BSE bhavcopy URL", () => {
    assert.equal(
      buildBseBhavcopyUrl(DAY),
      "https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_20260618_F_0000.CSV",
    );
  });

  it("builds the NSE bhavcopy (zip) URL", () => {
    assert.equal(
      buildNseBhavcopyUrl(DAY),
      "https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20260618_F_0000.csv.zip",
    );
  });

  it("builds the NSE indices close URL", () => {
    assert.equal(
      buildNseIndicesUrl(DAY),
      "https://nsearchives.nseindia.com/content/indices/ind_close_all_18062026.csv",
    );
  });
});

describe("parseUdiffBhavcopy", () => {
  it("normalizes NSE equity rows (ISIN + OHLC + volume present)", () => {
    const csv = [
      UDIFF_HEADER,
      udiffRow({
        isin: "INE002A01018",
        symbol: "RELIANCE",
        series: "EQ",
        open: "2900.00",
        high: "2950.50",
        low: "2880.10",
        close: "2940.25",
        prevClose: "2895.00",
        volume: "1234567",
      }),
    ].join("\n");

    const rows = parseUdiffBhavcopy(csv, "NSE", DAY);
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.isin, "INE002A01018");
    assert.equal(r.symbol, "RELIANCE");
    assert.equal(r.exchange, "NSE");
    assert.equal(r.open, 2900);
    assert.equal(r.high, 2950.5);
    assert.equal(r.low, 2880.1);
    assert.equal(r.close, 2940.25);
    assert.equal(r.prevClose, 2895);
    assert.equal(r.volume, 1234567);
    // Date is UTC midnight of the IST trading day.
    assert.equal(r.date.toISOString(), "2026-06-18T00:00:00.000Z");
  });

  it("normalizes BSE rows the same way (same UDiFF columns)", () => {
    const csv = [
      UDIFF_HEADER,
      udiffRow({
        isin: "INE467B01029",
        symbol: "TCS",
        series: "A", // BSE group
        open: "3800",
        high: "3850",
        low: "3790",
        close: "3820",
        prevClose: "3795",
        volume: "54321",
      }),
    ].join("\n");

    const rows = parseUdiffBhavcopy(csv, "BSE", DAY);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.exchange, "BSE");
    assert.equal(rows[0]!.isin, "INE467B01029");
    assert.equal(rows[0]!.close, 3820);
  });

  it("drops non-equity (index/derivative) rows via FinInstrmTp", () => {
    const csv = [
      UDIFF_HEADER,
      udiffRow({
        finType: "IDX", // index pseudo-row
        isin: "",
        symbol: "NIFTY 50",
        series: "",
        close: "23456.78",
      }),
      udiffRow({
        finType: "STK",
        isin: "INE002A01018",
        symbol: "RELIANCE",
        series: "EQ",
        close: "2940.25",
      }),
    ].join("\n");

    const rows = parseUdiffBhavcopy(csv, "NSE", DAY);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.symbol, "RELIANCE");
  });

  it("drops a non-equity NSE series (e.g. derivatives series) but keeps EQ/BE", () => {
    const csv = [
      UDIFF_HEADER,
      udiffRow({
        isin: "INE002A01018",
        symbol: "RELIANCE",
        series: "EQ",
        close: "10",
      }),
      udiffRow({
        isin: "INE111A01011",
        symbol: "SOMEBE",
        series: "BE",
        close: "20",
      }),
      udiffRow({
        isin: "INE999A01099",
        symbol: "WEIRD",
        series: "GS",
        close: "30",
      }), // govt sec - dropped
    ].join("\n");

    const rows = parseUdiffBhavcopy(csv, "NSE", DAY);
    const symbols = rows.map((r) => r.symbol).sort();
    assert.deepEqual(symbols, ["RELIANCE", "SOMEBE"]);
  });

  it("falls back high/low/open to close and volume to 0 when blank", () => {
    const csv = [
      UDIFF_HEADER,
      udiffRow({
        isin: "INE002A01018",
        symbol: "RELIANCE",
        series: "EQ",
        open: "",
        high: "",
        low: "",
        close: "100.5",
        volume: "",
      }),
    ].join("\n");

    const rows = parseUdiffBhavcopy(csv, "NSE", DAY);
    const r = rows[0]!;
    assert.equal(r.open, 100.5);
    assert.equal(r.high, 100.5);
    assert.equal(r.low, 100.5);
    assert.equal(r.volume, 0);
  });

  it("drops a row with no close (unusable as a price seed)", () => {
    const csv = [
      UDIFF_HEADER,
      udiffRow({
        isin: "INE002A01018",
        symbol: "RELIANCE",
        series: "EQ",
        close: "",
      }),
    ].join("\n");
    assert.equal(parseUdiffBhavcopy(csv, "NSE", DAY).length, 0);
  });

  it("sets isin null when the ISIN cell is blank/short", () => {
    const csv = [
      UDIFF_HEADER,
      udiffRow({ isin: "-", symbol: "RELIANCE", series: "EQ", close: "100" }),
    ].join("\n");
    assert.equal(parseUdiffBhavcopy(csv, "NSE", DAY)[0]!.isin, null);
  });

  it("returns [] for an empty/header-only CSV", () => {
    assert.deepEqual(parseUdiffBhavcopy(UDIFF_HEADER, "NSE", DAY), []);
    assert.deepEqual(parseUdiffBhavcopy("", "NSE", DAY), []);
  });
});

describe("parseNseIndicesCsv", () => {
  it("normalizes index close rows and derives prevClose from points change", () => {
    const csv = [
      "Index Name,Index Date,Open Index Value,High Index Value," +
        "Low Index Value,Closing Index Value,Points Change,Change(%)," +
        "Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield",
      "Nifty 50,18-06-2026,23400.00,23500.00,23380.00,23456.78,56.78,0.24," +
        "100000,5000,22.5,4.1,1.2",
    ].join("\n");

    const rows = parseNseIndicesCsv(csv, DAY);
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.name, "Nifty 50");
    assert.equal(r.open, 23400);
    assert.equal(r.close, 23456.78);
    // prevClose = close - pointsChange = 23456.78 - 56.78 = 23400
    assert.ok(Math.abs(r.prevClose! - 23400) < 1e-6);
    assert.equal(r.date.toISOString(), "2026-06-18T00:00:00.000Z");
  });

  it("returns [] for a header-only indices CSV", () => {
    assert.deepEqual(
      parseNseIndicesCsv("Index Name,Closing Index Value,Points Change", DAY),
      [],
    );
  });
});

describe("parseNseIndicesCsv valuation columns (MONEY-1100 P4.2, real file)", () => {
  const rows = parseNseIndicesCsv(IND_CLOSE_ALL_CSV, IND_DAY);
  const byName = (name: string) => rows.find((r) => r.name === name)!;

  it("parses the real published 13-column header", () => {
    // The header this asserts against, verbatim from the archive:
    //   Index Name,Index Date,Open Index Value,High Index Value,Low Index
    //   Value,Closing Index Value,Points Change,Change(%),Volume,
    //   Turnover (Rs. Cr.),P/E,P/B,Div Yield
    // Every data line in the fixture must survive — a silent drop here is how
    // a whole era of a backfill goes missing without an error.
    assert.equal(rows.length, 11);
    assert.equal(byName("Nifty 50").close, 10628.6);
    // Existing shape is untouched: OHLC + prevClose still derive as before.
    assert.equal(byName("Nifty 50").open, 10568.3);
    assert.ok(Math.abs(byName("Nifty 50").prevClose! - 10526.75) < 1e-6);
    assert.equal(
      byName("Nifty 50").date.toISOString(),
      "2018-11-26T00:00:00.000Z",
    );
  });

  it("reads P/E, P/B and Div Yield exactly as published", () => {
    const nifty = byName("Nifty 50");
    assert.equal(nifty.pe, 25.71);
    assert.equal(nifty.pb, 3.36);
    assert.equal(nifty.divYield, 1.25);

    const bank = byName("Nifty Bank");
    assert.equal(bank.pe, 52.92);
    assert.equal(bank.pb, 3.02);
    // NSE writes sub-1 values with a LEADING DOT (".48"), not "0.48".
    assert.equal(bank.divYield, 0.48);

    const small = byName("NIFTY Smallcap 100");
    assert.equal(small.pe, 35.29);
    assert.equal(small.pb, 1.64);
    assert.equal(small.divYield, 0.95);
  });

  it("keeps volume as shares and turnover in ₹ CRORE (no unit conversion)", () => {
    const nifty = byName("Nifty 50");
    assert.equal(nifty.volume, 332863041);
    // 15927.25 is the file's `Turnover (Rs. Cr.)` cell UNCHANGED. The field is
    // named `turnoverCr` precisely so it can stay in the published unit: a
    // ×1e7 rupee conversion here would be a silent rewrite of exchange bytes
    // (the derivable map's "archived file wins" rule) and would read as
    // 1.592725e11 downstream with nothing in the name to explain it. Note
    // delivery.ts DOES convert (TURNOVER_LACS → rupees) — its field is bare
    // `turnover`, so there the conversion is what removes the ambiguity.
    assert.equal(nifty.turnoverCr, 15927.25);
    assert.equal(byName("Nifty Bank").turnoverCr, 4851.74);
  });

  it("maps `-` to null, never 0 (Nifty50 Dividend Points row)", () => {
    // This index has no constituents to value and no traded volume, so NSE
    // prints `-` in all five columns while still publishing a close. 0 would
    // make it look like a P/E-of-zero screaming buy in any screen built on
    // this table; null says "not reported", which is the truth.
    const div = byName("Nifty50 Dividend Points");
    assert.equal(div.close, 106.94);
    assert.equal(div.pe, null);
    assert.equal(div.pb, null);
    assert.equal(div.divYield, null);
    assert.equal(div.volume, null);
    assert.equal(div.turnoverCr, null);
    // Guard the exact failure mode: not one of them may be 0.
    for (const v of [
      div.pe,
      div.pb,
      div.divYield,
      div.volume,
      div.turnoverCr,
    ]) {
      assert.notEqual(v, 0);
    }
    // The `-` in Open/High/Low still falls back to close, as before P4.2.
    assert.equal(div.open, 106.94);
  });

  it("tolerates cosmetic header drift in the valuation columns", () => {
    // The backfill replays files from 2013 onward; punctuation/case is the
    // only thing that has ever moved in these labels. Matching on
    // letters+digits means a drifted era yields real numbers instead of a
    // full column of nulls that would be indistinguishable from `-`.
    const csv = [
      "Index Name,Index Date,Open Index Value,High Index Value,Low Index Value," +
        "Closing Index Value,Points Change,Change(%),VOLUME,Turnover(Rs.Cr.)," +
        "PE,PB,Div Yield (%)",
      "Nifty 50,26-11-2018,1,2,0.5,1.5,0.5,50,900,12.5,20.1,3.2,1.1",
    ].join("\n");

    const r = parseNseIndicesCsv(csv, IND_DAY)[0]!;
    assert.equal(r.pe, 20.1);
    assert.equal(r.pb, 3.2);
    assert.equal(r.divYield, 1.1);
    assert.equal(r.volume, 900);
    assert.equal(r.turnoverCr, 12.5);
  });

  it("returns nulls (not a throw) when the file has no valuation columns", () => {
    // Older/short variants exist in the archive; the OHLC contract every
    // current caller depends on must survive their absence untouched.
    const csv = [
      "Index Name,Index Date,Open Index Value,High Index Value,Low Index Value," +
        "Closing Index Value,Points Change",
      "Nifty 50,26-11-2018,100,110,90,105,5",
    ].join("\n");

    const r = parseNseIndicesCsv(csv, IND_DAY)[0]!;
    assert.equal(r.close, 105);
    assert.equal(r.prevClose, 100);
    assert.equal(r.pe, null);
    assert.equal(r.pb, null);
    assert.equal(r.divYield, null);
    assert.equal(r.volume, null);
    assert.equal(r.turnoverCr, null);
  });
});

describe("unzipSingleEntry", () => {
  /** Build a minimal single-entry ZIP local file header + payload. */
  function buildZip(content: string, method: 0 | 8): Buffer {
    const name = Buffer.from("bhav.csv", "ascii");
    const raw = Buffer.from(content, "utf-8");
    const body = method === 8 ? deflateRawSync(raw) : raw;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header signature
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(method, 8); // compression method
    header.writeUInt16LE(0, 10); // mod time
    header.writeUInt16LE(0, 12); // mod date
    header.writeUInt32LE(0, 14); // crc32 (unchecked by our reader)
    header.writeUInt32LE(body.length, 18); // compressed size
    header.writeUInt32LE(raw.length, 22); // uncompressed size
    header.writeUInt16LE(name.length, 26); // file name length
    header.writeUInt16LE(0, 28); // extra field length

    return Buffer.concat([header, name, body]);
  }

  it("inflates a DEFLATE (method 8) single-entry ZIP", () => {
    const csv = "TckrSymb,ISIN,ClsPric\nRELIANCE,INE002A01018,2940.25\n";
    const zip = buildZip(csv, 8);
    assert.equal(unzipSingleEntry(zip), csv);
  });

  it("reads a STORED (method 0) single-entry ZIP verbatim", () => {
    const csv = "TckrSymb,ISIN,ClsPric\nTCS,INE467B01029,3820\n";
    const zip = buildZip(csv, 0);
    assert.equal(unzipSingleEntry(zip), csv);
  });

  it("round-trips through the NSE fetch path shape (zip → parse)", () => {
    const csv = [
      UDIFF_HEADER,
      udiffRow({
        isin: "INE002A01018",
        symbol: "RELIANCE",
        series: "EQ",
        close: "2940.25",
        volume: "10",
      }),
    ].join("\n");
    const zip = buildZip(csv, 8);
    const rows = parseUdiffBhavcopy(unzipSingleEntry(zip), "NSE", DAY);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.close, 2940.25);
  });

  it("throws on a non-ZIP buffer (bad signature)", () => {
    assert.throws(() => unzipSingleEntry(Buffer.from("not a zip at all")));
  });
});
