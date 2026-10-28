/**
 * UNIT TEST — MONEY-1098 NSE issues / annual-reports / integrated-filings.
 *
 * Exercises the REAL exports (no shadow copies) from:
 *   - `@usemoney/research/data-sources/issues-logic` — every parser, the merge,
 *     the period keys and the weekly sharder
 *   - `@usemoney/research/data-sources/nse-issues` — the fetchers, driven
 *     through their injected `fetchImpl` so nothing here touches the network
 *
 * ## Every fixture below is SYNTHETIC
 *
 * Hand-written to the shape the code EXPECTS, not captured from NSE. That is a
 * real limitation and it is stated rather than hidden: these tests prove the
 * parsers are internally consistent and total (no throw, no Invalid Date, no
 * NaN, correct keys and time zone), and they prove NOTHING about whether NSE
 * actually spells a field `issueStartDate`. The one exception is
 * {@link CONFIRMED_INTEGRATED_FILING_ROW}, whose six keys come from the
 * MONEY-1097 P1 probe capture (`docs/reference/exchange-archive-probe.json` →
 * `nse-api/integrated-filing-results/bulk`, HTTP 200 / 15,066 bytes) and are
 * therefore real. See the task report for the full falsification list.
 *
 * Pure functions and injected fakes only: no Prisma, no GCS, no live fetch, no
 * unawaited timers — nothing here can orphan the runner.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  // primitives
  pickString,
  pickNumber,
  pickRaw,
  parseIndianNumber,
  parseNseDate,
  formatNseQueryDate,
  normalizeIssueSymbol,
  parsePriceBand,
  unwrapRows,
  summarizeUnmappedKeys,
  IST_OFFSET_MS,
  // annual reports
  annualReportPeriod,
  parseAnnualReports,
  dedupeAnnualReports,
  // ipo
  parseIpoRow,
  parseIpoIssues,
  deriveIpoStatus,
  normalizeIpoStatus,
  mergeIpoIssues,
  ipoKey,
  IPO_KEYS,
  // integrated filings
  integratedFilingPeriod,
  parseIntegratedFilings,
  dedupeIntegratedFilings,
  renderIntegratedFilingText,
  // sharding
  symbolShard,
  weekShardIndex,
  selectWeeklyShard,
  orderShardByStaleness,
  WEEKLY_SHARD_COUNT,
  type IpoIssue,
} from "@usemoney/research/data-sources/issues-logic";

import {
  extractCookies,
  fetchAnnualReports,
  fetchUpcomingIpos,
  fetchIntegratedFilings,
  type NseFetchImpl,
  type NseResponseLike,
} from "@usemoney/research/data-sources/nse-issues";

// ── Fake HTTP ────────────────────────────────────────────────────────────

/** Minimal {@link NseResponseLike} stand-in. */
function response(
  body: string,
  init?: { ok?: boolean; status?: number; setCookie?: string },
): NseResponseLike {
  const setCookie = init?.setCookie ?? null;
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "set-cookie" ? setCookie : null,
    },
    text: () => Promise.resolve(body),
  };
}

interface FakeFetch {
  impl: NseFetchImpl;
  urls: string[];
  cookies: (string | undefined)[];
}

/**
 * A fetch fake that answers the cookie handshake successfully and then serves
 * `apiResponder` for every API call. The handshake MUST succeed here: a failing
 * one drives the (correct) 3-attempt backoff in `getSession`, which would make
 * these tests spend seconds sleeping for no added coverage.
 */
function fakeFetch(
  apiResponder: (url: string) => NseResponseLike | Promise<NseResponseLike>,
): FakeFetch {
  const urls: string[] = [];
  const cookies: (string | undefined)[] = [];
  const impl: NseFetchImpl = (url, init) => {
    urls.push(url);
    cookies.push(init?.headers?.Cookie);
    if (!url.includes("/api/")) {
      return Promise.resolve(
        response("<html>home</html>", {
          setCookie:
            "nsit=abc123; Expires=Mon, 29 Mar 2027 10:00:00 GMT; Path=/, " +
            "nseappid=xyz789; Path=/",
        }),
      );
    }
    return Promise.resolve(apiResponder(url));
  };
  return { impl, urls, cookies };
}

// ── Fixtures (SYNTHETIC unless noted) ────────────────────────────────────

/**
 * REAL keys — the six proven by the MONEY-1097 P1 probe preview. The values are
 * the captured ones; no key here is a guess.
 */
const CONFIRMED_INTEGRATED_FILING_ROW = {
  attFileSize: "0 Bytes",
  audited: "Un-Audited",
  broadcast_Date: "07-Aug-2026 23:00:20",
  cmName: "Excelsoft Technologies Limited",
  consolidated: "Standalone",
  creation_Date: "07-Aug-2026 23:00:05",
  // SYNTHETIC addition — the probe preview was truncated before any symbol
  // field, so this key is a GUESS and the test says so.
  symbol: "EXCELSOFT",
} as const;

/** SYNTHETIC — annual-reports row in the shape `parseAnnualReports` expects. */
const SYNTHETIC_ANNUAL_ROW = {
  companyName: "Reliance Industries Limited",
  from_yr: "2023",
  to_yr: "2024",
  fileName: "/corporates/annualreports/RELIANCE_2024.pdf",
  fileSize: "4,512,000",
} as const;

/** SYNTHETIC — IPO row. Every key here is a guess. */
const SYNTHETIC_IPO_ROW = {
  symbol: "NEWCO",
  companyName: "New Co Limited",
  series: "EQ",
  issueStartDate: "12-Aug-2026",
  issueEndDate: "14-Aug-2026",
  issuePrice: "450 - 475",
  issueSize: "1,20,00,000",
  lotSize: "31",
  status: "Forthcoming",
} as const;

// ── Primitives ───────────────────────────────────────────────────────────

describe("pickString", () => {
  it("returns the first candidate that resolves, in order", () => {
    const row = { b: "second", a: "first" };
    assert.equal(pickString(row, ["a", "b"]), "first");
    assert.equal(pickString(row, ["b", "a"]), "second");
  });

  it("falls back to a case-insensitive match", () => {
    assert.equal(pickString({ SYMBOL: "TCS" }, ["symbol"]), "TCS");
  });

  it("trims — a trailing space would fragment a unique key", () => {
    assert.equal(pickString({ symbol: "RELIANCE " }, ["symbol"]), "RELIANCE");
  });

  it("coerces a numeric value to its string form", () => {
    assert.equal(pickString({ code: 500325 }, ["code"]), "500325");
  });

  it("treats empty / whitespace / missing as unresolved", () => {
    assert.equal(pickString({ a: "", b: "   " }, ["a", "b", "c"]), null);
  });
});

describe("parseIndianNumber", () => {
  it("parses Indian digit grouping", () => {
    assert.equal(parseIndianNumber("1,20,00,000"), 12000000);
  });

  it("strips currency and unit noise", () => {
    assert.equal(parseIndianNumber("₹ 450.00"), 450);
    assert.equal(parseIndianNumber("Rs.10"), 10);
    assert.equal(parseIndianNumber("0 Bytes"), 0);
  });

  it("takes only the FIRST token of a range", () => {
    assert.equal(parseIndianNumber("450 - 475"), 450);
  });

  it("returns null rather than NaN for junk", () => {
    assert.equal(parseIndianNumber("N/A"), null);
    assert.equal(parseIndianNumber("--"), null);
    assert.equal(parseIndianNumber(undefined), null);
    assert.equal(parseIndianNumber(Number.NaN), null);
    assert.equal(parseIndianNumber(Number.POSITIVE_INFINITY), null);
  });

  it("passes finite numbers through", () => {
    assert.equal(parseIndianNumber(42.5), 42.5);
  });
});

describe("pickNumber", () => {
  it("resolves through candidates and case-insensitively", () => {
    assert.equal(pickNumber({ LotSize: "31" }, ["lotSize"]), 31);
  });

  it("is null when nothing numeric resolves", () => {
    assert.equal(pickNumber({ a: "none" }, ["a", "b"]), null);
  });
});

describe("parseNseDate", () => {
  it("reads DD-MMM-YYYY HH:mm:ss AS IST", () => {
    // 23:00:20 IST on 7 Aug 2026 is 17:30:20Z the same day.
    const d = parseNseDate("07-Aug-2026 23:00:20");
    assert.equal(d?.toISOString(), "2026-08-07T17:30:20.000Z");
  });

  it("reads DD-MM-YYYY as IST midnight", () => {
    // 7 Aug 2026 00:00 IST is 6 Aug 2026 18:30Z — the PREVIOUS UTC day, which
    // is exactly the shift that would duplicate an IPO row if it were ignored.
    const d = parseNseDate("07-08-2026");
    assert.equal(d?.toISOString(), "2026-08-06T18:30:00.000Z");
  });

  it("reads a date-only DD-MMM-YYYY", () => {
    assert.equal(
      parseNseDate("12-Aug-2026")?.toISOString(),
      "2026-08-11T18:30:00.000Z",
    );
  });

  it("passes an explicit-zone ISO string through unshifted", () => {
    assert.equal(
      parseNseDate("2026-08-07T12:00:00.000Z")?.toISOString(),
      "2026-08-07T12:00:00.000Z",
    );
  });

  it("returns null — never an Invalid Date — for junk", () => {
    for (const junk of ["", "   ", "garbage", "31-Foo-2026", null, undefined, {}]) {
      assert.equal(parseNseDate(junk), null, `expected null for ${String(junk)}`);
    }
  });

  it("rejects an Invalid Date instance", () => {
    assert.equal(parseNseDate(new Date("nope")), null);
  });

  it("passes a valid Date instance through", () => {
    const d = new Date("2026-08-07T00:00:00.000Z");
    assert.equal(parseNseDate(d), d);
  });
});

describe("formatNseQueryDate", () => {
  it("formats in IST, not UTC", () => {
    // 20:00Z on 7 Aug is 01:30 IST on 8 Aug — the query must ask for the 8th.
    assert.equal(
      formatNseQueryDate(new Date("2026-08-07T20:00:00.000Z")),
      "08-08-2026",
    );
  });

  it("zero-pads day and month", () => {
    assert.equal(
      formatNseQueryDate(new Date("2026-01-05T06:00:00.000Z")),
      "05-01-2026",
    );
  });

  it("round-trips with parseNseDate at IST midnight", () => {
    const parsed = parseNseDate("07-08-2026");
    assert.ok(parsed);
    assert.equal(formatNseQueryDate(parsed), "07-08-2026");
  });
});

describe("normalizeIssueSymbol", () => {
  it("strips the exchange suffix and upper-cases", () => {
    assert.equal(normalizeIssueSymbol("reliance.ns"), "RELIANCE");
    assert.equal(normalizeIssueSymbol(" tcs.BO "), "TCS");
  });

  it("is total on empty input", () => {
    assert.equal(normalizeIssueSymbol(""), "");
  });
});

describe("parsePriceBand", () => {
  it("splits a range", () => {
    assert.deepEqual(parsePriceBand("450 - 475"), { min: 450, max: 475 });
  });

  it("handles a single price", () => {
    assert.deepEqual(parsePriceBand("475"), { min: 475, max: 475 });
    assert.deepEqual(parsePriceBand(475), { min: 475, max: 475 });
  });

  it("orders a reversed band", () => {
    assert.deepEqual(parsePriceBand("₹475 to ₹450"), { min: 450, max: 475 });
  });

  it("is null/null when nothing numeric is present", () => {
    assert.deepEqual(parsePriceBand("TBA"), { min: null, max: null });
  });
});

describe("unwrapRows", () => {
  it("accepts a bare array and every known envelope", () => {
    const row = { a: 1 };
    assert.deepEqual(unwrapRows([row]), [row]);
    assert.deepEqual(unwrapRows({ data: [row] }), [row]);
    assert.deepEqual(unwrapRows({ results: [row] }), [row]);
    assert.deepEqual(unwrapRows({ rows: [row] }), [row]);
  });

  it("drops non-object entries instead of coercing them", () => {
    assert.deepEqual(unwrapRows(["a", 1, null, { b: 2 }]), [{ b: 2 }]);
  });

  it("is [] for anything unrecognised", () => {
    assert.deepEqual(unwrapRows(null), []);
    assert.deepEqual(unwrapRows("string"), []);
    assert.deepEqual(unwrapRows({ nope: [] }), []);
  });
});

describe("pickRaw", () => {
  it("returns the untouched value of the first present key", () => {
    assert.equal(pickRaw({ a: 0 }, ["a"]), 0);
    assert.equal(pickRaw({ a: "", b: "x" }, ["a", "b"]), "x");
    assert.equal(pickRaw({}, ["a"]), undefined);
  });
});

describe("summarizeUnmappedKeys", () => {
  it("names the field groups that never resolved, and what WAS there", () => {
    const rows = [{ sym: "TCS", when: "07-Aug-2026" }];
    const out = summarizeUnmappedKeys(rows, {
      symbol: ["sym"],
      issueStart: ["issueStartDate", "openDate"],
    });
    assert.deepEqual(out.unresolved, ["issueStart"]);
    assert.deepEqual(out.observedKeys, ["sym", "when"]);
  });

  it("reports nothing unresolved when every group hits", () => {
    const out = summarizeUnmappedKeys([{ symbol: "TCS" }], {
      symbol: ["symbol"],
    });
    assert.deepEqual(out.unresolved, []);
  });
});

// ── Annual reports ───────────────────────────────────────────────────────

describe("annualReportPeriod", () => {
  it("prefers the END year (Indian FY convention)", () => {
    assert.equal(annualReportPeriod("2023", "2024"), "FY2024");
  });

  it("derives the end year when only the start is present", () => {
    assert.equal(annualReportPeriod("2023", null), "FY2024");
  });

  it("falls back to a year in the filename", () => {
    assert.equal(annualReportPeriod(null, null, "AR_2022_final.pdf"), "FY2022");
  });

  it("is a stable sentinel when nothing resolves", () => {
    assert.equal(annualReportPeriod(null, null, "report.pdf"), "unknown-year");
  });

  it("ignores non-4-digit year junk", () => {
    assert.equal(annualReportPeriod("FY23", "n/a"), "unknown-year");
  });

  it("is deterministic — the same row always yields the same key", () => {
    // The dedupe contract: a run-dependent key would re-download every report.
    assert.equal(
      annualReportPeriod("2023", "2024"),
      annualReportPeriod("2023", "2024"),
    );
  });
});

describe("parseAnnualReports", () => {
  it("maps a SYNTHETIC row from both envelope shapes identically", () => {
    const fromArray = parseAnnualReports("RELIANCE", [SYNTHETIC_ANNUAL_ROW]);
    const fromData = parseAnnualReports("RELIANCE", {
      data: [SYNTHETIC_ANNUAL_ROW],
    });
    assert.deepEqual(fromArray, fromData);
    const first = fromArray[0];
    assert.ok(first);
    assert.equal(first.symbol, "RELIANCE");
    assert.equal(first.companyName, "Reliance Industries Limited");
    assert.equal(first.period, "FY2024");
    assert.equal(
      first.attachmentUrl,
      "/corporates/annualreports/RELIANCE_2024.pdf",
    );
    assert.equal(first.fileSizeBytes, 4512000);
  });

  it("prefers the row's own symbol over the requested one", () => {
    const out = parseAnnualReports("RELIANCE", [
      { ...SYNTHETIC_ANNUAL_ROW, symbol: "ril.ns" },
    ]);
    assert.equal(out[0]?.symbol, "RIL");
  });

  it("is [] for an unusable payload rather than throwing", () => {
    assert.deepEqual(parseAnnualReports("TCS", null), []);
    assert.deepEqual(parseAnnualReports("TCS", { unexpected: true }), []);
  });

  it("keeps a row with no attachment (the filter is dedupe's job)", () => {
    const out = parseAnnualReports("TCS", [{ to_yr: "2024" }]);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.attachmentUrl, null);
  });
});

describe("dedupeAnnualReports", () => {
  it("drops rows with no attachment", () => {
    const out = dedupeAnnualReports(
      parseAnnualReports("TCS", [{ to_yr: "2024" }]),
    );
    assert.equal(out.length, 0);
  });

  it("keeps the FIRST of two rows sharing a period key", () => {
    const out = dedupeAnnualReports(
      parseAnnualReports("TCS", [
        { to_yr: "2024", fileName: "/a.pdf" },
        { to_yr: "2024", fileName: "/b.pdf" },
      ]),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]?.attachmentUrl, "/a.pdf");
  });

  it("keeps distinct periods", () => {
    const out = dedupeAnnualReports(
      parseAnnualReports("TCS", [
        { to_yr: "2024", fileName: "/a.pdf" },
        { to_yr: "2023", fileName: "/b.pdf" },
      ]),
    );
    assert.equal(out.length, 2);
  });
});

// ── IPO ──────────────────────────────────────────────────────────────────

const NOW = new Date("2026-08-13T06:00:00.000Z"); // 11:30 IST, 13 Aug 2026

describe("deriveIpoStatus", () => {
  const d = (iso: string): Date => new Date(iso);

  it("is UPCOMING before the window opens", () => {
    assert.equal(
      deriveIpoStatus(
        { issueStart: d("2026-08-20T00:00:00Z"), issueEnd: null, listingDate: null },
        NOW,
      ),
      "UPCOMING",
    );
  });

  it("is OPEN inside the window", () => {
    assert.equal(
      deriveIpoStatus(
        {
          issueStart: d("2026-08-12T00:00:00Z"),
          issueEnd: d("2026-08-14T00:00:00Z"),
          listingDate: null,
        },
        NOW,
      ),
      "OPEN",
    );
  });

  it("is CLOSED after the window", () => {
    assert.equal(
      deriveIpoStatus(
        {
          issueStart: d("2026-08-01T00:00:00Z"),
          issueEnd: d("2026-08-05T00:00:00Z"),
          listingDate: null,
        },
        NOW,
      ),
      "CLOSED",
    );
  });

  it("LISTED wins over CLOSED once the listing date passes", () => {
    assert.equal(
      deriveIpoStatus(
        {
          issueStart: d("2026-08-01T00:00:00Z"),
          issueEnd: d("2026-08-05T00:00:00Z"),
          listingDate: d("2026-08-08T00:00:00Z"),
        },
        NOW,
      ),
      "LISTED",
    );
  });

  it("is UPCOMING when every date is missing", () => {
    assert.equal(
      deriveIpoStatus(
        { issueStart: null, issueEnd: null, listingDate: null },
        NOW,
      ),
      "UPCOMING",
    );
  });
});

describe("normalizeIpoStatus", () => {
  it("maps NSE's vocabulary", () => {
    assert.equal(normalizeIpoStatus("Forthcoming"), "UPCOMING");
    assert.equal(normalizeIpoStatus("Active"), "OPEN");
    assert.equal(normalizeIpoStatus("Closed"), "CLOSED");
    assert.equal(normalizeIpoStatus("Listed"), "LISTED");
  });

  it("is null for an unrecognised or missing status", () => {
    assert.equal(normalizeIpoStatus("something else"), null);
    assert.equal(normalizeIpoStatus(null), null);
  });
});

describe("parseIpoRow", () => {
  it("maps a SYNTHETIC row end-to-end", () => {
    const issue = parseIpoRow(SYNTHETIC_IPO_ROW, "upcoming", NOW);
    assert.equal(issue.symbol, "NEWCO");
    assert.equal(issue.companyName, "New Co Limited");
    assert.equal(issue.series, "EQ");
    assert.equal(issue.priceMin, 450);
    assert.equal(issue.priceMax, 475);
    assert.equal(issue.issueSize, 12000000);
    assert.equal(issue.lotSize, 31);
    assert.equal(issue.isSme, false);
    assert.equal(issue.source, "upcoming");
    assert.equal(issue.issueStart?.toISOString(), "2026-08-11T18:30:00.000Z");
  });

  it("trusts a recognised status string over the derived one", () => {
    // The dates say OPEN (12→14 Aug straddles NOW); NSE says Forthcoming.
    assert.equal(parseIpoRow(SYNTHETIC_IPO_ROW, "upcoming", NOW).status,
      "UPCOMING");
  });

  it("derives the status when NSE's string is unrecognised", () => {
    const issue = parseIpoRow(
      { ...SYNTHETIC_IPO_ROW, status: "???" },
      "current",
      NOW,
    );
    assert.equal(issue.status, "OPEN");
  });

  it("flags SME from the series OR the category", () => {
    assert.equal(
      parseIpoRow({ ...SYNTHETIC_IPO_ROW, series: "SME" }, "upcoming", NOW).isSme,
      true,
    );
    assert.equal(
      parseIpoRow(
        { ...SYNTHETIC_IPO_ROW, series: "EQ", category: "SME Platform" },
        "upcoming",
        NOW,
      ).isSme,
      true,
    );
  });

  it("produces nulls — not NaN or Invalid Date — for an empty row", () => {
    const issue = parseIpoRow({}, "past", NOW);
    assert.equal(issue.symbol, "");
    assert.equal(issue.issueStart, null);
    assert.equal(issue.issueEnd, null);
    assert.equal(issue.priceMin, null);
    assert.equal(issue.priceMax, null);
    assert.equal(issue.issueSize, null);
    assert.equal(issue.lotSize, null);
    assert.equal(issue.listingDate, null);
    assert.equal(issue.status, "UPCOMING");
  });

  it("reads the separate min/max keys in preference to a band", () => {
    const issue = parseIpoRow(
      { ...SYNTHETIC_IPO_ROW, minPrice: "100", maxPrice: "110" },
      "upcoming",
      NOW,
    );
    assert.equal(issue.priceMin, 100);
    assert.equal(issue.priceMax, 110);
  });
});

describe("parseIpoIssues", () => {
  it("maps every envelope shape and tags the source", () => {
    const rows = parseIpoIssues({ data: [SYNTHETIC_IPO_ROW] }, "current", NOW);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.source, "current");
  });

  it("is [] for an unusable payload", () => {
    assert.deepEqual(parseIpoIssues(null, "past", NOW), []);
  });
});

describe("mergeIpoIssues", () => {
  const base = (
    source: IpoIssue["source"],
    over: Partial<IpoIssue>,
  ): IpoIssue => ({
    symbol: "NEWCO",
    companyName: null,
    series: null,
    issueStart: new Date("2026-08-11T18:30:00.000Z"),
    issueEnd: null,
    status: "UPCOMING",
    priceMin: null,
    priceMax: null,
    issueSize: null,
    lotSize: null,
    listingDate: null,
    isSme: false,
    source,
    raw: {},
    ...over,
  });

  it("gives `current` precedence over `upcoming` and `past`", () => {
    const merged = mergeIpoIssues(
      [base("past", { priceMin: 100, status: "CLOSED" })],
      [base("upcoming", { priceMin: 200 })],
      [base("current", { priceMin: 300, status: "OPEN" })],
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.priceMin, 300);
    assert.equal(merged[0]?.status, "OPEN");
  });

  it("still fills gaps from the lower-precedence rows", () => {
    // `past` is usually the ONLY carrier of listingDate — last-write-wins
    // would throw it away.
    const merged = mergeIpoIssues(
      [base("past", { listingDate: new Date("2026-08-20T00:00:00Z") })],
      [base("current", { priceMin: 300 })],
    );
    assert.equal(merged[0]?.priceMin, 300);
    assert.equal(
      merged[0]?.listingDate?.toISOString(),
      "2026-08-20T00:00:00.000Z",
    );
  });

  it("ORs isSme rather than letting the winner clear it", () => {
    const merged = mergeIpoIssues(
      [base("past", { isSme: true })],
      [base("current", { isSme: false })],
    );
    assert.equal(merged[0]?.isSme, true);
  });

  it("keeps different issueStarts as separate rows (same symbol)", () => {
    const merged = mergeIpoIssues(
      [base("past", { issueStart: new Date("2024-01-01T00:00:00Z") })],
      [base("current", {})],
    );
    assert.equal(merged.length, 2);
  });

  it("drops symbol-less rows", () => {
    assert.equal(mergeIpoIssues([base("current", { symbol: "" })]).length, 0);
  });

  it("is order-independent for the same inputs", () => {
    const a = mergeIpoIssues(
      [base("current", { priceMin: 300 })],
      [base("past", { priceMin: 100 })],
    );
    const b = mergeIpoIssues(
      [base("past", { priceMin: 100 })],
      [base("current", { priceMin: 300 })],
    );
    assert.equal(a[0]?.priceMin, b[0]?.priceMin);
  });
});

describe("ipoKey", () => {
  it("uses a stable token for a missing start date", () => {
    assert.equal(ipoKey({ symbol: "X", issueStart: null }), "X|no-start");
  });
});

describe("IPO_KEYS", () => {
  it("lists every candidate the parser actually consults", () => {
    // Guards the falsification story: the report enumerates these, so a key
    // silently dropped from the parser would make the report a lie.
    assert.ok(IPO_KEYS.issueStart.includes("issueStartDate"));
    assert.ok(IPO_KEYS.symbol.includes("symbol"));
    assert.ok(IPO_KEYS.listingDate.includes("listingDate"));
  });
});

// ── Integrated filings ───────────────────────────────────────────────────

describe("integratedFilingPeriod", () => {
  it("keys on the IST broadcast DAY, not the UTC day", () => {
    // 17:30:20Z is 23:00:20 IST the same date — a UTC-day key would be right
    // here by luck; the next case is the one that separates them.
    assert.equal(
      integratedFilingPeriod(new Date("2026-08-07T17:30:20.000Z")),
      "IF-2026-08-07",
    );
    // 20:00Z on the 7th is 01:30 IST on the 8th.
    assert.equal(
      integratedFilingPeriod(new Date("2026-08-07T20:00:00.000Z")),
      "IF-2026-08-08",
    );
  });

  it("appends a sanitised discriminator", () => {
    assert.equal(
      integratedFilingPeriod(
        new Date("2026-08-07T17:30:20.000Z"),
        "Standalone/Q1 2026",
      ),
      // "StandaloneQ12026" truncated to 12 chars.
      "IF-2026-08-07-StandaloneQ1",
    );
  });

  it("is a stable sentinel with no broadcast date", () => {
    assert.equal(integratedFilingPeriod(null), "IF-unknown-date");
  });

  it("does NOT depend on 'now' — the same filing re-read keys identically", () => {
    // The overlapping daily window re-reads filings on purpose; a now-derived
    // key would create a second row for a filing we already have.
    const first = integratedFilingPeriod(
      new Date("2026-08-07T17:30:20.000Z"),
      "Standalone",
    );
    const second = integratedFilingPeriod(
      new Date("2026-08-07T17:30:20.000Z"),
      "Standalone",
    );
    assert.equal(first, second);
  });
});

describe("parseIntegratedFilings", () => {
  it("maps the CONFIRMED-key row from the P1 probe capture", () => {
    const out = parseIntegratedFilings({
      data: [CONFIRMED_INTEGRATED_FILING_ROW],
    });
    assert.equal(out.length, 1);
    const f = out[0];
    assert.ok(f);
    assert.equal(f.companyName, "Excelsoft Technologies Limited");
    assert.equal(f.audited, "Un-Audited");
    assert.equal(f.consolidated, "Standalone");
    assert.equal(f.broadcastAt?.toISOString(), "2026-08-07T17:30:20.000Z");
    // "0 Bytes" → 0, NOT null: the row HAS the field and it says there is no
    // file. Collapsing that to null would lose the distinction from "no such
    // field", which is the whole attachment question.
    assert.equal(f.attachmentSizeBytes, 0);
    assert.equal(f.attachmentUrl, null);
    assert.equal(f.period, "IF-2026-08-07-Standalone");
  });

  it("falls back to creation_Date when broadcast_Date is absent", () => {
    const out = parseIntegratedFilings([
      { symbol: "X", creation_Date: "07-Aug-2026 10:00:00" },
    ]);
    assert.equal(out[0]?.broadcastAt?.toISOString(), "2026-08-07T04:30:00.000Z");
  });

  it("resolves an attachment when a candidate key IS present", () => {
    const out = parseIntegratedFilings([
      {
        ...CONFIRMED_INTEGRATED_FILING_ROW,
        attFileName: "/corporates/filings/EXCELSOFT_Q1.pdf",
        attFileSize: "412 KB",
      },
    ]);
    assert.equal(
      out[0]?.attachmentUrl,
      "/corporates/filings/EXCELSOFT_Q1.pdf",
    );
    assert.equal(out[0]?.attachmentSizeBytes, 412);
  });

  it("is [] for an unusable payload", () => {
    assert.deepEqual(parseIntegratedFilings(null), []);
    assert.deepEqual(parseIntegratedFilings({ nope: 1 }), []);
  });
});

describe("dedupeIntegratedFilings", () => {
  it("drops symbol-less rows — they cannot resolve an instrument", () => {
    const out = dedupeIntegratedFilings(
      parseIntegratedFilings([{ cmName: "No Symbol Ltd" }]),
    );
    assert.equal(out.length, 0);
  });

  it("collapses duplicates on (symbol, period)", () => {
    const rows = parseIntegratedFilings([
      CONFIRMED_INTEGRATED_FILING_ROW,
      CONFIRMED_INTEGRATED_FILING_ROW,
    ]);
    assert.equal(rows.length, 2);
    assert.equal(dedupeIntegratedFilings(rows).length, 1);
  });

  it("keeps the standalone/consolidated pair filed on the same day", () => {
    const rows = parseIntegratedFilings([
      CONFIRMED_INTEGRATED_FILING_ROW,
      { ...CONFIRMED_INTEGRATED_FILING_ROW, consolidated: "Consolidated" },
    ]);
    assert.equal(dedupeIntegratedFilings(rows).length, 2);
  });
});

describe("renderIntegratedFilingText", () => {
  it("renders only the fields that resolved", () => {
    const filing = parseIntegratedFilings([CONFIRMED_INTEGRATED_FILING_ROW])[0];
    assert.ok(filing);
    const text = renderIntegratedFilingText(filing);
    assert.ok(text.startsWith("EXCELSOFT - Integrated Filing (NSE)"));
    assert.ok(text.includes("Basis: Standalone"));
    assert.ok(text.includes("Audit status: Un-Audited"));
    // Never the literal word "null" — that would be embedded as a fact.
    assert.ok(!text.includes("null"), text);
  });

  it("is a single line for an all-empty filing", () => {
    const filing = parseIntegratedFilings([{ symbol: "X" }])[0];
    assert.ok(filing);
    assert.equal(
      renderIntegratedFilingText(filing),
      "X - Integrated Filing (NSE)",
    );
  });
});

// ── Weekly sharding ──────────────────────────────────────────────────────

const UNIVERSE = Array.from({ length: 300 }, (_, i) => `SYM${i}`);

describe("symbolShard", () => {
  it("is in range and deterministic", () => {
    for (const s of UNIVERSE) {
      const shard = symbolShard(s);
      assert.ok(shard >= 0 && shard < WEEKLY_SHARD_COUNT, `${s} → ${shard}`);
      assert.equal(shard, symbolShard(s));
    }
  });

  it("spreads a realistic universe across the week", () => {
    const counts = new Array<number>(WEEKLY_SHARD_COUNT).fill(0);
    for (const s of UNIVERSE) counts[symbolShard(s)]! += 1;
    assert.equal(counts.filter((c) => c > 0).length, WEEKLY_SHARD_COUNT);
    // No day may carry more than half the universe — a hash that collapsed
    // would still "pass" a range check.
    assert.ok(Math.max(...counts) < UNIVERSE.length / 2);
  });

  it("normalises the symbol before hashing", () => {
    assert.equal(symbolShard("reliance.ns"), symbolShard("RELIANCE"));
  });

  it("honours a custom shard count", () => {
    assert.ok(symbolShard("RELIANCE", 3) < 3);
    assert.equal(symbolShard("RELIANCE", 0), 0); // degenerate input, total
  });
});

describe("selectWeeklyShard", () => {
  it("partitions the universe exactly once across the week", () => {
    const seen = new Set<string>();
    let total = 0;
    for (let i = 0; i < WEEKLY_SHARD_COUNT; i++) {
      const shard = selectWeeklyShard(UNIVERSE, i);
      total += shard.length;
      for (const s of shard) {
        assert.ok(!seen.has(s), `${s} appeared in two shards`);
        seen.add(s);
      }
    }
    assert.equal(total, UNIVERSE.length);
    assert.equal(seen.size, UNIVERSE.length);
  });

  it("PINS a symbol to its day as the universe grows", () => {
    // The whole point of hashing the symbol instead of its list position: one
    // new listing must not move every other symbol to a different weekday.
    const small = ["RELIANCE", "TCS", "INFY"];
    const large = [...UNIVERSE, ...small];
    const dayOf = (list: string[], sym: string): number => {
      for (let i = 0; i < WEEKLY_SHARD_COUNT; i++) {
        if (selectWeeklyShard(list, i).includes(sym)) return i;
      }
      return -1;
    };
    for (const sym of small) {
      assert.equal(dayOf(small, sym), dayOf(large, sym), sym);
    }
  });

  it("wraps a negative or oversized shard index", () => {
    assert.deepEqual(
      selectWeeklyShard(UNIVERSE, -1),
      selectWeeklyShard(UNIVERSE, WEEKLY_SHARD_COUNT - 1),
    );
    assert.deepEqual(
      selectWeeklyShard(UNIVERSE, WEEKLY_SHARD_COUNT + 2),
      selectWeeklyShard(UNIVERSE, 2),
    );
  });

  it("is [] for an empty universe", () => {
    assert.deepEqual(selectWeeklyShard([], 0), []);
  });
});

describe("weekShardIndex", () => {
  it("advances by one per day and wraps after a week", () => {
    const day0 = new Date("2026-08-07T04:00:00.000Z"); // 09:30 IST
    const day1 = new Date("2026-08-08T04:00:00.000Z");
    const day7 = new Date("2026-08-14T04:00:00.000Z");
    assert.equal(
      weekShardIndex(day1),
      (weekShardIndex(day0) + 1) % WEEKLY_SHARD_COUNT,
    );
    assert.equal(weekShardIndex(day7), weekShardIndex(day0));
  });

  it("uses the IST calendar day, not the UTC one", () => {
    // 19:00Z on the 7th is 00:30 IST on the 8th — same shard as 06:00Z on the
    // 8th, a DIFFERENT shard from 04:00Z on the 7th.
    const lateUtcSeventh = new Date("2026-08-07T19:00:00.000Z");
    const eighth = new Date("2026-08-08T06:00:00.000Z");
    const seventh = new Date("2026-08-07T04:00:00.000Z");
    assert.equal(weekShardIndex(lateUtcSeventh), weekShardIndex(eighth));
    assert.notEqual(weekShardIndex(lateUtcSeventh), weekShardIndex(seventh));
  });

  it("stays in range for a custom shard count", () => {
    assert.ok(weekShardIndex(new Date(), 3) < 3);
  });
});

describe("orderShardByStaleness", () => {
  it("puts never-fetched symbols first, then oldest-first", () => {
    const last = new Map<string, Date>([
      ["B", new Date("2026-08-01T00:00:00Z")],
      ["C", new Date("2026-07-01T00:00:00Z")],
    ]);
    assert.deepEqual(orderShardByStaleness(["A", "B", "C"], last), [
      "A",
      "C",
      "B",
    ]);
  });

  it("breaks ties on symbol so a re-run is not a reshuffle", () => {
    const at = new Date("2026-08-01T00:00:00Z");
    const last = new Map([
      ["B", at],
      ["A", at],
    ]);
    assert.deepEqual(orderShardByStaleness(["B", "A"], last), ["A", "B"]);
  });

  it("does not mutate its input", () => {
    const input = ["B", "A"];
    orderShardByStaleness(input, new Map());
    assert.deepEqual(input, ["B", "A"]);
  });

  it("MOVES the truncation point across runs", () => {
    // The property that makes a budget-truncated shard drain instead of
    // stalling: whatever went un-fetched last run sorts to the head next run.
    const shard = ["A", "B", "C", "D"];
    const run1 = orderShardByStaleness(shard, new Map());
    const processed = run1.slice(0, 2); // budget cut it here
    const after = new Map(
      processed.map((s) => [s, new Date("2026-08-10T00:00:00Z")] as const),
    );
    const run2 = orderShardByStaleness(shard, after);
    assert.deepEqual(run2.slice(0, 2), run1.slice(2));
  });
});

// ── Fetchers (injected fetchImpl — no network) ────────────────────────────

describe("extractCookies", () => {
  it("does not split on the comma inside an Expires date", () => {
    const cookies = extractCookies(
      "nsit=abc; Expires=Mon, 29 Mar 2027 10:00:00 GMT; Path=/, nseappid=xyz; Path=/",
    );
    assert.deepEqual(cookies, ["nsit=abc", "nseappid=xyz"]);
  });

  it("is [] for a header with no name=value pair", () => {
    assert.deepEqual(extractCookies("Path=/; HttpOnly"), ["Path=/"]);
    assert.deepEqual(extractCookies(""), []);
  });
});

describe("fetchAnnualReports", () => {
  it("performs the handshake, sends the cookie, and parses", async () => {
    const fake = fakeFetch(() =>
      response(JSON.stringify({ data: [SYNTHETIC_ANNUAL_ROW] })),
    );
    const out = await fetchAnnualReports("reliance.ns", {
      fetchImpl: fake.impl,
    });

    assert.equal(out.length, 1);
    assert.equal(out[0]?.period, "FY2024");
    // Handshake first, then the API call.
    assert.equal(fake.urls.length, 2);
    assert.equal(fake.urls[0], "https://www.nseindia.com");
    assert.equal(
      fake.urls[1],
      "https://www.nseindia.com/api/annual-reports?index=equities&symbol=RELIANCE",
    );
    assert.equal(fake.cookies[1], "nsit=abc123; nseappid=xyz789");
  });

  it("returns [] for an HTML challenge page served with HTTP 200", async () => {
    const fake = fakeFetch(() =>
      response("<html><body>Access Denied</body></html>"),
    );
    assert.deepEqual(
      await fetchAnnualReports("TCS", { fetchImpl: fake.impl }),
      [],
    );
  });

  it("returns [] on a non-2xx", async () => {
    const fake = fakeFetch(() => response("", { ok: false, status: 503 }));
    assert.deepEqual(
      await fetchAnnualReports("TCS", { fetchImpl: fake.impl }),
      [],
    );
  });

  it("returns [] on malformed JSON instead of throwing", async () => {
    const fake = fakeFetch(() => response("{not json"));
    assert.deepEqual(
      await fetchAnnualReports("TCS", { fetchImpl: fake.impl }),
      [],
    );
  });

  it("returns [] when the transport itself throws", async () => {
    const fake = fakeFetch(() => {
      throw new Error("ECONNRESET");
    });
    assert.deepEqual(
      await fetchAnnualReports("TCS", { fetchImpl: fake.impl }),
      [],
    );
  });

  it("skips the request entirely for an empty symbol", async () => {
    const fake = fakeFetch(() => response("[]"));
    assert.deepEqual(await fetchAnnualReports("", { fetchImpl: fake.impl }), []);
    assert.equal(fake.urls.length, 0);
  });

  it("uses a supplied cookie instead of handshaking", async () => {
    const fake = fakeFetch(() => response("[]"));
    await fetchAnnualReports("TCS", {
      fetchImpl: fake.impl,
      cookie: "preset=1",
    });
    assert.equal(fake.urls.length, 1);
    assert.equal(fake.cookies[0], "preset=1");
  });
});

describe("fetchUpcomingIpos", () => {
  it("pins category=ipo — the endpoint also serves rights/debt issues", async () => {
    const fake = fakeFetch(() =>
      response(JSON.stringify({ data: [SYNTHETIC_IPO_ROW] })),
    );
    const out = await fetchUpcomingIpos({ fetchImpl: fake.impl, now: NOW });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.source, "upcoming");
    assert.ok(fake.urls[1]?.endsWith("/api/all-upcoming-issues?category=ipo"));
  });
});

describe("fetchIntegratedFilings", () => {
  it("formats the window as DD-MM-YYYY in IST", async () => {
    const fake = fakeFetch(() =>
      response(JSON.stringify({ data: [CONFIRMED_INTEGRATED_FILING_ROW] })),
    );
    const out = await fetchIntegratedFilings(
      new Date("2026-08-05T20:00:00.000Z"), // 01:30 IST on the 6th
      new Date("2026-08-07T20:00:00.000Z"), // 01:30 IST on the 8th
      { fetchImpl: fake.impl },
    );
    assert.ok(out, "a successful fetch must not report failure");
    assert.equal(out.length, 1);
    assert.equal(
      fake.urls[1],
      "https://www.nseindia.com/api/integrated-filing-results?index=equities" +
        "&from_date=06-08-2026&to_date=08-08-2026",
    );
  });

  it("accepts pre-formatted date strings verbatim", async () => {
    const fake = fakeFetch(() => response("[]"));
    await fetchIntegratedFilings("01-08-2026", "07-08-2026", {
      fetchImpl: fake.impl,
    });
    assert.ok(fake.urls[1]?.includes("from_date=01-08-2026"));
    assert.ok(fake.urls[1]?.includes("to_date=07-08-2026"));
  });

  // MONEY-1189 — a FAILED fetch and an EMPTY window are different facts and
  // must be distinguishable by the caller. They both used to return `[]`, so
  // leg B reported an NSE timeout as "filings=0 … or the response shape
  // changed", sending the reader hunting for a parser bug that did not exist.
  it("returns NULL when the fetch fails, not an empty array", async () => {
    const fake = fakeFetch(() => response("", { ok: false, status: 500 }));
    const out = await fetchIntegratedFilings("01-08-2026", "07-08-2026", {
      fetchImpl: fake.impl,
    });
    assert.equal(out, null);
  });

  it("returns NULL for an HTML challenge page carrying HTTP 200", async () => {
    // The throttle signature: status alone never decides success here.
    const fake = fakeFetch(() => response("<html>Access Denied</html>"));
    const out = await fetchIntegratedFilings("01-08-2026", "07-08-2026", {
      fetchImpl: fake.impl,
    });
    assert.equal(out, null);
  });

  it("returns an EMPTY ARRAY when NSE genuinely answers with no rows", async () => {
    // The other side of the distinction — this one is real data, not a failure.
    const fake = fakeFetch(() => response(JSON.stringify({ data: [] })));
    const out = await fetchIntegratedFilings("01-08-2026", "07-08-2026", {
      fetchImpl: fake.impl,
    });
    assert.deepEqual(out, []);
  });
});

// ── Constants ────────────────────────────────────────────────────────────

describe("constants", () => {
  it("IST_OFFSET_MS is +05:30 exactly", () => {
    assert.equal(IST_OFFSET_MS, 19_800_000);
  });

  it("WEEKLY_SHARD_COUNT is a full week", () => {
    assert.equal(WEEKLY_SHARD_COUNT, 7);
  });
});

// ══════════════════════════════════════════════════════════════════════
// Live-payload regression (MONEY-1098 prod audit)
//
// The first prod ipo-sync run reported `upserted=11 skippedNoStartDate=1343`.
// Cause: /api/public-past-issues names its dates ipoStartDate / ipoEndDate,
// which IPO_KEYS did not list — so every past issue was dropped, and
// issueStart is half of UpcomingIpo's unique key so it cannot be defaulted.
// ══════════════════════════════════════════════════════════════════════

describe("IPO past-issues payload (real shape)", () => {
  // Verbatim row from /api/public-past-issues on 2026-08-11.
  const pastRow = {
    company: "Ardee Industries Limited",
    htmSym: "ardee",
    ipoEndDate: "07-AUG-2026",
    ipoStartDate: "05-AUG-2026",
    issuePrice: "-",
    linkRemovalDate: "08-AUG-2026",
    listingDate: "-",
    priceRange: "Rs.50 to Rs.53",
    securityType: "EQ",
    symbol: "ARDEE",
  };
  const NOW = new Date("2026-08-11T10:00:00Z");

  it("reads ipoStartDate / ipoEndDate", () => {
    const rows = parseIpoIssues([pastRow], "past", NOW);
    assert.equal(rows.length, 1);
    const r = rows[0]!;
    assert.equal(r.symbol, "ARDEE");
    assert.ok(r.issueStart, "issueStart must be set — it is half the upsert key");
    // NSE prints wall-clock IST with no zone, so 05-AUG-2026 IST midnight is
    // 2026-08-04T18:30Z. Asserted as an INSTANT, not a UTC date string — the
    // latter reads as "the 4th" and invites someone to `fix` the parser.
    assert.equal(r.issueStart!.toISOString(), "2026-08-04T18:30:00.000Z");
    assert.equal(r.issueEnd!.toISOString(), "2026-08-06T18:30:00.000Z");
  });

  it("treats NSE's '-' placeholder as absent, not as a date", () => {
    const r = parseIpoIssues([pastRow], "past", NOW)[0]!;
    assert.equal(r.listingDate, null);
  });

  it("keeps every spelling of one calendar day on the SAME instant", () => {
    // issueStart is half of @@unique([symbol, issueStart]); three spellings
    // resolving to three instants produced duplicate UpcomingIpo rows.
    const a = parseIpoIssues([{ ...pastRow, ipoStartDate: "05-AUG-2026" }], "past", NOW)[0]!;
    const b = parseIpoIssues([{ ...pastRow, ipoStartDate: "05-08-2026" }], "past", NOW)[0]!;
    const c = parseIpoIssues([{ ...pastRow, ipoStartDate: "2026-08-05" }], "past", NOW)[0]!;
    assert.equal(a.issueStart!.getTime(), b.issueStart!.getTime());
    assert.equal(b.issueStart!.getTime(), c.issueStart!.getTime());
  });
});
