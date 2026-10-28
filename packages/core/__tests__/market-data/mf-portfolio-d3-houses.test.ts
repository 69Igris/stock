/**
 * Kotak and ICICI Prudential — MONEY-1405 D3.
 *
 * ## Three defects, all of the same shape: the file downloads and says nothing
 *
 * Neither house had a row in `AMC_SOURCES` that could be fetched, so neither
 * had ever reached the parser. When they did, on the live August-2026 files,
 * each produced a workbook that parsed "successfully" and was wrong:
 *
 *   KOTAK  119 sheets, **110 holdings**, every ISIN null. The `Name of
 *          Instrument` header is MERGED across columns A:C and SheetJS reports
 *          a merged value only at the top-left cell, so the mapped column was
 *          empty on every security row and the only survivor per scheme was
 *          `Net Current Assets/(Liabilities)`, which really is written in
 *          column A. One cash line per fund, stored, joinable, wrong.
 *   KOTAK  118 of 119 sheets had NO scheme name, because the house's only
 *          title row carries an as-on label (`Portfolio of X as on 31-Aug-2026`)
 *          and `findSchemeMeta` skips those. `writeSheet` would have keyed them
 *          on the worksheet name — the house's internal short code `V3I` —
 *          which is unjoinable to AMFI for ever.
 *   ICICI  every sheet summed to ~**300%** of NAV, because it prints each SEBI
 *          section's SUBTOTAL on the heading line itself rather than on a row
 *          saying "Total". Two phantom holdings per section, each ~100% by
 *          weight, and `AGGREGATE_ROW` cannot see them.
 *   ICICI  `parseAmcPortfolioWorkbook` returned **null** for the whole 25 MB
 *          zip, and 37 of its 147 members would have been unreadable
 *          individually — both because a local zip header is allowed to lie
 *          about its sizes and ICICI's all do.
 *
 * ## Why these fixtures are synthesised
 *
 * Same reason as `mf-portfolio-amc-headers.test.ts` next door: what is pinned
 * is a SHAPE — a merged header, a subtotal-bearing heading, a zip that defers
 * its sizes — and each reproduces in a dozen rows. The real files are 3.7 MB
 * and 25 MB and there are twelve of each a year. The byte-level questions that
 * genuinely need real bytes (magic-byte sniffing, the two percent scales) are
 * already pinned against the four committed workbooks under
 * `__tests__/fixtures/amc/`.
 *
 * Every change here was blast-radius measured against all four of those before
 * and after: sheets, holdings, null ISINs, null scheme names, scale-suspect
 * counts, as-on months and the 95-105% weight band are IDENTICAL on SBI,
 * Nippon, HDFC and ABSL.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import * as XLSX from "xlsx";

import {
  detectWorkbookFormat,
  parseAmcPortfolioWorkbook,
} from "../../src/market-data/mf-portfolio-logic";

/**
 * @param percentCol Stamp `0.00%` as the NUMBER FORMAT on this column.
 *   ICICI stores its `% to Nav` as a fraction (`0.5059`) and lets Excel render
 *   it, which is the only reason `resolvePercentScale` can tell 0.5059 from
 *   half a percent. `aoa_to_sheet` writes no formats, so a fixture built
 *   without this one would exercise the column-SUM fallback instead of the
 *   number-format rule the live file actually takes.
 */
function workbook(
  rows: unknown[][],
  sheetName: string,
  percentCol?: number,
): Buffer {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (percentCol !== undefined) {
    for (let r = 0; r < rows.length; r++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c: percentCol })] as
        | { t?: string; z?: string }
        | undefined;
      if (cell && cell.t === "n") cell.z = "0.00%";
    }
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** ICICI's `% to Nav` column index — see {@link iciciSheet}. */
const ICICI_PCT_COL = 7;

/* -------------------------------------------------------------------------- */
/* Kotak                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Kotak's sheet shape, cell for cell, from the live August-2026 workbook.
 *
 * The header cell sits at index 0 and the names at index 2, which is what a
 * merged A:C header looks like once SheetJS has flattened it. Columns 1 and 2
 * have NO header text, and column 1 holds a single space on every data row —
 * both verbatim, because both are what the span walk has to survive.
 */
function kotakSheet(): unknown[][] {
  return [
    [
      null,
      null,
      "Portfolio of Kotak Nifty200 Value 30 Index Fund as on 31-Aug-2026",
    ],
    [
      "Name of Instrument",
      null,
      null,
      "ISIN Code",
      "Industry",
      "Yield",
      "Quantity",
      "Market Value (Rs.in Lacs)",
      "% to Net Assets",
    ],
    ["Equity & Equity related"],
    [null, "Listed/Awaiting listing on Stock Exchange"],
    [
      null,
      " ",
      "STATE BANK OF INDIA.",
      "INE062A01020",
      "Banks",
      null,
      6613,
      70.1,
      40.32,
    ],
    [
      null,
      " ",
      "BHARAT PETROLEUM CORPORATION  LTD.",
      "INE029A01011",
      "Petroleum Products",
      null,
      21612,
      70.03,
      40.31,
    ],
    [
      null,
      " ",
      "Oil And Natural Gas Corporation Ltd.",
      "INE213A01029",
      "Oil",
      null,
      28512,
      66.09,
      19.32,
    ],
    [null, null, null, null, "Total", null, null, 206.22, 99.95],
    [],
    [
      "Net Current Assets/(Liabilities)",
      null,
      null,
      null,
      null,
      null,
      null,
      0.74,
      0.05,
    ],
    [],
    [null, null, null, null, "Grand Total", null, null, 206.96, 100],
  ];
}

describe("MONEY-1405 — Kotak's MERGED instrument-name header", () => {
  it("[meta] the synthesised workbook is a real OOXML file", () => {
    // Without this every assertion below could be passing on a parser that
    // rejected the bytes for an unrelated reason and returned null anyway.
    assert.equal(
      workbook(kotakSheet(), "V3I").subarray(0, 2).toString("latin1"),
      "PK",
    );
  });

  it("reads the names from the column the DATA is in, not the header's", () => {
    // MUTATION: in `parseSheet`, replace the `rowShape(...)` name with
    // `normText(row[cols.instrumentName]?.v)` -> 1 holding, RED here. That is
    // the live defect exactly: 119 sheets, 110 holdings, every ISIN null.
    const parsed = parseAmcPortfolioWorkbook(workbook(kotakSheet(), "V3I"));
    assert.ok(parsed, "the workbook must parse");
    assert.equal(parsed.sheets.length, 1);

    const sheet = parsed.sheets[0]!;
    assert.deepEqual(
      sheet.holdings.map((h) => h.instrumentName),
      [
        "STATE BANK OF INDIA.",
        "BHARAT PETROLEUM CORPORATION LTD.",
        "Oil And Natural Gas Corporation Ltd.",
        "Net Current Assets/(Liabilities)",
      ],
      "the cash line is written in the MAPPED column and must survive " +
        "alongside the three that are not — a fix that moved the column " +
        "instead of widening it would lose it",
    );
    assert.deepEqual(
      sheet.holdings.map((h) => h.isin),
      ["INE062A01020", "INE029A01011", "INE213A01029", null],
      "the ISINs must be READ, not merely the rows counted",
    );
  });

  it("the span stops at the first HEADED column — it cannot eat the ISIN", () => {
    // The bound that makes the widening safe, tested adversarially: a row with
    // NOTHING in the name span but a real ISIN beside it. Unbounded, the walk
    // reaches column 3 and stores a holding whose name is its own ISIN — a row
    // that looks perfectly stored and names no instrument.
    //
    // MUTATION: remove `if ((headers[c] ?? "") !== "") break` from
    // `instrumentNameSpan` -> a fifth holding named "INE009A01021", RED here.
    //
    // (An earlier version of this test asserted the same thing through a
    // second `claimed.has(c)` guard. A mutation showed that guard could not
    // change any answer — every column `mapColumns` claims has header text, so
    // the header test already covers it — and it was deleted rather than left
    // as protection nobody has.)
    const rows = kotakSheet();
    rows.splice(7, 0, [
      null,
      null,
      null,
      "INE009A01021",
      "IT - Software",
      null,
      100,
      1.5,
      0.01,
    ]);
    const sheet = parseAmcPortfolioWorkbook(workbook(rows, "V3I"))!.sheets[0]!;
    assert.equal(sheet.columns.instrumentName, 0);
    assert.equal(sheet.columns.isin, 3);
    assert.equal(
      sheet.holdings.length,
      4,
      "the nameless row must be DROPPED, not named after its ISIN",
    );
    for (const h of sheet.holdings) {
      assert.ok(
        !/^INE[A-Z0-9]/.test(h.instrumentName),
        `an ISIN leaked into the name column: ${h.instrumentName}`,
      );
    }
  });

  it("the weights sum to ~100% and the money cross-check passes", () => {
    const sheet = parseAmcPortfolioWorkbook(workbook(kotakSheet(), "V3I"))!
      .sheets[0]!;
    assert.ok(
      sheet.percentSum !== null &&
        sheet.percentSum >= 95 &&
        sheet.percentSum <= 105,
      `percentSum ${sheet.percentSum}`,
    );
    assert.notEqual(
      sheet.percentSumCheck.verdict,
      "scale-suspect",
      "a scale-suspect sheet is REFUSED by the sync — the whole house would " +
        "write nothing",
    );
  });

  it("the as-on date is read from the title row", () => {
    const sheet = parseAmcPortfolioWorkbook(workbook(kotakSheet(), "V3I"))!
      .sheets[0]!;
    assert.equal(sheet.asOfDate, "2026-08-31");
  });

  it("the scheme NAME comes out of `Portfolio of X as on Y`", () => {
    // MUTATION: delete the PORTFOLIO_OF branch in `findSchemeMeta` ->
    // schemeName null, and `writeSheet` keys 119 Kotak schemes on their
    // internal short codes (`V3I`), unjoinable to AMFI for ever.
    const sheet = parseAmcPortfolioWorkbook(workbook(kotakSheet(), "V3I"))!
      .sheets[0]!;
    assert.equal(sheet.schemeName, "Kotak Nifty200 Value 30 Index Fund");
  });

  it("does NOT fire on the as-on spellings the other houses use", () => {
    // The reason the pattern is anchored on `portfolio of|for` rather than
    // "strip the as-on clause and keep the rest". Both of these are ≥ 8
    // characters after such a strip, so a looser rule would name the scheme
    // "Portfolio" (Tata) and "Monthly Portfolio Statement" (Nippon) — two
    // houses that name their schemes correctly today.
    for (const [title, expected] of [
      ["Portfolio as on 31-08-26", "Tata Value Fund"],
      ["Monthly Portfolio Statement as on August 31,2026", "Tata Value Fund"],
    ] as const) {
      const rows = kotakSheet();
      rows[0] = [null, "Tata Value Fund", title];
      const sheet = parseAmcPortfolioWorkbook(workbook(rows, "V3I"))!
        .sheets[0]!;
      assert.equal(sheet.schemeName, expected, title);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* ICICI Prudential                                                            */
/* -------------------------------------------------------------------------- */

/**
 * ICICI's sheet shape, from the live `ICICI Prudential Nifty 50 ETF.xlsx`.
 *
 * Rows 4 and 6 are the SECTION HEADINGS that carry their own subtotal; rows 7-8
 * are the securities; the TREPS and Net Current Assets rows at the bottom have
 * exactly the same shape as the headings and are REAL holdings. That
 * indistinguishability is the whole problem, and it is why the rule is
 * positional rather than a list of heading names.
 */
function iciciSheet(): unknown[][] {
  return [
    [null, "ICICI Prudential Mutual Fund"],
    [null, "ICICI Prudential Nifty 50 ETF"],
    [null, "Portfolio as on Aug 31,2026"],
    [
      null,
      "Company/Issuer/Instrument Name",
      "ISIN",
      "Coupon",
      "Industry/Rating",
      "Quantity",
      "Exposure/Market Value(Rs.Lakh)",
      "% to Nav",
    ],
    [
      null,
      "Equity & Equity Related Instruments",
      "",
      "",
      "",
      "",
      859038.99,
      0.9913,
    ],
    [null, "", null, null, null, null, null, null],
    [
      null,
      "Listed / Awaiting Listing On Stock Exchanges",
      "",
      "",
      "",
      "",
      859038.99,
      0.9913,
    ],
    [
      null,
      "HDFC Bank Ltd.",
      "INE040A01034",
      "",
      "Banks",
      61837112,
      438425.12,
      0.5059,
    ],
    [
      null,
      "ICICI Bank Ltd.",
      "INE090A01021",
      "",
      "Banks",
      28928052,
      420613.87,
      0.4854,
    ],
    [null, "", null, null, null, null, null, null],
    [null, "Unlisted", "", "", "", "", "Nil", "Nil"],
    [null, "", null, null, null, null, null, null],
    [null, "TREPS", "", "", "", "", 3805.9, 0.0044],
    [null, "", null, null, null, null, null, null],
    [null, "Net Current Assets", "", "", "", "", 3721.11, 0.0043],
    [null, "Total Net Assets", "", "", "", "", 866566.0, 1.0],
  ];
}

describe("MONEY-1405 — ICICI's section headings carry their own subtotal", () => {
  it("[meta] the synthesised workbook is a real OOXML file", () => {
    assert.equal(
      workbook(iciciSheet(), "NIFETF", ICICI_PCT_COL)
        .subarray(0, 2)
        .toString("latin1"),
      "PK",
    );
  });

  it("the subtotal-bearing headings are NOT stored as holdings", () => {
    // MUTATION: delete the `headsItsOwnSection(...)` branch in `parseSheet` ->
    // 4 holdings become 6 and the sum goes from ~100% to ~299%, RED here. That
    // is the live defect: every one of ICICI's 147 August-2026 sheets.
    const parsed = parseAmcPortfolioWorkbook(
      workbook(iciciSheet(), "NIFETF", ICICI_PCT_COL),
    );
    assert.ok(parsed);
    const sheet = parsed.sheets[0]!;
    assert.deepEqual(
      sheet.holdings.map((h) => h.instrumentName),
      ["HDFC Bank Ltd.", "ICICI Bank Ltd.", "TREPS", "Net Current Assets"],
    );
  });

  it("TREPS and Net Current Assets SURVIVE — they look identical to a heading", () => {
    // The direction that must never be wrong. A heading counted as a holding
    // inflates a weight and is visible in `percentSum`; a cash line DELETED as
    // a heading silently removes a real position, and nothing downstream can
    // see it. Hence "a row whose successors carry no ISIN and no quantity stays
    // a holding" rather than a vocabulary of section names, which would have to
    // separate `Government Securities` (a heading) from `Net Current Assets`
    // (a holding) by string alone.
    const sheet = parseAmcPortfolioWorkbook(
      workbook(iciciSheet(), "NIFETF", ICICI_PCT_COL),
    )!.sheets[0]!;
    const cash = sheet.holdings.filter((h) => h.isin === null);
    assert.deepEqual(
      cash.map((h) => h.instrumentName),
      ["TREPS", "Net Current Assets"],
    );
    assert.deepEqual(
      cash.map((h) => h.marketValueLakhs),
      [3805.9, 3721.11],
    );
  });

  it("the weights sum to ~100%, not ~300%", () => {
    const sheet = parseAmcPortfolioWorkbook(
      workbook(iciciSheet(), "NIFETF", ICICI_PCT_COL),
    )!.sheets[0]!;
    assert.ok(
      sheet.percentSum !== null &&
        sheet.percentSum >= 95 &&
        sheet.percentSum <= 105,
      `percentSum ${sheet.percentSum}`,
    );
    assert.notEqual(sheet.percentSumCheck.verdict, "scale-suspect");
    assert.equal(sheet.asOfDate, "2026-08-31");
  });

  it("a heading whose children carry a QUANTITY but no ISIN is still a heading", () => {
    // ICICI's gold and silver ETFs hold a commodity, so there is no ISIN
    // anywhere on the sheet and an ISIN-only lookahead can never fire. Measured
    // live before the quantity arm existed: both summed to ~199%.
    // MUTATION: narrow the lookahead to `if (hasIsin) return true` -> `Gold`
    // is stored as a second copy of the bar it heads, RED here.
    const rows = iciciSheet();
    rows[4] = [null, "Gold", "", "", "", "", 859038.99, 0.9913];
    rows[6] = [
      null,
      "Gold (995 Purity) ^",
      null,
      "",
      "Gold",
      17937,
      859038.99,
      0.9913,
    ];
    rows.splice(7, 2); // drop the two ISIN-bearing securities
    const sheet = parseAmcPortfolioWorkbook(
      workbook(rows, "GOLD", ICICI_PCT_COL),
    )!.sheets[0]!;
    assert.deepEqual(
      sheet.holdings.map((h) => h.instrumentName),
      ["Gold (995 Purity) ^", "TREPS", "Net Current Assets"],
    );
  });

  it("REGRESSION: a `Total` CLOSES a section, so the row above it is a holding", () => {
    // Nippon publishes `Triparty Repo` (36% of one interval fund) followed by
    // its section's `Total`, then a NEW section whose first row has an ISIN.
    // Without the aggregate stop the lookahead walks straight past both and
    // deletes a real cash position: measured, 102 rows across the committed
    // Nippon fixture.
    // MUTATION: remove `if (isAggregateRow(name)) return false` from
    // `headsItsOwnSection` -> `Triparty Repo` disappears, RED here.
    const rows: unknown[][] = [
      [null, "Monthly Portfolio Statement as on August 31,2026"],
      [
        null,
        "ISIN",
        "Name of the Instrument",
        "Industry / Rating",
        "Quantity",
        "Market/Fair Value ( Rs. in Lacs)",
        "% to NAV",
      ],
      [null, null, "Money Market Instruments"],
      [null, null, "Triparty Repo", null, null, 262.29, 36.12],
      [null, null, "Total", null, null, 262.29, 36.12],
      [null, null, "Mutual Fund Units"],
      [
        "118701",
        "INF204K01ZH0",
        "Nippon India Liquid Fund-Direct Growth Plan",
        null,
        6688.548,
        461.78,
        63.6,
      ],
      [null, null, "GRAND TOTAL", null, null, 726.07, 100],
    ];
    const sheet = parseAmcPortfolioWorkbook(workbook(rows, "K5"))!.sheets[0]!;
    assert.deepEqual(
      sheet.holdings.map((h) => h.instrumentName),
      ["Triparty Repo", "Nippon India Liquid Fund-Direct Growth Plan"],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1409 — the heading whose children carry NOTHING                       */
/* -------------------------------------------------------------------------- */

/**
 * ICICI Prudential Overnight Fund, `OVERNITE`, verbatim from the live July-2026
 * member — the one sheet of 146 that `headsItsOwnSection` cannot decide.
 *
 * `Reverse Repo` carries a subtotal AND both of its children carry neither an
 * ISIN nor a quantity, so the forward walk looks past both, past `TREPS` and
 * `Net Current Assets`, reaches `Total Net Assets` and declines. All three rows
 * stored and the sheet summed to **178.36%** of NAV.
 *
 * The two legs are the real ones: 944,966.09 + 84,961.91 = 1,029,928.00, to the
 * paisa, which is what makes the heading recognisable at all.
 */
function iciciOvernightSheet(): unknown[][] {
  return [
    [null, "ICICI Prudential Mutual Fund"],
    [null, "ICICI Prudential Overnight Fund"],
    [null, "Portfolio as on Aug 31,2026"],
    [
      null,
      "Company/Issuer/Instrument Name",
      "ISIN",
      "Coupon",
      "Industry/Rating",
      "Quantity",
      "Exposure/Market Value(Rs.Lakh)",
      "% to Nav",
    ],
    [null, "Treasury Bills", "", "", "", "", 70347.45, 0.0535],
    [
      null,
      "91 Days Treasury Bills",
      "IN002026X057",
      "",
      "SOV",
      19000000,
      18986.61,
      0.0144,
    ],
    [
      null,
      "182 Days Treasury Bills",
      "IN002025Y479",
      "",
      "SOV",
      17000000,
      51360.84,
      0.0391,
    ],
    [null, "", null, null, null, null, null, null],
    [null, "Reverse Repo", "", "", "", "", 1029928.0, 0.7836],
    [null, "Reverse Repo (8/3/2026)", "", "", "", "", 944966.09, 0.7189],
    [null, "Reverse Repo (8/3/2026)", "", "", "", "", 84961.91, 0.0646],
    [null, "", null, null, null, null, null, null],
    [null, "TREPS", "", "", "", "", 210571.67, 0.1602],
    [null, "", null, null, null, null, null, null],
    [null, "Net Current Assets", "", "", "", "", 3587.93, 0.0027],
    [null, "Total Net Assets", "", "", "", "", 1314435.05, 1.0],
  ];
}

describe("MONEY-1409 — a heading whose subtotal IS the block beneath it", () => {
  it("[meta] the synthesised workbook is a real OOXML file", () => {
    assert.equal(
      workbook(iciciOvernightSheet(), "OVERNITE", ICICI_PCT_COL)
        .subarray(0, 2)
        .toString("latin1"),
      "PK",
    );
  });

  it("`Reverse Repo` is dropped and BOTH of its legs survive", () => {
    // MUTATION: remove `|| headsItsOwnSectionBySum(...)` from `parseSheet` ->
    // `Reverse Repo` is stored as a third holding and the sheet sums to
    // 178.36%, RED here. That is the live defect, one sheet of 146.
    const sheet = parseAmcPortfolioWorkbook(
      workbook(iciciOvernightSheet(), "OVERNITE", ICICI_PCT_COL),
    )!.sheets[0]!;
    assert.deepEqual(
      sheet.holdings.map((h) => h.instrumentName),
      [
        "91 Days Treasury Bills",
        "182 Days Treasury Bills",
        "Reverse Repo (8/3/2026)",
        "Reverse Repo (8/3/2026)",
        "TREPS",
        "Net Current Assets",
      ],
      "the two repo LEGS carry the money; only the line that states their " +
        "total is the heading",
    );
    assert.ok(
      sheet.percentSum !== null &&
        sheet.percentSum >= 95 &&
        sheet.percentSum <= 105,
      `percentSum ${sheet.percentSum}`,
    );
  });

  it("a heading whose value does NOT equal the block is KEPT", () => {
    // The conservative direction, restated for the sum rule: a cash line is
    // never deleted. `Reverse Repo` here states 900,000 against legs totalling
    // 1,029,928 — not a subtotal, so not a heading.
    // MUTATION: `return summed >= 2` (drop the tolerance test) -> `Reverse
    // Repo` disappears and a real position is deleted, RED here.
    const rows = iciciOvernightSheet();
    rows[8] = [null, "Reverse Repo", "", "", "", "", 900000.0, 0.6848];
    const sheet = parseAmcPortfolioWorkbook(
      workbook(rows, "OVERNITE", ICICI_PCT_COL),
    )!.sheets[0]!;
    assert.ok(
      sheet.holdings.some((h) => h.instrumentName === "Reverse Repo"),
      "a row that is not the sum of its neighbours is a holding",
    );
  });

  it("the sum must EXHAUST the block — a PREFIX hit is not a subtotal", () => {
    // Measured, not hypothetical. A first version tested the RUNNING total
    // after every row and deleted 16 genuine interest-rate-swap legs across
    // five live ICICI sheets, because the legs are round numbers and
    // `10,000 = 5,000 + 5,000` two rows later is arithmetic, not structure.
    // Here the SECTION total (30,000) is a real subtotal of all four legs and
    // must go; the first leg (10,000) is followed by 5,000 + 5,000 and must
    // stay.
    // MUTATION: move the tolerance test inside the loop (prefix form) -> the
    // 10,000 leg is deleted, RED here.
    const rows = iciciOvernightSheet();
    rows.splice(
      8,
      3,
      [
        null,
        "INTEREST RATE SWAPS (At Notional Value)",
        "",
        "",
        "",
        "",
        30000,
        0.0228,
      ],
      [
        null,
        "Interest Rate Swaps- MD -18-May-2027",
        "",
        "",
        "",
        "",
        10000,
        0.0076,
      ],
      [
        null,
        "Interest Rate Swaps- MD -18-May-2028",
        "",
        "",
        "",
        "",
        5000,
        0.0038,
      ],
      [
        null,
        "Interest Rate Swaps- MD -18-May-2028",
        "",
        "",
        "",
        "",
        5000,
        0.0038,
      ],
      [
        null,
        "Interest Rate Swaps- MD -18-May-2029",
        "",
        "",
        "",
        "",
        10000,
        0.0076,
      ],
    );
    const names = parseAmcPortfolioWorkbook(
      workbook(rows, "OVERNITE", ICICI_PCT_COL),
    )!.sheets[0]!.holdings.map((h) => h.instrumentName);
    assert.ok(
      !names.includes("INTEREST RATE SWAPS (At Notional Value)"),
      "the section total is the sum of all four legs and is a heading",
    );
    assert.equal(
      names.filter((n) => n.startsWith("Interest Rate Swaps- MD")).length,
      4,
      "every leg is a real position — none of them heads anything",
    );
  });

  it("a block of ONE equal row is not a section — the row is kept", () => {
    // A value printed twice in consecutive rows is indistinguishable from a
    // one-member section, and dropping the first copy deletes a cash line.
    // MUTATION: `summed >= 1` -> `Reverse Repo` disappears, RED here.
    const rows = iciciOvernightSheet();
    rows.splice(
      8,
      3,
      [null, "Reverse Repo", "", "", "", "", 1029928.0, 0.7836],
      [null, "Reverse Repo (8/3/2026)", "", "", "", "", 1029928.0, 0.7836],
    );
    const names = parseAmcPortfolioWorkbook(
      workbook(rows, "OVERNITE", ICICI_PCT_COL),
    )!.sheets[0]!.holdings.map((h) => h.instrumentName);
    assert.ok(names.includes("Reverse Repo"));
  });

  it("REGRESSION: the sum walk stops at a `Total`, like the walk beside it", () => {
    // The 102 deleted Nippon cash rows, reproduced against the SUM rule rather
    // than the lookahead. `Triparty Repo` (36% of one interval fund) is a real
    // position; without the aggregate stop the walk reads past its own section
    // `Total` and adds the next section's row, hitting its value exactly.
    // MUTATION: remove `if (isAggregateRow(name)) break` from
    // `headsItsOwnSectionBySum` -> `Triparty Repo` disappears, RED here.
    const rows: unknown[][] = [
      [null, "Monthly Portfolio Statement as on August 31,2026"],
      [
        null,
        "ISIN",
        "Name of the Instrument",
        "Industry / Rating",
        "Quantity",
        "Market/Fair Value ( Rs. in Lacs)",
        "% to NAV",
      ],
      [null, null, "Money Market Instruments"],
      [null, null, "Triparty Repo", null, null, 262.29, 36.12],
      [null, null, "Total", null, null, 162.29, 22.35],
      [null, null, "Net Current Assets", null, null, 100.0, 13.77],
      [null, null, "GRAND TOTAL", null, null, 726.07, 100],
    ];
    const names = parseAmcPortfolioWorkbook(
      workbook(rows, "K5"),
    )!.sheets[0]!.holdings.map((h) => h.instrumentName);
    assert.deepEqual(names, ["Triparty Repo", "Net Current Assets"]);
  });

  it("the walk stops at a table TERMINATOR, not only at a `Total`", () => {
    // `Notes` ENDS the holdings table (`isTableTerminator`), and here it ends
    // the repo block too — no blank row between them, which is how the section
    // sits when it is the last one on the sheet. Without the stop the walk
    // reaches a row that names something and carries no money, and answers
    // `false` — so the heading survives and the sheet double-counts again.
    // MUTATION: remove `if (isTableTerminator(row)) break` from
    // `headsItsOwnSectionBySum` -> `Reverse Repo` is stored, RED here.
    const rows = iciciOvernightSheet();
    rows.splice(11, rows.length - 11, [null, "Notes"]);
    const names = parseAmcPortfolioWorkbook(
      workbook(rows, "OVERNITE", ICICI_PCT_COL),
    )!.sheets[0]!.holdings.map((h) => h.instrumentName);
    assert.ok(!names.includes("Reverse Repo"), "the block still adds up");
    assert.equal(
      names.filter((n) => n.startsWith("Reverse Repo (")).length,
      2,
      "and both legs are still real positions",
    );
  });

  it("a named row inside the block that states NO money makes it decline", () => {
    // `Unlisted | Nil | Nil` is a real ICICI row and a real hazard: it names
    // something, it is not a `Total`, and it states no amount. A subtotal's
    // children all carry money, so a block containing one is not a block this
    // rule can add up — and the answer to "cannot tell" is the conservative
    // one, an over-count that `percentSum` reports, never a deleted position.
    // MUTATION: `if (mv === null) continue` -> the moneyless row is skipped,
    // the two legs still total the heading, and `Reverse Repo` is deleted on a
    // block this rule never actually read, RED here.
    const rows = iciciOvernightSheet();
    rows.splice(10, 0, [null, "Unlisted", "", "", "", "", "Nil", "Nil"]);
    const names = parseAmcPortfolioWorkbook(
      workbook(rows, "OVERNITE", ICICI_PCT_COL),
    )!.sheets[0]!.holdings.map((h) => h.instrumentName);
    assert.ok(
      names.includes("Reverse Repo"),
      "an unreadable block leaves the heading alone",
    );
  });

  it("a BLANK row ends the block — it is not skipped past", () => {
    // The other half of "exhaust the block". `Reverse Repo`'s two legs are
    // followed by a blank row and then `TREPS` and `Net Current Assets`, which
    // belong to no section. Reading past the blank makes the block total
    // 1,244,087.60 against a heading of 1,029,928.00 and the rule declines —
    // so the sheet goes back to 178%.
    // MUTATION: `if (!name) continue` instead of `break` in
    // `headsItsOwnSectionBySum` -> `Reverse Repo` is stored, RED here.
    const names = parseAmcPortfolioWorkbook(
      workbook(iciciOvernightSheet(), "OVERNITE", ICICI_PCT_COL),
    )!.sheets[0]!.holdings.map((h) => h.instrumentName);
    assert.ok(!names.includes("Reverse Repo"));
    assert.ok(names.includes("TREPS") && names.includes("Net Current Assets"));
  });
});

/* -------------------------------------------------------------------------- */
/* The zip container                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build a zip whose LOCAL HEADERS defer their sizes — ICICI's shape exactly.
 *
 * General-purpose bit 3 means the local header carries zeroed crc/sizes and the
 * real ones trail the data in a descriptor, so a reader walking local headers
 * cannot find the next entry without guessing. The CENTRAL DIRECTORY carries
 * the truth, and that is what the parser reads.
 *
 * DEFLATE rather than STORE, deliberately: a stored member's "compressed"
 * bytes are the file itself, so a forward scan for the next signature would
 * usually succeed by luck and the fixture would not reproduce the defect.
 */
function zipWithDeferredSizes(
  entries: ReadonlyArray<{ name: string; bytes: Buffer }>,
): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf-8");
    const data = deflateRawSync(e.bytes);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0008, 6); // bit 3 — sizes in a trailing descriptor
    local.writeUInt16LE(8, 8); // DEFLATE
    // crc32 + both sizes stay ZERO here, which is the whole point.
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);

    // The descriptor the local header promised. Its CRC is not checked by this
    // parser (it reads sizes from the central directory), so it is written as
    // zero rather than computed — a real archiver would fill it in.
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(0, 4);
    descriptor.writeUInt32LE(data.length, 8);
    descriptor.writeUInt32LE(e.bytes.length, 12);

    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0008, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(e.bytes.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    name.copy(cd, 46);
    central.push(cd);

    chunks.push(local, data, descriptor);
    offset += local.length + data.length + descriptor.length;
  }

  const cdBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...chunks, cdBytes, eocd]);
}

describe("MONEY-1405 — a zip whose local headers defer their sizes", () => {
  const nifty = workbook(iciciSheet(), "NIFETF", ICICI_PCT_COL);
  const gold = workbook(iciciSheet(), "GOLDETF", ICICI_PCT_COL);

  it("[meta] the helper really does zero the local sizes", () => {
    // Without this the two tests below could be passing against an ordinary
    // zip and would say nothing about the defect they name.
    const zip = zipWithDeferredSizes([{ name: "a.xlsx", bytes: nifty }]);
    assert.equal(zip.readUInt16LE(6) & 0x08, 0x08, "bit 3 must be set");
    assert.equal(zip.readUInt32LE(18), 0, "local compressed size must be 0");
    assert.equal(zip.readUInt32LE(22), 0, "local uncompressed size must be 0");
  });

  it("reads EVERY member, not just the first", () => {
    // MUTATION: make `unzipWorkbookEntries` return only `[entries[0]]` ->
    // 1 sheet, RED here. Live, that would have stored 1 of ICICI's 146 schemes
    // and reported a clean success.
    const zip = zipWithDeferredSizes([
      { name: "ICICI Prudential Nifty 50 ETF.xlsx", bytes: nifty },
      { name: "ICICI Prudential Gold ETF.xlsx", bytes: gold },
    ]);
    assert.equal(detectWorkbookFormat(zip), "zip-archive");

    const parsed = parseAmcPortfolioWorkbook(zip);
    assert.ok(parsed, "a deferred-size archive must parse");
    assert.equal(parsed.sheets.length, 2);
  });

  it("a MULTI-member archive names each scheme after its member file", () => {
    // ICICI prints its own AMC name on row 1 of every member, above the
    // scheme's, and `findSchemeMeta` takes the first row that has a candidate —
    // so all 147 schemes would collapse onto one `schemeKey` and upsert over
    // each other. The publisher named the files; that is the stronger claim.
    // MUTATION: drop the `read.sheets[0]!.schemeName = entryStem(...)` line ->
    // both sheets come back "ICICI Prudential Mutual Fund", RED here.
    const zip = zipWithDeferredSizes([
      { name: "ICICI Prudential Nifty 50 ETF.xlsx", bytes: nifty },
      { name: "ICICI Prudential Gold ETF.xlsx", bytes: gold },
    ]);
    assert.deepEqual(
      parseAmcPortfolioWorkbook(zip)!.sheets.map((s) => s.schemeName),
      ["ICICI Prudential Nifty 50 ETF", "ICICI Prudential Gold ETF"],
    );
  });

  it("a SINGLE-member archive keeps the names its sheets carry", () => {
    // ABSL's one member holds ~105 schemes. Naming all of them after the zip
    // member would be the same defect from the other side, which is why the
    // rule is confined to archives with more than one member.
    // MUTATION: drop the `members.length > 1` guard -> the scheme is renamed
    // after the file, RED here.
    const zip = zipWithDeferredSizes([
      { name: "31082026_ABSLMF_MonthlyDisclosure.xls", bytes: nifty },
    ]);
    const parsed = parseAmcPortfolioWorkbook(zip)!;
    assert.equal(
      parsed.containerEntryName,
      "31082026_ABSLMF_MonthlyDisclosure.xls",
    );
    assert.equal(parsed.sheets[0]!.schemeName, "ICICI Prudential Mutual Fund");
  });

  it("an OOXML workbook whose first member is not an OPC part still sniffs `ooxml`", () => {
    // 37 of ICICI's 147 members failed here, individually, before the central
    // directory was consulted: their first zip member is `docProps/app.xml`,
    // the local walk stops there because of bit 3, and `isOpcPart` says no — so
    // an ordinary workbook read as `zip-archive`, was treated as a container,
    // held no `.xlsx` member, and came back null.
    // MUTATION: make `readZipEntryNames` use `readLocalHeaderNames` only ->
    // "zip-archive", RED here.
    const zip = zipWithDeferredSizes([
      { name: "docProps/app.xml", bytes: Buffer.from("<Properties/>") },
      { name: "[Content_Types].xml", bytes: Buffer.from("<Types/>") },
      { name: "xl/workbook.xml", bytes: Buffer.from("<workbook/>") },
    ]);
    assert.equal(detectWorkbookFormat(zip), "ooxml");
  });

  it("a TRUNCATED archive is still refused", () => {
    // The fallback the local walk was kept for. A short read has no central
    // directory at all, and `XLSX.read` does not throw on one — it spins
    // forever — so it must be rejected before it reaches the reader.
    assert.equal(parseAmcPortfolioWorkbook(nifty.subarray(0, 512)), null);
  });
});
