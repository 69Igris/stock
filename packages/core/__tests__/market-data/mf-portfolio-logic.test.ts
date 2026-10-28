/**
 * Tests for the AMC monthly-portfolio parser (MONEY-1104).
 *
 * These run against the REAL published files from the four largest AMCs by AUM,
 * committed under `__tests__/fixtures/amc/`. That matters: every assertion here
 * is a deformity that actually shipped, and a synthetic workbook would have
 * quietly agreed with whatever the parser did. Each regression block names the
 * silent-wrong-answer it exists to prevent.
 *
 * Runtime note: the fixtures are 155 KB – 4 MB and total ~330 worksheets, so
 * the whole-file parses cost roughly 1.5–2 s combined. Full parses are memoised
 * per fixture and the per-sheet tests use `onlySheets`, which keeps the file at
 * a few seconds. Everything is synchronous — no timers, no promises, nothing to
 * orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classifyIndustryOrRating,
  detectWorkbookFormat,
  excelSerialToIsoDate,
  isPercentHeader,
  parseAmcPortfolioWorkbook,
  parseAsOfDate,
  resolvePercentScale,
  type AmcPortfolioFile,
  type AmcSchemeSheet,
} from "../../src/market-data/mf-portfolio-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "amc");

const HDFC_FILE = "hdfc-value-fund-2026-07.xlsx";
const NIPPON_FILE = "nippon-monthly-portfolio-2026-07.xls";
const SBI_FILE = "sbi-all-schemes-2026-07.xlsx";
const ABSL_FILE = "absl-monthly-portfolio-2026-07.zip";

const bytesCache = new Map<string, Buffer>();
function fixture(name: string): Buffer {
  let b = bytesCache.get(name);
  if (!b) {
    b = readFileSync(join(FIXTURES, name));
    bytesCache.set(name, b);
  }
  return b;
}

/** Memoised whole-file parse — the SBI workbook alone is 122 sheets. */
const parseCache = new Map<string, AmcPortfolioFile>();
function parseFull(name: string): AmcPortfolioFile {
  let p = parseCache.get(name);
  if (!p) {
    const parsed = parseAmcPortfolioWorkbook(fixture(name));
    assert.ok(parsed, `${name} must parse`);
    p = parsed;
    parseCache.set(name, p);
  }
  return p;
}

/**
 * Warm every whole-file parse ONCE, at module scope, before any test runs.
 *
 * ## Why this is here and not left to lazy memoisation
 *
 * `--test-timeout` is per TEST and measured in WALL CLOCK. With lazy
 * memoisation, whichever test happens to touch a fixture first pays that
 * workbook's entire parse while every other test pays nothing — so the cost is
 * both large and attributed to an arbitrary test. Locally that test measures
 * ~1.8 s, which is invisible. On a contended CI runner (this suite ran 104 s
 * against ~15 s locally, while 28 turbo tasks and a 19,600-test web suite share
 * two cores) the same CPU-bound parse can stretch past the 30 s deadline.
 *
 * When that happens the runner reports the test as CANCELLED, not failed, and
 * the file is torn down — so the other 59 tests never report at all. That is
 * exactly the signature this file produced in CI: `# fail 0`, `# cancelled 1`,
 * and 59 tests missing from a total that otherwise matched.
 *
 * Module-scope work runs during import, which no per-test deadline governs, so
 * moving the parses here removes the exposure entirely. Nothing is skipped,
 * no timeout is relaxed and no assertion changes — the same four workbooks are
 * parsed by the same function, just not on a test's clock.
 *
 * The alternative — raising `--test-timeout` — would have hidden the real
 * property (one test silently carrying seconds of shared setup) rather than
 * removing it, and would have raised the deadline for every unrelated test in
 * the package.
 */
for (const f of [HDFC_FILE, NIPPON_FILE, SBI_FILE, ABSL_FILE]) parseFull(f);

/**
 * Parse a single sheet — much cheaper than the whole workbook, but NOT free:
 * even a narrowed parse still opens and scans the archive, which for SBI's
 * 2.6 MB / 122-sheet book is a few hundred ms. Memoised for the same reason
 * `parseFull` is — several suites ask for the same four (file, sheet) pairs,
 * and repeating that work put ~1.9 s on individual tests against a 30 s
 * wall-clock deadline (see the warm-up note above).
 *
 * Sharing one parsed object across tests is safe here and is already how
 * `parseFull` behaves: every assertion in this file is read-only, and the
 * purity suite at the bottom pins that the parser does not mutate its input.
 */
const sheetCache = new Map<string, AmcSchemeSheet>();
function parseSheet(file: string, sheet: string): AmcSchemeSheet {
  const key = `${file}::${sheet}`;
  const hit = sheetCache.get(key);
  if (hit) return hit;
  const parsed = parseAmcPortfolioWorkbook(fixture(file), {
    onlySheets: [sheet],
  });
  assert.ok(parsed, `${file} must parse`);
  const s = parsed.sheets.find((x) => x.sheetName === sheet);
  assert.ok(s, `${file} must contain sheet ${sheet}`);
  sheetCache.set(key, s);
  return s;
}

const near = (
  actual: number,
  expected: number,
  tol: number,
  msg: string,
): void => {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg}: expected ~${expected} (±${tol}), got ${actual}`,
  );
};

/* -------------------------------------------------------------------------- */

describe("detectWorkbookFormat", () => {
  it("sniffs a bare OOXML workbook from its zip entry names", () => {
    assert.equal(detectWorkbookFormat(fixture(HDFC_FILE)), "ooxml");
    assert.equal(detectWorkbookFormat(fixture(SBI_FILE)), "ooxml");
  });

  it("REGRESSION: Nippon's `.xls` is really OOXML — the extension AND the Content-Type lie", () => {
    // Served as `application/vnd.ms-excel` named `.xls`, but the first four
    // bytes are `PK\x03\x04`. Anything that branches on the extension parses
    // this file with a BIFF reader and gets nothing. This is THE regression.
    const bytes = fixture(NIPPON_FILE);
    assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
    assert.equal(detectWorkbookFormat(bytes), "ooxml");
  });

  it("distinguishes a zip ARCHIVE containing a workbook from a workbook that IS a zip", () => {
    // Both start `PK\x03\x04`; only the entry names tell them apart.
    assert.equal(detectWorkbookFormat(fixture(ABSL_FILE)), "zip-archive");
    assert.equal(detectWorkbookFormat(fixture(HDFC_FILE)), "ooxml");
  });

  it("recognises a genuine OLE2 workbook", () => {
    // ABSL's INNER file is a real BIFF8 `.xls` — so `.xls` lies in BOTH
    // directions across these four fixtures, which is why only magic bytes are
    // trusted.
    const ole2 = Buffer.from([
      0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00,
    ]);
    assert.equal(detectWorkbookFormat(ole2), "ole2");
  });

  it("returns unknown for non-workbook bytes", () => {
    assert.equal(detectWorkbookFormat(Buffer.from("hello world")), "unknown");
    assert.equal(detectWorkbookFormat(new Uint8Array(0)), "unknown");
    assert.equal(
      detectWorkbookFormat(Buffer.from([0x25, 0x50, 0x44, 0x46])),
      "unknown",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("parseAmcPortfolioWorkbook — failure is not an empty array", () => {
  it("returns null for garbage bytes, never []", () => {
    const result = parseAmcPortfolioWorkbook(
      Buffer.from("this is not a workbook"),
    );
    assert.equal(result, null);
  });

  it("returns null for empty input", () => {
    assert.equal(parseAmcPortfolioWorkbook(new Uint8Array(0)), null);
  });

  it("REGRESSION: a truncated workbook returns null instead of HANGING", () => {
    // Measured: handed the first 512 bytes of a valid .xlsx, `XLSX.read` does
    // not throw and does not return — it spins indefinitely (>120 s, killed).
    // A try/catch cannot rescue a call that never comes back, so incomplete
    // archives are rejected on the end-of-central-directory record before the
    // reader sees them. A short read must fail a job, not wedge a worker.
    const started = Date.now();
    for (const cut of [512, 4096, 100_000]) {
      assert.equal(
        parseAmcPortfolioWorkbook(fixture(SBI_FILE).subarray(0, cut)),
        null,
        `SBI truncated to ${cut} bytes must be null`,
      );
      assert.equal(
        parseAmcPortfolioWorkbook(fixture(ABSL_FILE).subarray(0, cut)),
        null,
      );
    }
    // Dropping only the trailing bytes still kills the EOCD, and must not hang.
    assert.equal(
      parseAmcPortfolioWorkbook(
        fixture(SBI_FILE).subarray(0, fixture(SBI_FILE).length - 100),
      ),
      null,
    );
    assert.ok(
      Date.now() - started < 10_000,
      "rejecting truncated input must be fast, not a timeout",
    );
  });

  it("a successful parse is a real object — callers can tell it from a failure", () => {
    // The whole point: `null` means "could not parse" and an AmcPortfolioFile
    // with `sheets: []` would mean "parsed, found nothing". A caller that sees
    // `[]` for both will happily overwrite a good month with an empty one.
    const parsed = parseAmcPortfolioWorkbook(fixture(HDFC_FILE));
    assert.notEqual(parsed, null);
    assert.ok(Array.isArray(parsed?.sheets));
    assert.ok(parsed!.sheets.length > 0);
  });
});

/* -------------------------------------------------------------------------- */

describe("HDFC — one scheme per file", () => {
  const sheet = () => parseSheet(HDFC_FILE, "HDFCCB");

  it("parses the single sheet with its scheme name and date", () => {
    const parsed = parseFull(HDFC_FILE);
    assert.equal(parsed.format, "ooxml");
    assert.equal(parsed.containerEntryName, null);
    assert.equal(parsed.sheetCount, 1);
    assert.equal(parsed.sheets.length, 1);
    // A single-scheme file has no Index sheet at all.
    assert.deepEqual(parsed.index, []);

    const s = parsed.sheets[0]!;
    assert.match(s.schemeName ?? "", /^HDFC Value Fund/);
    assert.equal(s.asOfDate, "2026-07-31");
    assert.equal(s.holdings.length, 76);
  });

  it("extracts the top holding exactly", () => {
    const h = sheet().holdings[0]!;
    assert.equal(h.isin, "INE090A01021");
    assert.equal(h.instrumentName, "ICICI Bank Ltd.");
    assert.equal(h.industry, "Banks");
    assert.equal(h.rating, null);
    assert.equal(h.quantity, 3_750_000);
    assert.equal(h.marketValueLakhs, 53_827.5);
    assert.equal(h.pctToNav, 6.78);
  });

  it("keeps non-ISIN portfolio lines, including a NEGATIVE one", () => {
    // TREPS and Net Current Assets are real portfolio lines with no ISIN.
    // Dropping them breaks the book: 99.57 (ISIN rows) + 1.17 − 0.74 = 100.00.
    const s = sheet();
    const treps = s.holdings.find((h) => /TREPS/i.test(h.instrumentName));
    assert.ok(treps, "TREPS row must be kept");
    assert.equal(treps.isin, null);
    assert.equal(treps.marketValueLakhs, 9_254.85);

    const nca = s.holdings.find((h) =>
      /Net Current Assets/i.test(h.instrumentName),
    );
    assert.ok(nca, "Net Current Assets row must be kept");
    assert.equal(nca.marketValueLakhs, -5_935.87);
    assert.equal(nca.pctToNav, -0.74);
  });
});

describe("Nippon — 108 sheets behind a lying extension", () => {
  it("parses every scheme sheet and leaves the Index out of the portfolios", () => {
    const parsed = parseFull(NIPPON_FILE);
    assert.equal(parsed.format, "ooxml");
    assert.equal(parsed.sheetCount, 108);
    assert.equal(parsed.sheets.length, 107);
    assert.deepEqual(parsed.nonPortfolioSheets, ["Index"]);
  });

  it("extracts the top holding of the Growth fund", () => {
    const h = parseSheet(NIPPON_FILE, "GF").holdings[0]!;
    assert.equal(h.isin, "INE171A01029");
    assert.equal(h.instrumentName, "The Federal Bank Limited");
    assert.equal(h.industry, "Banks");
    assert.equal(h.quantity, 41_000_000);
    assert.equal(h.marketValueLakhs, 147_128.5);
    // Stored as the fraction 0.029; normalised to percent.
    near(h.pctToNav!, 2.9, 1e-9, "Nippon pct");
  });

  it("reads its own internal scheme code from the sheet, since the Index has none", () => {
    const s = parseSheet(NIPPON_FILE, "GF");
    assert.equal(s.schemeCode, "RLMF001");
    assert.match(s.schemeName ?? "", /^Nippon India Growth Mid Cap Fund/);
    assert.equal(s.asOfDate, "2026-07-31");
  });
});

describe("SBI — 122 sheets", () => {
  it("parses every scheme sheet", () => {
    const parsed = parseFull(SBI_FILE);
    assert.equal(parsed.sheetCount, 122);
    assert.equal(parsed.sheets.length, 121);
    assert.deepEqual(parsed.nonPortfolioSheets, ["Index"]);
  });

  it("extracts the top holding and the scheme's own code", () => {
    const s = parseSheet(SBI_FILE, "SMEEF");
    assert.equal(s.schemeName, "SBI ESG Exclusionary Strategy Fund");
    assert.equal(s.schemeCode, "007");
    assert.equal(s.asOfDate, "2026-07-31");

    const h = s.holdings[0]!;
    assert.equal(h.isin, "INE090A01021");
    assert.equal(h.instrumentName, "ICICI Bank Ltd.");
    assert.equal(h.quantity, 3_390_000);
    assert.equal(h.marketValueLakhs, 48_660.06);
    assert.equal(h.pctToNav, 8.9);
    // SBI and ABSL share this instrument-code namespace (both call ICICI 100012).
    assert.equal(h.amcInstrumentCode, "100012");
  });
});

describe("ABSL — a zip wrapping an OLE2 workbook", () => {
  it("unwraps the archive and parses the inner .xls", () => {
    const parsed = parseFull(ABSL_FILE);
    assert.equal(parsed.format, "zip-archive");
    assert.equal(
      parsed.containerEntryName,
      "ABSL_Monthly_Portfolio_Report_July 2026.xls",
    );
    assert.equal(parsed.sheetCount, 105);
    assert.equal(parsed.sheets.length, 104);
  });

  it("extracts the top holding of the '95 fund", () => {
    const s = parseSheet(ABSL_FILE, "BSL95F");
    assert.equal(s.schemeName, "ADITYA BIRLA SUN LIFE EQUITY HYBRID '95 FUND");
    assert.equal(s.asOfDate, "2026-07-31");

    const h = s.holdings[0]!;
    assert.equal(h.isin, "INE090A01021");
    assert.equal(h.quantity, 3_250_000);
    assert.equal(h.marketValueLakhs, 46_650.5);
    // Stored as 0.0647006940593613 — a fraction.
    near(h.pctToNav!, 6.47006940593613, 1e-9, "ABSL pct");
    assert.equal(h.amcInstrumentCode, "100012");
  });
});

/* -------------------------------------------------------------------------- */

describe("REGRESSION: the combined Industry/Rating column (trap 3)", () => {
  // SBI writes `Rating / Industry^`; ABSL `Industry^ / Rating`; Nippon
  // `Industry / Rating`; HDFC `Industry+ /Rating`. It is ONE column. A mapper
  // that keys on which word comes FIRST files SBI's equities under `rating` and
  // everyone else's under `industry` — a silent field swap. Content decides.

  it("SBI's reversed header still puts an INDUSTRY in `industry` for equity", () => {
    const s = parseSheet(SBI_FILE, "SMEEF");
    assert.equal(
      s.headers[2],
      "Rating / Industry^",
      "the header really is reversed",
    );
    const h = s.holdings[0]!;
    assert.equal(h.industry, "Banks");
    assert.equal(h.rating, null);
  });

  it("SBI's reversed header still puts a RATING in `rating` for debt", () => {
    const s = parseSheet(SBI_FILE, "SMIF");
    assert.equal(s.headers[2], "Rating / Industry^");
    const h = s.holdings[0]!;
    assert.equal(h.instrumentName, "Muthoot Finance Ltd.");
    assert.equal(h.rating, "CRISIL AA+");
    assert.equal(h.industry, null);
  });

  it("the other three word-orders land in the same fields", () => {
    const nippon = parseSheet(NIPPON_FILE, "IP");
    assert.equal(nippon.headers[2], "Industry / Rating");
    assert.equal(nippon.holdings[0]!.rating, "CRISIL AAA");
    assert.equal(nippon.holdings[0]!.industry, null);

    const absl = parseSheet(ABSL_FILE, "BSL95F");
    assert.equal(absl.headers[2], "Industry^ / Rating");
    assert.equal(absl.holdings[0]!.industry, "Banks");
    assert.equal(absl.holdings[0]!.rating, null);

    const hdfc = parseSheet(HDFC_FILE, "HDFCCB");
    assert.equal(hdfc.headers[3], "Industry+ /Rating");
    assert.equal(hdfc.holdings[0]!.industry, "Banks");
    assert.equal(hdfc.holdings[0]!.rating, null);
  });

  it("classifies government paper as SOVEREIGN rather than an industry", () => {
    const gsec = parseSheet(NIPPON_FILE, "IP").holdings.find(
      (h) => h.isin === "IN0020260025",
    );
    assert.ok(gsec, "the G-Sec row must be present");
    assert.equal(gsec.rating, "SOVEREIGN");
    assert.equal(gsec.industry, null);
  });

  it("classifyIndustryOrRating separates the two vocabularies directly", () => {
    for (const rating of [
      "CRISIL AAA",
      "ICRA AA+",
      "[ICRA]AA+",
      "CARE A(CE)",
      "IND AAA(SO)",
      "CRISIL A1+",
      "SOVEREIGN",
      "Sovereign",
      "Unrated",
    ]) {
      const out = classifyIndustryOrRating(rating);
      assert.equal(out.rating, rating, `${rating} must be a rating`);
      assert.equal(out.industry, null, `${rating} must not be an industry`);
    }

    for (const industry of [
      "Banks",
      "IT - Software",
      "Petroleum Products",
      "Pharmaceuticals & Biotechnology",
      "Capital Markets",
      "Healthcare Services",
      "Consumer Durables",
      "Telecom - Services",
    ]) {
      const out = classifyIndustryOrRating(industry);
      assert.equal(out.industry, industry, `${industry} must be an industry`);
      assert.equal(out.rating, null, `${industry} must not be a rating`);
    }

    assert.deepEqual(classifyIndustryOrRating(""), {
      industry: null,
      rating: null,
    });
  });

  it("REGRESSION: an industry containing a rating-agency's NAME is still an industry", () => {
    // Detecting ratings by agency name matched `\bcare\b` inside these five
    // real NSE industries and filed them as credit ratings — the very
    // industry/rating swap this module exists to prevent, arriving through the
    // back door. Grades are detected instead, case-sensitively, so `Care`
    // cannot be read as the grade `C`.
    for (const industry of [
      "Personal Care Products",
      "Health Care Equipment",
      "Managed Health Care",
      "Health Care Distributors",
      "Health Care Technology",
    ]) {
      const out = classifyIndustryOrRating(industry);
      assert.equal(out.industry, industry, `${industry} must stay an industry`);
      assert.equal(out.rating, null, `${industry} must not become a rating`);
    }
  });

  it("no industry anywhere in the fixtures is filed as a rating", () => {
    // The sweep that found the bug above, kept as a standing guard: every value
    // classified as a rating must end in a real grade or be sovereign/unrated.
    const ratings = new Set<string>();
    for (const file of [HDFC_FILE, NIPPON_FILE, SBI_FILE, ABSL_FILE]) {
      for (const s of parseFull(file).sheets) {
        for (const h of s.holdings) if (h.rating) ratings.add(h.rating);
      }
    }
    assert.ok(
      ratings.size > 20,
      "the fixtures must contain plenty of debt ratings",
    );
    for (const r of ratings) {
      assert.match(
        r,
        /(?:^|[\s\])])(?:AAA|AA|A[1-4]|A|BBB|BB|B|C|D)\s*[+-]?\s*(?:\((?:CE|SO)\))?$|^sovereign$|^unrated$/i,
        `"${r}" was classified as a rating but does not look like one`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("REGRESSION: the percentage column's three spellings and its newlines", () => {
  it("maps all three published spellings to one field (traps 2 + 4)", () => {
    assert.ok(isPercentHeader("% to NAV"), "HDFC + Nippon");
    assert.ok(isPercentHeader("% to AUM"), "SBI + ABSL");
    // The third SEBI spelling. NOT present in these four fixtures — matched
    // defensively so a fifth AMC does not silently lose its weights.
    assert.ok(isPercentHeader("% to Net Assets"), "third SEBI spelling");
    assert.ok(isPercentHeader("%to NAV"));
  });

  it("matches a header cell containing an EMBEDDED NEWLINE (trap 5)", () => {
    // Verbatim from ABSL's `BSLMTP` sheet.
    assert.ok(isPercentHeader("% to AUM \non 31JUL26"));
    assert.ok(isPercentHeader("%\nto\nNAV"));
  });

  it("does not match neighbouring columns", () => {
    for (const notPercent of [
      "YTM %",
      "YTC % ##",
      "Quantity",
      "ISIN",
      "Yield",
      "",
    ]) {
      assert.equal(
        isPercentHeader(notPercent),
        false,
        `${notPercent} is not the % column`,
      );
    }
  });

  it("the newline-bearing value header is still found on the real sheets", () => {
    // `Market value\n(Rs. in Lakhs)` — if the newline broke matching, the
    // market-value column would be reported missing.
    for (const [file, sheet] of [
      [SBI_FILE, "SMEEF"],
      [ABSL_FILE, "BSL95F"],
      [NIPPON_FILE, "GF"],
      [HDFC_FILE, "HDFCCB"],
    ] as const) {
      const s = parseSheet(file, sheet);
      assert.deepEqual(
        s.missingColumns,
        [],
        `${file}/${sheet} must map every column`,
      );
      assert.notEqual(s.columns.marketValue, null);
      assert.notEqual(s.columns.percent, null);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("REGRESSION: the percent SCALE — a silent 100x (trap 3 in the module header)", () => {
  // SBI/HDFC store `6.78` for 6.78%. Nippon/ABSL store `0.0647` for 6.47%,
  // because the cell is percent-FORMATTED. Both parse as fine numbers, so the
  // error is invisible: read naively, ABSL's entire book is understated 100x.

  it("detects the scale each AMC actually used, from the number format", () => {
    for (const [file, sheet, expected] of [
      [HDFC_FILE, "HDFCCB", "percent"],
      [SBI_FILE, "SMEEF", "percent"],
      [NIPPON_FILE, "GF", "fraction"],
      [ABSL_FILE, "BSL95F", "fraction"],
    ] as const) {
      const s = parseSheet(file, sheet);
      assert.equal(s.percentScale, expected, `${file}/${sheet} scale`);
      assert.equal(
        s.percentScaleSource,
        "number-format",
        `${file}/${sheet} source`,
      );
    }
  });

  it("normalises both scales onto 0–100, so every book sums to ~100%", () => {
    for (const [file, sheet] of [
      [HDFC_FILE, "HDFCCB"],
      [SBI_FILE, "SMEEF"],
      [NIPPON_FILE, "GF"],
      [ABSL_FILE, "BSL95F"],
    ] as const) {
      const s = parseSheet(file, sheet);
      near(s.percentSum!, 100, 1.5, `${file}/${sheet} percent sum`);
    }
  });

  it("the number format WINS over the column sum — the sum is wrong on real sheets", () => {
    // Measured: format and sum agree on 305 of 330 sheets, and where they
    // disagree the SUM is the liar. SBI's `SOF` is an overnight fund holding 6
    // instruments that sum to 3.55% — genuinely percent, but a sum-first rule
    // calls it a fraction and inflates the book 100x.
    const sof = parseSheet(SBI_FILE, "SOF");
    assert.equal(sof.percentScale, "percent");
    assert.equal(sof.percentScaleSource, "number-format");

    // And directly: a percent-formatted cell is a fraction no matter how the
    // values happen to sum.
    assert.deepEqual(
      resolvePercentScale([0.05, 0.03], ["#,##0.00%", "#,##0.00%"]),
      {
        scale: "fraction",
        source: "number-format",
      },
    );
    assert.deepEqual(resolvePercentScale([3.55], ["#,##0.00"]), {
      scale: "percent",
      source: "number-format",
    });
  });

  it("falls back to the column sum only when no number format exists, and says so", () => {
    assert.deepEqual(resolvePercentScale([60, 39], []), {
      scale: "percent",
      source: "column-sum",
    });
    assert.deepEqual(resolvePercentScale([0.6, 0.39], []), {
      scale: "fraction",
      source: "column-sum",
    });
    // Neither signal usable → flagged as unverified rather than quietly chosen.
    assert.deepEqual(resolvePercentScale([], []), {
      scale: "percent",
      source: "assumed",
    });
    assert.deepEqual(resolvePercentScale([7], []), {
      scale: "percent",
      source: "assumed",
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("REGRESSION: a portfolio sheet holds more than one table (trap 6)", () => {
  it("stops at GRAND TOTAL and excludes the 'securities in default' table", () => {
    // ABSL's `BSLMTP` prints a SEBI default-disclosure table below the
    // holdings, with its own header and a rupee amount where `% to AUM` sits.
    // Scanning to end-of-sheet summed that column to 1,451,238,937.
    const s = parseSheet(ABSL_FILE, "BSLMTP");
    assert.equal(
      s.holdings.some((h) => /IL&FS Tamil Nadu/i.test(h.instrumentName)),
      false,
      "rows from the default-disclosure table must not be holdings",
    );
    near(s.percentSum!, 100, 1.5, "BSLMTP percent sum");
  });

  it("excludes the annexures that follow the grand total", () => {
    // SBI's `SEHF` lists interest-rate-swap counterparties below the total,
    // whose column 7 is a NOTIONAL (25,000) — it summed to 105,300.
    const s = parseSheet(SBI_FILE, "SEHF");
    near(s.percentSum!, 100, 1.5, "SEHF percent sum");
    assert.equal(
      s.holdings.some((h) => /Derivatives Total/i.test(h.instrumentName)),
      false,
    );
  });

  it("excludes subtotal and total rows, which would double-count the book", () => {
    // Every sheet summed to ~300% before this: holdings + section subtotals +
    // the grand total.
    const s = parseSheet(SBI_FILE, "SMEEF");
    for (const h of s.holdings) {
      assert.doesNotMatch(
        h.instrumentName,
        /^(sub\s*total|total|grand\s*total)/i,
        `aggregate row leaked in: ${h.instrumentName}`,
      );
    }
  });

  it("captures the grand total as the scheme AUM instead of discarding it", () => {
    assert.equal(parseSheet(SBI_FILE, "SMEEF").totalAumLakhs, 546_960.98);
    assert.equal(parseSheet(ABSL_FILE, "BSL95F").totalAumLakhs, 721_020.09);
  });
});

/* -------------------------------------------------------------------------- */

describe("holdings reconcile to the published AUM", () => {
  // The strongest available check, and independent of every heuristic above: if
  // a row were missed, double-counted, dropped as an aggregate when it was a
  // holding, or read from the wrong column, the money would not add up.
  //
  // Measured worst case per AMC (relative error, all 333 portfolio sheets):
  //   HDFC 0 · SBI 9.3e-16 · ABSL 1.4e-15   — float noise; exact.
  //   Nippon 3.7e-6                         — Nippon's own rounding: it prints
  //     the GRAND TOTAL at full precision (726.0717809) over rows rounded to
  //     two decimals (726.07).
  //
  // 1e-5 absorbs that and stays ~10x tighter than the smallest error a real row
  // omission could produce (dropping even a 0.01%-of-AUM line gives 1e-4).
  const TOLERANCE = 1e-5;

  for (const file of [HDFC_FILE, NIPPON_FILE, SBI_FILE, ABSL_FILE]) {
    it(`${file}: sum(marketValueLakhs) == GRAND TOTAL on every sheet`, () => {
      const parsed = parseFull(file);
      assert.ok(parsed.sheets.length > 0);
      let checked = 0;
      for (const s of parsed.sheets) {
        if (s.totalAumLakhs === null || s.totalAumLakhs === 0) continue;
        const sum = s.holdings.reduce(
          (a, h) => a + (h.marketValueLakhs ?? 0),
          0,
        );
        const rel = Math.abs(sum - s.totalAumLakhs) / Math.abs(s.totalAumLakhs);
        assert.ok(
          rel < TOLERANCE,
          `${file}/${s.sheetName}: sum(mv)=${sum} vs AUM=${s.totalAumLakhs} (rel ${rel})`,
        );
        checked++;
      }
      assert.ok(checked > 0, "at least one sheet must carry an AUM");
    });
  }

  it("every sheet in every fixture carries a GRAND TOTAL", () => {
    // If the terminator stopped matching, the AUM would go quietly null rather
    // than wrong — this is the canary for that.
    for (const file of [HDFC_FILE, NIPPON_FILE, SBI_FILE, ABSL_FILE]) {
      for (const s of parseFull(file).sheets) {
        assert.ok(
          s.totalAumLakhs !== null && Number.isFinite(s.totalAumLakhs),
          `${file}/${s.sheetName} has no AUM`,
        );
      }
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the as-of date, in all four encodings (trap 7)", () => {
  it("reads every sheet's date across all four AMCs", () => {
    for (const file of [HDFC_FILE, NIPPON_FILE, SBI_FILE, ABSL_FILE]) {
      const parsed = parseFull(file);
      for (const s of parsed.sheets) {
        assert.equal(
          s.asOfDate,
          "2026-07-31",
          `${file}/${s.sheetName} as-of date`,
        );
      }
    }
  });

  it("converts an Excel serial without a timezone in the loop", () => {
    // SBI stores 46234. Via `sheet_to_json` this becomes a Date built in the
    // RUNNER's timezone — `2026-07-30T18:30:00Z` under IST, i.e. the month-end
    // date off by one, only east of UTC. Serial arithmetic has no such failure.
    assert.equal(excelSerialToIsoDate(46234), "2026-07-31");
    assert.equal(parseAsOfDate(46234), "2026-07-31");
    assert.equal(excelSerialToIsoDate(0), null);
    assert.equal(excelSerialToIsoDate(Number.NaN), null);
    assert.equal(excelSerialToIsoDate(Number.POSITIVE_INFINITY), null);
  });

  it("parses the three prose spellings", () => {
    assert.equal(parseAsOfDate("Portfolio as on 31-Jul-2026"), "2026-07-31");
    // Nippon omits the space after the comma.
    assert.equal(
      parseAsOfDate("Monthly Portfolio Statement as on July 31,2026"),
      "2026-07-31",
    );
    assert.equal(
      parseAsOfDate("Portfolio Statement as on July 31, 2026"),
      "2026-07-31",
    );
  });

  it("returns null rather than a guess for unparseable dates", () => {
    assert.equal(parseAsOfDate("as on the last business day"), null);
    assert.equal(parseAsOfDate(""), null);
    assert.equal(parseAsOfDate(null), null);
    assert.equal(parseAsOfDate(undefined), null);
  });
});

/* -------------------------------------------------------------------------- */

describe("non-finite cells become null, never 0", () => {
  it("keeps `NIL` out of the numbers", () => {
    // Every SBI scheme prints `NIL` in the numeric columns of its empty
    // sections. A fund that holds nothing is not a fund that holds zero rupees:
    // collapsing the two lets "no data" average into aggregates as a real zero.
    const s = parseSheet(SBI_FILE, "SOF");
    for (const h of s.holdings) {
      assert.notEqual(h.instrumentName, "");
      for (const v of [h.quantity, h.marketValueLakhs, h.pctToNav]) {
        assert.ok(
          v === null || Number.isFinite(v),
          `${h.instrumentName} has a non-finite number`,
        );
      }
    }
  });

  it("an absent value is null, not a defaulted zero", () => {
    // HDFC's TREPS line genuinely has no quantity — it must read `null`, which
    // is distinguishable from a real zero holding.
    const treps = parseSheet(HDFC_FILE, "HDFCCB").holdings.find((h) =>
      /TREPS/i.test(h.instrumentName),
    );
    assert.ok(treps);
    assert.equal(treps.quantity, null);
    assert.notEqual(treps.quantity, 0);
  });

  it("no parsed number anywhere is NaN or Infinity", () => {
    for (const file of [HDFC_FILE, NIPPON_FILE, SBI_FILE, ABSL_FILE]) {
      for (const s of parseFull(file).sheets) {
        for (const v of [s.percentSum, s.totalAumLakhs]) {
          assert.ok(
            v === null || Number.isFinite(v),
            `${file}/${s.sheetName} sheet total`,
          );
        }
        for (const h of s.holdings) {
          for (const v of [h.quantity, h.marketValueLakhs, h.pctToNav]) {
            assert.ok(
              v === null || Number.isFinite(v),
              `${file}/${s.sheetName}/${h.instrumentName}`,
            );
          }
        }
      }
    }
  });

  it("missing columns are reported, not defaulted", () => {
    const s = parseSheet(HDFC_FILE, "HDFCCB");
    assert.ok(Array.isArray(s.missingColumns));
    // All four fixtures publish every expected column; the field exists so a
    // future AMC that drops one is VISIBLY missing rather than silently 0/"".
    assert.deepEqual(s.missingColumns, []);
  });
});

/* -------------------------------------------------------------------------- */

describe("scheme identity", () => {
  it("SBI and ABSL publish an AMC-internal code; Nippon publishes none", () => {
    const sbi = parseFull(SBI_FILE).index;
    assert.equal(sbi.length, 121);
    assert.deepEqual(sbi[0], {
      schemeCode: "007",
      shortCode: "SMEEF",
      schemeName: "SBI ESG Exclusionary Strategy Fund",
    });

    const absl = parseFull(ABSL_FILE).index;
    assert.deepEqual(absl[0], {
      schemeCode: "AB001",
      shortCode: "BSL95F",
      schemeName: "ADITYA BIRLA SUN LIFE EQUITY HYBRID '95 FUND",
    });

    // Nippon's Index is two columns — no code at all.
    const nippon = parseFull(NIPPON_FILE).index;
    assert.equal(nippon.length, 107);
    assert.equal(nippon[0]!.schemeCode, null);
    assert.equal(nippon[0]!.shortCode, "GF");
    assert.match(nippon[0]!.schemeName, /^Nippon India Growth Mid Cap Fund/);
  });

  it("every Index short code resolves to a real portfolio sheet — the only firm join", () => {
    // No AMFI code appears anywhere in any fixture, so the short code (== the
    // worksheet name) is the only non-fuzzy identifier available in-file.
    for (const file of [NIPPON_FILE, SBI_FILE, ABSL_FILE]) {
      const parsed = parseFull(file);
      const sheetNames = new Set(parsed.sheets.map((s) => s.sheetName));
      for (const entry of parsed.index) {
        assert.ok(
          entry.shortCode && sheetNames.has(entry.shortCode),
          `${file}: index short code ${entry.shortCode} has no sheet`,
        );
        assert.ok(entry.schemeName.length > 0);
      }
    }
  });

  it("no ISIN-shaped string is mistaken for a scheme code", () => {
    // The instrument-code column sits next to the name on Nippon, but so does
    // ISIN — a positional read lands on the wrong one.
    const h = parseSheet(NIPPON_FILE, "GF").holdings[0]!;
    assert.equal(h.amcInstrumentCode, "FEBA02");
    assert.notEqual(h.amcInstrumentCode, h.isin);
  });

  it("HDFC's marker glyph column is not read as an instrument code", () => {
    // HDFC's headerless first column holds "|" marking traded securities.
    for (const h of parseSheet(HDFC_FILE, "HDFCCB").holdings) {
      assert.notEqual(h.amcInstrumentCode, "|");
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("purity", () => {
  it("does not mutate the input bytes", () => {
    const original = readFileSync(join(FIXTURES, HDFC_FILE));
    const working = Buffer.from(original);
    parseAmcPortfolioWorkbook(working);
    assert.ok(working.equals(original), "input buffer must not be modified");
  });

  it("is deterministic — same bytes in, same data out", () => {
    const bytes = fixture(HDFC_FILE);
    const a = parseAmcPortfolioWorkbook(bytes);
    const b = parseAmcPortfolioWorkbook(bytes);
    assert.deepEqual(a, b);
  });

  it("accepts a plain Uint8Array as well as a Buffer", () => {
    const buf = fixture(HDFC_FILE);
    const view = new Uint8Array(buf.byteLength);
    view.set(buf);
    assert.equal(detectWorkbookFormat(view), "ooxml");
    const parsed = parseAmcPortfolioWorkbook(view);
    assert.ok(parsed);
    assert.equal(parsed.sheets.length, 1);
  });

  it("onlySheets narrows the work without changing the result", () => {
    const full = parseFull(HDFC_FILE);
    const narrowed = parseAmcPortfolioWorkbook(fixture(HDFC_FILE), {
      onlySheets: ["HDFCCB"],
    });
    assert.ok(narrowed);
    assert.deepEqual(narrowed.sheets, full.sheets);
  });

  it("maxHoldingsPerSheet caps output without failing", () => {
    const parsed = parseAmcPortfolioWorkbook(fixture(HDFC_FILE), {
      onlySheets: ["HDFCCB"],
      maxHoldingsPerSheet: 5,
    });
    assert.ok(parsed);
    assert.equal(parsed.sheets[0]!.holdings.length, 5);
  });
});
