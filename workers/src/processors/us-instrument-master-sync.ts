/**
 * US instrument MASTER sync — MONEY-980.
 *
 * Reconciles `us_instruments` against Tiingo's daily security master (74,125
 * listings: 74,217 in-scope rows less 92 duplicate-listingId rows), then runs
 * two paced per-symbol enrichers over the same table — company NAMES from
 * `/tiingo/daily/<ticker>` and permaTicker from `/tiingo/utilities/search` —
 * and joins EDGAR's ticker->CIK map onto the active rows.
 *
 * ## `us_instruments`, NOT `instrument_mappings` (TASK B1)
 *
 * The provider that wrote the US universe into India's table is gone. The
 * argument for the split is in `packages/core/src/market-data/instruments/
 * us-instrument-sync.ts` and in the `UsInstrument` model's own comments; the
 * part that matters HERE is what it deleted from this file. There used to be a
 * paragraph explaining that `syncInstruments` MUST be called with an explicit
 * `options.exchanges`, because without it `deactivateStaleInstruments` computes
 * its still-active set from US symbols alone and flips `isActive: false` on all
 * ~20,804 INDIAN rows, with no error and a `COMPLETED` sync log.
 *
 * That argument is now unnecessary rather than merely satisfied. This job never
 * touches `instrument_mappings`, so there is no argument left to forget. Its
 * own sweep (`judgeUsStaleSweep`) can only see US listings, because that is the
 * only thing in the collection it reads.
 *
 * ## Separate from `us-instrument-sync.ts` in THIS directory
 *
 * That third file is the old Yahoo-validated seeder for 30 hard-coded large
 * caps in `instrument_mappings`. It is deliberately left alone and no longer
 * interacts with this job at all: the two now write different collections, so
 * the MONEY-1093 "two nightly writers on one field" hazard that used to force
 * `mapToUpdate` to drop `name` and `instrumentType` no longer exists.
 *
 * ## Legs, and which ones run on a chained link
 *
 *   depth 0 only   master reconcile (US_MASTER_SYNC)   — one file, whole-table
 *                  EDGAR CIK join   (EDGAR_CIK_ENRICH) — one file, whole-table
 *   every depth    company names    (US_NAME_ENRICH)      — one request/row
 *                  permaTicker      (TIINGO_SEARCH_ENRICH) — one request/row
 *
 * The two whole-file legs are skipped on a chained link because re-running them
 * would re-read the same 800 KB objects and re-diff the same 74k rows up to
 * seven times a night for an identical result. The paced legs are the reason
 * the chain exists.
 *
 * ## Ordering
 *
 * Must run BEFORE `us-eod-sync`, whose population does not exist until this has
 * written it. Scheduled 10:00 IST against the EOD job's 11:00, and the chain is
 * sized (`US_ENRICH_MAX_CHAIN_DEPTH`) to land before that hour — the two jobs
 * spend the SAME metered Tiingo account and `paceTiingoRequest` is per-process
 * module state, so overlapping them would pace independently against one
 * ceiling.
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types/pubsub";
import { getPubSubClient } from "@usemoney/pubsub/client";
import {
  enrichUsInstrumentsWithCik,
  enrichUsInstrumentsWithPermaTicker,
} from "@usemoney/core/market-data";
import { syncUsInstruments } from "@usemoney/core/market-data/instruments/us-instrument-sync";
import { enrichUsInstrumentNames } from "@usemoney/core/market-data/instruments/us-instrument-names";
import {
  US_ENRICH_MAX_CHAIN_DEPTH,
  US_NAME_PAGE_SIZE,
  US_SEARCH_PAGE_SIZE,
  normalizeUsChainDepth,
  shouldChainUsEnrichment,
  usEnrichmentDeadlines,
} from "@usemoney/core/market-data/instruments/us-instrument-names-logic";

/**
 * The Pub/Sub payload. Declared here rather than in `@usemoney/types/pubsub`
 * because it has exactly one field and only this job reads it; the scheduler
 * sends `{}` and every field must therefore be optional.
 */
export interface UsInstrumentMasterSyncMessage {
  /** Link number in a self-chain. 0 (or absent) for a scheduler trigger. */
  chainDepth?: number;
}

export interface UsInstrumentMasterResult {
  /**
   * The reconcile stopped on its run budget with work still planned.
   *
   * Separate from `failed`: nothing was rejected, the clock ran out. Kept as a
   * boolean rather than folded into `errors` so a monitor can key on it
   * without parsing prose.
   */
  masterTruncated: boolean;
  /** Listings Tiingo's master yielded after the listingId collapse. */
  fetched: number;
  /** Rows written by the master reconcile (created + updated). */
  upserted: number;
  /** Rows the master reconcile could not write. */
  failed: number;
  /**
   * ACTIVE listings the stale sweep flipped DELISTED — MONEY-1263.
   *
   * Reported because it is the number that makes the one CATASTROPHIC failure
   * visible at a glance. The sweep retires every ACTIVE listing the master no
   * longer carries, so a truncated `supported_tickers.zip` would retire most of
   * the universe. `judgeUsStaleSweep` refuses a sweep above 10% of its
   * population, but a refusal the operator cannot SEE is only half a guard — on
   * a healthy night this reads in the low tens, and anything in the thousands
   * means the master came back short.
   */
  deactivated: number;
  /** True when US_MASTER_SYNC=off — a deliberate skip, not a failure. */
  masterDisabled: boolean;
  /**
   * The master leg itself failed — 1 or 0, an UPSTREAM failure not a row one.
   *
   * ## Why this field exists at all
   *
   * The `catch` below recorded its error in `errors` and nowhere else, so a
   * night on which Tiingo's master 403'd emitted
   * `selected:0, written:0, failed:0, transportFailures:0` — arithmetically
   * indistinguishable from a healthy no-op. The zero-write monitor is
   * `clamp_max(selected,1) - clamp_max(written,1) > 0`, whose own truth table
   * calls `0 - 0` "genuinely idle", so it could not fire; and
   * `reportJobOutcome`'s upstream-failure branch
   * (`transportFailures > 0 && written === 0`) could not fire either. A job
   * whose ONLY job is populating the US master could go dark indefinitely with
   * every log line reading normal.
   *
   * It is 1 rather than a count of HTTP attempts because `syncUsInstruments`
   * throwing is one LEG down, not one request — the client's own retries are
   * inside it and invisible from here. Inventing a request count would be a
   * number nothing measured.
   */
  providerTransportFailures: number;
  /** Rows stamped with a CIK by the EDGAR enricher. */
  cikWritten: number;
  /** Active US rows EDGAR has no entry for. A large number is NORMAL. */
  cikUnmatched: number;
  /**
   * `cikUnmatched` split by venue, and the first few tickers — MONEY-1353.
   *
   * A bare 1,170 says a number; it does not say WHETHER those rows are
   * warrants and units SEC's file never lists (the steady state) or a venue
   * that stopped joining (a defect). The split is the only thing that can, and
   * the sample is BOUNDED at 20 for the reason the whole list is not here at
   * all: a log line 1,170 tickers long gets truncated by whatever renders it,
   * at an offset nobody chose. `scripts/data/us-cik-unmatched-report.ts` owns
   * the full population.
   */
  cikUnmatchedByExchange: Record<string, number>;
  cikUnmatchedSample: string[];
  /** True when EDGAR_CIK_ENRICH=off — a deliberate skip, not a failure. */
  cikDisabled: boolean;
  /** Rows given a company name this run. */
  namesWritten: number;
  /**
   * Rows whose metadata described a DIFFERENT occupancy of the ticker.
   * Expected and non-zero: 1,440 of the 74,125 listings share a ticker, and
   * `/tiingo/daily/` only ever answers for the current occupant. This is the
   * coverage ceiling, reported so nobody files it as a gap.
   */
  namesNotThisListing: number;
  /** Metadata calls that failed upstream. Distinct from a 404, an ANSWER. */
  nameTransportFailures: number;
  /** True when US_NAME_ENRICH=off. */
  namesDisabled: boolean;
  /** Rows stamped with a Tiingo permaTicker this run (MONEY-1263). */
  permaTickerWritten: number;
  /** Tickers several US securities answer to — deliberately left unwritten. */
  permaTickerAmbiguous: number;
  /** Search calls that failed upstream. Distinct from "no match", an ANSWER. */
  permaTickerTransportFailures: number;
  /** True when TIINGO_SEARCH_ENRICH=off. */
  permaTickerDisabled: boolean;
  /** This link's depth in the self-chain. */
  chainDepth: number;
  /** Whether a follow-up message was published. */
  chained: boolean;
  errors: string[];
}

export async function syncUsInstrumentMaster(
  message: UsInstrumentMasterSyncMessage = {},
): Promise<UsInstrumentMasterResult> {
  // Taken FIRST. The 600s ack clock starts at delivery, so every deadline below
  // is absolute against this instant and not against each leg's own start.
  const startedAtMs = Date.now();
  const chainDepth = normalizeUsChainDepth(message.chainDepth);

  const result: UsInstrumentMasterResult = {
    masterTruncated: false,
    fetched: 0,
    upserted: 0,
    failed: 0,
    deactivated: 0,
    masterDisabled: false,
    providerTransportFailures: 0,
    cikWritten: 0,
    cikUnmatched: 0,
    cikUnmatchedByExchange: {},
    cikUnmatchedSample: [],
    cikDisabled: false,
    namesWritten: 0,
    namesNotThisListing: 0,
    nameTransportFailures: 0,
    namesDisabled: false,
    permaTickerWritten: 0,
    permaTickerAmbiguous: 0,
    permaTickerTransportFailures: 0,
    permaTickerDisabled: false,
    chainDepth,
    chained: false,
    errors: [],
  };

  console.log(
    `[us-instrument-master] Starting (chainDepth ${chainDepth}/` +
      `${US_ENRICH_MAX_CHAIN_DEPTH})`,
  );

  // ── Whole-file legs: depth 0 only ─────────────────────────────────────────
  if (chainDepth === 0) {
    try {
      const sync = await syncUsInstruments();
      result.fetched = sync.stats?.kept ?? 0;
      result.upserted = sync.created + sync.updated;
      result.failed = sync.failed;
      result.deactivated = sync.retired;
      result.masterDisabled = sync.disabled;
      if (sync.sweepRefusedReason) {
        result.errors.push(`sweep: ${sync.sweepRefusedReason}`);
      }
      // A TRUNCATED reconcile must reach the operator as a NUMBER, not as
      // prose. `syncUsInstruments` bounds its write loops by a clock and
      // reports how much it did not get to, but that signal died here: only
      // `created + updated` was mapped, and "reconciled 20,000 of 74,125 and
      // ran out of clock" is numerically indistinguishable from a healthy
      // steady-state night where most rows are `unchanged`.
      //
      // `errors` is the channel that survives into `skippedReason`, which is
      // why the count rides in the text — but the boolean is what a future
      // monitor can key on without parsing a sentence.
      result.masterTruncated = sync.truncated;
      if (sync.truncated) {
        result.errors.push(
          `reconcile truncated: ${sync.remaining} row(s) still planned — the table is still converging`,
        );
      }
    } catch (error) {
      // A master failure must not also cost the enrichers — they only ever
      // UPDATE rows already present, so they are still useful against
      // yesterday's table.
      //
      // COUNTED, not merely recorded. `errors` reaches the operator as
      // `skippedReason` text on a line that otherwise reads 0/0/0, and no
      // monitor can key on prose. This is the one counter that makes a dark
      // master leg arithmetically distinguishable from a healthy no-op — see
      // `providerTransportFailures`.
      result.providerTransportFailures = 1;
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(`provider: ${msg}`);
      console.error("[us-instrument-master] provider sync failed:", error);
    }

    try {
      const cik = await enrichUsInstrumentsWithCik();
      result.cikWritten = cik.cikWritten;
      result.cikUnmatched = cik.unmatched;
      result.cikUnmatchedByExchange = cik.unmatchedByExchange;
      result.cikUnmatchedSample = cik.unmatchedSample;
      result.cikDisabled = cik.disabled;
      if (cik.error) result.errors.push(`edgar: ${cik.error}`);
    } catch (error) {
      // Defensive only: the enricher documents that it never throws.
      const msg = error instanceof Error ? error.message : String(error);
      result.errors.push(`edgar: ${msg}`);
    }
  }

  // ── Paced per-symbol legs: every depth ────────────────────────────────────
  //
  // Both get an ABSOLUTE deadline carved out of the one 600s budget. Names go
  // first only because they are the larger backfill; the split is what stops
  // that from starving the search leg for a convergence cycle.
  const { nameDeadlineAtMs, searchDeadlineAtMs } =
    usEnrichmentDeadlines(startedAtMs);

  let nameSelected = 0;
  let searchSelected = 0;
  let rateLimited = false;

  try {
    const names = await enrichUsInstrumentNames({
      limit: US_NAME_PAGE_SIZE,
      deadlineAtMs: nameDeadlineAtMs,
    });
    nameSelected = names.selected;
    result.namesWritten = names.written;
    result.namesNotThisListing = names.notThisListing;
    result.nameTransportFailures = names.transportFailures;
    result.namesDisabled = names.disabled;
    rateLimited ||= names.rateLimited;
    if (names.error) result.errors.push(`names: ${names.error}`);
  } catch (error) {
    // Defensive only: the enricher documents that it never throws.
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(`names: ${msg}`);
  }

  // ── permaTicker, from Tiingo's utilities/search — MONEY-1263 ──────────────
  //
  // The corporate-actions feed identifies securities by `permaTicker` and NOT
  // by our symbol, so without this column every action row would need a ticker
  // join we already know to be unreliable: ticker reuse is live, and the batch
  // form returns two different companies both labelled `reax`.
  //
  // It rides THIS job because it is a per-symbol enricher over the same table
  // and the same metered account as the name leg, so the two must share one
  // budget and one pacer rather than one starving the other.
  //
  // Independent of every leg above: a search outage must not cost the master
  // sync, and a master failure must not cost the enrichment.
  try {
    const search = await enrichUsInstrumentsWithPermaTicker({
      limit: US_SEARCH_PAGE_SIZE,
      deadlineAtMs: searchDeadlineAtMs,
    });
    searchSelected = search.selected;
    result.permaTickerWritten = search.written;
    result.permaTickerAmbiguous = search.ambiguous;
    result.permaTickerTransportFailures = search.transportFailures;
    result.permaTickerDisabled = search.disabled;
    rateLimited ||= search.rateLimited;
    if (search.error) result.errors.push(`search: ${search.error}`);
  } catch (error) {
    // Defensive only: the enricher documents that it never throws.
    const msg = error instanceof Error ? error.message : String(error);
    result.errors.push(`search: ${msg}`);
  }

  // ── Self-chain ────────────────────────────────────────────────────────────
  //
  // NOT after a rate limit. The daily cap throws BEFORE any sleep, so chaining
  // through one is a job that hit its ceiling and responded by asking for more
  // — the exact behaviour `TiingoDailyCapError` was made a subclass to prevent.
  if (!rateLimited) {
    result.chained = await chainNextLink({
      chainDepth,
      nameSelected,
      searchSelected,
    });
  } else {
    console.warn(
      "[us-instrument-master] NOT chaining — Tiingo's daily cap was reached",
    );
  }

  console.log(
    `[us-instrument-master] Complete: fetched=${result.fetched} ` +
      `upserted=${result.upserted} failed=${result.failed} ` +
      `deactivated=${result.deactivated} ` +
      `masterDisabled=${result.masterDisabled} ` +
      `cikWritten=${result.cikWritten} cikUnmatched=${result.cikUnmatched} ` +
      // Both ride the SAME line as the integer they explain. Split across two
      // log statements they would be separated by whatever else the process
      // emits between them, and an operator reading a truncated tail would see
      // the breakdown without the total or the total without the breakdown.
      `cikUnmatchedByExchange=${
        Object.entries(result.cikUnmatchedByExchange)
          .sort((a, b) => b[1] - a[1])
          .map(([venue, n]) => `${venue}:${n}`)
          .join("|") || "none"
      } ` +
      `cikUnmatchedSample=${result.cikUnmatchedSample.join("|") || "none"} ` +
      `cikDisabled=${result.cikDisabled} ` +
      `providerTransportFailures=${result.providerTransportFailures} ` +
      `namesWritten=${result.namesWritten} ` +
      `namesNotThisListing=${result.namesNotThisListing} ` +
      `nameTransportFailures=${result.nameTransportFailures} ` +
      `permaTickerWritten=${result.permaTickerWritten} ` +
      `permaTickerAmbiguous=${result.permaTickerAmbiguous} ` +
      `permaTickerTransportFailures=${result.permaTickerTransportFailures} ` +
      `chainDepth=${result.chainDepth} chained=${result.chained}`,
  );

  // Reported from the happy path AND the failure paths above, because a run
  // that fetched nothing must still emit 0/0 rather than nothing at all: the
  // monitor sets `notify_no_data`, so silence reads as NO DATA rather than as a
  // problem (MONEY-1255).
  //
  // `selected`/`written` describe the MASTER leg, which is the reason the job
  // exists — and on a chained link that leg did not run, so the link reports
  // 0/0 and the depth-0 run carries the real numbers. That is honest rather
  // than convenient: a chained link genuinely selected no master rows.
  reportJobOutcome({
    job: "us-instrument-master-sync",
    selected: result.fetched,
    written: result.upserted,
    failed: result.failed,
    // An enricher outage is an UPSTREAM failure, not a row failure. Without
    // this the job can report 0 written after every call refused and read
    // exactly like a healthy night with nothing to do (MONEY-1255).
    //
    // The MASTER leg is summed in for the same reason and was once missing
    // from it, which was the more serious half: a search outage still leaves a
    // healthy master sync behind it, while a master outage leaves the job
    // having done nothing at all — and reported `transportFailures: 0` while
    // doing so. Summed rather than reported separately because `JobOutcome`
    // has one such field and its consumers ask one question of it ("did an
    // upstream refuse to answer this run?"); which leg it was is in
    // `skippedReason` and in the completion line above.
    ...(result.permaTickerTransportFailures + result.providerTransportFailures >
    0
      ? {
          transportFailures:
            result.permaTickerTransportFailures +
            result.providerTransportFailures,
        }
      : {}),
    ...(result.errors.length > 0
      ? { skippedReason: result.errors.slice(0, 3).join("; ") }
      : {}),
  });

  return result;
}

/**
 * Publish the next link, or explain why not.
 *
 * ## Why this terminates
 *
 * `shouldChainUsEnrichment` refuses once `chainDepth + 1` would REACH
 * `US_ENRICH_MAX_CHAIN_DEPTH`, and every published message carries
 * `chainDepth + 1`. That bound holds regardless of what the tables do, so a
 * chain is at most `US_ENRICH_MAX_CHAIN_DEPTH` messages long even if every
 * other signal is wrong. The remaining condition — at least one leg filled its
 * page — can only stop it SOONER.
 *
 * Never throws: a failed chain must leave a successful run successful. The cost
 * of a dropped link is one delayed page, and the daily scheduler starts a fresh
 * chain anyway.
 */
async function chainNextLink(opts: {
  chainDepth: number;
  nameSelected: number;
  searchSelected: number;
}): Promise<boolean> {
  const { chainDepth, nameSelected, searchSelected } = opts;

  if (
    !shouldChainUsEnrichment({
      chainDepth,
      nameSelected,
      namePageSize: US_NAME_PAGE_SIZE,
      searchSelected,
      searchPageSize: US_SEARCH_PAGE_SIZE,
    })
  ) {
    console.log(
      `[us-instrument-master] Not chaining (depth ${chainDepth}/` +
        `${US_ENRICH_MAX_CHAIN_DEPTH}, names ${nameSelected}/` +
        `${US_NAME_PAGE_SIZE}, search ${searchSelected}/` +
        `${US_SEARCH_PAGE_SIZE})`,
    );
    return false;
  }

  try {
    const pubsub = getPubSubClient();
    const topic = pubsub.topic(
      getTopicName(PUBSUB_TOPICS.US_INSTRUMENT_MASTER_SYNC),
    );
    const next: UsInstrumentMasterSyncMessage = {
      chainDepth: chainDepth + 1,
    };
    await topic.publishMessage({ json: next });
    console.log(
      `[us-instrument-master] Chained link ${chainDepth + 1}/` +
        `${US_ENRICH_MAX_CHAIN_DEPTH}`,
    );
    return true;
  } catch (error) {
    console.warn(
      `[us-instrument-master] Failed to chain the next link: ` +
        `${error instanceof Error ? error.message : error}`,
    );
    return false;
  }
}
