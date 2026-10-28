/**
 * `parseWdmTrades` + `resolveWdmTrades` — the WDM half of `BondEOD`
 * (MONEY-1210).
 *
 * ## Why the inputs are CAPTURED, not written
 *
 * Both fixtures are real bytes pulled from the prod feed archive:
 *   `wdm-trd-17082026_sett.csv`  — the first member of
 *       gs://stockbook-content-prod/feeds/NSE/wdm-daily/2026/08/dly17082026.zip
 *   `wdmlist-17082026.slice.csv` — rows of the 17-Aug `wdmlist` needed by those
 *       trades, PLUS all seven ambiguous (SECURITY, ISSUE_NAME) pairs.
 *
 * This project has been bitten repeatedly by tests written from the same
 * assumption that produced the bug — three Tickertape writers read a `period`
 * key that does not exist, and the test that "covered" them fed the mapper the
 * shape the broken client emitted. A hand-written CSV here could only prove the
 * parser self-consistent with my reading of the header.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseWdmTrades,
  resolveWdmTrades,
  type WdmMasterKey,
} from "../../src/market-data/bond-eod-logic";
import { parseWdmList } from "../../src/market-data/bond-master-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "bond");
const read = (n: string) => readFileSync(join(FIXTURES, n), "utf8");

const TRADES = read("wdm-trd-17082026_sett.csv");
const MASTER_CSV = read("wdmlist-17082026.slice.csv");

/** The master slice, through the real wdmlist parser rather than a hand map. */
function masterKeys(): WdmMasterKey[] {
  const parsed = parseWdmList(MASTER_CSV);
  assert.ok(parsed !== null, "the master slice must parse as a wdmlist");
  return parsed.rows.map((r) => ({
    isin: r.isin,
    symbol: r.symbol,
    issueName: r.issueName ?? null,
  }));
}

describe("parseWdmTrades — the settled-trades member", () => {
  it("finds the header and returns rows", () => {
    const out = parseWdmTrades(TRADES);
    assert.ok(out !== null, "header not located in the real file");
    assert.ok(out.rows.length > 0, "no rows parsed from a 21-trade file");
  });

  it("reads identity as (symbol, issueName) — there is NO ISIN in this feed", () => {
    const out = parseWdmTrades(TRADES)!;
    const first = out.rows[0]!;
    assert.equal(first.symbol, "CG2032");
    assert.equal(first.issueName, "6.54%");
    // The row shape must not pretend to carry an ISIN.
    assert.ok(!("isin" in first), "WdmTradeRow must not expose an isin field");
  });

  it("converts the money column from CRORES to LACS (x100)", () => {
    // Row 1 of the real file: Traded Value (Rs.Cr.) = 150.00
    const out = parseWdmTrades(TRADES)!;
    const cg2032 = out.rows.find((r) => r.symbol === "CG2032")!;
    assert.equal(
      cg2032.totalTradeValueLacs,
      15000,
      "150.00 crores must be stored as 15,000 lacs — the field name carries " +
        "the unit, and CBM rows in the same column are already lacs",
    );
    assert.notEqual(cg2032.totalTradeValueLacs, 150, "stored crores verbatim");
  });

  it("parses the price columns it has and nulls the ones it does not", () => {
    const out = parseWdmTrades(TRADES)!;
    const cg2032 = out.rows.find((r) => r.symbol === "CG2032")!;
    assert.equal(cg2032.lastPrice, 100.2);
    assert.equal(cg2032.wapPrice, 100.2);
    assert.equal(cg2032.wtdYtm, 6.4939);
  });

  it("dates come from the row's own Trade date column", () => {
    const out = parseWdmTrades(TRADES)!;
    for (const r of out.rows) {
      assert.equal(r.date.toISOString().slice(0, 10), "2026-08-17");
    }
    assert.ok(
      out.reasons.multipleTradeDates === undefined,
      "one file is one session",
    );
  });

  it("a duplicate (symbol, issue, day) is dropped and COUNTED, not merged", () => {
    // The real 17-Aug file has 21 trade lines across 20 distinct pairs.
    const out = parseWdmTrades(TRADES)!;
    assert.equal(out.rows.length, 20);
    assert.equal(out.reasons.duplicateSymbolIssueDate, 1);
    assert.equal(out.skipped, 1);
  });

  it("returns NULL on bytes that are not this report", () => {
    // What `unzipSingleEntry` would hand us if NSE reordered the zip members.
    assert.equal(parseWdmTrades("<html><body>404</body></html>"), null);
    assert.equal(parseWdmTrades(""), null);
    // A CBM trades header must NOT be accepted as a WDM one.
    assert.equal(
      parseWdmTrades("Trade Date,ISIN,Last Trade Price (in Rs.)\n"),
      null,
    );
  });

  it("an empty session is rows:[] with a header, NOT null", () => {
    const headerOnly = TRADES.split("\n")[0] + "\n";
    const out = parseWdmTrades(headerOnly);
    assert.ok(out !== null, "a no-trade session must not read as unreadable");
    assert.equal(out.rows.length, 0);
  });
});

describe("resolveWdmTrades — (symbol, issueName) -> ISIN", () => {
  it("resolves every trade in the real file to exactly one ISIN", () => {
    const trades = parseWdmTrades(TRADES)!.rows;
    const res = resolveWdmTrades(trades, masterKeys());
    assert.equal(res.rows.length, trades.length);
    assert.equal(res.reasons.noMasterMatch, undefined);
    assert.equal(res.reasons.ambiguousPair, undefined);
  });

  it("stamps segment WDM and source nse-wdm-daily", () => {
    const res = resolveWdmTrades(parseWdmTrades(TRADES)!.rows, masterKeys());
    for (const r of res.rows) {
      assert.equal(r.segment, "WDM");
      assert.equal(r.source, "nse-wdm-daily");
    }
  });

  it("REFUSES an ambiguous pair rather than guessing an ISIN", () => {
    // RECL27/7.38% maps to two ISINs in the real master. A price filed against
    // the wrong one is indistinguishable downstream from a correct one.
    const masters = masterKeys();
    const amb = masters.filter(
      (m) => m.symbol === "RECL27" && m.issueName === "7.38%",
    );
    assert.ok(amb.length >= 2, "fixture must retain the ambiguous pair");

    const res = resolveWdmTrades(
      [
        {
          symbol: "RECL27",
          issueName: "7.38%",
          date: new Date("2026-08-17T00:00:00Z"),
          lastPrice: 101,
          wapPrice: 101,
          wtdYtm: 7,
          totalTradeValueLacs: 100,
        },
      ],
      masters,
    );
    assert.equal(res.rows.length, 0, "an ambiguous pair must not be written");
    assert.equal(res.reasons.ambiguousPair, 1);
  });

  it("a security absent from the master is dropped and named", () => {
    const res = resolveWdmTrades(
      [
        {
          symbol: "NOTLISTED",
          issueName: "9.99%",
          date: new Date("2026-08-17T00:00:00Z"),
          lastPrice: 100,
          wapPrice: 100,
          wtdYtm: 9,
          totalTradeValueLacs: 100,
        },
      ],
      masterKeys(),
    );
    assert.equal(res.rows.length, 0);
    assert.equal(res.reasons.noMasterMatch, 1);
    // Unlike writeBondEod's noMasterRow probe, this one MUST drop: with no
    // master there is no ISIN, and BondEOD has no other key to write under.
  });

  it("symbol matching is case/space insensitive on both sides", () => {
    const res = resolveWdmTrades(
      [
        {
          symbol: "CG2032",
          issueName: "6.54%",
          date: new Date("2026-08-17T00:00:00Z"),
          lastPrice: 100,
          wapPrice: 100,
          wtdYtm: 6,
          totalTradeValueLacs: 100,
        },
      ],
      [{ isin: "IN0020210012", symbol: "  cg2032 ", issueName: " 6.54% " }],
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.rows[0]!.isin, "IN0020210012");
  });

  it("one pair repeated with the SAME isin stays unambiguous", () => {
    // A duplicated master row must not look like a two-ISIN conflict.
    const res = resolveWdmTrades(
      [
        {
          symbol: "X",
          issueName: "1%",
          date: new Date("2026-08-17T00:00:00Z"),
          lastPrice: 100,
          wapPrice: 100,
          wtdYtm: 1,
          totalTradeValueLacs: 100,
        },
      ],
      [
        { isin: "INE000000001", symbol: "X", issueName: "1%" },
        { isin: "INE000000001", symbol: "X", issueName: "1%" },
      ],
    );
    assert.equal(res.rows.length, 1);
    assert.equal(res.reasons.ambiguousPair, undefined);
  });

  it("a master row with no issueName cannot resolve anything", () => {
    const res = resolveWdmTrades(
      [
        {
          symbol: "Y",
          issueName: "2%",
          date: new Date("2026-08-17T00:00:00Z"),
          lastPrice: 100,
          wapPrice: 100,
          wtdYtm: 2,
          totalTradeValueLacs: 100,
        },
      ],
      [{ isin: "INE000000002", symbol: "Y", issueName: null }],
    );
    assert.equal(res.rows.length, 0);
    assert.equal(res.reasons.noMasterMatch, 1);
  });
});
