/**
 * NSE filings response parsing — REAL source (MONEY-620 de-shadow).
 *
 * Previously this file inlined `parseAnnouncements` / `parseFinancialResults` /
 * `parseCorporateActions` / `filterAnnualReports` / symbol normalisation and
 * asserted the copies. The parsers were extracted into
 * `packages/research/src/data-sources/nse-filings-logic.ts` and the live
 * fetchers (`fetchNSEAnnouncements`, …) now import and call them; this test
 * imports the REAL symbols.
 *
 * Bug fixed during extraction (Invalid-Date class): the inline mapping did
 * `new Date((row.an_dt as string) || Date.now())`, so a malformed NON-empty
 * date string ("garbage", a partial value) produced an `Invalid Date` that
 * `.toISOString()` consumers later throw on. The real parsers now route every
 * date through `safeFilingDate` / `safeOptionalDate`, which fall back to
 * `now` / `null`. Regression tests below pin that.
 *
 * The inline NSE session-manager / URL-builder / NSE_HEADERS suites tested
 * module-private constants with no exported counterpart (the cookie session and
 * URL construction live inside the network fetchers); those reimplementation-
 * only suites were dropped rather than kept as shadows.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeFilingSymbol,
  safeFilingDate,
  safeOptionalDate,
  parseAnnouncements,
  parseFinancialResults,
  parseCorporateActions,
  filterAnnualReports,
  categorizeNseAnnouncement,
  categorizeAnnouncements,
} from "@usemoney/research/data-sources/nse-filings-logic";
// `nse-filings-logic` only *imports* NSEFiling; it is declared (and exported)
// by the types module, which has its own subpath export.
import type { NSEFiling } from "@usemoney/research/data-sources/nse-filings-types";

// ── Symbol normalization ──────────────────────────────────────────────────

describe("normalizeFilingSymbol", () => {
  it("strips .NS / .BO (case-insensitive) and uppercases", () => {
    assert.strictEqual(normalizeFilingSymbol("reliance.NS"), "RELIANCE");
    assert.strictEqual(normalizeFilingSymbol("tcs.BO"), "TCS");
    assert.strictEqual(normalizeFilingSymbol("infy.ns"), "INFY");
    assert.strictEqual(normalizeFilingSymbol("hdfc.bo"), "HDFC");
  });

  it("uppercases an already-clean symbol", () => {
    assert.strictEqual(normalizeFilingSymbol("reliance"), "RELIANCE");
    assert.strictEqual(normalizeFilingSymbol("RELIANCE"), "RELIANCE");
  });

  it("only strips a TRAILING suffix", () => {
    assert.strictEqual(normalizeFilingSymbol("INS.INDIA"), "INS.INDIA");
  });

  it("handles the empty string", () => {
    assert.strictEqual(normalizeFilingSymbol(""), "");
  });
});

// ── safeFilingDate / safeOptionalDate (Invalid-Date guard) ────────────────

describe("safeFilingDate (required date)", () => {
  const NOW = Date.parse("2026-06-06T00:00:00Z");

  it("parses a valid date string", () => {
    assert.strictEqual(
      safeFilingDate("2026-03-15T10:00:00Z", NOW).toISOString(),
      "2026-03-15T10:00:00.000Z"
    );
  });

  it("falls back to `now` for an empty / null / undefined value", () => {
    assert.strictEqual(safeFilingDate("", NOW).getTime(), NOW);
    assert.strictEqual(safeFilingDate(null, NOW).getTime(), NOW);
    assert.strictEqual(safeFilingDate(undefined, NOW).getTime(), NOW);
  });

  it("falls back to `now` for a MALFORMED non-empty string (the bug fix)", () => {
    // Pre-fix this produced an Invalid Date; now it is a valid `now`.
    const d = safeFilingDate("garbage-not-a-date", NOW);
    assert.ok(!Number.isNaN(d.getTime()), "must not be an Invalid Date");
    assert.strictEqual(d.getTime(), NOW);
  });

  it("the returned date is always .toISOString()-safe (no RangeError)", () => {
    for (const raw of ["", "nonsense", "2026-13-99", undefined, null, {}]) {
      assert.doesNotThrow(() => safeFilingDate(raw, NOW).toISOString());
    }
  });
});

describe("safeOptionalDate (optional date)", () => {
  it("parses a valid date string", () => {
    assert.deepStrictEqual(
      safeOptionalDate("2026-04-01"),
      new Date("2026-04-01")
    );
  });

  it("returns null for missing values", () => {
    assert.strictEqual(safeOptionalDate(""), null);
    assert.strictEqual(safeOptionalDate(null), null);
    assert.strictEqual(safeOptionalDate(undefined), null);
  });

  it("returns null (not Invalid Date) for a malformed string", () => {
    assert.strictEqual(safeOptionalDate("not-a-date"), null);
  });
});

// ── parseAnnouncements ─────────────────────────────────────────────────────

describe("parseAnnouncements", () => {
  it("maps desc/attchmntText/attchmntFile/an_dt/smIndustry", () => {
    const resp = [
      {
        desc: "Board Meeting Outcome",
        attchmntText: "Detailed info",
        attchmntFile: "https://nse.co/file.pdf",
        an_dt: "2026-03-15T10:00:00Z",
        smIndustry: "Annual Report",
      },
    ];
    const [f] = parseAnnouncements("reliance.NS", resp);
    assert.strictEqual(f!.symbol, "RELIANCE");
    assert.strictEqual(f!.title, "Board Meeting Outcome");
    assert.strictEqual(f!.description, "Detailed info");
    assert.strictEqual(f!.attachmentUrl, "https://nse.co/file.pdf");
    assert.deepStrictEqual(f!.filingDate, new Date("2026-03-15T10:00:00Z"));
    assert.strictEqual(f!.category, "Annual Report");
  });

  it("defaults attachmentUrl to null and category to 'General'", () => {
    const [f] = parseAnnouncements("RELIANCE", [
      { desc: "Test", an_dt: "2026-03-15" },
    ]);
    assert.strictEqual(f!.attachmentUrl, null);
    assert.strictEqual(f!.category, "General");
  });

  it("handles a missing an_dt with a valid (now) filingDate", () => {
    const [f] = parseAnnouncements("RELIANCE", [{ desc: "Test" }]);
    assert.ok(f!.filingDate instanceof Date);
    assert.ok(!Number.isNaN(f!.filingDate.getTime()));
  });

  it("returns [] for a non-array / empty response", () => {
    assert.deepStrictEqual(parseAnnouncements("RELIANCE", []), []);
    assert.deepStrictEqual(parseAnnouncements("RELIANCE", "not-an-array"), []);
    assert.deepStrictEqual(parseAnnouncements("RELIANCE", null), []);
  });

  it("maps multiple announcements", () => {
    const result = parseAnnouncements("RELIANCE", [
      { desc: "First", an_dt: "2026-03-15" },
      { desc: "Second", an_dt: "2026-03-16" },
      { desc: "Third", an_dt: "2026-03-17" },
    ]);
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0]!.title, "First");
    assert.strictEqual(result[2]!.title, "Third");
  });
});

// ── parseFinancialResults ──────────────────────────────────────────────────

describe("parseFinancialResults", () => {
  it("parses results with period / resultType / pdfLink / broadcastDt", () => {
    const [f] = parseFinancialResults("RELIANCE", {
      results: [
        {
          period: "Q3 FY26",
          resultType: "Quarterly",
          pdfLink: "https://nse.co/q3.pdf",
          broadcastDt: "2026-01-15T10:00:00Z",
        },
      ],
    });
    assert.strictEqual(f!.title, "Financial Results - Q3 FY26");
    assert.strictEqual(f!.description, "Quarterly results for Q3 FY26");
    assert.strictEqual(f!.attachmentUrl, "https://nse.co/q3.pdf");
    assert.strictEqual(f!.category, "Financial Results");
    assert.deepStrictEqual(f!.filingDate, new Date("2026-01-15T10:00:00Z"));
  });

  it("normalizes the symbol and defaults pdfLink to null", () => {
    const [f] = parseFinancialResults("hdfc.bo", {
      results: [{ period: "FY26" }],
    });
    assert.strictEqual(f!.symbol, "HDFC");
    assert.strictEqual(f!.attachmentUrl, null);
  });

  it("returns [] when results is missing / null / not an array", () => {
    assert.deepStrictEqual(parseFinancialResults("RELIANCE", {}), []);
    assert.deepStrictEqual(
      parseFinancialResults("RELIANCE", {
        results: null as unknown as undefined,
      }),
      []
    );
    assert.deepStrictEqual(
      parseFinancialResults("RELIANCE", {
        results: "x" as unknown as unknown[],
      }),
      []
    );
    assert.deepStrictEqual(parseFinancialResults("RELIANCE", null), []);
  });
});

// ── parseCorporateActions ──────────────────────────────────────────────────

describe("parseCorporateActions", () => {
  it("uppercases the subject into actionType and parses ex/record dates", () => {
    const [a] = parseCorporateActions("RELIANCE", [
      {
        subject: "Dividend - Rs 10 Per Share",
        exDate: "2026-03-15",
        recDate: "2026-04-01",
      },
    ]);
    assert.strictEqual(a!.actionType, "DIVIDEND - RS 10 PER SHARE");
    assert.deepStrictEqual(a!.exDate, new Date("2026-03-15"));
    assert.deepStrictEqual(a!.recordDate, new Date("2026-04-01"));
    assert.strictEqual(a!.details, "Dividend - Rs 10 Per Share");
  });

  it("sets ex/record dates to null when missing", () => {
    const [a] = parseCorporateActions("RELIANCE", [{ subject: "Split" }]);
    assert.strictEqual(a!.exDate, null);
    assert.strictEqual(a!.recordDate, null);
  });

  it("sets ex/record dates to null for MALFORMED date strings (bug fix)", () => {
    const [a] = parseCorporateActions("RELIANCE", [
      { subject: "Bonus", exDate: "garbage", recDate: "also-bad" },
    ]);
    assert.strictEqual(a!.exDate, null);
    assert.strictEqual(a!.recordDate, null);
  });

  it("preserves the raw row and normalizes the symbol", () => {
    const [a] = parseCorporateActions("reliance.ns", [
      { subject: "Dividend", extraField: "value" },
    ]);
    assert.strictEqual(a!.symbol, "RELIANCE");
    assert.strictEqual(a!.rawData.extraField, "value");
  });

  it("handles an empty subject", () => {
    const [a] = parseCorporateActions("RELIANCE", [{}]);
    assert.strictEqual(a!.actionType, "");
    assert.strictEqual(a!.details, "");
  });

  it("returns [] for a non-array response", () => {
    assert.deepStrictEqual(parseCorporateActions("RELIANCE", "bad"), []);
  });
});

// ── filterAnnualReports ────────────────────────────────────────────────────

describe("filterAnnualReports", () => {
  const mk = (overrides: Partial<NSEFiling>): NSEFiling => ({
    symbol: "RELIANCE",
    title: "",
    description: "",
    attachmentUrl: null,
    filingDate: new Date("2026-06-15"),
    category: "General",
    ...overrides,
  });

  it("keeps filings with 'annual report' in the title (case-insensitive)", () => {
    const result = filterAnnualReports([
      mk({ title: "Annual Report 2025-26" }),
      mk({ title: "Board Meeting Outcome" }),
      mk({ title: "annual report for FY2026" }),
    ]);
    assert.strictEqual(result.length, 2);
  });

  it("keeps filings with 'annual report' in the category (case-insensitive)", () => {
    const result = filterAnnualReports([
      mk({ title: "Document", category: "ANNUAL REPORT" }),
      mk({ title: "Quarterly Results", category: "Financial Results" }),
    ]);
    assert.strictEqual(result.length, 1);
  });

  it("matches a partial 'annual report' substring in a longer title", () => {
    const result = filterAnnualReports([
      mk({ title: "Submission of Annual Report and Notice of AGM" }),
    ]);
    assert.strictEqual(result.length, 1);
  });

  it("returns [] when nothing matches / the input is empty", () => {
    assert.strictEqual(
      filterAnnualReports([mk({ title: "Quarterly Results" })]).length,
      0
    );
    assert.deepStrictEqual(filterAnnualReports([]), []);
  });
});

// ── categorizeNseAnnouncement (MONEY-784 P3b) ──────────────────────────────

describe("categorizeNseAnnouncement", () => {
  it("classifies annual reports", () => {
    assert.strictEqual(
      categorizeNseAnnouncement("Annual Report FY2026", ""),
      "annual_report"
    );
    assert.strictEqual(
      categorizeNseAnnouncement(
        "Submission of Annual Report and Notice of AGM",
        ""
      ),
      "annual_report"
    );
  });

  it("classifies investor / analyst presentations & meets", () => {
    assert.strictEqual(
      categorizeNseAnnouncement("Investor Presentation - Q3 FY26", ""),
      "investor_presentation"
    );
    assert.strictEqual(
      categorizeNseAnnouncement("Schedule of Analyst Meet", ""),
      "investor_presentation"
    );
    assert.strictEqual(
      categorizeNseAnnouncement("Investor Meet Intimation", ""),
      "investor_presentation"
    );
  });

  it("classifies credit-rating intimations (keyword + agencies)", () => {
    assert.strictEqual(
      categorizeNseAnnouncement("Credit Rating Update", ""),
      "credit_rating"
    );
    assert.strictEqual(
      categorizeNseAnnouncement("Intimation", "CRISIL reaffirms AAA rating"),
      "credit_rating"
    );
    assert.strictEqual(
      categorizeNseAnnouncement("ICRA revises outlook to Stable", ""),
      "credit_rating"
    );
    assert.strictEqual(
      categorizeNseAnnouncement("India Ratings assigns IND AA", ""),
      "credit_rating"
    );
    assert.strictEqual(
      categorizeNseAnnouncement("Revision in rating", ""),
      "credit_rating"
    );
    // Bare "rating" with a rating-ACTION verb (no agency, no "credit") still counts.
    assert.strictEqual(
      categorizeNseAnnouncement("Rating downgraded to A", ""),
      "credit_rating"
    );
  });

  it("does NOT bucket non-credit 'rating' filings (ESG / product / perf) as credit_rating", () => {
    // Bare "rating(s)" with no "credit", no rating-action verb, and no agency
    // name must not over-match into credit_rating (MONEY-779 fix).
    assert.strictEqual(
      categorizeNseAnnouncement("ESG Rating disclosure", ""),
      null
    );
    assert.strictEqual(
      categorizeNseAnnouncement("Product quality rating awarded", ""),
      null
    );
    assert.strictEqual(
      categorizeNseAnnouncement("Customer satisfaction ratings improve", ""),
      null
    );
  });

  it("classifies earnings-call / concall intimations", () => {
    assert.strictEqual(
      categorizeNseAnnouncement("Intimation of Earnings Call", ""),
      "earnings_call_intimation"
    );
    assert.strictEqual(
      categorizeNseAnnouncement("Q3 Concall Intimation", ""),
      "earnings_call_intimation"
    );
    assert.strictEqual(
      categorizeNseAnnouncement("Conference Call with Analysts", ""),
      "earnings_call_intimation"
    );
  });

  it("classifies press / media releases", () => {
    assert.strictEqual(
      categorizeNseAnnouncement("Press Release - Q3 Results", ""),
      "press_release"
    );
    assert.strictEqual(
      categorizeNseAnnouncement("Media Release on new plant", ""),
      "press_release"
    );
  });

  it("drops noise (board meetings, trading window, etc.) → null", () => {
    assert.strictEqual(
      categorizeNseAnnouncement("Board Meeting Intimation", ""),
      null
    );
    assert.strictEqual(
      categorizeNseAnnouncement("Closure of Trading Window", ""),
      null
    );
    assert.strictEqual(categorizeNseAnnouncement("", ""), null);
  });

  it("annual report wins over a competing 'press release' mention (order)", () => {
    assert.strictEqual(
      categorizeNseAnnouncement(
        "Annual Report",
        "see attached press release for details"
      ),
      "annual_report"
    );
  });
});

// ── categorizeAnnouncements ────────────────────────────────────────────────

describe("categorizeAnnouncements", () => {
  const mk = (overrides: Partial<NSEFiling>): NSEFiling => ({
    symbol: "RELIANCE",
    title: "",
    description: "",
    attachmentUrl: null,
    filingDate: new Date("2026-06-15"),
    category: "General",
    ...overrides,
  });

  it("buckets each useful filing into its docType and drops the noise", () => {
    const out = categorizeAnnouncements([
      mk({ title: "Annual Report FY2026" }),
      mk({ title: "Investor Presentation Q3" }),
      mk({ title: "CRISIL rating reaffirmed" }),
      mk({ title: "Earnings Call Intimation" }),
      mk({ title: "Press Release on dividend" }),
      mk({ title: "Board Meeting Intimation" }), // noise → dropped
    ]);
    const types = out.map((o) => o.docType);
    assert.deepStrictEqual(types, [
      "annual_report",
      "investor_presentation",
      "credit_rating",
      "earnings_call_intimation",
      "press_release",
    ]);
    // The dropped one is gone.
    assert.strictEqual(out.length, 5);
    // The filing payload is preserved alongside the docType.
    assert.strictEqual(out[0]!.filing.title, "Annual Report FY2026");
  });

  it("returns [] for an empty / all-noise list", () => {
    assert.deepStrictEqual(categorizeAnnouncements([]), []);
    assert.deepStrictEqual(
      categorizeAnnouncements([mk({ title: "Trading Window Closure" })]),
      []
    );
  });
});
