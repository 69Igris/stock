/**
 * UNIT TEST — NSE's results INDEX (MONEY-1113 / MONEY-1186, Data Engine P10 F1).
 *
 * Every fixture is REAL bytes pulled from the live NSE API on 2026-08-14, kept
 * VERBATIM. Nothing here is a hand-built shape, because every trap this module
 * exists to survive is a fact about the exact strings NSE serves:
 *
 *   legacy-nov-2024.sample.json        42 records sampled from the 2,317-record
 *                                      01-11-2024 → 15-11-2024 response. Sampled
 *                                      to carry the whole flag matrix: all three
 *                                      `bank` letters (31 N / 6 B / 5 F), both
 *                                      `consolidated` words, and the rare
 *                                      "Audited" (4 of 42). BARE ARRAY.
 *   legacy-may-2018-mixed.sample.json  32 records from 20-05-2018 → 31-05-2018,
 *                                      the month XBRL switched on: 11 stubs and
 *                                      21 real .xml on ONE page. The only
 *                                      fixture that proves the partition.
 *   legacy-nov-2017-stubs.sample.json  18 records from 01-11-2017 → 15-11-2017.
 *                                      The live window is 763/763 stubs — a page
 *                                      with ZERO usable entries that is a
 *                                      completely successful read.
 *   integrated-capped-20.sample.json   the VERBATIM 01-01-2026 → 15-02-2026
 *                                      response with NO `size` param: 20 records
 *                                      over a 46-day window. Envelope included.
 *   integrated-complete-6.sample.json  the VERBATIM 15-02-2026 → 15-02-2026
 *                                      response: 6 records, a genuinely complete
 *                                      answer. Envelope included.
 *
 * The two integrated fixtures are NOT trimmed. Trimming either one would destroy
 * the exact property under test — the capped one's record count and day-clustering
 * IS the evidence, and the complete one is the false-positive guard without which
 * `detectTruncation` could return `true` unconditionally and pass everything else.
 *
 * Everything here is synchronous: no timers, no promises, nothing to orphan.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  parseBasis,
  parseAudited,
  parseCumulative,
  parseFilerKind,
  parsePeriodType,
  parseNseIndexDate,
  parseRevisionKind,
  parseIndexSequence,
  hasXbrlDocument,
  parseFilingIndexPage,
  detectTruncation,
  eraForDate,
  INTEGRATED_FILING_ERA_START,
  type FilingIndexPage,
} from "../../src/market-data/xbrl-filing-index";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "xbrl-index");

const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf-8")) as unknown;

const LEGACY_NOV_2024 = readFixture("legacy-nov-2024.sample.json");
const LEGACY_MAY_2018 = readFixture("legacy-may-2018-mixed.sample.json");
const LEGACY_NOV_2017 = readFixture("legacy-nov-2017-stubs.sample.json");
const INTEGRATED_CAPPED = readFixture("integrated-capped-20.sample.json");
const INTEGRATED_COMPLETE = readFixture("integrated-complete-6.sample.json");

/** NSE's absence marker, verbatim. Every non-.xml value in every fixture. */
const STUB_URL = "https://nsearchives.nseindia.com/corporate/xbrl/-";

/** The window the capped fixture was fetched over: 01-01-2026 → 15-02-2026. */
const CAPPED_WINDOW_DAYS = 46;

// ─── Typed fixture accessors (no `any`) ──────────────────────────────

const asArray = (v: unknown, what: string): unknown[] => {
  assert.ok(Array.isArray(v), `${what} must be an array`);
  return v;
};

const asObject = (v: unknown, what: string): Record<string, unknown> => {
  assert.ok(
    typeof v === "object" && v !== null && !Array.isArray(v),
    `${what} must be an object`,
  );
  return v as Record<string, unknown>;
};

/** Count how many fixture records carry a given literal field value. */
const countField = (
  records: unknown[],
  field: string,
  value: unknown,
): number =>
  records.filter((r) => asObject(r, "record")[field] === value).length;

/** Parse a page or fail loudly — every fixture here is known-good. */
/**
 * The same page with its envelope removed — i.e. what the LEGACY index looks
 * like, since that one returns a bare array with no `totalCount` at all.
 *
 * Needed because `detectTruncation` now reads the server's own count FIRST and
 * only falls back to the structural heuristic. Without a way to remove the
 * exact signal, every heuristic branch would be shadowed and the tests below
 * would silently stop exercising it — the legacy index is precisely where the
 * heuristic is load-bearing.
 */
const withoutEnvelope = (p: FilingIndexPage): FilingIndexPage => ({
  ...p,
  total: null,
  serverPageSize: null,
});

const page = (
  payload: unknown,
  era: "legacy" | "integrated",
): FilingIndexPage => {
  const p = parseFilingIndexPage(payload, era);
  assert.ok(
    p !== null,
    "fixture must parse — a null here means a broken fixture",
  );
  return p;
};

/**
 * Distinct broadcast DAYS in a page, the way `detectTruncation` documents its
 * `distinctDays` input ("Distinct broadcast days present in the page").
 *
 * `countNullAsItsOwnDay` is the whole question. The module takes this number
 * from the caller and supplies no helper to compute it, so both readings are
 * things a caller will plausibly write — and on the real capped page they give
 * OPPOSITE truncation verdicts. See the REGRESSION case below.
 */
const distinctBroadcastDays = (
  p: FilingIndexPage,
  countNullAsItsOwnDay: boolean,
): number => {
  const days = new Set<number | null>();
  for (const e of p.entries) {
    if (e.broadcastAt === null) {
      if (countNullAsItsOwnDay) days.add(null);
      continue;
    }
    days.add(
      Date.UTC(
        e.broadcastAt.getUTCFullYear(),
        e.broadcastAt.getUTCMonth(),
        e.broadcastAt.getUTCDate(),
      ),
    );
  }
  return days.size;
};

const deepFreeze = (v: unknown): unknown => {
  if (v === null || typeof v !== "object") return v;
  Object.freeze(v);
  for (const k of Object.keys(v as Record<string, unknown>)) {
    deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
};

// ─── Guards the guard ────────────────────────────────────────────────

describe("fixtures — the suite cannot pass by asserting nothing", () => {
  it("every fixture loaded, in the shape NSE actually served", () => {
    // The legacy index returns a BARE ARRAY; the integrated one returns a
    // {data,size,page,totalCount} WRAPPER. Both shapes are load-bearing below,
    // so pin them here — if a fixture were replaced with `[]` or `{}` half this
    // file would go vacuously green.
    assert.equal(asArray(LEGACY_NOV_2024, "nov-2024").length, 42);
    assert.equal(asArray(LEGACY_MAY_2018, "may-2018").length, 32);
    assert.equal(asArray(LEGACY_NOV_2017, "nov-2017").length, 18);

    const capped = asObject(INTEGRATED_CAPPED, "capped");
    assert.equal(asArray(capped.data, "capped.data").length, 20);
    const complete = asObject(INTEGRATED_COMPLETE, "complete");
    assert.equal(asArray(complete.data, "complete.data").length, 6);
  });

  it("the sampled legacy window really does carry the whole flag matrix", () => {
    // If the sampling ever loses the 6 banks or the 4 audited rows, the flag
    // tests below stop testing anything. Pin the census.
    const recs = asArray(LEGACY_NOV_2024, "nov-2024");
    assert.equal(countField(recs, "bank", "N"), 31);
    assert.equal(countField(recs, "bank", "B"), 6);
    assert.equal(countField(recs, "bank", "F"), 5);
    assert.equal(countField(recs, "consolidated", "Consolidated"), 16);
    assert.equal(countField(recs, "consolidated", "Non-Consolidated"), 26);
    assert.equal(countField(recs, "audited", "Audited"), 4);
    assert.equal(countField(recs, "audited", "Un-Audited"), 38);
    // Live census over the full 2,317-record window, for the record:
    // 2,223 N / 88 F / 6 B — i.e. 4% of filings are the ones an `=== "Y"`
    // test would misfile, and they are exactly the banks and NBFCs.
  });

  it("the stub fixtures really are stubs, and the dense one really has none", () => {
    assert.equal(
      countField(asArray(LEGACY_NOV_2017, "nov-2017"), "xbrl", STUB_URL),
      18,
    );
    assert.equal(
      countField(asArray(LEGACY_MAY_2018, "may-2018"), "xbrl", STUB_URL),
      11,
    );
    assert.equal(
      countField(asArray(LEGACY_NOV_2024, "nov-2024"), "xbrl", STUB_URL),
      0,
    );
  });
});

// ─── 1. The four non-Y/N flags ───────────────────────────────────────

describe("parseBasis — 'Consolidated' / 'Non-Consolidated'", () => {
  it("REGRESSION: 'Non-Consolidated' is STANDALONE, not CONSOLIDATED", () => {
    // THE substring trap. "Non-Consolidated" CONTAINS "Consolidated", so an
    // `includes`-based check in the wrong order marks every standalone filing
    // as consolidated — silently, and on the MAJORITY of records (26 of 42 in
    // the fixture; 1,333 of 2,317 live).
    assert.equal(
      "Non-Consolidated".includes("Consolidated"),
      true,
      "the trap is real: the negative literally contains the positive",
    );
    assert.equal(parseBasis("Non-Consolidated"), "STANDALONE");
    assert.equal(parseBasis("Consolidated"), "CONSOLIDATED");
  });

  it("is case-insensitive, as NSE is not consistent about case", () => {
    assert.equal(parseBasis("NON-CONSOLIDATED"), "STANDALONE");
    assert.equal(parseBasis("consolidated"), "CONSOLIDATED");
    assert.equal(parseBasis("  Consolidated  "), "CONSOLIDATED");
  });

  it("falls back to STANDALONE — the conservative reading — when absent", () => {
    // Deliberately NOT null: an unknown label must not be asserted as
    // consolidated. Documented in the module; pinned here so a later
    // "make it nullable" refactor is a conscious decision.
    assert.equal(parseBasis(undefined), "STANDALONE");
    assert.equal(parseBasis(null), "STANDALONE");
    assert.equal(parseBasis(""), "STANDALONE");
    assert.equal(parseBasis("   "), "STANDALONE");
    assert.equal(parseBasis(42), "STANDALONE");
    assert.equal(parseBasis("Something Else Entirely"), "STANDALONE");
  });

  it("is NOT a Y/N field — 'Y' does not mean consolidated", () => {
    assert.equal(parseBasis("Y"), "STANDALONE");
    assert.equal(parseBasis("N"), "STANDALONE");
  });
});

describe("parseAudited — 'Audited' / 'Un-Audited'", () => {
  it("reads the real words", () => {
    assert.equal(parseAudited("Audited"), true);
    assert.equal(parseAudited("Un-Audited"), false);
    assert.equal(parseAudited("UN-AUDITED"), false);
    assert.equal(parseAudited("Non-Audited"), false);
  });

  it("REGRESSION: returns null — NOT false — when the field is absent", () => {
    // "we do not know whether this was audited" and "this was explicitly
    // unaudited" are different claims to put in front of a user reading a
    // company's results. `false` for absent would state the second.
    assert.equal(parseAudited(undefined), null);
    assert.equal(parseAudited(null), null);
    assert.equal(parseAudited(""), null);
    assert.equal(parseAudited("   "), null);
    assert.notEqual(parseAudited(undefined), false);
  });

  it("returns null for an unrecognised word rather than guessing", () => {
    assert.equal(parseAudited("Reviewed"), null);
    assert.equal(parseAudited("Y"), null);
  });
});

describe("parseCumulative — 'Cumulative' / 'Non-cumulative'", () => {
  it("REGRESSION: 'Non-cumulative' is false, not true", () => {
    // Same substring trap as parseBasis, and note NSE's lower-case 'c' in the
    // negative but upper-case in the positive — case-folding is required.
    assert.equal("Non-cumulative".toLowerCase().includes("cumulative"), true);
    assert.equal(parseCumulative("Non-cumulative"), false);
    assert.equal(parseCumulative("Cumulative"), true);
  });

  it("returns null — NOT false — when the field is absent", () => {
    assert.equal(parseCumulative(undefined), null);
    assert.equal(parseCumulative(null), null);
    assert.equal(parseCumulative(""), null);
    assert.notEqual(parseCumulative(undefined), false);
  });
});

describe("parseFilerKind — `bank` has THREE values, not two", () => {
  it("REGRESSION: 'B' is BANK and 'F' is NBFC — neither is GENERIC", () => {
    // The worst of the four fields because it looks closest to a flag. An
    // `=== "Y"` test returns GENERIC for all three letters, which silently
    // reclassifies every bank and NBFC — exactly the population whose XBRL
    // uses different tags for the same concepts.
    assert.equal(parseFilerKind("B"), "BANK");
    assert.equal(parseFilerKind("F"), "NBFC");
    assert.equal(parseFilerKind("N"), "GENERIC");

    assert.notEqual(parseFilerKind("B"), "GENERIC");
    assert.notEqual(parseFilerKind("F"), "GENERIC");
    // And none of the real values is "Y", so an `=== "Y"` test matches nothing:
    for (const real of ["N", "B", "F"]) {
      assert.notEqual(real, "Y", 'an `=== "Y"` test would never fire');
    }
  });

  it("BANK and NBFC stay separate — they file different XBRL", () => {
    // A bank files RBI Form-A concepts, an NBFC files Ind-AS with financial
    // extensions. Folding them into one "financial" bucket makes a coverage
    // report blame the parser for concepts the filer never had.
    assert.notEqual(parseFilerKind("B"), parseFilerKind("F"));
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    assert.equal(parseFilerKind("b"), "BANK");
    assert.equal(parseFilerKind(" f "), "NBFC");
  });

  it("an unknown letter degrades to GENERIC rather than dropping the filing", () => {
    // Deliberate catch-all: a new letter appearing upstream must not start
    // silently discarding records.
    assert.equal(parseFilerKind("X"), "GENERIC");
    assert.equal(parseFilerKind(undefined), "GENERIC");
    assert.equal(parseFilerKind(null), "GENERIC");
    assert.equal(parseFilerKind(""), "GENERIC");
    assert.equal(parseFilerKind(1), "GENERIC");
  });
});

describe("parsePeriodType", () => {
  it("maps NSE's words onto the closed set", () => {
    assert.equal(parsePeriodType("Quarterly"), "QUARTERLY");
    assert.equal(parsePeriodType("Half-Yearly"), "HALF_YEARLY");
    assert.equal(parsePeriodType("Annual"), "ANNUAL");
    assert.equal(parsePeriodType("Yearly"), "ANNUAL");
  });

  it("returns null for absent or unrecognised, never a default period", () => {
    assert.equal(parsePeriodType(undefined), null);
    assert.equal(parsePeriodType(""), null);
    assert.equal(parsePeriodType("Monthly"), null);
  });
});

// ─── 2. hasXbrlDocument and the stub URL ─────────────────────────────

describe("hasXbrlDocument — the stub URL", () => {
  it("REGRESSION: rejects the stub, which every loose check accepts", () => {
    // This is the test that has to exist. NSE's absence marker is a
    // WELL-FORMED URL ending in a bare dash. It is non-empty, it starts with
    // "http", and it parses as a URL — so coverage measured any of those ways
    // reads ~100% for every year back to 2012, and the backfill silently
    // fetches 763 dashes for a November 2017 window.
    //
    // Assert the loose checks WOULD have passed, so the next reader can see
    // why the `.xml` suffix is the only usable test, not just that it is used.
    assert.equal(Boolean(STUB_URL), true, "truthiness accepts the stub");
    assert.equal(
      STUB_URL.startsWith("http"),
      true,
      'startsWith("http") accepts the stub — this is why it is not the check',
    );
    assert.doesNotThrow(
      () => new URL(STUB_URL),
      "URL parsing accepts the stub too",
    );

    // The strict check is the only one that says no.
    assert.equal(hasXbrlDocument(STUB_URL), false);
  });

  it("accepts a real XBRL document url", () => {
    assert.equal(
      hasXbrlDocument(
        "https://nsearchives.nseindia.com/corporate/xbrl/INDAS_116875_1315808_15112024100348.xml",
      ),
      true,
    );
    // The integrated index's filenames differ but still end in .xml.
    assert.equal(
      hasXbrlDocument(
        "https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_INDAS_1626351_15022026025328_WEB.xml",
      ),
      true,
    );
  });

  it("rejects the iXBRL HTML rendering — it is not the document", () => {
    // Every modern record carries BOTH; taking the .html would feed the XBRL
    // parser a web page.
    assert.equal(
      hasXbrlDocument(
        "https://nsearchives.nseindia.com/corporate/ixbrl/INTEGRATED_FILING_INDAS_143664_15022026145329_iXBRL_WEB.html",
      ),
      false,
    );
  });

  it("rejects absent, blank and non-string values", () => {
    assert.equal(hasXbrlDocument(undefined), false);
    assert.equal(hasXbrlDocument(null), false);
    assert.equal(hasXbrlDocument(""), false);
    assert.equal(hasXbrlDocument("   "), false);
    assert.equal(hasXbrlDocument(123), false);
    assert.equal(hasXbrlDocument({ xbrl: "a.xml" }), false);
  });

  it("is case-insensitive on the suffix", () => {
    assert.equal(hasXbrlDocument("https://x/A.XML"), true);
  });

  it("every real stub in the 2017 fixture is the same marker string", () => {
    // If NSE ever changes the marker, this is the test that notices — and the
    // module logs `rawXbrl` for exactly that reason.
    const recs = asArray(LEGACY_NOV_2017, "nov-2017");
    for (const r of recs) {
      const xbrl = asObject(r, "record").xbrl;
      assert.equal(xbrl, STUB_URL);
      assert.equal(hasXbrlDocument(xbrl), false);
    }
  });
});

// ─── 3. parseNseIndexDate ────────────────────────────────────────────

describe("parseNseIndexDate", () => {
  it("parses the real date-only format to UTC midnight", () => {
    // `qe_Date` on the integrated index, upper-case month.
    const d = parseNseIndexDate("31-DEC-2025");
    assert.ok(d !== null);
    assert.equal(d.toISOString(), "2025-12-31T00:00:00.000Z");
    assert.equal(
      d.getTime() % 86_400_000,
      0,
      "must be a UTC-midnight boundary",
    );
  });

  it("parses the real datetime formats to the exact instant", () => {
    // `broadCastDate` (legacy, HH:MM:SS) and `filingDate` (legacy, HH:MM).
    const withSeconds = parseNseIndexDate("15-Feb-2026 14:53:12", {
      withTime: true,
    });
    assert.ok(withSeconds !== null);
    assert.equal(withSeconds.toISOString(), "2026-02-15T14:53:12.000Z");

    const withoutSeconds = parseNseIndexDate("15-Nov-2025 13:11", {
      withTime: true,
    });
    assert.ok(withoutSeconds !== null);
    assert.equal(withoutSeconds.toISOString(), "2025-11-15T13:11:00.000Z");

    // `revised_Date` arrives with an UPPER-case month and a time.
    const revised = parseNseIndexDate("14-FEB-2026 23:24:28", {
      withTime: true,
    });
    assert.ok(revised !== null);
    assert.equal(revised.toISOString(), "2026-02-14T23:24:28.000Z");
  });

  it("drops the time to UTC midnight when withTime is not requested", () => {
    // The same string means "the day" in a quarter-end field and "the instant"
    // in a broadcast field. The caller decides; the parser does not guess.
    const d = parseNseIndexDate("15-Feb-2026 14:53:12");
    assert.ok(d !== null);
    assert.equal(d.toISOString(), "2026-02-15T00:00:00.000Z");
  });

  it("REGRESSION: '31-Feb-2026' is REJECTED, not rolled forward into March", () => {
    // `Date.UTC(2026, 1, 31)` cheerfully returns 3 March. Range-checking the
    // digits (1-31, 1-12) does NOT catch this — only the round trip does. An
    // impossible date silently becoming a real one three days later is the
    // kind of thing that shows up as a mis-dated quarter-end months on.
    assert.equal(
      new Date(Date.UTC(2026, 1, 31)).toISOString(),
      "2026-03-03T00:00:00.000Z",
      "the trap is real: Date.UTC rolls over rather than failing",
    );
    assert.equal(parseNseIndexDate("31-Feb-2026"), null);
    assert.equal(parseNseIndexDate("30-Feb-2026"), null);
    assert.equal(parseNseIndexDate("31-Apr-2026"), null, "April has 30 days");
    assert.equal(parseNseIndexDate("00-Jan-2026"), null);
  });

  it("handles the leap-year boundary in both directions", () => {
    const leap = parseNseIndexDate("29-Feb-2024");
    assert.ok(leap !== null);
    assert.equal(leap.toISOString(), "2024-02-29T00:00:00.000Z");
    assert.equal(
      parseNseIndexDate("29-Feb-2025"),
      null,
      "2025 is not a leap year",
    );
  });

  it("returns null — never epoch, never today, never Invalid Date", () => {
    // `new Date(undefined)` yields an Invalid Date whose every comparison is
    // false, which poisons a date range quietly. `new Date(0)` would date a
    // filing to 1970. Both are worse than an explicit null.
    const bad: unknown[] = [
      undefined,
      null,
      "",
      "   ",
      "garbage",
      "2025-12-31",
      "31/12/2025",
      "31-XYZ-2025",
      "Dec-31-2025",
      "31-DEC-25",
      123,
      {},
      [],
      new Date(),
      NaN,
    ];
    for (const v of bad) {
      const got = parseNseIndexDate(v);
      assert.equal(got, null, `expected null for ${JSON.stringify(v)}`);
      // Belt and braces: whatever it is, it is not a usable-looking Date.
      assert.notEqual(got, new Date(0));
    }
  });

  it("rejects a malformed time rather than silently dropping it", () => {
    assert.equal(
      parseNseIndexDate("15-Feb-2026 25:00", { withTime: true }),
      null,
    );
    assert.equal(
      parseNseIndexDate("15-Feb-2026 1:5", { withTime: true }),
      null,
    );
  });

  it("every date it produced from the real fixtures is valid and sane", () => {
    // The suite-wide sanity sweep: no Invalid Date, no epoch, and quarter-ends
    // land on UTC midnight exactly as the type promises.
    for (const p of [
      page(LEGACY_NOV_2024, "legacy"),
      page(INTEGRATED_CAPPED, "integrated"),
    ]) {
      for (const e of p.entries) {
        if (e.quarterEnd !== null) {
          assert.equal(Number.isNaN(e.quarterEnd.getTime()), false);
          assert.notEqual(e.quarterEnd.getTime(), 0, "never epoch");
          assert.equal(
            e.quarterEnd.getTime() % 86_400_000,
            0,
            `${e.symbol}: quarterEnd is not on a UTC-midnight boundary`,
          );
        }
        if (e.broadcastAt !== null) {
          assert.equal(Number.isNaN(e.broadcastAt.getTime()), false);
          assert.notEqual(e.broadcastAt.getTime(), 0, "never epoch");
        }
      }
    }
  });
});

// ─── 4. parseFilingIndexPage ─────────────────────────────────────────

describe("parseFilingIndexPage — payload shapes", () => {
  it("accepts a BARE ARRAY (what the legacy index actually returns)", () => {
    const p = page(LEGACY_NOV_2024, "legacy");
    assert.equal(p.era, "legacy");
    assert.equal(p.listed, 42);
    assert.equal(p.entries.length, 42);
  });

  it("accepts a {data:[...]} WRAPPER (what the integrated index returns)", () => {
    // Assuming one shape yields zero records from a perfectly good 200, which
    // reads downstream as "a quiet week" rather than as a bug.
    const p = page(INTEGRATED_CAPPED, "integrated");
    assert.equal(p.era, "integrated");
    assert.equal(p.listed, 20);
    assert.equal(p.entries.length, 20);
  });

  it("REGRESSION: a garbage payload returns null, NOT an empty page", () => {
    // A failed read and an empty window must never be the same value. Every
    // caller in this repo that conflated them eventually shipped a silent
    // no-op that reported success.
    const garbage: unknown[] = [
      null,
      undefined,
      "",
      "not json",
      123,
      true,
      {},
      { data: null },
      { data: "nope" },
      { records: [] }, // right idea, wrong key
      { data: { 0: {} } }, // object-with-numeric-keys, not an array
    ];
    for (const g of garbage) {
      assert.equal(
        parseFilingIndexPage(g, "legacy"),
        null,
        `expected null for ${JSON.stringify(g)}`,
      );
    }
  });

  it("REGRESSION: an EMPTY window returns a page with listed:0 — null !== empty", () => {
    // The pair that matters. `[]` is a successful read of a quiet window and
    // must be distinguishable from an unreadable response.
    const empty = parseFilingIndexPage([], "legacy");
    assert.ok(empty !== null, "an empty array is a SUCCESSFUL read");
    assert.equal(empty.listed, 0);
    assert.deepEqual(empty.entries, []);
    assert.deepEqual(empty.rejected, []);
    assert.equal(empty.stubbed, 0);

    const unreadable = parseFilingIndexPage({ nope: true }, "legacy");
    assert.equal(unreadable, null);

    // Stated as bluntly as possible, because this is the whole point:
    assert.notDeepEqual(
      unreadable,
      empty,
      "an unreadable payload must not equal an empty window",
    );

    // The wrapped form of empty is also a success, not a failure.
    const emptyWrapped = parseFilingIndexPage(
      { data: [], size: 20, page: -1, totalCount: 0 },
      "integrated",
    );
    assert.ok(emptyWrapped !== null);
    assert.equal(emptyWrapped.listed, 0);
  });
});

describe("parseFilingIndexPage — stubs are counted, not rejected", () => {
  it("a MIXED real page partitions into entries + stubbed with no rejects", () => {
    // May 2018 is the month XBRL switched on, so one real page carries both.
    // 21 usable + 11 stubs = 32 listed, and NOTHING is an error.
    const p = page(LEGACY_MAY_2018, "legacy");
    assert.equal(p.listed, 32);
    assert.equal(p.entries.length, 21);
    assert.equal(p.stubbed, 11);
    assert.deepEqual(p.rejected, [], "a stub is NOT a reject");
    assert.equal(
      p.entries.length + p.stubbed,
      p.listed,
      "the partition must be exhaustive — no record vanishes",
    );
  });

  it("REGRESSION: an ALL-STUB page is a SUCCESS with zero entries", () => {
    // The live 01-11-2017 → 15-11-2017 window is 763/763 stubs. A pre-2018
    // filing without XBRL is the NORMAL state, not a failure — conflating the
    // two makes a complete backfill look broken and invites a "retry" loop
    // that can never succeed.
    const p = page(LEGACY_NOV_2017, "legacy");
    assert.equal(p.listed, 18);
    assert.equal(p.entries.length, 0);
    assert.equal(p.stubbed, 18);
    assert.deepEqual(p.rejected, []);
    // Zero entries, yet emphatically not a null and not an error:
    assert.notEqual(parseFilingIndexPage(LEGACY_NOV_2017, "legacy"), null);
  });

  it("a modern dense page has no stubs at all", () => {
    const p = page(INTEGRATED_CAPPED, "integrated");
    assert.equal(p.stubbed, 0);
    assert.deepEqual(p.rejected, []);
  });

  it("a record with no symbol is REJECTED (not silently dropped)", () => {
    // Synthetic — no real record in any captured window is missing `symbol`.
    // Pinned anyway because the reject carries `rawXbrl` for the log line.
    const p = parseFilingIndexPage(
      [{ symbol: "   ", xbrl: STUB_URL }, { xbrl: "https://x/a.xml" }],
      "legacy",
    );
    assert.ok(p !== null);
    assert.equal(p.listed, 2);
    assert.equal(p.entries.length, 0);
    assert.equal(p.rejected.length, 2);
    assert.equal(p.rejected[0]?.reason, "NO_SYMBOL");
    assert.equal(p.rejected[0]?.symbol, null);
    assert.equal(
      p.rejected[0]?.rawXbrl,
      STUB_URL,
      "the raw xbrl is preserved so a NEW absence marker shows up in logs",
    );
    assert.equal(p.rejected[1]?.rawXbrl, "https://x/a.xml");
  });
});

describe("parseFilingIndexPage — legacy field extraction", () => {
  it("extracts a known legacy record field-by-field (ALICON, 15-Nov-2024)", () => {
    const p = page(LEGACY_NOV_2024, "legacy");
    const row = p.entries.find((e) => e.symbol === "ALICON");
    assert.ok(row !== undefined, "ALICON must be present");

    assert.equal(row.era, "legacy");
    assert.equal(row.isin, "INE062D01024");
    assert.equal(
      row.xbrlUrl,
      "https://nsearchives.nseindia.com/corporate/xbrl/INDAS_116875_1315808_15112024100348.xml",
    );
    assert.equal(row.ixbrlUrl, null, "the legacy index has no iXBRL");
    assert.equal(row.basis, "CONSOLIDATED");
    assert.equal(row.audited, false, '"Un-Audited"');
    assert.equal(row.cumulative, false, '"Non-cumulative"');
    assert.equal(row.periodType, "QUARTERLY");
    assert.equal(row.filerKind, "GENERIC", 'bank === "N"');
    // The legacy index states a from/to pair; `toDate` is the period end.
    assert.equal(row.quarterEnd?.toISOString(), "2024-09-30T00:00:00.000Z");
    assert.equal(row.broadcastAt?.toISOString(), "2024-11-15T22:03:49.000Z");
    assert.equal(row.companyName, "Alicon Castalloy Limited");
  });

  it("a real BANK record (bank='B') lands as BANK, and its XBRL is BANKING_", () => {
    const p = page(LEGACY_NOV_2024, "legacy");
    const bank = p.entries.find((e) => e.symbol === "ESAFSFB");
    assert.ok(bank !== undefined);
    assert.equal(bank.filerKind, "BANK");
    assert.equal(bank.companyName, "ESAF Small Finance Bank Limited");
    // The filename prefix independently corroborates the flag — a bank files
    // RBI Form-A concepts, and the document parser keys on this prefix.
    assert.ok(
      bank.xbrlUrl.includes("/BANKING_"),
      `expected a BANKING_ document, got ${bank.xbrlUrl}`,
    );
  });

  it("a real NBFC record (bank='F') lands as NBFC, and its XBRL is NBFC_INDAS_", () => {
    const p = page(LEGACY_NOV_2024, "legacy");
    const nbfc = p.entries.find((e) => e.symbol === "JPOLYINVST");
    assert.ok(nbfc !== undefined);
    assert.equal(nbfc.filerKind, "NBFC");
    assert.ok(
      nbfc.xbrlUrl.includes("/NBFC_INDAS_"),
      `expected an NBFC_INDAS_ document, got ${nbfc.xbrlUrl}`,
    );
  });

  it("the whole real page classifies into the census the raw fields imply", () => {
    // End-to-end over 42 real records: the parsed distribution must match the
    // raw field census exactly. This is what catches a regression that only
    // shows up in aggregate, e.g. a flag flip on a minority class.
    const p = page(LEGACY_NOV_2024, "legacy");
    const by = <T extends string>(pick: (e: (typeof p.entries)[number]) => T) =>
      p.entries.reduce<Record<string, number>>((acc, e) => {
        const k = pick(e);
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});

    assert.deepEqual(
      by((e) => e.filerKind),
      { GENERIC: 31, BANK: 6, NBFC: 5 },
    );
    assert.deepEqual(
      by((e) => e.basis),
      { CONSOLIDATED: 16, STANDALONE: 26 },
    );
    assert.deepEqual(
      by((e) => String(e.audited)),
      { false: 38, true: 4 },
    );
    // Every legacy record in the live window is "Non-cumulative" — so this is
    // a field that is ALWAYS false and never null on the legacy index.
    assert.deepEqual(
      by((e) => String(e.cumulative)),
      { false: 42 },
    );
    assert.deepEqual(
      by((e) => String(e.periodType)),
      { QUARTERLY: 42 },
    );
  });

  it("every legacy entry carries an ISIN", () => {
    const p = page(LEGACY_NOV_2024, "legacy");
    for (const e of p.entries) {
      assert.ok(
        e.isin !== null && /^INE|^INF|^IN[0-9A-Z]/.test(e.isin),
        `${e.symbol}: expected an ISIN, got ${String(e.isin)}`,
      );
    }
  });
});

describe("parseFilingIndexPage — modern absent fields are visibly absent", () => {
  it("extracts a known modern record field-by-field (BGLOBAL, 15-Feb-2026)", () => {
    const p = page(INTEGRATED_CAPPED, "integrated");
    const row = p.entries.find((e) => e.symbol === "BGLOBAL");
    assert.ok(row !== undefined, "BGLOBAL must be present");

    assert.equal(row.era, "integrated");
    assert.equal(
      row.xbrlUrl,
      "https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_INDAS_1626351_15022026025328_WEB.xml",
    );
    assert.equal(
      row.ixbrlUrl,
      "https://nsearchives.nseindia.com/corporate/ixbrl/INTEGRATED_FILING_INDAS_143664_15022026145329_iXBRL_WEB.html",
    );
    assert.equal(row.basis, "CONSOLIDATED");
    assert.equal(row.audited, false);
    assert.equal(row.quarterEnd?.toISOString(), "2025-12-31T00:00:00.000Z");
    assert.equal(row.broadcastAt?.toISOString(), "2026-02-15T14:53:12.000Z");
    assert.equal(row.companyName, "Bharatiya Global Infomedia Limited");
  });

  it("REGRESSION: isin / cumulative / periodType are null — not '' and not false", () => {
    // The property: a field the modern index does not carry must be VISIBLY
    // absent. Defaulting `cumulative` to false would state a fact NSE never
    // sent, and — worse — would make the two eras indistinguishable downstream
    // at exactly the point where knowing which one you have matters.
    const p = page(INTEGRATED_CAPPED, "integrated");
    assert.equal(p.entries.length, 20);
    for (const e of p.entries) {
      assert.equal(e.isin, null, `${e.symbol}: isin must be null`);
      assert.notEqual(e.isin, "", `${e.symbol}: isin must not be ""`);

      assert.equal(e.cumulative, null, `${e.symbol}: cumulative must be null`);
      assert.notEqual(e.cumulative, false, `${e.symbol}: NOT false`);

      assert.equal(e.periodType, null, `${e.symbol}: periodType must be null`);
      assert.notEqual(e.periodType, "", `${e.symbol}: NOT ""`);

      // The modern index carries no `bank` field; the filer class is recovered
      // from the XBRL filename by the document parser, not guessed here.
      assert.equal(e.filerKind, "GENERIC");
    }
  });

  it("a revision carries a null broadcastAt — the field is genuinely absent", () => {
    // 3 of the 20 real records are `type_Sub: "Revision"` and NSE sends
    // `broadcast_Date: null` for them (they carry `revised_Date` instead).
    // This is not a parse failure; it is a real hole in the feed, and it is
    // the reason the truncation heuristic below is fragile.
    const p = page(INTEGRATED_CAPPED, "integrated");
    const nullBroadcast = p.entries.filter((e) => e.broadcastAt === null);
    assert.equal(
      nullBroadcast.length,
      3,
      "3 of 20 real records have no broadcast date",
    );
    assert.deepEqual(nullBroadcast.map((e) => e.symbol).sort(), [
      "JAINREC",
      "JAINREC",
      "SALSTEEL",
    ]);
    // They are still perfectly good entries — a missing broadcast timestamp
    // does not make the filing unusable.
    for (const e of nullBroadcast) {
      assert.ok(e.xbrlUrl.endsWith(".xml"));
      assert.equal(e.quarterEnd?.toISOString(), "2025-12-31T00:00:00.000Z");
    }
  });

  it("the era is CALLER-ASSERTED, not detected — a mismatch degrades silently", () => {
    // The two schemas are disjoint (`broadCastDate`/`isin`/`companyName` vs
    // `broadcast_Date`/`qe_Date`/`cmName`), so parsing legacy bytes as
    // "integrated" produces entries with the right symbols and urls but a
    // blank companyName and null dates — no reject, no error. Pinned so the
    // footgun is visible; the caller is what has to get `era` right.
    const wrong = parseFilingIndexPage(LEGACY_NOV_2024, "integrated");
    assert.ok(wrong !== null);
    assert.equal(wrong.entries.length, 42, "it does NOT reject the mismatch");
    assert.deepEqual(wrong.rejected, []);
    for (const e of wrong.entries) {
      assert.equal(
        e.companyName,
        "",
        "cmName/smName do not exist on legacy rows",
      );
      assert.equal(e.quarterEnd, null, "qe_Date does not exist on legacy rows");
      assert.equal(e.broadcastAt, null, "broadcast_Date does not exist either");
    }
  });
});

// ─── 5. detectTruncation ─────────────────────────────────────────────

describe("detectTruncation — the silent 20-record cap", () => {
  it("the server's OWN totalCount is the signal, and it is reported first", () => {
    // The real envelope: {data: [...20...], size: 20, page: -1, totalCount: 7091}.
    // Nothing inferred from shape beats "you received 20 of 7091", so this must
    // win over both the page-size branch and the clustering heuristic.
    const p = page(INTEGRATED_CAPPED, "integrated");
    assert.equal(p.total, 7091, "the fixture carries the real totalCount");
    assert.equal(
      p.serverPageSize,
      20,
      "and the size the server actually applied",
    );

    const v = detectTruncation(p, {
      pageSize: 20,
      windowDays: CAPPED_WINDOW_DAYS,
    });
    assert.equal(v.truncated, true);
    // "the walk has", not "returned" — MONEY-1114. The comparison is against
    // what has been COLLECTED across the query's pages, not against this page,
    // because `totalCount` describes the query. Omitted here, so it defaults to
    // this page's own count and the verdict is unchanged.
    assert.match(v.reason, /totalCount=7091 but the walk has 20/);
  });

  it("a page that returned exactly the requested size is truncated", () => {
    // The page-size branch, reachable only once the exact signal is removed —
    // which is the LEGACY index's situation. 20 records back from a size=20
    // request means there is almost certainly a page 2.
    const p = withoutEnvelope(page(INTEGRATED_CAPPED, "integrated"));
    const v = detectTruncation(p, {
      pageSize: 20,
      windowDays: CAPPED_WINDOW_DAYS,
    });
    assert.equal(v.truncated, true);
    assert.match(v.reason, /exactly the requested size \(20\)/);
  });

  it("the REAL complete page is NOT truncated (the false-positive guard)", () => {
    // WITHOUT this case `detectTruncation` could `return {truncated:true}`
    // unconditionally and pass every other test in this file. 6 records over a
    // single-day window is a genuinely complete answer and must read as one —
    // a permanent false positive means paging forever.
    const p = page(INTEGRATED_COMPLETE, "integrated");
    assert.equal(p.listed, 6);
    assert.equal(distinctBroadcastDays(p, true), 1);

    const v = detectTruncation(p, {
      pageSize: 200,
      windowDays: 1,
      distinctDays: 1,
    });
    assert.equal(v.truncated, false, "a complete answer must not be flagged");
    assert.equal(v.reason, "");
  });

  it("a wide window with well-spread days is NOT truncated", () => {
    // Second false-positive guard, this one on the structural branch: the
    // clustering signal must not fire just because the window is wide.
    const p = page(INTEGRATED_COMPLETE, "integrated");
    const v = detectTruncation(p, {
      pageSize: 200,
      windowDays: 46,
      distinctDays: 30,
    });
    assert.equal(v.truncated, false);
  });

  it("the REAL capped page is truncated when null broadcast dates are EXCLUDED", () => {
    // The intended behaviour. 20 records over a 46-day window landing on 2
    // real broadcast days is the fingerprint of a newest-N cap — the response
    // is ordered newest-first and the cap keeps the head.
    const p = page(INTEGRATED_CAPPED, "integrated");
    assert.equal(p.listed, 20);
    assert.equal(
      distinctBroadcastDays(p, false),
      2,
      "2 real broadcast days: 14-Feb and 15-Feb 2026",
    );

    // With the envelope present the EXACT signal answers it, and better.
    const withTotal = detectTruncation(p, {
      pageSize: 200,
      windowDays: CAPPED_WINDOW_DAYS,
    });
    assert.equal(withTotal.truncated, true, "20 < 200 yet still capped");
    assert.match(withTotal.reason, /totalCount=7091/);

    // Strip the envelope and the STRUCTURAL branch must still catch it on its
    // own. This is the legacy index's only defence, so it has to work without
    // any help from a server-reported count.
    const v = detectTruncation(withoutEnvelope(p), {
      pageSize: 200,
      windowDays: CAPPED_WINDOW_DAYS,
    });
    assert.equal(v.truncated, true, "the heuristic alone must still catch it");
    assert.match(v.reason, /newest-N cap/);
  });

  it("REGRESSION: the REAL capped page is NOT flagged when nulls count as a day", () => {
    // ── DEFECT (reported, not fixed) ──────────────────────────────────────
    // `detectTruncation` takes `distinctDays` from the caller and the module
    // ships NO helper to compute it. On the real capped response the two
    // obvious computations disagree, and the verdict flips with them:
    //
    //   distinct days, nulls skipped          -> 2  -> truncated: TRUE  (right)
    //   distinct values of broadcastAt        -> 3  -> truncated: FALSE (wrong)
    //
    // 3 of the 20 real records are revisions whose `broadcast_Date` is null,
    // so the naive `new Set(entries.map(e => e.broadcastAt))` — which is what
    // a caller writes without knowing the feed has holes — yields 3, the
    // `distinctDays <= 2` guard misses, and the single most dangerous property
    // of this API goes undetected.
    //
    // This asserts the CORRECT verdict, so it FAILS today and documents the
    // gap. Fixing it means owning the computation inside the module (export a
    // `distinctBroadcastDays(page)` that skips nulls) rather than leaving a
    // 2-vs-3 judgement call at every call site.
    const p = page(INTEGRATED_CAPPED, "integrated");
    const naive = distinctBroadcastDays(p, true);
    assert.equal(naive, 3, "3 buckets: 14-Feb, 15-Feb, and the null revisions");

    const v = detectTruncation(p, {
      pageSize: 200,
      windowDays: CAPPED_WINDOW_DAYS,
      distinctDays: naive,
    });
    assert.equal(
      v.truncated,
      true,
      "a 20-record answer to a 46-day window is capped however the caller " +
        "counts days — 3 records with a null broadcast date must not flip the verdict",
    );
  });

  it("the response carried an EXACT truncation signal that the page drops", () => {
    // ── DEFECT / design gap (reported, not fixed) ────────────────────────
    // The module header states "There is no total, no `hasMore`, and no
    // error". That is no longer true of the live API: the integrated endpoint
    // returns {data, size, page, totalCount}, and on the capped window it
    // reports totalCount 7091 alongside its 20 records. That is an exact,
    // unambiguous "you got 20 of 7091" — strictly better than any heuristic.
    //
    // `parseFilingIndexPage` discards the envelope, so `FilingIndexPage` has
    // nowhere to put it and `detectTruncation` cannot use it. This asserts the
    // signal IS in the bytes, so the gap is a decision rather than an oversight.
    const capped = asObject(INTEGRATED_CAPPED, "capped");
    assert.equal(capped.totalCount, 7091);
    assert.equal(
      capped.size,
      20,
      "the response even echoes the cap it applied",
    );
    assert.equal(asArray(capped.data, "capped.data").length, 20);
    assert.ok(
      Number(capped.totalCount) > asArray(capped.data, "capped.data").length,
      "listed < totalCount is truncation, stated by NSE itself",
    );

    // And on the genuinely complete window the same field agrees it is complete.
    const complete = asObject(INTEGRATED_COMPLETE, "complete");
    assert.equal(complete.totalCount, 6);
    assert.equal(asArray(complete.data, "complete.data").length, 6);
  });

  it("an empty page is never reported truncated", () => {
    // `listed > 0` guards this; a quiet window must not trigger endless paging.
    const empty = parseFilingIndexPage([], "legacy");
    assert.ok(empty !== null);
    const v = detectTruncation(empty, {
      pageSize: 200,
      windowDays: 46,
      distinctDays: 0,
    });
    assert.equal(v.truncated, false);
  });

  it("a narrow window is exempt from the clustering rule", () => {
    // windowDays < 5: a single-day window SHOULD have all its records on one
    // day, so clustering says nothing there.
    //
    // Exercised on a LEGACY page, and that is not incidental — MONEY-1235. The
    // clustering rule exists FOR the legacy index, which really does serve a
    // bare array with no envelope. The same envelope-less shape on the MODERN
    // index is now itself a verdict (rule 4: every capture of that endpoint
    // carries `totalCount`, so its absence means the shape changed), which
    // would mask the exemption under test. Using the era the rule belongs to
    // tests the rule instead of the interaction.
    const bare = page(LEGACY_NOV_2024, "legacy");
    assert.equal(bare.total, null, "the legacy index carries no envelope");
    assert.equal(
      detectTruncation(bare, { pageSize: 200, windowDays: 4, distinctDays: 1 })
        .truncated,
      false,
    );
    assert.equal(
      detectTruncation(bare, { pageSize: 200, windowDays: 5, distinctDays: 1 })
        .truncated,
      true,
      "at 5 days the rule switches on",
    );
  });

  it("an exact 'you have them all' SUPPRESSES the clustering heuristic", () => {
    // The complement of the branch above, and the reason the exact signal is
    // checked first. When the server says totalCount == what it returned, the
    // page IS complete — a heuristic must not overrule that and send the caller
    // paging forever through a quiet fortnight that genuinely produced a
    // handful of filings on one day.
    const p = page(INTEGRATED_COMPLETE, "integrated");
    assert.equal(
      p.total,
      p.listed,
      "fixture: the server says this is all of them",
    );

    const v = detectTruncation(p, { pageSize: 200, windowDays: 46 });
    assert.equal(v.truncated, false, "an exact complete must win over shape");
    assert.equal(v.reason, "");
  });

  it("reason is non-empty exactly when truncated is true", () => {
    const p = page(INTEGRATED_CAPPED, "integrated");
    for (const opts of [
      { pageSize: 20, windowDays: 46, distinctDays: 3 },
      { pageSize: 200, windowDays: 46, distinctDays: 2 },
      { pageSize: 200, windowDays: 46, distinctDays: 30 },
      { pageSize: 200, windowDays: 1, distinctDays: 1 },
    ]) {
      const v = detectTruncation(p, opts);
      assert.equal(
        v.reason.length > 0,
        v.truncated,
        `reason/truncated disagree for ${JSON.stringify(opts)}`,
      );
    }
  });
});

// ─── 6. eraForDate ───────────────────────────────────────────────────

describe("eraForDate / INTEGRATED_FILING_ERA_START", () => {
  it("the boundary is exactly 2025-01-01T00:00:00Z", () => {
    assert.equal(INTEGRATED_FILING_ERA_START, Date.UTC(2025, 0, 1));
    assert.equal(
      new Date(INTEGRATED_FILING_ERA_START).toISOString(),
      "2025-01-01T00:00:00.000Z",
    );
  });

  it("REGRESSION: the instant itself is INTEGRATED, not legacy", () => {
    // `>=`, not `>`. An off-by-one here loses or double-fetches the seam day.
    assert.equal(
      eraForDate(new Date(INTEGRATED_FILING_ERA_START)),
      "integrated",
    );
    assert.equal(eraForDate(new Date(Date.UTC(2025, 0, 1))), "integrated");
  });

  it("one millisecond before the boundary is LEGACY", () => {
    assert.equal(
      eraForDate(new Date(INTEGRATED_FILING_ERA_START - 1)),
      "legacy",
    );
    assert.equal(
      eraForDate(new Date(Date.UTC(2024, 11, 31, 23, 59, 59, 999))),
      "legacy",
    );
  });

  it("agrees with the eras the real fixtures were fetched from", () => {
    // Nov-2024 came from the legacy endpoint, Feb-2026 from the integrated one.
    assert.equal(eraForDate(new Date(Date.UTC(2024, 10, 15))), "legacy");
    assert.equal(eraForDate(new Date(Date.UTC(2017, 10, 15))), "legacy");
    assert.equal(eraForDate(new Date(Date.UTC(2026, 1, 15))), "integrated");
    assert.equal(eraForDate(new Date(Date.UTC(2026, 0, 1))), "integrated");
  });

  it("covers the overlap the backfill deliberately walks twice", () => {
    // 2024-10 → 2025-06 is fetched from BOTH indexes because the boundary is a
    // judgement; the upsert key makes the overlap free and a gap invisible.
    assert.equal(eraForDate(new Date(Date.UTC(2024, 9, 1))), "legacy");
    assert.equal(eraForDate(new Date(Date.UTC(2025, 5, 30))), "integrated");
  });
});

// ─── 7. Purity ───────────────────────────────────────────────────────

describe("purity — nothing mutates its input", () => {
  it("parseFilingIndexPage does not touch a deeply frozen payload", () => {
    // ESM is strict mode, so any write to a frozen object THROWS rather than
    // failing silently — this is a real assertion, not a smoke test.
    for (const [name, fx, era] of [
      ["legacy-nov-2024", LEGACY_NOV_2024, "legacy"],
      ["legacy-may-2018", LEGACY_MAY_2018, "legacy"],
      ["integrated-capped", INTEGRATED_CAPPED, "integrated"],
    ] as const) {
      const clone: unknown = JSON.parse(JSON.stringify(fx)) as unknown;
      const before = JSON.stringify(clone);
      deepFreeze(clone);
      assert.doesNotThrow(
        () => parseFilingIndexPage(clone, era),
        `${name}: parseFilingIndexPage mutated its input`,
      );
      assert.equal(JSON.stringify(clone), before, `${name}: payload changed`);
    }
  });

  it("detectTruncation does not mutate the page it inspects", () => {
    const p = page(INTEGRATED_CAPPED, "integrated");
    const before = {
      listed: p.listed,
      stubbed: p.stubbed,
      entries: p.entries.length,
      rejected: p.rejected.length,
      firstSymbol: p.entries[0]?.symbol,
    };
    Object.freeze(p);
    Object.freeze(p.entries);
    Object.freeze(p.rejected);
    assert.doesNotThrow(() =>
      detectTruncation(p, { pageSize: 200, windowDays: 46, distinctDays: 2 }),
    );
    assert.deepEqual(
      {
        listed: p.listed,
        stubbed: p.stubbed,
        entries: p.entries.length,
        rejected: p.rejected.length,
        firstSymbol: p.entries[0]?.symbol,
      },
      before,
    );
  });

  it("the field parsers are total and side-effect free on odd input", () => {
    // No throw for anything, including values that are not strings at all.
    const odd: unknown[] = [
      undefined,
      null,
      "",
      "  ",
      0,
      1,
      NaN,
      true,
      {},
      [],
      new Date(),
    ];
    for (const v of odd) {
      assert.doesNotThrow(() => parseBasis(v));
      assert.doesNotThrow(() => parseAudited(v));
      assert.doesNotThrow(() => parseCumulative(v));
      assert.doesNotThrow(() => parseFilerKind(v));
      assert.doesNotThrow(() => parsePeriodType(v));
      assert.doesNotThrow(() => parseNseIndexDate(v));
      assert.doesNotThrow(() => hasXbrlDocument(v));
    }
  });

  it("parsing the same fixture twice yields deep-equal pages", () => {
    // Catches hidden module-level state (a memo, a counter, a shared array).
    const a = page(LEGACY_MAY_2018, "legacy");
    const b = page(LEGACY_MAY_2018, "legacy");
    assert.deepEqual(a, b);
    assert.notEqual(a.entries, b.entries, "must not hand back the same array");
  });
});

// ─── 7. Revision metadata — MONEY-1235 ───────────────────────────────

describe("the fixture really does contain the revision evidence", () => {
  it("SALSTEEL: the Revision is served BEFORE its own Original", () => {
    // The whole defect in one pair. Both records describe SALSTEEL's
    // 31-DEC-2025 standalone period, so both upsert onto ONE `XbrlFiling` row
    // (the unique key excludes `sourceUrl` on purpose). The modern index serves
    // newest-first, so the Revision arrives at index 8 and the superseded
    // Original at index 9 — and a loop that upserts in index order therefore
    // ends on the ORIGINAL.
    //
    // Pinned against the raw bytes, not against parsed entries: if this fixture
    // is ever re-captured or re-ordered, the ordering tests downstream must go
    // red HERE rather than quietly stop testing anything.
    const recs = asArray(
      asObject(INTEGRATED_CAPPED, "capped").data,
      "capped.data",
    ).map((r) => asObject(r, "record"));

    const revision = recs[8];
    const original = recs[9];
    assert.ok(revision !== undefined && original !== undefined);

    assert.equal(revision.symbol, "SALSTEEL");
    assert.equal(revision.type_Sub, "Revision");
    assert.equal(revision.seq_Id, "143654");
    assert.equal(revision.revised_Date, "14-FEB-2026 23:24:28");
    assert.equal(revision.broadcast_Date, null, "a Revision has NO broadcast");
    assert.equal(
      revision.xbrl,
      "https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_INDAS_1626321_14022026112433_WEB.xml",
    );

    assert.equal(original.symbol, "SALSTEEL");
    assert.equal(original.type_Sub, "Original");
    assert.equal(original.seq_Id, "143653");
    assert.equal(original.revised_Date, null);
    assert.equal(original.broadcast_Date, "14-Feb-2026 23:24:16");
    assert.equal(
      original.xbrl,
      "https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_INDAS_1626320_14022026112420_WEB.xml",
    );

    // Same period, same basis, DIFFERENT url — which is exactly why the
    // pre-download `sourceUrl` skip cannot catch the sibling.
    assert.equal(revision.qe_Date, original.qe_Date);
    assert.equal(revision.consolidated, original.consolidated);
    assert.notEqual(revision.xbrl, original.xbrl);
  });

  it("JAINREC: TWO Revisions of one period, newest first, no Original", () => {
    // The case that rules out a `type_Sub`-based "process Revisions last" rule.
    // Both of these are Revisions, so a kind-based rule leaves them in index
    // order — which is newest-first, so the EARLIER revision (seq 143646) would
    // still be the last write. Only a monotonic sequence separates them.
    const recs = asArray(
      asObject(INTEGRATED_CAPPED, "capped").data,
      "capped.data",
    ).map((r) => asObject(r, "record"));

    const jain = recs
      .map((r, i) => ({ i, r }))
      .filter(({ r }) => r.symbol === "JAINREC");
    assert.equal(jain.length, 2);
    assert.deepEqual(
      jain.map(({ i }) => i),
      [12, 15],
      "and they are not even adjacent in the response",
    );
    for (const { r } of jain) {
      assert.equal(r.type_Sub, "Revision");
      assert.equal(r.qe_Date, "31-DEC-2025");
      assert.equal(r.consolidated, "Standalone");
    }
    assert.deepEqual(
      jain.map(({ r }) => r.seq_Id),
      ["143649", "143646"],
      "newest first — the later revision is served first",
    );
  });

  it("the modern index is NOT reliably ordered, so it cannot just be reversed", () => {
    // Indices 13 and 14 are seq 143647 then 143648 — ASCENDING, inside an
    // otherwise descending list. "Reverse the array" is therefore not a fix,
    // it is a different arbitrary order.
    const recs = asArray(
      asObject(INTEGRATED_CAPPED, "capped").data,
      "capped.data",
    ).map((r) => asObject(r, "record"));
    assert.equal(recs[13]?.seq_Id, "143647");
    assert.equal(recs[14]?.seq_Id, "143648");
    assert.equal(recs[13]?.symbol, "TAKE");
    assert.equal(recs[14]?.symbol, "TAKE");
    // …and where sequence and creation time BOTH exist they agree, which is
    // what makes the sequence trustworthy as the primary ordering key.
    assert.equal(recs[13]?.creation_Date, "14-Feb-2026 22:38:14");
    assert.equal(recs[14]?.creation_Date, "14-Feb-2026 22:38:19");
  });

  it("MEASURED: legacy `reInd` is the ACCOUNTING REGIME, not a revision flag", () => {
    // The reason `normaliseLegacy` sets `revisionKind: null` rather than
    // reading the one legacy field that looks like a revision indicator.
    // Across all 105 legacy records in this repo's fixtures — the 92 asserted
    // below plus the 13 in the three `nse-legacy-index-*.trimmed.json`
    // captures — `reInd` is a 1:1 restatement of `indAs`:
    //
    //     N -> "Ind-AS New"  80/80    A -> "Non-Ind-AS"  20/20
    //     F -> "NBFC-IND"     5/5
    //
    // `reInd !== "N"` as "revised" would label 25 of those 105 (23.8%)
    // revisions, every one wrongly — and since revisions sort LAST, it would
    // hand the write order to a column about accounting standards.
    const legacy = [
      ...asArray(LEGACY_NOV_2024, "nov-2024"),
      ...asArray(LEGACY_MAY_2018, "may-2018"),
      ...asArray(LEGACY_NOV_2017, "nov-2017"),
    ].map((r) => asObject(r, "record"));
    assert.equal(legacy.length, 92, "the three legacy fixtures");

    const EXPECTED: Record<string, string> = {
      N: "Ind-AS New",
      A: "Non-Ind-AS",
      F: "NBFC-IND",
    };
    const seen = new Set<string>();
    for (const r of legacy) {
      const reInd = String(r.reInd);
      seen.add(reInd);
      assert.equal(
        r.indAs,
        EXPECTED[reInd],
        `reInd=${reInd} must mean indAs=${EXPECTED[reInd]}, got ${String(r.indAs)}`,
      );
    }
    assert.deepEqual([...seen].sort(), ["A", "F", "N"], "all three letters");

    // And the other lookalike, `oldNewFlag`, takes exactly one value plus
    // explicit null — so no mapping can be established from it either. A field
    // that is never anything but "N" or null cannot distinguish two siblings.
    const flags = new Set(legacy.map((r) => String(r.oldNewFlag)));
    assert.deepEqual([...flags].sort(), ["N", "null"]);
  });
});

describe("parseRevisionKind — MODERN ONLY, and unknown is null", () => {
  it("reads NSE's two words", () => {
    assert.equal(parseRevisionKind("Original"), "ORIGINAL");
    assert.equal(parseRevisionKind("Revision"), "REVISION");
  });

  it("is case- and whitespace-insensitive, like every other flag parser here", () => {
    assert.equal(parseRevisionKind("  revision  "), "REVISION");
    assert.equal(parseRevisionKind("ORIGINAL"), "ORIGINAL");
    // "Revised" is the other spelling NSE uses for the same idea in
    // `revised_Date` / `revision_Remark`; accept the stem rather than the word.
    assert.equal(parseRevisionKind("Revised"), "REVISION");
  });

  it("an ABSENT or UNKNOWN value is null, never a confident ORIGINAL", () => {
    // The legacy index sends nothing, and a new `type_Sub` value appearing
    // upstream must read as "this index did not say" — which is a different
    // claim from "this is the first publication" and has to stay different.
    for (const v of [undefined, null, "", "   ", 0, true, {}, []]) {
      assert.equal(parseRevisionKind(v), null, `${String(v)} must be null`);
    }
    assert.equal(parseRevisionKind("Withdrawal"), null);
  });
});

describe("parseIndexSequence — both eras serve it as a STRING", () => {
  it("parses the real values from both eras", () => {
    assert.equal(parseIndexSequence("143654"), 143654);
    assert.equal(parseIndexSequence("1189117"), 1189117);
    // A number would also be accepted, but NSE has never sent one.
    assert.equal(parseIndexSequence(143654), 143654);
  });

  it("REFUSES anything that is not a run of digits — 0 is not a fallback", () => {
    // `Number("")` and `Number("  ")` are both 0, not NaN. A sequence that
    // silently became 0 would sort its record among the very earliest real
    // sequences and let everything else overwrite it, with nothing to see in
    // any log — so the digits test is the guard, not a `Number()` round trip.
    for (const v of [
      "",
      "  ",
      "12a",
      "-5",
      "1.5",
      "1e3",
      null,
      undefined,
      {},
      [],
      true,
      NaN,
    ]) {
      assert.equal(parseIndexSequence(v), null, `${String(v)} must be null`);
    }
  });

  it("trims, because every other field parser in this module does", () => {
    // Consistency is the point: `str()` trims for `parseBasis`, `parseAudited`
    // and the rest, so a padded sequence must not be the one field that rejects.
    assert.equal(parseIndexSequence("  143654  "), 143654);
  });
});

describe("parseFilingIndexPage — the revision metadata reaches the entry", () => {
  it("SALSTEEL's Revision and Original both parse, with their own metadata", () => {
    const p = page(INTEGRATED_CAPPED, "integrated");
    const sal = p.entries.filter((e) => e.symbol === "SALSTEEL");
    assert.equal(sal.length, 2, "both siblings become entries");

    const rev = sal.find((e) => e.revisionKind === "REVISION");
    const orig = sal.find((e) => e.revisionKind === "ORIGINAL");
    assert.ok(rev !== undefined && orig !== undefined);

    assert.equal(rev.indexSequence, 143654);
    assert.equal(rev.createdAt?.toISOString(), "2026-02-14T23:24:33.000Z");
    // Served UPPER-CASED ("14-FEB-2026") where creation_Date is title-cased.
    assert.equal(rev.revisedAt?.toISOString(), "2026-02-14T23:24:28.000Z");
    assert.equal(rev.broadcastAt, null);

    assert.equal(orig.indexSequence, 143653);
    assert.equal(orig.createdAt?.toISOString(), "2026-02-14T23:24:20.000Z");
    assert.equal(orig.revisedAt, null, "an Original was never revised");
    assert.equal(orig.broadcastAt?.toISOString(), "2026-02-14T23:24:16.000Z");
  });

  it("every revision in the fixture supplies a date the broadcast column does not", () => {
    // The `filedAt` fallback's whole justification: the 3 records with a null
    // broadcast are exactly the 3 revisions, and every one of them carries a
    // `revised_Date`. Without the fallback a revision write nulls a `filedAt`
    // its Original had already supplied.
    const p = page(INTEGRATED_CAPPED, "integrated");
    const revisions = p.entries.filter((e) => e.revisionKind === "REVISION");
    assert.equal(revisions.length, 3);
    for (const e of revisions) {
      assert.equal(e.broadcastAt, null, `${e.symbol}: no broadcast date`);
      assert.ok(e.revisedAt !== null, `${e.symbol}: but it HAS a revised date`);
    }
    // …and the converse: nothing with a broadcast date is missing one.
    const nullBroadcast = p.entries.filter((e) => e.broadcastAt === null);
    assert.equal(nullBroadcast.length, 3);
  });

  it("every modern entry carries a sequence and a creation time", () => {
    // 61 records across 5 captures had both, non-null and numeric. If NSE ever
    // stops sending one the ordering degrades to the other, but this pins that
    // the primary key is actually populated on real data rather than always
    // falling through to the tie-breaks.
    for (const fx of [INTEGRATED_CAPPED, INTEGRATED_COMPLETE]) {
      for (const e of page(fx, "integrated").entries) {
        assert.ok(
          e.indexSequence !== null && e.indexSequence > 0,
          `${e.symbol}: indexSequence`,
        );
        assert.ok(e.createdAt !== null, `${e.symbol}: createdAt`);
      }
    }
  });

  it("legacy entries carry the sequence and NOTHING else — measured, not missing", () => {
    const p = page(LEGACY_NOV_2024, "legacy");
    assert.equal(p.entries.length, 42);
    for (const e of p.entries) {
      assert.equal(e.revisionKind, null, `${e.symbol}: legacy states no kind`);
      assert.equal(e.revisedAt, null);
      assert.equal(e.createdAt, null);
      assert.ok(
        e.indexSequence !== null && e.indexSequence > 1_000_000,
        `${e.symbol}: seqNumber is the one ordering signal legacy has`,
      );
    }
    // Legacy sequences live a whole order of magnitude above modern ones
    // (1.18M vs 143k), which is why the write comparator sorts on ERA first and
    // never compares the two ranges numerically.
    const modern = page(INTEGRATED_CAPPED, "integrated").entries;
    const maxModern = Math.max(...modern.map((e) => e.indexSequence ?? 0));
    const minLegacy = Math.min(...p.entries.map((e) => e.indexSequence ?? 0));
    assert.ok(
      minLegacy > maxModern,
      `a 2019 legacy seq (${minLegacy}) outranks a 2026 modern one (${maxModern})`,
    );
  });
});

describe("detectTruncation — an ABSENT envelope on the MODERN index (MONEY-1235)", () => {
  it("a modern page with no totalCount is SUSPECT even when nothing else fires", () => {
    // The residual hole. Construct the case rules 1-3 all miss: no envelope
    // (rule 1 has nothing to read), a short page (rule 2 needs listed >=
    // pageSize), and a narrow window (rule 3 needs windowDays >= 5). Before
    // this rule that combination returned `truncated: false` — a capped
    // response reported as a complete one.
    const bare = withoutEnvelope(page(INTEGRATED_COMPLETE, "integrated"));
    assert.equal(bare.total, null);
    assert.equal(bare.listed, 6);

    const v = detectTruncation(bare, { pageSize: 500, windowDays: 1 });
    assert.equal(v.truncated, true);
    assert.match(v.reason, /NO totalCount envelope/);
    assert.match(v.reason, /response shape has changed/);
  });

  it("the same shape on the LEGACY index is NORMAL and must not be flagged", () => {
    // The legacy index really does serve a bare array with no envelope at all.
    // Firing there would put a permanent truncation warning on every legacy
    // page of the backfill — and a warning that always fires is not a signal.
    const p = page(LEGACY_NOV_2017, "legacy");
    assert.equal(p.total, null, "legacy genuinely has no envelope");
    assert.equal(p.listed, 18);

    const v = detectTruncation(p, { pageSize: 500, windowDays: 1 });
    assert.equal(
      v.truncated,
      false,
      "no envelope is the legacy index's normal",
    );
    assert.equal(v.reason, "");
  });

  it("it is LAST — a rule that names the actual cause still wins", () => {
    // Rules 1-3 are strictly more useful than "the shape changed", so the
    // catch-all must not shadow them. All three of these are envelope-less
    // MODERN pages, i.e. they satisfy rule 4's condition too.
    const capped = withoutEnvelope(page(INTEGRATED_CAPPED, "integrated"));

    // rule 2 — a full page
    assert.match(
      detectTruncation(capped, { pageSize: 20, windowDays: 46 }).reason,
      /exactly the requested size \(20\)/,
    );
    // rule 3 — the newest-N fingerprint
    assert.match(
      detectTruncation(capped, { pageSize: 200, windowDays: 46 }).reason,
      /newest-N cap/,
    );
    // rule 1 — the server's own count, with the envelope restored
    assert.match(
      detectTruncation(page(INTEGRATED_CAPPED, "integrated"), {
        pageSize: 200,
        windowDays: 46,
      }).reason,
      /totalCount=7091/,
    );
  });

  it("a modern page WITH an envelope that says complete is still complete", () => {
    // The false-positive guard for the new rule: it keys on the envelope being
    // ABSENT, never on its contents, so an honest `totalCount == listed` must
    // continue to read as complete.
    const p = page(INTEGRATED_COMPLETE, "integrated");
    assert.equal(p.total, 6);
    assert.equal(
      detectTruncation(p, { pageSize: 500, windowDays: 1 }).truncated,
      false,
    );
  });
});
