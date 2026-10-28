/**
 * MONEY-1238 — a computed signal must reach something that DECIDES.
 *
 * ## The defect class
 *
 * A module does the expensive part — a scale cross-check, a coverage report, a
 * retry outcome, a drift counter — and then drops the answer on the floor. The
 * cost is paid, the value is not collected, and the resulting failure is silent
 * by construction: the job finishes, the log says a number, and the number is
 * about something other than what went wrong.
 *
 * Five instances are fixed here, and they are grouped by RULE rather than by
 * module on purpose — the same way `no-feed-fetch-bypass.test.ts` groups by
 * "everything goes through the seam". Split across five module suites, each one
 * reads as a small local assertion; together they are one recurring bug.
 *
 *   1. `report-registry.requiresApi`  — declared, set on four rows, read by
 *      nobody, while two of those rows shipped `enabled: true` on a daily
 *      cadence into a fetch path with no cookie jar.
 *   2. `mf-portfolio-logic.percentSum` / `.missingColumns` — computed per
 *      sheet, documented as "the cheapest way to catch a scale or row-boundary
 *      regression", and read by nobody.
 *   3. `deals.SlbParseResult` — the header-drift degrade was inferable only
 *      from a count that three different outcomes can produce.
 *   4. `quote-service` — `runWithWriteConflictRetry` returns
 *      `{ success, attempts }` and the awaited value was not bound.
 *   5. `audit-stock-ratios-coverage.ts` — measured ROW EXISTENCE and fed a
 *      `process.exit(1)` with it.
 *
 * ## Why several of these are STATIC scans
 *
 * "The value is discarded" is a property of the CALL SITE, not of the function.
 * Nothing about `runWithWriteConflictRetry`'s behaviour changes when its caller
 * stops ignoring the result, so no behavioural test of that function can
 * observe the fix — which is precisely why the defect survived a suite that
 * already drives the real retry loop (`apps/web/__tests__/core/market-data/
 * quote-retry.test.ts`, 56 passing cases, none of which could see it).
 *
 * Comments are stripped LINE-FIRST, then BLOCK (MONEY-1143): a `//` line
 * containing `/*` otherwise opens a phantom block that swallows everything up
 * to the next terminator, and a guard whose job is to notice text that IS there
 * reads swallowed text as clean.
 *
 * Pure: no network, no Prisma, no GCS. The workbook fixtures are committed
 * bytes and the synthetic workbooks are built in memory.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as XLSX from "xlsx";

import {
  REPORT_REGISTRY,
  apiGatedFamilies,
  familiesDue,
  familyById,
  isNightlyFetchable,
  type ReportFamily,
} from "../../src/market-data/report-registry";
import {
  PERCENT_SUM_MAX_RATIO,
  PERCENT_SUM_MIN_RATIO,
  checkPercentSum,
  parseAmcPortfolioWorkbook,
} from "../../src/market-data/mf-portfolio-logic";
import { parseSlbOpenPositions } from "../../src/market-data/deals";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

/** LINE comments first, then BLOCK — see the header (MONEY-1143). */
function stripComments(src: string): string {
  return src
    .replace(/^[^\S\n]*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ""));
}

function readSource(relPath: string): string {
  const src = readFileSync(join(REPO_ROOT, relPath), "utf8");
  assert.ok(
    src.length > 0,
    `${relPath} is empty — the scan below would pass vacuously`,
  );
  return stripComments(src);
}

/* -------------------------------------------------------------------------- */
/* 1. report-registry — `requiresApi` decides which families the job fetches   */
/* -------------------------------------------------------------------------- */

describe("requiresApi is read, not merely declared", () => {
  /**
   * A fabricated family, because every row in the shipped table now satisfies
   * the rule. Asserting the guard only against real data would make it
   * untestable the moment it works — the exact state `requiresApi` was in.
   */
  function fake(overrides: Partial<ReportFamily>): ReportFamily {
    return {
      id: "probe-family",
      exchange: "NSE",
      feed: "probe",
      buildUrl: () => "https://example.invalid/probe.csv",
      cadence: "daily",
      startDate: "2000-01-01",
      format: "csv",
      enabled: true,
      backfillable: false,
      provenance: "p1-verified",
      notes: "test double",
      ...overrides,
    };
  }

  it("excludes an ENABLED family that needs the cookie-gated API", () => {
    assert.equal(isNightlyFetchable(fake({})), true);
    assert.equal(isNightlyFetchable(fake({ requiresApi: true })), false);
  });

  it("still excludes a disabled family, api-gated or not", () => {
    assert.equal(isNightlyFetchable(fake({ enabled: false })), false);
    assert.equal(
      isNightlyFetchable(fake({ enabled: false, requiresApi: true })),
      false,
    );
  });

  it("hands familiesDue NO api-gated family, on any cadence or day", () => {
    // Several days across eras: startDate filtering must not be what happens
    // to be doing the excluding.
    const days = [
      new Date("2020-06-15T00:00:00Z"),
      new Date("2026-08-13T00:00:00Z"),
      new Date("2026-08-31T00:00:00Z"),
    ];
    for (const day of days) {
      for (const cadence of ["daily", "weekly", "monthly", "all"] as const) {
        for (const f of familiesDue(day, cadence)) {
          assert.notEqual(
            f.requiresApi,
            true,
            `${f.id} reached the nightly fetch set on ${day.toISOString()} (${cadence}) — that path has no cookie jar`,
          );
        }
      }
    }
  });

  it("drops an api-gated family from a registry that still has one", () => {
    // The behavioural half, against a FABRICATED registry.
    //
    // The case above proves nothing about `familiesDue` on the shipped table:
    // every real row now satisfies the rule, so reverting the filter to the old
    // `f.enabled` leaves the real result identical and that assertion green.
    // Verified by mutation — it survived exactly that change until this case
    // existed.
    const gated = fake({ id: "gated-one", feed: "gated", requiresApi: true });
    const plain = fake({ id: "plain-one", feed: "plain" });
    const due = familiesDue(new Date("2026-08-13T00:00:00Z"), "daily", [
      gated,
      plain,
    ]);
    assert.deepEqual(
      due.map((f) => f.id),
      ["plain-one"],
    );
  });

  it("lists the api-gated rows instead of dropping them silently", () => {
    const gated = apiGatedFamilies();
    assert.ok(gated.length > 0, "no api-gated rows — the guard is vacuous");
    for (const f of gated) assert.equal(f.requiresApi, true);
    // Nothing carrying the flag may be missing from the list.
    assert.deepEqual(
      REPORT_REGISTRY.filter((f) => f.requiresApi === true).map((f) => f.id),
      gated.map((f) => f.id),
    );
  });

  it("ships no row that is both enabled and api-gated", () => {
    // The data itself must stop claiming the nightly job may fetch something it
    // provably cannot. `enabled` is the operator's intent and it should not
    // record an intent the transport cannot satisfy.
    const contradictory = REPORT_REGISTRY.filter(
      (f) => f.enabled && f.requiresApi === true,
    ).map((f) => f.id);
    assert.deepEqual(contradictory, []);
  });

  it("keeps the ASM/GSM rows, disabled, pointing at their real fetcher", () => {
    // They must not be DELETED: both ids are `StockFlag.source` values written
    // by surveillance-sync (STOCK_FLAG_SOURCES in stock-flags.ts), and the
    // stock page renders the family behind a flag from exactly that string.
    for (const id of ["nse-asm-api", "nse-gsm-api"]) {
      const f = familyById(id);
      assert.ok(f, `${id} must still exist — it is a StockFlag.source value`);
      assert.equal(f.enabled, false, `${id} must not be fetched nightly`);
      assert.equal(f.requiresApi, true);
      assert.match(
        f.notes,
        /surveillance-sync/,
        `${id} notes must name the job that actually fetches it`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. mf-portfolio-logic — percentSum and missingColumns decide                */
/* -------------------------------------------------------------------------- */

const AMC_FIXTURES = join(import.meta.dirname, "..", "fixtures", "amc");
const AMC_FILES = [
  "hdfc-value-fund-2026-07.xlsx",
  "nippon-monthly-portfolio-2026-07.xls",
  "sbi-all-schemes-2026-07.xlsx",
  "absl-monthly-portfolio-2026-07.zip",
] as const;

const PROBE_HEADERS = [
  "Name of the Instrument",
  "ISIN",
  "Industry / Rating",
  "Quantity",
  "Market Value (Rs. in Lakhs)",
  "% to NAV",
];

/**
 * Build a one-sheet portfolio workbook in memory.
 *
 * `percentFormat` stamps the `%` number format on the percentage cells, which
 * is how a real AMC expresses a fraction — and how the 100× misread is
 * reproduced faithfully rather than by hand-editing a parsed structure.
 */
function buildWorkbook(
  rows: unknown[][],
  opts: { percentFormat?: boolean; percentColumn?: string } = {},
): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  if (opts.percentFormat) {
    const col = opts.percentColumn ?? "F";
    for (let r = 1; r <= rows.length; r++) {
      const cell = ws[`${col}${r}`];
      if (cell) cell.z = "0.00%";
    }
  }
  XLSX.utils.book_append_sheet(wb, ws, "PROBE");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

describe("checkPercentSum — the cross-check itself", () => {
  const holdings = [
    { pctToNav: 50, marketValueLakhs: 500 },
    { pctToNav: 50, marketValueLakhs: 500 },
  ];

  it("passes a book whose two columns agree", () => {
    const r = checkPercentSum({
      percentSum: 100,
      totalAumLakhs: 1000,
      holdings,
    });
    assert.equal(r.verdict, "ok");
    assert.equal(r.moneyWeightSum, 100);
    assert.equal(r.ratio, 1);
  });

  it("passes ABSL's real worst case (percentages sum to 101.7%)", () => {
    // Measured, not invented: 1.01691 is the largest ratio across all 333
    // portfolio sheets in the four committed fixtures. If the band ever
    // tightens past this, ABSL's Other Current Assets lines start crying wolf.
    const r = checkPercentSum({
      percentSum: 101.691,
      totalAumLakhs: 1000,
      holdings,
    });
    assert.equal(r.verdict, "ok");
  });

  it("flags a 100x scale misread in BOTH directions", () => {
    const inflated = checkPercentSum({
      percentSum: 10000,
      totalAumLakhs: 1000,
      holdings,
    });
    assert.equal(inflated.verdict, "scale-suspect");
    assert.equal(inflated.ratio, 100);

    const shrunk = checkPercentSum({
      percentSum: 1,
      totalAumLakhs: 1000,
      holdings,
    });
    assert.equal(shrunk.verdict, "scale-suspect");
    assert.equal(shrunk.ratio, 0.01);
  });

  it("REGRESSION: rows with a percentage but NO money cannot inflate the ratio", () => {
    // MONEY-1236. `percentSum` is accumulated wherever `pctToNav !== null`, with
    // no condition on the money column, but the money loop additionally skipped
    // a row whose `marketValueLakhs` was null or non-finite. Those rows landed
    // in the numerator and not the denominator, understating `moneyWeightSum`
    // and INFLATING the ratio — a false `scale-suspect` on a healthy sheet.
    //
    // Here MOST of the money is missing from percentage-bearing rows, so the two
    // sides describe different populations and the honest answer is
    // `uncheckable` — never a disagreement the data cannot support.
    const lopsided = [
      { pctToNav: 10, marketValueLakhs: 100 },
      { pctToNav: 30, marketValueLakhs: null },
      { pctToNav: 30, marketValueLakhs: null },
      { pctToNav: 30, marketValueLakhs: Number.NaN },
    ];
    const r = checkPercentSum({
      percentSum: 100,
      totalAumLakhs: 1000,
      holdings: lopsided,
    });
    assert.equal(
      r.verdict,
      "uncheckable",
      "a comparison over different populations must not be reported as one",
    );
    assert.equal(r.ratio, null);
  });

  it("a MINORITY of money-less rows still yields a real verdict", () => {
    // The control, and the reason this is a majority rule rather than a blanket
    // veto: one missing rupee figure must not void the whole check. Without
    // this the assertion above passes for any fixture with a null in it.
    const mostlyFine = [
      { pctToNav: 25, marketValueLakhs: 250 },
      { pctToNav: 25, marketValueLakhs: 250 },
      { pctToNav: 25, marketValueLakhs: 250 },
      { pctToNav: 25, marketValueLakhs: null },
    ];
    const r = checkPercentSum({
      percentSum: 100,
      totalAumLakhs: 1000,
      holdings: mostlyFine,
    });
    assert.notEqual(r.verdict, "uncheckable");
  });

  it("the numerator is still the SHEET's percentSum, not one re-derived here", () => {
    // Re-deriving the numerator from `holdings` would make `percentSum` unused
    // and the function blind to the exact misread it exists to catch. Same
    // holdings, two different percentSum values, two different verdicts.
    const a = checkPercentSum({
      percentSum: 100,
      totalAumLakhs: 1000,
      holdings,
    });
    const b = checkPercentSum({
      percentSum: 10000,
      totalAumLakhs: 1000,
      holdings,
    });
    assert.equal(a.verdict, "ok");
    assert.equal(b.verdict, "scale-suspect");
  });

  it("holds the measured band it documents", () => {
    assert.equal(PERCENT_SUM_MIN_RATIO, 0.5);
    assert.equal(PERCENT_SUM_MAX_RATIO, 2);
    // Just inside and just outside, so the comparison is proven inclusive.
    assert.equal(
      checkPercentSum({ percentSum: 50, totalAumLakhs: 1000, holdings })
        .verdict,
      "ok",
    );
    assert.equal(
      checkPercentSum({ percentSum: 49, totalAumLakhs: 1000, holdings })
        .verdict,
      "scale-suspect",
    );
    assert.equal(
      checkPercentSum({ percentSum: 200, totalAumLakhs: 1000, holdings })
        .verdict,
      "ok",
    );
    assert.equal(
      checkPercentSum({ percentSum: 201, totalAumLakhs: 1000, holdings })
        .verdict,
      "scale-suspect",
    );
  });

  it("says UNCHECKABLE, never OK, when an input is missing", () => {
    // The fail-open shape this repo keeps paying for: "could not determine"
    // must not be spelled the same way as "determined to be fine".
    for (const input of [
      { percentSum: null, totalAumLakhs: 1000, holdings },
      { percentSum: 100, totalAumLakhs: null, holdings },
      { percentSum: 100, totalAumLakhs: 0, holdings },
      { percentSum: 100, totalAumLakhs: 1000, holdings: [] },
      {
        percentSum: 100,
        totalAumLakhs: 1000,
        holdings: [{ pctToNav: 50, marketValueLakhs: null }],
      },
      { percentSum: Number.NaN, totalAumLakhs: 1000, holdings },
    ]) {
      const r = checkPercentSum(input);
      assert.equal(r.verdict, "uncheckable");
      assert.equal(r.ratio, null);
      assert.equal(r.moneyWeightSum, null);
    }
  });
});

describe("the parser acts on percentSum and missingColumns", () => {
  it("runs the check on every real fixture sheet and passes all 333", () => {
    let checked = 0;
    for (const file of AMC_FILES) {
      const parsed = parseAmcPortfolioWorkbook(
        readFileSync(join(AMC_FIXTURES, file)),
      );
      assert.ok(parsed, `${file} must parse`);
      for (const sheet of parsed.sheets) {
        // Not merely "no anomaly": `uncheckable` would also produce none, and
        // would mean the cross-check never ran on any real sheet.
        assert.equal(
          sheet.percentSumCheck.verdict,
          "ok",
          `${file} :: ${sheet.sheetName} — ${JSON.stringify(sheet.percentSumCheck)}`,
        );
        checked++;
      }
      assert.deepEqual(
        parsed.anomalies,
        [],
        `${file} must have no file-level anomalies`,
      );
    }
    assert.equal(checked, 333, "the fixture corpus changed — re-measure");
  });

  it("turns a 100x scale misread into a sheet AND a file anomaly", () => {
    // Percent values (50, 50) stamped with a `%` number format. The format wins
    // over the column sum by design, so the parser reads them as FRACTIONS and
    // multiplies by 100 — the whole book inflates to 10,000% while the money
    // column still reconciles to the AUM at exactly 100%.
    const bytes = buildWorkbook(
      [
        ["Probe Scheme Fund"],
        PROBE_HEADERS,
        ["Equity & Equity related"],
        ["ALPHA LTD", "INE000A01001", "Banks", 100, 500, 50],
        ["BETA LTD", "INE000A01002", "Banks", 100, 500, 50],
        ["GRAND TOTAL", "", "", "", 1000, 100],
      ],
      { percentFormat: true },
    );
    const parsed = parseAmcPortfolioWorkbook(bytes);
    assert.ok(parsed);
    const sheet = parsed.sheets[0];
    assert.ok(sheet);

    assert.equal(sheet.percentScale, "fraction");
    assert.equal(sheet.percentSum, 10000);
    assert.equal(sheet.percentSumCheck.verdict, "scale-suspect");
    assert.equal(sheet.percentSumCheck.ratio, 100);
    assert.equal(
      sheet.anomalies.filter((a) => /disagrees with the money column/.test(a))
        .length,
      1,
    );
    assert.equal(
      parsed.anomalies.filter((a) => /percent-vs-money cross-check/.test(a))
        .length,
      1,
      "a per-sheet anomaly on sheet 87 of 122 is invisible without the roll-up",
    );
  });

  it("leaves a correctly-scaled synthetic book alone", () => {
    // Same workbook, no `%` format — the control that proves the anomaly above
    // comes from the scale misread and not from the synthetic shape.
    const bytes = buildWorkbook([
      ["Probe Scheme Fund"],
      PROBE_HEADERS,
      ["Equity & Equity related"],
      ["ALPHA LTD", "INE000A01001", "Banks", 100, 500, 50],
      ["BETA LTD", "INE000A01002", "Banks", 100, 500, 50],
      ["GRAND TOTAL", "", "", "", 1000, 100],
    ]);
    const parsed = parseAmcPortfolioWorkbook(bytes);
    assert.ok(parsed);
    const sheet = parsed.sheets[0];
    assert.ok(sheet);
    assert.equal(sheet.percentSumCheck.verdict, "ok");
    assert.deepEqual(sheet.anomalies, []);
    assert.deepEqual(parsed.anomalies, []);
  });

  it("turns a dropped column into a sheet AND a file anomaly", () => {
    const bytes = buildWorkbook([
      ["Probe Scheme Fund"],
      [
        "Name of the Instrument",
        "ISIN",
        "Industry / Rating",
        "Market Value (Rs. in Lakhs)",
        "% to NAV",
      ],
      ["ALPHA LTD", "INE000A01001", "Banks", 500, 50],
      ["BETA LTD", "INE000A01002", "Banks", 500, 50],
      ["GRAND TOTAL", "", "", 1000, 100],
    ]);
    const parsed = parseAmcPortfolioWorkbook(bytes);
    assert.ok(parsed);
    const sheet = parsed.sheets[0];
    assert.ok(sheet);

    assert.deepEqual(sheet.missingColumns, ["quantity"]);
    assert.equal(
      sheet.anomalies.filter((a) => /expected column\(s\) absent/.test(a))
        .length,
      1,
      "missingColumns was computed and dropped — it must now say so",
    );
    assert.equal(
      parsed.anomalies.filter((a) => /missing an expected column/.test(a))
        .length,
      1,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 3. deals — the SLB header-drift degrade is distinguishable                  */
/* -------------------------------------------------------------------------- */

describe("SLB parse reports UNRECOGNISED FORMAT as its own state", () => {
  const DAY = new Date("2026-08-13T00:00:00Z");
  const REAL_HEADER =
    "Sr no,Security,Series,Outstanding Quantity at the end of the day";

  it("flags a drifted header instead of leaving it inferable from a count", () => {
    const drifted = ["Sr no,Scrip,Expiry,Open Interest", "1,TCS,X9,1000"].join(
      "\n",
    );
    const out = parseSlbOpenPositions(drifted, DAY);
    assert.equal(out.unrecognisedFormat, true);
    assert.deepEqual(out.rows, []);
    assert.equal(out.multiSeriesSymbols, 0);
  });

  it("does not flag a real file", () => {
    const good = [REAL_HEADER, "1,TCS,X9,1000", "2,TCS,XO,500"].join("\n");
    const out = parseSlbOpenPositions(good, DAY);
    assert.equal(out.unrecognisedFormat, false);
    assert.equal(out.rows.length, 2);
    assert.equal(out.multiSeriesSymbols, 1);
  });

  it("separates the three ways this parser can return zero rows", () => {
    // The whole reason the flag exists: `skipped` alone cannot tell these
    // apart, and each wants a different response.
    const empty = parseSlbOpenPositions("", DAY);
    assert.equal(empty.unrecognisedFormat, true);
    assert.equal(empty.rows.length, 0);

    const headerOnly = parseSlbOpenPositions(REAL_HEADER, DAY);
    assert.equal(headerOnly.unrecognisedFormat, false);
    assert.equal(headerOnly.rows.length, 0);
    assert.equal(headerOnly.skipped, 0);

    const allRowsBad = parseSlbOpenPositions(
      [REAL_HEADER, ",,X9,", ",,XO,"].join("\n"),
      DAY,
    );
    assert.equal(allRowsBad.unrecognisedFormat, false);
    assert.equal(allRowsBad.rows.length, 0);
    assert.equal(allRowsBad.skipped, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. quote-service — the retry outcome is bound and acted on                  */
/* -------------------------------------------------------------------------- */

describe("the write-conflict retry result is not discarded", () => {
  const QUOTE_SERVICE = "packages/core/src/market-data/prices/quote-service.ts";

  it("binds the awaited runWithWriteConflictRetry result", () => {
    const src = readSource(QUOTE_SERVICE);
    // Bounded to one statement: `[^;]*` cannot cross the `;` that ends the
    // await, so this cannot accidentally match an assignment further down.
    assert.match(
      src,
      /const\s+\w+\s*=\s*await\s+runWithWriteConflictRetry\s*\(/,
      "the awaited result must be bound — `await runWithWriteConflictRetry(...)` " +
        "on its own resolves success:false without throwing, so an exhausted " +
        "retry leaves no trace anywhere",
    );
    assert.equal(
      /^\s*await\s+runWithWriteConflictRetry\s*\(/m.test(src),
      false,
      "a bare awaited call is the defect this guard exists for",
    );
  });

  it("branches on the failure and logs it at error severity", () => {
    const src = readSource(QUOTE_SERVICE);
    const opener = /if\s*\(\s*!\s*(\w+)\.success\s*\)\s*\{/.exec(src);
    assert.ok(opener, "quote-service must branch on the retry's success flag");

    // The branch body is delimited by the `} catch (` that closes the enclosing
    // try, NOT by a `[^}]*` run: the log message interpolates `${yahooSymbol}`,
    // whose own `}` terminates such a run three characters in — which is how
    // the first version of this assertion managed to fail against correct code.
    //
    // Bounded at both ends and it must not be empty, so it can never span the
    // rest of the file or match nothing at all.
    const from = opener.index + opener[0].length;
    const catchAt = src.indexOf("} catch (", from);
    assert.ok(catchAt > from, "the retry branch must sit inside the try/catch");
    const body = src.slice(from, catchAt);
    assert.ok(body.trim().length > 0, "the failure branch must not be empty");

    assert.match(
      body,
      /console\.error/,
      "the exhausted-retry branch must report, not swallow",
    );
    assert.match(
      body,
      /attempts/,
      "the attempt count is the only thing distinguishing a conflict storm " +
        "from a single failure — report it",
    );
    assert.match(
      body,
      /NOT written/,
      "the message must say the write did not land — a bare 'failed' reads " +
        "like a fetch problem",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 5. audit-stock-ratios-coverage — coverage means POPULATED, not PRESENT      */
/* -------------------------------------------------------------------------- */

describe("the ratios coverage audit measures populated columns", () => {
  const AUDIT = "scripts/data/audit-stock-ratios-coverage.ts";

  it("reads the ratio columns instead of only the keys", () => {
    const src = readSource(AUDIT);
    assert.match(
      src,
      /OWNED_RATIO_FIELDS\.map\(\(f\) => \[f, true\]\)/,
      "the stockRatios select must request the value columns — a row's " +
        "existence says nothing about whether it holds anything",
    );
    for (const field of ["roe", "roce", "debtToEquity", "revenueGrowth"]) {
      assert.ok(
        src.includes(`"${field}"`),
        `${field} must be in the measured set`,
      );
    }
  });

  it("does not count a bare row as covered", () => {
    const src = readSource(AUDIT);
    // The exact expression that produced 100% coverage over a table of empty
    // shells. Bounded to the identifier, so a `covered` variable elsewhere
    // cannot make this pass or fail by accident.
    assert.equal(
      /covered\.add\(r\.symbol\)/.test(src),
      false,
      "row existence was the old measure and it is what this rewrite removes",
    );
    assert.match(
      src,
      /withCoreRatios\b/,
      "the headline metric must be the populated-column count",
    );
  });

  it("gates the exit on the populated count, not on row existence", () => {
    const src = readSource(AUDIT);
    const coverageAssignment = src.match(/const coverage =[^;]*;/);
    assert.ok(coverageAssignment, "coverage must be computed");
    assert.match(
      coverageAssignment[0],
      /withCoreRatios/,
      "coverage — the number the exit(1) gate reads — must be derived from " +
        "populated columns",
    );
    assert.match(
      src,
      /if \(overall < COVERAGE_TARGET\) \{/,
      "the gate itself must still exist",
    );
  });

  it("excludes the two deliberately-null analyst columns", () => {
    const src = readSource(AUDIT);
    // MONEY-1220 leaves these null on purpose rather than scraping sell-side
    // opinion. Counting them would score a policy decision as a data gap.
    for (const field of ["targetPrice", "recommendation"]) {
      assert.equal(
        src.includes(`"${field}"`),
        false,
        `${field} is analyst opinion we deliberately do not store — it must ` +
          "not be part of the coverage denominator",
      );
    }
  });
});
