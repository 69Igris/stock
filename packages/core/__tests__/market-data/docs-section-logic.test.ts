/**
 * Pure helpers for the stock page's DOCUMENT sections — MONEY-1204
 * (P14 / 14c.7 · 14c.8 · 14c.9).
 *
 * Behavioural, not structural. Every case below is a place where the obvious
 * implementation is quietly wrong and produces a plausible number rather than
 * an error:
 *
 *   - a non-READY document filtered out, so a stalled extractor reads as a
 *     quiet company;
 *   - a macro `upcoming_events` row (symbol NULL) pinned onto every stock;
 *   - the nine-month cumulative merged with the Q3 filing it shares a
 *     `periodEnd` with, or consolidated charted against standalone;
 *   - a fund present in only ONE of the two compared months counted as
 *     "unchanged" instead of entered/exited;
 *   - two compared months that are not consecutive labelled "month on month";
 *   - an undisclosed `percentToNav` summed as 0.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  availableFilingViews,
  buildFilingDrilldown,
  buildFilingsTimeline,
  buildFundsHoldingSection,
  classifyDocType,
  compareTimelineDocuments,
  dedupeUpcomingEvents,
  documentPeriodSortKey,
  indexedAtSortKey,
  isReadableDocument,
  parseDocumentPeriod,
  nextUpcomingEvent,
  normalizeBasis,
  normalizeProcessingStatus,
  selectFilings,
  summarizeFinancialsSource,
  toTimelineDocument,
  DEFAULT_FINANCIALS_BASIS,
  SPARSE_COVERAGE_THRESHOLD,
  STOCK_HOLDING_TYPES,
  type StockDocumentRow,
  type StockFundHoldingRow,
  type UpcomingEventRow,
  type XbrlFilingRow,
} from "../../src/market-data/docs-section-logic";

const at = (iso: string): Date => new Date(iso);
const day = (d: string): Date => new Date(`${d}T00:00:00.000Z`);

// ════════════════════════════════════════════════════════════════════
// 14c.7 — filings & documents timeline
// ════════════════════════════════════════════════════════════════════

describe("14c.7 classifyDocType", () => {
  it("maps the REAL writer vocabulary, not the schema comment's four values", () => {
    // The schema comment lists annual_report | quarterly_result |
    // financial_statement | corporate_filing. None of the announcement syncs
    // writes three of those, so a map built from the comment would bucket the
    // whole announcement feed as "other".
    assert.equal(classifyDocType("annual_report"), "annual_report");
    assert.equal(classifyDocType("integrated_filing"), "result");
    assert.equal(classifyDocType("financial_statement"), "result");
    assert.equal(classifyDocType("corporate_filing"), "announcement");
    assert.equal(classifyDocType("video_transcript"), "transcript");
    assert.equal(classifyDocType("concall_ppt"), "transcript");
    assert.equal(classifyDocType("investor_presentation"), "announcement");
  });

  it("is case- and whitespace-insensitive, and never throws on absence", () => {
    assert.equal(classifyDocType("  Annual_Report "), "annual_report");
    assert.equal(classifyDocType(null), "other");
    assert.equal(classifyDocType(undefined), "other");
    assert.equal(classifyDocType(""), "other");
  });

  it("buckets an UNKNOWN docType as `other` rather than dropping it", () => {
    // A new upstream docType must show up as a count, not vanish.
    assert.equal(classifyDocType("sebi_scores_complaint"), "other");
  });

  it("keeps machine-readable snapshots out of the human filing buckets", () => {
    // screener_financials is a JSON blob archived for RAG, not a document a
    // reader opens — putting it under "Results" mixes the two.
    assert.equal(classifyDocType("screener_financials"), "other");
    assert.equal(classifyDocType("corporate_actions"), "other");
  });
});

describe("14c.7 processing status", () => {
  it("READY is the ONLY readable state", () => {
    assert.equal(isReadableDocument("READY"), true);
    for (const s of [
      "PENDING",
      "PROCESSING",
      "FAILED",
      "UNSUPPORTED",
      "",
      null,
      "ready?",
    ]) {
      assert.equal(isReadableDocument(s), false, String(s));
    }
  });

  it("an unrecognised status becomes UNKNOWN, never READY", () => {
    assert.equal(normalizeProcessingStatus("DONE"), "UNKNOWN");
    assert.equal(normalizeProcessingStatus(null), "UNKNOWN");
    assert.equal(normalizeProcessingStatus(" ready "), "READY");
  });

  // ── MONEY-1255 ────────────────────────────────────────────────────
  //
  // 1,210 rows sat PENDING while being an HTML error page, an MP3 or a ZIP.
  // PENDING means "queued for extraction" and no extractor in this repo will
  // ever read one, so it was a claim about a future that could not arrive —
  // and it made the real PDF backlog unreadable.

  it("UNSUPPORTED is a recognised terminal status, not UNKNOWN", () => {
    assert.equal(normalizeProcessingStatus("UNSUPPORTED"), "UNSUPPORTED");
    assert.equal(normalizeProcessingStatus("unsupported"), "UNSUPPORTED");
    assert.equal(normalizeProcessingStatus(" Unsupported "), "UNSUPPORTED");
  });

  it("UNSUPPORTED renders its own label, not 'Unknown state'", () => {
    // The whole point of a new status is that a reader can tell the difference
    // between "we could not read this" and "we have not tried yet". Falling
    // through to UNKNOWN would trade one invisible pile for another.
    const doc = toTimelineDocument({
      id: "1",
      docType: "annual_report",
      processingStatus: "UNSUPPORTED",
    });
    assert.equal(doc.status, "UNSUPPORTED");
    assert.equal(doc.statusLabel, "No text to extract");
    assert.notEqual(doc.statusLabel, "Unknown state");
    assert.equal(doc.readable, false);
  });

  it("UNSUPPORTED is distinct from FAILED", () => {
    // FAILED means "we tried and it did not work" and `force:true` re-runs it.
    // Folding the two together would put 1,210 guaranteed no-ops into every
    // forced extraction pass.
    assert.notEqual(
      normalizeProcessingStatus("UNSUPPORTED"),
      normalizeProcessingStatus("FAILED"),
    );
  });
});

describe("14c.7 toTimelineDocument", () => {
  it("reports the DEFAULT fileSize of 0 as absent, not as '0 bytes'", () => {
    const d = toTimelineDocument({
      id: "d1",
      docType: "annual_report",
      fileSize: 0,
    });
    assert.equal(d.fileSizeBytes, null);
    assert.equal(
      toTimelineDocument({ id: "d2", docType: "x", fileSize: 42 })
        .fileSizeBytes,
      42,
    );
  });

  it("falls back through title → period → category label, never to blank", () => {
    assert.equal(
      toTimelineDocument({ id: "d", docType: "annual_report", period: "2024" })
        .title,
      "2024",
    );
    assert.equal(
      toTimelineDocument({ id: "d", docType: "annual_report" }).title,
      "Annual reports",
    );
  });

  it("names the date `indexedAt` and sources it from fetchedAt", () => {
    // There is no filing-date column on this model; calling ingest time a
    // filing date would sort a backfilled 2019 report to the top today.
    const d = toTimelineDocument({
      id: "d",
      docType: "annual_report",
      fetchedAt: at("2026-08-14T10:00:00.000Z"),
    });
    assert.equal(d.indexedAt, "2026-08-14T10:00:00.000Z");
  });
});

// ════════════════════════════════════════════════════════════════════
// 14c.7 — `period` → sortable key (MONEY-1255)
// ════════════════════════════════════════════════════════════════════
//
// Every literal below is a shape MEASURED in `stock_documents` on prod
// 2026-08-26 (43,031 rows, 30 distinct shapes) — not an invented vocabulary.
// The garbage cases are the load-bearing half: they are what stops the parser
// from filing an unknown date at the TOP of the timeline.

describe("14c.7 parseDocumentPeriod", () => {
  it("reads the four shapes that name a point in time", () => {
    assert.deepEqual(parseDocumentPeriod("FY2025"), {
      key: "20250000",
      year: 2025,
      month: 0,
      day: 0,
      kind: "year",
    });
    assert.deepEqual(parseDocumentPeriod("Q3-2024"), {
      key: "20240900",
      year: 2024,
      month: 9,
      day: 0,
      kind: "quarter",
    });
    assert.deepEqual(parseDocumentPeriod("Feb 2026"), {
      key: "20260200",
      year: 2026,
      month: 2,
      day: 0,
      kind: "month",
    });
    assert.deepEqual(parseDocumentPeriod("IF-2026-08-20"), {
      key: "20260820",
      year: 2026,
      month: 8,
      day: 20,
      kind: "date",
    });
  });

  it("orders quarters against each other WITHIN their label year", () => {
    const q = ["Q1-2024", "Q2-2024", "Q3-2024", "Q4-2024"].map((p) =>
      documentPeriodSortKey(p),
    );
    assert.deepEqual(q, ["20240300", "20240600", "20240900", "20241200"]);
    // Strictly increasing, so Q4-2024 renders above Q3-2024 and neither
    // escapes 2024 into a neighbouring year.
    for (let i = 1; i < q.length; i++) {
      assert.ok(q[i]! > q[i - 1]!, `${q[i]} should follow ${q[i - 1]}`);
    }
  });

  it("pads a YEAR-only label to the START of its year, never the end", () => {
    // `FY2025` names a whole span. Padding it to 202512xx would rank it above
    // every dated document from inside 2025 — coarse precision winning a tie it
    // has no information to win.
    assert.ok(
      documentPeriodSortKey("FY2025")! < documentPeriodSortKey("Jan 2025")!,
    );
    assert.ok(
      documentPeriodSortKey("2024")! < documentPeriodSortKey("Q1-2024")!,
    );
    // And it still sits above the whole previous year.
    assert.ok(
      documentPeriodSortKey("FY2025")! > documentPeriodSortKey("Dec 2024")!,
    );
  });

  it("accepts the prefixed year forms the writers actually mint", () => {
    assert.equal(documentPeriodSortKey("screener-2026"), "20260000");
    assert.equal(documentPeriodSortKey("annual-2026"), "20260000");
    assert.equal(documentPeriodSortKey("2024"), "20240000");
    assert.equal(documentPeriodSortKey("MAR 2012"), "20120300");
    assert.equal(documentPeriodSortKey("JUN 2026"), "20260600");
    assert.equal(documentPeriodSortKey("2026-08-20"), "20260820");
    assert.equal(documentPeriodSortKey("IF-2026-08-20-Standalone"), "20260820");
    assert.equal(documentPeriodSortKey("Q1-2026"), "20260300");
  });

  it("returns NULL for every period that names no date", () => {
    // `[1]` is a genuinely mis-parsed Screener table cell (317 rows on prod);
    // `nse-{seq_id}` is an announcement id (2,344); `IPO` (593) and
    // `unknown-date` (extractPeriod's Invalid-Date sentinel) are labels, not
    // dates. Null is the honest answer and it means "sort last".
    for (const p of [
      "[1]",
      "[4]",
      "IPO",
      "unknown-date",
      "",
      "   ",
      null,
      undefined,
    ]) {
      assert.equal(parseDocumentPeriod(p), null, JSON.stringify(p));
    }
  });

  it("never reads a YEAR out of the middle of an announcement id", () => {
    // The whole failure mode in one case: `nse-106748636` contains the digits
    // `1067`, and a `\d{4}` without digit-lookarounds files a 2026 announcement
    // under the year 1067 — or, with a different seq id, under a plausible one,
    // where nothing would ever notice.
    assert.equal(parseDocumentPeriod("nse-106748636"), null);
    assert.equal(parseDocumentPeriod("nse-2026748636"), null);
    assert.equal(parseDocumentPeriod("bse-1234"), null);
  });

  it("rejects a 4-digit run that is not a plausible YEAR", () => {
    // These ten are REAL prod rows: a month name followed by a mangled time or
    // sequence. Taken at face value, `AUG 9284` pins itself to the top of that
    // company's timeline forever.
    for (const p of [
      "dec 1087",
      "dec 4310",
      "FEB 1748",
      "FEB 1048",
      "jan 0807",
      "jan 2107",
      "AUG 9284",
      "AUG 0809",
      "feb 9031",
      "DEC 5120",
    ]) {
      assert.equal(parseDocumentPeriod(p), null, p);
    }
    // The band is a plausibility filter, not a prediction — real years pass.
    assert.equal(parseDocumentPeriod("FY2010")?.year, 2010);
    assert.equal(parseDocumentPeriod("Dec 1999")?.year, 1999);
  });

  it("DEGRADES an out-of-range month or day to the year, never inventing one", () => {
    // A 13th month is not a month, so the date branch declines it — but the
    // YEAR in the same string is still real and still orders the row. Losing
    // precision is the right failure; discarding a row we can partly read, or
    // clamping 13 to December, are both worse.
    for (const p of ["IF-2026-13-20", "IF-2026-08-45", "IF-2026-00-00"]) {
      assert.deepEqual(
        parseDocumentPeriod(p),
        { key: "20260000", year: 2026, month: 0, day: 0, kind: "year" },
        p,
      );
    }
    // The well-formed neighbour still resolves all the way to the day, so the
    // case above is a real branch and not the parser giving up everywhere.
    assert.equal(parseDocumentPeriod("IF-2026-12-31")?.kind, "date");
  });
});

// The seventeen documents `stock_documents` actually holds for GOODYEAR,
// verbatim (ids, periods and `fetchedAt` as read from prod 2026-08-26). This is
// the reported bug: every row was scraped on one of two days in April 2026, so
// an `indexedAt`-first comparator has nothing to order by and collapses to
// Mongo `_id` — which rendered FY2011, FY2013, FY2010, FY2012, FY2014, …
const GOODYEAR: StockDocumentRow[] = [
  ["69ea0aec66274d247ffc23f7", "FY2011", "2026-04-23T12:05:00.255Z"],
  ["69ea0aea063fcb054c5cd677", "FY2013", "2026-04-23T12:04:58.357Z"],
  ["69e51213b12acb1ed7734202", "FY2010", "2026-04-19T17:34:11.941Z"],
  ["69e51213b12acb1ed7734201", "FY2012", "2026-04-19T17:34:11.246Z"],
  ["69e51210b12acb1ed7734200", "FY2014", "2026-04-19T17:34:08.220Z"],
  ["69e5120fb12acb1ed77341ff", "FY2016", "2026-04-19T17:34:07.471Z"],
  ["69e5120cb12acb1ed77341fe", "FY2018", "2026-04-19T17:34:04.493Z"],
  ["69e5120cb12acb1ed77341fd", "FY2017", "2026-04-19T17:34:04.193Z"],
  ["69e51208b12acb1ed77341fc", "FY2019", "2026-04-19T17:34:00.349Z"],
  ["69e51205b12acb1ed77341fb", "FY2020", "2026-04-19T17:33:57.219Z"],
  ["69e51201b12acb1ed77341fa", "FY2021", "2026-04-19T17:33:53.390Z"],
  ["69e511fdb12acb1ed77341f9", "FY2022", "2026-04-19T17:33:50.162Z"],
  ["69e511fab12acb1ed77341f8", "FY2023", "2026-04-19T17:33:46.384Z"],
  ["69e511f6b12acb1ed77341f7", "FY2024", "2026-04-19T17:33:42.946Z"],
  ["69e511f3b12acb1ed77341f6", "FY2025", "2026-04-19T17:33:39.577Z"],
  ["69e511f0b12acb1ed77341f5", "[1]", "2026-04-19T17:33:36.157Z"],
  ["69e511efb12acb1ed77341f4", "screener-2026", "2026-04-19T17:33:35.285Z"],
].map(([id, period, fetchedAt]) => ({
  id: id!,
  docType: period === "screener-2026" ? "screener_financials" : "annual_report",
  period: period!,
  title: `GOODYEAR ${period}`,
  processingStatus: period === "screener-2026" ? "READY" : "PENDING",
  sourceType: "SCREENER",
  fetchedAt: at(fetchedAt!),
}));

describe("14c.7 compareTimelineDocuments — the GOODYEAR regression", () => {
  const t = buildFilingsTimeline({ docs: GOODYEAR, symbol: "GOODYEAR" });

  it("renders the fiscal years in strict DESCENDING order", () => {
    assert.deepEqual(
      t.items.map((d) => d.period),
      [
        // `[1]` has no readable period, so it falls back to its INGEST day
        // (2026-04-19) — which outranks `screener-2026`'s 20260000. This is the
        // accepted cost of the fallback, and the fifteen FY rows below it are
        // untouched by it: that is the whole point of falling back only where
        // the period names no date.
        "[1]",
        "screener-2026",
        "FY2025",
        "FY2024",
        "FY2023",
        "FY2022",
        "FY2021",
        "FY2020",
        "FY2019",
        "FY2018",
        "FY2017",
        "FY2016",
        "FY2014",
        "FY2013",
        "FY2012",
        "FY2011",
        "FY2010",
      ],
    );
  });

  it("dates the unparseable `[1]` row by INGEST rather than discarding it", () => {
    // The row is a real annual report whose period cell was mis-scraped into a
    // page anchor. We do not know WHICH year it is — but we do know when we
    // pulled it, and a weaker date beats no date. It sorts on 2026-04-19.
    assert.equal(t.items[0]?.period, "[1]");
    assert.equal(t.items.length, 17);
    // The fifteen rows that DO carry a readable period never touch the
    // fallback, which is what keeps the fix from regressing into the old bug.
    assert.deepEqual(
      t.items.filter((d) => d.period?.startsWith("FY")).map((d) => d.period),
      [
        "FY2025",
        "FY2024",
        "FY2023",
        "FY2022",
        "FY2021",
        "FY2020",
        "FY2019",
        "FY2018",
        "FY2017",
        "FY2016",
        "FY2014",
        "FY2013",
        "FY2012",
        "FY2011",
        "FY2010",
      ],
    );
  });

  it("ignores ingest time entirely while the periods differ", () => {
    // FY2011 and FY2013 carry the two NEWEST scrape timestamps in the set
    // (23 Apr, vs 19 Apr for the other fifteen). Under the old comparator they
    // led the list. Under this one they are 15th and 13th, by period alone.
    const ids = t.items.map((d) => d.id);
    assert.ok(
      ids.indexOf("69ea0aec66274d247ffc23f7") >
        ids.indexOf("69e511f3b12acb1ed77341f6"),
      "FY2011 (newest scrape) must rank BELOW FY2025 (oldest scrape)",
    );
  });
});

describe("14c.7 compareTimelineDocuments — the tiebreak ladder", () => {
  const doc = (
    id: string,
    period: string | null,
    indexedAt: string | null,
  ): StockDocumentRow => ({
    id,
    docType: "annual_report",
    period,
    fetchedAt: indexedAt === null ? null : at(indexedAt),
  });

  const order = (rows: StockDocumentRow[]): string[] =>
    buildFilingsTimeline({ docs: rows, symbol: "X" }).items.map((d) => d.id);

  it("breaks a period tie on indexedAt DESC", () => {
    assert.deepEqual(
      order([
        doc("older", "Q1-2026", "2026-08-01T00:00:00.000Z"),
        doc("newer", "Q1-2026", "2026-08-09T00:00:00.000Z"),
      ]),
      ["newer", "older"],
    );
  });

  it("breaks a FULL tie on id, so the order is TOTAL and repeatable", () => {
    // Without the final `id` arm the comparator returns 0 for two
    // indistinguishable rows and the list can reshuffle between identical
    // requests. Asserted from BOTH input orders — a comparator that merely
    // preserved input order would pass one and fail the other.
    const rows = [
      doc("zzz", "FY2025", "2026-08-01T00:00:00.000Z"),
      doc("aaa", "FY2025", "2026-08-01T00:00:00.000Z"),
    ];
    assert.deepEqual(order(rows), ["aaa", "zzz"]);
    assert.deepEqual(order([...rows].reverse()), ["aaa", "zzz"]);
  });

  it("dates an announcement by INGEST and lets it outrank an old filing", () => {
    // The regression the sink-to-the-bottom rule would have caused. An
    // `nse-{seq_id}` row is not undated junk: prod holds 2,344 of them, EVERY
    // one ingested inside the last fourteen days, and they are the earnings-call
    // intimations and concall transcripts a reader came for. Burying them under
    // a FY2010 annual report is worse than the mis-ordering this fix targets.
    assert.deepEqual(
      order([
        doc("ann-old", "nse-100", "2026-08-01T00:00:00.000Z"),
        doc("dated", "FY2010", "2020-01-01T00:00:00.000Z"),
        doc("ann-new", "nse-200", "2026-08-09T00:00:00.000Z"),
      ]),
      ["ann-new", "ann-old", "dated"],
    );
  });

  it("brackets a real nse-{seq} announcement between older and newer filings", () => {
    // The shape as it exists on prod: period `nse-{seq_id}`, ingested
    // 2026-08-25. It must clear an old annual report and still yield to a
    // filing whose own period is genuinely later.
    assert.deepEqual(
      order([
        doc("fy2010", "FY2010", "2026-04-19T00:00:00.000Z"),
        doc("ann", "nse-106748636", "2026-08-25T09:00:00.000Z"),
        doc("sep2026", "Sep 2026", "2026-08-20T00:00:00.000Z"),
      ]),
      ["sep2026", "ann", "fy2010"],
    );
    // And the sub-case worth pinning explicitly, because it looks wrong and is
    // not: an `FY2026` annual report sorts BELOW that announcement. A year-only
    // label pads to the START of its year (20260000), and an Indian FY2026 ends
    // in March 2026 — so a 25-Aug-2026 announcement really is the later
    // document. Ingest day did not "beat" a period here; it dated a row the
    // period could not.
    assert.deepEqual(
      order([
        doc("fy2026", "FY2026", "2026-04-19T00:00:00.000Z"),
        doc("ann", "nse-106748636", "2026-08-25T09:00:00.000Z"),
      ]),
      ["ann", "fy2026"],
    );
  });

  it("sorts LAST only when BOTH keys are absent", () => {
    // `nothing` has no period and no ingest time — there is genuinely no date
    // to place it by, so it goes last. `undated-but-scraped` has one of the two
    // and is placed by it. That distinction is the entire contract: last is
    // reserved for no information, not for weak information.
    assert.deepEqual(
      order([
        doc("nothing", null, null),
        doc("undated-but-scraped", "IPO", "2026-08-01T00:00:00.000Z"),
        doc("dated", "2011", "2019-01-01T00:00:00.000Z"),
      ]),
      ["undated-but-scraped", "dated", "nothing"],
    );
  });

  it("compares an ingest fallback on DAY granularity, not on the instant", () => {
    // A period key can never be finer than a day, so if the fallback carried
    // the clock time an undated row would beat a same-day dated row on scrape
    // order alone — a small re-run of the original bug. Same day ⇒ the primary
    // keys tie, and the full-precision instant then breaks it.
    assert.equal(indexedAtSortKey("2026-08-25T09:00:00.000Z"), "20260825");
    assert.equal(indexedAtSortKey(null), null);
    assert.equal(indexedAtSortKey(""), null);
    assert.equal(indexedAtSortKey("not-a-date"), null);
    assert.deepEqual(
      order([
        doc("undated-later-that-day", "IPO", "2026-08-25T23:00:00.000Z"),
        doc("dated-same-day", "2026-08-25", "2026-08-25T01:00:00.000Z"),
      ]),
      ["undated-later-that-day", "dated-same-day"],
    );
    // ...and the tie really is a tie on the primary key, broken by the instant:
    // reversing the instants reverses the pair.
    assert.deepEqual(
      order([
        doc("undated-earlier", "IPO", "2026-08-25T01:00:00.000Z"),
        doc("dated-same-day", "2026-08-25", "2026-08-25T23:00:00.000Z"),
      ]),
      ["dated-same-day", "undated-earlier"],
    );
  });

  it("is usable directly as an Array#sort comparator", () => {
    // The exported function IS the one buildFilingsTimeline uses — not a second
    // copy of the rule that can drift away from it.
    const items = buildFilingsTimeline({
      docs: [doc("a", "FY2020", null), doc("b", "FY2024", null)],
      symbol: "X",
    }).items;
    assert.deepEqual([...items].sort(compareTimelineDocuments), items);
    assert.equal(compareTimelineDocuments(items[0]!, items[1]!) < 0, true);
    assert.equal(compareTimelineDocuments(items[1]!, items[0]!) > 0, true);
    assert.equal(compareTimelineDocuments(items[0]!, items[0]!), 0);
  });
});

const DOCS: StockDocumentRow[] = [
  {
    id: "a",
    docType: "annual_report",
    period: "2025",
    title: "Annual Report FY25",
    processingStatus: "READY",
    sourceType: "NSE",
    fetchedAt: at("2026-08-10T10:00:00.000Z"),
  },
  {
    id: "b",
    docType: "corporate_filing",
    period: "bse-1234",
    title: "Board meeting outcome",
    processingStatus: "PENDING",
    sourceType: "BSE",
    fetchedAt: at("2026-08-14T10:00:00.000Z"),
  },
  {
    id: "c",
    docType: "concall_transcript",
    period: "Q1-2026",
    title: "Q1 earnings call",
    processingStatus: "FAILED",
    sourceType: "NSE",
    fetchedAt: at("2026-08-12T10:00:00.000Z"),
  },
  {
    id: "d",
    docType: "financial_statement",
    period: "Q1-2026",
    title: "Q1 results",
    processingStatus: "READY",
    sourceType: "NSE",
    fetchedAt: at("2026-08-13T10:00:00.000Z"),
  },
  {
    id: "e",
    docType: "sebi_scores_complaint",
    period: "2026",
    title: "Something new upstream",
    processingStatus: "READY",
    sourceType: "NSE",
    fetchedAt: null,
  },
];

describe("14c.7 buildFilingsTimeline — docType grouping with a non-READY doc", () => {
  const t = buildFilingsTimeline({ docs: DOCS, symbol: "RELIANCE" });

  it("counts every category INCLUDING `other`", () => {
    assert.deepEqual(t.counts, {
      result: 1,
      annual_report: 1,
      transcript: 1,
      announcement: 1,
      other: 1,
    });
  });

  it("KEEPS documents whose extraction is PENDING or FAILED", () => {
    // The regression this exists for: filtering on processingStatus hides real
    // published filings behind an internal job's state.
    const ids = t.items.map((d) => d.id).sort();
    assert.deepEqual(ids, ["a", "b", "c", "d", "e"]);
    assert.equal(t.notReadyCount, 2);
  });

  it("gates only the `readable` affordance on READY", () => {
    const byId = new Map(t.items.map((d) => [d.id, d]));
    assert.equal(byId.get("b")?.readable, false);
    assert.equal(byId.get("b")?.status, "PENDING");
    assert.equal(byId.get("c")?.readable, false);
    assert.equal(byId.get("c")?.status, "FAILED");
    assert.equal(byId.get("a")?.readable, true);
  });

  it("orders by the best date each row has, newest first", () => {
    // MONEY-1255, all three rules in one fixture.
    //
    // `b`'s period is `bse-1234` — an announcement id, not a year — so it falls
    // back to its ingest day (2026-08-14) and leads. It is NOT sunk to the
    // bottom: a weaker date is still a date.
    //
    // `e` is the rule read from the other side: it has NO ingest time at all,
    // and still outranks `a` because its period (2026) beats `a`'s (2025). A
    // real period never defers to a scrape clock.
    //
    // `d` before `c` is the tiebreak: identical `Q1-2026`, later scrape wins.
    assert.deepEqual(
      t.items.map((d) => d.id),
      ["b", "d", "c", "e", "a"],
    );
    // `latestIndexedAt` still reports INGEST — it drives the "as of" chip, and
    // that chip is honestly about our pipeline. Only the ORDER moved.
    assert.equal(t.latestIndexedAt, "2026-08-14T10:00:00.000Z");
  });

  it("a category filter COUNTS what it hid instead of silently shrinking", () => {
    const only = buildFilingsTimeline({
      docs: DOCS,
      symbol: "RELIANCE",
      categories: ["result"],
    });
    assert.deepEqual(
      only.items.map((d) => d.id),
      ["d"],
    );
    assert.equal(only.filteredOut, 4);
    // Counts stay pre-filter, so the chips can show what filtering would reveal.
    assert.equal(only.counts.transcript, 1);
  });

  it("an empty docs set is a real, non-throwing empty rather than a crash", () => {
    const empty = buildFilingsTimeline({ docs: [], symbol: "RELIANCE" });
    assert.deepEqual(empty.items, []);
    assert.equal(empty.latestIndexedAt, null);
    assert.equal(empty.notReadyCount, 0);
    assert.equal(empty.pinned, null);
  });
});

describe("14c.7 upcoming event pin", () => {
  const NOW = at("2026-08-15T06:30:00.000Z");
  const EVENTS: UpcomingEventRow[] = [
    {
      id: "macro",
      date: day("2026-08-18"),
      symbol: null,
      title: "RBI monetary policy",
      category: "macro",
      source: "NSE",
    },
    {
      id: "past",
      date: day("2026-08-01"),
      symbol: "RELIANCE",
      title: "Q1 board meeting",
      category: "earnings",
      source: "NSE",
    },
    {
      id: "yahoo",
      date: day("2026-08-20"),
      symbol: "RELIANCE",
      title: "Earnings   Date",
      category: "earnings",
      source: "YAHOO",
    },
    {
      id: "nse",
      date: day("2026-08-20"),
      symbol: "RELIANCE",
      title: "earnings date",
      category: "Earnings",
      source: "NSE",
    },
    {
      id: "later",
      date: day("2026-09-01"),
      symbol: "RELIANCE",
      title: "Dividend record date",
      category: "dividend",
      source: "NSE",
    },
  ];

  it("NEVER pins a macro row (symbol NULL) onto a stock", () => {
    // The bug this guards: a null-tolerant symbol filter puts one RBI policy
    // date on every stock page on the platform.
    const pinned = nextUpcomingEvent(EVENTS, { symbol: "RELIANCE", now: NOW });
    assert.ok(pinned);
    assert.notEqual(pinned.title, "RBI monetary policy");
  });

  it("picks the SOONEST future event and ignores past ones", () => {
    const pinned = nextUpcomingEvent(EVENTS, { symbol: "RELIANCE", now: NOW });
    assert.equal(pinned?.date.slice(0, 10), "2026-08-20");
    assert.equal(pinned?.daysAway, 5);
  });

  it("dedupes the NSE/YAHOO double-write, NSE winning deterministically", () => {
    // `upcoming_events` has NO unique constraint and two feeds populate it.
    const deduped = dedupeUpcomingEvents(EVENTS);
    const aug20 = deduped.filter(
      (e) => new Date(e.date).toISOString().slice(0, 10) === "2026-08-20",
    );
    assert.equal(aug20.length, 1);
    assert.equal(aug20[0]?.source, "NSE");
    // …and stable when the input order is reversed.
    const reversed = dedupeUpcomingEvents([...EVENTS].reverse());
    assert.equal(
      reversed.filter(
        (e) => new Date(e.date).toISOString().slice(0, 10) === "2026-08-20",
      )[0]?.source,
      "NSE",
    );
  });

  it("counts an event dated TODAY as upcoming, with daysAway 0", () => {
    const pinned = nextUpcomingEvent(
      [
        {
          date: day("2026-08-15"),
          symbol: "RELIANCE",
          title: "Results",
          category: "earnings",
        },
      ],
      { symbol: "RELIANCE", now: NOW },
    );
    assert.equal(pinned?.daysAway, 0);
  });

  it("matches the symbol case-insensitively and returns null for a miss", () => {
    assert.ok(nextUpcomingEvent(EVENTS, { symbol: "reliance", now: NOW }));
    assert.equal(nextUpcomingEvent(EVENTS, { symbol: "TCS", now: NOW }), null);
    assert.equal(nextUpcomingEvent(EVENTS, { symbol: "", now: NOW }), null);
  });

  it("pins through buildFilingsTimeline even when there are no documents", () => {
    // A pinned event with zero documents is NOT an empty section.
    const t = buildFilingsTimeline({
      docs: [],
      events: EVENTS,
      symbol: "RELIANCE",
      now: NOW,
    });
    assert.equal(t.items.length, 0);
    assert.ok(t.pinned);
  });
});

// ════════════════════════════════════════════════════════════════════
// 14c.8 — financials source badge + basis / cumulative toggle
// ════════════════════════════════════════════════════════════════════

describe("14c.8 summarizeFinancialsSource", () => {
  it("reports what `source` SAYS — today that is TICKERTAPE everywhere", () => {
    // The XBRL switchover is not armed, so every row reads TICKERTAPE. The
    // badge must read it rather than assert it: a hardcoded value is a badge
    // that lies the day the switchover lands.
    const s = summarizeFinancialsSource([
      {
        period: "Q1-2026",
        source: "TICKERTAPE",
        fetchedAt: at("2026-08-01T00:00:00.000Z"),
      },
      {
        period: "Q4-2025",
        source: "TICKERTAPE",
        fetchedAt: at("2026-07-01T00:00:00.000Z"),
      },
    ]);
    assert.equal(s.primary, "TICKERTAPE");
    assert.equal(s.mixed, false);
    assert.equal(s.asOf, "2026-08-01T00:00:00.000Z");
  });

  it("flags a MIXED table and ranks the majority source first", () => {
    const s = summarizeFinancialsSource([
      { source: "NSE_XBRL" },
      { source: "NSE_XBRL" },
      { source: "NSE_XBRL" },
      { source: "TICKERTAPE" },
    ]);
    assert.equal(s.primary, "NSE_XBRL");
    assert.equal(s.mixed, true);
    assert.deepEqual(
      s.breakdown.map((b) => [b.source, b.rows]),
      [
        ["NSE_XBRL", 3],
        ["TICKERTAPE", 1],
      ],
    );
  });

  it("breaks a row-count TIE by FINANCIALS_AUTHORITY, not by input order", () => {
    const s = summarizeFinancialsSource([
      { source: "TICKERTAPE" },
      { source: "NSE_XBRL" },
      { source: "TICKERTAPE" },
      { source: "NSE_XBRL" },
    ]);
    assert.equal(s.primary, "NSE_XBRL");
  });

  it("ranks an UNKNOWN source last but still reports it", () => {
    const s = summarizeFinancialsSource([
      { source: "SOME_NEW_FEED" },
      { source: "SOME_NEW_FEED" },
      { source: "YAHOO" },
    ]);
    assert.equal(s.primary, "SOME_NEW_FEED");
    const unknown = s.breakdown.find((b) => b.source === "SOME_NEW_FEED");
    const yahoo = s.breakdown.find((b) => b.source === "YAHOO");
    assert.ok(unknown && yahoo && unknown.rank > yahoo.rank);
  });

  it("surfaces the displacement record — the ONLY trace of an erased source", () => {
    // `source` is not in the @@unique, so a second source for one period
    // ERASES rather than duplicates.
    const s = summarizeFinancialsSource([
      {
        period: "Q3-2026",
        source: "NSE_XBRL",
        rawData: {
          displacedByXbrl: {
            displacedSource: "TICKERTAPE",
            by: "NSE_XBRL",
            displacedAt: "2026-08-10T00:00:00.000Z",
            values: {},
            fetchedAt: null,
            rawData: null,
          },
        },
      },
      { period: "Q2-2026", source: "TICKERTAPE", rawData: { anything: 1 } },
      { period: "Q1-2026", source: "TICKERTAPE", rawData: null },
    ]);
    assert.equal(s.displacements.length, 1);
    assert.equal(s.displacements[0]?.displacedSource, "TICKERTAPE");
    assert.equal(s.displacements[0]?.period, "Q3-2026");
  });

  it("no rows ⇒ a null source, never a fabricated default", () => {
    const s = summarizeFinancialsSource([]);
    assert.equal(s.primary, null);
    assert.equal(s.asOf, null);
    assert.equal(s.mixed, false);
    assert.deepEqual(s.displacements, []);
  });

  it("treats a blank source string as absent", () => {
    assert.equal(summarizeFinancialsSource([{ source: "   " }]).primary, null);
  });
});

// A quarter, the nine-month CUMULATIVE that shares its periodEnd, and the
// STANDALONE twin of the quarter. Three different facts, one periodEnd.
const Q3_END = day("2025-12-31");
const FILINGS: XbrlFilingRow[] = [
  {
    id: "cons-q3",
    periodStart: day("2025-10-01"),
    periodEnd: Q3_END,
    periodType: "QUARTERLY",
    basis: "CONSOLIDATED",
    cumulative: false,
    audited: false,
    coverage: 0.82,
    conceptsFound: ["Revenue", "NetIncome"],
    sourceUrl: "https://nse/cons-q3.xml",
    filedAt: at("2026-01-20T00:00:00.000Z"),
  },
  {
    id: "cons-9m",
    periodStart: day("2025-04-01"),
    periodEnd: Q3_END,
    periodType: "QUARTERLY",
    basis: "CONSOLIDATED",
    cumulative: true,
    audited: false,
    coverage: 0.8,
    conceptsFound: ["Revenue"],
    sourceUrl: "https://nse/cons-9m.xml",
    filedAt: at("2026-01-20T00:00:00.000Z"),
  },
  {
    id: "std-q3",
    periodStart: day("2025-10-01"),
    periodEnd: Q3_END,
    periodType: "QUARTERLY",
    basis: "STANDALONE",
    cumulative: false,
    audited: false,
    coverage: 0.4,
    conceptsFound: ["Revenue"],
    sourceUrl: "https://nse/std-q3.xml",
    filedAt: at("2026-01-20T00:00:00.000Z"),
  },
  {
    id: "cons-q2",
    periodStart: day("2025-07-01"),
    periodEnd: day("2025-09-30"),
    periodType: "QUARTERLY",
    basis: "CONSOLIDATED",
    cumulative: false,
    audited: false,
    coverage: 0.9,
    conceptsFound: ["Revenue", "NetIncome", "Ebitda"],
    sourceUrl: "https://nse/cons-q2.xml",
    filedAt: at("2025-10-20T00:00:00.000Z"),
  },
];

describe("14c.8 selectFilings — cumulative vs discrete", () => {
  it("does NOT merge the nine-month cumulative into the quarterly series", () => {
    // Both share periodEnd 2025-12-31. Filtering on basis alone returns two
    // rows for one quarter and a chart that steps.
    const discrete = selectFilings(FILINGS, {
      basis: "CONSOLIDATED",
      cumulative: false,
    });
    assert.deepEqual(
      discrete.map((p) => p.id),
      ["cons-q3", "cons-q2"],
    );
    const cumulative = selectFilings(FILINGS, {
      basis: "CONSOLIDATED",
      cumulative: true,
    });
    assert.deepEqual(
      cumulative.map((p) => p.id),
      ["cons-9m"],
    );
  });

  it("splits CONSOLIDATED from STANDALONE — never one series", () => {
    // Consolidated revenue for a holding company can be a multiple of
    // standalone; one series makes that read as growth.
    const std = selectFilings(FILINGS, {
      basis: "STANDALONE",
      cumulative: false,
    });
    assert.deepEqual(
      std.map((p) => p.id),
      ["std-q3"],
    );
    assert.equal(
      std.every((p) => p.basis === "STANDALONE"),
      true,
    );
  });

  it("orders newest periodEnd first and derives the period label", () => {
    const rows = selectFilings(FILINGS, {
      basis: "CONSOLIDATED",
      cumulative: false,
    });
    assert.deepEqual(
      rows.map((p) => p.period),
      ["Q3-2026", "Q2-2026"],
    );
  });

  it("dedupes an exchange-duplicated period, higher coverage winning", () => {
    // The read is by symbol alone (a BSE view of a dual-listed name must not
    // come back empty), so the same period can arrive twice.
    const dup: XbrlFilingRow = {
      ...FILINGS[0]!,
      id: "cons-q3-bse",
      coverage: 0.95,
    };
    const rows = selectFilings([...FILINGS, dup], {
      basis: "CONSOLIDATED",
      cumulative: false,
    });
    assert.deepEqual(
      rows.map((p) => p.id),
      ["cons-q3-bse", "cons-q2"],
    );
  });

  it("marks a low-coverage filing sparse without treating absence as zero", () => {
    const std = selectFilings(FILINGS, {
      basis: "STANDALONE",
      cumulative: false,
    })[0]!;
    assert.equal(std.coverage, 0.4);
    assert.equal(std.sparse, true);
    assert.ok(SPARSE_COVERAGE_THRESHOLD > 0.4);

    const noCoverage = selectFilings(
      [{ ...FILINGS[0]!, id: "x", coverage: null }],
      { basis: "CONSOLIDATED", cumulative: false },
    )[0]!;
    assert.equal(noCoverage.coverage, null);
    assert.equal(noCoverage.sparse, false, "unknown coverage is not sparse");
  });

  it("keeps a STORED coverage of 0 as 0 — nothing resolved is a real fact", () => {
    const zero = selectFilings([{ ...FILINGS[0]!, id: "z", coverage: 0 }], {
      basis: "CONSOLIDATED",
      cumulative: false,
    })[0]!;
    assert.equal(zero.coverage, 0);
    assert.equal(zero.sparse, true);
  });

  it("drops a filing whose basis is unparseable rather than guessing one", () => {
    const rows = selectFilings([{ ...FILINGS[0]!, id: "bad", basis: "" }], {
      basis: "CONSOLIDATED",
      cumulative: false,
    });
    assert.deepEqual(rows, []);
  });
});

describe("14c.8 availableFilingViews / buildFilingDrilldown", () => {
  it("reports which bases the issuer actually filed", () => {
    const a = availableFilingViews(FILINGS);
    assert.deepEqual(a.bases, ["CONSOLIDATED", "STANDALONE"]);
    assert.equal(a.hasCumulative, true);
    assert.equal(a.hasDiscrete, true);
  });

  it("defaults to CONSOLIDATED discrete", () => {
    const d = buildFilingDrilldown(FILINGS);
    assert.equal(d.basis, DEFAULT_FINANCIALS_BASIS);
    assert.equal(d.cumulative, false);
    assert.deepEqual(
      d.periods.map((p) => p.id),
      ["cons-q3", "cons-q2"],
    );
    // 4 rows in, 2 matched the (CONSOLIDATED, discrete) view.
    assert.equal(d.filteredOut, 2);
  });

  it("falls back to a basis that EXISTS instead of an empty panel", () => {
    const standaloneOnly = FILINGS.filter((f) => f.basis === "STANDALONE");
    const d = buildFilingDrilldown(standaloneOnly, { basis: "CONSOLIDATED" });
    assert.equal(d.basis, "STANDALONE");
    assert.equal(d.periods.length, 1);
  });

  it("normalizeBasis rejects anything that is not one of the two", () => {
    assert.equal(normalizeBasis("consolidated"), "CONSOLIDATED");
    assert.equal(normalizeBasis(" STANDALONE "), "STANDALONE");
    assert.equal(normalizeBasis("COMBINED"), null);
    assert.equal(normalizeBasis(null), null);
  });

  it("no filings ⇒ empty views and no crash", () => {
    const d = buildFilingDrilldown([]);
    assert.deepEqual(d.periods, []);
    assert.deepEqual(d.available.bases, []);
    assert.equal(d.filteredOut, 0);
  });
});

// ════════════════════════════════════════════════════════════════════
// 14c.9 — funds holding this stock
// ════════════════════════════════════════════════════════════════════

const holding = (o: Partial<StockFundHoldingRow>): StockFundHoldingRow => ({
  period: day("2026-07-01"),
  amc: "SBI",
  schemeName: "SBI Bluechip Fund",
  schemeKey: "sbi bluechip",
  amfiSchemeCode: "103504",
  isin: "INE002A01018",
  instrumentId: "inst1",
  instrumentName: "Reliance Industries Ltd",
  holdingType: "EQUITY",
  quantity: 1000,
  marketValue: 250,
  percentToNav: 3,
  ...o,
});

describe("14c.9b buildFundsHoldingSection — valueHeldLakh sums the RIGHT column", () => {
  // MONEY-1484. `combinedWeightPct` sums `percentToNav` — each scheme's weight
  // IN ITS OWN NAV — so it is not a percentage of anything and routinely
  // exceeds 100 (measured on RELIANCE, Aug 2026: 505.36% across 116 rows).
  //
  // `valueHeldLakh` sums `marketValue`, which shares one denominator and may
  // legitimately be added. The two must never be confused, and swapping them
  // is invisible in every other assertion — a mutation that made
  // `valueHeldLakh` sum `percentToNav` left all 79 core tests green, which is
  // why these cases exist.
  const rows = [
    holding({ schemeKey: "a", marketValue: 250, percentToNav: 3 }),
    holding({ schemeKey: "b", marketValue: 750, percentToNav: 7 }),
  ];

  it("sums market VALUE, not weight — the two are distinguishable by design", () => {
    const s = buildFundsHoldingSection(rows);
    assert.equal(s.valueHeldLakh, 1000, "250 + 750");
    assert.equal(s.combinedWeightPct, 10, "3 + 7");
    // The fixture is chosen so the two totals CANNOT coincide. Equal values
    // would let either column satisfy both assertions.
    assert.notEqual(s.valueHeldLakh, s.combinedWeightPct);
  });

  it("an undisclosed value is COUNTED, never summed as zero", () => {
    // A scheme that disclosed no value is not a scheme holding ₹0. Folding it
    // in as zero would understate the total silently and for ever.
    const s = buildFundsHoldingSection([
      holding({ schemeKey: "a", marketValue: 250 }),
      holding({ schemeKey: "b", marketValue: null }),
    ]);
    assert.equal(s.valueHeldLakh, 250);
    assert.equal(s.undisclosedValueCount, 1);
  });

  it("no scheme disclosing a value is NULL, not 0", () => {
    const s = buildFundsHoldingSection([
      holding({ schemeKey: "a", marketValue: null }),
    ]);
    assert.equal(s.valueHeldLakh, null);
    assert.equal(s.undisclosedValueCount, 1);
  });

  it("the total covers EVERY scheme, not the `limit`-sliced display list", () => {
    // `funds` is sliced for rendering. A total computed from the slice would
    // shrink whenever the display cap tightened — a number that changes with a
    // UI constant is not a measurement.
    const many = Array.from({ length: 5 }, (_, i) =>
      holding({ schemeKey: `s${i}`, marketValue: 100 }),
    );
    const s = buildFundsHoldingSection(many, { limit: 2 });
    assert.equal(s.funds.length, 2, "the display list IS capped");
    assert.equal(s.valueHeldLakh, 500, "the total is not");
  });
});

describe("14c.9 buildFundsHoldingSection — MoM entered / exited", () => {
  const JUL = day("2026-07-01");
  const JUN = day("2026-06-01");
  const ROWS: StockFundHoldingRow[] = [
    // Held in BOTH months, weight up.
    holding({
      period: JUL,
      schemeKey: "a",
      schemeName: "Fund A",
      percentToNav: 3.5,
    }),
    holding({
      period: JUN,
      schemeKey: "a",
      schemeName: "Fund A",
      percentToNav: 3,
    }),
    // Present in JULY only ⇒ ENTERED.
    holding({
      period: JUL,
      schemeKey: "b",
      schemeName: "Fund B",
      percentToNav: 1.2,
    }),
    // Present in JUNE only ⇒ EXITED.
    holding({
      period: JUN,
      schemeKey: "c",
      schemeName: "Fund C",
      percentToNav: 0.8,
    }),
  ];
  const s = buildFundsHoldingSection(ROWS);

  it("compares the two most recent disclosure months", () => {
    assert.equal(s.period, JUL.toISOString());
    assert.equal(s.priorPeriod, JUN.toISOString());
    assert.equal(s.comparable, true);
    assert.equal(s.monthGap, false);
  });

  it("classifies a scheme present in only ONE month as entered / exited", () => {
    assert.deepEqual(
      s.entered.map((f) => f.schemeKey),
      ["b"],
    );
    assert.deepEqual(
      s.exited.map((f) => f.schemeKey),
      ["c"],
    );
    // The exited scheme is NOT in the current holder list.
    assert.deepEqual(s.funds.map((f) => f.schemeKey).sort(), ["a", "b"]);
    assert.equal(s.fundCount, 2);
  });

  it("computes the weight delta only where BOTH months disclosed one", () => {
    const a = s.funds.find((f) => f.schemeKey === "a")!;
    assert.equal(a.deltaPct, 0.5);
    // An entrant has no prior weight, so its change is UNKNOWN — not +1.2.
    const b = s.funds.find((f) => f.schemeKey === "b")!;
    assert.equal(b.deltaPct, null);
  });

  it("sums only DISCLOSED weights into the combined figure", () => {
    assert.equal(s.combinedWeightPct, 4.7);
  });
});

describe("14c.9 buildFundsHoldingSection — month gap and single month", () => {
  it("flags a NON-consecutive pair rather than calling it month-on-month", () => {
    const s = buildFundsHoldingSection([
      holding({ period: day("2026-07-01"), schemeKey: "a" }),
      holding({ period: day("2026-04-01"), schemeKey: "b" }),
    ]);
    assert.equal(s.monthGap, true);
    assert.equal(s.comparable, true);
    // The diff is still produced — a fund absent for three months really did go.
    assert.deepEqual(
      s.entered.map((f) => f.schemeKey),
      ["a"],
    );
    assert.deepEqual(
      s.exited.map((f) => f.schemeKey),
      ["b"],
    );
  });

  it("handles the year boundary without calling Dec→Jan a gap", () => {
    const s = buildFundsHoldingSection([
      holding({ period: day("2027-01-01"), schemeKey: "a" }),
      holding({ period: day("2026-12-01"), schemeKey: "a" }),
    ]);
    assert.equal(s.monthGap, false);
  });

  it("declares the diff UNKNOWABLE when only one month exists", () => {
    // Nippon publishes only the CURRENT month — this is the common state, and
    // reporting every fund as "entered" would be a fabricated signal.
    const s = buildFundsHoldingSection([
      holding({ period: day("2026-07-01"), schemeKey: "a" }),
      holding({ period: day("2026-07-01"), schemeKey: "b" }),
    ]);
    assert.equal(s.comparable, false);
    assert.equal(s.priorPeriod, null);
    assert.deepEqual(s.entered, []);
    assert.deepEqual(s.exited, []);
    assert.equal(s.fundCount, 2);
  });

  it("no rows ⇒ an empty section, not a throw", () => {
    const s = buildFundsHoldingSection([]);
    assert.equal(s.period, null);
    assert.equal(s.fundCount, 0);
    assert.equal(s.combinedWeightPct, null);
    assert.equal(s.comparable, false);
  });
});

describe("14c.9 absence rules", () => {
  it("an UNDISCLOSED percentToNav stays null and is counted, never zeroed", () => {
    const s = buildFundsHoldingSection([
      holding({ schemeKey: "a", percentToNav: null }),
      holding({ schemeKey: "b", percentToNav: 2 }),
    ]);
    const a = s.funds.find((f) => f.schemeKey === "a")!;
    assert.equal(a.percentToNav, null);
    assert.equal(s.undisclosedWeightCount, 1);
    assert.equal(s.combinedWeightPct, 2);
  });

  it("a DISCLOSED weight of 0 is a real weight and is kept as 0", () => {
    const s = buildFundsHoldingSection([
      holding({ schemeKey: "a", percentToNav: 0 }),
    ]);
    assert.equal(s.funds[0]?.percentToNav, 0);
    assert.equal(s.undisclosedWeightCount, 0);
    assert.equal(s.combinedWeightPct, 0);
  });

  it("combinedWeightPct is NULL when not one fund disclosed a weight", () => {
    const s = buildFundsHoldingSection([
      holding({ schemeKey: "a", percentToNav: null }),
      holding({ schemeKey: "b", percentToNav: null }),
    ]);
    assert.equal(s.combinedWeightPct, null, "an all-null sum must not be 0");
    assert.equal(s.fundCount, 2);
  });

  it("sorts undisclosed weights LAST instead of sorting them as 0", () => {
    const s = buildFundsHoldingSection([
      holding({ schemeKey: "a", schemeName: "A", percentToNav: null }),
      holding({ schemeKey: "b", schemeName: "B", percentToNav: 0.01 }),
      holding({ schemeKey: "c", schemeName: "C", percentToNav: 5 }),
    ]);
    assert.deepEqual(
      s.funds.map((f) => f.schemeKey),
      ["c", "b", "a"],
    );
  });
});

describe("14c.9 holding-type, linking and resolution", () => {
  it("counts EQUITY and REIT_INVIT; EXCLUDES and COUNTS the rest", () => {
    assert.deepEqual([...STOCK_HOLDING_TYPES], ["EQUITY", "REIT_INVIT"]);
    const s = buildFundsHoldingSection([
      holding({ schemeKey: "eq", holdingType: "EQUITY" }),
      holding({ schemeKey: "reit", holdingType: "REIT_INVIT" }),
      holding({ schemeKey: "bond", holdingType: "DEBT" }),
      holding({ schemeKey: "cash", holdingType: "CASH" }),
    ]);
    assert.deepEqual(s.funds.map((f) => f.schemeKey).sort(), ["eq", "reit"]);
    // A bondholder is not a shareholder — but the row is reported, not dropped.
    assert.equal(s.nonEquityRowCount, 2);
  });

  it("keeps a scheme with NO AMFI code visible, just unlinked", () => {
    const s = buildFundsHoldingSection([
      holding({
        schemeKey: "a",
        amfiSchemeCode: null,
        schemeName: "Unmapped Fund",
      }),
      holding({ schemeKey: "b", amfiSchemeCode: "103504" }),
    ]);
    const a = s.funds.find((f) => f.schemeKey === "a")!;
    assert.equal(a.href, null);
    assert.equal(a.schemeName, "Unmapped Fund");
    assert.equal(s.unlinkedFundCount, 1);
    assert.equal(s.funds.find((f) => f.schemeKey === "b")?.href, "/mf/103504");
  });

  it("counts a row that resolves to NEITHER an ISIN nor an instrument", () => {
    const s = buildFundsHoldingSection([
      holding({ schemeKey: "a" }),
      holding({ schemeKey: "ghost", isin: null, instrumentId: null }),
    ]);
    assert.equal(s.unresolvedRowCount, 1);
    assert.deepEqual(
      s.funds.map((f) => f.schemeKey),
      ["a"],
    );
  });

  it("an instrumentId-only row still counts — ISIN-first, id fallback", () => {
    const s = buildFundsHoldingSection([
      holding({ schemeKey: "a", isin: null, instrumentId: "inst1" }),
    ]);
    assert.equal(s.fundCount, 1);
    assert.equal(s.unresolvedRowCount, 0);
  });

  it("sums a scheme's TWO holding lines for the same issuer", () => {
    // @@unique is (period, amc, schemeKey, instrumentName) — two spellings of
    // one issuer inside one scheme are both valid rows and both this stock.
    const s = buildFundsHoldingSection([
      holding({
        schemeKey: "a",
        instrumentName: "Reliance Industries Ltd",
        percentToNav: 2,
        quantity: 100,
        marketValue: 50,
      }),
      holding({
        schemeKey: "a",
        instrumentName: "Reliance Industries Ltd - PP",
        percentToNav: 0.5,
        quantity: 10,
        marketValue: 5,
      }),
    ]);
    assert.equal(s.fundCount, 1);
    assert.equal(s.funds[0]?.percentToNav, 2.5);
    assert.equal(s.funds[0]?.quantity, 110);
    assert.equal(s.funds[0]?.marketValueLakh, 55);
  });

  it("caps the displayed list without distorting the totals", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      holding({ schemeKey: `s${i}`, percentToNav: i + 1 }),
    );
    const s = buildFundsHoldingSection(rows, { limit: 2 });
    assert.equal(s.funds.length, 2);
    assert.equal(s.fundCount, 5, "count is the truth, not the page size");
    assert.equal(s.combinedWeightPct, 15);
  });
});
