/**
 * UTI — ONE sheet, EVERY scheme — MONEY-1407.
 *
 * ## The shape, measured on the live August-2026 file (2026-09-14)
 *
 * UTI publishes no per-scheme workbook and no templatable URL. Its monthly
 * disclosure is a 1,692,892-byte zip of four members, and the only one that
 * holds holdings — `Sebi Exposure as on 31 Aug 2026_final_REVISED.xlsx`,
 * 329,181 B — is a SINGLE worksheet named `EXPOSURE` carrying 9,208 rows and
 * all 85 schemes one after another:
 *
 *   SCHEME CODE002STARTS
 *   UTI MUTUAL FUND
 *   SCHEME: UTI - Unit Linked Insurance Plan
 *   PROVISIONAL AND UNAUDITED PORTFOLIO DISCLOSURE AS OF 31/08/2026 (…)
 *   <blank>
 *   NAME OF THE INSTRUMENT | RATING/INDUSTRY | QUANTITY | MARKET-VALUE | % TO NAV | | | ISIN | …
 *   …holdings…
 *   SCHEME CODE002ENDS
 *   SCHEME CODE017STARTS
 *   …
 *
 * `parseAmcPortfolioWorkbook` maps one SHEET to one scheme, so as-is it
 * produced ONE sheet of 132 holdings summing to **11,816%** of NAV — the first
 * block's rows plus whatever ran on until the second block's header row
 * re-declared `ISIN` and tripped `isTableTerminator`. A wrong answer that
 * stores perfectly cleanly.
 *
 * Three things had to be true together, and any one alone changes nothing:
 *
 *   1. the sheet is SPLIT on the publisher's own markers
 *      (`splitConsolidatedSheet`);
 *   2. `AS_ON_STRICT` admits `as of`, or every one of the 85 blocks is refused
 *      `NO_AS_ON` by the write gate;
 *   3. `isTableTerminator` stops at `ISIN NO`, or UTI's "Details of Default
 *      beyond Maturity Date" annexure — five columns that do NOT line up with
 *      the holdings table's — puts a 2019 default's `Total Amt Due#` in the
 *      `% to NAV` column. Measured: 9,991.55% of NAV on one row, and three of
 *      the 85 schemes summing to 11,816%, 2,598% and 1,824%.
 *
 * ## What the live file produced afterwards (2026-09-14, end to end)
 *
 *   API   200, 505 B, application/json — one row, picked verbatim
 *   ZIP   200, 1,692,892 B, application/zip
 *   PARSE 85 sheets, 5,435 holdings, as-on 2026-08-31 on ALL 85,
 *         0 scale-suspect, 0 sheets missing a column, 0 file anomalies,
 *         83 summing inside 95-105%
 *   GATE  85 of 85 WRITE — STALE_FILE 0, NO_AS_ON 0, SCALE_SUSPECT 0
 *
 * The two sheets outside the band are the YES BANK AT1 SIDE-POCKETS
 * (`… ( Segregated -06032020)`): every value is 0 and every `% TO NAV` cell is
 * `*` ("Percentage to NAV less than 0.01"), so there are no percentages to sum
 * rather than wrong ones.
 *
 * ## Why the fixture is synthesised
 *
 * Same rule as `mf-portfolio-amc-headers.test.ts` and
 * `mf-portfolio-d3-houses.test.ts` next door: what is pinned is a SHAPE — three
 * marker rows, a `SCHEME:` line, an `AS OF` date and an annexure header — and
 * it reproduces in thirty rows taken verbatim from the live workbook. The real
 * member is 329 KB and there are twelve of them a year. The byte-level
 * questions are pinned against the four committed workbooks under
 * `__tests__/fixtures/amc/`, whose parse output was blast-radius measured
 * before and after every change here and is IDENTICAL on all of them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import { parseAmcPortfolioWorkbook } from "../../src/market-data/mf-portfolio-logic";
import {
  amcSource,
  fetchableSources,
  buildUtiDisclosureApiUrl,
  pickUtiDisclosureUrl,
} from "../../src/market-data/amc-portfolio-sources";

/** One worksheet, as bytes, through the real OOXML writer. */
function workbook(rows: unknown[][], sheetName = "EXPOSURE"): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/**
 * One scheme block, cell for cell from the live `EXPOSURE` sheet.
 *
 * The marker is `SCHEME CODE002STARTS` — the code is GLUED to both words, which
 * is why the pattern needs `\S+` where `\s+` would read naturally and match
 * nothing. `weights` are the `% TO NAV` values; they sum to ~100 per block, and
 * the block's own market values are made to agree so nothing here trips the
 * money-vs-percent cross-check.
 */
function schemeBlock(
  code: string,
  name: string,
  holdings: ReadonlyArray<readonly [string, string, number, number, number]>,
): unknown[][] {
  return [
    [`SCHEME CODE${code}STARTS`],
    ["UTI MUTUAL FUND"],
    [`SCHEME: ${name}`],
    [
      "PROVISIONAL AND UNAUDITED PORTFOLIO DISCLOSURE AS OF 31/08/2026 (Market value in Lacs)",
    ],
    [],
    [
      "NAME OF THE INSTRUMENT ",
      "RATING/INDUSTRY",
      "QUANTITY",
      "MARKET-VALUE",
      "% TO NAV",
      "",
      "",
      "ISIN",
      "Yield to call (AT1 and ATII Bonds)",
      "Yield",
    ],
    ["EQUITY AND EQUITY RELATED"],
    ["(a)  Listed/awaiting listing on Stock Exchanges"],
    ...holdings.map(([n, industry, qty, mv, pct]) => [
      n,
      industry,
      qty,
      mv,
      pct,
      "",
      "",
      // The ISIN sits in column 7 — three columns right of `% TO NAV`, with
      // two empty ones between. Positional readers do not survive this sheet.
      `INE${code}A0102${code.slice(-1)}`,
    ]),
    ["TOTAL:(a)  Listed/awaiting listing on Stock Exchanges", "", "", 0],
    [`TOTAL : ${name}`, "", "", 0],
    [],
    ["*  Percentage to NAV less than 0.01"],
    [`SCHEME CODE${code}ENDS`],
  ];
}

const ULIP = schemeBlock("002", "UTI - Unit Linked Insurance Plan", [
  ["EQ - ETERNAL LIMITED", "Retailing", 4382500, 14378.98, 60.2],
  ["EQ - ICICI BANK LTD", "Banks", 928000, 13493.12, 39.8],
]);
const LARGE_CAP = schemeBlock("017", "UTI - Large Cap Fund", [
  ["EQ - ICICI BANK LTD", "Banks", 7771866, 113002.93, 55.5],
  ["EQ - HDFC BANK LIMITED", "Banks", 14851270, 105295.5, 44.5],
]);
const FLEXI = schemeBlock("034", "UTI - Flexi Cap Fund.", [
  [
    "EQ - RELIANCE INDUSTRIES LTD.",
    "Petroleum Products",
    4795093,
    61233.34,
    70.0,
  ],
  ["EQ - BHARTI AIRTEL LTD.", "Telecom - Services", 2661581, 48225.19, 30.0],
]);

/** Three blocks end to end — the real sheet, at 3/85 scale. */
function consolidated(): unknown[][] {
  return [...ULIP, ...LARGE_CAP, ...FLEXI];
}

describe("MONEY-1407 — one worksheet, many schemes", () => {
  it("[meta] the synthesised workbook is a real OOXML file", () => {
    // Without this every assertion below could be passing on a parser that
    // rejected the bytes for an unrelated reason and returned null anyway.
    assert.equal(
      workbook(consolidated()).subarray(0, 2).toString("latin1"),
      "PK",
    );
  });

  it("three markers yield three sheets, not one", () => {
    // MUTATION: `return []` at the top of `splitConsolidatedSheet` -> ONE sheet
    // carrying the first block's holdings and whatever ran on after them, RED
    // here. That is the live defect: 85 UTI schemes merged into one portfolio.
    const parsed = parseAmcPortfolioWorkbook(workbook(consolidated()));
    assert.ok(parsed, "the workbook must parse");
    assert.equal(parsed.sheets.length, 3);
    assert.deepEqual(
      parsed.sheets.map((s) => s.holdings.length),
      [2, 2, 2],
      "each block's holdings stay inside their own block",
    );
  });

  it("each sheet is named by the block's own `SCHEME:` line", () => {
    // The name decides `schemeKey`, which is the ONLY join to AMFI's master —
    // no portfolio workbook anywhere carries a scheme code. Get it wrong and
    // all 85 schemes upsert over one key.
    // MUTATION: delete `seg.schemeName = block.name` in `readWorkbookSheets` ->
    // `findSchemeMeta` takes the longest text in the block's first row, which
    // is the MARKER (`SCHEME CODE002STARTS`), RED here.
    const parsed = parseAmcPortfolioWorkbook(workbook(consolidated()))!;
    assert.deepEqual(
      parsed.sheets.map((s) => s.schemeName),
      [
        "UTI - Unit Linked Insurance Plan",
        "UTI - Large Cap Fund",
        "UTI - Flexi Cap Fund.",
      ],
    );
  });

  it("`UTI MUTUAL FUND` on every block does NOT become the scheme name", () => {
    // The ICICI collapse from the other side: the house prints its own name
    // above each scheme's, identically on all 85 blocks, and a rule that took
    // the first long string would key every scheme on it.
    const names = parseAmcPortfolioWorkbook(
      workbook(consolidated()),
    )!.sheets.map((s) => s.schemeName);
    assert.equal(new Set(names).size, 3, "three distinct names");
    assert.ok(!names.includes("UTI MUTUAL FUND"));
  });

  it("ONE marker is not a consolidated sheet and is left alone", () => {
    // A normal house's sheet scores ZERO markers, so every other AMC is
    // untouched by construction rather than by a per-AMC branch. One marker is
    // the boundary case that decides whether that claim holds.
    // MUTATION: `if (marks.length < 1) return []` -> the single block is split
    // and its scheme name comes from the marker path instead of the normal
    // one, RED here.
    const parsed = parseAmcPortfolioWorkbook(workbook(ULIP))!;
    assert.equal(parsed.sheets.length, 1);
    assert.equal(
      parsed.sheets[0]!.sheetName,
      "EXPOSURE",
      "the WORKSHEET name survives, so nothing was split",
    );
  });

  it("TWO markers already split — the boundary is 2, not 3", () => {
    // The N=2 boundary was UNPINNED: the suite carried a 1-marker case and a
    // 3-marker fixture, so mutating `marks.length < 2` to `< 3` left 374/374
    // GREEN. A genuine two-scheme consolidated sheet exists — it is what UTI
    // looks like the month it launches its second scheme, and what any smaller
    // house publishing this way looks like always — and under `< 3` it merges
    // into one portfolio summing to ~200%, which is the whole defect at N=2.
    // MUTATION: `marks.length < 2` -> `< 3` -> RED.
    const parsed = parseAmcPortfolioWorkbook(
      workbook([...ULIP, ...LARGE_CAP]),
    )!;
    assert.equal(parsed.sheets.length, 2);
    assert.deepEqual(
      parsed.sheets.map((s) => s.schemeName),
      ["UTI - Unit Linked Insurance Plan", "UTI - Large Cap Fund"],
    );
    assert.deepEqual(
      parsed.sheets.map((s) => s.holdings.length),
      [2, 2],
    );
  });

  it("a SPURIOUS split falls back to the unsplit sheet, losing nothing", () => {
    // The `^` anchor is real protection, but an anchored PHRASE is still a
    // phrase: `SCHEME CODE 101 STARTS trading in this security were suspended`
    // matches `/^SCHEME\s+CODE\s*\S+\s*STARTS\b/i` exactly. Two such footnote
    // rows on an ordinary sheet score two marks.
    //
    // Every segment begins at `marks[0].row`, so all the REAL holdings — which
    // sit above the first footnote — fall outside every segment. Executed
    // before the fix: `sheets: 0`, both prose lines in `nonPortfolioSheets`,
    // and the unsplit sheet never re-parsed because the branch `continue`d.
    // A whole scheme's holdings deleted by a footnote, silently.
    // MUTATION: `if (segs.length > 0) {` -> `if (true) {` -> RED.
    const normal: unknown[][] = [
      ["ACME Bluechip Fund"],
      ["Portfolio as on 31/08/2026"],
      [],
      [
        "Name of the Instrument",
        "Industry",
        "Quantity",
        "Market Value",
        "% to NAV",
        "",
        "",
        "ISIN",
      ],
      ["EQ - ICICI BANK LTD", "Banks", 100, 1000, 60, "", "", "INE090A01021"],
      [
        "EQ - HDFC BANK LIMITED",
        "Banks",
        200,
        2000,
        40,
        "",
        "",
        "INE040A01034",
      ],
      [],
      ["SCHEME CODE 101 STARTS trading in this security were suspended"],
      ["SCHEME CODE 102 STARTS trading only after the lock-in ends"],
    ];
    const parsed = parseAmcPortfolioWorkbook(workbook(normal, "Portfolio"))!;
    assert.equal(parsed.sheets.length, 1, "the unsplit sheet must survive");
    assert.equal(parsed.sheets[0]!.holdings.length, 2);
    assert.equal(parsed.sheets[0]!.schemeName, "ACME Bluechip Fund");
    assert.deepEqual(
      parsed.nonPortfolioSheets,
      [],
      "the spurious segments must not be reported as rejected sheets either — " +
        "they are not sheets",
    );
  });

  it("`AS OF` is read as the as-on date, on every block", () => {
    // MUTATION: `AS_ON_STRICT = /\bas\s*(?:on|at)\b/i` (drop `of`) -> asOfDate
    // null on all three, and `judgeSheetWrite` refuses every one of UTI's 85
    // sheets NO_AS_ON. The split alone buys nothing without this — exactly the
    // "two individually-correct fixes that cancel" shape.
    const parsed = parseAmcPortfolioWorkbook(workbook(consolidated()))!;
    assert.deepEqual(
      parsed.sheets.map((s) => s.asOfDate),
      ["2026-08-31", "2026-08-31", "2026-08-31"],
    );
  });

  it("each block's weights sum to ~100%, not to the whole house's", () => {
    const parsed = parseAmcPortfolioWorkbook(workbook(consolidated()))!;
    assert.equal(parsed.sheets.length, 3, "three blocks, three sheets");
    for (const sheet of parsed.sheets) {
      assert.ok(
        sheet.percentSum !== null &&
          sheet.percentSum >= 95 &&
          sheet.percentSum <= 105,
        `${sheet.schemeName}: percentSum ${sheet.percentSum}`,
      );
      assert.notEqual(sheet.percentSumCheck.verdict, "scale-suspect");
    }
  });

  it("the ISINs land in column 7, not wherever a positional read would put them", () => {
    // Two EMPTY columns sit between `% TO NAV` and `ISIN` on this sheet. If the
    // split changed the grid's shape the mapping would move with it, and a
    // sheet of null ISINs is worse than no sheet: rows that look stored and
    // cannot be joined to an instrument.
    const parsed = parseAmcPortfolioWorkbook(workbook(consolidated()))!;
    assert.equal(parsed.sheets.length, 3, "three blocks, three sheets");
    for (const sheet of parsed.sheets) {
      assert.deepEqual(
        sheet.holdings.map((h) => h.isin === null),
        [false, false],
        `${sheet.schemeName} lost its ISINs`,
      );
    }
  });

  it("a block with no `SCHEME:` line keeps its holdings under the MARKER", () => {
    // Not dropped. A block whose name we cannot read still holds real rows, and
    // the marker carries the scheme CODE so it is distinct per block — a
    // visibly odd scheme name is recoverable, silently merged rows are not.
    // MUTATION: `out.push(...)` only when `name` is non-empty -> the block's
    // holdings vanish from the file entirely, RED here.
    const rows = consolidated();
    const schemeLine = rows.findIndex((r) =>
      String(r[0] ?? "").startsWith("SCHEME: UTI - Large Cap"),
    );
    assert.ok(schemeLine > 0, "the fixture must carry that line to remove it");
    rows[schemeLine] = [""];

    const parsed = parseAmcPortfolioWorkbook(workbook(rows))!;
    assert.equal(parsed.sheets.length, 3);
    assert.equal(parsed.sheets[1]!.schemeName, "SCHEME CODE017STARTS");
    assert.equal(parsed.sheets[1]!.holdings.length, 2);
  });
});

describe("MONEY-1407 — the defaults ANNEXURE is not part of the table", () => {
  /**
   * `(a)Details of Default beyond Maturity Date`, verbatim from the live sheet.
   *
   * FIVE columns, none of which line up with the holdings table's ten:
   * `Total Amt Due#` sits where `% TO NAV` does. The two rows are securities
   * that defaulted in 2019 and are carried at ZERO.
   */
  const annexure: unknown[][] = [
    ["** Non traded securities"],
    [],
    ["(a)Details of Default beyond Maturity Date (Fig. in Lakhs) :"],
    [],
    [
      "NAME OF THE SECURITY",
      "ISIN NO",
      "VALUE AS PER NCA",
      "%AGE TO NAV",
      "Total Amt Due#",
    ],
    ["11.5%URNCD IL&FS TRANNET-20.11.19", "INE975G08074", 0, 0, 1724.45],
    ["CP - COX & KINGS  - 09/07/19", "INE008I14OM7", 0, 0, 9991.55],
  ];

  it("`ISIN NO` ends the holdings table, as a bare `ISIN` already did", () => {
    // MUTATION: restore `/^isin$/i` in `isTableTerminator` -> both annexure
    // rows are stored as holdings with `Total Amt Due#` read as `% to NAV`, and
    // the sheet sums to ~9,900%, RED here. Measured live on three of UTI's 85
    // schemes: 11,816%, 2,598% and 1,824%.
    const rows = [...ULIP.slice(0, ULIP.length - 1), ...annexure];
    const sheet = parseAmcPortfolioWorkbook(workbook(rows))!.sheets[0]!;
    assert.deepEqual(
      sheet.holdings.map((h) => h.instrumentName),
      ["EQ - ETERNAL LIMITED", "EQ - ICICI BANK LTD"],
    );
    assert.ok(
      sheet.percentSum !== null && sheet.percentSum < 105,
      `percentSum ${sheet.percentSum}`,
    );
  });

  it("it does not swallow the sheet's OWN header row", () => {
    // `parseSheet` starts BELOW the header it found, so a terminator that
    // matches the header vocabulary cannot terminate the table at row one —
    // which is the only thing that makes widening this pattern safe. Tata heads
    // its column `ISIN CODE` and is the house that would break first.
    const rows = ULIP.map((r) => [...r]);
    rows[5]![7] = "ISIN CODE";
    const sheet = parseAmcPortfolioWorkbook(workbook(rows))!.sheets[0]!;
    assert.equal(sheet.holdings.length, 2);
  });
});

describe("MONEY-1407 — the URL has to be asked for", () => {
  /** The live August-2026 response, byte for byte (2026-09-14). */
  const LIVE_BODY = {
    rows: [
      {
        description: "",
        doc: "https://d3ce1o48hc5oli.cloudfront.net/s3fs-public/2026-09/fw_uti_mf_scheme_portfolios_31.08.2026_revised_final.zip?VersionId=EhSzHSoKCBkh0BsN76FmUi65sUKxPLs9",
        name: "Consolidated Portfolio August 2026",
        type: "Zip",
        url: "https://d3ce1o48hc5oli.cloudfront.net/s3fs-public/2026-09/fw_uti_mf_scheme_portfolios_31.08.2026_revised_final.zip?VersionId=EhSzHSoKCBkh0BsN76FmUi65sUKxPLs9",
        category: "Consolidate portfolio disclosure",
        month: "August",
        year: "2026",
      },
    ],
  };
  const AUGUST = new Date(Date.UTC(2026, 7, 1));

  it("the month is the FULL English name, never a number", () => {
    // `month=08` answers HTTP 200 with `{"rows":[]}` — a silent zero that reads
    // exactly like "not published yet". Measured 2026-09-13.
    // MUTATION: `String(m + 1).padStart(2, "0")` -> RED here.
    assert.equal(
      buildUtiDisclosureApiUrl(AUGUST),
      "https://www.utimf.com/api/get-consolidate-portfolio-disclosure" +
        "?year=2026&month=August",
    );
  });

  it("any date inside the month resolves to the same endpoint", () => {
    // And it is the DATA month. HDFC's row on this table needs the PUBLICATION
    // month for its path and the data month for its filename, so "which month"
    // is a live question here rather than a pedantic one.
    // MUTATION: `dataMonth.getUTCMonth() + 1` -> `month=September`, RED here.
    assert.equal(
      buildUtiDisclosureApiUrl(new Date(Date.UTC(2026, 7, 31))),
      buildUtiDisclosureApiUrl(AUGUST),
    );
  });

  it("the picked URL is returned VERBATIM, query string and all", () => {
    // The `?VersionId=` is part of the object's identity on CloudFront and the
    // filename convention changed three times in three months
    // (`_revised_final`, bare, `_rv1`). Nothing about it is derivable, which is
    // the whole reason this AMC has no `buildUrl`.
    // MUTATION: `url.split("?")[0]` -> RED here.
    assert.equal(
      pickUtiDisclosureUrl(LIVE_BODY, AUGUST),
      LIVE_BODY.rows[0]!.url,
    );
  });

  it("TWO matching rows are refused, never the first of them", () => {
    // `pickLinkForMonth`'s rule, and the reason this pipeline has no invented
    // URLs in it: an index that starts carrying two files for one month is
    // telling us something we do not know yet, and a guess stores cleanly.
    // MUTATION: `return hits[0]?.url ?? null` -> RED here.
    const two = { rows: [LIVE_BODY.rows[0], { ...LIVE_BODY.rows[0] }] };
    assert.equal(pickUtiDisclosureUrl(two, AUGUST), null);
  });

  it("a row for ANOTHER month is refused", () => {
    // The endpoint answers 200 for a month it has nothing for, so the echoed
    // month/year are checked rather than trusted. Without this a September run
    // would store August's holdings under `2026-09`.
    // MUTATION: drop the `row.month`/`row.year` comparisons -> RED here.
    assert.equal(
      pickUtiDisclosureUrl(LIVE_BODY, new Date(Date.UTC(2026, 8, 1))),
      null,
    );
  });

  it("an empty `rows` — the silent-zero shape — is refused, not crashed on", () => {
    assert.equal(pickUtiDisclosureUrl({ rows: [] }, AUGUST), null);
    assert.equal(pickUtiDisclosureUrl({}, AUGUST), null);
    assert.equal(pickUtiDisclosureUrl(null, AUGUST), null);
    assert.equal(pickUtiDisclosureUrl("<!doctype html>", AUGUST), null);
  });

  it("a row that is not the consolidated portfolio is refused", () => {
    // The one thing the endpoint's own name does not guarantee. Note the plan
    // for this ticket proposed matching `/sebi\s*exposure/i` — that string is
    // the ZIP MEMBER's filename and appears nowhere in the response, so that
    // rule would have matched ZERO rows every month.
    const other = {
      rows: [{ ...LIVE_BODY.rows[0], name: "Risk-o-meter August 2026" }],
    };
    assert.equal(pickUtiDisclosureUrl(other, AUGUST), null);
  });

  it("a discovery-only source is FETCHABLE once verified", () => {
    // `fetchableSources` meant "verified AND has a buildUrl", so promoting UTI
    // without widening it would have left the row `verified` and never fetched
    // — a provenance that claims coverage the run does not have.
    // MUTATION: restore `s.buildUrl !== null` -> RED here.
    const uti = amcSource("UTI")!;
    assert.equal(uti.buildUrl, null);
    assert.ok(uti.discoverUrl, "UTI resolves its URL by asking");
    assert.ok(
      fetchableSources().some((s) => s.id === "UTI"),
      "a scheduled run must reach it",
    );
  });

  it("a per-scheme house is still NOT fetchable from a month alone", () => {
    // The widening must not turn HDFC into a source: it publishes one file per
    // scheme and a month does not name them.
    assert.ok(!fetchableSources().some((s) => s.id === "HDFC"));
  });
});
