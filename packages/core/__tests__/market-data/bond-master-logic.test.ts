/**
 * UNIT TEST — debt security master parsers (MONEY-1204, P14 / 14b.1).
 *
 * Both fixtures are cut BY WHOLE ROWS from the prod archive
 * (`gs://stockbook-content-prod`, 2026-08-16):
 *
 *   wdmlist_14082026.sample.csv                   60 of 10,678 data rows
 *   Corporate_bond_report_14-Aug-2026.sample.csv  54 of  3,717 data rows
 *
 * Real bytes, not a guessed layout: MONEY-1201's synthetic SLB fixture passed
 * green while wrong on three of four columns, because the fixture encoded the
 * same misunderstanding as the parser it was testing.
 *
 * What this file pins that the registry notes get wrong or do not say:
 *
 * 1. The corporate report's preamble is FIVE rows, not the "two banner rows"
 *    the registry describes — two banners, a `Details report for :- …` line
 *    and two rows of bare commas — so the header sits at row index 5 and is
 *    FOUND, never assumed.
 * 2. `0` in the last-traded-price column is NSE's never-traded filler. The
 *    correlation in the archived bytes is exact: 34 of 60 wdmlist rows and 31
 *    of 54 corporate rows print an empty trade date AND a zero price; not one
 *    row prints a zero price alongside a real date. Stored as 0 those become
 *    bonds that trade at ₹0.
 * 3. Perpetual paper (BOB / Canara / SBI Tier-1 — 26 of the 54 corporate rows)
 *    prints an EMPTY maturity date. That null is the fact.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  bondNum,
  bondText,
  normalizeBondIsin,
  parseCorporateBondReport,
  parseCouponPercent,
  parseWdmList,
  resolveLastTraded,
  type BondMasterRow,
} from "../../src/market-data/bond-master-logic";
import { normalizeMasterIsin } from "../../src/market-data/instruments/nse-master-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "nse-debt");
const WDM_CSV = readFileSync(
  join(FIXTURES, "wdmlist_14082026.sample.csv"),
  "utf-8",
);
const CORP_CSV = readFileSync(
  join(FIXTURES, "Corporate_bond_report_14-Aug-2026.sample.csv"),
  "utf-8",
);

/** Rebuild a fixture with one cell of one data row replaced. */
function withCell(
  csv: string,
  lineIndex: number,
  cellIndex: number,
  value: string,
): string {
  const lines = csv.split(/\r?\n/);
  const cells = (lines[lineIndex] ?? "").split(",");
  cells[cellIndex] = value;
  lines[lineIndex] = cells.join(",");
  return lines.join("\n");
}

const NOT_A_REPORT =
  "<html><head><title>404 Not Found</title></head><body>nginx</body></html>";

// ─── wdmlist: the wholesale debt master ──────────────────────────────

describe("parseWdmList — real archived wdmlist_14082026.csv", () => {
  const out = parseWdmList(WDM_CSV);
  assert.ok(out, "the real wdmlist must parse");

  it("parses every data row and skips nothing", () => {
    assert.equal(out.rows.length, 60);
    assert.equal(out.skipped, 0);
  });

  it("reads the first row cell-by-cell", () => {
    // GS,CG2036,8.33%,GOI LOAN 8.33% 2036,07-Jun-2006,07-Jun-2036,07-Jun-2026,
    // 07-Dec-2026,Half Yearly,12-Nov-2025,111.5522,IN0020060045,Listed
    assert.deepEqual(out.rows[0], {
      isin: "IN0020060045",
      symbol: "CG2036",
      secType: "GS",
      issuer: null,
      issueName: "8.33%",
      issueDesc: "GOI LOAN 8.33% 2036",
      creditRating: null,
      coupon: 8.33,
      couponFrequency: "Half Yearly",
      faceValue: null,
      issueDate: new Date(Date.UTC(2006, 5, 7)),
      maturityDate: new Date(Date.UTC(2036, 5, 7)),
      // `Next IP Dt` — the NEXT interest payment, not `Last IP Dt` beside it.
      nextCouponDate: new Date(Date.UTC(2026, 11, 7)),
      lastTradedDate: new Date(Date.UTC(2025, 10, 12)),
      lastTradedPrice: 111.5522,
      status: "Listed",
      source: "nse-wdm-list",
    } satisfies BondMasterRow);
  });

  it("carries NO as-of date — wdmlist prints none in any column", () => {
    // The day exists only in the object key (`wdmlist_14082026.csv`). Returning
    // it from a byte parser would be a lie about where the fact came from, so
    // the writer stamps BondMaster.asOf from the key when this is null.
    assert.equal(out.asOf, null);
  });

  it("never stores NSE's zero as a price: no trade date ⇒ no price", () => {
    const untraded = out.rows.filter((r) => r.lastTradedDate === null);
    assert.equal(untraded.length, 34);
    for (const row of untraded) {
      assert.equal(
        row.lastTradedPrice,
        null,
        `${row.isin} kept a price with no trade date`,
      );
    }
    // Every drop is named and counted; the file's other 26 rows priced fine.
    assert.deepEqual(out.reasons, { untradedFillerZero: 34 });
  });

  it("reads a never-traded row without inventing a zero-price bond", () => {
    // TS,PIDB26,0.40%,PUNJAB INFRA 0.4% 2026 SIII C,…,Yearly,,0,INE091D11139,Listed
    const row = out.rows.find((r) => r.isin === "INE091D11139");
    assert.ok(row);
    assert.equal(row.symbol, "PIDB26");
    assert.equal(row.secType, "TS");
    assert.equal(row.coupon, 0.4); // "0.40%" — a real coupon, small
    assert.equal(row.lastTradedDate, null);
    assert.equal(row.lastTradedPrice, null); // the file says `0`
  });

  it("normalises every emitted ISIN and emits each one once", () => {
    const seen = new Set<string>();
    for (const row of out.rows) {
      assert.equal(row.isin, row.isin.trim().toUpperCase());
      assert.ok(row.isin.length >= 12, row.isin);
      assert.ok(!seen.has(row.isin), `duplicate ${row.isin}`);
      seen.add(row.isin);
    }
    assert.equal(seen.size, 60);
  });

  it("drops a row with no ISIN and names the reason", () => {
    const broken = parseWdmList(withCell(WDM_CSV, 1, 11, ""));
    assert.ok(broken);
    assert.equal(broken.rows.length, 59);
    assert.equal(broken.skipped, 1);
    assert.equal(broken.reasons.noIsin, 1);
  });
});

// ─── Corporate bond report: the CBM security master ──────────────────

describe("parseCorporateBondReport — real archived 14-Aug-2026 report", () => {
  const out = parseCorporateBondReport(CORP_CSV);
  assert.ok(out, "the real corporate bond report must parse");

  it("skips the FIVE-row preamble and finds the real header", () => {
    // Registry note says "two banner rows"; the bytes carry five. Row 0 as
    // header would read `,,,National Stock Exchange Of India Limited,,,` as
    // column names and report all 3,717 real rows as malformed.
    const lines = CORP_CSV.split(/\r?\n/);
    assert.match(lines[0]!, /National Stock Exchange Of India Limited/);
    assert.match(lines[1]!, /Negotiated Trade Reporting Platform/);
    assert.match(lines[2]!, /Details report for/);
    assert.equal(lines[3]!.replace(/,/g, ""), "");
    assert.equal(lines[4]!.replace(/,/g, ""), "");
    assert.match(lines[5]!, /^Sectype,Security,Issue Name,/);

    assert.equal(out.rows.length, 54);
    assert.equal(out.skipped, 0);
    assert.equal(out.rows[0]?.symbol, "AXBK32");
  });

  it("scans for the header rather than jumping a fixed five rows", () => {
    const padded = `,,,extra banner,,,\n,,,,,\n,,,,,\n${CORP_CSV}`;
    const shifted = parseCorporateBondReport(padded);
    assert.ok(shifted);
    assert.equal(shifted.rows.length, 54);
    assert.equal(shifted.skipped, 0);
    assert.deepEqual(shifted.rows[0], out.rows[0]);
  });

  it("takes its as-of date from the file's own banner, not the filename", () => {
    // `Details report for :- 14-Aug-2026` (row 3). House rule: the bytes beat
    // the archive key — the two diverge on a replay or a late publication.
    assert.deepEqual(out.asOf, new Date(Date.UTC(2026, 7, 14)));
  });

  it("reads a perpetual bond cell-by-cell and keeps maturityDate null", () => {
    // AT,BOB,7.88%,BOB 7.88% Perp Tier 1 Sr XIX,BANK OF BARODA,100.00,,
    // 02-Sep-2022,,,,Yearly,02-Sep-2026,ACTUALby365,,,13-Jun-2024,98.9844,
    // 400.00,8.2300,,,,INE028A08299,Listed
    const row = out.rows.find((r) => r.isin === "INE028A08299");
    assert.ok(row);
    assert.deepEqual(row, {
      isin: "INE028A08299",
      symbol: "BOB",
      secType: "AT",
      issuer: "BANK OF BARODA",
      issueName: "7.88%",
      issueDesc: "BOB 7.88% Perp Tier 1 Sr XIX",
      creditRating: null,
      coupon: 7.88,
      couponFrequency: "Yearly",
      faceValue: 100,
      issueDate: new Date(Date.UTC(2022, 8, 2)),
      maturityDate: null, // perpetual: never redeems, empty cell IS the fact
      nextCouponDate: new Date(Date.UTC(2026, 8, 2)),
      lastTradedDate: new Date(Date.UTC(2024, 5, 13)),
      lastTradedPrice: 98.9844,
      status: "Listed",
      source: "nse-corporate-bond-report",
    } satisfies BondMasterRow);
  });

  it("counts perpetuals instead of defaulting a redemption date", () => {
    const perpetual = out.rows.filter((r) => r.maturityDate === null);
    assert.equal(perpetual.length, 26);
    assert.equal(out.reasons.noMaturityDate, 26);
    // Symbol is NOT the key: `BOB` is three rows in this 54-row window (four
    // in the full 3,717-row file, per the BondMaster docblock), each a
    // different ISIN, and `SBI` is eight. An upsert keyed on symbol would
    // collapse a bank's whole Tier-1 stack into one row.
    const bob = out.rows.filter((r) => r.symbol === "BOB");
    assert.equal(bob.length, 3);
    assert.equal(new Set(bob.map((r) => r.isin)).size, 3);
    assert.equal(out.rows.filter((r) => r.symbol === "SBI").length, 8);
  });

  it("applies the same zero-filler rule as wdmlist", () => {
    const untraded = out.rows.filter((r) => r.lastTradedDate === null);
    assert.equal(untraded.length, 31); // the file prints `0.0000` for each
    assert.ok(untraded.every((r) => r.lastTradedPrice === null));
    assert.deepEqual(out.reasons, {
      untradedFillerZero: 31,
      noMaturityDate: 26,
    });
  });

  it("yields issuer + faceValue, and a BLANK credit rating as null", () => {
    assert.ok(out.rows.every((r) => r.issuer !== null));
    assert.ok(out.rows.every((r) => r.faceValue === 100));
    // The column exists and is empty in all 54 archived rows — null, not "".
    assert.ok(out.rows.every((r) => r.creditRating === null));
  });

  it("reads a blank numeric cell as null, never 0", () => {
    // `Number("")` is 0; a face value of ₹0 would silently divide wrong
    // everywhere downstream. Blank the real AXBK32 row's Face Value cell.
    const blanked = parseCorporateBondReport(withCell(CORP_CSV, 6, 5, ""));
    assert.ok(blanked);
    assert.equal(blanked.rows[0]?.isin, "INE238A08484");
    assert.equal(blanked.rows[0]?.faceValue, null);
    assert.notEqual(blanked.rows[0]?.faceValue, 0);
  });

  it("keeps the first of two rows for one ISIN and counts the collision", () => {
    // BondMaster.isin is @unique — two rows would become a last-write-wins
    // upsert, i.e. an order-dependent master (MONEY-1201's SLB lesson).
    const lines = CORP_CSV.split(/\r?\n/);
    const dup = [...lines.slice(0, 7), lines[6], ...lines.slice(7)].join("\n");
    const out2 = parseCorporateBondReport(dup);
    assert.ok(out2);
    assert.equal(out2.rows.length, 54);
    assert.equal(out2.skipped, 1);
    assert.equal(out2.reasons.duplicateIsin, 1);
  });
});

// ─── "Not this report" vs "this report, and it was empty" ────────────

describe("the null signal is not the empty-rows signal", () => {
  it("returns null for bytes that are not the report at all", () => {
    for (const bytes of [NOT_A_REPORT, "", "   ", "a,b,c\n1,2,3"]) {
      assert.equal(parseWdmList(bytes), null);
      assert.equal(parseCorporateBondReport(bytes), null);
    }
  });

  it("returns null when each master is handed the OTHER master's bytes", () => {
    // The discriminators: wdmlist spells the column `ISIN NO.`, the corporate
    // report spells it `ISIN` and is the only one with `Issuer`. Loosen either
    // alias list and each parser starts emitting a half-empty master from the
    // other family's file instead of saying "not this report".
    assert.equal(parseWdmList(CORP_CSV), null);
    assert.equal(parseCorporateBondReport(WDM_CSV), null);
  });

  it("returns rows:[] — NOT null — for a real header carrying no rows", () => {
    const headerOnly = WDM_CSV.split(/\r?\n/)[0]!;
    const out = parseWdmList(headerOnly);
    assert.ok(out, "a header with no data rows is still this report");
    assert.deepEqual(out.rows, []);
    assert.equal(out.skipped, 0);

    const corpHeaderOnly = CORP_CSV.split(/\r?\n/).slice(0, 6).join("\n");
    const out2 = parseCorporateBondReport(corpHeaderOnly);
    assert.ok(out2);
    assert.deepEqual(out2.rows, []);
    assert.deepEqual(out2.asOf, new Date(Date.UTC(2026, 7, 14)));
  });
});

// ─── Absence + coupon rules ──────────────────────────────────────────

describe("absence is null, never zero", () => {
  it("reads blanks and placeholders as null but keeps a real zero", () => {
    assert.equal(bondNum(""), null);
    assert.equal(bondNum("   "), null);
    assert.equal(bondNum("-"), null);
    assert.equal(bondNum("NA"), null);
    assert.equal(bondNum("junk"), null);
    assert.equal(bondNum("0"), 0); // explicit zero is a value
    assert.equal(bondNum("0.00"), 0);
    assert.equal(bondNum("100.2612"), 100.2612);
    assert.equal(bondNum("1,50,000"), 150000); // Indian lakh grouping
    assert.equal(bondText(""), null);
    assert.equal(bondText("-"), null);
    assert.equal(bondText(" Listed "), "Listed");
  });

  it("parses the coupon out of ISSUE_NAME and never guesses one", () => {
    assert.equal(parseCouponPercent("8.33%"), 8.33);
    assert.equal(parseCouponPercent("8%"), 8);
    assert.equal(parseCouponPercent("8.785%"), 8.785);
    assert.equal(parseCouponPercent(" 0.40% "), 0.4);
    // An explicit 0% IS a zero-coupon bond; an unreadable label is NOT.
    assert.equal(parseCouponPercent("0%"), 0);
    assert.equal(parseCouponPercent(""), null);
    assert.equal(parseCouponPercent("MIBOR+150bps"), null);
    assert.equal(parseCouponPercent("ZCB"), null);
    assert.notEqual(parseCouponPercent("ZCB"), 0);
  });

  it("names all three ways a last-traded price gets dropped", () => {
    const r1: Record<string, number> = {};
    assert.deepEqual(resolveLastTraded("", "0", r1), {
      lastTradedDate: null,
      lastTradedPrice: null,
    });
    assert.deepEqual(r1, { untradedFillerZero: 1 });

    const r2: Record<string, number> = {};
    assert.deepEqual(resolveLastTraded("", "104.25", r2), {
      lastTradedDate: null,
      lastTradedPrice: null,
    });
    assert.deepEqual(r2, { priceWithoutTradeDate: 1 });

    const r3: Record<string, number> = {};
    assert.deepEqual(resolveLastTraded("12-Nov-2025", "0", r3), {
      lastTradedDate: new Date(Date.UTC(2025, 10, 12)),
      lastTradedPrice: null,
    });
    assert.deepEqual(r3, { zeroPriceWithTradeDate: 1 });

    // A real print survives untouched and raises no counter.
    const r4: Record<string, number> = {};
    assert.deepEqual(resolveLastTraded("12-Nov-2025", "111.5522", r4), {
      lastTradedDate: new Date(Date.UTC(2025, 10, 12)),
      lastTradedPrice: 111.5522,
    });
    assert.deepEqual(r4, {});
  });
});

// ─── The ISIN normaliser ─────────────────────────────────────────────

describe("normalizeBondIsin", () => {
  it("trims, upper-cases and rejects anything under 12 chars", () => {
    assert.equal(normalizeBondIsin("INE261F08EO7 "), "INE261F08EO7");
    assert.equal(normalizeBondIsin("  IN0020060045  "), "IN0020060045");
    assert.equal(normalizeBondIsin("ine053f09eo6"), "INE053F09EO6");
    assert.equal(normalizeBondIsin(""), null);
    assert.equal(normalizeBondIsin("   "), null);
    assert.equal(normalizeBondIsin("-"), null);
    assert.equal(normalizeBondIsin("INE261F08"), null); // 9 chars
    assert.equal(normalizeBondIsin(null), null);
    assert.equal(normalizeBondIsin(undefined), null);
  });

  it("is the SAME normaliser the instrument master and bhavcopy join on", () => {
    // Not a style point: BondMaster.isin has to normalise identically to
    // InstrumentMapping's ~12k DEBT rows or the join silently matches nothing.
    // If this fires, one of the two was forked — re-delegate, do not "fix" the
    // expectations.
    for (const raw of [
      "INE261F08EO7 ",
      " in0020060045",
      "INE053F09EO6",
      "",
      "-",
      "SHORT",
      "  ",
    ]) {
      assert.equal(
        normalizeBondIsin(raw),
        normalizeMasterIsin(raw),
        `drift on ${JSON.stringify(raw)}`,
      );
    }
  });
});
