/**
 * Is an `xbrl-sync` run healthy? — MONEY-1200.
 *
 * Pure. No I/O, no clock. The whole reason this is its own module is that the
 * defect it exists to catch was a JUDGEMENT bug, not a parsing bug, and a
 * judgement that lives inline in an I/O processor is a judgement nobody tests.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## What went wrong
 *
 * Measured on prod, 2026-08-14, from one run's own result object:
 *
 *     listed: 1866   downloaded: 1500   unparseable: 1499   fetchFailed: 1
 *     written: 0     skippedExisting: 0  stubbed: 0   rejected: 0   noPeriod: 0
 *     ok: true
 *
 * The job downloaded 1,500 well-formed filings, understood none of them (a
 * taxonomy mismatch — see `xbrl-financials-logic.ts`), wrote nothing, and
 * reported SUCCESS. `xbrl_filings` was empty for months while the daily log
 * line said the run was fine.
 *
 * `ok` was initialised to `true` and only ever cleared when the INDEX was
 * unreadable. Everything downstream of the index — every document — could fail
 * without touching it. That is the MONEY-1189 wrong-granularity class exactly:
 * a completeness check asserted at the wrong level reports SUCCESS while the
 * thing it is supposed to be checking is entirely absent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Why a plain `written > 0` check would NOT have worked
 *
 * The obvious guard — "fail if nothing was written" — is wrong in both
 * directions here:
 *
 *   - FALSE ALARM: the trailing window is deliberately overlapping, so a normal
 *     re-run legitimately writes 0 and skips everything as `skippedExisting`.
 *     A guard that fires on that gets muted within a week.
 *   - FALSE CALM: one parseable filing among 1,500 broken ones writes 1 row and
 *     satisfies the guard. That is within a rounding error of the actual
 *     failure.
 *
 * So the guard is on the RATIO of documents we could not make sense of to
 * documents we actually read, and it counts the healthy outcomes as healthy.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## Governance filings are NOT failures
 *
 * ~6% of a live window (29 of 500 measured 2026-08-14) are
 * `INTEGRATED_FILING_GOVERNANCE` — board composition, committee meetings,
 * investor complaints. They carry no financial concepts BY DESIGN. Counting
 * them as `unparseable` would put a permanent ~6% floor under the failure
 * ratio, which forces the threshold up above the noise and blunts exactly the
 * signal this module exists to give. They are `nonFinancial`, and they are
 * subtracted from the numerator, not from the denominator: they were read and
 * understood.
 */

import {
  buildFeedArchiveKey,
  eraForDate,
  INTEGRATED_FILING_ERA_START,
} from "@usemoney/core/market-data";
import type {
  XbrlDocumentOutcome,
  FilingIndexEntry,
  FilingIndexEra,
  FilingExchange,
} from "@usemoney/core/market-data";

/* -------------------------------------------------------------------------- */
/* WHICH INDEXES a window must be walked against — MONEY-1250                 */
/* -------------------------------------------------------------------------- */

/**
 * The last instant at which the LEGACY index may still be serving financial
 * results, EXCLUSIVE. Nothing before this is "post-regime enough" to trust the
 * modern index alone.
 *
 * ## The quarter that was unreachable
 *
 * Measured on prod 2026-08-26, `xbrl_filings` by `periodEnd`:
 *
 *     2024-09-30   2,717 filings
 *     2024-12-31       0 filings      <- an ENTIRE results quarter
 *     2025-03-31   7,561 filings
 *
 * ~3,895 documents across ~2,540 symbols, absent, with every nightly run and
 * every backfill window reporting success.
 *
 * The cause is a seam, not a parser. Walking NSE's own indexes for Jan-Mar 2025
 * returns **3,901 records / 3,895 XMLs from the LEGACY index** — families
 * INDAS, BANKING and NBFC_INDAS, ~3,822 of them carrying `qe_Date` 2024-12-31 —
 * i.e. the Dec-2024 quarter was broadcast through the OLD index for a full
 * quarter after `INTEGRATED_FILING_ERA_START` (2025-01-01). Over the same
 * months the MODERN index carries governance filings and nothing else. Prod's
 * own log says it plainly (execution `vwmjv`, 2026-08-20):
 *
 *     2025-01: listed 831, written 0, non-financial 831
 *
 * Era selection walked BOTH indexes only when a window STRADDLED the boundary,
 * and `scripts/jobs/xbrl-backfill.ts` generates whole-MONTH windows, which
 * never straddle anything. So every 2025 window walked integrated-only and the
 * legacy tail was unreachable BY CONSTRUCTION — no error, no counter, no gap
 * anybody could see.
 *
 * ## Why an OVERLAP and not a moved boundary
 *
 * `INTEGRATED_FILING_ERA_START` is not wrong: from 2025-01 the modern index
 * genuinely does serve — that is where the governance filings are, and where
 * `xbrl-sync` finds the current quarter. Moving the constant would trade this
 * gap for its mirror image. Both indexes are LIVE across these months, so both
 * get walked. Duplicates are free: the entries are deduplicated on
 * `symbol|xbrlUrl` before download, and the `XbrlFiling` upsert key makes a
 * re-write idempotent.
 *
 * ## Where the END came from, and why it is past the last measured month
 *
 * Measured, both directions:
 *
 *   - LEGACY still serving financials through **2025-03** (the 3,901 records
 *     above; "at least 2025-03" is a floor — the walk stopped there);
 *   - MODERN serving financials from **2025-04** (3,302 records listed, against
 *     831 all-governance in 2025-01), and prod holds 7,561 rows for periodEnd
 *     2025-03-31 — a quarter that could only have arrived through the modern
 *     index. The committed fixtures agree: every record in
 *     `nse-integrated-index-2025-06-*.json` is `Integrated Filing- Financials`
 *     for `qe_Date` 31-MAR-2025.
 *
 * That puts the true crossover at 2025-04. The overlap deliberately runs one
 * quarter PAST it, to 2025-06-30 inclusive, because the two errors are not
 * symmetric:
 *
 *   - too SHORT -> a silently missing quarter. That is this defect.
 *   - too LONG  -> at most 2 extra index reads per window (the legacy index
 *                  takes `?period=` and does not page), for at most 6 windows,
 *                  returning records we already have.
 *
 * A late filer of the Dec-2024 quarter broadcasting in April or May is exactly
 * the record a short overlap would drop, and it would drop it invisibly.
 * 2025-06-30 also makes true what `INTEGRATED_FILING_ERA_START`'s own docstring
 * has claimed all along — "the backfill walks BOTH indexes across 2024-10 ->
 * 2025-06" — which was a description of intent that no code path implemented.
 *
 * The one real cost: a window in the overlap now makes an extra index call, and
 * `collectIndex` returning null (throttle, challenge page, transport) aborts
 * the run with `ok=false`. That is the same exposure the straddle path has
 * always carried, and it is a LOUD retriable failure rather than a silent gap.
 */
export const LEGACY_FINANCIALS_OVERLAP_END = Date.UTC(2025, 6, 1);

/**
 * Which index or indexes a window must be walked against, oldest era first.
 *
 * Three cases, and the third is the one MONEY-1250 added:
 *
 *   1. the window STRADDLES `INTEGRATED_FILING_ERA_START` -> both, as before;
 *   2. the window lies inside the OVERLAP PERIOD (era start .. 2025-06-30) ->
 *      both, because the legacy index is still broadcasting financial results
 *      there and the modern one is only broadcasting governance;
 *   3. otherwise -> the single era that serves it.
 *
 * Order is `["legacy", "integrated"]` and never the reverse. The final write
 * order is fixed by `orderFilingsForWrite` regardless, but era is that
 * comparator's FIRST key, so collecting in the same order keeps the stream it
 * sorts already roughly ordered rather than reversed.
 *
 * A non-finite bound returns BOTH eras. An undatable window must never resolve
 * to a confident single index: `eraForDate` reads a NaN clock as "legacy"
 * (because `NaN >= start` is false), so the silent answer would be the wrong
 * one, and the loud answer costs one extra index read on a window that is
 * already malformed.
 */
export function erasForWindow(from: Date, to: Date): FilingIndexEra[] {
  const BOTH: FilingIndexEra[] = ["legacy", "integrated"];
  const fromMs = from.getTime();
  const toMs = to.getTime();
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return BOTH;

  if (eraForDate(from) !== eraForDate(to)) return BOTH;

  // Intersection with [ERA_START, OVERLAP_END). Half-open on purpose: an
  // inclusive end invites a fencepost on the last millisecond of 2025-06-30,
  // which would be invisible in exactly the way this whole function exists to
  // stop being invisible.
  const touchesOverlap =
    toMs >= INTEGRATED_FILING_ERA_START &&
    fromMs < LEGACY_FINANCIALS_OVERLAP_END;
  if (touchesOverlap) return BOTH;

  return [eraForDate(to)];
}

/**
 * Which counter a parse outcome moves.
 *
 * Pure, and separated from the I/O processor on purpose: mis-wiring ONE arm of
 * this switch re-creates the original defect in a form no parser test can see.
 * Route governance to `unparseable` and every healthy run reads as 6% broken;
 * route `unknown-taxonomy` to `nonFinancial` and a total taxonomy failure reads
 * as a quiet week. Both are one line, and both look like a passing build.
 */
export type XbrlOutcomeBucket =
  | "financials"
  | "nonFinancial"
  | "unmappedFamily"
  | "unknownTaxonomy"
  | "noPeriod"
  | "unparseable";

/**
 * Known-NON-FINANCIAL filing types, recognisable from the URL alone — MONEY-1250.
 *
 * ## Why this exists: the download budget could not converge
 *
 * `MAX_DOWNLOADS_PER_RUN` is a per-window cap. A governance filing is
 * downloaded, classified `nonFinancial`, and then NOT STORED — so the next run's
 * `skippedExisting` check, which keys on `(symbol, exchange, sourceUrl)` in
 * `xbrl_filings`, cannot skip it. It gets downloaded again. And again.
 *
 * That is harmless while a window is mostly unfetched, and fatal once it is
 * mostly done: as the financial filings get stored and skipped, the un-stored
 * remainder becomes almost pure governance, so the whole budget goes to
 * re-downloading files that will never be recorded. Measured on prod
 * 2026-08-24, two consecutive runs of the 2025-04 window:
 *
 *     run 1  listed 3302  skippedExisting 280  downloaded 1500  nonFinancial 1466
 *     run 2  listed 3302  skippedExisting 269  downloaded 1500  nonFinancial 1454
 *
 * `skippedExisting` went DOWN and `downloaded` stayed pinned at the cap. The
 * job's own advice — "Re-run; already-stored filings are skipped before
 * download" — is true and does not help, because these are never stored. By
 * contrast 2025-05, whose remainder was still mostly financial, converged in one
 * further run (`skippedExisting` 2140 -> 2812, `truncatedByBudget` false).
 *
 * ## Why a DENY list and not an allow list
 *
 * An allow list of financial prefixes would silently drop a filing type NSE
 * adds later — the worst possible failure for a backfill, because the absence
 * looks exactly like "the company did not file". A deny list can only ever skip
 * what it names: an unrecognised prefix is downloaded and classified exactly as
 * it is today, and `bucketForOutcome` remains the authority on what a document
 * turned out to be.
 *
 * Measured before shipping: of 20,000 stored filings, ZERO carry a
 * `INTEGRATED_FILING_GOVERNANCE` prefix. Every one is INDAS,
 * INTEGRATED_FILING_INDAS, NBFC_INDAS, INTEGRATED_FILING_NONINDAS or
 * INTEGRATED_FILING_BANKING. So this cannot skip anything we would have kept.
 *
 * ## EARLY-INTEGRATED governance filings carry NO family token at all
 *
 * The prefix above covers governance filings as NSE names them today. It does
 * not cover how NSE named them when the integrated index opened. Measured
 * 2026-08-26 against the live index and the prod feed archive:
 *
 *   - the integrated index's Jan-Mar 2025 records include **2,375** documents
 *     named `INTEGRATED_FILING_{seq}_{ts}_WEB.xml` — a DIGIT straight after the
 *     second underscore, no `GOVERNANCE`, no `INDAS`, no family word anywhere;
 *   - a second, independent count found **2,354** such objects already in GCS,
 *     100% of them under the `2024/12` archive prefix (i.e. the Dec-2024
 *     quarter);
 *   - one was fetched and read end to end (VRLLOG, 131,896 bytes): pure
 *     `in-capmkt` IntegratedGovernance XBRL, ZERO financial concepts.
 *
 * This matters far more than 2,375 documents normally would, because those
 * months are exactly the ones `erasForWindow` has just made reachable. Without
 * this arm, every re-run of a Jan-Mar-2025 window would spend its download
 * budget on ~2,375 files that can never be stored and therefore can never be
 * skipped — the non-convergent shape described above, reproduced in the one
 * quarter this ticket exists to recover.
 *
 * ## Why `\d` and not a wider prefix
 *
 * A broader `INTEGRATED_FILING` prefix would deny `INTEGRATED_FILING_INDAS_*`,
 * `_BANKING_`, `_NBFC_INDAS_` and `_NONINDAS_` — which is EVERY modern
 * financial filing, i.e. the entire reason the job exists. The digit is what
 * separates them: a family token always begins with a letter, and the tokenless
 * form always begins with the sequence number. That distinction is asserted
 * directly by the unit tests, on all four family names.
 */
const NON_FINANCIAL_URL_PREFIXES = ["INTEGRATED_FILING_GOVERNANCE"] as const;

/**
 * The tokenless early-integrated governance filename, anchored at the basename.
 *
 * `INTEGRATED_FILING_1477411_20250114...` matches; `INTEGRATED_FILING_INDAS_…`
 * does not, because `INDAS` is not a digit. Anchored with `^` so a financial
 * filing whose name merely CONTAINS the token is untouched.
 */
const TOKENLESS_INTEGRATED_GOVERNANCE = /^INTEGRATED_FILING_\d/;

/**
 * True when the URL's own filename says this document carries no financials.
 *
 * Deliberately conservative: matches on the filename's leading token only, so a
 * governance filing is recognised and everything else — including anything
 * unrecognised — falls through to be downloaded and classified as before.
 */
export function isNonFinancialFilingUrl(url: string): boolean {
  const base = url.split("/").pop() ?? "";
  if (TOKENLESS_INTEGRATED_GOVERNANCE.test(base)) return true;
  return NON_FINANCIAL_URL_PREFIXES.some((p) => base.startsWith(`${p}_`));
}

export function bucketForOutcome(
  kind: XbrlDocumentOutcome["kind"],
): XbrlOutcomeBucket {
  switch (kind) {
    case "financials":
      return "financials";
    // HEALTHY. Governance filings have no numbers by design.
    case "non-financial":
      return "nonFinancial";
    // A KNOWN gap, and its own counter for exactly that reason — MONEY-1220.
    //
    // It is not `unknownTaxonomy`: nothing about a General Insurance filing is
    // unknown, so putting it in the failure numerator makes the nightly run
    // report a defect that no code change will ever clear, and — on a catch-up
    // window that happens to hold only insurance filings — trips
    // `notUnderstood === readable` and fails a perfectly correct run.
    //
    // It is not `nonFinancial` either: that bucket asserts "no numbers by
    // design", and these filings carry real ones we have chosen not to read.
    // Collapsing it there would retire the warning by making a false claim, and
    // the gap would vanish from the counters on the day it became closeable.
    case "unmapped-family":
      return "unmappedFamily";
    // Both unknown shapes are the SAME failure at different depths — a
    // namespace we were never taught, or an entry point under a namespace we
    // were. Splitting them in the counters would let a threshold catch one and
    // miss the other.
    case "unknown-taxonomy":
    case "unknown-entry-point":
      return "unknownTaxonomy";
    case "no-period":
      return "noPeriod";
    case "not-xbrl":
      return "unparseable";
  }
}

/** The parse-outcome tallies a run produces. Only these steer the verdict. */
export interface XbrlParseTally {
  /** Documents whose bytes we asked for. */
  downloaded: number;
  /** …of which the transport failed (timeout, 404, challenge page). */
  fetchFailed: number;
  /** Recognised as a filing that legitimately carries no financials. */
  nonFinancial: number;
  /** Bytes arrived, but nothing in them was a recognisable XBRL instance. */
  unparseable: number;
  /** A well-formed instance in a taxonomy or entry point we cannot read. */
  unknownTaxonomy: number;
  /** Parsed, but with no resolvable reporting period, so not storable. */
  noPeriod: number;
  /**
   * Parsed and DATED, but the span matches no known period band — MONEY-1114.
   *
   * OPTIONAL so every existing caller and test keeps compiling, but it belongs
   * in the numerator for the same reason `noPeriod` does: it is a document that
   * arrived, was understood as XBRL, and stored nothing. A taxonomy change that
   * made every span read as, say, 200 days would write zero rows across a whole
   * run and — without this — report perfect health, which is precisely the
   * MONEY-1200 shape this verdict exists to catch.
   */
  unclassifiedPeriod?: number;
}

export interface XbrlParseHealth {
  ok: boolean;
  /** Documents whose bytes we actually read. The denominator. */
  readable: number;
  /** Read but not made sense of. The numerator. */
  notUnderstood: number;
  /** `notUnderstood / readable`, or 0 when nothing was readable. */
  ratio: number;
  /** Human-readable cause when `ok` is false; `null` when it is true. */
  reason: string | null;
}

/**
 * Fail when more than this share of readable documents was not understood.
 *
 * **10%.** Justified from both ends rather than picked:
 *
 *   - The floor it must sit ABOVE. In a healthy run the only legitimately
 *     not-understood documents are individually malformed ones — a truncated
 *     upload, a filer's generator emitting an instance with no contexts. Those
 *     are single-digit counts against the ~470 financial filings a normal
 *     earnings day carries (measured: 471 of 500 records in one live window),
 *     i.e. well under 2%. Governance filings, the one large legitimate class,
 *     do not enter the numerator at all.
 *   - The ceiling it must sit BELOW. The failure it exists to catch is a whole
 *     taxonomy going unread: 1,499/1,500 = 99.9%. Every failure of that shape —
 *     a new SEBI entry point, a namespace version bump we have not mapped, an
 *     era switchover — is a large fraction by construction, because taxonomies
 *     change for everyone at once.
 *
 * 10% is roughly 5x above the noise and 10x below the signal, so it is tuned to
 * neither edge, and no plausible small perturbation of either estimate moves
 * the verdict.
 */
export const MAX_NOT_UNDERSTOOD_SHARE = 0.1;

/**
 * Below this many readable documents the RATIO is not evidence.
 *
 * A quiet day (a holiday, a mid-quarter Tuesday) can produce three filings, and
 * one malformed one out of three is 33% — a red run caused by arithmetic, not
 * by a defect. 20 sits below the ~470 a normal earnings day carries and above
 * the handful a quiet day does.
 *
 * It is a floor on the RATIO test only, never a licence to pass: see the
 * total-failure rule in {@link judgeXbrlParseHealth}, which has no minimum.
 * "Read some documents, understood NONE of them" is the exact shape of the
 * defect and must fail at any sample size — otherwise a small window becomes a
 * blind spot, and small windows are what a catch-up run uses.
 */
export const MIN_READABLE_FOR_RATIO = 20;

export function judgeXbrlParseHealth(t: XbrlParseTally): XbrlParseHealth {
  // Transport failures are NOT counted against parse health. A 404 on a filing
  // NSE broadcast minutes ago is routine — measured 3 of 9 on documents indexed
  // within the hour — and the trailing window re-reads it tomorrow. Folding
  // them in would make the guard fire on the exchange's publishing latency.
  const readable = Math.max(0, t.downloaded - t.fetchFailed);
  // `unmappedFamily` is absent from this sum on purpose — MONEY-1220. A General
  // Insurance filing was read and identified exactly; what we declined to do is
  // map its concepts. That is a standing product gap, not a parse failure, and
  // no run should be able to fail because the market filed insurance results.
  const notUnderstood =
    t.unparseable +
    t.unknownTaxonomy +
    t.noPeriod +
    (t.unclassifiedPeriod ?? 0);
  const ratio = readable === 0 ? 0 : notUnderstood / readable;

  if (readable === 0) {
    // Nothing was read, so nothing can be said about the parser. Not a parse
    // failure — the index/transport counters carry that story.
    return { ok: true, readable, notUnderstood, ratio, reason: null };
  }

  // Total failure, at ANY sample size. This is the observed defect's shape.
  if (notUnderstood === readable) {
    return {
      ok: false,
      readable,
      notUnderstood,
      ratio,
      reason:
        `understood NONE of the ${readable} documents read — ` +
        `every one was unparseable, an unknown taxonomy, or undateable`,
    };
  }

  if (readable >= MIN_READABLE_FOR_RATIO && ratio > MAX_NOT_UNDERSTOOD_SHARE) {
    return {
      ok: false,
      readable,
      notUnderstood,
      ratio,
      reason:
        `${notUnderstood}/${readable} (${(ratio * 100).toFixed(1)}%) of the ` +
        `documents read were not understood, over the ` +
        `${(MAX_NOT_UNDERSTOOD_SHARE * 100).toFixed(0)}% limit`,
    };
  }

  return { ok: true, readable, notUnderstood, ratio, reason: null };
}

/**
 * Should Pub/Sub retry this run? — i.e. does the route answer 500 or 200.
 *
 * ## Why the failure CLASS has to decide, now that `ok` can be false
 *
 * The route used to answer 500 for every `!ok`, and `!ok` only ever meant "the
 * index was unreadable" — a transient failure, cheap to retry, which fails in
 * one HTTP call before any document is downloaded. Retrying that is right.
 *
 * Making `ok` false on parse health (the point of MONEY-1200) puts a
 * DETERMINISTIC failure on the same wire. A taxonomy we cannot read will fail
 * identically on every attempt, and each attempt re-downloads up to
 * `MAX_DOWNLOADS_PER_RUN` XMLs from `nsearchives.nseindia.com` — 1,500 of them,
 * one every 600 ms. Worse, a deterministic parse failure writes NOTHING, so the
 * `skippedExisting` short-circuit that normally makes a re-run nearly free does
 * not engage: every retry pays the full download cost again. Left as a 500, the
 * fix for a silent failure would have become a retry storm against the
 * exchange.
 *
 * Nothing is lost by acking. The trailing 7-day window re-reads the index and
 * re-downloads every filing not already in `xbrl_filings`, so once the concept
 * table is taught the next scheduled run picks up everything the failed run
 * dropped. The 500 was never the healing mechanism — the window is. What the
 * 500 WAS doing is alerting, and that job now belongs to the `PARSE HEALTH
 * FAILURE` error line, which is greppable and does not cost NSE 1,500 requests
 * per alert.
 *
 * ## The retry shape has a SECOND problem this does not fix
 *
 * Measured from `setup-pubsub.sh`: `--ack-deadline=600`,
 * `--max-delivery-attempts=5`, `--min-retry-delay=10s --max-retry-delay=600s`.
 * Against that, `MAX_DOWNLOADS_PER_RUN × DOWNLOAD_DELAY_MS` = 1500 × 600 ms =
 * **900 s of sleeping alone**, before 1,500 HTTP round trips and 1,500 indexed
 * reads. A full run cannot finish inside a 600 s ack deadline, so Pub/Sub
 * redelivers while the first attempt is still running and each redelivery
 * starts another full pass. That is the likelier explanation for ~11
 * deliveries in 57 minutes than a NACK chain, which `max-delivery-attempts=5`
 * caps at five. 600 s is Pub/Sub's MAXIMUM push ack deadline, so the only lever
 * is a shorter run: see the note on `MAX_DOWNLOADS_PER_RUN`.
 */
export function isRetriableFailure(run: {
  ok: boolean;
  parseHealthFailure: string | null;
}): boolean {
  if (run.ok) return false;
  // A parse-health failure is deterministic — the same bytes will fail the same
  // way on every attempt. Everything else that clears `ok` is transport.
  return run.parseHealthFailure === null;
}

/**
 * Which IST calendar day an XBRL filing is archived under — MONEY-1204 (P0.2).
 *
 * Pure, and its own function BECAUSE the choice is a judgement rather than a
 * lookup: `getFeedAsset` turns this date into the `{YYYY}/{MM}` segment of the
 * archive key, and the key grammar is frozen (~66,950 objects per bucket), so
 * getting it wrong is not a bug you fix — it is objects you migrate.
 *
 * ## The rule
 *
 *     quarterEnd  ->  broadcastAt  ->  undated (`current/`)
 *
 * ## Why the FILING's own day and not the FETCH day
 *
 * A fetch day is not a property of the filing. Re-running the same window a
 * month later would compute a different key for the same immutable document,
 * so the archive would accumulate a second copy under a second prefix, a replay
 * would MISS the first one, and — decisively — nothing stored in `XbrlFiling`
 * records when we fetched, so a later reader holding the row could not
 * reconstruct the key at all. Keying on the filing makes the key a pure
 * function of the filing: idempotent, reproducible, and derivable from the row.
 *
 * ## Why quarterEnd FIRST, when `filedAt` is the field we store
 *
 * Two reasons, one measured and one about what the key MEANS.
 *
 * Measured across the five committed index fixtures (118 records, both eras):
 * `qe_Date`/`toDate` is present on 118/118, while `broadcast_Date` is null on
 * 3 of the 20 modern records — NSE's Revisions carry no broadcast date. A
 * primary key field that is absent 15% of the time on the CURRENT index is not
 * a primary.
 *
 * And MONEY-1189's lesson is that an archive key's day and its data's day
 * diverge exactly when it matters. `quarterEnd` IS the data's day: every object
 * under `feeds/NSE/results-xbrl/2025/12/` is a filing FOR the quarter ending
 * Dec-2025, whenever NSE happened to broadcast it. Broadcast day would instead
 * scatter one quarter's filings across three months and file a late Revision of
 * a 2024 quarter under 2026 — the divergence, reintroduced.
 *
 * ## Why `undefined` rather than a substitute when both are absent
 *
 * `current/` is the grammar's existing, distinct "this artifact has no day"
 * value, and an honest "undated" beats a confident wrong month — the same rule
 * as never persisting a fail-open default. Basenames here are per-filing
 * unique, so an undated object can never overwrite another filing's bytes; it
 * is simply filed where a reader can see it was not datable. Not measured in
 * any fixture (0 of 118), so this arm is a guard, not a path.
 */
export function archiveDayForFiling(entry: {
  quarterEnd: Date | null;
  broadcastAt: Date | null;
}): Date | undefined {
  return entry.quarterEnd ?? entry.broadcastAt ?? undefined;
}

/* -------------------------------------------------------------------------- */
/* The ANNUAL companion period — MONEY-1114                                   */
/* -------------------------------------------------------------------------- */

/**
 * Which of a document's non-primary periods is the full financial year.
 *
 * A March-quarter filing declares the quarter (`OneD`, ~90 days) and the year
 * (`FourD`, 364-366 days) as two undimensioned contexts sharing an end date.
 * The parser's primary rule takes the quarter, correctly; this picks the year
 * out of what it left behind so a second row can be written from the same bytes.
 *
 * ## Three answers, and two of them are refusals
 *
 * `none` is the COMMON case and is not a problem: a Q1 filing's year-to-date
 * column IS its quarter, so it declares no second period at all. Measured on
 * prod 2026-08-19 — 2,127 of 2,152 stored rows have periodEnd 2026-06-30, i.e.
 * a Q1 filing, and none of them can yield an annual row.
 *
 * `ambiguous` is a refusal by design. Two full-year candidates means the
 * document declares the current year and a prior-year comparative as separate
 * undimensioned periods, and nothing here can say which one the filer's own
 * "current" column is. Picking the first would store a prior year's figures
 * under this year's key, which is unrecoverable once written and looks entirely
 * normal. A counted refusal is the only safe answer.
 *
 * Pure: takes only the resolved period metadata, so it can be tested against
 * real documents without a database or a network.
 */
export type AnnualCompanionPick =
  | { kind: "found"; contextRef: string }
  | { kind: "none" }
  | { kind: "ambiguous"; contextRefs: string[] };

export function pickAnnualCompanion(
  otherPeriods: readonly { days: number; contextRef: string }[],
  isAnnualSpan: (days: number) => boolean,
): AnnualCompanionPick {
  const hits = otherPeriods.filter((p) => isAnnualSpan(p.days));
  if (hits.length === 0) return { kind: "none" };
  if (hits.length > 1) {
    return { kind: "ambiguous", contextRefs: hits.map((h) => h.contextRef) };
  }
  return { kind: "found", contextRef: hits[0]!.contextRef };
}

/* -------------------------------------------------------------------------- */
/* WRITE ORDER — the newest filing for a period must win. MONEY-1235.          */
/* -------------------------------------------------------------------------- */

/**
 * Order index entries so that, for any `XbrlFiling` unique key, the NEWEST
 * filing is upserted LAST.
 *
 * ## The bug this exists to remove
 *
 * `XbrlFiling`'s unique key is
 * `(symbol, exchange, periodEnd, periodType, basis, cumulative)` and
 * deliberately EXCLUDES `sourceUrl` — a corrected filing republished at a new
 * URL must UPDATE the period, not fork it. The download loop's pre-download
 * skip, however, IS keyed on `sourceUrl`. So when NSE serves an Original and
 * its Revision inside the same window:
 *
 *   - neither matches the other's stored `sourceUrl`, so BOTH are downloaded;
 *   - both upsert onto the SAME row;
 *   - whichever the loop reaches LAST is the one that survives.
 *
 * The modern index is served newest-first, so "last" was the OLDEST — the run
 * ended every night with the superseded Original in the row, and every night
 * re-downloaded both to arrive back there. No counter moves. No log line. The
 * only visible symptom is a `sourceUrl` that keeps changing.
 *
 * ## Why the key is a SEQUENCE and not `type_Sub`
 *
 * "Process Revisions after Originals" is the obvious rule and it is not
 * sufficient. `integrated-capped-20.sample.json` — 20 verbatim records — holds
 * JAINREC's 31-DEC-2025 standalone period as TWO Revisions and NO Original:
 * seq 143649 (creation 22:41:14) at index 12 and seq 143646 (22:36:37) at
 * index 15. A kind-based rule leaves those two in the order the index returned
 * them, which is newest-first, so the EARLIER revision still wins. Only a
 * monotonic key separates them.
 *
 * The two available monotonic signals AGREE on the real data, which is why one
 * can be trusted as the primary: in the same fixture TAKE files seq 143647 at
 * 22:38:14 and seq 143648 at 22:38:19 — sequence ascending, creation time
 * ascending, together.
 *
 * ## And why the raw index order cannot simply be reversed
 *
 * It is not monotonic. In that same 20-record capture indices 13 and 14 are
 * seq 143647 then 143648 — ASCENDING, inside an otherwise descending list. The
 * legacy samples are not monotonic in either direction. "Reverse the array" is
 * therefore not a fix, it is a different arbitrary order.
 *
 * ## The invariant
 *
 * **For a given `XbrlFiling` unique key, the newest filing wins regardless of
 * the order the index returned its records in.** Proven, rather than asserted,
 * by feeding the fixture pair in BOTH orders and requiring the same last write.
 *
 * ## What this does NOT do
 *
 * It does not drop the superseded sibling. Grouping by the unique key is not
 * possible here: `periodType` and `cumulative` come from the DOCUMENT (see
 * `storeFiling`), which has not been downloaded yet, so any grouping done at
 * index time is a guess about a key we cannot compute. Dropping on a guess
 * risks losing a filing; ordering on a fact cannot. The cost is that a revised
 * period is downloaded twice per run — 3 of 20 records in one capture, 16 of 20
 * in another — and the row passes transiently through the Original before
 * landing on the Revision.
 */
export function orderFilingsForWrite(
  entries: readonly FilingIndexEntry[],
): FilingIndexEntry[] {
  return [...entries].sort(compareFilingWriteOrder);
}

/**
 * Oldest-first total order over index entries.
 *
 * Four keys, and every one of them is needed:
 *
 *   1. **era** — legacy before integrated. The eras are ordered in time by
 *      construction (`INTEGRATED_FILING_ERA_START`), and this ALSO stops key 2
 *      being compared across them: legacy sequences run 1,03x,xxx-1,18x,xxx and
 *      modern ones 9x,xxx-14x,xxx, so a raw numeric compare would sort a 2019
 *      legacy row after a 2026 modern one.
 *   2. **indexSequence** — the authority within an era. `null` sorts FIRST, so
 *      a record we cannot place in time can be overwritten by one we can, never
 *      the reverse.
 *   3. **timestamp** (`createdAt ?? revisedAt ?? broadcastAt`) — the tie-break
 *      when sequences are equal or both absent, and the only key a legacy
 *      record has beyond its sequence.
 *   4. **xbrlUrl** — makes the order TOTAL. Without it two records identical in
 *      keys 1-3 sort by whatever the engine's sort happens to do, and the whole
 *      point of this function is that the outcome does not depend on that.
 */
export function compareFilingWriteOrder(
  a: FilingIndexEntry,
  b: FilingIndexEntry,
): number {
  const eraDelta = cmpNum(eraRank(a.era), eraRank(b.era));
  if (eraDelta !== 0) return eraDelta;

  const seqDelta = cmpNum(
    sequenceRank(a.indexSequence),
    sequenceRank(b.indexSequence),
  );
  if (seqDelta !== 0) return seqDelta;

  const tsDelta = cmpNum(filingWriteTimestamp(a), filingWriteTimestamp(b));
  if (tsDelta !== 0) return tsDelta;

  return a.xbrlUrl < b.xbrlUrl ? -1 : a.xbrlUrl > b.xbrlUrl ? 1 : 0;
}

/**
 * Ordering by COMPARISON, never by subtraction.
 *
 * `a - b` is the idiomatic comparator body and it is wrong for every key here,
 * because two of the three carry -Infinity for "this record states no value":
 * `-Infinity - -Infinity` is **NaN**, `NaN !== 0` is true, so the subtraction
 * form RETURNS NaN from the comparator. `Array.prototype.sort` treats that as
 * "leave them alone", and two dateless, unsequenced records keep whatever order
 * the index happened to serve them in — which is the exact defect this whole
 * module exists to remove, wearing a different hat.
 *
 * Written down because it was committed and caught by
 * `is a TOTAL order — identical entries still sort deterministically`, not by
 * review. `a < b` / `a > b` are both false for two equal infinities, so this
 * returns 0 and the next key gets its turn.
 */
function cmpNum(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function eraRank(era: FilingIndexEntry["era"]): number {
  return era === "legacy" ? 0 : 1;
}

/**
 * `null` becomes -Infinity, not 0.
 *
 * 0 would sort an unsequenced record among the very earliest REAL sequences
 * rather than definitively before them, and `NaN` — which is what a bare
 * `Number(null ?? undefined)` arithmetic would produce — makes every comparison
 * false and silently turns the sort into a no-op.
 */
function sequenceRank(seq: number | null): number {
  return seq === null ? Number.NEGATIVE_INFINITY : seq;
}

/**
 * The entry's own clock, in the order of decreasing directness.
 *
 * `createdAt` is when NSE created the INDEX ROW, which is the thing being
 * ordered. `revisedAt` is the Revision's own timestamp and is the fallback that
 * matters, because a Revision has a NULL `broadcast_Date`. `broadcastAt` is all
 * a legacy record has.
 *
 * -Infinity when the record carries no date at all, for the same reason as
 * `sequenceRank`: undatable loses, and loses deterministically.
 */
export function filingWriteTimestamp(entry: FilingIndexEntry): number {
  const d = entry.createdAt ?? entry.revisedAt ?? entry.broadcastAt;
  if (d === null) return Number.NEGATIVE_INFINITY;
  const t = d.getTime();
  return Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY;
}

/* -------------------------------------------------------------------------- */
/* The run budget must cover the INDEX PAGING too — MONEY-1235.               */
/* -------------------------------------------------------------------------- */

/**
 * How much of the run's wall-clock budget is left for the DOWNLOAD loop, once
 * index paging has already spent some of it.
 *
 * ## Why the clock cannot start at the download loop
 *
 * `RUN_TIME_BUDGET_MS` is 480 s of the Pub/Sub push subscription's 600 s ack
 * deadline — 600 being Pub/Sub's MAXIMUM, so the deadline cannot be raised —
 * with 120 s kept back for exactly this paging and for the writes that follow.
 * The budget was then measured from AFTER paging, which spends that headroom
 * twice: the nightly 7-day window pages ~3 times and is safe, but the route
 * accepts `windowDays` up to 370, and a catch-up window can page up to
 * `MAX_PAGES` (40) before the budget starts. 40 pages at a 15 s NSE response is
 * 600 s of index reads, and only THEN does a full 480 s download phase begin.
 *
 * Overrunning the deadline does not make the run late. Pub/Sub redelivers the
 * message while the first attempt is still running, so a second complete pass
 * starts concurrently — and against the dedupe middleware's 409-while-leased
 * behaviour each redelivery burns an attempt toward the dead-letter queue.
 *
 * ## Why it returns 0 rather than a floor
 *
 * If paging alone exhausted the budget there is no honest amount of download
 * time left, and inventing a minimum ("always allow 30 s") is how a deadline
 * gets overrun by exactly that minimum. 0 stops the loop on its first check,
 * sets `truncatedByBudget`, and lets the TRAILING WINDOW collect the filings on
 * the next run — which is what the trailing window is for.
 *
 * A negative elapsed (a clock that went backwards) is clamped rather than
 * credited, so it can only ever shorten the budget.
 */
export function downloadBudgetAfterIndexing(
  totalBudgetMs: number,
  indexElapsedMs: number,
): number {
  if (!Number.isFinite(totalBudgetMs) || totalBudgetMs <= 0) return 0;
  const spent = Number.isFinite(indexElapsedMs)
    ? Math.max(0, indexElapsedMs)
    : 0;
  return Math.max(0, totalBudgetMs - spent);
}

/* -------------------------------------------------------------------------- */
/* The archive key for a STORED filing — MONEY-1204 / MONEY-1252              */
/* -------------------------------------------------------------------------- */

/**
 * Feed slug for the archive key: `feeds/NSE/results-xbrl/{YYYY}/{MM}/{basename}`.
 *
 * Declared here and registered in `REPORT_REGISTRY` as `nse-results-xbrl`
 * (`enabled:false`, `buildUrl: () => null`). Disabled is not a contradiction:
 * `report-archive-sync` fetches only `enabledFamilies()`, while `getFeedAsset`
 * never consults the registry at all. Same arrangement as
 * `nse-cm-udiff-bhavcopy`, which `bhavcopy.ts` archives nightly while its
 * registry row is disabled.
 *
 * MOVED here from `xbrl-sync.ts` by MONEY-1252 (which re-exports it, so every
 * existing importer is unchanged). It now has TWO readers that must agree
 * byte-for-byte — the fetch that WRITES the object and
 * {@link candidateArchiveKeysForFiling}, which is the only way to find it again
 * — and a constant with two readers belongs in the module they can both import
 * without dragging Prisma in.
 */
export const XBRL_FEED_SLUG = "results-xbrl";

/**
 * A stored `XbrlFiling` row, reduced to what locating its archived XML needs.
 */
export interface ArchivedFilingRef {
  /** `XbrlFiling.sourceUrl` — the NSE URL the object's basename comes from. */
  sourceUrl: string;
  /** `XbrlFiling.periodEnd`. Non-null in the schema; the primary key input. */
  periodEnd: Date;
  /** `XbrlFiling.filedAt`. Null for a modern Revision. */
  filedAt: Date | null;
}

/**
 * Every archive key a stored row could plausibly be filed under, best first.
 *
 * ## Why a SET and not one key
 *
 * The writer keys on `archiveDayForFiling(entry)` — `quarterEnd ?? broadcastAt`,
 * i.e. the results INDEX's `qe_Date` — and `quarterEnd` is not a stored column.
 * What IS stored is `periodEnd`, taken from the DOCUMENT (`storeFiling`
 * deliberately prefers the document over the index), and `filedAt`, which is
 * `entry.broadcastAt ?? entry.revisedAt`.
 *
 * The two period-ends agree for every filing shape we have seen — a quarter's
 * END is the quarter's end whether the column is the quarter or the
 * year-to-date — but "agree in every case we have seen" is not "cannot differ",
 * and a single-key probe that is wrong reports a MISSING object that is
 * actually present.
 *
 * MEASURED, MONEY-1252, against the live prod bucket: 72 real objects sampled
 * across nine `{YYYY}/{MM}` prefixes from 2018-03 to 2026-06 resolved to 62
 * stored rows (the other 27 objects are governance filings, archived but never
 * stored). All 62 reproduced the object's real key from `periodEnd`, and none
 * needed `filedAt`.
 *
 * **CORRECTED, MONEY-1250: that sample was not representative, and the "62 of
 * 62" it licensed was read as a property of the table.** A full-table
 * measurement found **1,220 rows (823 distinct documents)** whose archived
 * object sits under a `{YYYY}/{MM}` that is **+12 months** off what `periodEnd`
 * derives — concentrated in periodEnd 2017-12 through 2019-09.
 *
 * The cause is a seam between the two writers, not a bug in this function. The
 * archive key comes from `archiveDayForFiling` = the LEGACY index's `qe_Date`,
 * and on those records `qe_Date` carried the PRIOR year, while `storeFiling`
 * deliberately takes `periodEnd` from the DOCUMENT — which states its own,
 * correct, date. Two different sources for what everyone assumed was one fact.
 *
 * DO NOT "fix" the derivation here. Rewriting the first arm to chase the stale
 * year would break the ~94,000 rows it currently resolves, to rescue 1,220; the
 * repair is an in-bucket COPY to the correct key, planned separately. What this
 * note has to do is stop the next reader believing the first arm is exhaustive:
 * those 1,220 rows fall through to `filedAt`, and where that misses too they are
 * counted `archiveMissing` and SKIPPED — visible, recoverable, and a real part
 * of the ~2.1% gap the re-parse job reports rather than an anomaly in it.
 *
 * The general lesson is the one that keeps costing us releases: a sample proves
 * a claim about the SAMPLE. "62 of 62" was true and was never evidence for the
 * table.
 *
 * The cost of being wrong is asymmetric and that is what decides the shape:
 *
 *   - false MISSING  -> the row is counted as un-archived and SKIPPED. In the
 *                       re-parse job that is a row left stale; in the backfill
 *                       it is one redundant NSE fetch. Both are visible and
 *                       recoverable.
 *   - false PRESENT  -> impossible here: a key either returns bytes or it does
 *                       not. The probe cannot invent an object.
 *
 * So the probe is deliberately biased toward TRYING MORE KEYS: three cheap
 * `get`s, and the row is located if ANY of them hits.
 *
 * ## Why `filedAt` second and `undated` third
 *
 * `filedAt` is the stored form of `broadcastAt`, which is `archiveDayForFiling`'s
 * OWN second arm — so a row whose index record carried no `qe_Date` is filed
 * under exactly this key. The undated arm covers `archiveDayForFiling` returning
 * `undefined` (neither date on the index record), which
 * `buildFeedArchiveKey` files under `current/`. Measured 0 of 118 across the
 * committed index fixtures, so it is a guard rather than a path — but a guard
 * that costs one `get` and closes the last way to miss an object we hold.
 *
 * Deduplicated, because `periodEnd` and `filedAt` landing in the same IST month
 * is the COMMON case for a filing broadcast inside its own quarter, and probing
 * one key twice is one wasted round trip per row over ~96,000 rows.
 */
export function candidateArchiveKeysForFiling(
  row: ArchivedFilingRef,
): string[] {
  const descriptor = (date?: Date) => ({
    exchange: "NSE" as const,
    feed: XBRL_FEED_SLUG,
    date,
  });
  const keys = [buildFeedArchiveKey(descriptor(row.periodEnd), row.sourceUrl)];
  if (row.filedAt) {
    const byFiled = buildFeedArchiveKey(descriptor(row.filedAt), row.sourceUrl);
    if (!keys.includes(byFiled)) keys.push(byFiled);
  }
  const undated = buildFeedArchiveKey(descriptor(undefined), row.sourceUrl);
  if (!keys.includes(undated)) keys.push(undated);
  return keys;
}

/* -------------------------------------------------------------------------- */
/* WHICH INSTRUMENT a filing belongs to — MONEY-1299                          */
/* -------------------------------------------------------------------------- */

/**
 * Which rung of the ladder produced an `instrumentId`. Reported, not decorative
 * — see {@link rankIsinCandidates} for why an unaudited choice here is the
 * expensive kind of wrong.
 */
export type InstrumentRung =
  | "isin-own-active"
  | "isin-other-active"
  | "isin-own-inactive"
  | "isin-other-inactive"
  | "isin-unranked"
  | "symbol-exchange";

/** The `InstrumentMapping` columns the ladder ranks on. */
export interface InstrumentCandidate {
  id: string;
  exchange?: string | null;
  isActive?: boolean | null;
}

/** A resolved instrument and the rung that resolved it. */
export interface InstrumentChoice {
  id: string;
  rung: InstrumentRung;
}

/**
 * Counters the resolver moves. `XbrlSyncOutcome` satisfies this structurally,
 * so the nightly loop hands it its own outcome object and the census lands in
 * the job log.
 */
export interface InstrumentResolutionTally {
  unresolvedIsin: number;
  instrumentRungs: Record<string, number>;
}

/**
 * Pick ONE instrument for an ISIN, from a TOTAL preference order — MONEY-1299.
 *
 * ## The defect this replaces
 *
 * The ISIN leg was `findFirst({ where: { isin } })` with **no `orderBy`**. That
 * reads as "any row with this ISIN will do", and it is not: measured on prod
 * 2026-08-30, **2,155 ISINs carry exactly two rows — an NSE-active row AND a
 * BSE-active row** (the census of row shapes over the 2,845 ISINs in
 * `xbrl_filings` is a single entry, `{"BSE+,NSE+": 2155}`). A dual listing is
 * ONE company with TWO `instrument_mappings` rows, and nothing in that query
 * says which one a filing belongs to.
 *
 * Mongo answered with the BSE row. **79,297 of the 101,288 resolved filings —
 * 78.3%, across 2,172 symbols — are attached to the company's BSE listing**,
 * though `xbrl_filings.exchange` is `"NSE"` on all 108,020 rows and every one
 * of those filings was published by NSE. 2,148 of the 2,169 BSE instruments so
 * attached have an NSE sibling carrying the identical ISIN, which is the one
 * the filing meant.
 *
 * ## Why that is not cosmetic
 *
 * `xbrl-ratios` reads filings by `where: { instrumentId: inst.id }` and upserts
 * `stock_ratios` on `symbol_exchange: { symbol: inst.symbol, exchange:
 * inst.exchange }`. Attached to a BSE row, it writes `(SYMBOL, "BSE")`. Every
 * one of the 2,135 incumbent `stock_ratios` rows is keyed `(SYMBOL, "NSE")`
 * (measured: 2,135 of 2,135 on NSE instruments, 0 on BSE), so there is no
 * collision and no error — the upsert CREATES A SECOND ROW. One company, two
 * ratio rows, and every reader that asks for the NSE listing (the stock page's
 * default) keeps the stale Tickertape-era row while the fresh XBRL one sits
 * unreachable beside it. `stock_financials` is the same shape: 32,359 of 32,359
 * rows on NSE instruments today, against a projection that would stamp
 * `instrumentId` — a REQUIRED FK — with the BSE row while `symbol`/`exchange`
 * come from the NSE filing.
 *
 * 163 filings resolve onto a BSE row whose symbol is a DIFFERENT COMPANY'S
 * (GILLETTE's filings onto `PGHH/BSE`, GLOBOFFS onto `GARWAOFFS/BSE`,
 * OCCL onto `AGVENTURES/BSE`), because the ISIN is shared across a rename the
 * two exchanges applied at different times.
 *
 * ## Why the order must be TOTAL, not merely better
 *
 * `StockRatios.instrumentId` is `@unique` and `StockFinancials` keys on it, so
 * two filings for one company MUST resolve to the same id. Today they happen to
 * (no ISIN in `xbrl_filings` points at two different instrumentIds) — but that
 * is storage order, not a decision, and `syncInstruments` upserts on
 * `(symbol, exchange)`, so a rename CREATES a row (MONEY-1177) and can reshuffle
 * what "first" means. A flip forks one company into two ratio rows, each valid
 * against the unique index.
 *
 * So the ladder ends in a tie-break on `id`. Four classes over rows that can
 * repeat within a class is not a total order; the `id` comparison is what makes
 * repeated calls, and calls from different runs, agree.
 *
 * ## Why an inactive row still wins over nothing
 *
 * A filing belongs to a COMPANY, not to a listing. A delisted issuer's row is
 * still the right join target for its historical filings — refusing it would
 * throw away the mapping we have to preserve a tidiness nothing reads.
 */
export function rankIsinCandidates(
  candidates: readonly InstrumentCandidate[],
  filingExchange: FilingExchange,
): InstrumentChoice | null {
  let best: { rung: InstrumentRung; score: number; id: string } | null = null;
  for (const c of candidates) {
    if (!c.id) continue;
    const own = c.exchange === filingExchange;
    // `isActive` is `Boolean @default(true)` and NOT NULLABLE, so a row that
    // omits it in a projection is active. Treating `undefined` as inactive
    // would demote every candidate a caller selected without the column.
    const active = c.isActive !== false;
    const score = (active ? 0 : 2) + (own ? 0 : 1);
    const rung: InstrumentRung = active
      ? own
        ? "isin-own-active"
        : "isin-other-active"
      : own
        ? "isin-own-inactive"
        : "isin-other-inactive";
    // The `id` comparison is the TIE-BREAK that makes this order total. Without
    // it two rows in one class leave the winner to iteration order, which is the
    // defect this whole function exists to remove — one layer down.
    if (
      best === null ||
      score < best.score ||
      (score === best.score && c.id < best.id)
    ) {
      best = { rung, score, id: c.id };
    }
  }
  return best === null ? null : { id: best.id, rung: best.rung };
}
