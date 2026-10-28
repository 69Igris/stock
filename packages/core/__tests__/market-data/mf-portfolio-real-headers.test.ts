/**
 * The five houses this branch exists to un-break, against bytes THEY published.
 *
 * ## The defect this file closes is in the TESTS, not in the parser
 *
 * `mf-portfolio-as-on.test.ts` states the rule in its own header — *"NOT a
 * synthetic workbook: a hand-built one would agree with whatever the parser
 * did"* — and then TATA, 360 ONE, ZERODHA, KOTAK and ICICI were validated
 * against `XLSX.utils.aoa_to_sheet` fixtures whose header strings were typed
 * out by the same person who wrote the regex to match them.
 *
 * For two of the five that is not a weak test, it is a VACUOUS one. The whole
 * of MONEY-1405's Tata fix is that the header reads `ISIN CODE` and not `ISIN`;
 * the whole of the 360 ONE fix is `Rounded % to Net Assets` and not
 * `% to Net Assets`. A fixture that spells those strings by hand **cannot fail
 * for the reason the test was written**: mis-transcribe the header and the
 * regex written from the same mis-transcription matches it, green.
 *
 * ## What is committed instead
 *
 * Not five multi-megabyte workbooks — this is a monthly feed and there would be
 * sixty a year. The defect class is the HEADER TRANSCRIPTION, so what is
 * captured is the header block itself: every cell of every row from row 0 down
 * to the holdings header plus ten, copied out of the live file BY A SCRIPT,
 * with its number format (`z`) and the sheet's merge ranges. 29 KB for five
 * houses, and the header string is legible in the diff.
 *
 * Each fixture carries its own provenance — the URL it came from, the byte
 * count, the HTTP status, the User-Agent that worked and the timestamp — and
 * `provenance: "real"`. A future fixture that cannot be fetched must say
 * `"synthetic"` and say why; the `[meta]` test below refuses a fixture that
 * claims `"real"` without a source URL, so a synthetic one cannot quietly look
 * like this.
 *
 * ## Per-house provenance, all fetched 2026-09-14 from this machine
 *
 *   TATA       www.tatamutualfund.com page -> betacms host, 1,762,746 B, 71
 *              sheets. Header `ISIN CODE` at [11,4]; `Portfolio as on 31-08-26`.
 *   360 ONE    s3.ap-south-1.amazonaws.com, 283,616 B, 12 sheets. Header
 *              `Rounded % to Net Assets` at [3,6].
 *   ZERODHA    assets.zerodhafundhouse.com, 134,195 B, 1 sheet. Period stated
 *              `… FOR AUGUST 2026` — the preposition, and no day.
 *   KOTAK      vatseelabs-s3.kotakmf.com, 3,706,593 B, 120 sheets. `Name of
 *              Instrument` MERGED across A:C — the merge is in the fixture.
 *   ICICI      www.icicipruamc.com, 25,378,416 B, 147-member zip; the captured
 *              member is `BHARAT 22 ETF.xlsx`.
 *
 * **Every one answered with NO User-Agent header at all.** The brief for this
 * work warned that HDFC and Edelweiss 403 a self-identifying bot while WhiteOak
 * does the opposite; none of these five needed a string either way. The one
 * refusal measured was ICICI's PRIMARY url — see the sibling assertion in
 * `amc-portfolio-sources.test.ts`.
 *
 * ## What these tests are NOT
 *
 * They are not a second copy of `mf-portfolio-amc-headers.test.ts`. That file
 * pins the RULES (what a percent header may and may not match, where the span
 * stops) and a synthesised sheet is the right shape for a rule. This file pins
 * the INPUTS — that the strings those rules are aimed at are the strings the
 * publishers actually ship.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

import {
  parseAmcPortfolioWorkbook,
  type AmcSchemeSheet,
} from "../../src/market-data/mf-portfolio-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "amc-headers");

interface CapturedCell {
  v: string | number | boolean;
  t?: string;
  z?: string;
}

interface HeaderFixture {
  amc: string;
  provenance: "real" | "synthetic";
  /** Absent only on a `synthetic` fixture, which must then say why. */
  sourceUrl?: string;
  synthetic_reason?: string;
  fetchedAt?: string;
  httpStatus?: number;
  userAgent?: string;
  fileBytes?: number;
  dataMonth?: string;
  sheetName: string;
  sheetCountInFile?: number;
  headerRow: number;
  rowsCaptured: string;
  colsCaptured: number;
  note?: string;
  merges: XLSX.Range[];
  cells: (CapturedCell | null)[][];
}

function load(file: string): HeaderFixture {
  return JSON.parse(
    readFileSync(join(FIXTURES, file), "utf8"),
  ) as HeaderFixture;
}

/**
 * The captured cells back into a real OOXML workbook.
 *
 * Cell objects are written directly rather than through `aoa_to_sheet`, because
 * `aoa_to_sheet` writes no `z` — and `z` is the signal `dateReadableValue`
 * screens on, so a fixture that lost it would exercise a different parser.
 */
function workbookFrom(fx: HeaderFixture): Buffer {
  const ws: XLSX.WorkSheet = {};
  let maxCol = 0;
  fx.cells.forEach((row, r) => {
    row.forEach((cell, c) => {
      if (cell === null) return;
      maxCol = Math.max(maxCol, c);
      ws[XLSX.utils.encode_cell({ r, c })] = {
        t: cell.t ?? (typeof cell.v === "number" ? "n" : "s"),
        v: cell.v,
        ...(cell.z === undefined ? {} : { z: cell.z }),
      } as XLSX.CellObject;
    });
  });
  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: fx.cells.length - 1, c: maxCol },
  });
  if (fx.merges.length > 0) ws["!merges"] = fx.merges;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, fx.sheetName);
  return XLSX.write(wb, {
    type: "buffer",
    bookType: "xlsx",
    cellStyles: true,
  }) as Buffer;
}

function parseOne(file: string): { fx: HeaderFixture; sheet: AmcSchemeSheet } {
  const fx = load(file);
  const parsed = parseAmcPortfolioWorkbook(workbookFrom(fx), {});
  assert.ok(parsed, `${fx.amc}: the rebuilt workbook did not read at all`);
  assert.equal(
    parsed.sheets.length,
    1,
    `${fx.amc}: expected the one captured sheet to parse as a portfolio`,
  );
  return { fx, sheet: parsed.sheets[0]! };
}

/** The header cell that carries a house's distinguishing spelling, verbatim. */
function headerCell(fx: HeaderFixture, col: number): string {
  const v = fx.cells[fx.headerRow]?.[col]?.v;
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : String(v);
}

const FILES = [
  "tata-header.json",
  "three-sixty-one-header.json",
  "zerodha-header.json",
  "kotak-header.json",
  "icici-header.json",
] as const;

describe("[meta] every header fixture declares where its bytes came from", () => {
  it("a fixture claiming `real` names a URL, a byte count and a date", () => {
    // The point of the whole file. A synthetic fixture is allowed — a house may
    // simply not be fetchable on the day — but it has to SAY so and say why,
    // rather than sitting in this directory looking like the others.
    //
    // MUTATION: set `provenance` to "synthetic" in any one fixture without
    // adding `synthetic_reason` -> RED on that file.
    for (const file of FILES) {
      const fx = load(file);
      assert.ok(
        fx.provenance === "real" || fx.provenance === "synthetic",
        `${file}: provenance must be stated`,
      );
      if (fx.provenance === "real") {
        assert.match(fx.sourceUrl ?? "", /^https:\/\//, `${file}: sourceUrl`);
        assert.match(
          fx.fetchedAt ?? "",
          /^\d{4}-\d{2}-\d{2}T/,
          `${file}: fetchedAt`,
        );
        assert.equal(fx.httpStatus, 200, `${file}: httpStatus`);
        assert.ok((fx.fileBytes ?? 0) > 10_000, `${file}: fileBytes`);
      } else {
        assert.ok(
          (fx.synthetic_reason ?? "").length > 20,
          `${file}: a synthetic fixture must say WHY it could not be fetched`,
        );
      }
    }
  });

  it("the captured block really is a header block, not a slice of holdings", () => {
    // `headerRow > 0` on all five: every house prints something above the
    // table. A fixture whose header sat on row 0 would have captured no as-on
    // line and no scheme name, which is half of what these sheets are read for.
    for (const file of FILES) {
      const fx = load(file);
      assert.ok(fx.headerRow > 0, `${file}: headerRow=${fx.headerRow}`);
      assert.ok(
        fx.cells.length > fx.headerRow + 3,
        `${file}: too few rows below the header to be holdings`,
      );
    }
  });
});

describe("TATA — `ISIN CODE`, from Tata's own August-2026 workbook", () => {
  it("the committed header string is the one Tata publishes", () => {
    // THE LOAD-BEARING LINE. `/^isin$/` missed this and cost the house every
    // row it ever had. The string is not typed here — it is read out of the
    // fixture, which a script copied out of the live file.
    //
    // MUTATION: change the fixture cell to `ISIN` -> the parse below still
    // works (it is the generic spelling) but THIS assertion goes RED, which is
    // the direction that matters: the fixture can no longer be quietly
    // "corrected" into agreeing with a narrower regex.
    const fx = load("tata-header.json");
    assert.equal(headerCell(fx, 4), "ISIN CODE");
    assert.notEqual(headerCell(fx, 4), "ISIN");
  });

  it("the sheet yields holdings with ISINs — it used to yield nothing", () => {
    const { sheet } = parseOne("tata-header.json");
    assert.ok(sheet.holdings.length > 0, "zero holdings is the old bug");
    assert.ok(
      sheet.holdings.some((h) => /^IN[A-Z0-9]{10}$/.test(h.isin ?? "")),
      "no ISIN reached a holding",
    );
    assert.equal(sheet.columns.isin, 4);
  });

  it("reads Tata's TWO-DIGIT as-on year off its own title row", () => {
    // `Portfolio as on 31-08-26`, verbatim from the file.
    const { fx, sheet } = parseOne("tata-header.json");
    assert.ok(
      fx.cells.some((row) =>
        row.some(
          (c) => typeof c?.v === "string" && /as on 31-08-26/i.test(c.v),
        ),
      ),
      "the captured block no longer contains the as-on line it was captured for",
    );
    assert.equal(sheet.asOfDate, "2026-08-31");
  });
});

describe("360 ONE — `Rounded % to Net Assets`, from its August-2026 workbook", () => {
  it("the committed header string carries the QUALIFIER", () => {
    // `/^%\s*to\s*…/` missed this one. Same discipline as Tata's: the string is
    // read from the fixture, never typed into the assertion twice.
    const fx = load("three-sixty-one-header.json");
    assert.equal(headerCell(fx, 6), "Rounded % to Net Assets");
    assert.ok(!headerCell(fx, 6).startsWith("%"));
  });

  it("that column is bound as the percent column and the weights land", () => {
    const { sheet } = parseOne("three-sixty-one-header.json");
    assert.equal(sheet.columns.percent, 6);
    assert.ok(sheet.holdings.length > 0);
    assert.ok(
      sheet.holdings.some((h) => typeof h.pctToNav === "number"),
      "the percent column bound but produced no value",
    );
    // 360 ONE stores the weight as an Excel FRACTION (`#0.00%` / 0.0466), so
    // this also pins that the scale detector reads `z` on the real cell.
    assert.equal(sheet.percentScale, "fraction");
  });
});

describe("ZERODHA — `… FOR AUGUST 2026`, from its August-2026 workbook", () => {
  it("the period is stated with `FOR` and no day, as published", () => {
    const fx = load("zerodha-header.json");
    const title = fx.cells
      .flat()
      .map((c) => (typeof c?.v === "string" ? c.v : ""))
      .find((s) => /monthly portfolio statement/i.test(s));
    assert.match(title ?? "", /\bFOR AUGUST 2026\b/);
    // Not `as on`, and not a date. Those are the spellings the other four use,
    // and reading this one required admitting a looser cue.
    assert.ok(!/\bas\s*on\b/i.test(title ?? ""));
  });

  it("the sheet still gets an as-on date — the month end", () => {
    const { sheet } = parseOne("zerodha-header.json");
    assert.equal(sheet.asOfDate, "2026-08-31");
    assert.ok(sheet.holdings.length > 0);
  });
});

describe("KOTAK — the MERGED instrument-name header, from its own workbook", () => {
  it("the merge is in the fixture, spanning A:C on the header row", () => {
    // SheetJS reports a merged value only at the TOP-LEFT cell, so `Name of
    // Instrument` sits in column 0 while every instrument NAME sits in column 2
    // and columns 1-2 of the header row are EMPTY. That emptiness is what
    // `instrumentNameSpan` walks.
    //
    // MEASURED, and it corrects what this comment first claimed: the `!merges`
    // array is NOT what makes the parse work. Dropping it from the rebuild
    // leaves every assertion below green, because the empty header cells the
    // span reads are already in the capture — `instrumentNameSpan(cols,
    // headers)` takes the HEADERS, never the merge ranges. It is captured
    // because it is the publisher's own explanation of WHY those cells are
    // empty, and a future rule may read it; it is not load-bearing today and
    // this test does not pretend it is.
    //
    // What IS load-bearing is the pair of nulls asserted at the end.
    const fx = load("kotak-header.json");
    assert.equal(headerCell(fx, 0), "Name of Instrument");
    assert.ok(
      fx.merges.some(
        (m) => m.s.r === fx.headerRow && m.s.c === 0 && m.e.c === 2,
      ),
      "the A:C merge on the header row is missing from the capture",
    );
    // And the cells it covers really are empty, which is what makes the span
    // necessary rather than cosmetic.
    assert.equal(fx.cells[fx.headerRow]?.[1] ?? null, null);
    assert.equal(fx.cells[fx.headerRow]?.[2] ?? null, null);
  });

  it("names come out of the column the DATA is in, not the header's", () => {
    const { sheet } = parseOne("kotak-header.json");
    assert.ok(sheet.holdings.length > 0);
    assert.ok(
      sheet.holdings.every(
        (h) => h.instrumentName.length > 0 && h.instrumentName !== " ",
      ),
      "an empty instrument name is the merged-header bug",
    );
    assert.ok(
      sheet.holdings.some((h) => /STATE BANK OF INDIA/i.test(h.instrumentName)),
      "the real names from Kotak's own sheet did not survive",
    );
    assert.equal(sheet.columns.isin, 3, "`ISIN Code`, Kotak's spelling");
  });

  it("reads Kotak's as-on out of `Portfolio of <scheme> as on 31-Aug-2026`", () => {
    const { sheet } = parseOne("kotak-header.json");
    assert.equal(sheet.asOfDate, "2026-08-31");
    assert.match(sheet.schemeName ?? "", /Kotak Nifty200 Value 30 Index Fund/);
  });
});

describe("ICICI — a member of its 147-file August-2026 zip", () => {
  it("the fixture records that it came out of an archive", () => {
    const fx = load("icici-header.json");
    assert.match(fx.note ?? "", /zip member/i);
    assert.match(fx.sourceUrl ?? "", /\.zip$/);
  });

  it("`% to Nav` and `Portfolio as on Aug 31,2026` both read", () => {
    // Two spellings in one sheet that no other house uses: a lowercase `Nav`,
    // and an abbreviated month with NO SPACE after the comma.
    const { fx, sheet } = parseOne("icici-header.json");
    assert.equal(headerCell(fx, 7), "% to Nav");
    assert.equal(sheet.asOfDate, "2026-08-31");
    assert.ok(sheet.holdings.length > 0);
    assert.ok(
      sheet.holdings.some((h) => /Larsen/i.test(h.instrumentName)),
      "the real holdings from ICICI's own sheet did not survive",
    );
  });
});
