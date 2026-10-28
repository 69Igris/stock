/**
 * The as-on date is the ONLY thing that separates a current disclosure from a
 * dead one — MONEY-1405 D1.
 *
 * ## The two measured traps
 *
 * Neither is hypothetical and neither fails any check this job made before this
 * ticket — the fetch succeeds, the bytes are a workbook, the parse yields
 * sheets, the holdings are real:
 *
 *   - **Axis** publishes at an UNDATED url,
 *     `transact.axismf.com/…/IN_MF_MONTHLY_PORTFOLIO_AXISMF.xls`. It answers
 *     200 with a genuine 840 KB workbook whose 59 sheets ALL read "as on
 *     January 31, 2022".
 *   - **KFintech** serves `mfs.kfintech.com/mfs/SchemePortfolio/{amc}/MONTHLY/
 *     {scheme}.xlsx` unauthenticated, with full holdings, and it is a DEAD
 *     STORE: one frozen file per scheme, as-on dates sampled across Sep-2021,
 *     Jun-2024 and Aug-2025.
 *
 * So `extractAsOnDate` returning null, or returning the wrong month, is not a
 * cosmetic gap: it is four-year-old holdings written over a live month with
 * every log line reading success.
 *
 * ## What is asserted, and on what bytes
 *
 * The date SHAPES are asserted as unit cases — they are string parsing and a
 * workbook would add nothing. The two claims that need real bytes get them:
 *
 *   1. the four committed REAL workbooks still read 2026-07-31 on every sheet
 *      (the widened patterns must not move a date that was already right), and
 *   2. a STALE workbook is refused end-to-end — built here by rewriting ONE
 *      CELL of the real HDFC fixture, in memory, at test time. Nothing
 *      synthetic is committed: the derivation is visible on the line that does
 *      it, and every other byte in that workbook is the file HDFC published.
 *      Axis's own bytes cannot be committed (the URL is undated, so the file it
 *      serves today is not the file it served when this was measured).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

import {
  extractAsOnDate,
  parseAmcPortfolioWorkbook,
  parseAsOfDate,
} from "../../src/market-data/mf-portfolio-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "amc");
const HDFC_FILE = "hdfc-value-fund-2026-07.xlsx";
const NIPPON_FILE = "nippon-monthly-portfolio-2026-07.xls";
const SBI_FILE = "sbi-all-schemes-2026-07.xlsx";
const ABSL_FILE = "absl-monthly-portfolio-2026-07.zip";

/** One row of raw cell values, the shape `extractAsOnDate` takes. */
const row = (...cells: unknown[]): unknown[] => cells;

describe("extractAsOnDate: the shapes real AMCs actually publish", () => {
  it("reads the four spellings that were already supported", () => {
    // MUTATION: delete the `DATE_DMY` ordinal branch (restore
    // `[-/\s]([A-Za-z]{3,9})[-/\s]`) -> the ordinal cases below go null; these
    // four stay green, which is the point of keeping them.
    assert.equal(
      extractAsOnDate([row("Portfolio as on 31-Jul-2026")]),
      "2026-07-31",
    );
    assert.equal(
      extractAsOnDate([row("Monthly Portfolio Statement as on July 31,2026")]),
      "2026-07-31",
    );
    assert.equal(
      extractAsOnDate([row("Portfolio Statement as on July 31, 2026")]),
      "2026-07-31",
    );
    // SBI's layout: a LABEL cell, and the date as an Excel serial beside it.
    assert.equal(
      extractAsOnDate([row("PORTFOLIO STATEMENT AS ON :", 46234)]),
      "2026-07-31",
    );
  });

  it("reads an ORDINAL suffix — `31st October 2025`, `30th April 2026`", () => {
    // These returned NULL before MONEY-1405: `\d{1,2}` took `31`, the separator
    // class then met `s`, and the whole match failed. A null as-on is now a
    // REFUSED sheet, so the miss costs an AMC its month.
    //
    // MUTATION: drop `(?:st|nd|rd|th)?` from DATE_DMY -> both go null. RED.
    assert.equal(
      extractAsOnDate([row("Portfolio as on 31st October 2025")]),
      "2025-10-31",
    );
    assert.equal(
      extractAsOnDate([row("Portfolio as on 30th April 2026")]),
      "2026-04-30",
    );
    assert.equal(parseAsOfDate("as on 1st January 2026"), "2026-01-01");
  });

  it("reads an ALL-NUMERIC date, day first", () => {
    // MUTATION: delete the DATE_NUMERIC_DMY branch from parseAsOfDate -> null.
    assert.equal(
      extractAsOnDate([row("Portfolio as on 31/07/2026")]),
      "2026-07-31",
    );
    assert.equal(extractAsOnDate([row("as on 31-07-2026")]), "2026-07-31");
    assert.equal(extractAsOnDate([row("as on 31.07.2026")]), "2026-07-31");
  });

  it("does not guess the wrong way round on an ambiguous numeric date", () => {
    // A component above 12 cannot be a month, so `07/31` is read M/D whatever
    // the convention — reading it D/M would yield month 31 and a null, i.e. a
    // refused sheet on a perfectly good file.
    //
    // MUTATION: replace the swap with a bare `[a, b]` -> `07/31/2026` goes
    // null. RED.
    assert.equal(extractAsOnDate([row("as on 07/31/2026")]), "2026-07-31");
    // Genuinely ambiguous: both are <= 12. Indian filings are day-first, and
    // this is the ONE case where the convention decides.
    //
    // MUTATION: make the swap unconditional -> this reads 2026-07-03. RED.
    assert.equal(extractAsOnDate([row("as on 07/03/2026")]), "2026-03-07");
  });

  it("reads `as at` as well as `as on`", () => {
    // MUTATION: narrow AS_ON_LABEL back to /\bas\s*on\b/i -> null. RED.
    assert.equal(
      extractAsOnDate([row("Portfolio as at 31-Mar-2026")]),
      "2026-03-31",
    );
    // `portfolio as on` needs no branch of its own — it CONTAINS `as on`.
    assert.equal(
      extractAsOnDate([row("PORTFOLIO AS ON 31-Mar-2026")]),
      "2026-03-31",
    );
  });

  it("reads Axis's spelling — the one this ticket exists for", () => {
    // The 59 sheets of the undated Axis workbook all carry this line.
    assert.equal(
      extractAsOnDate([row("Portfolio as on January 31, 2022")]),
      "2022-01-31",
    );
  });

  it("returns null rather than a guess", () => {
    // MUTATION: return a fallback date instead of null anywhere here and the
    // whole D1 gate inverts — an unreadable date becomes a current one.
    assert.equal(extractAsOnDate([row("as on the last business day")]), null);
    assert.equal(extractAsOnDate([row("31-Jul-2026")]), null, "no label");
    assert.equal(extractAsOnDate([]), null);
    assert.equal(extractAsOnDate([row(), row(null, undefined, "")]), null);
    // A label with nothing usable within reach of it.
    assert.equal(extractAsOnDate([row("as on", "", "", "", "", 46234)]), null);
  });

  it("honours the scan window", () => {
    const rows = [
      ...Array.from({ length: 20 }, () => row("")),
      row("Portfolio as on 31-Jul-2026"),
    ];
    // MUTATION: ignore `scanRows` and always scan `rows.length` -> the default
    // call below returns the date instead of null. RED.
    assert.equal(extractAsOnDate(rows), null, "default window is 15 rows");
    assert.equal(extractAsOnDate(rows, 30), "2026-07-31");
  });
});

describe("REGRESSION: the widened patterns do not move a date that was right", () => {
  it("all four REAL workbooks still read 2026-07-31 on every sheet", () => {
    // The widening added an optional ordinal, a looser separator, an
    // all-numeric form and `as at`. Any of them could have matched EARLIER in a
    // header line than the real date does — `% to AUM on 31JUL26` sits in these
    // files — so this is asserted on the published bytes, not on prose.
    //
    // MUTATION: make DATE_NUMERIC_DMY run BEFORE DATE_DMY -> unchanged here
    // (no numeric dates in these four), which is why the shape cases above
    // carry that assertion instead.
    for (const file of [HDFC_FILE, NIPPON_FILE, SBI_FILE, ABSL_FILE]) {
      const parsed = parseAmcPortfolioWorkbook(
        readFileSync(join(FIXTURES, file)),
      );
      assert.ok(parsed, `${file} must parse`);
      assert.ok(parsed.sheets.length > 0, `${file} must yield sheets`);
      for (const s of parsed.sheets) {
        assert.equal(
          s.asOfDate,
          "2026-07-31",
          `${file}/${s.sheetName} as-of date moved`,
        );
      }
    }
  });
});

describe("a STALE workbook, derived from real bytes", () => {
  /**
   * The real HDFC fixture with ONE CELL changed: `A2:I2`, which reads
   * `"Portfolio as on 31-Jul-2026"`, rewritten to Axis's spelling of a 2022
   * date. Everything else — 60-odd holdings, the merged header, the combined
   * Industry/Rating column, the AUM line — is the file HDFC published.
   *
   * NOT a synthetic workbook: a hand-built one would agree with whatever the
   * parser did, which is the property this fixture set exists to avoid.
   */
  function staleHdfcBytes(asOnText: string): Buffer {
    const wb = XLSX.read(readFileSync(join(FIXTURES, HDFC_FILE)), {
      cellDates: false,
      cellNF: true,
      cellStyles: true,
    });
    const ws = wb.Sheets[wb.SheetNames[0]!]!;
    // The line is MERGED, so every cell across it carries the same text — and
    // the merge runs to J2, not to I2 as the visible columns suggest. Rewriting
    // only the first nine left `J2` holding the real date and the parser found
    // it there, so the row is walked to the sheet's declared width rather than
    // to a number read off a screenshot.
    const range = XLSX.utils.decode_range(String(ws["!ref"]));
    for (let c = range.s.c; c <= range.e.c; c++) {
      const addr = XLSX.utils.encode_cell({ r: 1, c });
      if (ws[addr]) ws[addr] = { t: "s", v: asOnText };
    }
    return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  }

  it("[meta] the derivation changed the date and nothing else", () => {
    const real = parseAmcPortfolioWorkbook(
      readFileSync(join(FIXTURES, HDFC_FILE)),
    );
    const stale = parseAmcPortfolioWorkbook(
      staleHdfcBytes("Portfolio as on January 31, 2022"),
    );
    assert.ok(real && stale);
    const a = real.sheets[0]!;
    const b = stale.sheets[0]!;
    // If the round-trip through SheetJS moved the holdings, this fixture would
    // be proving something about SheetJS rather than about the gate.
    assert.equal(b.holdings.length, a.holdings.length);
    assert.equal(b.totalAumLakhs, a.totalAumLakhs);
    assert.deepEqual(b.missingColumns, a.missingColumns);
    assert.equal(a.asOfDate, "2026-07-31");
  });

  it("the stale workbook parses PERFECTLY and reads January 2022", () => {
    // This is the whole trap: nothing about this file is broken. It parses, it
    // has holdings, it has an AUM. Only the date says it is four years old.
    //
    // MUTATION: have findAsOfDate ignore the prose cell and return null ->
    // asOfDate becomes null, which the sync refuses as NO_AS_ON rather than
    // writing. RED either way, which is the design.
    const stale = parseAmcPortfolioWorkbook(
      staleHdfcBytes("Portfolio as on January 31, 2022"),
    );
    assert.ok(stale, "the derived workbook must still be readable");
    const s = stale.sheets[0]!;
    assert.equal(s.asOfDate, "2022-01-31");
    assert.ok(s.holdings.length > 10, "it has real holdings");
  });

  it("a workbook with NO as-on line at all yields null, not a guess", () => {
    // KFintech's store is frozen rather than undated, but an AMC dropping the
    // line is the same failure for us: we cannot tell the month, so we must not
    // claim one.
    const blanked = parseAmcPortfolioWorkbook(staleHdfcBytes("Portfolio"));
    assert.ok(blanked);
    assert.equal(blanked.sheets[0]!.asOfDate, null);
  });
});

/**
 * The number FORMAT is the only thing separating a date from a rupee figure.
 *
 * `findAsOfDate` used to map the grid to `row.map((cell) => cell.v)`, throwing
 * away the `z` that `buildGrid` exists to preserve. `parseAsOfDate` then accepts
 * ANY finite number in 1 … 2,958,465 as an Excel serial — which is the whole
 * plausible range of a rupee figure — and the sibling scan looks up to four
 * cells to the RIGHT of any as-on cue. So
 *
 *     ["TOTAL NET ASSETS AS ON MONTH END", "", 45678.90]
 *
 * dated a sheet 2025-01-21 from its own AUM.
 *
 * That was survivable while `asOfDate` was a log line. It is not now:
 * `judgeSheetWrite` compares its MONTH against the requested one and refuses the
 * WHOLE SHEET as `STALE_FILE`. A loose heuristic became a total-loss gate
 * without being tightened, which is the shape of MONEY-1408.
 *
 * ## Measured before this guard shipped
 *
 * Across the four committed workbooks plus five live August-2026 files (TATA,
 * 360 ONE, ZERODHA, KOTAK, ICICI) — 679 sheets, 435 with a readable table:
 *
 *   - 121 cue+number pairs sit inside the window `findAsOfDate` scans, and ALL
 *     121 are genuinely date-formatted. So this guard changes NOTHING on real
 *     data today: parsing all nine files with it on and with it off produced
 *     byte-identical as-on dates and holding counts on all 679 sheets.
 *   - 168 more sit BELOW the header row, where the scan does not reach:
 *     `National Bank FOR Agriculture and Rural Development` is a NABARD bond
 *     line whose quantity cell is a plausible serial, and it appears 48 times in
 *     Nippon's file and 82 in Kotak's.
 *
 * This is therefore HARDENING with a measured-zero present effect, and it is
 * worth having because the distance between the two populations is one layout
 * change: a house that prints its net-assets line ABOVE the holdings header —
 * which is where a summary line goes — moves 168 into 121's window.
 *
 * The fixtures below derive from real bytes and change exactly ONE thing: the
 * `z` on a single cell. Nothing synthetic is committed.
 */
describe("MONEY-1408 — a currency cell is not an as-on date", () => {
  const SBI_SHEET = "SMEEF";

  /**
   * SBI's own sheet with the as-on cell's FORMAT rewritten, value untouched.
   *
   * SBI states its date as the Excel serial 46234 in `D4`, formatted
   * `mmmm dd, yyyy`. Re-stamping that cell `#,##0.00` turns it into the exact
   * shape a market-value cell has — same number, same position, same cue beside
   * it — so the format is the only variable in the experiment.
   */
  // READ ONCE. This helper is called NINE times, and SBI's fixture is 2.6 MB
  // across 121 sheets — re-reading it per call cost ~1.1 s each and made this
  // file ~9.3 s, which timed out at the 30 s per-file wall under a full parallel
  // `yarn test` (measured 2026-09-14; it passes alone, so it presents as a
  // flake). The parse is hoisted; each call still gets its OWN worksheet object
  // so one case cannot leak a format into the next.
  let sbiSourceSheet: XLSX.WorkSheet | null = null;
  function sbiWithAsOnFormat(z: string | null): Buffer {
    sbiSourceSheet ??= XLSX.read(readFileSync(join(FIXTURES, SBI_FILE)), {
      cellDates: false,
      cellNF: true,
      cellStyles: true,
    }).Sheets[SBI_SHEET]!;

    // Shallow-clone the sheet and copy ONLY the cell we mutate. The sheet is a
    // dictionary of cell objects, so this costs nothing measurable.
    //
    // HONESTLY: this is DEFENSIVE, not load-bearing. Mutation-verified — sharing
    // the sheet outright still passes 18/18, because every call either sets `z`
    // or deletes it, so each case fully determines what it reads. It is kept
    // because `delete cell.z` on a SHARED object is a live footgun for the next
    // case added here: one that reads the sheet WITHOUT setting `z` would
    // inherit whatever the previous case left, and that failure is
    // order-dependent and only appears when someone reorders the file. Two
    // lines to make the hazard unreachable is the right trade; claiming it
    // currently prevents an observable bug would not be.
    const ws: XLSX.WorkSheet = { ...sbiSourceSheet };
    const cell = { ...(sbiSourceSheet["D4"] as object) } as {
      v?: unknown;
      z?: string;
    };
    assert.equal(cell.v, 46234, "the fixture's as-on serial moved");
    if (z === null) delete cell.z;
    else cell.z = z;
    ws["D4"] = cell;

    const out = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(out, ws, SBI_SHEET);
    return XLSX.write(out, {
      type: "buffer",
      bookType: "xlsx",
      cellStyles: true,
    }) as Buffer;
  }

  const asOnOf = (bytes: Buffer): string | null => {
    const parsed = parseAmcPortfolioWorkbook(bytes, {
      onlySheets: [SBI_SHEET],
    });
    assert.ok(parsed, "the derived workbook must still be readable");
    assert.equal(parsed.sheets.length, 1);
    return parsed.sheets[0]!.asOfDate;
  };

  it("[meta] the derivation changes the FORMAT and nothing else", () => {
    // If the round-trip moved the holdings, this would be proving something
    // about SheetJS rather than about the guard.
    const a = parseAmcPortfolioWorkbook(
      sbiWithAsOnFormat("mmmm\\ dd\\,\\ yyyy"),
      {
        onlySheets: [SBI_SHEET],
      },
    )!.sheets[0]!;
    const b = parseAmcPortfolioWorkbook(sbiWithAsOnFormat("#,##0.00"), {
      onlySheets: [SBI_SHEET],
    })!.sheets[0]!;
    assert.equal(b.holdings.length, a.holdings.length);
    assert.equal(b.totalAumLakhs, a.totalAumLakhs);
    assert.deepEqual(b.headers, a.headers);
  });

  it("a DATE-formatted serial beside `AS ON :` still reads — SBI's own layout", () => {
    // The green half. Narrowing the rule must not cost the one house whose date
    // IS a number: 121 of SBI's sheets date themselves this way.
    //
    // MUTATION: make `dateReadableValue` drop every number -> RED here.
    assert.equal(
      asOnOf(sbiWithAsOnFormat("mmmm\\ dd\\,\\ yyyy")),
      "2026-07-31",
    );
    // …and the spellings a different house might use for the same cell.
    assert.equal(asOnOf(sbiWithAsOnFormat("dd-mmm-yyyy")), "2026-07-31");
    assert.equal(
      asOnOf(sbiWithAsOnFormat("[$-409]d\\-mmm\\-yy;@")),
      "2026-07-31",
    );
  });

  it("THE BUG: the same serial in a CURRENCY format is refused", () => {
    // Byte for byte the same sheet and the same number 46234. Only `z` moved,
    // and the answer must move with it — because in a currency format that
    // number is ₹46,234.00 of net assets, not the last day of July.
    //
    // MUTATION: `return cell.v` in `dateReadableValue` -> all four go GREEN at
    // "2026-07-31", which is the defect: a rupee figure dating a sheet.
    for (const z of [
      "#,##0.00",
      "#,##0",
      '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', // SBI's own money format
      "General",
    ]) {
      assert.equal(asOnOf(sbiWithAsOnFormat(z)), null, `z=${z}`);
    }
  });

  it("THE COST OF FAILING CLOSED: `cellNF` must stay on the workbook read", () => {
    // The guard treats a MISSING format as "not a date". Measured, that branch
    // is unreachable today — zero of the 12,107 numeric cells in the committed
    // workbooks lack a `z`, because `readWorkbookSheets` reads with
    // `cellNF: true` and SheetJS then stamps `"General"` on everything else.
    //
    // Which makes `cellNF` load-bearing in a NEW way. It was there for the
    // percent scale, where losing it degrades a heuristic. Now, dropping it
    // sends every `z` to `undefined`, the guard refuses every number, and SBI's
    // 121 sheets — the one house whose date IS a number — all read `null` and
    // are refused as NO_AS_ON. So the dependency is pinned here rather than
    // left to the comment beside the read.
    //
    // This replaces an assertion that LOOKED like it covered the missing-`z`
    // branch and did not: deleting `z` and writing the workbook back produces
    // `z: "General"` on the next read, never `undefined`, so it was a second
    // copy of the `"General"` case above. Mutating the guard to treat a missing
    // format as a date left it green.
    const [withNf, withoutNf] = [true, false].map((cellNF) => {
      const wb = XLSX.read(readFileSync(join(FIXTURES, SBI_FILE)), {
        cellDates: false,
        cellNF,
      });
      const cell = wb.Sheets[SBI_SHEET]![`D4`] as { z?: unknown };
      return typeof cell.z;
    });
    assert.equal(withNf, "string", "cellNF:true must carry the format");
    assert.equal(
      withoutNf,
      "undefined",
      "cellNF:false loses it — which is why the read must keep the flag",
    );
    // And with the flag on, as the parser reads it, SBI's date survives.
    const sbi = parseAmcPortfolioWorkbook(
      readFileSync(join(FIXTURES, SBI_FILE)),
      { onlySheets: [SBI_SHEET] },
    );
    assert.equal(sbi!.sheets[0]!.asOfDate, "2026-07-31");
  });

  it("a format whose LITERAL text contains date letters is still not a date", () => {
    // `0.00" days"` and `#,##0.00" mn"` carry `d`, `m` and `y` inside quoted
    // literals. A hand-rolled `/[dmy]/` test says yes to both; SheetJS's own
    // `SSF.is_date` skips quoted runs, which is why it is used instead.
    //
    // MUTATION: swap `isDateNumberFormat` for `/[dmy]/i.test(z)` -> RED.
    assert.equal(asOnOf(sbiWithAsOnFormat('0.00" days"')), null);
    assert.equal(asOnOf(sbiWithAsOnFormat('#,##0.00" mn"')), null);
  });

  it("the STRING spellings are untouched — only numbers are screened", () => {
    // HDFC states its date as prose and must be unaffected by any of this.
    const hdfc = parseAmcPortfolioWorkbook(
      readFileSync(join(FIXTURES, HDFC_FILE)),
    );
    assert.equal(hdfc!.sheets[0]!.asOfDate, "2026-07-31");
    // And the pure function keeps its loose contract: a caller with no formats
    // to screen with (a test, a CSV) has nothing to screen.
    assert.equal(parseAsOfDate(46234), "2026-07-31");
  });
});
