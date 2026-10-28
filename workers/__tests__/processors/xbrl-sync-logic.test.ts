/**
 * UNIT TEST — `xbrl-sync` run health (MONEY-1200).
 *
 * ## The defect
 *
 * Measured on prod 2026-08-14, from one run's own result object:
 *
 *     listed: 1866   downloaded: 1500   unparseable: 1499   fetchFailed: 1
 *     written: 0     skippedExisting: 0  stubbed: 0   rejected: 0   noPeriod: 0
 *     ok: true
 *
 * `ok` was initialised `true` and only ever cleared when the INDEX was
 * unreadable, so every document downstream could fail without touching it.
 * `xbrl_filings` stayed empty for months while the daily log said success.
 *
 * Every block below names the silent wrong answer it prevents, because the
 * threshold has two ways to be useless — too tight and it fires on healthy
 * runs until someone mutes it, too loose and it misses the failure it exists
 * for — and both failure modes look like a passing test.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  XbrlDocumentOutcome,
  FilingIndexEntry,
} from "@usemoney/core/market-data";
import { parseFilingIndexPage } from "@usemoney/core/market-data";
import {
  judgeXbrlParseHealth,
  bucketForOutcome,
  isRetriableFailure,
  archiveDayForFiling,
  pickAnnualCompanion,
  orderFilingsForWrite,
  compareFilingWriteOrder,
  filingWriteTimestamp,
  downloadBudgetAfterIndexing,
  MAX_NOT_UNDERSTOOD_SHARE,
  MIN_READABLE_FOR_RATIO,
  type XbrlParseTally,
  isNonFinancialFilingUrl,
  erasForWindow,
  LEGACY_FINANCIALS_OVERLAP_END,
  candidateArchiveKeysForFiling,
  XBRL_FEED_SLUG,
} from "../../src/processors/xbrl-sync-logic";

/** A tally with everything zero, so each case states only what it varies. */
function tally(over: Partial<XbrlParseTally> = {}): XbrlParseTally {
  return {
    downloaded: 0,
    fetchFailed: 0,
    nonFinancial: 0,
    unparseable: 0,
    unknownTaxonomy: 0,
    noPeriod: 0,
    ...over,
  };
}

describe("bucketForOutcome — which counter a parse outcome moves", () => {
  // Mis-wiring ONE arm re-creates the defect in a form no parser test can see:
  // the parser would be correct and the REPORT would lie. These are the two
  // arms that matter, so they are asserted as behaviour, not as a table dump.
  it("routes governance to the HEALTHY counter, never to unparseable", () => {
    assert.equal(bucketForOutcome("non-financial"), "nonFinancial");
    assert.notEqual(bucketForOutcome("non-financial"), "unparseable");
  });

  it("routes BOTH unknown shapes to the same failure counter", () => {
    // A namespace we were never taught and an entry point under a namespace we
    // were are the same failure at different depths. Splitting them here would
    // let the threshold catch one and miss the other.
    assert.equal(bucketForOutcome("unknown-taxonomy"), "unknownTaxonomy");
    assert.equal(bucketForOutcome("unknown-entry-point"), "unknownTaxonomy");
  });

  it("gives `unmapped-family` a counter of its OWN, not either neighbour", () => {
    // MONEY-1220. General Insurance filings are recognised exactly and
    // deliberately not parsed, and BOTH neighbouring buckets would misreport
    // that. `unknownTaxonomy` claims we do not know what it is — a defect no
    // code change can clear, printed nightly. `nonFinancial` claims it carries
    // no numbers by design — false; GICRE's ₹1,922.04 Cr quarterly PAT is in
    // the document. A known gap needs a counter that says "known gap".
    assert.equal(bucketForOutcome("unmapped-family"), "unmappedFamily");
    assert.notEqual(bucketForOutcome("unmapped-family"), "unknownTaxonomy");
    assert.notEqual(bucketForOutcome("unmapped-family"), "nonFinancial");
  });

  it("keeps not-xbrl and no-period apart from the taxonomy failures", () => {
    assert.equal(bucketForOutcome("not-xbrl"), "unparseable");
    assert.equal(bucketForOutcome("no-period"), "noPeriod");
    assert.equal(bucketForOutcome("financials"), "financials");
  });

  // A new outcome kind added to the union without an arm here would silently
  // return undefined and increment nothing — a document that vanishes from
  // every counter, which is precisely how "understood nothing" looked like
  // "there was nothing". The compiler catches it via the exhaustive switch;
  // this asserts the union is fully enumerated at runtime too.
  it("has an arm for every outcome kind the parser can return", () => {
    const kinds: XbrlDocumentOutcome["kind"][] = [
      "financials",
      "non-financial",
      "unknown-taxonomy",
      "unknown-entry-point",
      "unmapped-family",
      "no-period",
      "not-xbrl",
    ];
    for (const k of kinds) {
      assert.ok(
        typeof bucketForOutcome(k) === "string",
        `no bucket for outcome kind ${k}`,
      );
    }
  });
});

describe("the observed production failure", () => {
  // THE case. If this ever passes as `ok`, the whole module is decoration.
  it("fails the run that downloaded 1,500 filings and understood none", () => {
    const h = judgeXbrlParseHealth(
      tally({ downloaded: 1500, fetchFailed: 1, unparseable: 1499 }),
    );
    assert.equal(h.ok, false);
    assert.equal(h.readable, 1499);
    assert.equal(h.notUnderstood, 1499);
    assert.ok(
      h.reason !== null && h.reason.length > 0,
      "a failure must say why",
    );
  });

  // The same run after MONEY-1200's parser fix, if the taxonomy were STILL
  // unknown: the counter moves from `unparseable` to `unknownTaxonomy` and the
  // verdict must not move with it. Splitting a counter for diagnosis must never
  // become a way of exempting half the failures from the guard.
  it("fails identically when the same 1,499 are counted as unknownTaxonomy", () => {
    const h = judgeXbrlParseHealth(
      tally({ downloaded: 1500, fetchFailed: 1, unknownTaxonomy: 1499 }),
    );
    assert.equal(h.ok, false);
    assert.equal(h.notUnderstood, 1499);
  });

  it("fails when the failures are spread across all three not-understood counters", () => {
    const h = judgeXbrlParseHealth(
      tally({
        downloaded: 600,
        unparseable: 200,
        unknownTaxonomy: 200,
        noPeriod: 200,
      }),
    );
    assert.equal(h.ok, false);
  });
});

describe("governance filings must not fail a healthy run", () => {
  // 29 of 500 records in a live window are governance filings, which carry no
  // financials by design. If they landed in the numerator, a completely
  // healthy earnings day would sit at ~6% permanently — close enough to any
  // sane threshold that the threshold has to be raised past it, which is how
  // the guard gets blunted into uselessness.
  it("a day that is 6% governance filings and 0% broken is ok", () => {
    const h = judgeXbrlParseHealth(
      tally({ downloaded: 500, nonFinancial: 29 }),
    );
    assert.equal(h.ok, true);
    assert.equal(h.notUnderstood, 0);
    assert.equal(h.ratio, 0);
  });

  // Governance filings are subtracted from the NUMERATOR, not the denominator:
  // they were read AND understood. Removing them from `readable` would shrink
  // the sample and inflate the ratio of any real failures beside them.
  it("counts governance filings as read, keeping them in the denominator", () => {
    const h = judgeXbrlParseHealth(
      tally({ downloaded: 100, nonFinancial: 90, unparseable: 5 }),
    );
    assert.equal(h.readable, 100);
    assert.equal(h.notUnderstood, 5);
    assert.equal(h.ok, true);
  });

  // An ALL-governance window is real: a quiet non-earnings week where the only
  // integrated filings are compliance reports. It understood everything.
  it("a window of nothing but governance filings is healthy, not empty", () => {
    const h = judgeXbrlParseHealth(tally({ downloaded: 40, nonFinancial: 40 }));
    assert.equal(h.ok, true);
    assert.equal(h.notUnderstood, 0);
  });
});

describe("transport failures are not parse failures", () => {
  // NSE indexes a filing before its XML is fetchable — measured 3 of 9 404s on
  // documents broadcast within the hour. Folding those into parse health makes
  // the guard fire on the exchange's publishing latency, which the trailing
  // window already heals tomorrow.
  it("404s and timeouts leave the denominator, not the numerator", () => {
    const h = judgeXbrlParseHealth(
      tally({ downloaded: 100, fetchFailed: 40, unparseable: 2 }),
    );
    assert.equal(h.readable, 60);
    assert.equal(h.notUnderstood, 2);
    assert.equal(h.ok, true);
  });

  // A run whose every download failed says nothing about the parser. Failing
  // it HERE would attribute an NSE outage to the concept table and send the
  // next investigation to the wrong module — the index/transport counters
  // carry that story.
  it("a run where nothing was readable is not judged on parse health", () => {
    const h = judgeXbrlParseHealth(tally({ downloaded: 80, fetchFailed: 80 }));
    assert.equal(h.readable, 0);
    assert.equal(h.ok, true);
    assert.equal(h.ratio, 0);
  });

  // The overlapping trailing window means a re-run legitimately downloads
  // nothing at all: everything is `skippedExisting`. A guard keyed on
  // `written > 0` would fire on this every single day until it was muted.
  it("a fully-skipped re-run is ok — it downloaded nothing to misunderstand", () => {
    const h = judgeXbrlParseHealth(tally({ downloaded: 0 }));
    assert.equal(h.ok, true);
    assert.equal(h.reason, null);
  });
});

describe("the threshold", () => {
  // A handful of malformed filings is the normal state of a feed produced by
  // thousands of filers' own generators. Failing on those trains everyone to
  // ignore the alert, and the next real taxonomy break arrives into a muted
  // channel.
  it("tolerates the ordinary trickle of individually broken filings", () => {
    const h = judgeXbrlParseHealth(tally({ downloaded: 470, unparseable: 6 }));
    assert.equal(h.ok, true);
    assert.ok(h.ratio < MAX_NOT_UNDERSTOOD_SHARE);
  });

  it("fires once a tenth of what was read is not understood", () => {
    const under = judgeXbrlParseHealth(
      tally({ downloaded: 100, unparseable: 10 }),
    );
    assert.equal(under.ok, true, "exactly at the limit is not over it");

    const over = judgeXbrlParseHealth(
      tally({ downloaded: 100, unparseable: 11 }),
    );
    assert.equal(over.ok, false);
    assert.ok(over.reason?.includes("11/100"));
  });

  // One parseable filing among 1,500 broken ones writes a row and satisfies
  // any `written > 0` guard, while being within a rounding error of total
  // failure. The ratio is what makes that impossible.
  it("one success among a thousand failures does NOT rescue the run", () => {
    const h = judgeXbrlParseHealth(
      tally({ downloaded: 1000, unparseable: 999 }),
    );
    assert.equal(h.ok, false);
  });
});

describe("the small-sample floor cannot become a blind spot", () => {
  // A quiet day can produce three filings, and one bad one out of three is
  // 33% — a red run caused by arithmetic rather than by a defect.
  it("does not fail a tiny window on one malformed filing", () => {
    const h = judgeXbrlParseHealth(tally({ downloaded: 3, unparseable: 1 }));
    assert.equal(h.ok, true);
    assert.ok(
      h.ratio > MAX_NOT_UNDERSTOOD_SHARE,
      "the ratio IS over the limit",
    );
    assert.ok(h.readable < MIN_READABLE_FOR_RATIO);
  });

  // …but "read some, understood NONE" is the defect's exact shape and must
  // fail at ANY size. Without this rule the floor is a hole: a catch-up run
  // over a narrow window — precisely what an operator runs while diagnosing —
  // would report success while understanding nothing.
  it("STILL fails a tiny window that understood nothing at all", () => {
    for (const n of [1, 2, 5, 19]) {
      const h = judgeXbrlParseHealth(tally({ downloaded: n, unparseable: n }));
      assert.equal(h.ok, false, `${n} readable, ${n} not understood`);
      assert.ok(h.reason?.includes("NONE"));
    }
  });

  // The total-failure rule must not swallow the ordinary case where the sample
  // is small AND partly fine.
  it("a tiny window that understood even one document is not a total failure", () => {
    const h = judgeXbrlParseHealth(tally({ downloaded: 5, unparseable: 4 }));
    assert.equal(h.ok, true);
    assert.equal(h.notUnderstood, 4);
  });

  it("a governance-only tiny window is understood, not a total failure", () => {
    const h = judgeXbrlParseHealth(tally({ downloaded: 2, nonFinancial: 2 }));
    assert.equal(h.ok, true);
  });
});

describe("isRetriableFailure — the response code is chosen by failure class", () => {
  // Making `ok` false is only half the fix. Left on the old blanket-500 route,
  // a DETERMINISTIC parse failure NACKs, and every redelivery re-downloads up
  // to 1,500 XMLs from NSE at 600 ms apart — a deterministic failure writes
  // nothing, so the `skippedExisting` short-circuit that normally makes a
  // re-run free never engages. The fix for a silent failure would have become
  // a retry storm against the exchange.
  it("does NOT retry a parse-health failure — the same bytes fail the same way", () => {
    assert.equal(
      isRetriableFailure({ ok: false, parseHealthFailure: "understood NONE" }),
      false,
    );
  });

  // The index being unreadable is a throttle, a challenge page or a transport
  // error, and the run gives up before downloading anything. Acking that
  // silently loses a day of filings that a single cheap retry would have got.
  it("DOES retry a transient failure, which costs one HTTP call", () => {
    assert.equal(
      isRetriableFailure({ ok: false, parseHealthFailure: null }),
      true,
    );
  });

  it("a healthy run is never a retry", () => {
    assert.equal(
      isRetriableFailure({ ok: true, parseHealthFailure: null }),
      false,
    );
    // Belt: even if a reason string somehow survives onto an ok run, `ok` wins.
    assert.equal(
      isRetriableFailure({ ok: true, parseHealthFailure: "stale" }),
      false,
    );
  });
});

describe("arithmetic safety", () => {
  // A negative denominator or a NaN ratio would poison the comparison and make
  // the guard silently pass — the same non-finite class that has bitten the
  // money paths.
  it("never produces a non-finite ratio, even on impossible tallies", () => {
    for (const t of [
      tally({ downloaded: 0, fetchFailed: 10 }),
      tally({ downloaded: 5, fetchFailed: 99 }),
      tally({}),
    ]) {
      const h = judgeXbrlParseHealth(t);
      assert.ok(Number.isFinite(h.ratio), `ratio ${h.ratio}`);
      assert.ok(h.readable >= 0, `readable ${h.readable}`);
    }
  });

  it("is pure — the same tally always gives the same verdict", () => {
    const t = tally({ downloaded: 200, fetchFailed: 3, unknownTaxonomy: 50 });
    assert.deepEqual(judgeXbrlParseHealth(t), judgeXbrlParseHealth(t));
  });

  // The thresholds are exported so a caller can explain the verdict, and so a
  // change to either is a visible diff rather than a magic number edit.
  it("keeps the thresholds where the reasoning put them", () => {
    assert.equal(MAX_NOT_UNDERSTOOD_SHARE, 0.1);
    assert.equal(MIN_READABLE_FOR_RATIO, 20);
  });
});

describe("archiveDayForFiling — which month a filing is archived under (MONEY-1204)", () => {
  const QUARTER_END = new Date(Date.UTC(2024, 8, 30));
  const BROADCAST = new Date(Date.UTC(2024, 10, 15, 4, 33, 48));

  it("prefers the quarter-end — the day the DATA describes", () => {
    // MONEY-1189's lesson restated: an archive key's day and its data's day
    // diverge exactly when it matters. Keying on the quarter-end makes them the
    // same by construction, so `feeds/NSE/results-xbrl/2024/09/` means "filings
    // FOR the quarter ending Sep-2024" whenever NSE happened to broadcast them.
    assert.equal(
      archiveDayForFiling({
        quarterEnd: QUARTER_END,
        broadcastAt: BROADCAST,
      })?.toISOString(),
      QUARTER_END.toISOString(),
    );
  });

  it("falls back to the broadcast date when the index gives no quarter-end", () => {
    assert.equal(
      archiveDayForFiling({
        quarterEnd: null,
        broadcastAt: BROADCAST,
      })?.toISOString(),
      BROADCAST.toISOString(),
    );
  });

  it("returns undefined rather than substituting a day it does not have", () => {
    // `undefined` routes buildFeedArchiveKey to `current/`, the grammar's
    // existing, DISTINCT "no day" value. A confident wrong month would be a
    // cached fail-open default: unrecoverable, and invisible.
    assert.equal(
      archiveDayForFiling({ quarterEnd: null, broadcastAt: null }),
      undefined,
    );
  });

  it("is a pure function of the FILING — never of the clock", () => {
    // The property the whole choice rests on. A fetch-day key would compute a
    // different month for the same immutable document on a re-run, so the
    // archive would hold two copies, a replay would miss the first, and — since
    // nothing in `XbrlFiling` records when we fetched — no later reader holding
    // the row could reconstruct the key at all.
    const entry = { quarterEnd: QUARTER_END, broadcastAt: BROADCAST };
    const first = archiveDayForFiling(entry);
    const second = archiveDayForFiling(entry);
    assert.equal(first?.getTime(), second?.getTime());
    assert.equal(first?.getTime(), QUARTER_END.getTime());
  });

  it("broadcast-day keying would have SCATTERED one quarter across months", () => {
    // Why the fallback is a fallback. Three real filings for the SAME quarter,
    // broadcast weeks apart — under broadcastAt they land in two different
    // archive months and a late Revision of a 2024 quarter files under 2026.
    const sameQuarter = [
      new Date(Date.UTC(2024, 9, 12)),
      new Date(Date.UTC(2024, 10, 14)),
      new Date(Date.UTC(2026, 1, 2)),
    ].map((broadcastAt) =>
      archiveDayForFiling({ quarterEnd: QUARTER_END, broadcastAt }),
    );
    assert.equal(
      new Set(sameQuarter.map((d) => d?.toISOString().slice(0, 7))).size,
      1,
      "every filing for one quarter must archive under one month",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* pickAnnualCompanion — MONEY-1114                                           */
/* -------------------------------------------------------------------------- */

/**
 * A March-quarter filing carries the full financial year as a SECOND context in
 * the same document. This is the decision that finds it, and the two ways it is
 * required to refuse.
 *
 * The spans below are the real ones — 89/90 for a quarter, 364 for a financial
 * year (start-inclusive, end-exclusive, so NOT 365), 274 for the nine-month
 * year-to-date. `isAnnualSpan` is injected so this stays pure and so the band
 * itself is tested once, in `classifyFilingPeriod`, rather than twice.
 */
describe("pickAnnualCompanion — the ANNUAL row inside a Q4 filing", () => {
  const isAnnual = (days: number): boolean => days >= 355 && days <= 380;

  it("finds the single full-year context beside the quarter", () => {
    // RELIANCE Q4-FY19, verbatim: primary OneD 89d, other FourD 364d.
    const pick = pickAnnualCompanion(
      [{ days: 364, contextRef: "FourD" }],
      isAnnual,
    );
    assert.deepEqual(pick, { kind: "found", contextRef: "FourD" });
  });

  it("returns `none` for a Q1 filing — the COMMON case, not a fault", () => {
    // A Q1 filing's year-to-date column IS its quarter, so the document
    // declares no second period at all. 2,127 of the 2,152 rows in prod on
    // 2026-08-19 are exactly this. A pass that treated `none` as a failure
    // would report a 99% error rate on a completely healthy table.
    assert.deepEqual(pickAnnualCompanion([], isAnnual), { kind: "none" });
  });

  it("returns `none` when the other periods are shorter than a year", () => {
    // A Q3 filing: the quarter plus the nine-month YTD. Nothing annual here,
    // and the 274-day column must NOT be mistaken for one.
    assert.deepEqual(
      pickAnnualCompanion([{ days: 274, contextRef: "FourD" }], isAnnual),
      { kind: "none" },
    );
  });

  it("REFUSES when two full-year contexts exist", () => {
    // The current year and a prior-year comparative, both undimensioned.
    // Nothing available here can say which is the filer's "current" column, and
    // picking the first would store last year's figures under this year's
    // unique key — unrecoverable, and it looks entirely normal.
    const pick = pickAnnualCompanion(
      [
        { days: 364, contextRef: "FourD" },
        { days: 365, contextRef: "FivePriorD" },
      ],
      isAnnual,
    );
    assert.equal(pick.kind, "ambiguous");
    assert.deepEqual(
      pick.kind === "ambiguous" ? pick.contextRefs : [],
      ["FourD", "FivePriorD"],
      "the refusal must name what it saw, or the fix needs a re-download",
    );
  });

  it("never returns the FIRST of several — it returns nothing", () => {
    // Guards the specific weakening a future "just pick one" change would be.
    const pick = pickAnnualCompanion(
      [
        { days: 364, contextRef: "A" },
        { days: 364, contextRef: "B" },
      ],
      isAnnual,
    );
    assert.notEqual(pick.kind, "found");
  });
});

/**
 * `unclassifiedPeriod` in the parse-health numerator — MONEY-1114.
 *
 * A refusal that does not reach the verdict is a document downloaded,
 * understood as XBRL, discarded, and reported as a healthy run — the exact
 * MONEY-1200 shape (`downloaded: 1500, written: 0, ok: true`) restated one
 * refusal later.
 */
describe("judgeXbrlParseHealth counts unclassified spans as not-understood", () => {
  const base: XbrlParseTally = {
    downloaded: 100,
    fetchFailed: 0,
    nonFinancial: 0,
    unparseable: 0,
    unknownTaxonomy: 0,
    noPeriod: 0,
  };

  it("FAILS a run where every document had an unrecognised span", () => {
    // The taxonomy-change scenario: every filing parses, every span reads as
    // 200 days, zero rows are written. Without this term the verdict is `ok`.
    const v = judgeXbrlParseHealth({ ...base, unclassifiedPeriod: 100 });
    assert.equal(v.ok, false);
    assert.equal(v.notUnderstood, 100);
    assert.equal(v.ratio, 1);
  });

  it("does not fire on a handful of odd filers", () => {
    // Transition years are real and rare. 3 of 100 must not fail a run, or the
    // threshold gets muted and stops protecting anything.
    const v = judgeXbrlParseHealth({ ...base, unclassifiedPeriod: 3 });
    assert.equal(v.ok, true);
    assert.equal(v.notUnderstood, 3);
  });

  it("treats the field as absent-means-zero for pre-1114 callers", () => {
    assert.deepEqual(
      judgeXbrlParseHealth(base),
      judgeXbrlParseHealth({ ...base, unclassifiedPeriod: 0 }),
    );
  });
});

/**
 * `unmappedFamily` must never reach the parse-health numerator — MONEY-1220.
 *
 * The counter is excluded structurally: `judgeXbrlParseHealth` sums
 * `unparseable + unknownTaxonomy + noPeriod + unclassifiedPeriod` and there is
 * no fifth term, so this asserts the SCENARIO rather than a field.
 *
 * Before the classification, General Insurance filings landed in
 * `unknownTaxonomy` — i.e. in that sum. On the 2026-08-18 prod window that was
 * 2 of 228 and harmless. It is not harmless in general: `notUnderstood ===
 * readable` fails a run at ANY sample size, so a narrow catch-up window that
 * happened to hold only insurance filings would have failed — deterministically,
 * with `isRetriableFailure` correctly declining to retry, and with nothing wrong
 * anywhere. A run must not be able to fail because the market filed insurance
 * results we have chosen not to read yet.
 */
describe("MONEY-1220 — a window of only unmapped-family filings is HEALTHY", () => {
  /**
   * The processor's own composition: `out[bucketForOutcome(kind)]++` for each
   * document, then `judgeXbrlParseHealth(out)`.
   *
   * Asserting on a hand-built tally instead would test nothing — an all-zero
   * numerator is healthy whatever `bucketForOutcome` does, so the test would
   * survive routing `unmapped-family` straight back into `unknownTaxonomy`.
   * Running the kinds THROUGH the mapping is what couples this to the change.
   */
  const judgeWindow = (kinds: XbrlDocumentOutcome["kind"][]) => {
    const counts: Record<string, number> = {};
    for (const k of kinds) {
      const bucket = bucketForOutcome(k);
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    return judgeXbrlParseHealth(
      tally({
        downloaded: kinds.length,
        nonFinancial: counts.nonFinancial ?? 0,
        unparseable: counts.unparseable ?? 0,
        unknownTaxonomy: counts.unknownTaxonomy ?? 0,
        noPeriod: counts.noPeriod ?? 0,
      }),
    );
  };

  it("does not fail when every document read was a recognised, skipped shape", () => {
    // The two GICRE filings from the 2026-08-18 window, and nothing else.
    const v = judgeWindow(["unmapped-family", "unmapped-family"]);
    assert.equal(
      v.ok,
      true,
      `a window of skipped shapes must stand: ${v.reason}`,
    );
    assert.equal(v.notUnderstood, 0);
    assert.equal(v.readable, 2);
    assert.equal(v.reason, null);
  });

  it("still fails that same window if the filings were genuinely unknown", () => {
    // The counterfactual, and the guard against "fixing" this by widening the
    // threshold: the same two documents as an unknown entry point must still
    // fail. The classification is what changed, not the sensitivity.
    const v = judgeWindow(["unknown-entry-point", "unknown-entry-point"]);
    assert.equal(v.ok, false);
    assert.equal(v.notUnderstood, 2);
  });

  it("does not dilute a REAL failure sitting beside skipped filings", () => {
    // The opposite error: moving GI out of the numerator must not also move it
    // out of the denominator, or a window padded with insurance filings would
    // hide a genuine parse failure. 20 read (the minimum ratio sample), 17
    // skipped, 3 broken = 15%, over the 10% share — so it must fail.
    //
    // 3 and not 2: the guard is `ratio > MAX_NOT_UNDERSTOOD_SHARE`, strictly,
    // so 2/20 is exactly 10% and correctly stands.
    const kinds: XbrlDocumentOutcome["kind"][] = [
      ...Array<XbrlDocumentOutcome["kind"]>(17).fill("unmapped-family"),
      "unknown-taxonomy",
      "unknown-entry-point",
      "not-xbrl",
    ];
    const v = judgeWindow(kinds);
    assert.equal(v.readable, 20, "skipped filings stay in the denominator");
    assert.equal(v.notUnderstood, 3);
    assert.equal(v.ok, false);
  });
});

/* ═════════════════════════════════════════════════════════════════════════ */
/* MONEY-1235 — write order, and the budget that has to cover index paging.  */
/* ═════════════════════════════════════════════════════════════════════════ */

const INDEX_CAPTURE: unknown = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "packages",
      "core",
      "__tests__",
      "fixtures",
      "xbrl-index",
      "integrated-capped-20.sample.json",
    ),
    "utf-8",
  ),
) as unknown;

function capturedEntries(): FilingIndexEntry[] {
  const p = parseFilingIndexPage(INDEX_CAPTURE, "integrated");
  assert.ok(p !== null, "the real capture must parse");
  assert.equal(p.entries.length, 20, "20 verbatim records");
  return p.entries;
}

/** A minimal entry; every case states only the fields it varies. */
function entry(over: Partial<FilingIndexEntry> = {}): FilingIndexEntry {
  return {
    era: "integrated",
    symbol: "ACME",
    isin: null,
    xbrlUrl: "https://nsearchives.nseindia.com/corporate/xbrl/A.xml",
    ixbrlUrl: null,
    basis: "STANDALONE",
    audited: null,
    cumulative: null,
    periodType: null,
    filerKind: "GENERIC",
    quarterEnd: null,
    broadcastAt: null,
    companyName: "",
    revisionKind: null,
    revisedAt: null,
    createdAt: null,
    indexSequence: null,
    ...over,
  };
}

describe("orderFilingsForWrite — the newest filing must be the LAST write", () => {
  it("puts the SALSTEEL Original before its Revision, from the real capture", () => {
    // The index serves them newest-first — Revision at 8, Original at 9 — so
    // the download loop used to end on the SUPERSEDED Original. Ordering
    // oldest-first makes the Revision the last write for that key.
    const sal = capturedEntries().filter((e) => e.symbol === "SALSTEEL");
    assert.equal(sal[0]!.revisionKind, "REVISION", "as the index returns them");

    const ordered = orderFilingsForWrite(sal);
    assert.deepEqual(
      ordered.map((e) => e.indexSequence),
      [143653, 143654],
      "ascending sequence: the Original is written first and overwritten",
    );
    assert.equal(ordered[1]!.revisionKind, "REVISION");
  });

  it("orders JAINREC's TWO Revisions, which a `type_Sub` rule cannot", () => {
    // The case that rules out "process Revisions last". Both records are
    // Revisions of one period, so a kind-based rule leaves them in index order
    // — which is newest-first, so the EARLIER revision (143646) stays the last
    // write. Only a monotonic key separates them.
    const jain = capturedEntries().filter((e) => e.symbol === "JAINREC");
    assert.equal(jain.length, 2);
    assert.deepEqual(
      jain.map((e) => e.revisionKind),
      ["REVISION", "REVISION"],
      "neither is an Original, so kind cannot order them",
    );
    assert.deepEqual(
      orderFilingsForWrite(jain).map((e) => e.indexSequence),
      [143646, 143649],
    );
  });

  it("the whole capture comes out ascending by sequence", () => {
    const seqs = orderFilingsForWrite(capturedEntries()).map(
      (e) => e.indexSequence,
    );
    assert.equal(seqs.length, 20);
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(
        seqs[i]! > seqs[i - 1]!,
        `not ascending at ${i}: ${seqs[i - 1]} then ${seqs[i]}`,
      );
    }
    // …and the input genuinely was not, or this asserts nothing: indices 13/14
    // are 143647 then 143648, ASCENDING inside an otherwise descending list.
    const raw = capturedEntries().map((e) => e.indexSequence);
    assert.equal(raw[13], 143647);
    assert.equal(raw[14], 143648);
    assert.ok(
      !raw.every((v, i) => i === 0 || v! < raw[i - 1]!),
      "the raw capture is not monotonic — reversing it is NOT a fix",
    );
  });

  it("is ORDER-INDEPENDENT: shuffling the input cannot change the output", () => {
    // The invariant as a property. Three different arrival orders of the same
    // 20 records must produce one identical write order.
    const base = orderFilingsForWrite(capturedEntries()).map((e) => e.xbrlUrl);
    const reversed = orderFilingsForWrite([...capturedEntries()].reverse()).map(
      (e) => e.xbrlUrl,
    );
    // Deterministic pseudo-shuffle — no clock, no Math.random, nothing to flake.
    const rotated = capturedEntries();
    const shuffled = orderFilingsForWrite([
      ...rotated.slice(7),
      ...rotated.slice(0, 7),
    ]).map((e) => e.xbrlUrl);

    assert.deepEqual(reversed, base);
    assert.deepEqual(shuffled, base);
  });

  it("does not mutate the array it was handed", () => {
    // The processor keeps `collectedEntries` for its `duplicateListings`
    // arithmetic; sorting in place would silently change what that counts.
    const input = capturedEntries();
    const before = input.map((e) => e.xbrlUrl);
    const out = orderFilingsForWrite(input);
    assert.notEqual(out, input, "must hand back a NEW array");
    assert.deepEqual(
      input.map((e) => e.xbrlUrl),
      before,
      "the input order must survive",
    );
  });

  it("LEGACY sorts before INTEGRATED, whatever the raw sequences say", () => {
    // Legacy sequences run ~1.18M and modern ones ~143k, so a bare numeric
    // compare puts a 2019 legacy filing AFTER a 2026 modern one — i.e. lets
    // history overwrite the present. Era is compared first for exactly this.
    const legacy = entry({ era: "legacy", indexSequence: 1_189_117 });
    const modern = entry({ era: "integrated", indexSequence: 143_654 });
    assert.deepEqual(
      orderFilingsForWrite([modern, legacy]).map((e) => e.era),
      ["legacy", "integrated"],
    );
  });

  it("an entry with NO sequence sorts first — unplaceable must not win", () => {
    // A record we cannot place in time may be overwritten by one we can, never
    // the reverse.
    const known = entry({ indexSequence: 1, xbrlUrl: "https://x/known.xml" });
    const unknown = entry({
      indexSequence: null,
      xbrlUrl: "https://x/unk.xml",
    });
    assert.deepEqual(
      orderFilingsForWrite([known, unknown]).map((e) => e.indexSequence),
      [null, 1],
    );
  });

  it("`null` is -Infinity, NOT 0 — it must lose to a sequence of zero too", () => {
    // The distinction the previous case cannot make, because every real
    // sequence is >= 1 and so beats a 0 substitute anyway. `parseIndexSequence`
    // accepts the literal "0", so 0 IS a reachable stated sequence; mapping
    // null to it would make "NSE gave no sequence" and "NSE said 0" the same
    // claim, and the tie would then be decided by the url tie-break rather than
    // by "unplaceable loses".
    const stated = entry({ indexSequence: 0, xbrlUrl: "https://x/aaa.xml" });
    const absent = entry({ indexSequence: null, xbrlUrl: "https://x/zzz.xml" });
    assert.deepEqual(
      orderFilingsForWrite([stated, absent]).map((e) => e.indexSequence),
      [null, 0],
      "…and note the url tie-break would have ordered them the OTHER way",
    );
    assert.ok(compareFilingWriteOrder(absent, stated) < 0);
  });

  it("falls back to the timestamp when sequences tie or are both absent", () => {
    const older = entry({
      xbrlUrl: "https://x/older.xml",
      createdAt: new Date(Date.UTC(2026, 1, 14, 22, 0, 0)),
    });
    const newer = entry({
      xbrlUrl: "https://x/newer.xml",
      createdAt: new Date(Date.UTC(2026, 1, 14, 23, 0, 0)),
    });
    assert.deepEqual(
      orderFilingsForWrite([newer, older]).map((e) => e.xbrlUrl),
      ["https://x/older.xml", "https://x/newer.xml"],
    );
  });

  it("is a TOTAL order — identical entries still sort deterministically", () => {
    // Without the url tie-break, two records equal in era/sequence/timestamp
    // sort by whatever the engine's sort happens to do — and the entire point
    // of this function is that the outcome does not depend on that.
    const a = entry({ xbrlUrl: "https://x/aaa.xml" });
    const b = entry({ xbrlUrl: "https://x/bbb.xml" });
    assert.deepEqual(
      orderFilingsForWrite([b, a]).map((e) => e.xbrlUrl),
      ["https://x/aaa.xml", "https://x/bbb.xml"],
    );
    assert.equal(compareFilingWriteOrder(a, a), 0, "reflexive");
    assert.ok(compareFilingWriteOrder(a, b) < 0);
    assert.ok(compareFilingWriteOrder(b, a) > 0, "antisymmetric");
  });
});

describe("filingWriteTimestamp — a Revision's clock is not its broadcast", () => {
  it("prefers createdAt, then revisedAt, then broadcastAt", () => {
    const all = entry({
      createdAt: new Date(Date.UTC(2026, 0, 3)),
      revisedAt: new Date(Date.UTC(2026, 0, 2)),
      broadcastAt: new Date(Date.UTC(2026, 0, 1)),
    });
    assert.equal(filingWriteTimestamp(all), Date.UTC(2026, 0, 3));
    assert.equal(
      filingWriteTimestamp({ ...all, createdAt: null }),
      Date.UTC(2026, 0, 2),
      "a Revision has a null broadcast date and states revised_Date instead",
    );
    assert.equal(
      filingWriteTimestamp({ ...all, createdAt: null, revisedAt: null }),
      Date.UTC(2026, 0, 1),
      "legacy has only the broadcast date",
    );
  });

  it("a dateless entry is -Infinity, never NaN", () => {
    // NaN makes every comparison false, which turns the sort into a silent
    // no-op — the defect wearing a different hat.
    const t = filingWriteTimestamp(entry());
    assert.equal(t, Number.NEGATIVE_INFINITY);
    assert.ok(!Number.isNaN(t));
  });

  it("an Invalid Date is -Infinity too", () => {
    const t = filingWriteTimestamp(entry({ createdAt: new Date("nonsense") }));
    assert.equal(t, Number.NEGATIVE_INFINITY);
  });
});

describe("downloadBudgetAfterIndexing — paging is charged to the run budget", () => {
  it("subtracts what the index already spent", () => {
    // The nightly case: a 7-day window pages ~3 times, so a few seconds come
    // off the 480 s and nothing else changes.
    assert.equal(downloadBudgetAfterIndexing(480_000, 4_000), 476_000);
    assert.equal(downloadBudgetAfterIndexing(480_000, 0), 480_000);
  });

  it("REGRESSION: a long catch-up paging phase SHRINKS the download budget", () => {
    // The bug. `windowDays` is capped at 370 by the route, and a wide window
    // can page up to MAX_PAGES (40) per era/period at up to 15 s a page —
    // 600 s — before the download loop began its OWN full 480 s. Total 1,080 s
    // against a 600 s ack deadline that cannot be raised, so Pub/Sub
    // redelivers mid-flight and a second complete pass starts.
    assert.equal(downloadBudgetAfterIndexing(480_000, 300_000), 180_000);
    assert.ok(
      downloadBudgetAfterIndexing(480_000, 300_000) < 480_000,
      "the download loop must NOT still get the whole budget",
    );
  });

  it("returns 0 rather than a floor when paging ate everything", () => {
    // No honest amount of download time is left, and inventing a minimum is
    // how a deadline gets overrun by exactly that minimum. 0 stops the loop on
    // its first check and the trailing window collects the filings next run.
    assert.equal(downloadBudgetAfterIndexing(480_000, 480_000), 0);
    assert.equal(downloadBudgetAfterIndexing(480_000, 600_000), 0);
    assert.ok(downloadBudgetAfterIndexing(480_000, 999_999_999) >= 0);
  });

  it("a backwards clock can only SHORTEN the budget, never extend it", () => {
    // A negative elapsed is clamped rather than credited: `480_000 - (-60_000)`
    // would hand the loop 540 s, i.e. more than the run was ever allowed.
    assert.equal(downloadBudgetAfterIndexing(480_000, -60_000), 480_000);
  });

  it("is total on nonsense input", () => {
    for (const bad of [NaN, Infinity, -Infinity, 0, -1]) {
      assert.equal(downloadBudgetAfterIndexing(bad, 1_000), 0, `budget ${bad}`);
    }
    assert.equal(downloadBudgetAfterIndexing(480_000, NaN), 480_000);
    assert.equal(downloadBudgetAfterIndexing(480_000, Infinity), 480_000);
  });
});

/* -------------------------------------------------------------------------- */
/* WIRING — a pure helper nobody calls is a decision nobody made.             */
/* -------------------------------------------------------------------------- */

const PROC = readFileSync(
  join(import.meta.dirname, "..", "..", "src", "processors", "xbrl-sync.ts"),
  "utf-8",
);

/**
 * The source with comments removed.
 *
 * Every absence assertion below MUST run against this. The comments in
 * `xbrl-sync.ts` quote the very code they replaced — `filedAt: entry.broadcastAt`
 * appears verbatim in the explanation of why it is gone — so an absence
 * assertion over the raw text would match its own documentation and pass while
 * the defect sat one line below.
 */
// LINE comments FIRST, then BLOCK — MONEY-1143. Reversed, a `//` comment
// containing `/*` swallows every line up to the next `*/`, and these are
// ABSENCE assertions, so the swallowed code would read as a PASS.
const PROC_CODE = PROC.replace(/(^|[^:])\/\/.*$/gm, "$1").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

describe("MONEY-1235 wiring — processXbrlSync uses the decisions above", () => {
  it("the comment stripper actually stripped something", () => {
    // Guards the guard: a stripper that matched nothing would make every
    // absence assertion below vacuous.
    assert.ok(PROC.length > PROC_CODE.length + 5_000, "comments were removed");
    assert.ok(
      PROC.includes("MONEY-1235"),
      "the raw source carries the ticket comments",
    );
    assert.ok(
      !PROC_CODE.includes("MONEY-1235"),
      "…and the stripped source does not",
    );
  });

  it("the download loop iterates the ORDERED entries", () => {
    // The assignment is pinned WHOLE, terminator included. `orderFilingsForWrite(deduped)`
    // alone is satisfied by `orderFilingsForWrite(deduped).reverse()`, which
    // re-creates the defect exactly — newest first, superseded Original last —
    // while every property test of the comparator stays green, because they
    // call the comparator rather than the call site.
    //
    // MONEY-1238 wraps it in `downloadOrder`, which REGROUPS by symbol without
    // touching the relative order inside a group — see the behavioural tests in
    // `xbrl-sync-store.test.ts`, which are what actually prove the invariant
    // survives. This assertion still pins the composition WHOLE so a future
    // `.reverse()` or a swap of the two calls cannot slip in unremarked.
    assert.match(
      PROC_CODE,
      /const\s+entries\s*=\s*downloadOrder\(\s*orderFilingsForWrite\(\s*deduped\s*\)\s*\)\s*;/,
    );
    assert.ok(
      !/orderFilingsForWrite\([^)]*\)\s*\./.test(PROC_CODE),
      "nothing may be chained onto the ordered array",
    );
    // Every CALL (as opposed to the definition) must consume the WRITE-ordered
    // stream. A second call site fed a raw array would regroup entries that
    // were never ordered oldest-first, which loses the newest-wins invariant
    // without touching the assertion above.
    for (const m of PROC_CODE.matchAll(/downloadOrder\(/g)) {
      const at = m.index ?? 0;
      if (/function\s+$/.test(PROC_CODE.slice(Math.max(0, at - 30), at))) {
        continue; // the definition itself
      }
      assert.match(
        PROC_CODE.slice(at, at + 60),
        /downloadOrder\(\s*orderFilingsForWrite\(/,
        "downloadOrder must consume the WRITE-ordered stream, not a raw one",
      );
    }
    assert.match(PROC_CODE, /for\s*\(\s*const\s+entry\s+of\s+entries\s*\)/);
  });

  it("the budget clock starts BEFORE the index is walked", () => {
    // The whole fix is an ordering fact about two statements, so assert the
    // ordering rather than the presence.
    const clock = PROC_CODE.indexOf("const runStartedAt = Date.now()");
    const firstCollect = PROC_CODE.indexOf("await collectIndex(");
    const loop = PROC_CODE.indexOf("const downloadStartedAt = Date.now()");
    assert.ok(clock > 0, "runStartedAt must exist");
    assert.ok(firstCollect > 0 && loop > 0);
    assert.ok(
      clock < firstCollect,
      "the run clock must be taken before any index page is fetched",
    );
    assert.ok(firstCollect < loop, "…and paging happens before the loop");
    // …and HOW the elapsed time is computed, not merely that a variable of
    // that name is passed. `const indexElapsedMs = 0` type-checks, keeps the
    // call site intact, and restores the original double-spend in full.
    assert.match(
      PROC_CODE,
      /const\s+indexElapsedMs\s*=\s*downloadStartedAt\s*-\s*runStartedAt\s*;/,
    );
    assert.match(
      PROC_CODE,
      /downloadBudgetAfterIndexing\(\s*timeBudgetMs\s*,\s*indexElapsedMs\s*,?\s*\)/,
    );
    assert.match(
      PROC_CODE,
      /Date\.now\(\)\s*-\s*downloadStartedAt\s*>=\s*downloadBudgetMs/,
      "the loop must check the SHRUNK budget, not the raw one",
    );
  });

  it("REGRESSION: the loop no longer measures against the raw timeBudgetMs", () => {
    assert.ok(
      !/downloadStartedAt\s*>=\s*timeBudgetMs/.test(PROC_CODE),
      "measuring from after paging is what double-spent the 120 s headroom",
    );
  });

  it("REGRESSION: filedAt is not assigned straight from broadcastAt", () => {
    // The revision case: `broadcast_Date` is null on 3 of 20 records in one
    // capture and 16 of 20 in another, so this assignment blanked a filedAt the
    // Original had already supplied.
    assert.ok(
      !/filedAt:\s*entry\.broadcastAt/.test(PROC_CODE),
      "must go through the broadcastAt ?? revisedAt fallback",
    );
    assert.match(PROC_CODE, /entry\.broadcastAt\s*\?\?\s*entry\.revisedAt/);
  });

  it("the projection cursor is cleared on UPDATE and nowhere else", () => {
    // One occurrence, in the update branch. A `projectedAt` in `create:` would
    // be a second way of saying `isSet: false`, and `UNPROJECTED_FILING_WHERE`
    // already covers that arm.
    const hits = PROC_CODE.match(/projectedAt/g) ?? [];
    assert.equal(hits.length, 1, "exactly one mention in the code");
    assert.match(PROC_CODE, /projectedAt:\s*null/);
    const update = PROC_CODE.indexOf("update: {");
    const create = PROC_CODE.indexOf("create: { ...data, filedAt }");
    const stamp = PROC_CODE.indexOf("projectedAt: null");
    assert.ok(create > 0 && update > create, "create precedes update");
    assert.ok(stamp > update, "the reset lives inside the update branch");
  });

  it("the pre-download skip is still keyed on sourceUrl", () => {
    // Pinned because the store test MODELS this query. If the skip ever changes
    // shape, that model becomes a shadow and this is what says so.
    assert.match(PROC_CODE, /prisma\.xbrlFiling\.findFirst\(/);
    assert.match(PROC_CODE, /sourceUrl:\s*entry\.xbrlUrl/);
  });
});

describe("MONEY-1237 — a truncation verdict must keep the walk paging, not just log", () => {
  const SYNC = readFileSync(
    join(import.meta.dirname, "..", "..", "src", "processors", "xbrl-sync.ts"),
    "utf8",
  );
  /** LINE comments first, then BLOCK — MONEY-1143. */
  const CODE = SYNC.replace(/^[^\S\r\n]*\/\/.*$/gm, "").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );

  it("the paged short-page branch CONTINUES on `truncated` before breaking", () => {
    // THE DEFECT. The comment above the branch correctly said a short page does
    // NOT end the walk when the server's own totalCount says there is more —
    // and the `break` below it was unconditional. On the documented failure
    // shape (NSE's 20-record default cap while totalCount reports thousands)
    // the walk pushed one suspicion string, consumed by a single logger.warn,
    // and stopped at page 1 with 20 of ~7,000 filings — a healthy-looking run
    // short by 99.7% of its window. Computed and inert.
    const branch =
      /if \(parsed\.listed < PAGE_SIZE\) \{([\s\S]*?)\n {6}\}/.exec(CODE);
    assert.ok(branch, "could not locate the paged short-page branch");
    assert.match(
      branch[1]!,
      /if \(verdict\.truncated\) \{[\s\S]*?if \(page < maxPages\) continue;/,
      "a truncated verdict must continue the walk while pages remain",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1250 — the ERA SEAM that made a whole quarter unreachable            */
/* -------------------------------------------------------------------------- */

/**
 * `erasForWindow` — which index or indexes a window must be walked against.
 *
 * ## The defect these cases pin
 *
 * Era selection walked both indexes only when a window STRADDLED
 * `INTEGRATED_FILING_ERA_START`. `scripts/jobs/xbrl-backfill.ts` emits calendar
 * MONTHS, and a calendar month cannot straddle a 1-January boundary, so the
 * both-eras branch was unreachable for every window that script generates.
 *
 * The Dec-2024 quarter was broadcast through the LEGACY index for the whole of
 * Jan-Mar 2025 (3,901 records / 3,895 XMLs, ~3,822 carrying `qe_Date`
 * 2024-12-31), so those months walked the modern index — which over the same
 * period carries governance and nothing else — and found nothing to write.
 * Prod, measured 2026-08-26:
 *
 *     periodEnd 2024-09-30   2,717 filings
 *     periodEnd 2024-12-31       0 filings
 *     periodEnd 2025-03-31   7,561 filings
 *
 * A missing quarter, reported by every run as success. The first case below is
 * that exact window and it fails against the old ternary.
 *
 * ## Why these assert the WINDOW and not the boundary
 *
 * A test that only checked `eraForDate` would have passed before and after the
 * fix — the boundary constant is not wrong, and the defect lived entirely in
 * how a RANGE was reduced to a set of eras. So every case here is a from/to
 * pair, and the monthly ones are built the way `monthWindows` builds them
 * (day 0 of the next month = the last day of this one).
 */
describe("erasForWindow — a monthly window can never straddle a boundary", () => {
  /** The exact shape `monthWindows` emits: [1st 00:00, last day 00:00]. */
  const month = (y: number, m: number): { from: Date; to: Date } => ({
    from: new Date(Date.UTC(y, m - 1, 1)),
    to: new Date(Date.UTC(y, m, 0)),
  });

  it("walks BOTH indexes for Jan/Feb/Mar 2025 — the unreachable quarter", () => {
    // THE REGRESSION. Under the straddle-only rule every one of these returned
    // ["integrated"], and the ~3,895 legacy filings for periodEnd 2024-12-31
    // were unreachable by construction — no error, no counter, no gap anyone
    // could see. Prod log, execution `vwmjv` 2026-08-20:
    //   2025-01: listed 831, written 0, non-financial 831
    for (const m of [1, 2, 3]) {
      const w = month(2025, m);
      assert.deepEqual(
        erasForWindow(w.from, w.to),
        ["legacy", "integrated"],
        `2025-${m}: the legacy index was still broadcasting the Dec-2024 ` +
          `quarter, so walking integrated-only loses it silently`,
      );
    }
  });

  it("keeps walking both through the Apr-Jun 2025 margin", () => {
    // The measured crossover is 2025-04 (3,302 modern records listed, against
    // 831 all-governance in 2025-01). The overlap runs one quarter PAST it
    // deliberately: "legacy serves through 2025-03" is a FLOOR — the walk
    // stopped there — and a late filer of the Dec-2024 quarter broadcasting in
    // April or May is precisely the record a tight overlap drops invisibly.
    // Being too wide costs 2 index reads on a window; being too narrow costs a
    // quarter.
    for (const m of [4, 5, 6]) {
      const w = month(2025, m);
      assert.deepEqual(erasForWindow(w.from, w.to), ["legacy", "integrated"]);
    }
  });

  it("is INTEGRATED-only once the overlap ends — it is an overlap, not a move", () => {
    // The other half of the fix. If this returned both eras the change would
    // have quietly become "move the boundary to 2025-07", buying the missing
    // quarter with an unbounded extra legacy walk on every window forever.
    for (const w of [month(2025, 7), month(2025, 8), month(2026, 3)]) {
      assert.deepEqual(erasForWindow(w.from, w.to), ["integrated"]);
    }
  });

  it("the nightly 7-day window in 2026 pays nothing for any of this", () => {
    // The job that runs every night must be untouched by a fix aimed at a
    // 2025 backfill. A trailing week in 2026 walks one index, as before.
    const to = new Date(Date.UTC(2026, 7, 26));
    const from = new Date(to.getTime() - 7 * 86_400_000);
    assert.deepEqual(erasForWindow(from, to), ["integrated"]);
  });

  it("still walks both on a GENUINE straddle, and still legacy-only before", () => {
    // Pre-existing behaviour, asserted so the new overlap arm cannot be
    // refactored on top of it and quietly delete it.
    assert.deepEqual(
      erasForWindow(new Date("2024-12-15"), new Date("2025-01-15")),
      ["legacy", "integrated"],
    );
    const dec = month(2024, 12);
    assert.deepEqual(erasForWindow(dec.from, dec.to), ["legacy"]);
    const old = month(2019, 5);
    assert.deepEqual(erasForWindow(old.from, old.to), ["legacy"]);
  });

  it("a 370-day catch-up window that reaches into the overlap walks both", () => {
    // The route accepts windowDays up to 370. Such a window ends well past the
    // overlap, so a rule keyed on the END date alone would answer
    // "integrated" and skip the legacy months it spans.
    const to = new Date(Date.UTC(2026, 0, 15));
    const from = new Date(to.getTime() - 370 * 86_400_000);
    assert.deepEqual(erasForWindow(from, to), ["legacy", "integrated"]);
  });

  it("orders legacy FIRST — era is orderFilingsForWrite's first sort key", () => {
    const w = month(2025, 2);
    assert.deepEqual(erasForWindow(w.from, w.to)[0], "legacy");
  });

  it("an UNDATABLE window walks both rather than picking one confidently", () => {
    // `eraForDate` reads a NaN clock as "legacy" (NaN >= start is false), so
    // the silent answer to a malformed window is a confident WRONG one. Both
    // costs an index read on a window that is already broken.
    const bad = new Date("not-a-date");
    assert.deepEqual(erasForWindow(bad, new Date(Date.UTC(2026, 0, 1))), [
      "legacy",
      "integrated",
    ]);
    assert.deepEqual(erasForWindow(new Date(Date.UTC(2019, 0, 1)), bad), [
      "legacy",
      "integrated",
    ]);
  });

  it("the overlap end is 2025-07-01 EXCLUSIVE — pinned, not inferred", () => {
    // The constant is a measured judgement, so it is asserted directly: a
    // future edit that shortens it past the evidence has to change this line
    // and say why.
    assert.equal(
      new Date(LEGACY_FINANCIALS_OVERLAP_END).toISOString(),
      "2025-07-01T00:00:00.000Z",
    );
    // Half-open, tested on the last millisecond that must still be inside.
    const lastInstant = new Date(LEGACY_FINANCIALS_OVERLAP_END - 1);
    assert.deepEqual(erasForWindow(lastInstant, lastInstant), [
      "legacy",
      "integrated",
    ]);
    const firstOutside = new Date(LEGACY_FINANCIALS_OVERLAP_END);
    assert.deepEqual(erasForWindow(firstOutside, firstOutside), ["integrated"]);
  });

  it("processXbrlSync actually CALLS it — a pure function nobody calls is a no-op", () => {
    // MERGED-NOT-WIRED is the failure this repo keeps paying for: the fix
    // lands, the unit test is green, and the production path still runs the
    // old ternary. Asserted against the file on disk, and the old expression
    // is asserted GONE so both halves cannot coexist.
    const src = readFileSync(
      join(import.meta.dirname, "../../src/processors/xbrl-sync.ts"),
      "utf8",
    );
    assert.match(
      src,
      /const eras: FilingIndexEra\[\] = erasForWindow\(from, to\);/,
      "the download path must derive its eras from erasForWindow",
    );
    assert.doesNotMatch(
      src,
      /eraForDate\(from\) === eraForDate\(to\)/,
      "the straddle-only ternary is the defect — it must not survive",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* MONEY-1250 — the download budget could not converge                        */
/* -------------------------------------------------------------------------- */

describe("MONEY-1250 — a governance filing must not spend a download slot", () => {
  it("recognises the known non-financial prefix, and only that", () => {
    // The measured separation: of 20,000 STORED filings, zero carry a
    // governance prefix — every one is INDAS / INTEGRATED_FILING_INDAS /
    // NBFC_INDAS / INTEGRATED_FILING_NONINDAS / INTEGRATED_FILING_BANKING. So
    // skipping this prefix cannot drop anything we would have kept.
    assert.equal(
      isNonFinancialFilingUrl(
        "https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_GOVERNANCE_1492818_24072025075212_WEB.xml",
      ),
      true,
    );
    for (const url of [
      "https://x/INDAS_107700_1143475_29052024124130.xml",
      "https://x/INTEGRATED_FILING_INDAS_1434305_08052025.xml",
      "https://x/NBFC_INDAS_104663_1107165_24042024033751.xml",
      "https://x/INTEGRATED_FILING_NONINDAS_1_2.xml",
      "https://x/INTEGRATED_FILING_BANKING_1_2.xml",
    ]) {
      assert.equal(
        isNonFinancialFilingUrl(url),
        false,
        `${url} is a financial filing and must still be downloaded`,
      );
    }
  });

  it("denies the TOKENLESS early-integrated governance filename", () => {
    // The hole the era fix exposed. Governance filings from the integrated
    // index's first months carry NO family token at all — a digit follows
    // `INTEGRATED_FILING_` directly. Measured 2026-08-26: 2,375 such records
    // over Jan-Mar 2025 in the index, 2,354 such objects already in GCS (100%
    // under the `2024/12` prefix), and one fetched end to end — VRLLOG,
    // 131,896 bytes of pure `in-capmkt` IntegratedGovernance XBRL with zero
    // financial concepts.
    //
    // Those are exactly the months `erasForWindow` has just made reachable, so
    // without this arm the recovered quarter would be non-convergent on day
    // one: ~2,375 files that can never be stored, and therefore can never be
    // skipped, re-downloaded on every run.
    for (const url of [
      "https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_1477411_14012025153012_WEB.xml",
      "https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_9_1.xml",
    ]) {
      assert.equal(
        isNonFinancialFilingUrl(url),
        true,
        `${url} is a tokenless governance filing and must not be downloaded`,
      );
    }
    // ANCHORED at the basename, exactly like the GOVERNANCE arm below. A
    // filename that merely CONTAINS the token is a different document, and an
    // unanchored pattern would deny it — a financial filing skipped by a rule
    // written to skip governance. Added because the mutation that drops the
    // `^` survived every other case here: the anchor is a stated property of
    // the code, and a stated property with no assertion is a comment.
    assert.equal(
      isNonFinancialFilingUrl("https://x/INDAS_INTEGRATED_FILING_1_2.xml"),
      false,
    );
  });

  it("the four FAMILY names still pass — a wider prefix would deny everything", () => {
    // THE TRAP, asserted separately from the case above because it is the whole
    // risk of the change. `INTEGRATED_FILING` as a plain prefix would deny
    // every modern financial filing there is — which is the entire job. The
    // digit is the discriminator: a family token always begins with a letter.
    for (const family of ["INDAS", "BANKING", "NBFC_INDAS", "NONINDAS"]) {
      const url = `https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_${family}_1475217_30062025080009_WEB.xml`;
      assert.equal(
        isNonFinancialFilingUrl(url),
        false,
        `INTEGRATED_FILING_${family}_* is a FINANCIAL filing — denying it ` +
          `would empty the table the job exists to fill`,
      );
    }
  });

  it("is a DENY list — an unrecognised prefix still gets downloaded", () => {
    // The failure an allow list would produce is the worst kind for a backfill:
    // a filing type NSE adds later is silently never fetched, and the absence
    // reads exactly like "the company did not file".
    assert.equal(
      isNonFinancialFilingUrl(
        "https://x/INTEGRATED_FILING_SOMETHING_NEW_9_9.xml",
      ),
      false,
      "an unknown prefix must fall through to download-and-classify",
    );
    // Substring, not prefix, must not match — a financial filing whose name
    // merely CONTAINS the token is still financial.
    assert.equal(
      isNonFinancialFilingUrl(
        "https://x/INDAS_INTEGRATED_FILING_GOVERNANCE_1.xml",
      ),
      false,
    );
  });

  it("the skip runs BEFORE the budget check — that ordering IS the fix", () => {
    // Charging a governance filing to `MAX_DOWNLOADS_PER_RUN` is what made the
    // window non-convergent: it is never stored, so `skippedExisting` can never
    // skip it, so every run re-downloads it. Prod 2025-04, two consecutive runs:
    //   run 1  skippedExisting 280  downloaded 1500  nonFinancial 1466
    //   run 2  skippedExisting 269  downloaded 1500  nonFinancial 1454
    // `skippedExisting` went DOWN while `downloaded` stayed pinned at the cap.
    //
    // Asserted on ORDER because a correct predicate placed after the budget
    // check fixes nothing at all, and no unit test of the predicate would see it.
    const src = readFileSync(
      join(import.meta.dirname, "../../src/processors/xbrl-sync.ts"),
      "utf8",
    );
    const skipAt = src.indexOf("if (isNonFinancialFilingUrl(entry.xbrlUrl))");
    const budgetAt = src.indexOf(
      "if (out.downloaded >= MAX_DOWNLOADS_PER_RUN)",
    );
    assert.ok(skipAt > 0, "the url skip is not in the download loop");
    assert.ok(budgetAt > 0, "the budget check is not in the download loop");
    assert.ok(
      skipAt < budgetAt,
      "the non-financial skip must precede the budget check, or the budget is " +
        "still spent on files that will never be stored",
    );
  });
});

/**
 * The archive key a STORED row resolves to — MONEY-1252.
 *
 * ## Why these fixtures are real
 *
 * `candidateArchiveKeysForFiling` is the ONLY way a row already in
 * `xbrl_filings` can find the bytes it was parsed from, and the grammar it
 * depends on is FROZEN (~66,950 objects per bucket, `buildFeedArchiveKey`'s own
 * header). If it derives the wrong key the re-parse job counts the row as
 * un-archived and SKIPS it — silently, and at a scale where 2% of misses is
 * already normal, so nobody would look.
 *
 * The writer keys on the INDEX's `qe_Date` (`archiveDayForFiling`), a field the
 * schema does not store. This function reconstructs it from `periodEnd`, which
 * comes from the DOCUMENT. That they agree is an EMPIRICAL claim, not a
 * derivation, so it is pinned against objects that actually exist:
 *
 *   MEASURED 2026-08-25 against `gs://stockbook-content-prod`. 72 objects
 *   sampled across nine `{YYYY}/{MM}` prefixes (2018-03 through 2026-06)
 *   resolved to 62 stored rows; all 62 reproduced the object's real key from
 *   `periodEnd`, and none needed `filedAt`. (The other 27 objects have no row
 *   at all — governance filings, archived but never stored.)
 *
 * CORRECTED, MONEY-1250 — and the correction is the more useful half. A
 * FULL-TABLE measurement found 1,220 rows (823 distinct documents, concentrated
 * in periodEnd 2017-12 -> 2019-09) whose object sits under a `{YYYY}/{MM}` that
 * is +12 MONTHS off, because the legacy index's `qe_Date` carried the prior year
 * while `storeFiling` stored the document's own date. The 72-object sample
 * simply did not contain one. So these fixtures pin the RULE, not a claim that
 * the rule is exhaustive — the fall-through arms are load-bearing for those
 * rows, and where they miss the row is counted `archiveMissing` and skipped.
 * (The in-bucket copy repair is planned separately; do not "fix" the derivation
 * here to chase the stale year — it would break the ~94,000 rows that resolve.)
 *
 * Every fixture below is a row and an object read out of prod. Each was chosen
 * because its `periodEnd` MONTH DIFFERS FROM its `filedAt` month, so a
 * `filedAt`-first implementation fails them instead of passing by coincidence.
 */
describe("candidateArchiveKeysForFiling — the key a stored row resolves to", () => {
  const PROD_CASES = [
    {
      what: "EMAMILTD Q4-FY18 (legacy era)",
      row: {
        sourceUrl:
          "https://nsearchives.nseindia.com/corporate/xbrl/INDAS_34822_8210_04052018013527_WEB_2.xml",
        periodEnd: new Date("2018-03-31T00:00:00.000Z"),
        filedAt: new Date("2018-05-26T10:15:59.000Z"),
      },
      // The object that exists in the prod bucket.
      key: "feeds/NSE/results-xbrl/2018/03/INDAS_34822_8210_04052018013527_WEB_2.xml",
      // What a filedAt-first implementation would have asked for.
      wrong:
        "feeds/NSE/results-xbrl/2018/05/INDAS_34822_8210_04052018013527_WEB_2.xml",
    },
    {
      what: "YESBANK Q4-FY25 (integrated era)",
      row: {
        sourceUrl:
          "https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_BANKING_1420095_19042025053136_WEB.xml",
        periodEnd: new Date("2025-03-31T00:00:00.000Z"),
        filedAt: new Date("2025-04-19T17:31:36.000Z"),
      },
      key: "feeds/NSE/results-xbrl/2025/03/INTEGRATED_FILING_BANKING_1420095_19042025053136_WEB.xml",
      wrong:
        "feeds/NSE/results-xbrl/2025/04/INTEGRATED_FILING_BANKING_1420095_19042025053136_WEB.xml",
    },
    {
      what: "EQUITASBNK Q1-FY27 (the newest era)",
      row: {
        sourceUrl:
          "https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_BANKING_1703150_28072026052311_WEB.xml",
        periodEnd: new Date("2026-06-30T00:00:00.000Z"),
        filedAt: new Date("2026-07-28T17:23:06.000Z"),
      },
      key: "feeds/NSE/results-xbrl/2026/06/INTEGRATED_FILING_BANKING_1703150_28072026052311_WEB.xml",
      wrong:
        "feeds/NSE/results-xbrl/2026/07/INTEGRATED_FILING_BANKING_1703150_28072026052311_WEB.xml",
    },
  ] as const;

  for (const c of PROD_CASES) {
    it(`${c.what}: the FIRST candidate is the object that exists`, () => {
      const keys = candidateArchiveKeysForFiling(c.row);
      // FIRST, not merely present: every extra candidate is a wasted GCS round
      // trip over ~96,000 rows, and the ordering is the measured claim.
      assert.equal(keys[0], c.key);
    });

    it(`${c.what}: a filedAt-first derivation would MISS it`, () => {
      // The negative half. Without it the assertion above passes for any
      // implementation that happens to list both months.
      const keys = candidateArchiveKeysForFiling(c.row);
      assert.notEqual(
        keys[0],
        c.wrong,
        "periodEnd is the archive day; filedAt is the broadcast day, and for " +
          "a results filing they are a different MONTH",
      );
      // …but it is still probed, second, because being wrong costs one `get`
      // while a false MISSING costs a row left permanently stale.
      assert.ok(keys.includes(c.wrong));
    });
  }

  it("falls back to filedAt, then to the undated `current/` prefix", () => {
    const keys = candidateArchiveKeysForFiling(PROD_CASES[0]!.row);
    assert.deepEqual(keys, [
      PROD_CASES[0]!.key,
      PROD_CASES[0]!.wrong,
      "feeds/NSE/results-xbrl/current/INDAS_34822_8210_04052018013527_WEB_2.xml",
    ]);
  });

  it("does NOT probe the same key twice when the two dates share a month", () => {
    // The COMMON case — a filing broadcast inside its own quarter. One wasted
    // round trip per row is ~96,000 wasted round trips.
    const keys = candidateArchiveKeysForFiling({
      sourceUrl: "https://nsearchives.nseindia.com/corporate/xbrl/A_1.xml",
      periodEnd: new Date("2025-06-30T00:00:00.000Z"),
      filedAt: new Date("2025-06-14T09:00:00.000Z"),
    });
    assert.deepEqual(keys, [
      "feeds/NSE/results-xbrl/2025/06/A_1.xml",
      "feeds/NSE/results-xbrl/current/A_1.xml",
    ]);
  });

  it("a null filedAt (a modern Revision) still yields the periodEnd key", () => {
    // 1,247 of 90,188 prod rows carry an explicit null `filedAt`: NSE's
    // Revisions state their date in `revised_Date` instead. A derivation that
    // needed `filedAt` would strand every one of them.
    const keys = candidateArchiveKeysForFiling({
      sourceUrl: "https://nsearchives.nseindia.com/corporate/xbrl/B_2.xml",
      periodEnd: new Date("2024-09-30T00:00:00.000Z"),
      filedAt: null,
    });
    assert.deepEqual(keys, [
      "feeds/NSE/results-xbrl/2024/09/B_2.xml",
      "feeds/NSE/results-xbrl/current/B_2.xml",
    ]);
  });

  it("the QUARTERLY row and its ANNUAL companion resolve to ONE object", () => {
    // Both rows share `sourceUrl` AND `periodEnd` — measured on the EMAMILTD
    // fixture above, which is stored twice. That is what makes re-parsing a
    // document idempotent no matter which of its rows the page selected.
    const q = candidateArchiveKeysForFiling(PROD_CASES[0]!.row);
    const a = candidateArchiveKeysForFiling({ ...PROD_CASES[0]!.row });
    assert.deepEqual(q, a);
  });

  it("the prefix is IST-derived, not UTC (MONEY-1157)", () => {
    // `buildFeedArchiveKey` converts through `toIstDateKey`, so a Date at or
    // past 18:30 UTC on a month's last day belongs to the NEXT month. Pinned
    // here because the grammar is frozen: a "fix" back to getUTCMonth would
    // orphan every object filed across that boundary.
    const keys = candidateArchiveKeysForFiling({
      sourceUrl: "https://nsearchives.nseindia.com/corporate/xbrl/C_3.xml",
      periodEnd: new Date("2025-07-31T19:00:00.000Z"),
      filedAt: null,
    });
    assert.equal(keys[0], "feeds/NSE/results-xbrl/2025/08/C_3.xml");
  });

  it("a query string is folded into the basename, never dropped", () => {
    // Two URLs differing only in their query must not collapse onto one key.
    const keys = candidateArchiveKeysForFiling({
      sourceUrl: "https://nsearchives.nseindia.com/corporate/xbrl/D_4.xml?v=2",
      periodEnd: new Date("2025-03-31T00:00:00.000Z"),
      filedAt: null,
    });
    assert.notEqual(keys[0], "feeds/NSE/results-xbrl/2025/03/D_4.xml");
    assert.match(keys[0]!, /^feeds\/NSE\/results-xbrl\/2025\/03\/D_4/);
  });

  it("the feed slug is the one the WRITER uses", () => {
    // One constant, two readers. A second copy of it would not be a bug to fix
    // but ~66,950 objects to migrate.
    assert.equal(XBRL_FEED_SLUG, "results-xbrl");
    const src = readFileSync(
      join(import.meta.dirname, "../../src/processors/xbrl-sync.ts"),
      "utf8",
    );
    // The fetch that WRITES the object builds its descriptor from the same
    // imported constant rather than from a literal.
    assert.match(src, /feed: XBRL_FEED_SLUG/);
    assert.ok(
      !/XBRL_FEED_SLUG = "/.test(src),
      "xbrl-sync.ts must import the slug, not re-declare it",
    );
  });
});
