/**
 * UNIT TESTS — `bse-announcements-sync-logic.ts` (MONEY-1255).
 *
 * Every symbol imported here is the REAL export the processor calls; there are
 * no shadow re-implementations.
 *
 * The weight is on {@link derivePeriodEnd} and its REJECT path, because that is
 * the one decision in this job that can do damage rather than merely fail to
 * help. `stock_documents` is `@@unique([symbol, exchange, docType, period])`, so
 * a fabricated period files a company's quarter under a date it keeps forever,
 * and the downstream Gemini parse pipeline then reads a real statement against
 * the wrong quarter. A row with NO derivable period simply stays a
 * `corporate_filing`, which costs nothing — the PDF is still archived, still
 * embedded, still searchable. Every reject case below is therefore an assertion
 * that the cheap failure was chosen over the expensive guess.
 *
 * The period LABEL is asserted by round-tripping it through the REAL
 * `parseDocumentPeriod` rather than by restating its regex — a label outside
 * that parser's measured vocabulary does not error, it sorts LAST forever.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// RELATIVE, deliberately. `docs-section-logic` has no `exports` subpath on
// @usemoney/core, and the market-data BARREL is the only published door to it
// — importing a barrel here would drag the whole market-data surface (and its
// Prisma-touching modules) into a pure unit test. The point of this import is
// to assert against the REAL parser the timeline sorts by rather than a
// restated regex, so a copy is not an option either.
import { parseDocumentPeriod } from "../../../packages/core/src/market-data/docs-section-logic";
import { PARSEABLE_DOC_TYPES } from "../../src/processors/stock-document-parse-logic";
import type { BseAnnouncement } from "@usemoney/research/data-sources/bse-client";
import {
  BSE_BREADCRUMB_PREFIX,
  BSE_DOC_TYPE_CORPORATE_FILING,
  BSE_DOC_TYPE_QUARTERLY_RESULT,
  BSE_MAX_CHAIN_DEPTH,
  BSE_RUN_TIME_BUDGET_MS,
  MAX_SUPERSEDED_TRAIL,
  announcementPeriod,
  attachmentNameFromUrl,
  buildBseDocumentDescription,
  bseCompactToIsoDate,
  bseDecisionWrites,
  classifyBseAnnouncement,
  decideBseAnnouncementWrite,
  decodeQuarterId,
  derivePeriodEnd,
  interleaveByCategory,
  isWithinBseRunBudget,
  judgeBseAnnouncementsHealth,
  normalizeBseChainDepth,
  normalizeBseResumeIndex,
  parseBseDocumentBreadcrumb,
  quarterlyPeriodLabel,
  shouldChainBseAnnouncements,
  summarizeCategoryCounts,
  windowDays,
} from "../../src/processors/bse-announcements-sync-logic";

function ann(overrides: Partial<BseAnnouncement> = {}): BseAnnouncement {
  return {
    scripCode: "530127",
    symbol: "",
    company: "Test Industries Ltd",
    title: "UNAUDITED RESULTS QUARTER ENDED 30/06/2026",
    description: "",
    category: "Result",
    subcategory: "Financial Results",
    pdfUrl:
      "https://www.bseindia.com/xml-data/corpfiling/AttachLive/b2235ebf-aaaa.pdf",
    newsId: "n-1",
    xmlName: "ANN_530127_AD76AC5C",
    quarterId: "",
    publishedAt: new Date("2026-08-14T18:05:00Z"),
    ...overrides,
  };
}

const iso = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

// ── A1.3 — periodEnd derivation: the ACCEPT patterns ────────────────────────

describe("derivePeriodEnd — patterns that yield a REAL period end", () => {
  it("DD/MM/YYYY — the live-observed 'QUARTER ENDED 30/06/2026'", () => {
    const d = derivePeriodEnd("UNAUDITED RESULTS QUARTER ENDED 30/06/2026")!;
    assert.strictEqual(iso(d.date), "2026-06-30");
    assert.strictEqual(d.source, "NEWSSUB_EXPLICIT_DATE");
  });

  it("DD.MM.YYYY — the live-observed 'AUDITED FIN RESULTS 31.03.2026'", () => {
    const d = derivePeriodEnd("AUDITED FIN RESULTS 31.03.2026")!;
    assert.strictEqual(iso(d.date), "2026-03-31");
  });

  it("DD-MM-YYYY", () => {
    assert.strictEqual(
      iso(derivePeriodEnd("Results for the quarter ended 30-09-2025")?.date),
      "2025-09-30",
    );
  });

  it("reads DAY-first, not month-first (Indian convention)", () => {
    // 30 is not a valid month, so this can only be day-first — but it also
    // pins the convention explicitly.
    assert.strictEqual(
      iso(derivePeriodEnd("Q ENDED 31/12/2025")?.date),
      "2025-12-31",
    );
  });

  it("a leap-day period end is a real date", () => {
    assert.strictEqual(
      iso(derivePeriodEnd("Results for period ended 29/02/2024")?.date),
      "2024-02-29",
    );
  });

  it("named month + 'ENDED' cue, quarter-end month only", () => {
    const d = derivePeriodEnd("Outcome: results for QUARTER ENDED JUNE 2026")!;
    assert.strictEqual(iso(d.date), "2026-06-30");
    assert.strictEqual(d.source, "NEWSSUB_MONTH_NAME");
  });

  it("'ENDING' is accepted as the cue too", () => {
    assert.strictEqual(
      iso(
        derivePeriodEnd("Financial results for the year ending March 2026")
          ?.date,
      ),
      "2026-03-31",
    );
  });

  it("picks the LATEST month-end when comparatives are also named", () => {
    // A results subject names the period it reports PLUS its comparatives, and
    // a comparative is always EARLIER.
    const d = derivePeriodEnd(
      "Results for quarter ended 30/06/2026 vs corresponding quarter ended 30/06/2025",
    )!;
    assert.strictEqual(iso(d.date), "2026-06-30");
  });

  it("prefers a QUARTER-END month over a non-quarter month-end", () => {
    const d = derivePeriodEnd(
      "Results for the period ended 30/06/2026, superseding the one ended 31/07/2026",
    )!;
    assert.strictEqual(iso(d.date), "2026-06-30");
  });

  it("IGNORES a submission date that is not a month end", () => {
    // THE case the month-end filter exists for. Taking "the latest date" alone
    // would file this quarter under 14 August.
    const d = derivePeriodEnd(
      "Results submitted on 14/08/2026 for quarter ended 30/06/2026",
    )!;
    assert.strictEqual(iso(d.date), "2026-06-30");
  });
});

// ── A1.3 — the REJECT path. Absent beats fabricated. ────────────────────────

describe("derivePeriodEnd — the REJECT path (null, never a guess)", () => {
  const rejects: Array<[string, string]> = [
    ["no date at all", "Outcome of Board Meeting"],
    ["empty subject", ""],
    ["whitespace only", "   "],
    ["a date with an impossible day", "Results for quarter ended 31/06/2026"],
    ["a date with an impossible month", "Results for quarter ended 30/13/2026"],
    ["31 February", "Results for quarter ended 31/02/2026"],
    ["29 Feb in a non-leap year", "Results for quarter ended 29/02/2026"],
    ["a year below the plausible band", "Results for quarter ended 30/06/1899"],
    ["a two-digit year", "Results for quarter ended 30/06/26"],
    ["a mid-month date only", "Results approved on 15/08/2026"],
    ["a named month with NO 'ended' cue", "Investor call in June 2026"],
    [
      "a named month that is not a quarter end",
      "Results for period ended July 2026",
    ],
    ["a bare year", "Annual results 2026"],
    ["a sequence id that looks date-ish", "Filing ref 106748636"],
  ];

  for (const [label, subject] of rejects) {
    it(`returns null for ${label}`, () => {
      assert.strictEqual(
        derivePeriodEnd(subject),
        null,
        `"${subject}" was turned into a period end`,
      );
    });
  }

  it("null / undefined input is null, not a throw", () => {
    assert.strictEqual(derivePeriodEnd(null), null);
    assert.strictEqual(derivePeriodEnd(undefined), null);
  });
});

// ── QUARTER_ID: a cross-check, never a source ──────────────────────────────

describe("decodeQuarterId", () => {
  it("decodes an unambiguous YYYYMMDD", () => {
    assert.strictEqual(iso(decodeQuarterId("20260630")), "2026-06-30");
  });

  it("decodes YYYYMM to that month's LAST day", () => {
    assert.strictEqual(iso(decodeQuarterId("202606")), "2026-06-30");
    assert.strictEqual(iso(decodeQuarterId("202602")), "2026-02-28");
  });

  it("is INERT for anything that is not self-evidently a date", () => {
    for (const v of [
      "0",
      "1",
      "42",
      "",
      null,
      undefined,
      "Q1",
      "2026",
      "1234567",
    ]) {
      assert.strictEqual(decodeQuarterId(v), null, `decoded ${String(v)}`);
    }
  });

  it("rejects an out-of-band year and an impossible month", () => {
    assert.strictEqual(decodeQuarterId("189901"), null);
    assert.strictEqual(decodeQuarterId("202613"), null);
  });

  it("rejects a day that does not exist in its month, without ROLLING OVER", () => {
    // The only path on which the day-vs-month validation is reachable.
    // `derivePeriodEnd` masks it — its month-end filter rejects every rolled
    // over date anyway (31/02 becomes 3 March, which is not a month end) — so
    // a mutation that weakened `utcDate` to `day > 31` survived the whole
    // derivation suite. It does NOT survive here: `Date.UTC(2026, 1, 31)`
    // silently yields 3 March, and `decodeQuarterId` feeds the cross-check
    // that can ABANDON a correct derivation. A rolled-over decode would
    // contradict a perfectly good subject line and throw the period away.
    assert.strictEqual(decodeQuarterId("20260231"), null);
    assert.strictEqual(decodeQuarterId("20260229"), null); // 2026 is not a leap year
    assert.strictEqual(decodeQuarterId("20260431"), null);
    assert.strictEqual(decodeQuarterId("20260931"), null);
    // ...and still accepts the real leap day.
    assert.strictEqual(iso(decodeQuarterId("20240229")), "2024-02-29");
  });

  it("a rolled-over QUARTER_ID cannot silently veto a correct subject line", () => {
    // 20260231 must not decode to 3 March and then "contradict" a June quarter.
    const d = derivePeriodEnd("QUARTER ENDED 30/06/2026", "20260231");
    assert.ok(d, "an invalid QUARTER_ID destroyed a valid derivation");
    assert.strictEqual(iso(d.date), "2026-06-30");
    assert.strictEqual(d.quarterIdCorroborated, false);
  });
});

describe("derivePeriodEnd — QUARTER_ID cross-check", () => {
  it("a decodable AGREEING id corroborates and keeps the subject's date", () => {
    const d = derivePeriodEnd("QUARTER ENDED 30/06/2026", "202606")!;
    assert.strictEqual(iso(d.date), "2026-06-30");
    assert.strictEqual(d.quarterIdCorroborated, true);
  });

  it("a decodable CONTRADICTING id abandons the derivation entirely", () => {
    // Two sources disagreeing about which quarter a filing covers is not a tie
    // to break — it is a reason to store a corporate_filing and lose nothing.
    assert.strictEqual(
      derivePeriodEnd("QUARTER ENDED 30/06/2026", "202603"),
      null,
    );
  });

  it("an UNDECODABLE id neither corroborates nor blocks", () => {
    const d = derivePeriodEnd("QUARTER ENDED 30/06/2026", "0")!;
    assert.strictEqual(iso(d.date), "2026-06-30");
    assert.strictEqual(d.quarterIdCorroborated, false);
  });

  it("QUARTER_ID alone never mints a period", () => {
    assert.strictEqual(
      derivePeriodEnd("Outcome of Board Meeting", "202606"),
      null,
    );
  });
});

// ── The period LABEL must live inside the timeline sorter's vocabulary ──────

describe("quarterlyPeriodLabel", () => {
  it("is month-name-of-quarter-end", () => {
    assert.strictEqual(
      quarterlyPeriodLabel(new Date(Date.UTC(2026, 5, 30))),
      "Jun 2026",
    );
    assert.strictEqual(
      quarterlyPeriodLabel(new Date(Date.UTC(2026, 2, 31))),
      "Mar 2026",
    );
    assert.strictEqual(
      quarterlyPeriodLabel(new Date(Date.UTC(2025, 11, 31))),
      "Dec 2025",
    );
    assert.strictEqual(
      quarterlyPeriodLabel(new Date(Date.UTC(2025, 8, 30))),
      "Sep 2025",
    );
  });

  it("ROUND-TRIPS through the REAL parseDocumentPeriod the timeline sorts by", () => {
    // Asserted against the actual parser, not against a restated regex: a
    // label outside its measured vocabulary returns null, which routes the row
    // to the unparseable-sorts-LAST branch — it exists and is invisible.
    for (const [y, m] of [
      [2026, 5],
      [2026, 2],
      [2025, 11],
      [2025, 8],
    ] as const) {
      const end = new Date(Date.UTC(y, m, 1));
      const label = quarterlyPeriodLabel(end);
      const parsed = parseDocumentPeriod(label);
      assert.ok(parsed, `parseDocumentPeriod returned null for "${label}"`);
      assert.strictEqual(parsed.kind, "month");
      assert.strictEqual(parsed.year, y);
      assert.strictEqual(parsed.month, m + 1);
    }
  });

  it("consecutive quarters sort ASCENDING by the parser's own key", () => {
    const keys = [
      new Date(Date.UTC(2025, 8, 30)),
      new Date(Date.UTC(2025, 11, 31)),
      new Date(Date.UTC(2026, 2, 31)),
      new Date(Date.UTC(2026, 5, 30)),
    ].map((d) => parseDocumentPeriod(quarterlyPeriodLabel(d))!.key);
    assert.deepStrictEqual(keys, [...keys].sort());
    assert.strictEqual(new Set(keys).size, 4);
  });

  it("a corporate_filing period (bse-{newsId}) is NOT confusable with a quarter", () => {
    const p = parseDocumentPeriod("bse-106748636");
    // It may parse as SOMETHING (a bare year out of the id) or not at all —
    // what matters is that it never claims to be a month.
    assert.notStrictEqual(p?.kind, "month");
  });
});

// ── Classification ─────────────────────────────────────────────────────────

describe("classifyBseAnnouncement", () => {
  it("Result + derivable period -> quarterly_result keyed on the quarter", () => {
    const c = classifyBseAnnouncement(ann());
    assert.strictEqual(c.docType, BSE_DOC_TYPE_QUARTERLY_RESULT);
    assert.strictEqual(c.period, "Jun 2026");
    assert.strictEqual(iso(c.periodEnd), "2026-06-30");
    assert.strictEqual(c.reason, "result-with-period");
  });

  it("Integrated Filing + derivable period -> quarterly_result too", () => {
    const c = classifyBseAnnouncement(
      ann({ category: "Integrated Filing", subcategory: "Integrated Filing" }),
    );
    assert.strictEqual(c.docType, BSE_DOC_TYPE_QUARTERLY_RESULT);
    assert.strictEqual(c.period, "Jun 2026");
  });

  it("Result with NO derivable period -> corporate_filing keyed on the news id", () => {
    const c = classifyBseAnnouncement(
      ann({ title: "Outcome of Board Meeting", newsId: "n-77" }),
    );
    assert.strictEqual(c.docType, BSE_DOC_TYPE_CORPORATE_FILING);
    assert.strictEqual(c.period, "bse-n-77");
    assert.strictEqual(c.periodEnd, null);
    assert.strictEqual(c.reason, "result-without-period");
  });

  it("a NON-result category with a period-shaped date stays corporate_filing", () => {
    // Category alone is not enough in either direction. A Board Meeting notice
    // naming a month end is not a filed statement.
    const c = classifyBseAnnouncement(
      ann({
        category: "Board Meeting",
        title: "Board meeting to consider results for quarter ended 30/06/2026",
      }),
    );
    assert.strictEqual(c.docType, BSE_DOC_TYPE_CORPORATE_FILING);
    assert.strictEqual(c.reason, "not-a-result-category");
  });

  it("the category match is case- and whitespace-insensitive", () => {
    const c = classifyBseAnnouncement(ann({ category: "  result  " }));
    assert.strictEqual(c.docType, BSE_DOC_TYPE_QUARTERLY_RESULT);
  });

  it("a SUBCATEGORY of 'Financial Results' does NOT promote a non-result row", () => {
    // The pre-fix parser collapsed CATEGORYNAME||SUBCATNAME, so this row would
    // have arrived with category "Financial Results".
    const c = classifyBseAnnouncement(
      ann({ category: "Company Update", subcategory: "Financial Results" }),
    );
    assert.strictEqual(c.docType, BSE_DOC_TYPE_CORPORATE_FILING);
  });

  it("passes QUARTER_ID through to the cross-check", () => {
    const c = classifyBseAnnouncement(ann(), "202603");
    assert.strictEqual(c.docType, BSE_DOC_TYPE_CORPORATE_FILING);
    assert.strictEqual(c.reason, "result-without-period");
  });

  it("A1.4 — quarterly_result IS in the parse lane's selection family", () => {
    // Without this the promotion is decorative: the row would be created and
    // the financials parser would never select it.
    assert.ok(PARSEABLE_DOC_TYPES.includes(BSE_DOC_TYPE_QUARTERLY_RESULT));
    assert.ok(!PARSEABLE_DOC_TYPES.includes(BSE_DOC_TYPE_CORPORATE_FILING));
  });
});

describe("announcementPeriod", () => {
  it("uses the globally-unique BSE news id", () => {
    assert.strictEqual(
      announcementPeriod(ann({ newsId: "12345" })),
      "bse-12345",
    );
  });

  it("falls back to a date+title hash that is STABLE across calls", () => {
    const a = ann({ newsId: "", title: "Some filing" });
    assert.strictEqual(announcementPeriod(a), announcementPeriod(a));
    assert.match(announcementPeriod(a), /^bse-\d{8}-/);
  });

  it("two same-day filings with different titles do not collide", () => {
    const a = ann({ newsId: "", title: "Filing A" });
    const b = ann({ newsId: "", title: "Filing B" });
    assert.notStrictEqual(announcementPeriod(a), announcementPeriod(b));
  });

  // MONEY-1536 — NEWS_DT "2026-09-23T02:00:00" is IST wall-clock, i.e.
  // 2026-09-22T20:30Z now that it is parsed as the instant it names. The key is
  // the filing's IST day, which is what the Cloud Run parse always produced.
  // Mutation: back to `d.toISOString().slice(0, 10)` -> RED ("20260922").
  it("the fallback date is the filing's IST day", () => {
    const a = ann({
      newsId: "",
      title: "Early filing",
      publishedAt: new Date("2026-09-22T20:30:00Z"),
    });
    assert.match(announcementPeriod(a), /^bse-20260923-/);
  });
});

// ── The breadcrumb: XML_NAME on the row + the D-v supersession trail ────────

describe("buildBseDocumentDescription / parseBseDocumentBreadcrumb", () => {
  it("persists XML_NAME, the attachment, the news id and BOTH taxonomy levels", () => {
    const d = buildBseDocumentDescription({ ann: ann() });
    const b = parseBseDocumentBreadcrumb(d)!;
    assert.strictEqual(b.xmlName, "ANN_530127_AD76AC5C");
    assert.strictEqual(b.attachment, "b2235ebf-aaaa.pdf");
    assert.strictEqual(b.newsId, "n-1");
    assert.strictEqual(b.category, "Result");
    assert.strictEqual(b.subcategory, "Financial Results");
    assert.deepStrictEqual(b.superseded, []);
    assert.ok(d.includes(BSE_BREADCRUMB_PREFIX));
  });

  it("keeps BSE's own description text above the breadcrumb", () => {
    const d = buildBseDocumentDescription({
      ann: ann({ description: "Board approved the results." }),
    });
    assert.ok(d.startsWith("Board approved the results.\n"));
    assert.strictEqual(
      parseBseDocumentBreadcrumb(d)!.xmlName,
      "ANN_530127_AD76AC5C",
    );
  });

  it("D-v: the SUPERSEDED attachment survives on the row", () => {
    const first = buildBseDocumentDescription({ ann: ann() });
    const revised = buildBseDocumentDescription({
      ann: ann({
        pdfUrl:
          "https://www.bseindia.com/xml-data/corpfiling/AttachLive/rev-2.pdf",
      }),
      previousDescription: first,
      supersededAttachment: "b2235ebf-aaaa.pdf",
    });
    const b = parseBseDocumentBreadcrumb(revised)!;
    assert.strictEqual(b.attachment, "rev-2.pdf");
    assert.deepStrictEqual(b.superseded, ["b2235ebf-aaaa.pdf"]);
  });

  it("the supersession trail ACCUMULATES and is BOUNDED", () => {
    let desc = buildBseDocumentDescription({ ann: ann() });
    let prevAttachment = "b2235ebf-aaaa.pdf";
    for (let i = 1; i <= MAX_SUPERSEDED_TRAIL + 3; i++) {
      const url = `https://www.bseindia.com/xml-data/corpfiling/AttachLive/rev-${i}.pdf`;
      desc = buildBseDocumentDescription({
        ann: ann({ pdfUrl: url }),
        previousDescription: desc,
        supersededAttachment: prevAttachment,
      });
      prevAttachment = `rev-${i}.pdf`;
    }
    const b = parseBseDocumentBreadcrumb(desc)!;
    assert.strictEqual(b.superseded.length, MAX_SUPERSEDED_TRAIL);
    // Oldest dropped, newest kept.
    assert.strictEqual(
      b.superseded.at(-1),
      `rev-${MAX_SUPERSEDED_TRAIL + 2}.pdf`,
    );
    assert.ok(!b.superseded.includes("b2235ebf-aaaa.pdf"));
  });

  it("does not duplicate an attachment already in the trail", () => {
    const first = buildBseDocumentDescription({ ann: ann() });
    const twice = buildBseDocumentDescription({
      ann: ann(),
      previousDescription: buildBseDocumentDescription({
        ann: ann(),
        previousDescription: first,
        supersededAttachment: "x.pdf",
      }),
      supersededAttachment: "x.pdf",
    });
    assert.deepStrictEqual(parseBseDocumentBreadcrumb(twice)!.superseded, [
      "x.pdf",
    ]);
  });

  it("a value containing the delimiters ROUND-TRIPS, it is not truncated", () => {
    // Asserting only "the parsed value has no ; or =" is vacuous: an
    // UNSANITISED `AN;N=1` splits on the delimiter and comes back as "AN",
    // which also contains neither. The assertion has to be equality against
    // the sanitised form, or the encoding can silently eat the field.
    const d = buildBseDocumentDescription({
      ann: ann({
        xmlName: "AN;N=1\nBROKEN",
        description: "note; with = signs",
      }),
    });
    const b = parseBseDocumentBreadcrumb(d)!;
    assert.strictEqual(b.xmlName, "AN N 1 BROKEN");
    assert.ok(!b.xmlName.includes(";"));
    assert.ok(!b.xmlName.includes("="));
    // Everything AFTER the mangled field must still be readable.
    assert.strictEqual(b.attachment, "b2235ebf-aaaa.pdf");
    assert.strictEqual(b.newsId, "n-1");
    assert.strictEqual(b.category, "Result");
    assert.strictEqual(b.subcategory, "Financial Results");
  });

  it("a newline in the human text cannot push the breadcrumb onto another line", () => {
    const d = buildBseDocumentDescription({
      ann: ann({ description: "line one\nbse-meta xml=SPOOFED" }),
    });
    // The LAST marker wins, and the real fields follow it.
    const b = parseBseDocumentBreadcrumb(d)!;
    assert.strictEqual(b.xmlName, "ANN_530127_AD76AC5C");
  });

  it("returns null for a description with no breadcrumb", () => {
    assert.strictEqual(parseBseDocumentBreadcrumb("just prose"), null);
    assert.strictEqual(parseBseDocumentBreadcrumb(null), null);
    assert.strictEqual(parseBseDocumentBreadcrumb(undefined), null);
  });

  it("attachmentNameFromUrl strips the path and any query", () => {
    assert.strictEqual(
      attachmentNameFromUrl(
        "https://www.bseindia.com/xml-data/corpfiling/AttachLive/a-b.pdf?x=1",
      ),
      "a-b.pdf",
    );
    assert.strictEqual(attachmentNameFromUrl(null), "");
    assert.strictEqual(attachmentNameFromUrl(""), "");
  });
});

// ── A1.5 — the health verdict that makes this defect impossible to repeat ───

const cat = (
  category: string,
  count: number,
  stop: "exhausted" | "maxPages" | "failed" = "exhausted",
) => ({ category, count, pages: 1, stop });

describe("judgeBseAnnouncementsHealth", () => {
  it("ZERO across ALL NINE categories is UNHEALTHY — the defect's signature", () => {
    const h = judgeBseAnnouncementsHealth({
      byCategory: [
        cat("AGM/EGM", 0),
        cat("Board Meeting", 0),
        cat("Company Update", 0),
        cat("Corp. Action", 0),
        cat("Insider Trading / SAST", 0),
        cat("New Listing", 0),
        cat("Result", 0),
        cat("Integrated Filing", 0),
        cat("Others", 0),
      ],
      transportFailures: 0,
      windowDays: 2,
    });
    assert.strictEqual(h.healthy, false);
    assert.match(h.reason, /0 announcements across ALL 9 categories/);
    assert.strictEqual(h.emptyCategories.length, 9);
  });

  it("a run with rows anywhere is HEALTHY", () => {
    const h = judgeBseAnnouncementsHealth({
      byCategory: [cat("Result", 12), cat("Board Meeting", 0)],
      transportFailures: 0,
      windowDays: 2,
    });
    assert.strictEqual(h.healthy, true);
  });

  it("a SINGLE empty category is healthy but NAMED (the near-miss spelling)", () => {
    const h = judgeBseAnnouncementsHealth({
      byCategory: [cat("Result", 12), cat("New Listing", 0)],
      transportFailures: 0,
      windowDays: 2,
    });
    assert.strictEqual(h.healthy, true);
    assert.deepStrictEqual(h.emptyCategories, ["New Listing"]);
    assert.match(h.reason, /empty: New Listing/);
  });

  it("every walk FAILING is UNHEALTHY and says upstream, not empty", () => {
    const h = judgeBseAnnouncementsHealth({
      byCategory: [cat("Result", 0, "failed"), cat("Others", 0, "failed")],
      transportFailures: 2,
      windowDays: 2,
    });
    assert.strictEqual(h.healthy, false);
    assert.match(h.reason, /category walks FAILED/);
    // A failed walk is not an "empty category" — the distinction is what tells
    // a blocked egress apart from a wrong query.
    assert.deepStrictEqual(h.emptyCategories, []);
  });

  it("a PARTIAL failure is UNHEALTHY even though rows arrived", () => {
    const h = judgeBseAnnouncementsHealth({
      byCategory: [cat("Result", 12), cat("Others", 0, "failed")],
      transportFailures: 1,
      windowDays: 2,
    });
    assert.strictEqual(h.healthy, false);
    assert.match(h.reason, /1 of 2 category walks failed/);
  });

  it("an EMPTY category list is UNHEALTHY, never vacuously healthy", () => {
    const h = judgeBseAnnouncementsHealth({
      byCategory: [],
      transportFailures: 0,
      windowDays: 2,
    });
    assert.strictEqual(h.healthy, false);
    assert.match(h.reason, /no category was queried/);
  });

  it("the reason ALWAYS carries the per-category census", () => {
    for (const input of [
      { byCategory: [cat("Result", 3)], transportFailures: 0, windowDays: 1 },
      { byCategory: [cat("Result", 0)], transportFailures: 0, windowDays: 1 },
      {
        byCategory: [cat("Result", 0, "failed")],
        transportFailures: 1,
        windowDays: 1,
      },
    ]) {
      assert.match(judgeBseAnnouncementsHealth(input).reason, /Result=/);
    }
  });
});

describe("summarizeCategoryCounts", () => {
  it("names every category and flags FAILED / CAPPED walks", () => {
    const s = summarizeCategoryCounts([
      cat("Result", 12),
      cat("Others", 0, "failed"),
      cat("AGM/EGM", 40, "maxPages"),
    ]);
    assert.strictEqual(s, "Result=12 Others=0(FAILED) AGM/EGM=40(CAPPED)");
  });

  it("says so when nothing was queried, rather than returning ''", () => {
    assert.strictEqual(summarizeCategoryCounts([]), "no categories queried");
  });
});

describe("windowDays", () => {
  it("counts whole days and floors at 1 so a same-day window reads as 1-day", () => {
    assert.strictEqual(
      windowDays(
        new Date("2026-08-24T00:00:00Z"),
        new Date("2026-08-26T00:00:00Z"),
      ),
      2,
    );
    assert.strictEqual(
      windowDays(
        new Date("2026-08-26T00:00:00Z"),
        new Date("2026-08-26T00:00:00Z"),
      ),
      1,
    );
  });

  it("an Invalid Date does not produce NaN in the reason string", () => {
    assert.strictEqual(windowDays(new Date("nope"), new Date()), 1);
  });
});

// ── MONEY-1285 — the write decision, the ordering, the budget, the chain ────

describe("decideBseAnnouncementWrite", () => {
  const bytes = { gcsPath: "stocks/X/corporate_filing/a.pdf", fileSize: 4096 };
  const noBytes = { gcsPath: "", fileSize: 0 };

  it("no existing row → write-new", () => {
    assert.equal(
      decideBseAnnouncementWrite({
        existing: null,
        isQuarterly: false,
        priorAttachment: "",
        incomingAttachment: "a.pdf",
      }),
      "write-new",
    );
  });

  it("THE DEFECT: an existing corporate_filing with NO bytes is retried", () => {
    // 2,339 rows on prod, all from the last four days, all with `gcsPath: ""`
    // while BSE was serving the attachments. A `corporate_filing`'s period is
    // `bse-{newsId}` — globally unique per filing — so the existing row matches
    // on EVERY later run and the old unconditional `!isQuarterly` skip made the
    // gap permanent.
    assert.equal(
      decideBseAnnouncementWrite({
        existing: noBytes,
        isQuarterly: false,
        priorAttachment: "a.pdf",
        incomingAttachment: "a.pdf",
      }),
      "write-retry-bytes",
    );
  });

  it("CONTROL: an existing corporate_filing WITH bytes is skipped", () => {
    // Without this, the rule degenerates to "always download", which re-fetches
    // all 4,268 rows a night and puts the run back over its ack deadline.
    assert.equal(
      decideBseAnnouncementWrite({
        existing: bytes,
        isQuarterly: false,
        priorAttachment: "a.pdf",
        incomingAttachment: "a.pdf",
      }),
      "skip-has-bytes",
    );
  });

  it("the bytes test is docType-INDEPENDENT", () => {
    // The whole defect was one rule spelled twice, and only one spelling
    // reachable per docType. Same inputs, same answer, both ways.
    for (const isQuarterly of [true, false]) {
      assert.equal(
        decideBseAnnouncementWrite({
          existing: noBytes,
          isQuarterly,
          priorAttachment: "a.pdf",
          incomingAttachment: "a.pdf",
        }),
        "write-retry-bytes",
        `isQuarterly=${isQuarterly}`,
      );
      assert.equal(
        decideBseAnnouncementWrite({
          existing: bytes,
          isQuarterly,
          priorAttachment: "a.pdf",
          incomingAttachment: "a.pdf",
        }),
        "skip-has-bytes",
        `isQuarterly=${isQuarterly}`,
      );
    }
  });

  it("a CHANGED attachment on a quarterly supersedes, bytes or not", () => {
    // D-v, latest wins: one row per company-quarter, so a revision collides by
    // design and must replace rather than be skipped.
    assert.equal(
      decideBseAnnouncementWrite({
        existing: bytes,
        isQuarterly: true,
        priorAttachment: "old.pdf",
        incomingAttachment: "new.pdf",
      }),
      "write-superseding",
    );
    assert.equal(
      decideBseAnnouncementWrite({
        existing: noBytes,
        isQuarterly: true,
        priorAttachment: "old.pdf",
        incomingAttachment: "new.pdf",
      }),
      "write-superseding",
    );
  });

  it("a partial archive (path but zero bytes) counts as NO bytes", () => {
    // `gcsPath` is non-null on the model, so an empty-string path and a
    // zero-length file are two spellings of the same failure. Both must retry.
    assert.equal(
      decideBseAnnouncementWrite({
        existing: { gcsPath: "stocks/X/a.pdf", fileSize: 0 },
        isQuarterly: false,
        priorAttachment: "a.pdf",
        incomingAttachment: "a.pdf",
      }),
      "write-retry-bytes",
    );
  });

  it("bseDecisionWrites: skip-has-bytes is the ONLY skip", () => {
    assert.equal(bseDecisionWrites("skip-has-bytes"), false);
    for (const d of [
      "write-new",
      "write-retry-bytes",
      "write-superseding",
    ] as const) {
      assert.equal(bseDecisionWrites(d), true, d);
    }
  });
});

describe("interleaveByCategory", () => {
  const cat = (c: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => `${c}${i}`);

  it("round-robins, so a PREFIX of the result reaches every category", () => {
    // This is the property the 500-download cap needs. The client returns
    // category-MAJOR rows; a cap over that takes a prefix, and the prefix was
    // the same two categories every night while five got nothing.
    const items = [...cat("A", 300), ...cat("B", 300), ...cat("C", 300)];
    const out = interleaveByCategory(items, (s) => s[0]!);
    const prefix = out.slice(0, 500);
    for (const c of ["A", "B", "C"]) {
      assert.ok(
        prefix.some((s) => s.startsWith(c)),
        `category ${c} is absent from the first 500`,
      );
    }
  });

  it("CONTROL: the un-interleaved list starves the last category", () => {
    // The falsifier. Without this the case above passes for any permutation,
    // including the identity — so it would assert nothing about the fix.
    const items = [...cat("A", 300), ...cat("B", 300), ...cat("C", 300)];
    assert.ok(
      !items.slice(0, 500).some((s) => s.startsWith("C")),
      "the fixture does not reproduce the starvation it is written against",
    );
  });

  it("is a PERMUTATION — nothing added, nothing lost", () => {
    const items = [...cat("A", 5), ...cat("B", 2), ...cat("C", 9)];
    const out = interleaveByCategory(items, (s) => s[0]!);
    assert.equal(out.length, items.length);
    assert.deepEqual([...out].sort(), [...items].sort());
  });

  it("keeps within-category order, so a resume by INDEX is meaningful", () => {
    const items = ["A0", "A1", "A2", "B0", "B1"];
    const out = interleaveByCategory(items, (s) => s[0]!);
    assert.deepEqual(out, ["A0", "B0", "A1", "B1", "A2"]);
  });

  it("is deterministic across calls", () => {
    // `resumeIndex` indexes into this permutation on the NEXT link, which is a
    // different process. A non-deterministic order (a Set iteration, a sort by
    // a colliding key) would resume into a different list.
    const items = [...cat("A", 7), ...cat("B", 3), ...cat("C", 5)];
    const a = interleaveByCategory(items, (s) => s[0]!);
    const b = interleaveByCategory(items, (s) => s[0]!);
    assert.deepEqual(a, b);
  });

  it("handles an empty list and a single category", () => {
    assert.deepEqual(
      interleaveByCategory([], (s: string) => s),
      [],
    );
    assert.deepEqual(
      interleaveByCategory(["A0", "A1"], (s) => s[0]!),
      ["A0", "A1"],
    );
  });
});

describe("isWithinBseRunBudget", () => {
  it("permits work up to the budget and refuses at it", () => {
    assert.equal(isWithinBseRunBudget(0, BSE_RUN_TIME_BUDGET_MS - 1), true);
    assert.equal(isWithinBseRunBudget(0, BSE_RUN_TIME_BUDGET_MS), false);
    assert.equal(isWithinBseRunBudget(0, BSE_RUN_TIME_BUDGET_MS + 1), false);
  });

  it("the budget plus one worst announcement still clears the ack deadline", () => {
    // The headroom arithmetic on the constant, restated as a check rather than
    // as prose. Worst in-flight announcement = both attachment candidates
    // timing out at 30s, plus the 1500ms pace, plus a GCS upload; then the
    // report and the ONE chain publish.
    const worstInFlightMs = 2 * 30_000 + 1_500 + 5_000;
    const tailMs = 1_000;
    assert.ok(
      BSE_RUN_TIME_BUDGET_MS + worstInFlightMs + tailMs < 600_000,
      "budget + one worst announcement overruns the 600s Pub/Sub ack deadline",
    );
  });
});

describe("normalizeBseChainDepth / normalizeBseResumeIndex", () => {
  it("reads anything that is not a finite non-negative number as 0", () => {
    for (const bad of [undefined, null, "3", NaN, Infinity, -1, {}, []]) {
      assert.equal(normalizeBseChainDepth(bad), 0, String(bad));
      assert.equal(normalizeBseResumeIndex(bad), 0, String(bad));
    }
  });

  it("a forged large depth ENDS the chain rather than wrapping it", () => {
    assert.equal(normalizeBseChainDepth(1e9), BSE_MAX_CHAIN_DEPTH);
    assert.equal(
      shouldChainBseAnnouncements({
        chainDepth: normalizeBseChainDepth(1e9),
        remaining: 10_000,
        consumed: 10,
        rateLimited: false,
        fetchFailed: false,
      }).chain,
      false,
    );
  });

  it("a resumeIndex past the end is NOT clamped", () => {
    // Clamping to the last element would re-process one announcement forever;
    // an out-of-range index yields an empty slice, which is a correct no-op.
    assert.equal(normalizeBseResumeIndex(9_999), 9_999);
    assert.equal(normalizeBseResumeIndex(3.7), 3);
  });
});

describe("shouldChainBseAnnouncements", () => {
  const base = {
    chainDepth: 0,
    remaining: 500,
    consumed: 100,
    rateLimited: false,
    fetchFailed: false,
  };

  it("chains when there is work left and the link made progress", () => {
    assert.deepEqual(shouldChainBseAnnouncements(base), {
      chain: true,
      reason: "chain",
    });
  });

  it("TERMINATION: the depth bound holds against unbounded work", () => {
    // The proof, driven rather than asserted: an adversarial environment that
    // always reports more work and always reports progress still ends.
    let depth = 0;
    let links = 0;
    for (let i = 0; i < 1000; i++) {
      const { chain } = shouldChainBseAnnouncements({
        ...base,
        chainDepth: depth,
        remaining: 1_000_000,
        consumed: 1,
      });
      if (!chain) break;
      depth++;
      links++;
    }
    assert.ok(
      links < BSE_MAX_CHAIN_DEPTH,
      `the chain ran ${links} links against a ceiling of ${BSE_MAX_CHAIN_DEPTH}`,
    );
    assert.equal(
      shouldChainBseAnnouncements({ ...base, chainDepth: depth }).reason,
      "depth-exhausted",
    );
  });

  it("refuses on a 429 — the limiter is PER RUN", () => {
    assert.deepEqual(
      shouldChainBseAnnouncements({ ...base, rateLimited: true }),
      { chain: false, reason: "rate-limited" },
    );
  });

  it("refuses when the index walk itself failed", () => {
    assert.deepEqual(
      shouldChainBseAnnouncements({ ...base, fetchFailed: true }),
      { chain: false, reason: "fetch-failed" },
    );
  });

  it("refuses a drained window", () => {
    assert.deepEqual(shouldChainBseAnnouncements({ ...base, remaining: 0 }), {
      chain: false,
      reason: "window-drained",
    });
  });

  it("refuses when the link consumed NOTHING — the runaway shape", () => {
    // A follow-up would resume at the identical index and do the identical
    // nothing. Same class as `stock-document-extract`'s `leftPending` guard.
    assert.deepEqual(shouldChainBseAnnouncements({ ...base, consumed: 0 }), {
      chain: false,
      reason: "no-progress",
    });
  });
});

describe("bseCompactToIsoDate", () => {
  it("converts BSE's compact window bounds", () => {
    assert.equal(bseCompactToIsoDate("20260830"), "2026-08-30");
    assert.equal(bseCompactToIsoDate("20260101"), "2026-01-01");
  });

  it("returns null rather than guessing at an unrecognised shape", () => {
    // The caller then falls back to its own resolved dates instead of
    // publishing a window BSE will reject.
    for (const bad of [
      "",
      "2026-08-30",
      "202608",
      "2026083",
      "20261330",
      "20260800",
    ]) {
      assert.equal(bseCompactToIsoDate(bad), null, bad);
    }
  });
});
