/**
 * AMC header spellings — MONEY-1405 (D3 step 0).
 *
 * ## TWO houses wrote zero rows for the life of their source, from one defect class
 *
 * Both were `provenance: "verified"`, both reported `FETCH_FAILED` in the
 * nightly `[job-outcome]`, and in both cases the file downloaded perfectly:
 *
 *   TATA             1,762,746 B, OOXML, 71 sheets in the file -> 0 parsed
 *   THREE_SIXTY_ONE    283,616 B, OOXML, 12 sheets in the file -> 0 parsed
 *
 * `findHeaderRow` locates the holdings table by requiring an ISIN cell AND a
 * percent cell in one row. BOTH regexes were over-anchored, so each house lost
 * one of the two signals and every sheet was dropped — silently, because a
 * workbook with no recognisable header row is indistinguishable from a workbook
 * with nothing in it:
 *
 *   `/^isin$/`        vs Tata's     `ISIN CODE`
 *   `/^%\s*to\s*…/`   vs 360 ONE's  `Rounded % to Net Assets`
 *
 * They were found a week apart by the same question — "did we ever actually
 * fetch and parse the OTHER AMCs?" — which is the real lesson here. A per-AMC
 * row count is not evidence that an AMC parses: prod reported 26,521 rows
 * written on the same run that dropped both of these entirely.
 *
 * ## What this is a regression test for
 *
 * `TATA` has been `provenance: "verified"` since July 2026 and had **zero rows
 * in `mf_portfolio_holdings`** for the whole of that time, while the nightly
 * `[job-outcome]` reported it `FETCH_FAILED` — a status naming the network.
 *
 * Replayed against the live file on 2026-09-13, every link in the chain worked:
 * the page answered 200 with 161 monthly-portfolio links, `pickLinkForMonth`
 * chose the right one, the download returned **1,762,746 bytes** (matching the
 * `bytes` the failing prod run itself logged), the magic bytes were `PK` and
 * `detectWorkbookFormat` said `ooxml`. The workbook held **71 sheets**.
 * `parseAmcPortfolioWorkbook` returned **0**.
 *
 * The cause was one over-anchored regex. `findHeaderRow` located a holdings
 * header by requiring a cell matching `/^isin$/i`; Tata heads that column
 * `ISIN CODE`. No header row meant `parseSheet` returned null, for all 71
 * sheets, silently — and `FETCH_FAILED` because `parsedOk` never reached
 * `judgeAmcAttempt` from the page-scrape lane.
 *
 * ## Why the fixture is synthesised rather than committed
 *
 * The real workbook is 1.76 MB and there are twelve of them a year. What is
 * being pinned is a HEADER VOCABULARY — four cells and a column offset — so the
 * fixture reproduces exactly that, taken verbatim from the live file, and the
 * file itself is not worth a megabyte of git history. `mf-portfolio-logic`'s
 * other traps (magic-byte sniffing, the two percent scales, multi-table sheets)
 * are pinned against the four REAL workbooks committed under
 * `__tests__/fixtures/amc/`, which is where a byte-level question belongs.
 *
 * The blast radius of both loosenings was measured before and after against
 * all FOUR committed fixtures plus DSP's live 91-sheet archive: sheets,
 * holdings, as-on nulls, scale-suspect counts and the 95-105% weight band are
 * IDENTICAL on every one. The only file whose output moves is 360 ONE's, from
 * nothing to twelve sheets.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import {
  parseAmcPortfolioWorkbook,
  parseAsOfDate,
  parseMonthPeriod,
  extractAsOnDate,
  isPercentHeader,
} from "../../src/market-data/mf-portfolio-logic";

/**
 * Tata's sheet shape, cell for cell, from the live August-2026 workbook.
 *
 * Two things here are the point and both are verbatim:
 *
 *   - **Column A is empty on every row.** Tata indents the whole table one
 *     column, so nothing can be found positionally.
 *   - **The header vocabulary is its own**: `ISIN CODE` (not `ISIN`),
 *     `MKT VAL(Rs. Lacs)` (not `Market Value`), `INDUSTRY` alone (not the
 *     combined `Industry^ / Rating` the other houses print).
 */
function tataSheet(asOn: string): unknown[][] {
  return [
    ["Index", "TATA VALUE FUND"],
    [null, "Tata Value Fund"],
    [null, "(An open ended equity scheme following a value investment strategy)"],
    [null, "This product is suitable for investors who are seeking*:"],
    [null, "•Long Term Capital Appreciation."],
    [null, `Portfolio as on ${asOn}`],
    [
      null,
      "NAME OF THE INSTRUMENT",
      "YIELD ( IN % )",
      "INDUSTRY",
      "ISIN CODE",
      "QUANTITY",
      "MKT VAL(Rs. Lacs)",
      "% to NAV",
    ],
    [null, "EQUITY & EQUITY RELATED"],
    [null, "A) LISTED/AWAITING LISTING ON STOCK EXCHANGES"],
    [null, "ICICI BANK LTD", "NA", "Banks", "INE090A01021", 5580000, 81133.2, 9.37],
    [null, "SHRIRAM FINANCE LTD", "NA", "Finance", "INE721A01047", 5040000, 55938.96, 6.46],
    [null, "COAL INDIA LTD", "NA", "Consumable Fuels", "INE522F01014", 10489923, 42143.27, 4.87],
  ];
}

/** One sheet, as bytes, through the real OOXML writer. */
function workbook(rows: unknown[][], sheetName = "TEQPEF"): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("MONEY-1405 — Tata's header vocabulary parses", () => {
  it("[meta] the synthesised workbook is a real OOXML file", () => {
    // Without this every assertion below could be passing on a parser that
    // rejected the bytes for an unrelated reason and returned null anyway.
    const bytes = workbook(tataSheet("31-08-26"));
    assert.equal(bytes.subarray(0, 2).toString("latin1"), "PK");
  });

  it("a sheet headed `ISIN CODE` yields holdings — it used to yield nothing", () => {
    // MUTATION: restore `const ISIN_HEADER = /^isin$/i` -> 0 sheets, RED here.
    // This is the Tata bug exactly: findHeaderRow never fires, parseSheet
    // returns null for every sheet, and the workbook reports as empty.
    const parsed = parseAmcPortfolioWorkbook(workbook(tataSheet("31-08-26")));
    assert.ok(parsed, "the workbook must parse");
    assert.equal(parsed.sheets.length, 1);

    const sheet = parsed.sheets[0]!;
    assert.equal(sheet.holdings.length, 3);
    assert.deepEqual(
      sheet.holdings.map((h) => h.isin),
      ["INE090A01021", "INE721A01047", "INE522F01014"],
      "every ISIN must be READ, not merely the header recognised — a fix to " +
        "findHeaderRow alone would give sheets with null ISINs, which is " +
        "worse than none: rows that look stored and cannot be joined",
    );
  });

  it("`MKT VAL(Rs. Lacs)` and a bare `INDUSTRY` map too", () => {
    // MUTATION: require `h.includes("market")` -> marketValueLakhs all null.
    // MUTATION: require industry AND rating   -> industry all null.
    const sheet = parseAmcPortfolioWorkbook(workbook(tataSheet("31-08-26")))!
      .sheets[0]!;
    assert.deepEqual(
      sheet.holdings.map((h) => h.marketValueLakhs),
      [81133.2, 55938.96, 42143.27],
    );
    assert.deepEqual(
      sheet.holdings.map((h) => h.industry),
      ["Banks", "Finance", "Consumable Fuels"],
    );
    assert.deepEqual(
      sheet.holdings.map((h) => h.pctToNav),
      [9.37, 6.46, 4.87],
    );
  });

  it("the as-on date is read from Tata's two-digit year", () => {
    // Without this the sheet parses and D1's gate refuses every one of them as
    // NO_AS_ON — the two fixes are only worth anything together. Exactly the
    // "two individually-correct fixes that cancel" shape.
    const sheet = parseAmcPortfolioWorkbook(workbook(tataSheet("31-08-26")))!
      .sheets[0]!;
    assert.equal(sheet.asOfDate, "2026-08-31");
  });
});

describe("the loosened column rules do not over-match either", () => {
  it("`rating` is word-bounded — `Operating Expense` is not a rating column", () => {
    // `includes("rating")` matches "operating". An `Operating Expense` column
    // would claim `industryRating`, classify its values as industries, and
    // leave the real `Industry` column unmapped — trap 4 through the back door.
    // MUTATION: `includes("rating")` -> the Operating header wins and the
    // industries come back null, RED.
    const rows = tataSheet("31-08-26");
    rows[6] = [
      null,
      "NAME OF THE INSTRUMENT",
      "Operating Expense",
      "INDUSTRY",
      "ISIN CODE",
      "QUANTITY",
      "MKT VAL(Rs. Lacs)",
      "% to NAV",
    ];
    // The rows carry the industry in the column the header names INDUSTRY.
    const sheet = parseAmcPortfolioWorkbook(workbook(rows))!.sheets[0]!;
    assert.deepEqual(
      sheet.holdings.map((h) => h.industry),
      ["Banks", "Finance", "Consumable Fuels"],
      "the INDUSTRY column must win over a column merely containing 'rating'",
    );
  });

  it("a percent column is never bound as the MONEY column", () => {
    // `% of Market Value to Net Assets` satisfies (market && value) and is NOT
    // caught by the percent rule first, because that rule requires `% to …`
    // and this is `% of …`. Binding it writes a PERCENTAGE into
    // marketValueLakhs, and the unit cross-check cannot see it: `totalAumLakhs`
    // is read from the same mis-bound column, so the ratio lands near 1.
    // MUTATION: drop `!h.includes("%")` -> marketValueLakhs takes the percents,
    // RED.
    const rows = tataSheet("31-08-26");
    rows[6] = [
      null,
      "NAME OF THE INSTRUMENT",
      "YIELD ( IN % )",
      "INDUSTRY",
      "ISIN CODE",
      "QUANTITY",
      "% of Market Value to Net Assets",
      "% to NAV",
    ];
    const sheet = parseAmcPortfolioWorkbook(workbook(rows))!.sheets[0]!;
    assert.deepEqual(
      sheet.holdings.map((h) => h.marketValueLakhs),
      [null, null, null],
      "a header carrying '%' must not be read as the money column",
    );
    // …and the real percent column is still read.
    assert.deepEqual(
      sheet.holdings.map((h) => h.pctToNav),
      [9.37, 6.46, 4.87],
    );
  });

  it("ONE qualifier word, because two is a sentence", () => {
    // The bound was {0,2} and that admitted prose — one word away from the
    // example its own comment named as the hazard. These sheets carry note
    // blocks above the table, and `findHeaderRow` fixes on the FIRST row with
    // both an ISIN-word cell and a percent match.
    // MUTATION: restore {0,2} -> the three prose cases go true, RED.
    assert.ok(isPercentHeader("% to NAV"));
    assert.ok(isPercentHeader("Rounded % to Net Assets"));
    assert.equal(isPercentHeader("Figures are % to NAV"), false);
    assert.equal(isPercentHeader("All are % to NAV"), false);
    assert.equal(isPercentHeader("Weights shown % to Net Assets"), false);
    assert.equal(isPercentHeader("All figures are % to NAV"), false);
  });
});

describe("the loosened ISIN header does not over-match", () => {
  it("prose containing the letters `isin` is not an ISIN header", () => {
    // The reason the rule is `\bisin\b` and not `includes("isin")`: `revising`
    // and `raising` both contain those four letters, and a scheme objective
    // paragraph is full of prose. A substring rule would fix the header row on
    // a sentence eight rows above the real table.
    // MUTATION: `/isin/i` -> this goes RED (the prose row is chosen).
    const rows = tataSheet("31-08-26");
    rows.splice(4, 0, [
      null,
      "The scheme is revising its allocation, raising equity exposure",
      "% to NAV",
    ]);
    const sheet = parseAmcPortfolioWorkbook(workbook(rows))!.sheets[0]!;
    assert.equal(sheet.holdings.length, 3, "the real header row must still win");
  });

  it("the exact spelling every other AMC uses still works", () => {
    const rows = tataSheet("31-08-26");
    rows[6] = [
      null,
      "Name of the Instrument",
      "Yield",
      "Industry^ / Rating",
      "ISIN",
      "Quantity",
      "Market value (Rs. in Lakhs)",
      "% to NAV",
    ];
    const sheet = parseAmcPortfolioWorkbook(workbook(rows))!.sheets[0]!;
    assert.equal(sheet.holdings.length, 3);
    assert.equal(sheet.holdings[0]!.isin, "INE090A01021");
  });
});

/**
 * 360 ONE's sheet shape, from the live August-2026 workbook.
 *
 * Its header is the same vocabulary every other house uses EXCEPT for the
 * qualifier on the percent column, which is the whole point: one word in front
 * of `% to Net Assets` cost this AMC every row it has ever published.
 */
function threeSixtyOneSheet(): unknown[][] {
  return [
    ["360 ONE Liquid Fund - An open ended liquid scheme."],
    ["Monthly Portfolio Statement as on August 31,2026"],
    [
      "Name of the Instrument",
      "ISIN",
      "Rating",
      "Quantity",
      "Market/Fair Value(Rs. in Lacs)",
      "Rounded % to Net Assets",
      "YTM",
      "~YTC (AT1/Tier 2 bonds)",
    ],
    ["Debt Instruments"],
    ["(a) Listed / awaiting listing on Stock Exchange"],
    ["7.41% Indian Railway Finance Corporation Limited (15/10/2026) **", "INE053F08312", "CRISIL AAA", 2500000, 2502.175, 60.5, 0.064996],
    ["7.98% Sundaram Home Finance Limited (04/09/2026) **", "INE667F07IT7", "ICRA AAA", 500000, 500.0485, 39.5, 0.0631],
  ];
}

describe("MONEY-1405 — 360 ONE's qualified percent header", () => {
  it("`Rounded % to Net Assets` is the percent column", () => {
    // MUTATION: restore `/^%\s*to\s*(nav|aum|net\s*assets)\b/i` -> 0 sheets, RED.
    // That anchor dropped all 12 of this house's sheets on every run.
    const parsed = parseAmcPortfolioWorkbook(
      workbook(threeSixtyOneSheet(), "Liquid Fund"),
    );
    assert.ok(parsed, "the workbook must parse");
    assert.equal(parsed.sheets.length, 1);
    assert.deepEqual(
      parsed.sheets[0]!.holdings.map((h) => h.pctToNav),
      [60.5, 39.5],
      "the weights must be READ, not merely the header recognised",
    );
  });

  it("a qualifier is admitted; a SENTENCE is still refused", () => {
    // The bound is what keeps this from becoming an unanchored match. These
    // workbooks are full of footnote prose, and `findHeaderRow` fixes the
    // header row on the FIRST row that matches both signals.
    // MUTATION: drop the `{0,2}` bound -> the last case goes true, RED.
    assert.ok(isPercentHeader("% to NAV"));
    assert.ok(isPercentHeader("Rounded % to Net Assets"));
    assert.ok(isPercentHeader("Rounded % to NAV"));
    assert.equal(isPercentHeader("All figures are % to NAV"), false);
  });

  it("the neighbouring columns stay out — and never needed the anchor", () => {
    // `YTM %` and `YTC % ##` are refused by the REQUIRED `to (nav|aum|net
    // assets)` phrase, not by the anchor. Worth pinning because the anchor
    // LOOKED like the guard, which is why it survived two AMCs.
    for (const no of ["YTM %", "YTC % ##", "Quantity", "ISIN", "Yield", ""]) {
      assert.equal(isPercentHeader(no), false, no);
    }
  });
});

/**
 * Zerodha's sheet: the period is stated with a different preposition and no day.
 *
 * Row 2 is the whole finding. There is no `as on` anywhere in the file.
 */
function zerodhaSheet(title: string): unknown[][] {
  return [
    ["ZERODHA MUTUAL FUND"],
    [title],
    [
      "Name of the Instrument",
      "ISIN",
      "Rating / Industry^",
      "Quantity",
      "Market value\n(Rs. in Lakhs)",
      "% to NAV",
      "YTM %",
    ],
    ["EQUITY & EQUITY RELATED"],
    ["a) Listed/awaiting listing on Stock Exchanges"],
    ["HDFC Bank Limited", "INE040A01034", "Banks", 29250, 207.38, 60.0],
    ["Axis Bank Limited", "INE238A01034", "Banks", 8750, 113.75, 40.0],
  ];
}

describe("MONEY-1405 — a period stated as a MONTH, with no day", () => {
  it("THE REGRESSION: Zerodha's sheets get an as-on at all", () => {
    // This one would have been a REGRESSION rather than a standing bug.
    // Zerodha writes 2,256 rows on prod today; D1's new gate refuses any sheet
    // with `asOfDate === null` as NO_AS_ON, so shipping that gate without this
    // would have taken a working house to zero — silently, because a refusal
    // reports as a healthy `selected>0 written=0`.
    //
    // MUTATION: drop `\bfor\b` from AS_ON_LABEL -> asOfDate null, RED.
    // MUTATION: delete the MONTH_YEAR_PERIOD branch -> asOfDate null, RED.
    const sheet = parseAmcPortfolioWorkbook(
      workbook(
        zerodhaSheet(
          "MONTHLY PORTFOLIO STATEMENT OF ZERODHA ARBITRAGE FUND FOR AUGUST 2026",
        ),
        "ZARBI",
      ),
    )!.sheets[0]!;
    assert.equal(sheet.asOfDate, "2026-08-31");
  });

  it("THE PROD BUG: every Zerodha scheme gets its OWN name", () => {
    // Measured on prod 2026-09-13: `mf_portfolio_holdings` held **1,072
    // ZERODHA rows under exactly ONE schemeKey** (`zerodha-mutual-fund`),
    // where SBI has 135 distinct keys, DSP 88 and Helios 12. Every one of
    // Zerodha's ~22 schemes upserted into one pseudo-fund on
    // `(period, amc, schemeKey, instrumentName)`, so each sheet overwrote the
    // last and the survivor was whichever parsed final.
    //
    // The cause is `firstRowName` taking the FIRST row with any >= 8-char
    // candidate — and Zerodha's row 0 is the AMC NAME. It is NOT the as-on
    // skip: it reproduces with the `for` arm removed from AS_ON_LABEL.
    //
    // TWO mutations, and the second is the one that matters:
    //   MUT: delete PORTFOLIO_STATEMENT_OF        -> both collapse, RED.
    //   MUT: `labelled ??=` back to `bestInRow =` -> both collapse, RED,
    //        because extracting the right name one row later cannot win a race
    //        `firstRowName` already decided.
    const names = ["ZERODHA ARBITRAGE FUND", "ZERODHA NIFTY LARGEMIDCAP 250 INDEX FUND"].map(
      (scheme) =>
        parseAmcPortfolioWorkbook(
          workbook(zerodhaSheet(`MONTHLY PORTFOLIO STATEMENT OF ${scheme} FOR AUGUST 2026`), "ZARBI"),
        )!.sheets[0]!.schemeName,
    );
    assert.deepEqual(names, [
      "ZERODHA ARBITRAGE FUND",
      "ZERODHA NIFTY LARGEMIDCAP 250 INDEX FUND",
    ]);
    assert.notEqual(names[0], names[1], "two schemes must not share one name");
  });

  it("the AMC name on row 0 never wins over an identified scheme", () => {
    // The generic candidate must lose to the positively-identified one no
    // matter how the rows are ordered — that is the whole precedence fix.
    const sheet = parseAmcPortfolioWorkbook(
      workbook(
        zerodhaSheet("MONTHLY PORTFOLIO STATEMENT OF ZERODHA GOLD ETF FOR AUGUST 2026"),
        "ZGOLD",
      ),
    )!.sheets[0]!;
    assert.equal(sheet.schemeName, "ZERODHA GOLD ETF");
    assert.notEqual(sheet.schemeName, "ZERODHA MUTUAL FUND");
  });

  it("the month tail is required, so the period never lands in the name", () => {
    // Without the `for <Month> <Year>` tail the capture is unbounded and would
    // swallow the period — keying the same scheme differently every month,
    // which looks like new funds appearing rather than one fund missing.
    // MUTATION: drop the tail from PORTFOLIO_STATEMENT_OF -> the name grows a
    // month and this goes RED.
    const sheet = parseAmcPortfolioWorkbook(
      workbook(
        zerodhaSheet("MONTHLY PORTFOLIO STATEMENT OF ZERODHA ARBITRAGE FUND FOR AUGUST 2026"),
        "ZARBI",
      ),
    )!.sheets[0]!;
    assert.doesNotMatch(String(sheet.schemeName), /august|2026/i);
  });

  it("the day is the REAL month end, including a leap February", () => {
    // The day never reaches the database — `judgeSheetWrite` reads
    // `slice(0, 7)` and a log line prints it — but it sits beside twelve
    // houses that all state a real month end, so it should not read as a
    // different claim. MUTATION: hardcode 31 -> the February cases go RED.
    assert.equal(parseMonthPeriod("for February 2026"), "2026-02-28");
    assert.equal(parseMonthPeriod("for February 2024"), "2024-02-29");
    assert.equal(parseMonthPeriod("for April 2026"), "2026-04-30");
    assert.equal(parseMonthPeriod("for August 2026"), "2026-08-31");
  });

  it("a `for` in PROSE cannot supply a precise date from the wrong row", () => {
    // The regression the `for` cue introduced, and the reason the passes are
    // split by CUE and not only by precision. Both of these are real shapes,
    // and the scan is row-major, so before the split the sentence ABOVE the
    // as-on line won:
    //
    //   "…prepared for the period ended 31-Mar-2026"  -> 2026-03-31
    //   "Fund open for subscription since 01-Apr-2013" -> 2013-04-01
    //
    // A wrong date here is not cosmetic any more: `judgeSheetWrite` refuses the
    // sheet and `judgeAmcAttempt` reports STALE_FILE, which sends an operator
    // to the SCHEDULE or the URL — the wrong subsystem entirely.
    //
    // MUTATION: pass 1 back to `scan(parseAsOfDate, AS_ON_LABEL)` -> both RED.
    for (const prose of [
      "This statement has been prepared for the period ended 31-Mar-2026",
      "Fund open for subscription since 01-Apr-2013",
      "Units allotted for the offer closing 15-Jun-2020",
    ]) {
      assert.equal(
        extractAsOnDate([[prose], ["Portfolio as on 31-Aug-2026"]]),
        "2026-08-31",
        prose,
      );
    }
  });

  it("the loose cue still earns a MONTH — Zerodha keeps working", () => {
    // Pass 3 exists for exactly one house. It cannot make pass 1's mistake,
    // because parseMonthPeriod reads a month NAME beside a four-digit year and
    // never a hyphenated `31-Mar-2026`.
    assert.equal(
      extractAsOnDate([
        ["ZERODHA MUTUAL FUND"],
        ["MONTHLY PORTFOLIO STATEMENT OF ZERODHA ARBITRAGE FUND FOR AUGUST 2026"],
      ]),
      "2026-08-31",
    );
    // …and a `for`-cued sentence with a hyphenated date earns nothing at all.
    assert.equal(
      extractAsOnDate([["prepared for the period ended 31-Mar-2026"]]),
      null,
    );
  });

  it("a PRECISE date still wins over a month-only title", () => {
    // The PRECISE pass runs over every row before the month-only pass runs at
    // all, so the dated line wins even though the title sits ABOVE it — which
    // is the case a single ordered scan gets wrong.
    // MUTATION: collapse to one pass -> returns the title's month, RED.
    const rows = zerodhaSheet("PORTFOLIO FOR AUGUST 2026");
    rows.splice(2, 0, ["Portfolio as on 15-Aug-2026"]);
    const sheet = parseAmcPortfolioWorkbook(workbook(rows, "ZARBI"))!.sheets[0]!;
    assert.equal(sheet.asOfDate, "2026-08-15");
  });

  it("`for` with no date beside it matches nothing", () => {
    // The cue alone is never enough — this is what bounds the loosest word in
    // AS_ON_LABEL. MUTATION: return a date on a bare cue -> RED.
    assert.equal(parseMonthPeriod("for the reasons set out below"), null);
    assert.equal(parseAsOfDate("for the reasons set out below"), null);
    const sheet = parseAmcPortfolioWorkbook(
      workbook(zerodhaSheet("MONTHLY PORTFOLIO STATEMENT FOR THE SCHEME"), "ZARBI"),
    )!.sheets[0]!;
    assert.equal(sheet.asOfDate, null);
  });

  it("a word that merely STARTS with a month name is not a month", () => {
    // The first cut of MONTH_YEAR_PERIOD was `(jan|feb|mar|…)[a-z]*`, which
    // matched any word beginning with an abbreviation: `marketing` read as
    // March, `Junk` as June, `septembers` as September. It matters because the
    // cue this pattern sits behind is `for` — the loosest word in AS_ON_LABEL —
    // and these sheets are full of prose. The failure is not a parse error
    // anyone would see: it yields a confident WRONG period, and the sheet gate
    // then refuses a perfectly good month as STALE_FILE.
    //
    // MUTATION: restore the `[a-z]*` prefix form -> all three go RED.
    assert.equal(parseMonthPeriod("for marketing 2026"), null);
    assert.equal(parseMonthPeriod("for Junk 2026"), null);
    assert.equal(parseMonthPeriod("for septembers 2026"), null);

    // Both real short forms still work — AMFI houses publish each, and Zerodha
    // ships `Sep` and `Sept` for the same month.
    assert.equal(parseMonthPeriod("for Sep 2026"), "2026-09-30");
    assert.equal(parseMonthPeriod("for Sept 2026"), "2026-09-30");
    assert.equal(parseMonthPeriod("for September 2026"), "2026-09-30");
  });

  it("a bare month, and an out-of-range year, are both refused", () => {
    // These two are refused by DIFFERENT things and the distinction is why
    // both are here. `for August` never matches the pattern at all (it
    // requires four year digits); `August 1850` matches and is rejected by the
    // year bound. Asserting only the first left that bound untested — the
    // mutation that widened it came back GREEN.
    // MUTATION: drop `year < 1990 || year > 2100` -> the 1850 case goes RED.
    assert.equal(parseMonthPeriod("for August"), null);
    assert.equal(parseMonthPeriod("for August 1850"), null);
    assert.equal(parseMonthPeriod("for August 2199"), null);
  });
});

describe("parseAsOfDate — the two-digit year (MONEY-1405)", () => {
  it("reads Tata's `31-08-26` day-first into 2026", () => {
    // MUTATION: delete the DATE_NUMERIC_DMY_SHORT branch -> null, RED.
    assert.equal(parseAsOfDate("Portfolio as on 31-08-26"), "2026-08-31");
    assert.equal(parseAsOfDate("31/08/26"), "2026-08-31");
    assert.equal(parseAsOfDate("31.08.26"), "2026-08-31");
  });

  it("the four-digit form is untouched and still wins", () => {
    // The short pattern must not be able to steal from the long one. Against
    // `31-08-2026` its year group finds no word boundary inside `2026`, and the
    // four-digit branch returns first regardless.
    assert.equal(parseAsOfDate("31-08-2026"), "2026-08-31");
    assert.equal(parseAsOfDate("31-Jul-2026"), "2026-07-31");
    assert.equal(parseAsOfDate("July 31, 2026"), "2026-07-31");
  });

  it("day/month disambiguation is shared with the four-digit form", () => {
    // `07-31-26` can only be M/D; `31-07-26` can only be D/M; both land on the
    // same day, which is the property that makes the short form safe to add.
    assert.equal(parseAsOfDate("07-31-26"), "2026-07-31");
    assert.equal(parseAsOfDate("31-07-26"), "2026-07-31");
  });

  it("an impossible date is still null, not coerced", () => {
    assert.equal(parseAsOfDate("45-99-26"), null);
  });
});
