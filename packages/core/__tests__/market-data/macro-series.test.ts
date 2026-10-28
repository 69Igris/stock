/**
 * UNIT TEST — official macro series parsing + registry (MONEY-1106, P8b).
 *
 * The load-bearing cases, in order of what they protect:
 *
 *   1. **A failure and an empty result are different values.** A page with no
 *      table returns `null`; a page that parses and matches nothing returns
 *      `{rows: []}`. MONEY-1189 B2 is the whole reason: two fetchers that
 *      returned `[]` for both "asked, never answered" and "answered, nothing
 *      there" hid 37 failed windows behind a `DONE` line.
 *   2. **Colspan-driven year mapping.** RBI writes `2025 | 2026(colspan 5)`
 *      above six dates and leaves continuation years BLANK. Read positionally,
 *      the year-ago column silently becomes a current-year one — a wrong date on
 *      correct-looking data, which nothing downstream can detect.
 *   3. **Non-finite guarding at the parse boundary.** `Base Rate` is published
 *      as the range `"8.40/10.00"`. `Number()` on that is NaN, and NaN is the
 *      money-poison class this codebase keeps paying for.
 *   4. **Registry invariants.** Every label key must already BE normalised —
 *      the first draft of this file shipped `"91-day treasury bill primary
 *      yield"` as a key while `normaliseMacroLabel` strips `(Primary)` and
 *      produces `"91-day treasury bill yield"`. That series would have been
 *      silently absent forever with no error anywhere.
 *
 * The HTML fixtures are hand-built, but not invented: each reproduces the exact
 * cell/colspan layout dumped from the live pages on 2026-08-13, including the
 * stacked fortnight+week blocks on `param=4` and the trailing variation columns
 * on `param=15`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MACRO_SOURCES,
  expandCells,
  extractNsdpRows,
  judgeMacroFreshness,
  macroSourceById,
  normaliseMacroLabel,
  parseAsOnDate,
  parseMacroNumber,
  parseMacroSource,
  parseNsdpAsOnTable,
  parseNsdpPeriodTable,
  parseNsdpReleaseDate,
  selectMacroSources,
  type MacroSource,
} from "../../src/market-data/macro-series";
import {
  feedShapeFor,
  validateFeedPayload,
} from "../../src/market-data/feed-payload";

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const at = (s: string): Date => new Date(`${s}T00:00:00Z`);

const source = (id: string): MacroSource => {
  const s = macroSourceById(id);
  // An explicit throw rather than `assert.ok(s)` + narrowing: TypeScript's
  // assertion-function narrowing needs every name in the call target to carry
  // an explicit type annotation, which an imported `assert` does not reliably
  // satisfy across configs.
  if (!s) throw new Error(`missing source ${id}`);
  return s;
};

// ─── Fixtures: the real layouts, minus the 100 KB of site chrome ─────

/** Build a `<tr>` from `[text, colspan]` pairs. */
function tr(cells: Array<[string, number?]>): string {
  return (
    "<tr>" +
    cells
      .map(([t, span]) =>
        span && span > 1 ? `<td colspan="${span}">${t}</td>` : `<td>${t}</td>`,
      )
      .join("") +
    "</tr>"
  );
}

function page(rows: string[]): string {
  return `<html><body><table class="tablebg">${rows.join("")}</table></body></html>`;
}

/**
 * `param=4` — TWO stacked blocks exactly as dumped on 2026-08-13:
 * a fortnight-ended block whose every cell spans 2 (and whose trailing year
 * cell is BLANK), then the week-ended block.
 */
const RATES_HTML = page([
  tr([["Date : Aug 07, 2026"]]),
  tr([["Cash Reserve Ratio and Interest Rates"]]),
  // Fortnight header: 2025(x2) | 2026(x2) | ''(x2)  → the blank forward-fills.
  tr([["Item/Fortnight Ended#"], ["2025", 2], ["2026", 2], ["", 2]]),
  tr([
    ["Jul. 11", 2],
    ["Jun. 30", 2],
    ["Jul. 15", 2],
  ]),
  tr([
    ["1", 2],
    ["2", 2],
    ["3", 2],
  ]),
  tr([["Cash-Deposit Ratio"], ["4.35", 2], ["3.28", 2], ["3.18", 2]]),
  // Week header: one year-ago column then five current-year ones.
  tr([["Item/Week Ended"], ["2025"], ["2026", 5]]),
  tr([
    ["Aug. 01"],
    ["Jul. 03"],
    ["Jul. 10"],
    ["Jul. 17"],
    ["Jul. 24"],
    ["Jul. 31"],
  ]),
  tr([["1"], ["2"], ["3"], ["4"], ["5"], ["6"]]),
  tr([["Ratios"], [""], [""], [""], [""], [""], [""]]),
  tr([
    ["Cash Reserve Ratio"],
    ["4.00"],
    ["3.00"],
    ["3.00"],
    ["3.00"],
    ["3.00"],
    ["3.00"],
  ]),
  tr([
    ["Statutory Liquidity Ratio"],
    ["18.00"],
    ["18.00"],
    ["18.00"],
    ["18.00"],
    ["18.00"],
    ["18.00"],
  ]),
  tr([
    ["Policy Repo Rate"],
    ["5.50"],
    ["5.25"],
    ["5.25"],
    ["5.25"],
    ["5.25"],
    ["5.25"],
  ]),
  tr([
    ["Standing Deposit Facility (SDF) Rate *"],
    ["5.25"],
    ["5.00"],
    ["5.00"],
    ["5.00"],
    ["5.00"],
    ["5.00"],
  ]),
  // Published as a RANGE across banks — must yield NOTHING, never NaN.
  tr([
    ["Base Rate"],
    ["8.50/10.30"],
    ["8.40/10.00"],
    ["8.40/10.00"],
    ["8.40/10.00"],
    ["8.40/10.00"],
    ["8.40/10.00"],
  ]),
  tr([
    ["Call Money Rate (Weighted Average)"],
    ["5.41"],
    ["5.31"],
    ["5.29"],
    ["5.30"],
    ["5.28"],
    ["5.30"],
  ]),
  tr([
    ["91-Day Treasury Bill (Primary) Yield"],
    ["5.40"],
    ["5.25"],
    ["5.30"],
    ["5.33"],
    ["5.35"],
    ["5.34"],
  ]),
  // A MAPPED series carrying two of RBI's absence markers. This is the row that
  // exercises `skipped`: an unmapped row (Base Rate) is filtered by LABEL and
  // its cells are never read, so it can never contribute to that counter.
  tr([
    ["Savings Deposit Rate"],
    ["2.50"],
    ["–"],
    ["2.50"],
    [".."],
    ["2.50"],
    ["2.50"],
  ]),
]);

/** `param=15` — monthly columns followed by three VARIATION columns. */
const PRICES_HTML = page([
  tr([["Date : Aug 07, 2026"]]),
  tr([
    ["Item"],
    ["2025"],
    ["2026", 2],
    ["Percentage Variation of Current Month", 3],
  ]),
  tr([
    ["Jun."],
    ["May"],
    ["Jun."],
    ["Over Previous Month"],
    ["Over March"],
    ["Year-on-Year"],
  ]),
  tr([["1"], ["2"], ["3"], ["4"], ["5"], ["6"]]),
  tr([
    ["1 Consumer Price Index (2024=100)"],
    ["102.5"],
    ["105.9"],
    ["107.0"],
    ["1.0"],
    ["2.1"],
    ["4.4"],
  ]),
  tr([
    ["1.1 Rural"],
    ["102.4"],
    ["106.1"],
    ["107.2"],
    ["1.1"],
    ["2.1"],
    ["4.7"],
  ]),
  tr([
    ["3 Wholesale Price Index (2022-23=100)"],
    ["100.3"],
    ["109.9"],
    ["110.2"],
    ["0.3"],
    ["5.4"],
    ["9.9"],
  ]),
  tr([
    ["3.2 Fuel and Power"],
    ["87.2"],
    ["113.0"],
    ["111.1"],
    ["-1.7"],
    ["18.8"],
    ["27.4"],
  ]),
]);

/** `param=2` — one "As on" snapshot, then six variation columns. */
const FOREX_HTML = page([
  tr([["Date : Aug 07, 2026"]]),
  tr([["Foreign Exchange Reserves"]]),
  tr([["Item"], ["As on Jul. 31, 2026", 2], ["Variation over", 6]]),
  tr([
    ["Week", 2],
    ["End-March 2026", 2],
    ["Year", 2],
  ]),
  tr([
    ["₹ Cr."],
    ["US$ Mn."],
    ["₹ Cr."],
    ["US$ Mn."],
    ["₹ Cr."],
    ["US$ Mn."],
    ["₹ Cr."],
    ["US$ Mn."],
  ]),
  tr([
    ["1 Total Reserves"],
    ["6612148"],
    ["692866"],
    ["24233"],
    ["10512"],
    ["58287"],
    ["1758"],
    ["581731"],
    ["3995"],
  ]),
  tr([
    ["1.2 Gold"],
    ["999586"],
    ["104743"],
    ["4597"],
    ["1685"],
    ["-94724"],
    ["-10653"],
    ["264249"],
    ["20745"],
  ]),
]);

// ─── parseMacroNumber ────────────────────────────────────────────────

describe("parseMacroNumber — the non-finite boundary (MONEY-1106)", () => {
  it("accepts plain decimals, negatives and thousands separators", () => {
    assert.equal(parseMacroNumber("5.25"), 5.25);
    assert.equal(parseMacroNumber("18.00"), 18);
    assert.equal(parseMacroNumber("-1.7"), -1.7);
    assert.equal(parseMacroNumber("6,612,148"), 6612148);
    assert.equal(parseMacroNumber(" 692866 "), 692866);
  });

  it("REJECTS a published bank range rather than producing NaN", () => {
    // The live `Base Rate` / `MCLR` / `Term Deposit Rate` cells. Number() on
    // these is NaN, which must never reach a Float column.
    for (const range of [
      "8.50/10.30",
      "8.40/10.00",
      "7.80/8.00",
      "6.00/6.75",
    ]) {
      assert.equal(parseMacroNumber(range), null, range);
    }
  });

  it("rejects RBI's several spellings of absence", () => {
    for (const absent of ["", "  ", "-", "–", "—", "..", "N.A.", "na", "Nil"]) {
      assert.equal(parseMacroNumber(absent), null, JSON.stringify(absent));
    }
  });

  it("rejects anything that is not a plain signed decimal", () => {
    // "1e400" is the sharp one: Number("1e400") is Infinity, and an Infinity in
    // a money/index column is the same poison as a NaN.
    for (const bad of [
      "1e400",
      "Infinity",
      "-Infinity",
      "NaN",
      "5.2.3",
      "12%",
      "abc",
    ]) {
      assert.equal(parseMacroNumber(bad), null, bad);
    }
  });

  it("every accepted value is finite", () => {
    for (const raw of ["0", "0.0", "-0.5", "999999999", "5.25"]) {
      const v = parseMacroNumber(raw);
      assert.ok(v !== null && Number.isFinite(v), raw);
    }
  });
});

// ─── normaliseMacroLabel ─────────────────────────────────────────────

describe("normaliseMacroLabel", () => {
  it("strips outline numbers, footnote marks and parentheticals", () => {
    const cases: Array<[string, string]> = [
      ["Cash Reserve Ratio", "cash reserve ratio"],
      [
        "Standing Deposit Facility (SDF) Rate *",
        "standing deposit facility rate",
      ],
      ["Call Money Rate (Weighted Average)", "call money rate"],
      ["91-Day Treasury Bill (Primary) Yield", "91-day treasury bill yield"],
      ["10-Year G-Sec Par Yield (FBIL)", "10-year g-sec par yield"],
      ["1 Consumer Price Index (2024=100)", "consumer price index"],
      [
        "2 Consumer Price Index for Industrial Workers (2016=100)",
        "consumer price index for industrial workers",
      ],
      ["3 Wholesale Price Index (2022-23=100)", "wholesale price index"],
      ["3.2 Fuel and Power", "fuel and power"],
      ["1.1 Foreign Currency Assets #", "foreign currency assets"],
      ["1.4 Reserve Position in the IMF", "reserve position in the imf"],
      ["1.3 SDRs", "sdrs"],
    ];
    for (const [raw, want] of cases) {
      assert.equal(normaliseMacroLabel(raw), want, raw);
    }
  });

  it("a rebase does not change the key — the series survives it", () => {
    // The whole reason base-year parentheticals are stripped: when MOSPI
    // rebases CPI, the label changes and a literal match would go dark with no
    // error. The raw label is kept on every observation so the resulting level
    // DISCONTINUITY is still discoverable.
    assert.equal(
      normaliseMacroLabel("1 Consumer Price Index (2024=100)"),
      normaliseMacroLabel("1 Consumer Price Index (2030=100)"),
    );
    assert.equal(
      normaliseMacroLabel("3 Wholesale Price Index (2022-23=100)"),
      normaliseMacroLabel("3 Wholesale Price Index (2011-12=100)"),
    );
  });

  it("is idempotent", () => {
    for (const raw of [
      "1 Consumer Price Index (2024=100)",
      "Bank Rate",
      "1.1 Rural",
    ]) {
      const once = normaliseMacroLabel(raw);
      assert.equal(normaliseMacroLabel(once), once, raw);
    }
  });
});

// ─── Cell/colspan mechanics ──────────────────────────────────────────

describe("expandCells / extractNsdpRows", () => {
  it("repeats a spanned cell once per grid column", () => {
    assert.deepEqual(
      expandCells([
        { text: "2025", span: 1 },
        { text: "2026", span: 5 },
      ]),
      ["2025", "2026", "2026", "2026", "2026", "2026"],
    );
  });

  it("treats a zero/absurd colspan as 1 rather than deleting a column", () => {
    const rows = extractNsdpRows(
      '<table class="tablebg"><tr><td colspan="0">a</td><td colspan="999">b</td></tr></table>',
    );
    assert.ok(rows);
    assert.deepEqual(expandCells(rows[0]!), ["a", "b"]);
  });

  it("returns NULL when the data-table marker is absent", () => {
    assert.equal(
      extractNsdpRows("<html><body><p>nothing</p></body></html>"),
      null,
    );
    // A page that has tables but not THIS table is still a structural failure.
    assert.equal(extractNsdpRows("<table><tr><td>x</td></tr></table>"), null);
  });

  it("reads the release stamp", () => {
    assert.equal(iso(parseNsdpReleaseDate(RATES_HTML)!), "2026-08-07");
    assert.equal(parseNsdpReleaseDate("<p>no date here</p>"), null);
  });
});

// ─── Layout A: period columns ────────────────────────────────────────

describe("parseNsdpPeriodTable — rates (param=4)", () => {
  const result = parseNsdpPeriodTable(source("rbi-nsdp-rates"), RATES_HTML);

  it("parses", () => {
    assert.ok(result, "expected a result, not null");
  });

  it("maps the year-ago column to LAST year, not this one", () => {
    // The single most damaging silent failure available here: `Aug. 01` sits
    // under a `2025` header with colspan 1, and `Jul. 03`..`Jul. 31` under
    // `2026` with colspan 5.
    const repo = result!.rows.filter((r) => r.seriesId === "RBI_REPO_RATE");
    assert.deepEqual(
      repo.map((r) => `${iso(r.period)}=${r.value}`),
      [
        "2025-08-01=5.5",
        "2026-07-03=5.25",
        "2026-07-10=5.25",
        "2026-07-17=5.25",
        "2026-07-24=5.25",
        "2026-07-31=5.25",
      ],
    );
  });

  it("stamps WEEKLY observations on the period-END date, verbatim", () => {
    const crr = result!.rows.filter((r) => r.seriesId === "RBI_CRR");
    assert.equal(crr.length, 6);
    assert.equal(iso(crr.at(-1)!.period), "2026-07-31");
    assert.equal(crr.at(-1)!.value, 3);
    assert.equal(crr[0]!.frequency, "WEEKLY");
    assert.equal(crr[0]!.unit, "PERCENT");
    assert.equal(crr[0]!.source, "rbi-nsdp-rates");
  });

  it("keeps the raw label on every row", () => {
    const sdf = result!.rows.find((r) => r.seriesId === "RBI_SDF_RATE");
    assert.equal(sdf!.label, "Standing Deposit Facility (SDF) Rate *");
  });

  it("emits NOTHING for the range-published Base Rate", () => {
    // It is filtered by LABEL (it is not in the registry), so it shows up as
    // `unmapped` rather than `skipped` — the row's cells are never read at all.
    // Recording which counter it lands in matters: `skipped` means "a series we
    // track had an unusable value", and conflating that with "a row we ignore"
    // would make the counter useless for spotting a real upstream change.
    assert.equal(
      result!.rows.some((r) => r.label === "Base Rate"),
      false,
    );
    assert.ok(result!.unmapped.includes("Base Rate"));
  });

  it("counts absence markers inside a MAPPED row as skipped", () => {
    // Savings Deposit Rate carries "–" and ".." in the fixture. Both are
    // rejected by parseMacroNumber, so that series yields 4 of 6 columns and
    // the two rejections are visible rather than silently dropped.
    const savings = result!.rows.filter(
      (r) => r.seriesId === "RBI_SAVINGS_DEPOSIT_RATE",
    );
    assert.equal(savings.length, 4);
    assert.equal(result!.skipped, 2);
  });

  it("ignores the stacked FORTNIGHT block entirely", () => {
    // `Cash-Deposit Ratio` is a fortnightly banking ratio living above the week
    // block. It is unmapped, so no observation may carry its label — and the
    // parser must not have mistaken its dates for the weekly ones.
    assert.equal(
      result!.rows.some((r) => r.label.includes("Cash-Deposit")),
      false,
    );
    assert.ok(result!.unmapped.includes("Cash-Deposit Ratio"));
  });

  it("resolves the T-bill label through the stripped (Primary)", () => {
    // Guards the exact registry bug this ticket shipped-then-caught: a key
    // written as "…treasury bill primary yield" matches nothing.
    const tbill = result!.rows.filter(
      (r) => r.seriesId === "RBI_TBILL_91D_YIELD",
    );
    assert.equal(tbill.length, 6);
    assert.equal(tbill.at(-1)!.value, 5.34);
  });

  it("never emits the same (series, period) twice", () => {
    const keys = result!.rows.map((r) => `${r.seriesId}|${r.period.getTime()}`);
    assert.equal(new Set(keys).size, keys.length);
  });
});

describe("parseNsdpPeriodTable — prices (param=15)", () => {
  const result = parseNsdpPeriodTable(source("rbi-nsdp-prices"), PRICES_HTML);

  it("anchors MONTHLY observations at the first of the month", () => {
    const cpi = result!.rows.filter((r) => r.seriesId === "MOSPI_CPI_COMBINED");
    assert.deepEqual(
      cpi.map((r) => `${iso(r.period)}=${r.value}`),
      ["2025-06-01=102.5", "2026-05-01=105.9", "2026-06-01=107"],
    );
    assert.equal(cpi[0]!.frequency, "MONTHLY");
    assert.equal(cpi[0]!.unit, "INDEX");
  });

  it("EXCLUDES the percentage-variation columns", () => {
    // Their header is prose, not a year, so they are not data columns. Reading
    // them would file "4.4% y/y" as a June index level of 4.4.
    for (const row of result!.rows) {
      assert.ok(
        row.value > 50,
        `${row.seriesId} ${row.value} looks like a variation`,
      );
    }
    assert.equal(result!.rows.length, 4 * 3);
  });

  it("carries CPI, WPI and a WPI sub-index through one page", () => {
    const ids = new Set(result!.rows.map((r) => r.seriesId));
    assert.ok(ids.has("MOSPI_CPI_COMBINED"));
    assert.ok(ids.has("MOSPI_CPI_RURAL"));
    assert.ok(ids.has("OEA_WPI_ALL_COMMODITIES"));
    assert.ok(ids.has("OEA_WPI_FUEL_AND_POWER"));
  });

  it("reports the newest period it saw", () => {
    assert.equal(iso(result!.newestPeriod!), "2026-06-01");
  });
});

// ─── Layout B: as-on snapshot ────────────────────────────────────────

describe("parseNsdpAsOnTable — forex reserves (param=2)", () => {
  const result = parseNsdpAsOnTable(source("rbi-nsdp-forex"), FOREX_HTML);

  it("takes its single period from the 'As on' header", () => {
    assert.ok(result);
    assert.ok(result!.rows.length > 0);
    for (const row of result!.rows) assert.equal(iso(row.period), "2026-07-31");
  });

  it("splits the two magnitudes into two SERIES, not one ambiguous unit", () => {
    const inr = result!.rows.find(
      (r) => r.seriesId === "RBI_FOREX_RESERVES_TOTAL_INR_CR",
    );
    const usd = result!.rows.find(
      (r) => r.seriesId === "RBI_FOREX_RESERVES_TOTAL_USD_MN",
    );
    assert.equal(inr!.value, 6612148);
    assert.equal(inr!.unit, "INR_CRORE");
    assert.equal(usd!.value, 692866);
    assert.equal(usd!.unit, "USD_MILLION");
  });

  it("EXCLUDES the six variation columns", () => {
    // Only the first two value columns are levels. `24233` is the week-on-week
    // change and would be a catastrophic reserves reading.
    assert.equal(result!.rows.length, 2 * 2);
    assert.equal(
      result!.rows.some((r) => r.value === 24233 || r.value === 10512),
      false,
    );
  });

  it("returns NULL when the 'As on' header is missing", () => {
    // The header IS the period. Without it there is nothing to key on, and
    // guessing "this week" would mis-date the whole snapshot.
    const noHeader = page([
      tr([["Item"], ["a"], ["b"]]),
      tr([["1 Total Reserves"], ["1"], ["2"]]),
    ]);
    assert.equal(parseNsdpAsOnTable(source("rbi-nsdp-forex"), noHeader), null);
  });

  it("parses an as-on date directly", () => {
    assert.equal(iso(parseAsOnDate("As on Jul. 31, 2026")!), "2026-07-31");
    assert.equal(iso(parseAsOnDate("as on Mar 4, 2019")!), "2019-03-04");
    assert.equal(parseAsOnDate("Variation over Week"), null);
    // A rolled-over impossible date must not silently become March.
    assert.equal(parseAsOnDate("As on Feb. 31, 2026"), null);
  });
});

// ─── The distinction this ticket exists to protect ───────────────────

describe("a FAILURE and an EMPTY result are different values", () => {
  it("no table at all → null, for BOTH layouts", () => {
    const shell = "<html><body><div>RBI</div></body></html>";
    assert.equal(parseNsdpPeriodTable(source("rbi-nsdp-rates"), shell), null);
    assert.equal(parseNsdpAsOnTable(source("rbi-nsdp-forex"), shell), null);
    assert.equal(parseMacroSource(source("rbi-nsdp-rates"), shell), null);
  });

  it("a table with no recognisable header → null, not zero rows", () => {
    // Data rows with nothing above them to date them. Emitting `[]` here would
    // read as "RBI published nothing this week", which is a different — and
    // false — claim.
    const headerless = page([
      tr([["Policy Repo Rate"], ["5.25"], ["5.25"]]),
      tr([["Bank Rate"], ["5.50"], ["5.50"]]),
    ]);
    assert.equal(
      parseNsdpPeriodTable(source("rbi-nsdp-rates"), headerless),
      null,
    );
  });

  it("a real table whose labels we do not track → zero rows, NOT null", () => {
    // The genuinely empty case: structure intact, nothing we follow. It must be
    // reportable as such, so the caller can say "the row labels moved" rather
    // than "the page is gone".
    const foreign = page([
      tr([["Item/Week Ended"], ["2026", 2]]),
      tr([["Jul. 24"], ["Jul. 31"]]),
      tr([["Some Series We Do Not Track"], ["1.00"], ["2.00"]]),
    ]);
    const result = parseNsdpPeriodTable(source("rbi-nsdp-rates"), foreign);
    assert.notEqual(result, null, "structure was fine — must not be null");
    assert.deepEqual(result!.rows, []);
    assert.ok(result!.unmapped.includes("Some Series We Do Not Track"));
  });
});

// ─── Freshness ───────────────────────────────────────────────────────

describe("judgeMacroFreshness — the frozen-page guard", () => {
  it("recent → FRESH", () => {
    assert.equal(
      judgeMacroFreshness(at("2026-07-31"), at("2026-08-13"), 21),
      "FRESH",
    );
  });

  it("a discontinued page's 2012 data → STALE", () => {
    // Nine NSDP tables serve 2003–2014 data under a permanent HTTP 200. Without
    // this the only symptom would be a series that quietly stops moving.
    assert.equal(
      judgeMacroFreshness(at("2012-12-28"), at("2026-08-13"), 21),
      "STALE",
    );
  });

  it("exactly at the threshold is still FRESH", () => {
    assert.equal(
      judgeMacroFreshness(at("2026-07-23"), at("2026-08-13"), 21),
      "FRESH",
    );
    assert.equal(
      judgeMacroFreshness(at("2026-07-22"), at("2026-08-13"), 21),
      "STALE",
    );
  });

  it("UNKNOWN is NOT folded into STALE", () => {
    // "we cannot tell" and "we can tell, and it is old" are different findings.
    assert.equal(judgeMacroFreshness(null, at("2026-08-13"), 21), "UNKNOWN");
  });
});

// ─── Registry invariants ─────────────────────────────────────────────

describe("MACRO_SOURCES registry invariants", () => {
  it("every source carries a verification date and a bounded staleness", () => {
    for (const s of MACRO_SOURCES) {
      assert.match(s.verifiedOn, /^\d{4}-\d{2}-\d{2}$/, s.id);
      assert.ok(Number.isFinite(s.maxAgeDays) && s.maxAgeDays > 0, s.id);
      assert.match(s.url, /^https:\/\/www\.rbi\.org\.in\//, s.id);
    }
  });

  it("EVERY label key is already normalised", () => {
    // The invariant that catches a mis-typed key. A key that does not survive
    // normaliseMacroLabel can never match a live row, and the only symptom
    // would be a series that is permanently absent with no error anywhere.
    for (const s of MACRO_SOURCES) {
      for (const key of Object.keys(s.series)) {
        assert.equal(
          normaliseMacroLabel(key),
          key,
          `${s.id}: key ${JSON.stringify(key)} normalises to ` +
            `${JSON.stringify(normaliseMacroLabel(key))} and so can never match`,
        );
      }
    }
  });

  it("seriesIds are globally unique across sources", () => {
    const seen = new Map<string, string>();
    for (const s of MACRO_SOURCES) {
      for (const def of Object.values(s.series)) {
        const prior = seen.get(def.seriesId);
        assert.equal(
          prior,
          undefined,
          `${def.seriesId} defined by ${prior} and ${s.id}`,
        );
        seen.set(def.seriesId, s.id);
      }
    }
  });

  it("source ids and archive feeds are unique", () => {
    assert.equal(
      new Set(MACRO_SOURCES.map((s) => s.id)).size,
      MACRO_SOURCES.length,
    );
    assert.equal(
      new Set(MACRO_SOURCES.map((s) => s.archiveFeed)).size,
      MACRO_SOURCES.length,
    );
  });

  it("covers every series the ticket named", () => {
    const ids = new Set(
      MACRO_SOURCES.flatMap((s) => Object.values(s.series)).map(
        (d) => d.seriesId,
      ),
    );
    // CPI, WPI, repo, CRR/SLR, forex reserves, call money. IIP is deliberately
    // absent — see the TODO block in macro-series.ts.
    for (const required of [
      "MOSPI_CPI_COMBINED",
      "OEA_WPI_ALL_COMMODITIES",
      "RBI_REPO_RATE",
      "RBI_CRR",
      "RBI_SLR",
      "RBI_CALL_MONEY_RATE",
      "RBI_FOREX_RESERVES_TOTAL",
    ]) {
      assert.ok(ids.has(required), `missing ${required}`);
    }
  });
});

describe("selectMacroSources", () => {
  it("no ids → every source", () => {
    assert.equal(selectMacroSources().length, MACRO_SOURCES.length);
    assert.equal(selectMacroSources([]).length, MACRO_SOURCES.length);
  });

  it("explicit ids → just those", () => {
    assert.deepEqual(
      selectMacroSources(["rbi-nsdp-forex"]).map((s) => s.id),
      ["rbi-nsdp-forex"],
    );
  });

  it("an unknown id yields NOTHING — it does not widen to all", () => {
    // A typo that silently ran the whole registry is the opposite of what an
    // operator asking for one page wants.
    assert.deepEqual(selectMacroSources(["typo"]), []);
  });
});

// ─── Cross-module wiring: the archive shape ──────────────────────────

describe("every macro source is registered with the payload guard", () => {
  it("resolves to the html kind, not the generic guard", () => {
    // If this drifts, `feedShapeFor` falls back to the URL-extension guard,
    // which REJECTS HTML — so nothing would ever be archived while the live
    // fetch kept working and the ingest stayed green.
    for (const s of MACRO_SOURCES) {
      const shape = feedShapeFor(
        { exchange: "RBI", feed: s.archiveFeed },
        s.url,
      );
      assert.equal(shape.kind, "html", s.archiveFeed);
      assert.ok(shape.requiredTokens.length >= 2, s.archiveFeed);
    }
  });

  it("accepts a real page and rejects an error shell", () => {
    const s = source("rbi-nsdp-rates");
    const descriptor = { exchange: "RBI" as const, feed: s.archiveFeed };
    // Padded past minBytes; the marker + caption are what actually decide it.
    const good = Buffer.from(RATES_HTML + " ".repeat(8192));
    assert.equal(validateFeedPayload(descriptor, s.url, good).ok, true);

    // The shape the discontinued/moved pages take: plenty of chrome, no table.
    const shell = Buffer.from(
      "<html><body><nav>Reserve Bank of India</nav></body></html>" +
        " ".repeat(8192),
    );
    const verdict = validateFeedPayload(descriptor, s.url, shell);
    assert.equal(verdict.ok, false);
    assert.match(
      verdict.ok === false ? verdict.reason : "",
      /missing required marker/,
    );
  });

  it("does not let one macro page validate as another", () => {
    // Every NSDP table is served from the SAME .aspx with only a query param,
    // so a mis-built URL would otherwise archive silently under the wrong key.
    const forex = source("rbi-nsdp-forex");
    const verdict = validateFeedPayload(
      { exchange: "RBI", feed: forex.archiveFeed },
      forex.url,
      Buffer.from(RATES_HTML + " ".repeat(8192)),
    );
    assert.equal(verdict.ok, false);
  });

  it("HTML is still rejected for every NON-macro feed", () => {
    // The html kind must not have widened the generic guard.
    const verdict = validateFeedPayload(
      { exchange: "NSE", feed: "indices" },
      "https://nsearchives.nseindia.com/x.csv",
      Buffer.from(
        "<html><head><title>Throttled</title></head><body>no</body></html>",
      ),
    );
    assert.equal(verdict.ok, false);
  });
});
