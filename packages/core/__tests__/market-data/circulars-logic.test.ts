/**
 * Tests for circulars-logic.ts (MONEY-1187, Data Engine P11 item 7).
 *
 * Fixtures are REAL bytes from `https://www.nseindia.com/api/circulars`,
 * captured 2026-08-13 — not invented shapes. Two windows are pinned because the
 * pair is the point:
 *
 *   circulars-wide.sample.json   24 records sampled from a 237-record
 *                                01-08-2026 → 13-08-2026 response, chosen to
 *                                cover every observed department/category pair.
 *   circulars-empty.sample.json  the VERBATIM 08-08-2026 → 09-08-2026
 *                                (Saturday/Sunday) response: HTTP 200,
 *                                `{"data":[],…}`.
 *
 * The empty one is the load-bearing fixture. "NSE published nothing" and "we
 * could not read the response" must not be the same value, and the only way to
 * prove that is against a real empty response rather than a hand-written `{}`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseCircularsResponse,
  parseCircularDate,
  parseFileSizeLabel,
  classifyCircular,
  countByTopic,
  CIRCULAR_TOPICS,
  type CircularTopic,
} from "../../src/market-data/circulars-logic";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "circulars");

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as unknown;

const WIDE = readFixture("circulars-wide.sample.json");
const EMPTY = readFixture("circulars-empty.sample.json");

/** Classifier input shorthand — most cases only vary the subject. */
const c = (
  subject: string,
  department = "",
  category = "",
): { subject: string; department: string; category: string } => ({
  subject,
  department,
  category,
});

// ─── The real response ───────────────────────────────────────────────

describe("parseCircularsResponse — real NSE response", () => {
  it("parses every row of the live fixture with no rejects", () => {
    const file = parseCircularsResponse(WIDE);
    assert.ok(file !== null, "wrapped response must parse");
    assert.equal(file.outcome, "ROWS");
    assert.equal(file.circulars.length, 24);
    assert.deepEqual(file.rejected, []);
    assert.equal(file.fromDate, "01-08-2026");
    assert.equal(file.toDate, "13-08-2026");
  });

  it("extracts the concrete fields of a known circular (NSE/CML/75737)", () => {
    const file = parseCircularsResponse(WIDE);
    assert.ok(file !== null);

    const row = file.circulars.find((x) => x.number === "75737");
    assert.ok(row !== undefined, "75737 must be present");

    assert.equal(row.displayNumber, "NSE/CML/75737");
    assert.equal(row.subject, "Listing of further issues of securities");
    assert.equal(row.department, "Listing");
    assert.equal(row.departmentCode, "CML");
    assert.equal(row.category, "Listing");
    assert.equal(row.company, "NSE");
    assert.equal(row.issuedDateLabel, "August 13, 2026");
    assert.equal(row.issuedAt.toISOString(), "2026-08-13T00:00:00.000Z");
    assert.equal(row.topic, "LISTING");

    assert.ok(row.attachment !== null, "75737 links a PDF");
    assert.equal(
      row.attachment.url,
      "https://nsearchives.nseindia.com/content/circulars/CML75737.pdf",
    );
    assert.equal(row.attachment.filename, "CML75737.pdf");
    assert.equal(row.attachment.ext, "pdf");
    assert.equal(row.attachment.sizeLabel, "366 KB");
  });

  it("distinguishes NCL (clearing corp) circulars from NSE ones", () => {
    const file = parseCircularsResponse(WIDE);
    assert.ok(file !== null);
    const companies = new Set(file.circulars.map((x) => x.company));
    // Both issuers appear in the live window; neither is ever blank.
    assert.ok(companies.has("NSE"));
    assert.ok(!companies.has(""), "company must never be defaulted to empty");
  });

  it("dates land on UTC midnight, never local midnight", () => {
    const file = parseCircularsResponse(WIDE);
    assert.ok(file !== null);
    for (const row of file.circulars) {
      assert.equal(
        row.issuedAt.getTime() % 86_400_000,
        0,
        `${row.number} is not on a UTC-midnight boundary`,
      );
    }
  });

  it("REGRESSION: circNumber is NOT unique — the key is (number, department)", () => {
    // NSE re-issues one circular under every department it applies to: 75736
    // appears under both "Listing" and "Emerge" with the same subject. A store
    // that upserts on circNumber alone silently drops one of the two (or churns
    // between them). This pins the real cardinality so the DB half cannot
    // assume otherwise.
    const file = parseCircularsResponse(WIDE);
    assert.ok(file !== null);

    const shared = file.circulars.filter((x) => x.number === "75736");
    assert.equal(shared.length, 2, "75736 is issued under two departments");
    assert.deepEqual(shared.map((x) => x.department).sort(), [
      "Emerge",
      "Listing",
    ]);

    const pairs = new Set(
      file.circulars.map((x) => `${x.number}|${x.department}`),
    );
    assert.equal(
      pairs.size,
      file.circulars.length,
      "(number, department) must be unique even though number is not",
    );
  });
});

// ─── The wrapper, and the empty case ─────────────────────────────────

describe("parseCircularsResponse — response shape", () => {
  it("REGRESSION: the payload is WRAPPED — a bare-array reading finds nothing", () => {
    // The bug this guards: `payload as Circular[]` against the real response
    // yields zero rows from a healthy 200 and reports "no circulars today".
    assert.ok(!Array.isArray(WIDE), "fixture must be an object, not an array");

    const file = parseCircularsResponse(WIDE);
    assert.ok(file !== null);
    assert.ok(
      file.circulars.length > 0,
      "the wrapper must be unwrapped, not read as a bare array",
    );

    // The inner array on its own is NOT an accepted payload: passing what a
    // bare-array parser would pass must fail loudly rather than half-work.
    const inner = (WIDE as { data: unknown[] }).data;
    assert.equal(
      parseCircularsResponse(inner),
      null,
      "a bare top-level array is an unrecognised shape",
    );
  });

  it("REGRESSION: {data: []} is zero-rows SUCCESS, not a parse failure", () => {
    const file = parseCircularsResponse(EMPTY);

    assert.notEqual(file, null, "an empty window is NOT a failure");
    assert.ok(file !== null);
    assert.equal(file.outcome, "EMPTY");
    assert.deepEqual(file.circulars, []);
    assert.deepEqual(file.rejected, []);
    // The echoed window survives, which is what makes the empty answer
    // attributable to a specific date range rather than to nothing at all.
    assert.equal(file.fromDate, "08-08-2026");
    assert.equal(file.toDate, "09-08-2026");
  });

  it("EMPTY and null are different values, so callers can tell them apart", () => {
    const empty = parseCircularsResponse(EMPTY);
    const broken = parseCircularsResponse({ nope: true });

    assert.ok(empty !== null);
    assert.equal(broken, null);
    // The distinction survives the idiom that usually destroys it.
    assert.equal(empty.circulars.length, 0);
    // `broken` is narrowed to `never` by the assert above, so tsc cannot see
    // through the optional chain. Re-read the value instead of asserting on
    // a narrowed binding — the POINT is that a garbage payload yields null,
    // which the line above already states (MONEY-1118).
    assert.equal(parseCircularsResponse({ nope: true }), null);
  });

  it("REGRESSION: garbage payloads return null", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "…",
      true,
      [],
      [{ circNumber: "1" }],
      {},
      { data: null },
      { data: "not-an-array" },
      { data: 7 },
      { records: [] }, // right idea, wrong key
    ]) {
      assert.equal(
        parseCircularsResponse(bad),
        null,
        `expected null for ${JSON.stringify(bad) ?? "undefined"}`,
      );
    }
  });
});

// ─── Row-level rejection ─────────────────────────────────────────────

describe("parseCircularsResponse — bad rows are rejected, not coerced", () => {
  const good = {
    cirDate: "20260813",
    cirDisplayDate: "August 13, 2026",
    circCategory: "Listing",
    circCompany: "NSE",
    circDepartment: "Listing",
    circDisplayNo: "NSE/CML/75737",
    circFileSize: "366 KB",
    circFilelink:
      "https://nsearchives.nseindia.com/content/circulars/CML75737.pdf",
    circFilename: "CML75737.pdf",
    circNumber: "75737",
    fileDept: "CML",
    fileExt: "pdf",
    sub: "Listing of further issues of securities",
  };

  it("an unparseable date is REJECTED — never epoch, never today", () => {
    const file = parseCircularsResponse({
      data: [{ ...good, circNumber: "1", cirDate: "not-a-date" }],
    });
    assert.ok(file !== null, "one bad row must not fail the file");
    assert.equal(file.circulars.length, 0);
    assert.equal(file.outcome, "EMPTY");
    assert.equal(file.rejected.length, 1);
    assert.deepEqual(file.rejected[0], {
      reason: "BAD_DATE",
      index: 0,
      rawNumber: "1",
      rawDate: "not-a-date",
    });
  });

  it("one bad row does not lose the good rows around it", () => {
    const file = parseCircularsResponse({
      data: [
        good,
        { ...good, circNumber: "2", cirDate: "20261332" },
        { ...good, circNumber: "3" },
      ],
    });
    assert.ok(file !== null);
    assert.equal(file.outcome, "ROWS");
    assert.deepEqual(
      file.circulars.map((x) => x.number),
      ["75737", "3"],
    );
    assert.equal(file.rejected.length, 1);
    assert.equal(file.rejected[0]?.index, 1);
  });

  it("classifies each reject reason and keeps the raw values", () => {
    const file = parseCircularsResponse({
      data: [
        "not an object",
        { ...good, circNumber: "  " },
        { ...good, circNumber: "9", sub: "" },
        { ...good, circNumber: "8", cirDate: "20260230" }, // Feb 30
      ],
    });
    assert.ok(file !== null);
    assert.deepEqual(
      file.rejected.map((r) => r.reason),
      ["NOT_AN_OBJECT", "MISSING_NUMBER", "MISSING_SUBJECT", "BAD_DATE"],
    );
    assert.equal(file.rejected[3]?.rawDate, "20260230");
    assert.equal(file.circulars.length, 0);
  });

  it("a missing attachment link is visibly absent, not a fabricated URL", () => {
    const file = parseCircularsResponse({
      data: [
        { ...good, circFilelink: undefined },
        { ...good, circNumber: "2", circFilelink: "javascript:alert(1)" },
        { ...good, circNumber: "3", circFilelink: "  " },
      ],
    });
    assert.ok(file !== null);
    assert.equal(file.circulars.length, 3);
    for (const row of file.circulars) {
      assert.equal(
        row.attachment,
        null,
        `${row.number} must have no attachment`,
      );
    }
  });

  it("optional string fields are empty, never invented", () => {
    const file = parseCircularsResponse({
      data: [
        {
          cirDate: "20260813",
          circNumber: "77",
          sub: "Some subject",
        },
      ],
    });
    assert.ok(file !== null);
    const row = file.circulars[0];
    assert.ok(row !== undefined);
    assert.equal(row.category, "");
    assert.equal(row.department, "");
    assert.equal(row.company, "");
    assert.equal(row.issuedDateLabel, "");
    assert.equal(row.attachment, null);
    // displayNumber falls back to the bare number rather than to "undefined".
    assert.equal(row.displayNumber, "77");
  });
});

// ─── Dates ───────────────────────────────────────────────────────────

describe("parseCircularDate", () => {
  it("parses NSE's YYYYMMDD as a UTC-midnight IST calendar day", () => {
    const d = parseCircularDate("20260813");
    assert.ok(d !== null);
    assert.equal(d.toISOString(), "2026-08-13T00:00:00.000Z");
  });

  it("handles month and year boundaries", () => {
    assert.equal(
      parseCircularDate("20260101")?.toISOString(),
      "2026-01-01T00:00:00.000Z",
    );
    assert.equal(
      parseCircularDate("20251231")?.toISOString(),
      "2025-12-31T00:00:00.000Z",
    );
    // A real leap day must survive.
    assert.equal(
      parseCircularDate("20240229")?.toISOString(),
      "2024-02-29T00:00:00.000Z",
    );
  });

  it("REJECTS impossible calendar days instead of normalising them", () => {
    // Date.UTC(2026, 1, 30) silently returns 2026-03-02, so range checks alone
    // are not enough — the round-trip is what catches these.
    assert.equal(parseCircularDate("20260230"), null);
    assert.equal(parseCircularDate("20250229"), null); // 2025 is not a leap year
    assert.equal(parseCircularDate("20260431"), null);
    assert.equal(parseCircularDate("20261301"), null);
    assert.equal(parseCircularDate("20260100"), null);
  });

  it("REJECTS malformed input rather than coercing it", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "   ",
      "2026-08-13",
      "13-08-2026",
      "August 13, 2026",
      "2026081",
      "202608133",
      "2026081a",
      20260813, // a number, not a string
      "18000101", // absurdly early
      "21010101", // absurdly late
      NaN,
      Infinity,
    ]) {
      assert.equal(
        parseCircularDate(bad),
        null,
        `expected null for ${String(bad)}`,
      );
    }
  });

  it("never returns epoch or an Invalid Date", () => {
    const bad = parseCircularDate("garbage");
    assert.equal(bad, null);
    // The two silent-coercion outcomes this guards against.
    assert.notEqual(bad, new Date(0));
    const ok = parseCircularDate("20260813");
    assert.ok(ok !== null && Number.isFinite(ok.getTime()));
  });
});

// ─── File sizes ──────────────────────────────────────────────────────

describe("parseFileSizeLabel", () => {
  it("reads NSE's human size strings", () => {
    assert.equal(parseFileSizeLabel("366 KB"), 374_784);
    assert.equal(parseFileSizeLabel("744 KB"), 761_856);
    assert.equal(parseFileSizeLabel("2 MB"), 2_097_152);
    assert.equal(parseFileSizeLabel("512 B"), 512);
    assert.equal(parseFileSizeLabel("1.5 MB"), 1_572_864);
    assert.equal(parseFileSizeLabel("366KB"), 374_784);
    assert.equal(parseFileSizeLabel("366 kb"), 374_784);
  });

  it("is documented as APPROXIMATE — the label is rounded upstream", () => {
    // CML75737.pdf: labelled "366 KB", actually 374,086 bytes (ranged GET,
    // 2026-08-13). The derived value is close but must never be used as a
    // content-length assertion.
    const derived = parseFileSizeLabel("366 KB");
    assert.ok(derived !== null);
    assert.notEqual(
      derived,
      374_086,
      "derived size is not the true byte count",
    );
    assert.ok(Math.abs(derived - 374_086) < 1024);
  });

  it("returns null — not 0 — for anything unreadable", () => {
    for (const bad of [
      undefined,
      null,
      "",
      "  ",
      "unknown",
      "KB",
      "366",
      "366 TB",
      "-5 KB",
      "1e999 KB", // Infinity if parsed naively
      {},
      NaN,
    ]) {
      assert.equal(
        parseFileSizeLabel(bad),
        null,
        `expected null for ${String(bad)}`,
      );
    }
  });

  it("0 is a legitimate size and stays distinguishable from unreadable", () => {
    assert.equal(parseFileSizeLabel("0 KB"), 0);
    assert.equal(parseFileSizeLabel("nonsense"), null);
  });
});

// ─── Classifier ──────────────────────────────────────────────────────

describe("classifyCircular — every branch", () => {
  it("TRADING_HOLIDAY wins regardless of the issuing department", () => {
    // NOTE: no holiday circular fell in the captured 01→13 Aug window, so these
    // subjects are realistic reconstructions of NSE's wording rather than
    // fixture rows. Flagged rather than passed off as live evidence.
    assert.equal(
      classifyCircular(c("Trading Holiday on account of Independence Day")),
      "TRADING_HOLIDAY",
    );
    assert.equal(
      classifyCircular(
        c("List of Trading Holidays for the calendar year 2027"),
      ),
      "TRADING_HOLIDAY",
    );
    assert.equal(
      classifyCircular(c("Muhurat Trading Session")),
      "TRADING_HOLIDAY",
    );
    // Beats a department that would otherwise claim it.
    assert.equal(
      classifyCircular(
        c(
          "Trading Holiday - settlement calendar revised",
          "Mutual Fund",
          "Listing",
        ),
      ),
      "TRADING_HOLIDAY",
    );
  });

  it("SURVEILLANCE — real ASM/ESM/ST-ASM subjects", () => {
    assert.equal(
      classifyCircular(
        c(
          "Applicability of Short-Term Additional Surveillance Measure (ST-ASM)",
          "Surveillance & Investigation",
          "Compliance",
        ),
      ),
      "SURVEILLANCE",
    );
    // Punctuation-insensitive: "(ASM)" and "ST-ASM" normalise to bare tokens.
    assert.equal(
      classifyCircular(
        c("Applicability of Enhanced Surveillance Measure (ESM)"),
      ),
      "SURVEILLANCE",
    );
    assert.equal(classifyCircular(c("Revised GSM framework")), "SURVEILLANCE");
  });

  it("MARGIN", () => {
    // Also not represented in the captured window — reconstructed wording.
    assert.equal(
      classifyCircular(
        c("Revision in margin rates for the Capital Market segment"),
      ),
      "MARGIN",
    );
    assert.equal(
      classifyCircular(c("Acceptance of collateral in the form of securities")),
      "MARGIN",
    );
    assert.equal(
      classifyCircular(c("Applicable haircut on approved securities")),
      "MARGIN",
    );
  });

  it("LISTING — via both department and subject", () => {
    assert.equal(
      classifyCircular(
        c(
          "Listing of Equity Shares of Technocraft Ventures Limited (IPO)",
          "Listing",
          "Listing",
        ),
      ),
      "LISTING",
    );
    // "Emerge" is the SME board and maps to LISTING too.
    assert.equal(
      classifyCircular(
        c(
          "Trade for Trade - Anawil Wire and Engineering Limited (SME IPO)",
          "Emerge",
          "Others",
        ),
      ),
      "LISTING",
    );
    // Subject alone is enough when the department is an unmapped segment name.
    assert.equal(
      classifyCircular(
        c("Listing of privately placed securities", "Debt Segment", "Others"),
      ),
      "LISTING",
    );
  });

  it("SETTLEMENT", () => {
    assert.equal(
      classifyCircular(
        c(
          "CM - Multiple Settlement scheduled on August 27, 2026",
          "NSE Clearing - Capital Market",
          "Clearing",
        ),
      ),
      "SETTLEMENT",
    );
    assert.equal(
      classifyCircular(
        c(
          "Settlement calendar for September 2026 - Debt Segment",
          "Debt Segment",
          "Others",
        ),
      ),
      "SETTLEMENT",
    );
    assert.equal(
      classifyCircular(
        c("Early Pay-in of securities for Tembo Global Industries Limited"),
      ),
      "SETTLEMENT",
    );
  });

  it("TECHNOLOGY — cross-departmental, which is why it outranks the department map", () => {
    // The SAME mock-trading notice is issued by five departments in the live
    // sample. If the department decided, one announcement would land in five
    // different topics.
    for (const dept of [
      "Capital Market (Equities) Trade",
      "Electronic Gold Receipt",
      "Commodity Derivatives",
      "Securities Lending & Borrowing Scheme",
      "Currency Derivatives",
    ]) {
      assert.equal(
        classifyCircular(
          c(
            "Mock trading on Saturday, August 08, 2026 - No new version release",
            dept,
            "Trading",
          ),
        ),
        "TECHNOLOGY",
        `mock trading from ${dept}`,
      );
    }
    assert.equal(
      classifyCircular(
        c(
          "Introduction of NSE Extranet Beta service - Update",
          "Member Service Department",
          "Others",
        ),
      ),
      "TECHNOLOGY",
    );
  });

  it("COMPLIANCE", () => {
    assert.equal(
      classifyCircular(
        c(
          "Segmental Surrender of Membership",
          "Inspection & Compliance",
          "Compliance",
        ),
      ),
      "COMPLIANCE",
    );
    assert.equal(
      classifyCircular(
        c(
          "Guidelines in pursuance of amendment to SEBI KYC (Know Your Client) Registration Agency (KRA) Regulations",
          "Legal, ISC & Arbitration",
          "Compliance",
        ),
      ),
      "COMPLIANCE",
    );
  });

  it("CORPORATE_ACTION — prefixed AND unprefixed F&O adjustments", () => {
    // Both spellings of the SAME INDUSTOWER action appear in the live window.
    // Matching only the "DIVIDEND:" prefix files half of them under OTHER.
    assert.equal(
      classifyCircular(
        c(
          "DIVIDEND: Adjustment of Futures and Options contracts in the security INDUSTOWER",
          "Futures & Options",
          "Trading",
        ),
      ),
      "CORPORATE_ACTION",
    );
    assert.equal(
      classifyCircular(
        c(
          "Adjustment of Futures and Options contracts in the security INDUS TOWERS LIMITED (INDUSTOWER)",
          "Futures & Options",
          "Trading",
        ),
      ),
      "CORPORATE_ACTION",
    );
    assert.equal(
      classifyCircular(
        c("BONUS: Adjustment of contracts", "Futures & Options", "Trading"),
      ),
      "CORPORATE_ACTION",
    );
  });

  it("MUTUAL_FUND", () => {
    assert.equal(
      classifyCircular(
        c(
          "Launch of UTI Balanced Hybrid Fund NFO on NSE MF Invest Platform",
          "Mutual Fund",
          "Trading",
        ),
      ),
      "MUTUAL_FUND",
    );
  });

  it("OTHER is the catch-all — unrecognised subjects are TAGGED, never dropped", () => {
    // The house lesson: narrowing a loose matcher without a catch-all turns
    // "unrecognised" into a NEW failure path and SHRINKS coverage.
    assert.equal(classifyCircular(c("Zzzz qwerty flubber")), "OTHER");
    assert.equal(classifyCircular(c("")), "OTHER");
    assert.equal(classifyCircular(c("   ")), "OTHER");
    assert.equal(
      classifyCircular(
        c("Change in ISIN-Globe Fincap Limited", "Debt Segment", "Others"),
      ),
      "OTHER",
    );
    assert.equal(
      classifyCircular(
        c(
          "Liquidity Enhancement Scheme (LES) on Silver Options on Goods",
          "Commodity Derivatives",
          "Others",
        ),
      ),
      "OTHER",
    );
    // Unicode / punctuation-only subjects still resolve rather than throwing.
    assert.equal(classifyCircular(c("—–…!!!")), "OTHER");
  });

  it("is TOTAL — never throws, always returns a member of the closed set", () => {
    const topics = new Set<CircularTopic>(CIRCULAR_TOPICS);
    for (const subject of [
      "",
      "   ",
      "\n\t",
      "%%%",
      "a".repeat(5000),
      "日本語の件名",
      "NULL",
      "undefined",
    ]) {
      for (const dept of ["", "Unknown Dept", "Listing"]) {
        for (const cat of ["", "Nonsense", "Compliance"]) {
          const topic = classifyCircular(c(subject, dept, cat));
          assert.ok(topics.has(topic), `${topic} is outside the closed set`);
        }
      }
    }
  });

  it("every declared topic except the unrepresented ones is reachable", () => {
    const reached = new Set<CircularTopic>([
      classifyCircular(c("Trading Holiday")),
      classifyCircular(c("Applicability of Additional Surveillance Measure")),
      classifyCircular(c("Revision in margin rates")),
      classifyCircular(c("Listing of Equity Shares")),
      classifyCircular(c("Settlement calendar for September 2026")),
      classifyCircular(c("Mock trading on Saturday")),
      classifyCircular(c("SEBI KYC KRA Regulations")),
      classifyCircular(c("DIVIDEND: Adjustment of contracts")),
      classifyCircular(c("NFO launch", "Mutual Fund", "")),
      classifyCircular(c("qwerty")),
    ]);
    for (const t of CIRCULAR_TOPICS) {
      assert.ok(reached.has(t), `${t} is declared but unreachable`);
    }
  });
});

// ─── The classifier's precedence rules ───────────────────────────────

describe("classifyCircular — precedence is a correctness property", () => {
  it("REGRESSION: word boundaries, not substrings — 'Systematic' is not 'system'", () => {
    // Real live row. Naive includes("system") files an SIP amendment under
    // TECHNOLOGY.
    assert.equal(
      classifyCircular(
        c(
          "Change in minimum amount and Instalments under Systematic Investment Plan (SIP) in JM Large & Mid Cap Fund",
          "Mutual Fund",
          "Trading",
        ),
      ),
      "MUTUAL_FUND",
    );
    assert.equal(
      classifyCircular(
        c(
          "Introduction of Daily frequency under Systematic Transfer Plan (STP)",
          "Mutual Fund",
          "Trading",
        ),
      ),
      "MUTUAL_FUND",
    );
  });

  it("REGRESSION: 'Nifty Bank' / 'Balanced' must not match a 'ban' rule", () => {
    assert.equal(
      classifyCircular(
        c(
          "Revision of Invesco India BSE Sensex ETF & Invesco India Nifty Bank ETF on NSE MF Invest Platform",
          "Mutual Fund",
          "Trading",
        ),
      ),
      "MUTUAL_FUND",
    );
    assert.equal(
      classifyCircular(
        c("Launch of UTI Balanced Hybrid Fund NFO", "Mutual Fund", "Trading"),
      ),
      "MUTUAL_FUND",
    );
  });

  it("REGRESSION: department beats category — all 45 ASM rows carry category 'Compliance'", () => {
    // Consulting circCategory first would file every surveillance notice under
    // COMPLIANCE and leave SURVEILLANCE permanently empty. The taxonomy would
    // look healthy and be wrong.
    assert.equal(
      classifyCircular(
        c(
          "Applicability of Additional Surveillance Measure (ASM)",
          "Surveillance & Investigation",
          "Compliance",
        ),
      ),
      "SURVEILLANCE",
    );
  });

  it("category is the last signal before OTHER, and still used", () => {
    assert.equal(
      classifyCircular(
        c("Some unmatched subject", "Unmapped Segment", "Clearing"),
      ),
      "SETTLEMENT",
    );
    assert.equal(
      classifyCircular(
        c(
          "Some unmatched subject",
          "Unmapped Segment",
          "Trading, Clearing & settlement",
        ),
      ),
      "SETTLEMENT",
    );
    assert.equal(
      classifyCircular(
        c("Some unmatched subject", "Unmapped Segment", "Others"),
      ),
      "OTHER",
    );
  });

  it("department and category matching is case- and whitespace-insensitive", () => {
    assert.equal(
      classifyCircular(
        c("unmatched", "  MUTUAL FUND  ".replace("FUND", "Fund"), ""),
      ),
      "MUTUAL_FUND",
    );
    assert.equal(classifyCircular(c("unmatched", "LISTING", "")), "LISTING");
  });
});

// ─── Aggregation ─────────────────────────────────────────────────────

describe("countByTopic", () => {
  it("reports every topic including zeros, so a vanished topic is visible", () => {
    const file = parseCircularsResponse(WIDE);
    assert.ok(file !== null);
    const counts = countByTopic(file.circulars);

    for (const t of CIRCULAR_TOPICS) {
      assert.equal(typeof counts[t], "number", `${t} missing from the tally`);
    }
    const total = CIRCULAR_TOPICS.reduce((a, t) => a + counts[t], 0);
    assert.equal(total, file.circulars.length, "counts must sum to the rows");
  });

  it("is all-zero for an empty window rather than an empty object", () => {
    const counts = countByTopic([]);
    assert.equal(Object.keys(counts).length, CIRCULAR_TOPICS.length);
    for (const t of CIRCULAR_TOPICS) assert.equal(counts[t], 0);
  });
});

// ─── Purity ──────────────────────────────────────────────────────────

describe("purity", () => {
  it("does not mutate its input", () => {
    const before = JSON.stringify(WIDE);
    parseCircularsResponse(WIDE);
    classifyCircular(c("anything"));
    assert.equal(JSON.stringify(WIDE), before);
  });

  it("accepts a deeply frozen payload", () => {
    const freeze = (v: unknown): unknown => {
      if (v !== null && typeof v === "object") {
        Object.values(v as Record<string, unknown>).forEach(freeze);
        Object.freeze(v);
      }
      return v;
    };
    const frozen = freeze(JSON.parse(JSON.stringify(WIDE)) as unknown);
    const file = parseCircularsResponse(frozen);
    assert.ok(file !== null);
    assert.equal(file.circulars.length, 24);
  });

  it("is deterministic across repeated calls", () => {
    const a = parseCircularsResponse(WIDE);
    const b = parseCircularsResponse(WIDE);
    assert.ok(a !== null && b !== null);
    assert.deepEqual(a, b);
  });

  it("does not depend on the wall clock or the host timezone", () => {
    // Every date is derived arithmetically from the payload, so the output is
    // pinned to absolute UTC instants no matter where this runs. If the parser
    // ever reached for `new Date()` as a fallback, this would drift.
    const file = parseCircularsResponse(WIDE);
    assert.ok(file !== null);
    const stamps = file.circulars.map((x) => x.issuedAt.toISOString()).sort();
    assert.equal(stamps[0], "2026-08-10T00:00:00.000Z");
    assert.equal(stamps[stamps.length - 1], "2026-08-13T00:00:00.000Z");
  });

  it("returns fresh objects — mutating a result cannot poison the next parse", () => {
    const first = parseCircularsResponse(WIDE);
    assert.ok(first !== null);
    first.circulars.length = 0;
    first.outcome = "EMPTY";

    const second = parseCircularsResponse(WIDE);
    assert.ok(second !== null);
    assert.equal(second.outcome, "ROWS");
    assert.equal(second.circulars.length, 24);
  });
});
