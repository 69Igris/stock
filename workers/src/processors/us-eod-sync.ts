/**
 * US EOD Sync Processor — MONEY-980 (tasks 6 + 7).
 *
 * The nightly US price backbone. SIX COUNTED LEGS in one job, because they
 * share one upstream, one token and one rate-limit budget that Tiingo does not
 * report: there is no remaining-quota header (verified — a successful EOD call
 * returns only `x-frame-options`), so a 429 is the only feedback channel. Six
 * separate jobs would race for a ceiling none of them can see.
 *
 *   (a) EOD bars for ACTIVE US securities        -> `Candle`
 *   (b) US mutual-fund NAVs                      -> `UsFundNav`
 *       Same fetch as (a) — the NAV rides in the OHLC fields of the same
 *       `/tiingo/daily` response — but NOT the same table any more. Measured
 *       across 22,096 fund bars on 2026-08-28, `open == high == low == close`
 *       in every row, `volume == 0` in every row and `splitFactor == 1` in
 *       every row, so four of `Candle`'s columns carried no information; and
 *       funds are 49,414 of 72,685 US listings, i.e. 72% of the bars in any
 *       hot-window depth. See `writeFundNavs` / `toFundNavRows` for the full
 *       measurement and for the one field this DOES lose (`divCash`).
 *       The trigger is 11:00 IST Tue-Sat, which is 00:30 ET under EST and
 *       01:30 under EDT — past the NAV publication boundary in BOTH, which the
 *       old 07:00 IST slot was not.
 *   (c) the corporate-actions delta, DERIVED from the `divCash`/`splitFactor`
 *       columns that come free on (a)+(b) — REPORTED, not applied; see below
 *   (d) the USDINR rate for the session          -> `FxRate`
 *   (e) the forward corporate-actions CALENDAR   -> `UsCorporateAction`
 *       (MONEY-1263). One ex-date per run, market-wide, two routes. NOT an
 *       adjustment source and NOT a replacement for (c) — see below.
 *
 *   (f) IS RETIRED — MONEY-1309. It fetched the session's US news into
 *       `UsStockNews`, and it was replaced because of THIS JOB'S SCHEDULE
 *       rather than anything the leg itself did wrong.
 *
 *       The cron above (`0 11 * * 2-6` IST) is derived entirely from market
 *       boundaries: a US session closes 16:00 ET = 02:30 IST on D+1, and fund
 *       NAVs publish after 00:00 ET. That reasoning is correct for prices and
 *       meaningless for news, which does not close at 16:00 and does not stop
 *       on Saturday. Being Tue-Sat, the leg could not run AT ALL on a Sunday
 *       or Monday IST. Measured on prod 2026-08-31: newest article 88 HOURS
 *       old, mean ingest lag 29.6 hours.
 *
 *       Nothing here could have reported that. Every run that DID happen
 *       fetched its day, wrote its rows and landed `healthy`; the defect lived
 *       in the gaps between runs, and a job cannot count the times it did not
 *       execute.
 *
 *       Superseded by `workers/src/processors/tiingo-news-poll.ts`, which runs
 *       every 2 minutes 24x7 against an ARTICLE-level store keyed on Tiingo's
 *       own article id. The 90-day floor and clamp guards that made this leg
 *       safe (`TiingoNewsFloorError` / `TiingoNewsClampedError` — a pre-floor
 *       request answers HTTP 200 with rows from the FLOOR date) moved across
 *       with it, unchanged and still enforced twice.
 *
 *       `us_stock_news` is NOT deleted and NOT migrated. Its rows stay and its
 *       readers keep working until they are moved in their own tickets; this
 *       job simply stops adding to it.
 *
 * ## LEG (c) DID NOT MOVE, and the beta grant is why that is now MEASURED
 *
 * This section used to read "THIS IS A TEMPORARY ARRANGEMENT. When beta access
 * lands, switch to the real endpoints." Beta access LANDED, the endpoints were
 * re-probed, and the answer is that switching buys nothing:
 *
 *   symbol   endpoint   bars w/ divCash   both   only-endpoint   only-bars   mismatches
 *   AAPL           91                90     90               1           0            0
 *   KO            258               257    257               1           0            0
 *   GE            157               157    157               0           0            0
 *
 * 504 events, ZERO amount disagreements, ZERO date disagreements; splits agree
 * too. And the single argument the old paragraph made for switching —
 * `splitStatus`, the flag said to mark a CANCELLED split "c", which a bar's
 * `splitFactor` column cannot express — rests on a field that DOES NOT EXIST in
 * live responses: verified across all 67 split rows and all 2,035 distribution
 * rows returned. The prediction was wrong, so the plan it justified is dropped
 * rather than carried out.
 *
 * Leg (c) therefore stays derived. `divCash > 0` on a bar IS a distribution on
 * that ex-date and `splitFactor != 1` IS a split, both columns already ride in
 * the bytes legs (a) and (b) downloaded, so the delta costs ZERO extra requests
 * and cannot drift from the prices because it IS the prices.
 *
 * ## Leg (e) is a CALENDAR, and it must never feed the adjustment path
 *
 * The dedicated endpoints are still worth calling, for something leg (c)
 * structurally cannot do: a price bar exists only AFTER its session, so the
 * derived path can only ever say what already happened. Leg (e) asks
 * `?exDate=<tomorrow>` and records FORWARD-dated ex-dates plus the declaration,
 * record and payment dates no bar carries.
 *
 * That is the whole of its job. `UsCorporateAction` is WRITTEN by leg (e) and
 * READ by nothing in this file; `Candle.divCash` / `Candle.splitFactor` remain
 * the sole adjustment inputs. The separation is load-bearing rather than tidy:
 * the two sources agree on 504 of 504 events, so if leg (e)'s rows ever reached
 * the adjustment path they would double-count every event leg (c) already read
 * off the same day's bar — and agreeing perfectly is exactly what would make
 * that duplication invisible. A source scan in the test file enforces it,
 * because a comment cannot fail a build.
 *
 * It APPLIES nothing, and that is MONEY-980 review finding 5 rather than a
 * shortcut. It used to evict `candles:adj:{exchange}:{symbol}:*`, a namespace
 * NO code in this repository writes, so it deleted 0 keys every night and its
 * own falsifiability signal was red from birth. The only candle cache that
 * exists is the COLD SHARD cache (`candles-cold`), which holds RAW bars for
 * closed symbol-years and is not staled by an action detected today — the
 * adjusted series is recomputed on every read and cached nowhere. See
 * `CA_EVICTION_UNAVAILABLE`. See `detectCorporateActions` for what this leg
 * deliberately does NOT do, which is write into India's `CorporateAction`
 * table.
 *
 * ## Where the US population lives (MONEY-980 C1)
 *
 * `us_instruments`, not `InstrumentMapping`. Every read and every rotation
 * stamp in this file goes there. The discriminator is now the TABLE rather than
 * a `market` column, which is strictly stronger: a reader can forget a column
 * and cannot forget a collection. `(symbol, exchange)` is indexed but
 * DELIBERATELY NOT unique there — a recycled ticker is two rows on one venue —
 * so nothing in this file may `findUnique` on that pair.
 *
 * ## The three hard constraints
 *
 * 1. **600s Pub/Sub ack ceiling.** Enforced by TWO walls, never by a bigger
 *    batch. `RUN_TIME_BUDGET_MS` is the THROUGHPUT wall, checked between
 *    symbols; `UPSTREAM_CALL_DEADLINE_MS` is the ACK-DEADLINE wall, checked
 *    before every single upstream call and derived from the client's own retry
 *    ladder so it always reserves room for one worst-case call plus the
 *    un-gated tail. The second exists because the first is not sufficient: one
 *    Tiingo call can occupy 155s (4 attempts x a 30s timeout, plus backoff),
 *    so a leg that checked the clock once and then made two calls could finish
 *    at ~730s. Overrunning does not make a run slow: Pub/Sub redelivers and a
 *    SECOND copy starts on the same page, spending the same invisible quota
 *    twice.
 * 2. **The rotation marker is in `orderBy` ONLY.** `usEodSyncedAt` is ABSENT
 *    (not null) on every existing `us_instruments` row, so a `where` on it
 *    matches zero (MONEY-1050 / 1205 / 1234 / 1236). Every VISITED row is
 *    stamped — skips and failures included — or the rotation stalls on the same
 *    head forever (MONEY-1211, 681 of 781 symbols).
 * 3. **Self-chaining**, bounded by `MAX_CHAIN_DEPTH`. That bound is the
 *    termination proof and `shouldChainAnotherBatch` consults no database, no
 *    clock and no queue to enforce it.
 *
 * ## What leg (e) costs, stated rather than implied
 *
 * TWO extra requests on a typical run: the distributions and splits routes are
 * separate, and each takes one `?exDate=`. Set against `requestBudgetForRun`,
 * which on the COMMERCIAL plan is `20,000 x (420/3600) = 2,333` requests for a
 * single link, that is 0.09% of one run's allowance — negligible in the only
 * unit that matters, since the ceiling this job cannot observe is a REQUEST
 * RATE. (It was three before MONEY-1309 retired leg (f); the news poller
 * spends its own requests on its own 2-minute schedule.)
 *
 * Time is the constraint it actually consumes, and it is not free: it is given
 * a reserved slice by `PRICE_LEG_BUDGET_MS` (365s, against a 385s call
 * deadline), because the price legs are rotations over populations far larger
 * than one page and would otherwise spend every millisecond of the budget and
 * leave it structurally unreachable. Read that constant before moving anything
 * in the leg order.
 *
 * A CHAIN LINK REPEATS IT, and that is deliberate. It is market-wide and
 * single-date, so link 19 asks the identical question link 0 did; the write is
 * an upsert on `(permaTicker, type, exDate)`, so the repeat is idempotent.
 * What it buys is the only healing available to a single-date market-wide
 * fetch: a transient failure on one link is retried on the next. The
 * per-symbol legs get that for free from their trailing window; this one has
 * no window to widen.
 *
 * Pure decisions live in `us-eod-sync-logic.ts` (unit-tested); this file does
 * I/O only.
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import prisma from "@usemoney/database";
import type { UsEodSyncMessage } from "@usemoney/types/pubsub";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types/pubsub";
import { getPubSubClient } from "@usemoney/pubsub/client";
// Every VALUE import from @usemoney/core lives in this I/O shell.
// `us-eod-sync-logic.ts` takes only `import type` from core and
// `routes/us-eod-sync.ts` takes none at all, so the decisions and the message
// narrowing can be exercised without a Tiingo client, a Prisma connection or a
// cache client being constructed at module load.
import {
  fetchTiingoEod,
  MAX_RETRIES,
  TiingoAuthError,
  TiingoRateLimitError,
} from "@usemoney/core/market-data/tiingo/tiingo-client";
import { tiingoLimits } from "@usemoney/core/market-data/tiingo/tiingo-logic";
// MONEY-1263 — the corporate-actions client. A VALUE import, and it lives in
// this I/O shell rather than in the logic module: keeping
// `us-eod-sync-logic.ts` on `import type` alone is what lets its tests run with
// no client, no Prisma and no clock constructed at module load.
import {
  fetchDistributionsByExDate,
  fetchSplitsByExDate,
} from "@usemoney/core/market-data/tiingo/tiingo-corp-actions";
import {
  dedupeCorpActions,
  toUsCorporateActionRows,
  type TiingoDistributionRow,
  type TiingoSplitRow,
} from "@usemoney/core/market-data/tiingo/tiingo-corp-actions-logic";
// NO Tiingo NEWS import any more — MONEY-1309 retired leg (f). The client, its
// 90-day floor guard and its clamp check all still exist and are all still
// enforced twice; they moved to `processors/tiingo-news-poll.ts`, which runs
// every 2 minutes 24x7 instead of on this job's Tue-Sat market cron.
// The per-attempt fetch timeout, from the module that enforces it. Half of the
// worst-call arithmetic in `worstTiingoCallMs`; see `TIINGO_BACKOFF_BASE_MS`
// below for the other half and for why only one of the three inputs is a local
// constant.
import { EXCHANGE_FETCH_TIMEOUT_MS } from "@usemoney/core/market-data";
// The BARREL (`.../candles`), not the file: `candle-repository.ts` has no
// subpath of its own in packages/core's `exports` map, and `moduleResolution:
// "bundler"` resolves through that map. `candleRepository` is the module's own
// singleton — constructing a second one per run would give the cold-store cache
// nothing to hold on to.
import {
  candleRepository,
  type CandleWriteRow,
} from "@usemoney/core/market-data/candles";
import { getExchangeRate } from "@usemoney/core/currency";
import type { ListingRow } from "@usemoney/core/market-data/databento/databento-symbology";
// NO `clearCachePattern` import any more — MONEY-980 finding 5. Leg (c) used to
// hand it `candles:adj:{exchange}:{symbol}:*`, a namespace NOTHING in the
// repository writes, so it deleted 0 keys on every run. See
// `CA_EVICTION_UNAVAILABLE` for the real namespace and why evicting it would be
// wrong even if this file could address it.
import {
  CA_CALENDAR_NOT_AN_ADJUSTMENT_SOURCE,
  CA_EVICTION_UNAVAILABLE,
  CA_LOOKUP_CHUNK_SIZE,
  DEFAULT_US_EOD_BATCH_SIZE,
  DEFAULT_US_MF_BATCH_SIZE,
  EQUITY_LEG_BUDGET_MS,
  MAX_CHAIN_DEPTH,
  MF_NAV_NEEDS_PERMATICKER,
  PRICE_LEG_BUDGET_MS,
  RUN_TIME_BUDGET_MS,
  STAMP_CHUNK_SIZE,
  latestUpstreamCallStartMs,
  worstTiingoCallMs,
  US_EOD_ORDER_BY,
  affectedSecurities,
  buildUsEodWhere,
  buildListingWindowIndex,
  chunkList,
  clampBatchSize,
  clampLookbackDays,
  detectCorporateActions,
  hasRotationWrapped,
  isCashDistribution,
  isWithinRunBudget,
  judgeUsEodHealth,
  normalizeChainDepth,
  normalizeChainStartedAt,
  computeSelected,
  requestBudgetForRun,
  requestsSpentByCall,
  resolveCalendarExDate,
  resolveCandleListingId,
  resolveUsSessionDate,
  resolveWindowStart,
  shouldChainAnotherBatch,
  toCandleRows,
  toFundNavRows,
  utcMidnight,
  type DerivedCorporateAction,
  type EodBarInput,
  type UsEodHealthVerdict,
  type UsEodLeg,
  type UsEodLegVerdict,
} from "./us-eod-sync-logic";

const logger = {
  info: (...args: unknown[]) => console.log("[us-eod-sync]", ...args),
  warn: (...args: unknown[]) => console.warn("[us-eod-sync]", ...args),
  error: (...args: unknown[]) => console.error("[us-eod-sync]", ...args),
};

/** The FX pair this job maintains. One pair, one row per session day. */
const FX_PAIR = "USDINR";

/**
 * The client's first backoff sleep, restated because it is NOT exported.
 *
 * `tiingo-client.ts` declares `const BACKOFF_BASE_MS = 5_000` at module scope
 * without an `export`, and MONEY-1263 does not own that file. The other two
 * inputs to the worst-call arithmetic — `MAX_RETRIES` and
 * `EXCHANGE_FETCH_TIMEOUT_MS` — ARE exported and are imported above, so this is
 * the only one of the three that could drift.
 *
 * It is therefore pinned by a SOURCE SCAN in the test file, which reads
 * `tiingo-client.ts` off disk and fails if the declared literal is not this
 * number. That is the same guard the ladder length has (`requestsSpentByCall`
 * takes `MAX_RETRIES` as an argument rather than restating it): a copied
 * constant is only safe when something fails on the day it stops being a copy.
 */
const TIINGO_BACKOFF_BASE_MS = 5_000;

/**
 * The worst wall clock ONE upstream Tiingo call can occupy: 155s today.
 *
 * `4 attempts x 30s timeout + 5s + 10s + 20s backoff`. Derived at module load
 * from the client's own constants rather than written down — see
 * {@link worstTiingoCallMs}, which explains why the number this replaces (45s)
 * was wrong by ~110s and what that cost.
 */
const TIINGO_WORST_CALL_MS = worstTiingoCallMs(
  MAX_RETRIES,
  EXCHANGE_FETCH_TIMEOUT_MS,
  TIINGO_BACKOFF_BASE_MS,
);

/**
 * The latest ELAPSED at which ANY leg may start a new upstream call: 400s.
 *
 * Checked before EVERY call, not once per leg. Leg (e) makes two and leg (f)
 * pages, so a per-leg entry check let a run that reached the leg at 419.9s
 * issue calls to ~730s — past the 600s ack deadline, where Pub/Sub redelivers
 * and a second copy of the run starts against the same page and the same
 * unobservable quota. See {@link latestUpstreamCallStartMs}.
 */
const UPSTREAM_CALL_DEADLINE_MS =
  latestUpstreamCallStartMs(TIINGO_WORST_CALL_MS);

/**
 * Provenance for leg (d).
 *
 * Yahoo, not Tiingo. Tiingo's FX endpoints are a separate entitlement we have
 * NOT probed, and `FxRate.source` documents `YAHOO | RBI` — so this leg reuses
 * `getExchangeRate`, which is already the platform's USDINR path and is a
 * single request. Claiming TIINGO here for a rate Yahoo supplied would be a
 * provenance lie in a column whose entire purpose is provenance.
 */
const FX_SOURCE = "YAHOO";

/** One `us_instruments` row as this job reads it. */
interface UsInstrumentRow {
  id: string;
  symbol: string;
  exchange: string;
  listingId: string | null;
  listingStartDate: Date | null;
  /** MONEY-1617 — the window's close, so the writer can clip to it. */
  listingEndDate: Date | null;
  listingStatus: string;
  /** Required by `UsFundNav`; null until the search leg reaches the row. */
  permaTicker: string | null;
  usEodSyncedAt: Date | null;
}

/**
 * The `UsFundNav` key this row can be written under, or `null` if it has none.
 *
 * ONE function for TWO guards — MONEY-1291. The decision is now made twice, in
 * `runPriceLeg` (before the request is issued) and again in `writeFundNavs`
 * (before the upsert), and the two must agree exactly: a `.trim()` present at
 * one site and absent at the other would let a whitespace-only `permaTicker`
 * be paid for at the first and refused at the second, restoring the wasted
 * call for precisely the rows nobody would think to look at.
 */
function fundNavKey(row: Pick<UsInstrumentRow, "permaTicker">): string | null {
  const key = row.permaTicker?.trim();
  return key ? key : null;
}

/** Everything one run accumulates. Every counter is incremented AFTER its call. */
export interface RunState {
  equityAttempted: number;
  /**
   * Bars leg (a) RECEIVED. The liveness signal, and deliberately not the same
   * number as `equityWritten`: `putCandles` PRESERVES a bar already stored at
   * equal-or-stronger provenance, so on the night after a US holiday a healthy
   * run receives its whole window and writes nothing. See `legIsDark`.
   */
  equityBars: number;
  /** Bars leg (a) OWED a write: created + upgraded + failed + droppedNonFinite. */
  equityOwed: number;
  /** Bars leg (a) actually persisted: created + upgraded. */
  equityWritten: number;
  /**
   * Rows leg (a)'s `findMany` returned — `null` until that query RUNS.
   *
   * Nullable on purpose (MONEY-980 finding 2): 0 is the ANSWER "no such rows
   * exist" and null is "we never asked". A leg whose query never ran (the run
   * circuit-broke first) must not be reported as an empty population, which is
   * the fail-open-cached-as-fact shape this repo has a standing rule against.
   */
  equitySelected: number | null;
  mfAttempted: number;
  /** NAV points leg (b) RECEIVED. The liveness signal; see `legIsDark`. */
  mfBars: number;
  /** `UsFundNav` rows leg (b) was OWED: attempted upserts, written or not. */
  mfOwed: number;
  /** `UsFundNav` rows leg (b) persisted. */
  mfWritten: number;
  /** As `equitySelected`. Leg (b) is SKIPPED entirely on a circuit break. */
  mfSelected: number | null;
  /**
   * Funds skipped because `UsInstrument.permaTicker` is still null.
   *
   * NOT a failure and NOT a transport problem — the enrichment rotation has not
   * reached the row. Its own counter because the remedy is a DIFFERENT JOB
   * (`us-instrument-master-sync`'s search leg), and a fund folded into
   * `failed` would send an operator to Tiingo instead. See
   * `MF_NAV_NEEDS_PERMATICKER`.
   */
  mfSkippedNoPermaTicker: number;
  /** NAV points refused by the shaper: malformed date, or a non-positive NAV. */
  mfNavRefused: number;
  /** Repeats of one `(permaTicker, date)` inside a single response. */
  mfNavDupInBatch: number;
  /**
   * NAV rows whose `divCash` was non-finite or negative and became 0.
   *
   * Expected to stay 0 — `parseTiingoEodCsv` coerces at the parse boundary and
   * 0 negatives were found in 95,597 measured fund bars. Non-zero means the
   * feed's distribution column has changed shape, which is worth seeing before
   * it becomes a total-return number nobody can explain.
   */
  mfNavDivCashClamped: number;
  /**
   * Fund NAV rows carrying a real split this run — expected to be 0 almost
   * every night (4 in 95,597 measured bars), and worth SEEING when it is not.
   * A split is the one fund event whose loss is catastrophic rather than
   * cosmetic: DODGX 2025-10-27 is a 93.7% apparent one-day collapse unadjusted.
   */
  mfNavSplits: number;
  /**
   * Bars claiming a non-finite or non-positive split factor, recorded as NO
   * SPLIT. Expected to stay 0 — the parser coerces at the boundary.
   */
  mfNavSplitRefused: number;
  fxAttempted: number;
  fxWritten: number;
  /** Symbols whose fetch/write failed. Rows, not calls. */
  failed: number;
  /** Upstream calls that failed. Calls, not rows — MONEY-1250. */
  transportFailures: number;
  /** Tickers Tiingo answered 404 for (a real answer, not a failure). */
  notFound: number;
  /** Requests issued this run, against the plan-derived budget. */
  requestsIssued: number;
  /** Response bytes, for bandwidth accounting against the plan. */
  bytes: number;
  /** Rows whose `listingId` had to be synthesised — see `resolveCandleListingId`. */
  synthesisedListingIds: number;
  /**
   * MONEY-1617 — bars DROPPED by the writer clip, by named reason: no master
   * window of the symbol on this venue covers the session, or several real
   * ones do and the fetched listing is not among them. Filing them under the
   * fetched listing is how 46,670 bars landed under ids that do not cover them.
   */
  clipDropped: { OUTSIDE_EVERY_WINDOW: number; AMBIGUOUS_WINDOW: number };
  /** Bars already stored at equal-or-stronger provenance. Evidence of liveness. */
  preserved: number;
  /**
   * Bars the repository archived to a GCS cold shard instead of Mongo.
   *
   * Expected to be ZERO on a healthy nightly: leg (a) walks ACTIVE listings over
   * a `lookbackDays` window, so every bar it fetches is inside the hot window by
   * construction. A non-zero count means a listing was deactivated under us, or
   * `lookbackDays` was widened past the window edge — both worth seeing.
   */
  archivedCold: number;
  /**
   * Cold-destined bars written to MONGO because no cold store is registered.
   *
   * Must be 0 in the worker: `initCandleColdStore()` runs at boot. Non-zero
   * means `GCP_STORAGE_BUCKET` is unset and the hot store is silently absorbing
   * rows it was not sized for.
   */
  coldFellBackToHot: number;
  /** Bars the repository refused: non-finite price or an invalid `ts`. */
  droppedNonFinite: number;
  /** Bars whose volume the repository clamped to 0. The bar is still written. */
  clampedVolume: number;
  /** Corporate actions read off this run's bars (leg c). */
  actions: DerivedCorporateAction[];
  /**
   * Distinct securities those actions touch.
   *
   * Was `caInvalidated`, which named an eviction this leg never performed —
   * MONEY-980 finding 5. The derivation is real and free; the application is
   * not available from here. Counting what we DID is the honest half.
   */
  caSecuritiesAffected: number;
  rateLimited: boolean;
  /**
   * Tiingo REFUSED the request (401/403) and we cannot say which cause.
   *
   * ONE flag where there were two — MONEY-980 review finding 1. `authFailed`
   * and `entitlementBlocked` were set from `TiingoAuthError.isTokenProblem`,
   * which the client decided by reading a response BODY it never had: the
   * archive seam throws on a non-OK status without reading it. So
   * `entitlementBlocked` could never be set and the `else` branch was dead
   * code, while a genuinely wrong `TIINGO_API_KEY_PROD` reached the operator
   * as "the plan does not cover this endpoint" — pointing away from the only
   * one of the two causes that changes between deploys. Both are
   * deterministic, both stop the run, and the MESSAGE names both checks, so
   * one flag is all the run can honestly carry.
   */
  accessRefused: boolean;
  /**
   * The refusal's operator-facing text, taken VERBATIM from the client.
   *
   * `TiingoAuthError.message` is built by `tiingoAuthMessage()`, which is
   * exported precisely so the wording is a tested property of one declaration
   * rather than a literal re-typed per consumer. Carrying the string is what
   * lets the PURE `judgeUsEodHealth` name both causes without a value import
   * from core.
   */
  accessRefusedDetail: string | null;
  stoppedOnBudget: boolean;
  stoppedOnQuota: boolean;
  /** Ids visited this run and not yet stamped. */
  pendingStamps: string[];
  /** Rows whose rotation marker actually moved. */
  stamped: number;
  /**
   * The oldest `usEodSyncedAt` on leg (a)'s page, epoch ms or null.
   *
   * ## Two markers where there was one
   *
   * There was a single `pageOldestSyncedAtMs`, written only by the leg the
   * caller passed `isFirstPage: true` — which was EQUITY, always. The
   * `rotationWrapped` derived from it then ended the WHOLE chain, so once the
   * equity partition came full circle the NAV leg stopped being offered links
   * even with a full page of never-synced funds pending. At ~49k MF listings
   * and 200 a link that rotation could never catch up, and it read `healthy`
   * every night because the 200 funds it did reach returned bars.
   *
   * The two legs are separate queries over disjoint partitions with their own
   * page sizes, so they wrap at different times and each needs its own
   * observation. `null` means the page was empty or led with never-synced rows;
   * both read as NOT wrapped, which is correct in both cases.
   */
  equityOldestSyncedAtMs: number | null;
  /** As {@link equityOldestSyncedAtMs}, for leg (b)'s own page. */
  mfOldestSyncedAtMs: number | null;

  // -- LEG (e): the forward corporate-actions CALENDAR (MONEY-1263) --------

  /** The ex-date this run asked about, or "" until the leg is reached. */
  caCalendarExDate: string;
  /**
   * Calls leg (e) issued - `null` until the leg RUNS.
   *
   * Nullable for the same reason `equitySelected` is: `0` is the answer "we got
   * here and the clock or the quota stopped us", `null` is "we never got here
   * at all". Only one of those is a reason to look at the leg order.
   */
  caAttempted: number | null;
  /** Rows RECEIVED across both routes, before dedupe. The liveness signal. */
  caRows: number;
  /** Rows the run tried to upsert (post-dedupe). */
  caOwed: number;
  /** Rows persisted. */
  caWritten: number;
  /** Rows dropped as an exact `(permaTicker, type, exDate)` repeat. */
  caDuplicates: number;
  /** Rows dropped for an unusable permaTicker or ex-date. */
  caUnusable: number;
  /** Distribution rows carrying CASH (`> 0`) - see `isCashDistribution`. */
  caCashDistributions: number;
  /** Split rows received. */
  caSplits: number;
  /** Rows whose permaTicker resolved unambiguously to a listing we carry. */
  caListingResolved: number;
  /**
   * `/tiingo/corporate-actions` answered 401/403.
   *
   * DELIBERATELY NOT `state.accessRefused`. That flag stops the chain, and the
   * corporate-actions family is a SEPARATE entitlement from `/tiingo/daily`: a
   * revoked beta must not be able to halt the US price rotation.
   */
  caRefused: boolean;
  caRefusedDetail: string | null;

  // -- LEG (f) IS RETIRED — MONEY-1309 --------------------------------------
  //
  // Ten news counters used to live here. They are gone with the leg, not
  // preserved as zeroes: a counter that is structurally always 0 reads as "the
  // work happened and produced nothing", which is the one thing it must not
  // say. The news counters now live on `TiingoNewsPollResult`, on the job that
  // actually does the work every 2 minutes.
}

type Db = typeof prisma;

/**
 * Injectable seams for the price legs — MONEY-1291.
 *
 * Production passes NONE of them, so the defaults ARE the production path and a
 * test drives the same loop the scheduler does. Added because the thing that
 * had to be asserted is a NEGATIVE — that an unkeyable fund costs ZERO Tiingo
 * requests — and a counter no test can observe is a counter no mutation can be
 * caught in: with `fetchTiingoEod` reached through a bare module import there
 * was no seam from which to count the calls that were NOT made.
 *
 * Scoped to the three things `runPriceLeg` touches outside itself. Each default
 * is the REAL collaborator rather than a quiet no-op, so a fixture that forgets
 * one opens a real socket instead of silently exercising an outage branch.
 */
export interface UsEodPriceLegDeps {
  prisma?: Db;
  fetchEod?: typeof fetchTiingoEod;
  putCandles?: typeof candleRepository.putCandles;
}

type ResolvedPriceLegDeps = Required<UsEodPriceLegDeps>;

function resolvePriceLegDeps(
  deps: UsEodPriceLegDeps = {},
): ResolvedPriceLegDeps {
  return {
    prisma: deps.prisma ?? prisma,
    fetchEod: deps.fetchEod ?? fetchTiingoEod,
    putCandles:
      deps.putCandles ?? candleRepository.putCandles.bind(candleRepository),
  };
}

/** What the route logs. Deliberately flat so a log line is greppable. */
export interface UsEodSyncResult {
  sessionDate: string;
  equitySelected: number;
  equityBars: number;
  equityWritten: number;
  /**
   * What each price leg PROVED tonight — MONEY-980 finding 2.
   *
   * Flat on the result, not folded into `ok`, because a leg with an empty
   * population is neither a failure worth paging for nor something an operator
   * may be left to infer from `mfSelected: 0`. `healthy` is EARNED here; it is
   * never what a leg gets for having nothing to do.
   */
  equityLeg: UsEodLegVerdict;
  mfLeg: UsEodLegVerdict;
  mfSelected: number;
  /** NAV points leg (b) RECEIVED. */
  mfBars: number;
  /** `UsFundNav` rows leg (b) persisted. NOT candles — see `writeFundNavs`. */
  mfWritten: number;
  /**
   * Funds fetched and skipped for want of a `permaTicker`.
   *
   * FLAT on the result rather than left in the log, because it is the state
   * that separates "Tiingo is dark" from "our own enrichment rotation is
   * behind", and those send an operator to two different jobs.
   */
  mfSkippedNoPermaTicker: number;
  /** Bars already stored at equal-or-stronger provenance — liveness, not a write. */
  preserved: number;
  /**
   * Bars routed to a GCS cold shard instead of Mongo.
   *
   * A falsifiable zero: leg (a) walks ACTIVE listings over a `lookbackDays`
   * window, so every bar it fetches is inside the hot window by construction.
   * Non-zero means a listing was deactivated under us or the window was
   * widened.
   */
  archivedCold: number;
  /**
   * Cold-destined bars that went to MONGO because no cold store is registered.
   *
   * Must be 0 in the worker — `initCandleColdStore()` runs at boot. Non-zero
   * means `GCP_STORAGE_BUCKET` is unset and the hot store is quietly absorbing
   * rows it was not sized for.
   */
  coldFellBackToHot: number;
  fxWritten: number;
  actionsDetected: number;
  /** Distinct securities this run's derived actions touch. */
  caSecuritiesAffected: number;
  /** Why leg (c) applied nothing. Constant today — see `CA_EVICTION_UNAVAILABLE`. */
  caEvictionUnavailable: string;
  /** The ex-date leg (e) asked about, "" if it never got that far. */
  caCalendarExDate: string;
  caLeg: UsEodLegVerdict;
  /** Rows leg (e) RECEIVED across both routes. Liveness, not a write. */
  caRows: number;
  /** `UsCorporateAction` rows leg (e) persisted. */
  caWritten: number;
  /**
   * Why leg (e) is not an adjustment source. Constant — see
   * `CA_CALENDAR_NOT_AN_ADJUSTMENT_SOURCE`. Flat on the result so the claim
   * travels with the run that made it, exactly like `caEvictionUnavailable`.
   */
  caCalendarNotAdjustment: string;
  // NO `news*` FIELDS — MONEY-1309 retired leg (f). They are not kept as
  // structural zeroes: `newsWritten: 0` on every run reads as "the news leg ran
  // and stored nothing", which is a claim this job is no longer entitled to
  // make. The poller reports its own counters on `TiingoNewsPollResult`.
  failed: number;
  transportFailures: number;
  notFound: number;
  requestsIssued: number;
  requestBudget: number;
  bytes: number;
  stamped: number;
  chained: boolean;
  ok: boolean;
  reason?: string;
}

/**
 * A fresh, zeroed tally. One per invocation, never shared.
 *
 * EXPORTED and factored out of `processUsEodSync` for MONEY-1291, so a test
 * driving `runPriceLeg` starts from the SAME initial state production does. A
 * hand-rolled literal in a test file is a second copy of a 60-field contract
 * that nothing can fail when the two drift — and every field here is a counter
 * whose starting value is the baseline an assertion is measured against.
 */
export function newUsEodRunState(): RunState {
  return {
    equityAttempted: 0,
    equityBars: 0,
    equityOwed: 0,
    equityWritten: 0,
    equitySelected: null,
    mfAttempted: 0,
    mfBars: 0,
    mfOwed: 0,
    mfWritten: 0,
    mfSelected: null,
    mfSkippedNoPermaTicker: 0,
    mfNavRefused: 0,
    mfNavDupInBatch: 0,
    mfNavDivCashClamped: 0,
    mfNavSplits: 0,
    mfNavSplitRefused: 0,
    fxAttempted: 0,
    fxWritten: 0,
    failed: 0,
    transportFailures: 0,
    notFound: 0,
    requestsIssued: 0,
    bytes: 0,
    synthesisedListingIds: 0,
    clipDropped: { OUTSIDE_EVERY_WINDOW: 0, AMBIGUOUS_WINDOW: 0 },
    preserved: 0,
    archivedCold: 0,
    coldFellBackToHot: 0,
    droppedNonFinite: 0,
    clampedVolume: 0,
    actions: [],
    caSecuritiesAffected: 0,
    rateLimited: false,
    accessRefused: false,
    accessRefusedDetail: null,
    stoppedOnBudget: false,
    stoppedOnQuota: false,
    pendingStamps: [],
    stamped: 0,
    equityOldestSyncedAtMs: null,
    mfOldestSyncedAtMs: null,
    caCalendarExDate: "",
    caAttempted: null,
    caRows: 0,
    caOwed: 0,
    caWritten: 0,
    caDuplicates: 0,
    caUnusable: 0,
    caCashDistributions: 0,
    caSplits: 0,
    caListingResolved: 0,
    caRefused: false,
    caRefusedDetail: null,
  };
}

export async function processUsEodSync(
  message: UsEodSyncMessage,
): Promise<UsEodSyncResult> {
  const startedAt = Date.now();
  const chainDepth = normalizeChainDepth(message.chainDepth);
  // Link 0 IS the chain's start; every later link carries the stamp forward.
  const chainStartedAt =
    normalizeChainStartedAt(message.chainStartedAt) ?? startedAt;

  const symbols =
    Array.isArray(message.symbols) && message.symbols.length > 0
      ? message.symbols
      : undefined;
  const symbolScoped = symbols !== undefined;
  const batchSize = clampBatchSize(
    message.batchSize,
    DEFAULT_US_EOD_BATCH_SIZE,
  );
  const mfBatchSize = clampBatchSize(
    message.mfBatchSize,
    DEFAULT_US_MF_BATCH_SIZE,
  );
  const lookbackDays = clampLookbackDays(message.lookbackDays);
  const skipFx = message.skipFx === true;

  // The plan ceilings are read HERE, per run, never captured in a module const
  // (MONEY-1262). `TIINGO_PLAN` defaults to COMMERCIAL — the LOWER pair — so an
  // unset or misspelled value throttles harder rather than walking into a 429
  // wall mid-page.
  const limits = tiingoLimits();
  const requestBudget = requestBudgetForRun(limits, RUN_TIME_BUDGET_MS);

  const sessionDate = resolveUsSessionDate(startedAt);
  const windowStart = resolveWindowStart(sessionDate, lookbackDays);

  const state: RunState = newUsEodRunState();

  logger.info(
    `Starting US EOD sync (session ${sessionDate}, window ${windowStart}.., ` +
      `chainDepth ${chainDepth}/${MAX_CHAIN_DEPTH}, batch ${batchSize}/${mfBatchSize}, ` +
      `plan budget ${requestBudget} req/run at ${limits.perHour}/hr, ` +
      `symbols ${symbols ? symbols.join(",") : "all"})`,
  );

  let chained = false;
  let verdict: UsEodHealthVerdict = {
    ok: true,
    legs: {
      equity: "notQueried",
      mf: "notQueried",
      ca: "notQueried",
    },
  };

  try {
    // ── LEG (a): EOD bars for ACTIVE US equities and ETFs ──────────────────
    await runPriceLeg({
      leg: "EQUITY",
      state,
      symbols,
      take: batchSize,
      startedAt,
      legBudgetMs: EQUITY_LEG_BUDGET_MS,
      requestBudget,
      windowStart,
      sessionDate,
    });

    // ── LEG (b): US mutual-fund NAVs ──────────────────────────────────────
    //
    // Runs from wherever leg (a) stopped up to the FULL run budget, never from
    // a share of what is left. Leg (a) yields at EQUITY_LEG_BUDGET_MS precisely
    // so this leg always has a floor: a class that always sorts last is the one
    // a wall-clock truncation always drops, and a dropped row keeps its stale
    // rotation marker and LEADS the next page — a livelock, not a delay
    // (MONEY-1255 A2).
    if (!state.rateLimited && !state.accessRefused) {
      await runPriceLeg({
        leg: "MF",
        state,
        symbols,
        take: mfBatchSize,
        startedAt,
        // PRICE_LEG_BUDGET_MS, not RUN_TIME_BUDGET_MS. Leg (b) used to run to
        // the full wall, which was correct while it was the last leg that
        // costs upstream time. Legs (e) and (f) now follow it, and both price
        // legs are rotations over populations far larger than one page — they
        // spend every millisecond offered. Without a reserved slice the new
        // legs would read "budget already gone" on their first check, every
        // night, for the life of the job.
        legBudgetMs: PRICE_LEG_BUDGET_MS,
        requestBudget,
        windowStart,
        sessionDate,
      });
    }

    // ── LEG (c): corporate-actions delta, derived and REPORTED ────────────
    reportCorporateActionLeg(state);

    // ── LEG (e): the forward corporate-actions CALENDAR ───────────────────
    //
    // AFTER the price legs, deliberately. See `PRICE_LEG_BUDGET_MS`: a refusal
    // circuit-breaks whatever follows it, and this endpoint family carries its
    // own entitlement, so first in the order a revoked beta would take the
    // whole US price backbone down with it every night.
    await runCorpActionCalendarLeg({
      state,
      sessionDate,
      startedAt,
      requestBudget,
    });

    // ── LEG (f) IS RETIRED — MONEY-1309 ───────────────────────────────────
    //
    // `runNewsLeg` used to run here. It was removed because THIS JOB'S CRON is
    // `0 11 * * 2-6` IST — a market schedule, correctly derived from a 16:00 ET
    // close and a 00:00 ET NAV boundary, and meaningless for news. Being
    // Tue-Sat it could not run at all on a Sunday or Monday IST; prod measured
    // a newest article 88h old and 29.6h mean ingest lag, while every run that
    // DID happen reported healthy. Replaced by `tiingo-news-poll`, every 2
    // minutes 24x7. Its floor and clamp guards moved across intact.

    // ── LEG (d): USDINR for the session ───────────────────────────────────
    if (!skipFx) {
      await runFxLeg(state, sessionDate);
    } else {
      logger.info("FX leg skipped by message (`skipFx: true`)");
    }
  } finally {
    // Stamp whatever is still un-stamped, INCLUDING on a throw. A visited row
    // that keeps its stale marker re-occupies the head of the queue on the next
    // run and is visited again — forever, for as long as it keeps failing.
    await flushStamps(state, prisma);

    // WORK OWED A WRITE, not rows looked at (MONEY-1250). A bar the repository
    // PRESERVED was owed nothing, which is what makes the night after a US
    // market holiday read 0-0 instead of 800-0 through the monitor's
    // clamped-difference query — and a DARK leg still contributes the symbols it
    // asked for, so a 403'd leg pages somebody instead of looking idle.
    const selected = computeSelected({
      equityOwed: state.equityOwed,
      equityAttempted: state.equityAttempted,
      equityBars: state.equityBars,
      mfOwed: state.mfOwed,
      mfAttempted: state.mfAttempted,
      mfBars: state.mfBars,
      fxAttempted: state.fxAttempted,
      // Leg (e) joins on the same terms: rows owed a write, plus the CALLS a
      // dark leg issued. `?? 0` because a leg that never ran owed nothing and
      // asked for nothing — its state is carried by the verdict, which is
      // where "never asked" belongs.
      caOwed: state.caOwed,
      caAttempted: state.caAttempted ?? 0,
      caRows: state.caRows,
    });
    const written =
      state.equityWritten + state.mfWritten + state.fxWritten + state.caWritten;

    verdict = judgeUsEodHealth({
      // `selected` and `attempted` are BOTH passed and they answer different
      // questions — MONEY-980 finding 2. `attempted === 0` happens for an empty
      // population AND for a budget-truncated run AND for a leg that never ran;
      // only `selected` separates them, and `null` is how "never asked" is
      // spelled.
      equitySelected: state.equitySelected,
      equityAttempted: state.equityAttempted,
      equityBars: state.equityBars,
      mfSelected: state.mfSelected,
      mfAttempted: state.mfAttempted,
      mfBars: state.mfBars,
      mfSkippedNoPermaTicker: state.mfSkippedNoPermaTicker,
      fxAttempted: state.fxAttempted,
      fxWritten: state.fxWritten,
      transportFailures: state.transportFailures,
      rateLimited: state.rateLimited,
      accessRefused: state.accessRefused,
      accessRefusedDetail: state.accessRefusedDetail,
      // The secondary leg carries its OWN refusal flag, not `accessRefused`.
      // `/tiingo/corporate-actions` is a separate entitlement from
      // `/tiingo/daily`, and folding them into one flag would let a revoked
      // beta stop the price chain.
      caAttempted: state.caAttempted,
      caRows: state.caRows,
      caRefused: state.caRefused,
      caRefusedDetail: state.caRefusedDetail,
    });

    logger.info(
      `Legs — EOD ${state.equityWritten} written / ${state.equityBars} received ` +
        `/ ${state.equityAttempted} symbols, ` +
        `NAV ${state.mfWritten} written / ${state.mfBars} received ` +
        `/ ${state.mfAttempted} funds` +
        (state.mfSkippedNoPermaTicker > 0
          ? ` (${state.mfSkippedNoPermaTicker} SKIPPED — no permaTicker)`
          : "") +
        (state.mfNavRefused > 0 || state.mfNavDupInBatch > 0
          ? ` (${state.mfNavRefused} refused, ${state.mfNavDupInBatch} dup)`
          : "") +
        (state.mfNavDivCashClamped > 0
          ? ` (${state.mfNavDivCashClamped} divCash CLAMPED)`
          : "") +
        (state.mfNavSplits > 0 ? ` (${state.mfNavSplits} SPLIT)` : "") +
        (state.mfNavSplitRefused > 0
          ? ` (${state.mfNavSplitRefused} split REFUSED)`
          : "") +
        ", " +
        `CA ${state.actions.length} detected / ${state.caSecuritiesAffected} ` +
        `securit(ies) (applied: none — see CA_EVICTION_UNAVAILABLE), ` +
        `FX ${state.fxWritten}/${state.fxAttempted}. ` +
        `CAL ${state.caWritten} written / ${state.caRows} received ` +
        `(${state.caSplits} split(s), ${state.caCashDistributions} cash ` +
        `distribution(s), ${state.caDuplicates} dup, ${state.caUnusable} ` +
        `unusable, ${state.caListingResolved} listing-joined) for ex-date ` +
        `${state.caCalendarExDate || "n/a"}. ` +
        // NO `NEWS …` segment — MONEY-1309 retired leg (f). News liveness is
        // now `tiingo-news-poll`'s own log line and its own job outcome.
        `LEGS eod=${verdict.legs.equity} nav=${verdict.legs.mf} ` +
        `cal=${verdict.legs.ca}. ` +
        `${state.requestsIssued}/${requestBudget} requests, ` +
        `${(state.bytes / 1_048_576).toFixed(2)} MiB, ` +
        `${state.failed} failed, ${state.transportFailures} transport, ` +
        `${state.notFound} not-found, ${state.preserved} preserved, ` +
        (state.archivedCold > 0
          ? `${state.archivedCold} archived-cold, `
          : "") +
        (state.coldFellBackToHot > 0
          ? `${state.coldFellBackToHot} COLD-FELL-BACK-TO-HOT, `
          : "") +
        `${state.droppedNonFinite} dropped, ${state.clampedVolume} volume-clamped, ` +
        `${state.stamped} stamped` +
        (state.synthesisedListingIds > 0
          ? `, ${state.synthesisedListingIds} SYNTHESISED listingId(s)`
          : "") +
        (state.clipDropped.OUTSIDE_EVERY_WINDOW +
          state.clipDropped.AMBIGUOUS_WINDOW >
        0
          ? `, clip dropped ${state.clipDropped.OUTSIDE_EVERY_WINDOW} ` +
            `OUTSIDE_EVERY_WINDOW / ${state.clipDropped.AMBIGUOUS_WINDOW} ` +
            "AMBIGUOUS_WINDOW"
          : "") +
        (state.stoppedOnBudget ? ", budget-truncated" : "") +
        (state.stoppedOnQuota ? ", quota-truncated" : ""),
    );

    // MONEY-1255 — the report lives in the `finally` so an IDLE run emits 0/0
    // rather than nothing. `apply-monitors.sh` creates this job's freshness
    // monitor with `notify_no_data: true`, so a job that emits nothing on a
    // quiet night sits in NO DATA — and a monitor that has never been green is
    // a monitor somebody mutes, which removes the only alert on the job that is
    // actually broken.
    reportJobOutcome({
      job: "us-eod-sync",
      selected,
      written,
      failed: state.failed,
      transportFailures: state.transportFailures,
      ...(verdict.reason ? { skippedReason: verdict.reason } : {}),
    });

    chained = await chainAnotherBatch({
      message,
      state,
      chainDepth,
      chainStartedAt,
      batchSize,
      mfBatchSize,
      symbolScoped,
    });
  }

  if (!verdict.ok) logger.error(verdict.reason);
  // A leg can be non-healthy without the RUN being a failure — an empty
  // population is the case this job actually has (MONEY-980 finding 2). It must
  // still be SAID: `ok: true` with no line is the silence the finding is about.
  // Warn, not error, because paging nightly for a known upstream emptiness is
  // how a monitor gets muted — and a muted monitor is how the leg that IS
  // broken goes unseen.
  else if (verdict.reason) logger.warn(verdict.reason);

  return {
    sessionDate,
    equitySelected: state.equitySelected ?? 0,
    equityBars: state.equityBars,
    equityWritten: state.equityWritten,
    equityLeg: verdict.legs.equity,
    mfLeg: verdict.legs.mf,
    mfSelected: state.mfSelected ?? 0,
    mfBars: state.mfBars,
    mfWritten: state.mfWritten,
    mfSkippedNoPermaTicker: state.mfSkippedNoPermaTicker,
    preserved: state.preserved,
    archivedCold: state.archivedCold,
    coldFellBackToHot: state.coldFellBackToHot,
    fxWritten: state.fxWritten,
    actionsDetected: state.actions.length,
    caSecuritiesAffected: state.caSecuritiesAffected,
    caEvictionUnavailable: CA_EVICTION_UNAVAILABLE,
    caCalendarExDate: state.caCalendarExDate,
    caLeg: verdict.legs.ca,
    caRows: state.caRows,
    caWritten: state.caWritten,
    caCalendarNotAdjustment: CA_CALENDAR_NOT_AN_ADJUSTMENT_SOURCE,
    failed: state.failed,
    transportFailures: state.transportFailures,
    notFound: state.notFound,
    requestsIssued: state.requestsIssued,
    requestBudget,
    bytes: state.bytes,
    stamped: state.stamped,
    chained,
    ok: verdict.ok,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  };
}

// ---------------------------------------------------------------------------
// LEGS (a) + (b) — the same walk over two disjoint partitions
// ---------------------------------------------------------------------------

/**
 * Walk one leg's page, fetch each symbol's trailing window, write the bars.
 *
 * Legs (a) and (b) are ONE function because they differ only in the partition
 * and the page size: a US mutual fund's NAV arrives in the same `/tiingo/daily`
 * response, in the same OHLC fields. They part company only at the WRITE —
 * `writeEquityCandles` vs `writeFundNavs`, two tables — and that split is a
 * dozen lines at the end of the loop rather than a second walk. A second copy
 * of the walk would be a second place for the rotation, the wall clock and the
 * stamping to be got subtly differently.
 */
export async function runPriceLeg(args: {
  leg: UsEodLeg;
  state: RunState;
  symbols?: string[];
  take: number;
  startedAt: number;
  legBudgetMs: number;
  requestBudget: number;
  windowStart: string;
  sessionDate: string;
  /** MONEY-1291. Omitted in production — the defaults ARE the real path. */
  deps?: UsEodPriceLegDeps;
}): Promise<void> {
  const {
    leg,
    state,
    symbols,
    take,
    startedAt,
    legBudgetMs,
    requestBudget,
    windowStart,
    sessionDate,
  } = args;
  const deps = resolvePriceLegDeps(args.deps);
  const db = deps.prisma;

  const rows: UsInstrumentRow[] = await db.usInstrument.findMany({
    where: buildUsEodWhere(leg, symbols),
    select: {
      id: true,
      symbol: true,
      exchange: true,
      listingId: true,
      listingStartDate: true,
      listingEndDate: true,
      // Carried onto every `CandleWriteRow` so the repository can route the bar
      // between Mongo and a GCS shard. `buildUsEodWhere` already narrows to
      // ACTIVE, so this is always "ACTIVE" today — passed anyway rather than
      // hardcoded, because the moment the filter widens (a repair run scoped by
      // symbol, say) a hardcoded "ACTIVE" would file a delisted security's
      // whole history into the hot store and nothing would say so.
      listingStatus: true,
      // Leg (b) only. `UsFundNav` REQUIRES it and it is null until the search
      // rotation reaches the row — see MF_NAV_NEEDS_PERMATICKER.
      permaTicker: true,
      // Read so the ROTATION WRAP can be observed. Never in the `where`.
      usEodSyncedAt: true,
    },
    // STALE FIRST. The marker is here and only here — see US_EOD_ORDER_BY.
    orderBy: [...US_EOD_ORDER_BY],
    take,
  });

  if (leg === "EQUITY") state.equitySelected = rows.length;
  else state.mfSelected = rows.length;

  // THIS leg's own rotation marker, never a shared one. The page is ordered
  // stale-first, so `rows[0]` carries the oldest marker in the partition this
  // query selected — and that is a fact about this partition alone. The
  // previous version recorded EQUITY's marker only and let it end the chain for
  // both legs; see `RunState.equityOldestSyncedAtMs`.
  if (rows.length > 0) {
    const oldest = rows[0]!.usEodSyncedAt;
    const oldestMs = oldest ? oldest.getTime() : null;
    if (leg === "EQUITY") state.equityOldestSyncedAtMs = oldestMs;
    else state.mfOldestSyncedAtMs = oldestMs;
  }

  if (rows.length === 0) {
    logger.info(`${leg} leg: no rows selected`);
    return;
  }

  logger.info(`${leg} leg: ${rows.length} row(s), stale first`);

  // MONEY-1617 — every master window of this page's symbols, ONE query per
  // chunk, so the writer can file each bar under the window that covers it.
  // A failed lookup degrades to "clip to the row's own window", never to a
  // failed leg: the row itself is always one of its windows.
  const windowsByVenue: Map<string, ListingRow[]> =
    leg === "EQUITY" ? await loadVenueWindows(db, rows) : new Map();

  // The archive partition: a nightly slice keeps its own object per symbol-year
  // instead of overwriting the backfill's whole-history copy.
  const sessionYear = Number(sessionDate.slice(0, 4));

  for (const row of rows) {
    if (!isWithinRunBudget(startedAt, Date.now(), legBudgetMs)) {
      state.stoppedOnBudget = true;
      logger.info(
        `${leg} leg: wall-clock budget reached after ${Date.now() - startedAt}ms ` +
          "— the rest keep their stale marker and lead the next page.",
      );
      break;
    }
    if (state.requestsIssued >= requestBudget) {
      state.stoppedOnQuota = true;
      logger.info(
        `${leg} leg: plan request budget (${requestBudget}) reached — stopping ` +
          "rather than discovering the ceiling as a 429.",
      );
      break;
    }

    // VISITED, therefore STAMPED — before the work, so a throw below cannot
    // leave the row un-stamped and re-occupying the head of the queue.
    state.pendingStamps.push(row.id);
    if (state.pendingStamps.length >= STAMP_CHUNK_SIZE) {
      await flushStamps(state, db);
    }

    // MONEY-1291 — THE SKIP HAPPENS BEFORE THE REQUEST, not after it.
    //
    // `UsFundNav` is unique on `(permaTicker, date)` and `permaTicker` arrives
    // from a DIFFERENT, paced rotation (`enrichUsInstrumentsWithPermaTicker`,
    // 800/page x 7 chained links = 5,600 ACTIVE rows a night). This guard used
    // to live inside `writeFundNavs`, so a fund with no key was FETCHED and
    // then discarded. Tiingo is a PAID METERED api: measured on prod
    // 2026-08-30, 46,908 of 49,846 NMFQS funds carried no `permaTicker`, which
    // is ~44,000 billed requests per full rotation buying nothing, every night
    // until the enricher converges (~8 nights from its 2026-08-29 start).
    //
    // The row is STILL STAMPED — the push above already ran, deliberately. An
    // unstamped row re-occupies the head of the rotation queue forever
    // (MONEY-1211), and "we looked at it and there was nothing to do" is a
    // visit. That half of the old comment was right; only the FETCH was
    // load-bearing in it, and it was not.
    //
    // `mfAttempted` is NOT incremented, because this row issued no request and
    // that counter's contract — here and in `UsEodHealthInput` — is "funds leg
    // (b) actually issued a request for". `computeSelected` reads it as work
    // OWED A BAR, which a fund we never asked about is not.
    //
    // CONSEQUENCE, written down rather than discovered later: on a page where
    // EVERY selected fund is unkeyable, `mfBars` is now 0 by construction
    // rather than by failure, so `judgeUsEodHealth`'s
    // `mfSkippedNoPermaTicker >= mfAttempted` branch — which assumes control
    // only reaches it when the leg RECEIVED NAVs — can no longer fire. Its
    // guard belongs in `us-eod-sync-logic.ts` and is tracked separately; see
    // the note on `writeFundNavs`.
    if (leg === "MF" && fundNavKey(row) === null) {
      state.mfSkippedNoPermaTicker++;
      logger.warn(`NAV leg: ${row.symbol} ${MF_NAV_NEEDS_PERMATICKER}`);
      continue;
    }

    if (leg === "EQUITY") state.equityAttempted++;
    else state.mfAttempted++;

    // MONEY-980 finding 8. The budget is charged from the `finally` below, for
    // requests ISSUED rather than requests that succeeded — see
    // `requestsSpentByCall`. A `let` outside the `try` because the charge has
    // to be decided by whether the call threw and applied on EVERY exit,
    // including the `continue`s and the `break`s inside the handler.
    let callThrew = false;

    try {
      // `endDate` is deliberately OMITTED. Bounding the window at the session
      // date could only ever return LESS: Tiingo corrects equities until 20:00
      // ET and a fund NAV lands after 00:00 ET, so an unbounded upper edge
      // captures a bar that has arrived since we computed the date, and the
      // upsert key makes a re-read of an unchanged bar a no-op.
      const res = await deps.fetchEod({
        symbol: row.symbol,
        startDate: windowStart,
        year: sessionYear,
      });

      if (res === null) {
        // 404 — the ticker does not exist upstream. A real answer, not a
        // failure, and NOT counted as one: conflating them is how a permanent
        // "not there" gets retried nightly forever (MONEY-1169).
        state.notFound++;
        continue;
      }

      state.bytes += res.bytes;
      // Counted BEFORE the write and separately from it: this is the liveness
      // signal, and it must not be entangled with whether the bars were new.
      if (leg === "EQUITY") state.equityBars += res.bars.length;
      else state.mfBars += res.bars.length;
      if (res.bars.length === 0) continue;

      if (leg === "MF") await writeFundNavs(state, row, res.bars, db);
      else {
        const wins = windowsByVenue.get(venueKey(row.symbol, row.exchange));
        await writeEquityCandles(state, row, res.bars, deps.putCandles, wins);
      }

      // Leg (c) reads the bars we already hold — no second request, and it runs
      // for BOTH legs. That is not incidental for funds: `divCash` is the one
      // column of a fund bar that is neither constant nor a copy of the NAV
      // (102 non-zero rows in VFIAX's 6,484), and `UsFundNav` has nowhere to
      // put it — so this derivation is the only place tonight's fund
      // distributions are seen at all. See `toFundNavRows`.
      const actions = detectCorporateActions({
        symbol: row.symbol,
        exchange: row.exchange,
        bars: res.bars,
      });
      if (actions.length > 0) state.actions.push(...actions);
    } catch (err) {
      callThrew = true;
      state.transportFailures++;

      if (err instanceof TiingoRateLimitError) {
        // CIRCUIT-BREAK THE WHOLE RUN. Budgets are per run, so continuing spends
        // the remaining wall clock collecting the same error, and the chain
        // deliberately does not continue either — a fresh link re-arms the
        // breaker straight back into the tarpit (MONEY-853).
        state.rateLimited = true;
        logger.error(
          // `requestsIssued` is charged in the `finally` BELOW, so at this
          // point it counts the requests issued BEFORE this symbol. Said
          // exactly rather than left as an off-by-one nobody can explain.
          `${leg} leg: Tiingo rate limit at ${row.symbol} — circuit-breaking ` +
            `this run after ${state.requestsIssued} prior request(s). ` +
            `${err.message}`,
        );
        break;
      }
      if (err instanceof TiingoAuthError) {
        // ONE branch, because there is only one fact. A 403 means EITHER a
        // rejected token OR an unentitled endpoint, and the two differ only in
        // a response body the archive seam throws away before we see it. The
        // old code branched on `isTokenProblem` and printed "PLAN DOES NOT
        // COVER THIS ENDPOINT" for every refusal — a confident answer derived
        // from `classifyTiingoError(status, "")`, an empty string at every call
        // site. Both causes are deterministic and both stop the run, so the
        // classification bought nothing and cost an operator the right lead.
        //
        // `err.message` is `tiingoAuthMessage()`'s text VERBATIM — it names
        // both causes and both checks, cheapest first. Reused rather than
        // restated so there is one wording to keep true.
        state.accessRefused = true;
        state.accessRefusedDetail = err.message;
        logger.error(`${leg} leg: at ${row.symbol} — ${err.message}`);
        break;
      }

      state.failed++;
      logger.warn(
        `${leg} leg: ${row.symbol} failed — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      // THE QUOTA METER, and it is the one counter in this file that must NOT
      // wait for a successful call — MONEY-980 finding 8. `attempted` and
      // `bars` are LIVENESS counters and MONEY-1255's rule applies to them:
      // count after the call, or a source that 403s every request still reports
      // a full number. `requestsIssued` measures SPEND, where the same rule
      // inverts — a failed call spends quota too, and the client's internal
      // ladder can spend it `MAX_RETRIES` times over. Counting only successes
      // made `stoppedOnQuota` unreachable on exactly the night it exists for.
      //
      // The ladder length is IMPORTED, never restated: `tiingo-client.ts`
      // exports `MAX_RETRIES` for exactly this reason, and a worker carrying
      // its own copy of that number would keep passing while the ladder moved
      // underneath it.
      //
      // In a `finally` so the 404 `continue`, the empty-window `continue` and
      // both circuit-breaking `break`s all pay for the request they issued: a
      // symbol that spent quota and then took an early exit must never be free.
      state.requestsIssued += requestsSpentByCall(callThrew, MAX_RETRIES);
    }
  }
}

const venueKey = (symbol: string, exchange: string): string =>
  `${symbol}\u0000${exchange}`;

/** MONEY-1617 — the page's symbols' master windows, grouped by symbol+venue. */
async function loadVenueWindows(
  db: Db,
  rows: readonly UsInstrumentRow[],
): Promise<Map<string, ListingRow[]>> {
  const out = new Map<string, ListingRow[]>();
  const symbols = [...new Set(rows.map((r) => r.symbol))];
  for (const slice of chunkList(symbols, CA_LOOKUP_CHUNK_SIZE)) {
    try {
      const found = await db.usInstrument.findMany({
        where: { symbol: { in: slice } },
        select: {
          symbol: true,
          exchange: true,
          listingId: true,
          listingStartDate: true,
          listingEndDate: true,
          listingStatus: true,
        },
      });
      for (const w of found) {
        if (!w.listingId) continue;
        const k = venueKey(w.symbol, w.exchange);
        const bucket = out.get(k);
        const win: ListingRow = { ...w, listingId: w.listingId };
        if (bucket) bucket.push(win);
        else out.set(k, [win]);
      }
    } catch (err) {
      logger.warn(
        `window lookup failed for ${slice.length} symbol(s); those rows clip ` +
          `to their own window only: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

/**
 * Leg (a)'s write: one symbol's bars -> `Candle`, via the repository.
 *
 * `listingStatus` rides along so `putCandles` can route each bar between Mongo
 * and a GCS cold shard. This job should never produce a cold bar — it walks
 * ACTIVE listings over a `lookbackDays` window — so `archivedCold` is a
 * falsifiable zero rather than a decorative counter.
 */
async function writeEquityCandles(
  state: RunState,
  row: UsInstrumentRow,
  bars: readonly EodBarInput[],
  putCandles: ResolvedPriceLegDeps["putCandles"],
  venueWindows: readonly ListingRow[] = [],
): Promise<void> {
  const { listingId, synthesised } = resolveCandleListingId({
    symbol: row.symbol,
    exchange: row.exchange,
    listingId: row.listingId,
    listingStartDate: row.listingStartDate,
  });
  if (synthesised) state.synthesisedListingIds++;

  // The row is ALWAYS one of its own windows, under the id it is written with.
  const windows: ListingRow[] = [
    ...venueWindows.filter((w) => w.listingId !== listingId),
    {
      symbol: row.symbol,
      exchange: row.exchange,
      listingId,
      listingStartDate: row.listingStartDate,
      listingEndDate: row.listingEndDate,
      listingStatus: row.listingStatus,
    },
  ];
  const clipped = toCandleRows({
    symbol: row.symbol,
    exchange: row.exchange,
    listingId,
    listingStatus: row.listingStatus,
    windows,
    bars,
  });
  state.clipDropped.OUTSIDE_EVERY_WINDOW +=
    clipped.dropped.OUTSIDE_EVERY_WINDOW;
  state.clipDropped.AMBIGUOUS_WINDOW += clipped.dropped.AMBIGUOUS_WINDOW;
  const upserts: CandleWriteRow[] = clipped.rows;
  if (upserts.length === 0) return;

  const w = await putCandles(upserts);
  // WRITTEN is `created + upgraded`. `preserved` is a bar the repository found
  // already stored at equal-or-stronger provenance — the run's work was
  // correct, but it was not a write, and counting it would make the zero-write
  // metric unable to tell a live pipeline from a dead one. `computeSelected` is
  // the other half of that: a preserved bar is owed nothing, so an idempotent
  // re-read reports 0-0 rather than 800-0.
  //
  // `archivedCold` joins WRITTEN, because a bar in a GCS shard IS persisted —
  // leaving it out would make every cold-routed bar look like a loss. It joins
  // OWED for the same reason `created` does. `coldFailed` is already inside
  // `failed`, so it is not added again.
  state.equityWritten += w.created + w.upgraded + w.archivedCold;
  state.equityOwed +=
    w.created + w.upgraded + w.archivedCold + w.failed + w.droppedNonFinite;
  state.failed += w.failed;
  state.preserved += w.preserved;
  state.droppedNonFinite += w.droppedNonFinite;
  state.clampedVolume += w.clampedVolume;
  state.archivedCold += w.archivedCold;
  state.coldFellBackToHot += w.coldFellBackToHot;
}

/**
 * Leg (b)'s write: one fund's NAVs -> `UsFundNav`. NOT `Candle`.
 *
 * ## Why this leg left the candle table (MONEY-980 C3)
 *
 * A NAV is one daily point, not an OHLCV bar. Measured across 22,096 fund bars
 * from three funds on 2026-08-28, `open == high == low == close` in EVERY row,
 * `volume == 0` in every row and `splitFactor == 1` in every row — so four of
 * `Candle`'s columns carried no information for a fund. At 49,414 of 72,685 US
 * listings, funds are 72% of the bars in any hot-window depth (105.9M rows for
 * a 10-year window with them, 33.8M without), which made that redundancy the
 * largest single term in the storage budget. `toFundNavRows` holds the shaping
 * and the full measurement.
 *
 * ## A fund with no permaTicker is SKIPPED, loudly and countably
 *
 * `UsFundNav.permaTicker` is required and is half the unique key;
 * `UsInstrument.permaTicker` is optional and filled by a different rotation. The
 * symbol is NOT substituted — see `MF_NAV_NEEDS_PERMATICKER`.
 *
 * The row is still STAMPED (the caller stamped it before this ran), which is
 * correct: it was visited, and an unstamped row re-occupies the head of the
 * queue forever (MONEY-1211).
 *
 * ## What changed in MONEY-1291, and what the guard below is now for
 *
 * This used to be the ONLY place the check happened, so the fetch had already
 * been paid for by the time the row was found unkeyable — and the sentence that
 * stood here called that "the price of not writing a fabricated key". It was
 * not: nothing about declining to fabricate a key requires having bought the
 * bars first. Measured on prod 2026-08-30, 46,908 of 49,846 NMFQS funds carried
 * no `permaTicker` (`backfill_checkpoints{jobKey:"tiingo-us-eod"}` recorded
 * 46,969 `NO_PERMATICKER`), so the discard cost ~44,000 billed requests on a
 * PAID METERED api per full rotation, nightly, until the enricher converged.
 * `runPriceLeg` now decides BEFORE issuing the request, and the fund's slot in
 * the plan request budget goes to a fund that can actually be written.
 *
 * The check below stays as BELT AND BRACES — it is the invariant `UsFundNav`'s
 * unique key actually needs, and a second caller added later must not be able
 * to reach the upsert without it. Both sites resolve the key through
 * `fundNavKey`, so the `.trim()` cannot drift between them. It is unreachable
 * from `runPriceLeg` today, which is why the counter it increments is asserted
 * at the CALLER in the tests rather than here.
 *
 * ## The consequence that is NOT fixed here
 *
 * `judgeUsEodHealth`'s "NAV leg wrote NOTHING: all N fund(s) ... have no
 * permaTicker" branch is keyed on `mfSkippedNoPermaTicker >= mfAttempted` and
 * sits AFTER the dark branch, on the documented assumption that "control only
 * reaches here when the leg RECEIVED NAVs". Skipping before the fetch breaks
 * that assumption: a skipped fund now contributes no bars, so the branch cannot
 * fire, and a page in which EVERY fund is unkeyable reads `notReached` instead.
 * The counters here are left HONEST rather than padded to keep that branch
 * alive — `mfAttempted` means "issued a request for" in this file and in
 * `UsEodHealthInput`, and `computeSelected` reads it as work owed a bar. The
 * guard belongs in `judgeLegVerdict` / `judgeUsEodHealth`, in
 * `us-eod-sync-logic.ts`, and is tracked separately.
 */
async function writeFundNavs(
  state: RunState,
  row: UsInstrumentRow,
  bars: readonly EodBarInput[],
  db: Db,
): Promise<void> {
  const permaTicker = fundNavKey(row);
  if (permaTicker === null) {
    state.mfSkippedNoPermaTicker++;
    logger.warn(`NAV leg: ${row.symbol} ${MF_NAV_NEEDS_PERMATICKER}`);
    return;
  }

  const shaped = toFundNavRows({ symbol: row.symbol, permaTicker, bars });
  state.mfNavRefused += shaped.badDate + shaped.badNav;
  state.mfNavDupInBatch += shaped.dupInBatch;
  state.mfNavDivCashClamped += shaped.divCashClamped;
  state.mfNavSplitRefused += shaped.splitFactorRefused;
  state.mfNavSplits += shaped.rows.filter(
    (r) => r.splitFactor !== undefined,
  ).length;

  for (const nav of shaped.rows) {
    state.mfOwed++;
    try {
      await db.usFundNav.upsert({
        where: {
          permaTicker_date: { permaTicker: nav.permaTicker, date: nav.date },
        },
        create: {
          permaTicker: nav.permaTicker,
          symbol: nav.symbol,
          date: nav.date,
          nav: nav.nav,
          divCash: nav.divCash,
          // SPARSE: the key is present only for a real split. Spreading an
          // empty object is what makes "no split" an ABSENT field rather than a
          // stored 1.0 — the distinction the column is designed around, and one
          // a `?? 1` here would quietly destroy across ~73.5M rows.
          ...(nav.splitFactor !== undefined
            ? { splitFactor: nav.splitFactor }
            : {}),
          source: nav.source,
        },
        // A re-read of the same session can only CORRECT the NAV — Tiingo
        // restates funds after the 12:00 AM ET publication. `symbol` is
        // refreshed too: a fund can be renamed under a stable permaTicker,
        // which is the entire reason the key is the permaTicker.
        //
        // `divCash` MUST be in the update as well as the create, and it is the
        // half that is easy to leave out. Leg (b) runs a trailing window, so a
        // distribution date is re-read for `lookbackDays` after it lands — and
        // Tiingo publishes the NAV before the distribution settles, so the
        // FIRST write of a payout date is routinely `divCash: 0` and the
        // correction arrives on a later run. Create-only would freeze that zero
        // permanently, which reads as "measured, no distribution" and is
        // indistinguishable from the truth.
        update: {
          symbol: nav.symbol,
          nav: nav.nav,
          divCash: nav.divCash,
          // The MIRROR of the create, and it cannot simply omit the key.
          //
          // Omitting leaves whatever is already stored, so a row written when
          // Tiingo reported a split that it later corrects to 1 would keep a
          // PHANTOM SPLIT for ever — an 83-94% cliff in the adjusted series, on
          // a date where nothing happened, with no way to tell it from a real
          // one. `unset: true` REMOVES the field, which is the only spelling
          // that restores the "absent means no split" contract; `null` would
          // invent a third state on a column whose entire design is that absent
          // means one specific thing.
          splitFactor:
            nav.splitFactor !== undefined
              ? { set: nav.splitFactor }
              : { unset: true },
          source: nav.source,
        },
      });
      // AFTER the write.
      state.mfWritten++;
    } catch (err) {
      state.failed++;
      logger.warn(
        `NAV leg: upsert failed for ${nav.symbol} ${nav.date.toISOString().slice(0, 10)} — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// LEG (c) — corporate actions, DERIVED and REPORTED (never applied from here)
// ---------------------------------------------------------------------------

/**
 * Record this run's derived corporate actions. It performs NO eviction.
 *
 * ## What changed and why (MONEY-980 finding 5)
 *
 * This used to call `clearCachePattern(adjustedSeriesCachePattern(...))` per
 * affected security. That pattern — `candles:adj:{exchange}:{symbol}:*` —
 * appeared in exactly ONE place in the repository: the function that built it.
 * Nothing wrote the namespace, so every call deleted 0 keys, and the
 * falsifiability this leg's own doc defined ("actions detected and zero keys
 * cleared, night after night, means the pattern and the repository's key
 * namespace have drifted apart") was tripped on the first run and every run
 * after. A signal that is red on a healthy night is not a signal.
 *
 * The real namespace is the COLD SHARD cache — `candles-cold`, scope
 * `_global`, identifier `candles/{market}/{timeframe}/{symbol}/{year}` — and it
 * holds RAW bars for CLOSED symbol-years. `CandleRepository.getCandles`
 * recomputes the adjusted series on every read and caches nothing, so a split
 * detected tonight stales none of it; the new bar lands in hot Mongo, which
 * wins the hot/cold merge. Evicting it would discard correct data. And the
 * repository exposes no eviction entry point, while two of the four key
 * segments are private to modules this job must not restate. See
 * `CA_EVICTION_UNAVAILABLE` in the logic module for the full reading.
 *
 * ## What the leg still is
 *
 * The DERIVATION is real, free and correct: `divCash` and `splitFactor` ride on
 * bytes legs (a) and (b) already downloaded, so the delta costs zero extra
 * requests and cannot drift from the prices because it IS the prices. What this
 * run knows is reported — count of actions, count of distinct securities — and
 * what it cannot do is NAMED rather than faked as a zero. The eviction lands
 * beside the write that invalidates it, in the module that owns the namespace,
 * on the day `CandleRepository` grows an adjusted-series cache.
 *
 * Synchronous now: with no Redis round trip there is nothing to await, and an
 * `async` signature would imply an I/O cost this function no longer has.
 */
function reportCorporateActionLeg(state: RunState): void {
  if (state.actions.length === 0) return;

  const affected = affectedSecurities(state.actions);
  state.caSecuritiesAffected = affected.length;

  const splits = state.actions.filter((a) => a.kind === "SPLIT").length;
  logger.info(
    `CA leg: ${state.actions.length} action(s) derived from bars we already ` +
      `held (${splits} split(s), ${state.actions.length - splits} distribution(s)) ` +
      `across ${affected.length} securit(ies). ZERO extra Tiingo requests — the ` +
      "dedicated corporate-actions endpoints 403 on our plan. APPLIED: NOTHING — " +
      CA_EVICTION_UNAVAILABLE,
  );
}

// ---------------------------------------------------------------------------
// LEG (e) - the forward corporate-actions CALENDAR (MONEY-1263)
// ---------------------------------------------------------------------------

/**
 * One ex-date's distributions and splits, market-wide, written as a CALENDAR.
 *
 * ## What this leg is for, and what it must never become
 *
 * Leg (c) reads corporate actions off price bars, and a bar exists only AFTER
 * its session - so the derived path can only ever say what already happened.
 * This leg asks `?exDate=<the next trading day>` and records what is ABOUT to
 * happen, plus the declaration / record / payment dates no bar carries.
 *
 * It is NOT an adjustment source and it must never be wired to one. The two
 * sources agreed on 504 of 504 measured events, which is exactly what would
 * make a double-count invisible if leg (e)'s rows ever reached the adjustment
 * path. `UsCorporateAction` is written here and read by nothing in this file.
 * See `CA_CALENDAR_NOT_AN_ADJUSTMENT_SOURCE`.
 *
 * ## Parsing, shaping, keying and dedupe are all IMPORTED
 *
 * `toUsCorporateActionRows` and `dedupeCorpActions` come from
 * `tiingo-corp-actions-logic`, which the day-walk backfill uses too. A second
 * implementation living here could disagree with that one - and the specific
 * disagreement that matters is the dedupe key: anything but
 * `(permaTicker, type, exDate)` drops a real split for a real company (two
 * `reax` rows on 2026-08-25, two different permaTickers, one ticker string)
 * with no error and no counter.
 *
 * ## Three counted states before a single call is made
 *
 *   the run had circuit-broken  -> `caAttempted` stays NULL   -> notQueried
 *   the clock or quota stopped  -> `caAttempted` becomes 0    -> notReached
 *   a call was issued           -> `caAttempted` counts it    -> dark|healthy
 *
 * That is the MONEY-980 finding-2 rule applied to a leg with no local
 * population: `0` is an answer ("we got here and could not start") and `null`
 * is the absence of one ("we never got here").
 *
 * ## A rate limit is global; a 403 here is NOT
 *
 * `TiingoRateLimitError` sets `state.rateLimited`, because the quota belongs to
 * the token and a fresh chain link re-arms the breaker into the same wall
 * (MONEY-853). `TiingoAuthError` sets `state.caRefused` and NOT
 * `state.accessRefused`: `/tiingo/corporate-actions` is a separate entitlement
 * from `/tiingo/daily`, and a revoked beta must not be able to stop the US
 * price rotation. `judgeUsEodHealth` still fails the run and names it - and,
 * because the price legs ran FIRST on the same token, it can say whether the
 * token is exonerated (`describeSecondaryRefusal`).
 */
async function runCorpActionCalendarLeg(args: {
  state: RunState;
  sessionDate: string;
  startedAt: number;
  requestBudget: number;
}): Promise<void> {
  const { state, sessionDate, startedAt, requestBudget } = args;

  if (state.rateLimited || state.accessRefused) {
    logger.info(
      "CA calendar leg: NOT QUERIED — the run had already circuit-broken on " +
        "a rate limit or a /tiingo/daily refusal.",
    );
    return;
  }

  // REACHED. From here `null` would be a lie, so the counter becomes a number.
  state.caAttempted = 0;

  // The ACK-DEADLINE gate, not `RUN_TIME_BUDGET_MS`. This leg issues TWO calls
  // and each can walk a 155s retry ladder, so the entry check has to reserve
  // room for a call rather than merely confirm the run still has work time —
  // see `UPSTREAM_CALL_DEADLINE_MS`.
  if (!isWithinRunBudget(startedAt, Date.now(), UPSTREAM_CALL_DEADLINE_MS)) {
    state.stoppedOnBudget = true;
    logger.info(
      `CA calendar leg: call deadline (${UPSTREAM_CALL_DEADLINE_MS}ms) reached ` +
        `after ${Date.now() - startedAt}ms — no call issued. The target ` +
        "ex-date is asked about only on the night before it, so this one needs " +
        "a day-walk repair rather than the rotation.",
    );
    return;
  }
  if (state.requestsIssued >= requestBudget) {
    state.stoppedOnQuota = true;
    logger.info(
      `CA calendar leg: plan request budget (${requestBudget}) reached — ` +
        "stopping rather than discovering the ceiling as a 429.",
    );
    return;
  }

  const exDate = resolveCalendarExDate(sessionDate);
  state.caCalendarExDate = exDate;

  let distributions: TiingoDistributionRow[] = [];
  let splits: TiingoSplitRow[] = [];

  // TWO routes, TWO requests, ONE ex-date. There is no market-wide range form:
  // `startExDate`/`endExDate` are rejected here and omitting `exDate` is a 400,
  // which is why the horizon is bought a day at a time.
  for (const route of ["distributions", "splits"] as const) {
    if (state.rateLimited || state.caRefused) break;
    // THE CLOCK, PER ROUTE — the F2 fix. This loop re-checked the QUOTA and not
    // the clock, so the entry gate above was the only clock check the leg had:
    // a run arriving at 419.9s passed it once and could then issue both 155s
    // calls back to back, finishing at ~730s against a 600s ack deadline. The
    // first call is bounded by the entry gate; this is what bounds the second.
    if (!isWithinRunBudget(startedAt, Date.now(), UPSTREAM_CALL_DEADLINE_MS)) {
      state.stoppedOnBudget = true;
      logger.info(
        `CA calendar leg: call deadline reached after ${Date.now() - startedAt}ms ` +
          `— ${route} NOT issued for ex-date ${exDate}. The day needs a ` +
          "day-walk repair; the rotation does not re-offer it.",
      );
      break;
    }
    if (state.requestsIssued >= requestBudget) {
      state.stoppedOnQuota = true;
      break;
    }

    let threw = false;
    try {
      const res =
        route === "distributions"
          ? await fetchDistributionsByExDate(exDate)
          : await fetchSplitsByExDate(exDate);

      if (res === null) {
        // A 404 is a MOVED ENDPOINT, not an empty day — the client is explicit
        // about that, and the two are checkpointed differently by the backfill.
        // Counted as a transport failure so it cannot pass as a quiet market;
        // it contributes nothing to `caRows`, so the leg lands as `dark`.
        state.transportFailures++;
        logger.error(
          `CA calendar leg: ${route} for ${exDate} returned 404 — the route ` +
            "has MOVED. That is not an empty day.",
        );
        continue;
      }

      // AFTER the call. A counter incremented BEFORE the call it counts reports
      // a full number for a route that 403s every request — the MONEY-1255
      // defect every leg in this job is arranged to make impossible.
      state.bytes += res.bytes;
      state.caRows += res.rows.length;
      if (route === "splits") {
        splits = res.rows as TiingoSplitRow[];
        state.caSplits += splits.length;
      } else {
        distributions = res.rows as TiingoDistributionRow[];
        for (const row of distributions) {
          // `> 0`, never `!= null`. A genuine 0.0 distribution exists in the
          // live data; `!= null` would call a zero-cash calendar entry a
          // dividend. The ROW is still written — this counts what carries cash.
          if (isCashDistribution(row.distribution)) state.caCashDistributions++;
        }
      }
      logger.info(
        `CA calendar leg: ${route} for ${exDate} returned ` +
          `${res.rows.length} row(s), ${res.bytes} byte(s)`,
      );
    } catch (err) {
      threw = true;
      state.transportFailures++;
      if (err instanceof TiingoRateLimitError) {
        // GLOBAL. The quota belongs to the token, not to the endpoint.
        state.rateLimited = true;
        logger.error(
          `CA calendar leg: Tiingo rate limit on ${route} — circuit-breaking ` +
            `this run. ${err.message}`,
        );
      } else if (err instanceof TiingoAuthError) {
        // NOT global. See this function's header: a separate entitlement must
        // not be able to stop the price chain.
        state.caRefused = true;
        state.caRefusedDetail = err.message;
        logger.error(`CA calendar leg: refused on ${route} — ${err.message}`);
      } else {
        logger.warn(
          `CA calendar leg: ${route} failed — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } finally {
      // THE QUOTA METER, charged for requests ISSUED rather than requests that
      // succeeded, and sized by the client's OWN ladder constant. Same rule and
      // same reasoning as the price legs — see `requestsSpentByCall`.
      state.caAttempted = (state.caAttempted ?? 0) + 1;
      state.requestsIssued += requestsSpentByCall(threw, MAX_RETRIES);
    }
  }

  if (distributions.length === 0 && splits.length === 0) return;

  // The listing join, keyed by UPPERCASE ticker because that is what
  // `toUsCorporateActionRows` looks up — and uppercase because the
  // corporate-actions API returns `aapl` while every US row this repo already
  // writes takes its symbol from the master and is `AAPL`.
  //
  // `listingStatus` is deliberately NOT in the where. A delisted row is exactly
  // what the occupancy window is there to reject, and excluding it up front
  // would hide the ambiguity rather than resolve it.
  const tickers = [
    ...new Set(
      [...distributions, ...splits].map((r) => r.ticker.trim().toUpperCase()),
    ),
  ].filter((t) => t !== "");

  const masterRows: Array<{
    symbol: string;
    listingId: string | null;
    listingStartDate: Date | null;
    listingEndDate: Date | null;
  }> = [];
  for (const slice of chunkList(tickers, CA_LOOKUP_CHUNK_SIZE)) {
    try {
      const found = await prisma.usInstrument.findMany({
        where: { symbol: { in: slice } },
        select: {
          symbol: true,
          listingId: true,
          listingStartDate: true,
          listingEndDate: true,
        },
      });
      masterRows.push(...found);
    } catch (err) {
      // A failed JOIN is not a failed LEG. Every row still writes, with a null
      // `listingId` — the same state the schema already uses for "we do not
      // carry this", recoverable by a later pass. Dropping the rows would not be.
      logger.warn(
        `CA calendar leg: listing lookup failed for ${slice.length} ticker(s); ` +
          "those rows write with listingId null: " +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const listings = buildListingWindowIndex({ exDate, rows: masterRows });

  // SHAPED and DEDUPED by the client's own logic, never by a copy living here.
  const deduped = dedupeCorpActions(
    toUsCorporateActionRows({ distributions, splits, listings }),
  );
  state.caDuplicates += deduped.dropped;
  // Rows the shaping refused (an unparseable ex-date) are the difference
  // between what came off the wire and what survived. Reported rather than
  // inferred: a rising count means the feed's date format moved.
  state.caUnusable +=
    distributions.length +
    splits.length -
    deduped.rows.length -
    deduped.dropped;

  for (const row of deduped.rows) {
    if (row.listingId) state.caListingResolved++;
    // OWED counts the attempt, so `selected - written` is exactly the failures.
    state.caOwed++;
    try {
      await prisma.usCorporateAction.upsert({
        where: {
          permaTicker_type_exDate: {
            permaTicker: row.permaTicker,
            type: row.type,
            exDate: row.exDate,
          },
        },
        create: { ...row },
        // A re-read of the SAME ex-date must be able to fill in the
        // announcement dates, which arrive LATE: they were added upstream in
        // 2024-01 and backfilled only to 2020, so a null today can become a
        // real date tomorrow. `listingId` is refreshed too — a security we did
        // not carry when the calendar entry was first written may be in the
        // master by the time its ex-date arrives.
        //
        // The three key columns are NOT in the update: they are the identity
        // this row was found by, so writing them back is either a no-op or a
        // key change disguised as a field update.
        update: {
          symbol: row.symbol,
          listingId: row.listingId,
          distribution: row.distribution,
          distributionFrequency: row.distributionFrequency,
          splitFactor: row.splitFactor,
          splitFrom: row.splitFrom,
          splitTo: row.splitTo,
          paymentDate: row.paymentDate,
          recordDate: row.recordDate,
          declarationDate: row.declarationDate,
          currency: row.currency,
          source: row.source,
        },
      });
      // AFTER the write.
      state.caWritten++;
    } catch (err) {
      state.failed++;
      logger.warn(
        `CA calendar leg: upsert failed for ${row.permaTicker} ${row.type} ` +
          `${exDate} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  logger.info(
    `CA calendar leg: ex-date ${exDate} — ${state.caWritten}/${state.caOwed} ` +
      `row(s) written, ${listings.size} of ${tickers.length} ticker(s) joined ` +
      `to a listing. ${CA_CALENDAR_NOT_AN_ADJUSTMENT_SOURCE}`,
  );
}

// ---------------------------------------------------------------------------
// LEG (f) — RETIRED (MONEY-1309)
// ---------------------------------------------------------------------------
//
// `runNewsLeg` lived here: one market-wide `/tiingo/news` call per session,
// paged on `offset`, fanned out to one `us_stock_news` row per carried ticker.
//
// It was NOT removed for being wrong. Every guard it carried was correct and
// hard-won — the explicit `limit` (an unparameterised call silently takes
// Tiingo's server default of 100 rows of a market-wide feed, newest-first), the
// offset-ceiling REFUSAL (measured: `offset=10000` returns zero rows, which is
// indistinguishable from "no more news"), and the double floor/clamp guard (a
// pre-floor request answers HTTP 200 with rows from the FLOOR date, so it can
// only be caught by refusing to build the URL and by re-checking the dates that
// came back). ALL of those moved intact into
// `workers/src/processors/tiingo-news-poll.ts`.
//
// What was wrong was the SCHEDULE, and it was wrong in a way no counter here
// could express. This job's cron is `0 11 * * 2-6` IST, derived from a 16:00 ET
// close and a 00:00 ET NAV boundary — impeccable reasoning about a MARKET. News
// is not a market: it does not close at 16:00 and it does not stop on Saturday,
// and a Tue-Sat cron cannot run at all on a Sunday or Monday IST. Measured on
// prod 2026-08-31: newest article 88 HOURS old, mean ingest lag 29.6 hours,
// while every run that did happen fetched its day, wrote its rows and landed
// `healthy`. The defect was in the gaps between runs.
//
// The replacement polls every 2 minutes, 24x7, and keys an ARTICLE-level store
// on Tiingo's own article id — so one story mentioning five companies is one
// row that says so, and the overlapping cursor window that makes a 2-minute
// poller safe costs one idempotent upsert rather than a duplicate.
//
// `us_stock_news` is NOT deleted and NOT migrated. Its rows stay; this job just
// stops adding to them.

// ---------------------------------------------------------------------------
// LEG (d) — USDINR (MONEY-980 task 7)
// ---------------------------------------------------------------------------

/**
 * Write the session's USDINR rate.
 *
 * `date` is the SESSION day, `asOf` is now. That split is the whole point of
 * the column: a rate observed at 11:00 IST on the calendar day AFTER the US
 * close still DESCRIBES the session that closed, and stamping it with the
 * observation day would shift every converted portfolio value by one day.
 *
 * `resolveUsSessionDate` is what makes that true, and it stopped being trivial
 * when the trigger moved: at 11:00 IST New York has just passed MIDNIGHT, so
 * "today in New York" is a session that has not opened. Read its doc before
 * changing either the schedule or that function.
 *
 * A rate is written for a US market HOLIDAY too, and that is correct rather
 * than sloppy: USDINR trades on days the US equity market is shut, so the row
 * is a true statement about a currency, not a claim that a session happened.
 *
 * Never writes on a null rate. `getExchangeRate` already refuses a
 * zero/negative/NaN quote, and a missing rate must not be allowed to overwrite
 * a good one with a fabricated number — the FX row feeds every USD->INR
 * conversion on the platform.
 */
async function runFxLeg(state: RunState, sessionDate: string): Promise<void> {
  state.fxAttempted++;
  try {
    const rate = await getExchangeRate("USD", "INR");
    if (rate === null || !Number.isFinite(rate) || rate <= 0) {
      logger.warn(
        `FX leg: no usable USDINR rate for ${sessionDate} — writing NOTHING. ` +
          "A fabricated rate is worse than a stale one.",
      );
      return;
    }

    const date = utcMidnight(sessionDate);
    const asOf = new Date();
    await prisma.fxRate.upsert({
      where: { pair_date: { pair: FX_PAIR, date } },
      create: { pair: FX_PAIR, date, rate, source: FX_SOURCE, asOf },
      update: { rate, source: FX_SOURCE, asOf },
    });
    // AFTER the write.
    state.fxWritten++;
    logger.info(`FX leg: ${FX_PAIR} ${rate} for session ${sessionDate}`);
  } catch (err) {
    state.transportFailures++;
    logger.warn(
      `FX leg failed for ${sessionDate} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// ROTATION
// ---------------------------------------------------------------------------

/**
 * Stamp every VISITED row's rotation marker and clear the pending buffer.
 *
 * Chunked rather than per-row so a page costs ~8 round trips instead of 800,
 * and flushed from the `finally` so a throw still advances the rotation for
 * everything already visited. Stamping only on a WRITE is how the sibling
 * `annual-reports-sync` stalled: a symbol that legitimately produces no bars
 * keeps its stale marker and re-occupies the head of the queue forever.
 *
 * A failed stamp is logged and the ids are DROPPED rather than retried
 * indefinitely — the cost is that those rows are visited again next run, which
 * is the same cost as not having stamped them, and retrying inside a `finally`
 * on a budget-exhausted run is how a 420s job becomes a 600s one.
 */
async function flushStamps(state: RunState, db: Db): Promise<void> {
  if (state.pendingStamps.length === 0) return;
  const ids = state.pendingStamps;
  state.pendingStamps = [];
  try {
    const res = await db.usInstrument.updateMany({
      where: { id: { in: ids } },
      data: { usEodSyncedAt: new Date() },
    });
    state.stamped += res.count;
  } catch (err) {
    logger.warn(
      `Failed to stamp ${ids.length} rotation marker(s) — those rows will be ` +
        `revisited next run: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// SELF-CHAIN
// ---------------------------------------------------------------------------

/**
 * Publish the NEXT link of the rotation chain — and never throw doing it.
 *
 * ## Why a chain rather than a bigger page
 *
 * 14,041 ACTIVE US securities against a run that must finish inside a 600s ack
 * deadline. A page cannot cover that: per-symbol cost is a paced network round
 * trip against a quota that reports nothing, so a bigger count only moves the
 * cliff (MONEY-1201 tried exactly that and wrote down why). More RUNS is the
 * lever `workers/CLAUDE.md` names, and self-chaining is how one trigger buys
 * them without twenty scheduler entries fighting for the same quota.
 *
 * ## Why it terminates
 *
 * `shouldChainAnotherBatch` refuses once `chainDepth + 1` reaches
 * `MAX_CHAIN_DEPTH`, and every published message carries `chainDepth + 1`. That
 * bound holds regardless of the database, the upstream or the clock, none of
 * which the decision function consults. The six other stop conditions can only
 * end it sooner.
 *
 * A failed publish costs one delayed page; the daily scheduler starts a fresh
 * chain regardless, so it must never fail a run that otherwise succeeded.
 */
async function chainAnotherBatch(opts: {
  message: UsEodSyncMessage;
  state: RunState;
  chainDepth: number;
  chainStartedAt: number;
  batchSize: number;
  mfBatchSize: number;
  symbolScoped: boolean;
}): Promise<boolean> {
  const {
    message,
    state,
    chainDepth,
    chainStartedAt,
    batchSize,
    mfBatchSize,
    symbolScoped,
  } = opts;

  // ONE CALL PER LEG. The two partitions are separate queries with separate
  // page sizes, so they come full circle at different links; a single flag
  // could only ever be right about one of them, and the one it was right about
  // (EQUITY) was the one that silenced the other.
  const equityRotationWrapped = hasRotationWrapped(
    state.equityOldestSyncedAtMs,
    chainStartedAt,
  );
  const mfRotationWrapped = hasRotationWrapped(
    state.mfOldestSyncedAtMs,
    chainStartedAt,
  );

  if (
    !shouldChainAnotherBatch({
      chainDepth,
      // `?? 0` and not a nullable pass-through: a leg whose query never ran
      // selected nothing to page through, which for the CHAIN decision is the
      // same as an empty page. The distinction that matters (never-asked vs
      // genuinely-empty) is a HEALTH question, and it is answered in
      // `judgeUsEodHealth` — not here, where either reading only ends the chain
      // sooner and the termination bound holds regardless.
      equitySelected: state.equitySelected ?? 0,
      equityBatchSize: batchSize,
      mfSelected: state.mfSelected ?? 0,
      mfBatchSize,
      stamped: state.stamped,
      rateLimited: state.rateLimited,
      accessRefused: state.accessRefused,
      symbolScoped,
      equityRotationWrapped,
      mfRotationWrapped,
    })
  ) {
    logger.info(
      `Not chaining (depth ${chainDepth}/${MAX_CHAIN_DEPTH}, ` +
        `selected ${state.equitySelected ?? "not-queried"}/${batchSize} + ` +
        `${state.mfSelected ?? "not-queried"}/${mfBatchSize}, ` +
        `stamped ${state.stamped}, rateLimited ${state.rateLimited}, ` +
        `accessRefused ${state.accessRefused}, ` +
        `scoped ${symbolScoped}, wrapped eod=${equityRotationWrapped} ` +
        `nav=${mfRotationWrapped})`,
    );
    return false;
  }

  try {
    const pubsub = getPubSubClient();
    const topic = pubsub.topic(getTopicName(PUBSUB_TOPICS.US_EOD_SYNC));
    // The follow-up inherits the ORIGINAL scope (page sizes, window, skipFx) so
    // a tuned run stays tuned. Only the depth moves, and `chainStartedAt` is
    // pinned so every later link can tell when the rotation has come full
    // circle.
    const next: UsEodSyncMessage = {
      ...message,
      batchSize,
      mfBatchSize,
      chainDepth: chainDepth + 1,
      chainStartedAt,
    };
    await topic.publishMessage({ json: next });
    logger.info(
      `Chained us-eod-sync batch ${chainDepth + 1}/${MAX_CHAIN_DEPTH}`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `Failed to chain the next us-eod-sync batch: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
