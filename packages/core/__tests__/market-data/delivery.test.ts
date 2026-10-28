/**
 * UNIT TEST — delivery parsers (MONEY-1100 P4.1).
 *
 * Fixtures are cut from REAL repaired archive files (post MONEY-1169):
 *   sec_bhavdata_full.sample.csv  <- feeds/NSE/sec-bhavdata-full/2026/08/…07082026.csv
 *   scbseall.sample.txt           <- feeds/BSE/gross-delivery/2026/08/SCBSEALL1008.zip
 * so every assertion is against bytes NSE/BSE actually published, including
 * the space padding and `-` placeholders the map warns about.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseSecBhavdataFull,
  parseScbseallGrossDelivery,
  parseDeliveryDate,
  collapseBySeriesPreference,
} from "../../src/market-data/delivery";
import { utcMidnightOf } from "../../src/market-data/feed-backfill-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");
const NSE_CSV = readFileSync(
  join(FIXTURES, "sec_bhavdata_full.sample.csv"),
  "utf-8",
);
const BSE_TXT = readFileSync(join(FIXTURES, "scbseall.sample.txt"), "utf-8");

const AUG7 = new Date(Date.UTC(2026, 7, 7));
const AUG10 = new Date(Date.UTC(2026, 7, 10));

describe("parseDeliveryDate", () => {
  it("parses DD-MMM-YYYY and rejects rollover", () => {
    assert.equal(
      parseDeliveryDate("07-Aug-2026")!.toISOString().slice(0, 10),
      "2026-08-07",
    );
    assert.equal(parseDeliveryDate("31-Feb-2026"), null, "rollover must fail");
    assert.equal(
      parseDeliveryDate("2026-08-07"),
      null,
      "ISO is not this format",
    );
  });
});

describe("parseSecBhavdataFull (real NSE rows)", () => {
  const out = parseSecBhavdataFull(NSE_CSV, AUG7);

  it("parses every fixture row despite space padding", () => {
    assert.equal(out.rows.length, 7);
    assert.equal(out.skipped, 0);
    assert.equal(out.dateMismatch, 0);
  });

  it("reads a plain EQ row exactly as published", () => {
    const r = out.rows.find((x) => x.symbol === "20MICRONS")!;
    assert.equal(r.series, "EQ");
    assert.equal(r.close, 189.07);
    assert.equal(r.avgPrice, 190.71);
    assert.equal(r.volume, 126589);
    assert.equal(r.trades, 2798);
    assert.equal(r.deliveryQty, 73242);
    assert.equal(r.deliveryPct, 57.86);
    // TURNOVER_LACS 241.41 -> rupees
    assert.equal(r.turnover, 241.41 * 100_000);
  });

  it("stores `-` as NULL on trade-for-trade rows — never 0, never 100", () => {
    // BE series: delivery is 100% by construction and NSE prints `-`.
    // Fabricating either number poisons the delivery-% signal downstream.
    const be = out.rows.find((x) => x.symbol === "AAREYDRUGS")!;
    assert.equal(be.series, "BE");
    assert.equal(be.deliveryQty, null);
    assert.equal(be.deliveryPct, null);
    // …while the traded columns on the same row still parse.
    assert.equal(be.volume, 7631);
    assert.equal(be.trades, 65);
  });

  it("keeps non-equity series rows for the writer to resolve-or-drop", () => {
    // GS (G-sec) parses fine here; the WRITER drops unresolved symbols with
    // counters (never mints instruments from price files — MONEY-1085).
    const gs = out.rows.find((x) => x.series === "GS")!;
    assert.equal(gs.symbol, "1018GS2026");
    assert.equal(gs.deliveryPct, 100);
    const sm = out.rows.find((x) => x.series === "SM")!;
    assert.equal(sm.deliveryPct, 88.89);
  });

  it("excludes rows whose own DATE1 disagrees with the archive key's date", () => {
    const wrongDay = parseSecBhavdataFull(NSE_CSV, AUG10);
    assert.equal(wrongDay.rows.length, 0);
    assert.equal(wrongDay.dateMismatch, 7);
    // MONEY-1612: WHICH date, not just how many — a stale copy is told from
    // the only copy of a weekend session by the date it holds.
    assert.deepEqual(wrongDay.mismatchedDates, ["2026-08-07"]);
    assert.deepEqual(out.mismatchedDates, []);
  });
});

describe("parseScbseallGrossDelivery (real BSE rows)", () => {
  const out = parseScbseallGrossDelivery(BSE_TXT, AUG10);

  it("parses the pipe layout and strips zero padding", () => {
    assert.equal(out.rows.length, 5);
    assert.equal(out.skipped, 0);
    const r = out.rows.find((x) => x.scripCode === "937455")!;
    assert.equal(r.deliveryQty, 974);
    assert.equal(r.deliveryVal, 978091);
    assert.equal(r.volume, 974);
    assert.equal(r.turnover, 978046);
    assert.equal(r.deliveryPct, 100);
  });

  it("keys by scrip code only — the file has no name column to tempt a name join", () => {
    for (const r of out.rows) assert.match(r.scripCode, /^\d+$/);
  });

  it("rejects rows for a different day and malformed field counts", () => {
    const wrongDay = parseScbseallGrossDelivery(BSE_TXT, AUG7);
    assert.equal(wrongDay.rows.length, 0);
    assert.equal(wrongDay.dateMismatch, 5);

    const mangled = parseScbseallGrossDelivery(
      "DATE|SCRIP CODE|X\n10082026|937455|1|2\n",
      AUG10,
    );
    assert.equal(mangled.rows.length, 0);
    assert.equal(
      mangled.skipped,
      1,
      "6-field row must be skipped, not guessed",
    );
  });
});

describe("collapseBySeriesPreference (the createMany self-collision fix)", () => {
  const e = (instrumentId: string, series: string, tag: number) => ({
    instrumentId,
    row: { series, tag },
  });

  it("keeps EQ over BE when both series resolve to one instrument", () => {
    // The production shape: one symbol, two series rows, one instrumentId.
    // Unfixed, this pair made createMany throw and cost the WHOLE file.
    const { kept, collapsed } = collapseBySeriesPreference([
      e("id1", "BE", 1),
      e("id1", "EQ", 2),
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0]!.row.series, "EQ");
    assert.equal(collapsed, 1);
  });

  it("is deterministic regardless of input order", () => {
    const a = collapseBySeriesPreference([e("x", "EQ", 1), e("x", "BE", 2)]);
    const b = collapseBySeriesPreference([e("x", "BE", 2), e("x", "EQ", 1)]);
    assert.equal(a.kept[0]!.row.series, b.kept[0]!.row.series);
  });

  it("unknown series rank below every known one, ties break on the string", () => {
    const { kept } = collapseBySeriesPreference([
      e("y", "GB", 1),
      e("y", "SM", 2),
    ]);
    assert.equal(kept[0]!.row.series, "SM");
    const tie = collapseBySeriesPreference([e("z", "N2", 1), e("z", "N1", 2)]);
    assert.equal(tie.kept[0]!.row.series, "N1");
  });

  it("passes distinct instruments through untouched", () => {
    const { kept, collapsed } = collapseBySeriesPreference([
      e("a", "EQ", 1),
      e("b", "EQ", 2),
    ]);
    assert.equal(kept.length, 2);
    assert.equal(collapsed, 0);
  });
});

describe("utcMidnightOf (the noon-fork postmortem helper)", () => {
  it("collapses the walk's UTC-noon convention to row-date midnight", () => {
    const noon = new Date(Date.UTC(2026, 7, 7, 12));
    assert.equal(utcMidnightOf(noon).toISOString(), "2026-08-07T00:00:00.000Z");
  });
  it("is a fixpoint on already-midnight dates", () => {
    const mid = new Date(Date.UTC(2026, 7, 7));
    assert.equal(utcMidnightOf(mid).toISOString(), mid.toISOString());
  });
});
