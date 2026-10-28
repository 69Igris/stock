/**
 * UNIT TEST — MONEY-1114 (Data Engine P10 F2): making ANNUAL filings reachable.
 *
 * Three separate defects are pinned here, and all three were INVISIBLE in
 * production — no error, no counter, no log line:
 *
 *  1. `xbrl-sync` hardcoded `?period=Quarterly&` on the legacy index, so annual
 *     filings were never REQUESTED. All 2,152 prod rows were QUARTERLY.
 *  2. `inferPeriodType`'s `>=150 → HALF_YEARLY` band swallowed the 274-day
 *     nine-month year-to-date column, storing nine months labelled six.
 *  3. `detectTruncation` compared the LAST PAGE's record count against the
 *     WHOLE QUERY's `totalCount`, so every completed multi-page walk reported
 *     itself truncated. Prod printed "INDEX MAY BE TRUNCATED" nightly.
 *
 * Every fixture is REAL bytes from the live NSE API on 2026-08-19, kept
 * verbatim (the two `.trimmed.` ones drop RECORDS; each surviving record is
 * byte-for-byte as served). Hand-built shapes cannot test any of this, because
 * every trap is a fact about the exact strings and numbers NSE returns.
 *
 *   nse-legacy-index-annual-2019-05.trimmed.json
 *       6 records from `period=Annual&from_date=01-05-2019&to_date=31-05-2019`
 *       (1,539 in the live response). Carries RELIANCE and ITC — whose `xbrl`
 *       URLs are IDENTICAL to their `period=Quarterly` records — a stub URL,
 *       and SIEMENS, which files an October-September financial year.
 *   nse-legacy-index-quarterly-2019-05.trimmed.json
 *       4 records from the SAME window under `period=Quarterly` (1,467 live).
 *       RELIANCE and ITC again, for the shared-URL proof.
 *   nse-legacy-index-period-not-accepted.json
 *       The VERBATIM 2-byte response to `period=Half-Yearly`. Not an error: a
 *       completely successful read of a value the column never holds.
 *   nse-legacy-index-null-period-2019-05.trimmed.json
 *       3 records whose `period` is JSON null. These are reachable ONLY by
 *       sending an unrecognised `period` value, which returns the union of
 *       everything — see the module header.
 *   nse-integrated-index-2025-06-size10-page1.json
 *       VERBATIM `size=10&page=1` for 01-06-2025 → 30-06-2025: 10 records,
 *       `totalCount: 295`, `page: 0` echoed. The "there IS more" case.
 *   nse-integrated-index-2025-06-size10-page30-last.json
 *       VERBATIM `page=30`: 5 records (295 = 29x10 + 5), `totalCount: 295`,
 *       `page: 29`. The LAST page of a COMPLETE walk — the exact shape that
 *       produced the nightly false alarm.
 *   nse-integrated-index-2025-06-default-cap-20.json
 *       VERBATIM with NO `size`: 20 records, `size: 20`, `page: -1`,
 *       `totalCount: 295`. The genuine cap.
 *   reliance-q4fy19-consolidated-indas-2018-03-31.xml
 *       RELIANCE's Q4-FY19 consolidated filing, whole. Declares `OneD`
 *       (2019-01-01..2019-03-31) and `FourD` (2018-04-01..2019-03-31); FourD
 *       carries `RevenueFromOperations` 5,810,200,000,000 — the published
 *       ₹5,81,020 Cr FY19 consolidated revenue.
 *   nagafert-q4fy25-consolidated-integrated-2025-01-31.xml
 *       The same shape in the INTEGRATED taxonomy, and the balance-sheet
 *       counter-example: it has `OneI` and no `FourI`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildFilingIndexPath,
  classifyFilingPeriod,
  detectTruncation,
  indexSupportsPaging,
  parseFilingIndexPage,
  parseXbrlDocument,
  LEGACY_PERIOD_PARAMS,
  type FilingIndexPage,
} from "../../src/market-data/index";

const INDEX_FIXTURES = join(
  import.meta.dirname,
  "..",
  "fixtures",
  "xbrl-index",
);
const XML_FIXTURES = join(import.meta.dirname, "..", "fixtures", "xbrl");

const loadIndex = (name: string): unknown =>
  JSON.parse(readFileSync(join(INDEX_FIXTURES, name), "utf-8")) as unknown;
const loadXml = (name: string): string =>
  readFileSync(join(XML_FIXTURES, name), "utf-8");

const RELIANCE_Q4FY19 = "reliance-q4fy19-consolidated-indas-2018-03-31.xml";
const NAGAFERT_Q4FY25 =
  "nagafert-q4fy25-consolidated-integrated-2025-01-31.xml";

/* -------------------------------------------------------------------------- */
/* 1. The legacy index's period vocabulary                                    */
/* -------------------------------------------------------------------------- */

describe("MONEY-1114 — the legacy index's `period` parameter", () => {
  it("has exactly TWO accepted values, quarter first", () => {
    // Measured 2026-08-19: Quarterly 1,467 records, Annual 1,539, and an
    // UNRECOGNISED value 3,012 = 1,467 + 1,539 + 6 null-period records. The
    // union proves the vocabulary is closed at two.
    assert.deepEqual([...LEGACY_PERIOD_PARAMS], ["Quarterly", "Annual"]);
  });

  it("puts `period` in the LEGACY path and NEVER in the modern one", () => {
    const legacy = buildFilingIndexPath({
      era: "legacy",
      from: "01-05-2019",
      to: "31-05-2019",
      size: 500,
      page: 1,
      period: "Annual",
    });
    assert.ok(
      legacy.startsWith("/api/corporates-financial-results?period=Annual&"),
      legacy,
    );
    assert.ok(legacy.includes("index=equities"), legacy);
    assert.ok(legacy.includes("from_date=01-05-2019"), legacy);

    const modern = buildFilingIndexPath({
      era: "integrated",
      from: "01-06-2025",
      to: "30-06-2025",
      size: 500,
      page: 1,
      period: null,
    });
    assert.ok(modern.startsWith("/api/integrated-filing-results?"), modern);
    // Measured: the integrated index returns byte-identical bodies for
    // period=Annual, period=Quarterly, period=Zzzz and no period at all. Sending
    // one would be inert, but it would also read as though it did something.
    assert.ok(!modern.includes("period="), modern);
  });

  it("builds the Quarterly path the pre-1114 job used, unchanged", () => {
    // The nightly quarterly behaviour must not regress. This is that exact URL.
    const p = buildFilingIndexPath({
      era: "legacy",
      from: "01-11-2024",
      to: "08-11-2024",
      size: 500,
      page: 1,
      period: "Quarterly",
    });
    assert.equal(
      p,
      "/api/corporates-financial-results?period=Quarterly&index=equities" +
        "&from_date=01-11-2024&to_date=08-11-2024&size=500&page=1",
    );
  });

  it("reads an ANNUAL record's flags — `Cumulative`, not Y/N", () => {
    const page = parseFilingIndexPage(
      loadIndex("nse-legacy-index-annual-2019-05.trimmed.json"),
      "legacy",
    );
    assert.ok(page !== null);
    const reliance = page.entries.find((e) => e.symbol === "RELIANCE");
    assert.ok(reliance, "RELIANCE must be in the annual fixture");
    assert.equal(reliance.periodType, "ANNUAL");
    // NSE flags EVERY annual record "Cumulative" — 1,539 of 1,539 live. The
    // index parser reports it faithfully; `classifyFilingPeriod` is what decides
    // what we STORE. See its own test below.
    assert.equal(reliance.cumulative, true);
    // The record is "Non-Consolidated" — and "Non-Consolidated" CONTAINS
    // "Consolidated", so a substring test in the wrong order would call this
    // consolidated. It does not.
    assert.equal(reliance.basis, "STANDALONE");
    assert.equal(
      reliance.quarterEnd?.toISOString().slice(0, 10),
      "2019-03-31",
      "toDate is the period END",
    );
  });

  it("carries a filer whose financial year is NOT April-March", () => {
    const page = parseFilingIndexPage(
      loadIndex("nse-legacy-index-annual-2019-05.trimmed.json"),
      "legacy",
    );
    assert.ok(page !== null);
    const siemens = page.entries.find((e) => e.symbol === "SIEMENS");
    assert.ok(siemens, "SIEMENS must be in the fixture");
    // 01-Oct-2018 → 30-Sep-2019. This is why the period type is derived from
    // the SPAN and never from the month: a month rule would call this a quarter.
    assert.equal(siemens.quarterEnd?.toISOString().slice(0, 10), "2019-09-30");
  });

  it("counts the stub URL as stubbed, not rejected", () => {
    const page = parseFilingIndexPage(
      loadIndex("nse-legacy-index-annual-2019-05.trimmed.json"),
      "legacy",
    );
    assert.ok(page !== null);
    assert.equal(page.listed, 6);
    assert.equal(page.stubbed, 1, "one `/corporate/xbrl/-` record");
    assert.equal(page.rejected.length, 0);
    assert.equal(page.entries.length, 5);
  });

  it("reads an unaccepted period value as an EMPTY read, never a failure", () => {
    const payload = loadIndex("nse-legacy-index-period-not-accepted.json");
    assert.deepEqual(payload, [], "the verbatim 2-byte response");
    const page = parseFilingIndexPage(payload, "legacy");
    // `null` would mean "unreadable". This is a successful read of nothing —
    // the distinction every silent no-op in this repo has turned on.
    assert.notEqual(page, null);
    assert.equal(page?.listed, 0);
    assert.equal(page?.entries.length, 0);
    assert.equal(page?.total, null, "the legacy index has no envelope");
  });

  it("keeps the null-period records readable (only an unknown value returns them)", () => {
    const page = parseFilingIndexPage(
      loadIndex("nse-legacy-index-null-period-2019-05.trimmed.json"),
      "legacy",
    );
    assert.ok(page !== null);
    assert.equal(page.listed, 3);
    for (const e of page.entries) {
      // `period: null` in the payload must NOT become a confident type.
      assert.equal(e.periodType, null);
    }
  });

  it("lists the SAME document under both periods — hence the dedupe", () => {
    const annual = parseFilingIndexPage(
      loadIndex("nse-legacy-index-annual-2019-05.trimmed.json"),
      "legacy",
    );
    const quarterly = parseFilingIndexPage(
      loadIndex("nse-legacy-index-quarterly-2019-05.trimmed.json"),
      "legacy",
    );
    assert.ok(annual !== null && quarterly !== null);
    const qUrls = new Set(quarterly.entries.map((e) => e.xbrlUrl));
    const shared = annual.entries.filter((e) => qUrls.has(e.xbrlUrl));
    assert.ok(
      shared.length >= 2,
      "RELIANCE and ITC appear under BOTH periods with the same xbrl URL",
    );
    // …and the index's OWN period word differs between the two listings of one
    // document. That is exactly why the document, not the index, decides.
    for (const a of shared) {
      // Annotated explicitly: without it tsc reports TS7022 (`q` implicitly
      // any, referenced in its own initializer) because the element type is
      // being inferred through `entries` inside the same loop that consumes it.
      const q: (typeof quarterly.entries)[number] | undefined =
        quarterly.entries.find((e) => e.xbrlUrl === a.xbrlUrl);
      assert.equal(a.periodType, "ANNUAL");
      assert.equal(q?.periodType, "QUARTERLY");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Which index paginates                                                   */
/* -------------------------------------------------------------------------- */

describe("MONEY-1114 — only the modern index paginates", () => {
  it("says legacy=no, integrated=yes", () => {
    // Measured: legacy page=1/2/3 and no-paging all returned byte-identical
    // 1,119,778-byte bodies with the same 1,467 seqNumbers in the same order.
    assert.equal(indexSupportsPaging("legacy"), false);
    assert.equal(indexSupportsPaging("integrated"), true);
  });

  it("proves the modern pages are disjoint and 1-based on the wire", () => {
    const p1 = loadIndex(
      "nse-integrated-index-2025-06-size10-page1.json",
    ) as Record<string, unknown>;
    const p30 = loadIndex(
      "nse-integrated-index-2025-06-size10-page30-last.json",
    ) as Record<string, unknown>;
    // Requested page=1 → echoed 0; requested page=30 → echoed 29.
    assert.equal(p1.page, 0);
    assert.equal(p30.page, 29);
    assert.equal(p1.totalCount, 295);
    assert.equal(p30.totalCount, 295);
    const ids1 = new Set(
      (p1.data as Record<string, unknown>[]).map((r) => String(r.seq_Id)),
    );
    for (const r of p30.data as Record<string, unknown>[]) {
      assert.ok(
        !ids1.has(String(r.seq_Id)),
        "page 1 and page 30 must not overlap",
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Truncation — the warning that cried wolf                                */
/* -------------------------------------------------------------------------- */

describe("MONEY-1114 — detectTruncation against a WALK, not a page", () => {
  const lastPage = (): FilingIndexPage => {
    const p = parseFilingIndexPage(
      loadIndex("nse-integrated-index-2025-06-size10-page30-last.json"),
      "integrated",
    );
    assert.ok(p !== null);
    return p;
  };

  it("does NOT flag the short last page of a COMPLETE walk", () => {
    const page = lastPage();
    assert.equal(page.listed, 5);
    assert.equal(page.total, 295);
    const verdict = detectTruncation(page, {
      pageSize: 10,
      windowDays: 30,
      // 29 full pages of 10 plus this one.
      collected: 295,
    });
    assert.equal(
      verdict.truncated,
      false,
      "295 collected of 295 reported is a complete walk",
    );
  });

  it("STILL flags it when the walk is genuinely short", () => {
    // Same page, but the caller only ever collected 5 — a walk that stopped
    // after one page. That IS truncated and must still be caught.
    const verdict = detectTruncation(lastPage(), {
      pageSize: 10,
      windowDays: 30,
      collected: 5,
    });
    assert.equal(verdict.truncated, true);
    assert.match(verdict.reason, /totalCount=295/);
  });

  it("flags a first page that is full and short of the total", () => {
    const page = parseFilingIndexPage(
      loadIndex("nse-integrated-index-2025-06-size10-page1.json"),
      "integrated",
    );
    assert.ok(page !== null);
    const verdict = detectTruncation(page, {
      pageSize: 10,
      windowDays: 30,
      collected: 10,
    });
    assert.equal(verdict.truncated, true);
    assert.match(verdict.reason, /totalCount=295/);
  });

  it("still catches the 20-record default cap", () => {
    // The headline trap of this API. It must survive the `collected` change.
    const page = parseFilingIndexPage(
      loadIndex("nse-integrated-index-2025-06-default-cap-20.json"),
      "integrated",
    );
    assert.ok(page !== null);
    assert.equal(page.listed, 20);
    assert.equal(page.serverPageSize, 20);
    assert.equal(page.total, 295);
    const verdict = detectTruncation(page, {
      pageSize: 500,
      windowDays: 30,
      collected: 20,
    });
    assert.equal(verdict.truncated, true);
  });

  it("defaults `collected` to this page — the pre-1114 behaviour", () => {
    // Omitting the option must not change any existing caller's verdict.
    const page = lastPage();
    const withDefault = detectTruncation(page, {
      pageSize: 10,
      windowDays: 30,
    });
    const explicit = detectTruncation(page, {
      pageSize: 10,
      windowDays: 30,
      collected: page.listed,
    });
    assert.deepEqual(withDefault, explicit);
  });

  it("does not let a full unpaged legacy body read as truncated", () => {
    // The legacy index answers a whole window in one body — 1,467 records is
    // the ANSWER, not a page. `Infinity` is how the caller disables the
    // "a full page means there is more" rule where there are no pages.
    const page = parseFilingIndexPage(
      loadIndex("nse-legacy-index-annual-2019-05.trimmed.json"),
      "legacy",
    );
    assert.ok(page !== null);
    const verdict = detectTruncation(page, {
      pageSize: Number.POSITIVE_INFINITY,
      windowDays: 30,
      collected: page.listed,
    });
    // The structural rule may still fire on a 6-record fixture; what must NOT
    // fire is the page-size rule.
    assert.ok(
      !/requested size/.test(verdict.reason),
      `page-size rule must be disabled: ${verdict.reason}`,
    );
  });

  /**
   * The walk PROD actually ran, with prod's own numbers — MONEY-1220.
   *
   * The cases above prove the rule on a 10-per-page fixture. This one replays
   * the shape from the log line that was still firing nightly, so the incident
   * of record is pinned rather than paraphrased. From `xbrl-sync-daily-prod`,
   * 2026-08-18, window 11-08-2026 → 18-08-2026:
   *
   *     listed: 1792 ... indexTruncationSuspected: [
   *       'integrated p4: the server reports totalCount=1792 but returned 292
   *        (size=500) — page for the rest' ]
   *
   * `listed` equals `totalCount` in that same object: the walk was COMPLETE and
   * the detector said otherwise, because "returned 292" is the LAST PAGE. Note
   * the reason string is the tell — the fixed detector says "but the walk has",
   * so any environment still logging "but returned" is running pre-#329 code
   * rather than hitting a second defect.
   *
   * The page counts are overridden onto a real parsed page: `detectTruncation`
   * reads `total`/`listed`/`serverPageSize` plus `collected`, and the entries
   * only matter to the structural rule, which is skipped outright once the
   * server's own count says complete.
   */
  it("replays the 2026-08-18 prod walk: 500/500/500/292 of 1792 is COMPLETE", () => {
    const base = lastPage();
    const at = (listed: number): FilingIndexPage => ({
      ...base,
      listed,
      total: 1792,
      serverPageSize: 500,
    });
    const opts = { pageSize: 500, windowDays: 7 };

    // Pages 1-3 are full and short of the total: more to come, which is why the
    // caller keeps paging. Reported only if the loop ended, which it does not.
    for (const [page, collected] of [
      [1, 500],
      [2, 1000],
      [3, 1500],
    ] as const) {
      assert.equal(
        detectTruncation(at(500), { ...opts, collected }).truncated,
        true,
        `page ${page} of the prod walk still has ${1792 - collected} to fetch`,
      );
    }

    // Page 4 — the short one prod warned on. 1792 collected of 1792 reported.
    const final = detectTruncation(at(292), { ...opts, collected: 1792 });
    assert.equal(
      final.truncated,
      false,
      `the walk collected every record the server declared: ${final.reason}`,
    );
    assert.equal(final.reason, "");
  });

  it("would STILL have flagged the prod walk had a page actually been lost", () => {
    // The false-negative guard for the case above. Same final page, but page 3
    // failed and the walk carries 1,292 — that is a real gap and must be loud.
    const short = detectTruncation(
      { ...lastPage(), listed: 292, total: 1792, serverPageSize: 500 },
      { pageSize: 500, windowDays: 7, collected: 1292 },
    );
    assert.equal(short.truncated, true);
    assert.match(short.reason, /totalCount=1792 but the walk has 1292/);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. classifyFilingPeriod — the 274-day bug and the gaps                     */
/* -------------------------------------------------------------------------- */

describe("MONEY-1114 — classifyFilingPeriod", () => {
  it("classifies the four real spans", () => {
    for (const days of [89, 90, 91, 92]) {
      assert.deepEqual(classifyFilingPeriod(days), {
        periodType: "QUARTERLY",
        cumulative: false,
      });
    }
    for (const days of [180, 181, 182, 183]) {
      assert.deepEqual(classifyFilingPeriod(days), {
        periodType: "HALF_YEARLY",
        cumulative: true,
      });
    }
    for (const days of [272, 273, 274, 275]) {
      assert.deepEqual(classifyFilingPeriod(days), {
        periodType: "NINE_MONTH",
        cumulative: true,
      });
    }
    // 364, not 365: `days` is start-inclusive / end-exclusive, so
    // 2018-04-01 → 2019-03-31 is 364. 371 is a 53-week filer.
    for (const days of [364, 365, 366, 371]) {
      assert.deepEqual(classifyFilingPeriod(days), {
        periodType: "ANNUAL",
        cumulative: false,
      });
    }
  });

  it("THE BUG: 274 days is NINE_MONTH, never HALF_YEARLY", () => {
    // The April-December year-to-date column. The old ladder
    // (>=300 ANNUAL, >=150 HALF_YEARLY, else QUARTERLY) called it HALF_YEARLY,
    // storing nine months of revenue labelled six, with nothing to say so.
    const c = classifyFilingPeriod(274);
    assert.equal(c?.periodType, "NINE_MONTH");
    assert.notEqual(c?.periodType, "HALF_YEARLY");
  });

  it("REFUSES a span that matches no band, rather than rounding", () => {
    for (const days of [
      0, // degenerate
      40, // a stub period — was QUARTERLY
      120, // was QUARTERLY
      200, // was HALF_YEARLY
      300, // was ANNUAL
      425, // a 14-month transition year — was ANNUAL
      730, // two years
    ]) {
      assert.equal(
        classifyFilingPeriod(days),
        null,
        `${days}d must be refused, not bucketed`,
      );
    }
  });

  it("refuses non-finite days instead of losing the comparison", () => {
    // NaN loses every `>=` silently, which would fall through to the last
    // branch of any ladder.
    assert.equal(classifyFilingPeriod(Number.NaN), null);
    assert.equal(classifyFilingPeriod(Number.POSITIVE_INFINITY), null);
    assert.equal(classifyFilingPeriod(Number.NEGATIVE_INFINITY), null);
  });

  it("marks a full financial year NON-cumulative, unlike NSE's own flag", () => {
    // NSE says "Cumulative" for every annual record; we store false because a
    // complete financial year IS the period its row claims. `cumulative` is in
    // `XbrlFiling`'s unique key, so this single decision is what keeps the
    // ingest leg and the annual leg from writing two rows per company-year.
    assert.equal(classifyFilingPeriod(364)?.cumulative, false);
    // …while a PARTIAL accumulation is flagged.
    assert.equal(classifyFilingPeriod(274)?.cumulative, true);
    assert.equal(classifyFilingPeriod(182)?.cumulative, true);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. The period selector on parseXbrlDocument                                */
/* -------------------------------------------------------------------------- */

describe("MONEY-1114 — parseXbrlDocument's period selector", () => {
  it("is a NO-OP when omitted, on every committed XBRL fixture", () => {
    // The hard contract: this option must not have changed any existing
    // caller's answer. `undefined` and an absent options object must both
    // reproduce the pre-1114 result exactly.
    const fixtures = [
      RELIANCE_Q4FY19,
      NAGAFERT_Q4FY25,
      "glaxo-q2fy25-standalone-indas-2020-03-31.xml",
      "icicibank-q2fy25-standalone-banking-2019-09-30.xml",
      "bhartiartl-q2fy20-consolidated-indas-2018-03-31.xml",
      "infy-q1fy27-standalone-indas-2026-01-31.xml",
      "ndgl-q1fy27-consolidated-nbfc-2026-01-31.xml",
      "aifl-q1fy27-standalone-nonindas-2026-01-31.xml",
      "cipla-q3fy26-standalone-indas-2025-01-31.xml",
      "finopb-q1fy27-standalone-banking-2026-01-31.xml",
    ];
    for (const name of fixtures) {
      const xml = loadXml(name);
      const bare = parseXbrlDocument(xml);
      const empty = parseXbrlDocument(xml, {});
      const undef = parseXbrlDocument(xml, { periodContextRef: undefined });
      assert.deepEqual(empty, bare, name);
      assert.deepEqual(undef, bare, name);
    }
  });

  it("reproduces `values` EXACTLY when pointed at the primary contextRef", () => {
    // The anti-drift property. Selecting the period the primary rule would have
    // chosen anyway must produce the identical parse — if it ever does not, the
    // selector and the ranking have diverged.
    for (const name of [
      RELIANCE_Q4FY19,
      NAGAFERT_Q4FY25,
      "glaxo-q2fy25-standalone-indas-2020-03-31.xml",
      "icicibank-q2fy25-standalone-banking-2019-09-30.xml",
      "bhartiartl-q2fy20-consolidated-indas-2018-03-31.xml",
      "infy-q1fy27-standalone-indas-2026-01-31.xml",
      "ndgl-q1fy27-consolidated-nbfc-2026-01-31.xml",
      "cipla-q3fy26-standalone-indas-2025-01-31.xml",
    ]) {
      const xml = loadXml(name);
      const bare = parseXbrlDocument(xml);
      assert.equal(bare.kind, "financials", name);
      if (bare.kind !== "financials") continue;
      const selected = parseXbrlDocument(xml, {
        periodContextRef: bare.financials.period.contextRef,
      });
      assert.deepEqual(selected, bare, `${name}: selector must be identity`);
    }
  });

  it("reads RELIANCE's FULL FINANCIAL YEAR out of its Q4 document", () => {
    const xml = loadXml(RELIANCE_Q4FY19);
    const quarter = parseXbrlDocument(xml);
    assert.equal(quarter.kind, "financials");
    if (quarter.kind !== "financials") return;

    // The primary is the QUARTER — the ranking is unchanged.
    assert.equal(quarter.financials.period.contextRef, "OneD");
    assert.equal(quarter.financials.period.start, "2019-01-01");
    assert.equal(quarter.financials.period.end, "2019-03-31");
    assert.equal(quarter.financials.period.days, 89);

    // …and the YEAR is in otherPeriods, with DATES ONLY. This is the fact that
    // makes a database-side projection impossible: no figures here.
    assert.equal(quarter.financials.otherPeriods.length, 1);
    const other = quarter.financials.otherPeriods[0]!;
    assert.equal(other.contextRef, "FourD");
    assert.equal(other.days, 364);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(other, "values"),
      "otherPeriods entries carry no values — that is the whole problem",
    );

    const year = parseXbrlDocument(xml, { periodContextRef: "FourD" });
    assert.equal(year.kind, "financials");
    if (year.kind !== "financials") return;
    assert.equal(year.financials.period.start, "2018-04-01");
    assert.equal(year.financials.period.end, "2019-03-31");
    assert.equal(year.financials.period.days, 364);
    assert.equal(classifyFilingPeriod(364)?.periodType, "ANNUAL");

    // The published FY2019 consolidated revenue: ₹5,81,020 crore.
    assert.equal(
      year.financials.values.revenueFromOperations,
      5_810_200_000_000,
    );
    // …and it is NOT the quarter's number, which is the failure this whole
    // mechanism exists to avoid.
    assert.equal(
      quarter.financials.values.revenueFromOperations,
      1_416_340_000_000,
    );
    assert.notEqual(
      year.financials.values.revenueFromOperations,
      quarter.financials.values.revenueFromOperations,
    );

    // The year's OWN otherPeriods now hold the quarter — the ranking is
    // preserved, only the pointer moved.
    assert.deepEqual(
      year.financials.otherPeriods.map((p) => p.contextRef),
      ["OneD"],
    );
  });

  it("REFUSES an unknown contextRef — never falls back to the primary", () => {
    // THE safety property the annual leg relies on. Substituting the quarter's
    // numbers under an ANNUAL label would be a wrong figure that looks right,
    // in a table whose unique key would then make it the incumbent.
    const xml = loadXml(RELIANCE_Q4FY19);
    const outcome = parseXbrlDocument(xml, {
      periodContextRef: "NoSuchContext",
    });
    assert.equal(outcome.kind, "no-period");
    assert.notEqual(outcome.kind, "financials");
  });

  it("REFUSES a dimensioned segment context", () => {
    // RELIANCE declares `FourReportableSegmentRevenue01D` etc. A segment column
    // is not a reporting period, and asking for one must not yield a filing.
    const xml = loadXml(RELIANCE_Q4FY19);
    assert.ok(
      xml.includes('contextRef="FourReportableSegmentRevenue01D"'),
      "fixture must actually contain the segment context",
    );
    const outcome = parseXbrlDocument(xml, {
      periodContextRef: "FourReportableSegmentRevenue01D",
    });
    assert.equal(outcome.kind, "no-period");
  });

  it("carries the year through the INTEGRATED taxonomy too", () => {
    const xml = loadXml(NAGAFERT_Q4FY25);
    const quarter = parseXbrlDocument(xml);
    assert.equal(quarter.kind, "financials");
    if (quarter.kind !== "financials") return;
    assert.equal(quarter.financials.taxonomy.dialect, "in-capmkt");
    assert.equal(quarter.financials.period.contextRef, "OneD");

    const year = parseXbrlDocument(xml, { periodContextRef: "FourD" });
    assert.equal(year.kind, "financials");
    if (year.kind !== "financials") return;
    assert.equal(year.financials.period.start, "2024-04-01");
    assert.equal(year.financials.period.end, "2025-03-31");
    assert.equal(year.financials.period.days, 364);
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The BALANCE SHEET era boundary                                          */
/* -------------------------------------------------------------------------- */

describe("MONEY-1114 — where the balance sheet actually is", () => {
  it("LEGACY in-bse-fin filings carry NO balance sheet at all", () => {
    // This is the measurement that bounds every equity-based ratio (ROCE,
    // D/E, P/B, interest coverage) to the integrated era. It is NOT a
    // "the annual column has it" situation: the tags are absent from the
    // ENTIRE document, on every context.
    const xml = loadXml(RELIANCE_Q4FY19);
    const quarter = parseXbrlDocument(xml);
    assert.equal(quarter.kind, "financials");
    if (quarter.kind !== "financials") return;
    assert.equal(quarter.financials.balanceSheetDate, null);
    assert.equal(quarter.financials.balanceSheetSource, null);
    for (const concept of [
      "totalAssets",
      "totalEquity",
      "borrowingsCurrent",
      "cashAndCashEquivalents",
    ] as const) {
      assert.equal(
        quarter.financials.values[concept],
        undefined,
        `${concept} must be ABSENT (not zero) in the legacy taxonomy`,
      );
    }

    // …and selecting the ANNUAL column does not conjure one.
    const year = parseXbrlDocument(xml, { periodContextRef: "FourD" });
    assert.equal(year.kind, "financials");
    if (year.kind !== "financials") return;
    assert.equal(year.financials.balanceSheetDate, null);
    assert.equal(year.financials.values.totalAssets, undefined);
  });

  it("INTEGRATED filings do carry one, and the annual row inherits it", () => {
    const xml = loadXml(NAGAFERT_Q4FY25);
    const quarter = parseXbrlDocument(xml);
    assert.equal(quarter.kind, "financials");
    if (quarter.kind !== "financials") return;
    assert.equal(quarter.financials.balanceSheetDate, "2025-03-31");
    assert.equal(quarter.financials.balanceSheetSource, "column");
    assert.equal(quarter.financials.values.totalAssets, 4_686_776_000);

    // The document declares `OneI` and NO `FourI`, so the annual column cannot
    // match by the `D`→`I` convention. It falls back to the instant that lands
    // on its period end — the SAME 2025-03-31 balance sheet, which is correct:
    // a year-end balance sheet does not depend on which duration column you
    // read it beside. The weaker provenance is recorded rather than hidden.
    assert.ok(!xml.includes('<xbrli:context id="FourI"'), "no FourI context");
    const year = parseXbrlDocument(xml, { periodContextRef: "FourD" });
    assert.equal(year.kind, "financials");
    if (year.kind !== "financials") return;
    assert.equal(year.financials.balanceSheetDate, "2025-03-31");
    assert.equal(year.financials.balanceSheetSource, "date");
    assert.equal(year.financials.values.totalAssets, 4_686_776_000);
  });
});
