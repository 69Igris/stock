/**
 * UNIT TEST — legacy (pre-UDiFF) BSE cash bhavcopy parsing (MONEY-1101 / P7).
 *
 * Every fixture below is cut from bytes actually served by
 * www.bseindia.com on **2026-08-13**, not invented:
 *
 *   eq020107_csv.zip        -> EQ020107.CSV     (14 cols, no ISIN)
 *   EQ_ISINCODE_030117.zip  -> …,ISIN_CODE,FILLER1,…      (early 2017)
 *   EQ_ISINCODE_150323.zip  -> …,ISIN_CODE,TRADING_DATE,… (mid-2017 →)
 *
 * The two load-bearing cases are marked REGRESSION:
 *
 *   1. An UNRECOGNISED header returns `null`, never `[]`. A failed parse and an
 *      empty file must be different values — MONEY-1189 lost 37 windows because
 *      they were the same one, and the run reported DONE while data was gone.
 *   2. The SAME era changes columns mid-2017 (`FILLER1` → `TRADING_DATE`), so a
 *      parser that hard-requires `TRADING_DATE` silently yields zero rows for
 *      every early-2017 file.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parseOldBseCmBhavcopy,
  detectBseLegacyVariant,
  parseBseLegacyTradingDate,
} from "../../src/market-data/bhavcopy-bse-legacy";

/** The trading day an archive key would claim. UTC noon, as the walk builds it. */
const day = (iso: string): Date => new Date(`${iso}T12:00:00Z`);

// ── Fixtures, cut from the real files ────────────────────────────────

/** 14 columns, NO ISIN — `eq{DDMMYY}_csv.zip`. Real rows from EQ020107.CSV. */
const PLAIN_CSV = [
  "SC_CODE,SC_NAME,SC_GROUP,SC_TYPE,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,NO_TRADES,NO_OF_SHRS,NET_TURNOV,TDCLOINDI",
  "526921,21ST CEN.MGM,B ,Q,34.35,34.35,34.35,34.35,34.35,32.75,39,10619,364762.00,",
  "500002,ABB LTD.    ,A ,Q,3346.95,3349.35,3288.80,3302.35,3301.50,3306.45,742,3601,11942570.00,",
].join("\n");

/** 18 columns WITH ISIN, column 16 = FILLER1 — observed 2017-01-03. */
const ISIN_FILLER_CSV = [
  "SC_CODE,SC_NAME,SC_GROUP,SC_TYPE,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,NO_TRADES,NO_OF_SHRS,NET_TURNOV,TDCLOINDI,ISIN_CODE,FILLER1,FILLER2,FILLER3",
  "500002,ABB LTD.    ,A ,Q,1069.90,1069.90,1037.90,1045.05,1045.05,1039.95,187,950,994456.00,,INE117A01022,,,",
].join("\n");

/** 18 columns WITH ISIN + TRADING_DATE — observed 2017-07-03 onward. */
const ISIN_DATED_CSV = [
  "SC_CODE,SC_NAME,SC_GROUP,SC_TYPE,OPEN,HIGH,LOW,CLOSE,LAST,PREVCLOSE,NO_TRADES,NO_OF_SHRS,NET_TURNOV,TDCLOINDI,ISIN_CODE,TRADING_DATE,FILLER2,FILLER3",
  "500002,ABB LTD.    ,A ,Q,3346.95,3349.35,3288.80,3302.35,3301.50,3306.45,742,3601,11942570.00,,INE117A01022,15-Mar-23,,",
  // Group F is corporate debt — the ticket's "BSE files include F-group bonds".
  "973270,NCD SERIES ,F ,D,1005.00,1010.00,1000.00,1008.50,1008.50,1004.00,12,340,342890.00,,INE123A07012,15-Mar-23,,",
].join("\n");

// ── Format detection ─────────────────────────────────────────────────

describe("detectBseLegacyVariant — by NAME, never by position", () => {
  it("classifies the three real layouts", () => {
    const cols = (csv: string): string[] => csv.split("\n")[0]!.split(",");
    assert.equal(detectBseLegacyVariant(cols(PLAIN_CSV)), "plain");
    assert.equal(detectBseLegacyVariant(cols(ISIN_FILLER_CSV)), "isin-filler");
    assert.equal(detectBseLegacyVariant(cols(ISIN_DATED_CSV)), "isin-dated");
  });

  it("REGRESSION: an unknown header is null, so the caller can tell it apart from an empty file", () => {
    // The MONEY-1189 conflation. `null` here is what makes the parse job throw
    // and leave the file un-checkpointed; `[]` would checkpoint ZERO and read
    // as a legitimately empty trading day forever after.
    assert.equal(detectBseLegacyVariant(["TckrSymb", "ClsPric"]), null);
    assert.equal(detectBseLegacyVariant([]), null);
    // Missing exactly ONE required column is still unrecognised — a partial
    // match is the dangerous case, because it is the one that looks fine.
    assert.equal(
      detectBseLegacyVariant([
        "SC_CODE",
        "SC_GROUP",
        "OPEN",
        "HIGH",
        "LOW",
        "CLOSE",
      ]),
      null,
    );
  });

  it("is order- and case-independent", () => {
    // BSE moved column 16 inside a single year, so position proves nothing.
    assert.equal(
      detectBseLegacyVariant([
        "no_of_shrs",
        "close",
        "low",
        "high",
        "open",
        "sc_group",
        "sc_code",
      ]),
      "plain",
    );
  });
});

// ── The unrecognised-shape contract ──────────────────────────────────

describe("parseOldBseCmBhavcopy — failure and emptiness are different values", () => {
  it("REGRESSION: an unrecognised file returns null, NOT an empty result", () => {
    const out = parseOldBseCmBhavcopy(
      "TckrSymb,ClsPric\nRELIANCE,1400\n",
      day("2023-03-15"),
    );
    assert.equal(out, null);
  });

  it("a RECOGNISED file with no data rows returns a result with rows: []", () => {
    // The other half of the same contract: this one IS a successful parse of a
    // genuinely empty file, and it must not look like a failure.
    const out = parseOldBseCmBhavcopy(
      PLAIN_CSV.split("\n")[0]!,
      day("2007-01-02"),
    );
    assert.notEqual(out, null);
    assert.deepEqual(out!.rows, []);
    assert.equal(out!.variant, "plain");
  });

  it("REGRESSION: the early-2017 FILLER1 layout parses — TRADING_DATE is optional", () => {
    // A parser calibrated only on the mid-2017 file would return zero rows for
    // every January-2017 day and checkpoint them as empty.
    const out = parseOldBseCmBhavcopy(ISIN_FILLER_CSV, day("2017-01-03"));
    assert.notEqual(out, null);
    assert.equal(out!.variant, "isin-filler");
    assert.equal(out!.rows.length, 1);
    assert.equal(out!.rows[0]!.isin, "INE117A01022");
    // No TRADING_DATE column exists, so nothing can mismatch.
    assert.equal(out!.dateMismatch, 0);
  });
});

// ── Row mapping ──────────────────────────────────────────────────────

describe("parseOldBseCmBhavcopy — row mapping", () => {
  it("carries the scrip code as identity and the group as series", () => {
    const out = parseOldBseCmBhavcopy(ISIN_DATED_CSV, day("2023-03-15"))!;
    const abb = out.rows.find((r) => r.scripCode === "500002")!;
    assert.equal(abb.scripCode, "500002");
    // No ticker exists in this era; the scrip code doubles as the symbol so
    // symbol@BSE is a real second resolution route.
    assert.equal(abb.symbol, "500002");
    assert.equal(abb.exchange, "BSE");
    // Trimmed: every text column in these files is space-padded ("A ").
    assert.equal(abb.series, "A");
    assert.equal(abb.name, "ABB LTD.");
    assert.equal(abb.close, 3302.35);
    assert.equal(abb.open, 3346.95);
    assert.equal(abb.prevClose, 3306.45);
    assert.equal(abb.volume, 3601);
  });

  it("keeps F-group debt rather than dropping it — the group letter types it later", () => {
    // MONEY-1093: `classifyCashInstrument` reads `series` to decide EQUITY vs
    // DEBT. Filtering bonds out here would strand exactly the rows the ticket
    // names, and a bond has a real close.
    const out = parseOldBseCmBhavcopy(ISIN_DATED_CSV, day("2023-03-15"))!;
    const bond = out.rows.find((r) => r.scripCode === "973270");
    assert.ok(bond, "F-group row must survive the parse");
    assert.equal(bond!.series, "F");
  });

  it("leaves isin null (not empty string) for the pre-2017 era and counts it", () => {
    const out = parseOldBseCmBhavcopy(PLAIN_CSV, day("2007-01-02"))!;
    assert.equal(out.rows.length, 2);
    assert.equal(out.withoutIsin, 2);
    for (const r of out.rows) assert.equal(r.isin, null);
  });

  it("dates every row from the ARCHIVE KEY, at UTC midnight", () => {
    // The file's own TRADING_DATE is a cross-check only. The key is the
    // authority on which day was requested.
    const out = parseOldBseCmBhavcopy(ISIN_DATED_CSV, day("2023-03-15"))!;
    for (const r of out.rows) {
      assert.equal(r.date.toISOString(), "2023-03-15T00:00:00.000Z");
    }
  });

  it("excludes and COUNTS a row whose TRADING_DATE disagrees with the key", () => {
    // A mis-filed row must never be stored under the day we asked for.
    const out = parseOldBseCmBhavcopy(ISIN_DATED_CSV, day("2023-03-16"))!;
    assert.equal(out.rows.length, 0);
    assert.equal(out.dateMismatch, 2);
  });
});

// ── Non-finite guards ────────────────────────────────────────────────

describe("parseOldBseCmBhavcopy — non-finite money never reaches a row", () => {
  const withClose = (close: string, open = "10.00"): string =>
    [
      PLAIN_CSV.split("\n")[0]!,
      `500002,ABB LTD.    ,A ,Q,${open},10.00,10.00,${close},10.00,10.00,1,5,50.00,`,
    ].join("\n");

  it("drops a row with a blank / dash / NA close and counts it by group", () => {
    for (const bad of ["", "-", "NA", "abc"]) {
      const out = parseOldBseCmBhavcopy(withClose(bad), day("2007-01-02"))!;
      assert.equal(out.rows.length, 0, `close=${JSON.stringify(bad)}`);
      assert.equal(out.skipped, 1);
      // Counted BY GROUP so a whole segment losing its prices is visible.
      assert.equal(out.droppedByGroup.A, 1);
    }
  });

  it("never emits NaN or Infinity for any OHLC leg", () => {
    const out = parseOldBseCmBhavcopy(
      withClose("10.00", "-"),
      day("2007-01-02"),
    )!;
    const r = out.rows[0]!;
    for (const v of [r.open, r.high, r.low, r.close, r.volume]) {
      assert.ok(Number.isFinite(v), `expected finite, got ${v}`);
    }
    // A missing OPEN falls back to the close — an honest flat bar, never a 0
    // leg, which would render as a 100% wick.
    assert.equal(r.open, 10);
  });

  it("drops a row with no SC_CODE — there is no other identity in this era", () => {
    const csv = [
      PLAIN_CSV.split("\n")[0]!,
      ",ABB LTD.    ,A ,Q,10.00,10.00,10.00,10.00,10.00,10.00,1,5,50.00,",
    ].join("\n");
    const out = parseOldBseCmBhavcopy(csv, day("2007-01-02"))!;
    assert.equal(out.rows.length, 0);
    assert.equal(out.skipped, 1);
  });
});

// ── The two-digit year ───────────────────────────────────────────────

describe("parseBseLegacyTradingDate — DD-Mon-YY", () => {
  it("parses the real format", () => {
    assert.equal(
      parseBseLegacyTradingDate("15-Mar-23")!.toISOString(),
      "2023-03-15T00:00:00.000Z",
    );
    assert.equal(
      parseBseLegacyTradingDate("01-Feb-24")!.toISOString(),
      "2024-02-01T00:00:00.000Z",
    );
  });

  it("rejects a rollover date instead of silently shifting it", () => {
    // `Date.UTC(2023, 1, 29)` is a perfectly valid 2023-03-01, so a NaN check
    // would accept 29-Feb-2023 and book the row two days late.
    assert.equal(parseBseLegacyTradingDate("29-Feb-23"), null);
    assert.equal(parseBseLegacyTradingDate("32-Jan-23"), null);
  });

  it("rejects junk and the 4-digit-year format rather than guessing", () => {
    for (const bad of ["", "-", "15-Mar-2023", "2023-03-15", "15/03/23"]) {
      assert.equal(parseBseLegacyTradingDate(bad), null, bad);
    }
  });
});
