/**
 * `us-eod-sync` — PURE helpers (no Prisma, no Tiingo client, no cache, no clock).
 *
 * MONEY-980 (tasks 6 + 7). Side-effect-free decisions and shaping extracted out
 * of `us-eod-sync.ts` so the EXACT code production runs can be unit-tested by
 * importing the real symbol — no shadow copies, no network, no Prisma at module
 * load. `us-eod-sync.ts` imports and CALLS every export here. Same posture as
 * `stock-document-extract-logic.ts` / `bhavcopy-sync-logic.ts`.
 *
 * ## Only TYPE imports from @usemoney/core, never a value one
 *
 * The three shapes this module needs — a Tiingo bar, the plan ceilings, and a
 * candle write row — are IMPORTED from their owning modules rather than
 * restated. An echoed interface is "one rule, stated twice", which is exactly
 * how MONEY-1255's mimeType defect happened: two spellings of one fact that
 * were free to drift apart, with the drift invisible because both sides
 * compiled.
 *
 * They are `import type`, so they ERASE at build time and this module still
 * pulls in no client, no Prisma, no cache and no clock at runtime — which is
 * what lets its tests import the real symbols and run hermetically. Both source
 * modules are themselves pure leaves (`tiingo-logic` imports one CSV splitter;
 * `candle-logic` imports nothing), so even the type graph stays thin.
 *
 * ## Three VALUE imports, and why they do not break the rule above
 *
 * MONEY-1263 / MONEY-1264. `resolveListingId`, `dedupeTickers` and
 * `QUOTE_FETCH_BUDGET_MS` are imported as VALUES from
 * `tiingo-corp-actions-logic`, `tiingo-news-logic` and `yahoo-api-logic`. All
 * three are proven PURE LEAVES - the first imports only `splitCsvLine`, the
 * second imports nothing at all, the third imports one `import type` that
 * erases - so this module still constructs no client, no Prisma, no cache and
 * no clock at load, which is the property the rule exists to protect. What it
 * protects against is a heavy import graph, not the word `import`.
 *
 * Taking them is the same argument the paragraph above makes about interfaces,
 * applied to behaviour. `dedupeTickers` collapses a `tickers[]` array that
 * repeats a symbol on 79 of 200 measured rows; `resolveListingId` decides
 * whether an ex-date falls inside a listing's occupancy window. A second
 * implementation of either, living here, would be one rule spelled twice and
 * free to drift from the one the clients' own tests cover - and the drift would
 * be invisible, because both sides would compile.
 *
 * @see workers/src/processors/us-eod-sync.ts (caller)
 * @see workers/src/routes/us-eod-sync.ts (message narrowing)
 */

import type {
  TiingoEodBar,
  TiingoLimits,
} from "@usemoney/core/market-data/tiingo/tiingo-logic";
import { buildListingId } from "@usemoney/core/market-data/tiingo/tiingo-logic";
import type { CandleWriteRow } from "@usemoney/core/market-data/candles/candle-logic";
// ONE declaration of the split threshold, shared with the historical backfill.
// `splitFactor` is SPARSE, so disagreeing about what counts as a split is
// disagreeing about whether the field exists — see the constant's own doc.
import { isRealSplit } from "@usemoney/core/market-data/candles/candle-logic";
// MONEY-1617 — the writer clip. A pure leaf too: it imports only
// `us-market-hours`, which imports nothing.
import {
  clipBarsToListingWindows,
  type ClipDropReason,
  type ListingRow,
} from "@usemoney/core/market-data/databento/databento-symbology";
// VALUE imports - see "Two VALUE imports" in the header. Both source modules
// are pure leaves; nothing is constructed at load.
import {
  resolveListingId,
  type CorpActionListingWindow,
} from "@usemoney/core/market-data/tiingo/tiingo-corp-actions-logic";
// The wall-clock bound on ONE `fetchQuotes` call, from the module that
// ENFORCES it (`yahooFetch` clamps every attempt to `min(FETCH_TIMEOUT_MS,
// remaining())`). `yahoo-api-logic` is a proven pure leaf - its only import is
// an `import type`, which erases - so this constructs nothing at load, exactly
// like the two above. It is imported rather than restated because
// `FX_LEG_TAIL_MS` is a term in a ladder that sits under a 600s ceiling: a
// copied bound that drifts does not make a run late, it duplicates it.
import { QUOTE_FETCH_BUDGET_MS } from "@usemoney/core/market-data/yahoo-api-logic";

/**
 * One raw Tiingo EOD bar. Prices are UNADJUSTED; `divCash` / `splitFactor` are
 * the adjustment INPUTS the adjusted series is recomputed from at read time.
 */
export type EodBarInput = TiingoEodBar;

/**
 * The plan ceilings this job paces against.
 *
 * The caller passes `tiingoLimits()` — resolved PER CALL from `TIINGO_PLAN`,
 * never snapshotted at import, because a module-scope read freezes the value
 * before a worker has finished loading its config (MONEY-1262). Taking it as a
 * PARAMETER rather than reading the env here is what keeps every decision in
 * this file pure and testable against either plan.
 *
 * MONEY-1326 — the NUMERIC shape, not `TiingoLimits` itself. `TiingoLimits` is
 * derived from an `as const` table, so its `perHour` is the LITERAL union
 * `20000 | 80000`. Under that type `requestBudgetForRun`'s own
 * `!Number.isFinite(limits.perHour) || limits.perHour <= 0` guard is
 * unreachable by construction — and the guard is not decorative: the plan is
 * chosen from `TIINGO_PLAN`, an env string, and this function is the second
 * stop condition standing between a bad ceiling and a 429 wall. A type that
 * says the bad value cannot arrive also says the test proving we survive it
 * cannot be written, which is exactly what it said until this tree was
 * type-checked. `TiingoLimits` stays assignable to this, so the real caller
 * (`tiingoLimits()` at us-eod-sync.ts) is unchanged.
 */
export type RateCeilings = {
  readonly perHour: number;
  readonly perDay: number;
  readonly bandwidthBytesPerMonth: number;
};

/**
 * Compile-time proof of the last sentence above, so it is a CHECKED property
 * rather than a comment. Widening a parameter is only safe while the real
 * argument still fits: if `TIINGO_PLAN_LIMITS` ever retypes a field so
 * `TiingoLimits` stops fitting, the conditional yields `false`, `false` does
 * not satisfy `extends true`, and `tsc` fails HERE — next to the reasoning —
 * instead of in whichever file happens to call it.
 *
 * The `Assert<T extends true>` indirection is load-bearing: a bare
 * `A extends B ? true : never` alias would simply RESOLVE to `never` on
 * failure, which is not a compile error and would prove nothing.
 */
type Assert<T extends true> = T;
export type _TiingoLimitsFitsRateCeilings = Assert<
  TiingoLimits extends RateCeilings ? true : false
>;

/** A row the job hands to `CandleRepository.putCandles`. */
export type CandleUpsert = CandleWriteRow;

// ---------------------------------------------------------------------------
// POPULATION SELECTION
// ---------------------------------------------------------------------------

/** The only timeframe this job writes. `M1`/`H1`/`W1` are reserved (prompt-01). */
export const US_TIMEFRAME_D1 = "D1";

/** Provenance stamped on every bar this job writes. */
export const US_EOD_SOURCE = "TIINGO";

/**
 * `UsInstrument.assetType` values that mean "US mutual fund".
 *
 * ## The column moved, and with it the spelling problem
 *
 * This was `InstrumentMapping.instrumentType` and accepted TWO spellings
 * (`MF`, `MUTUAL_FUND`) as a hedge against a provider that used the other one.
 * `UsInstrument.assetType` does not need the hedge: it carries TIINGO'S OWN
 * string, straight off `supported_tickers.csv`, and that file's vocabulary is
 * exactly `Stock` / `ETF` / `Mutual Fund`. One producer, one spelling. A
 * superset here would not be a cheap hedge any more, it would be two dead terms
 * that quietly imply a second writer exists.
 *
 * Measured 2026-08-28 against the real master: **49,414 `Mutual Fund` listings
 * of 72,685**. The two lists below PARTITION the population — every US row is
 * in exactly one — so no asset class can be orphaned by a filter that matches
 * neither. A new `assetType` from upstream would land in NEITHER list, which is
 * a visible `selected` shortfall rather than a silent misfile.
 *
 * The case is Tiingo's, not ours: `"Mutual Fund"` with a space and title case.
 * Uppercasing it here would match zero rows and present as an empty NAV leg.
 */
export const US_MF_ASSET_TYPES = ["Mutual Fund"] as const;

/** `UsInstrument.assetType` values leg (a) walks. The complement of the above. */
export const US_EQUITY_ASSET_TYPES = ["Stock", "ETF"] as const;

/** Which partition of the US population a page is drawn from. */
export type UsEodLeg = "EQUITY" | "MF";

/**
 * WHERE for one leg's page of the US population, in `us_instruments`.
 *
 * ## There is no `market` term any more, because the TABLE is the market
 *
 * This used to read `instrument_mappings` with `{market: "US"}`. US securities
 * live in `us_instruments` now, so the discriminator is the collection itself —
 * which is strictly stronger than a column, because a column can be forgotten
 * by a reader and a table cannot. (That is the same argument that split
 * `us_stock_news` out of `stock_news`: `market` could not save a reader that
 * predated it.)
 *
 * ## The rotation marker is NEVER in here
 *
 * `usEodSyncedAt` appears in `US_EOD_ORDER_BY` and NOWHERE ELSE. On MongoDB the
 * attribute is ABSENT — not null — on every pre-existing row, because a
 * `prisma db push` creates INDEXES and never FIELDS, and Prisma's Mongo
 * connector does not treat absent as null. So BOTH `{usEodSyncedAt: null}` and
 * `{usEodSyncedAt: {not: null}}` match ZERO rows. A `where` on the marker would
 * select nothing on night one and the job would report a clean, healthy,
 * entirely empty run forever. That class has caused MONEY-1050, MONEY-1205,
 * MONEY-1234 and MONEY-1236. The schema states the same rule on the column.
 *
 * `listingStatus` is matched POSITIVELY for the same reason, and it is the
 * prefix of `@@index([listingStatus, usEodSyncedAt])` — the index this exact
 * query plus `US_EOD_ORDER_BY` was shaped for.
 *
 * ## Both legs match assetType POSITIVELY — no `notIn`
 *
 * The old EQUITY term was `instrumentType: {notIn: [...funds]}`, which was
 * correct against a column with a bounded vocabulary and is a hazard against
 * this one: on Mongo a `notIn` also matches rows where the attribute is ABSENT,
 * so any `us_instruments` row written before `assetType` existed would be
 * fetched by leg (a) and asked for prices as though it were an equity. Two
 * positive lists partition the population instead, and a NEW upstream
 * `assetType` falls out of both — a visible shortfall in `selected` rather than
 * a silent misfile into the wrong leg.
 *
 * ## There is NO `exchange` term here, and there must not be one
 *
 * The instrument master collapses a US security to ONE row per ticker
 * GLOBALLY, not one per venue: `/tiingo/daily/<ticker>/prices` takes no
 * exchange qualifier, so two venue rows would be filled from the identical
 * response, and `@@unique([yahooSymbol])` binds tighter than
 * `@@unique([symbol, exchange])` anyway. Adding an exchange term would
 * therefore not de-duplicate anything — it would EXCLUDE rows whose stored
 * venue happens to differ from the one guessed here. The `exchange` this job
 * reads off the row is carried through to `Candle` as provenance; it is never
 * a selector and never part of the Tiingo URL.
 *
 * For the same reason, US rows carry a BARE Yahoo symbol (`AAPL`, not
 * `AAPL.NS`). Nothing in this job appends a suffix, and nothing should.
 */
export function buildUsEodWhere(
  leg: UsEodLeg,
  symbols?: readonly string[],
): Record<string, unknown> {
  const scoped =
    symbols && symbols.length > 0
      ? { symbol: { in: symbols.map((s) => s.trim().toUpperCase()) } }
      : {};
  return {
    listingStatus: "ACTIVE",
    assetType:
      leg === "MF"
        ? { in: [...US_MF_ASSET_TYPES] }
        : { in: [...US_EQUITY_ASSET_TYPES] },
    ...scoped,
  };
}

/**
 * STALE FIRST. `usEodSyncedAt` ascending is the rotation marker.
 *
 * Plain `asc` — deliberately NOT `{ sort: "asc", nulls: "first" }`. The
 * `nulls` modifier is a PostgreSQL feature; on the Mongo connector the field is
 * absent rather than null in the first place, and Mongo already orders a
 * missing field lowest. Adding the modifier would either be rejected or, worse,
 * quietly accepted while changing nothing — a guard that looks like it works.
 *
 * `symbol asc` is the tiebreak. Without it, every row synced in the same
 * millisecond (a chunked stamp writes 100 at a time with one timestamp) has an
 * arbitrary Mongo-resolved order, and an arbitrary order over a constant key is
 * the MONEY-1211 shape: the same head re-selected forever while the tail is
 * never reached.
 */
export const US_EOD_ORDER_BY = [
  { usEodSyncedAt: "asc" },
  { symbol: "asc" },
] as const;

// ---------------------------------------------------------------------------
// BUDGETS — the 600s Pub/Sub ack ceiling, spent
// ---------------------------------------------------------------------------

/**
 * The Pub/Sub ack deadline this whole section is spent against.
 *
 * `workers/scripts/setup-pubsub.sh` creates every job's push subscription with
 * `--ack-deadline=600`, which is Pub/Sub's MAXIMUM and cannot be raised; Cloud
 * Run's 3600s request timeout never binds. Overrunning it does not make a run
 * slow — Pub/Sub REDELIVERS, so a second copy of the job starts while the first
 * is still running and both fetch the same page against the same unobservable
 * quota.
 *
 * It is a CONSTANT here rather than a number inside a comment because the whole
 * budget ladder below is now derived from it, and a ceiling that only exists in
 * prose is a ceiling an arithmetic test cannot check (a falsifiable check needs
 * a verified ceiling — the ceiling is verified by that `setup-pubsub.sh` flag).
 */
export const ACK_DEADLINE_MS = 600_000;

/**
 * The worst wall-clock ONE upstream Tiingo call can occupy.
 *
 * ## The number this replaces was wrong by ~110s
 *
 * `RUN_TIME_BUDGET_MS` used to size the worst in-flight symbol at "~45s", which
 * counted the BACKOFF ladder (5s + 10s + 20s = 35s) and then charged the four
 * network round trips about 2.5s each — the MEASURED time of a call that
 * ANSWERS. A call that answers is never the worst case. The worst case is the
 * one that does not answer at all: each attempt then runs to
 * `EXCHANGE_FETCH_TIMEOUT_MS` (30s, `exchange-feed.ts:24`), and the client
 * takes `MAX_RETRIES` (4, `tiingo-client.ts:203`) of them. So
 *
 *   4 x 30s timeout  +  5s + 10s + 20s backoff  =  155s,
 *
 * not 45s. Underestimating the lumpiest term in a headroom calculation is not
 * a rounding error — it is how a run silently crosses the ack deadline and gets
 * itself duplicated.
 *
 * ## Why it is computed rather than written down
 *
 * All three inputs live in `@usemoney/core` and two of them are EXPORTED, so
 * the processor passes the real symbols and this file holds no copy: a second
 * spelling of the ladder is exactly the MONEY-1255 shape (one rule, stated
 * twice, free to drift while both sides compile). The backoff base is the one
 * input that is NOT exported (`const BACKOFF_BASE_MS = 5_000`, module-private);
 * the processor restates it beside a comment naming its home, and a source-scan
 * case in the test file fails if the two ever disagree.
 *
 * The summation mirrors the client's own `BACKOFF_BASE_MS * 2 ** (attempt - 1)`
 * rather than folding it into the closed form `base * (2^(n-1) - 1)`, for the
 * same reason: the loop is recognisably THAT rule, the closed form is a second
 * derivation of it.
 *
 * Nonsense inputs contribute 0 rather than throwing. That understates the worst
 * call, which is the dangerous direction — so the one consumer,
 * {@link latestUpstreamCallStartMs}, clamps its answer to
 * `RUN_TIME_BUDGET_MS`, which is the behaviour this job had before the deadline
 * existed. Garbage therefore degrades to the old wall, never past it.
 */
export function worstTiingoCallMs(
  maxRetries: number,
  perAttemptTimeoutMs: number,
  backoffBaseMs: number,
): number {
  const attempts =
    Number.isInteger(maxRetries) && maxRetries > 0 ? maxRetries : 1;
  const timeout =
    Number.isFinite(perAttemptTimeoutMs) && perAttemptTimeoutMs > 0
      ? perAttemptTimeoutMs
      : 0;
  const base =
    Number.isFinite(backoffBaseMs) && backoffBaseMs > 0 ? backoffBaseMs : 0;
  // The client sleeps BETWEEN attempts, so a 4-attempt ladder has 3 sleeps.
  let backoff = 0;
  for (let attempt = 1; attempt < attempts; attempt++) {
    backoff += base * 2 ** (attempt - 1);
  }
  return attempts * timeout + backoff;
}

/**
 * Leg (e)'s WRITE at its measured worst.
 *
 * A quarter-end ex-date is 6,482 distribution rows upserted one unique key at a
 * time; a typical weekday is 100-400 rows and ~1s. Four nights a year, and it
 * is a Mongo cost rather than a Tiingo one, so pacing cannot shorten it.
 *
 * This is a measurement of the WHOLE write, not a per-row rate multiplied out.
 */
export const CA_WRITE_TAIL_MS = 15_000;

/**
 * The queries that are not gated on anything: the two `findMany` pages, the
 * final stamp flush and leg (e)'s listing join.
 */
export const TAIL_QUERY_MS = 3_000;

/** `reportJobOutcome` plus the chain publish, both in the `finally`. */
export const TAIL_REPORT_MS = 1_000;

/**
 * How many `fetchQuotes` calls leg (d) can make: the pair, then the REVERSE.
 *
 * `getExchangeRate` (`packages/core/src/currency/exchange-rates.ts`) tries
 * `USDINR=X` and, when that yields no finite positive price, `INRUSD=X`. The
 * two are SEQUENTIAL and each is a separate `fetchQuotes`, so the worst case is
 * two full budgets and not one.
 */
export const FX_QUOTE_FETCH_CALLS = 2;

/** The `FxRate` upsert that follows a usable rate. */
export const FX_WRITE_MS = 1_000;

/**
 * The worst wall clock leg (d) can occupy: 41s today, NOT the "~10s" this
 * ladder used to claim.
 *
 * `QUOTE_FETCH_BUDGET_MS` is IMPORTED from the module that enforces it rather
 * than restated, for the same reason `worstTiingoCallMs` takes the client's
 * ladder as arguments: a second spelling of a bound is free to drift while both
 * sides compile, and this one sits under a 600s ceiling that redelivers rather
 * than merely running late.
 *
 * The bound is real rather than nominal. `yahooFetch` clamps every attempt to
 * `Math.min(FETCH_TIMEOUT_MS, remaining())` and refuses to start one once the
 * budget is spent, so ONE `fetchQuotes` cannot outlive its budget — which is
 * what makes multiplying by the call count a ceiling instead of an estimate.
 *
 * The `rateCache` in that module is NOT a reason to discount this. It caches
 * only VALID rates, so the night the FX provider is down — the only night this
 * term decides anything — pays the whole ladder on every single run.
 */
export const FX_LEG_TAIL_MS =
  FX_QUOTE_FETCH_CALLS * QUOTE_FETCH_BUDGET_MS + FX_WRITE_MS;

/**
 * Everything that runs AFTER the last leg's WRITE and is gated on nothing.
 *
 * Leg (d) is the whole of it, plus the flush/report/publish. Leg (e) is not
 * here: its write is on the other side of this line and is named separately by
 * {@link CA_WRITE_TAIL_MS}.
 *
 * It was `POST_NEWS_WRITE_TAIL_MS` until MONEY-1309 retired leg (f). The VALUE
 * is unchanged and deliberately so — every term in the sum is leg (d), the
 * stamp flush, the report and the chain publish, none of which leg (f) ever
 * contributed to. Only the name was wrong once the leg it named was gone, and a
 * constant named after a thing that no longer exists is how the next reader
 * concludes the arithmetic still reserves room for it.
 *
 * Nothing was RECLAIMED here either. Retiring a leg frees wall clock, and
 * spending it would mean starting an upstream call later against a 600s ack
 * deadline — a risk change nobody has measured, made as a side effect of a
 * deletion. The slack stays unallocated.
 */
export const POST_WRITE_TAIL_MS =
  FX_LEG_TAIL_MS + TAIL_QUERY_MS + TAIL_REPORT_MS;

/**
 * Everything that still has to happen AFTER the last upstream call returns.
 *
 * ## Why this is a SUM OF NAMED TERMS and not a rounded-up guess
 *
 * It used to be a hand-picked `45_000` with an itemisation in prose, and two of
 * the itemised terms were wrong in the direction that costs a run:
 *
 *   - **FX was written down as "~10s". It is up to 41s.** See
 *     {@link FX_LEG_TAIL_MS}: TWO sequential `fetchQuotes` calls, each bounded
 *     by `QUOTE_FETCH_BUDGET_MS`, with no timeout of our own around either.
 *   - **Leg (f)'s row writes were not budgeted at all.** That leg is RETIRED
 *     (MONEY-1309) and contributes nothing here at all now; the news poller has
 *     its own budget against its own 2-minute cadence.
 *
 * A tail whose dominant term is understated is not a rounding error. It is how
 * {@link latestUpstreamCallStartMs} hands out a deadline that leaves too little
 * room, the run crosses 600s, Pub/Sub redelivers, and a SECOND copy starts
 * against the same page and the same unobservable quota.
 *
 * The old note called its own rounding "the safety margin". A margin that
 * absorbs a term understated by 30s is not a margin; it is the reason nobody
 * looked. Every term is now named, and the test file re-derives the ones it can
 * reach INDEPENDENTLY — off the declaring module's own source — so this sum
 * cannot be lowered back to a comfortable number without something going red.
 *

 *    15.000s  CA_WRITE_TAIL_MS      leg (e)'s write, measured worst
 *    41.000s  FX_LEG_TAIL_MS        leg (d), 2 x QUOTE_FETCH_BUDGET_MS + write
 *     3.000s  TAIL_QUERY_MS         the un-gated queries and the stamp flush
 *     1.000s  TAIL_REPORT_MS        reportJobOutcome + the chain publish
 *     0.000s  leg (c)               derives and reports in memory, no I/O
 *   --------
 *    60.000s
 */
export const POST_CALL_TAIL_MS = CA_WRITE_TAIL_MS + POST_WRITE_TAIL_MS;

/**
 * Wall-clock budget after which NO leg starts another symbol.
 *
 * This is the THROUGHPUT wall — how much of the run is spent doing work. It is
 * NOT the ack-deadline guard any more; that is {@link latestUpstreamCallStartMs},
 * which is derived and is the tighter of the two. Keeping them separate is
 * deliberate: this number answers "how much work per link", and if the client's
 * retry ladder is ever shortened the derived deadline relaxes on its own while
 * this stays put.
 *
 * 420s is not a new number — `mf-nav-backfill` and `stock-document-extract`
 * stop on the same wall. Their per-item worst case is ~60s (a pathological
 * Document AI call), so 420s + one item fits 600s directly. This job's per-item
 * worst case is 155s and does NOT, which is exactly why the second wall exists
 * rather than this one simply being lowered: lowering it would shrink every
 * ordinary night's page to protect against a night when Tiingo is unreachable,
 * and on that night the run does no useful work anyway.
 *
 * It is also the denominator of {@link requestBudgetForRun} — a run lasting
 * `budgetMs/3_600_000` of an hour may spend that share of an hourly allowance —
 * so it means "how long this run intends to work", which is the right quantity
 * for that ratio and the wrong one for an ack-deadline guard.
 */
export const RUN_TIME_BUDGET_MS = 420_000;

/**
 * The latest ELAPSED at which any leg may START a new upstream call.
 *
 * ## The hole this closes
 *
 * Legs (e) and (f) were gated only at ENTRY, on `elapsed < RUN_TIME_BUDGET_MS`,
 * and leg (e)'s per-route loop then re-checked the QUOTA but never the clock. A
 * run whose price legs finished at 419.9s therefore passed the entry gate and
 * could issue two 155s calls back to back:
 *
 *   419.9s + 155s + 155s = 730s  ->  past the 600s ack deadline
 *   ->  Pub/Sub redelivers  ->  a SECOND copy runs concurrently against the
 *       same page and the same unobservable quota.
 *
 * The fix is two-part and both parts are needed: every upstream call site
 * re-checks the clock (not just the leg's first one), and the value it checks
 * against leaves room for the call it is about to make.
 *
 *   600s  ACK_DEADLINE_MS
 *  -155s  one worst-case Tiingo call — the call this gate is about to allow
 *   -60s  POST_CALL_TAIL_MS — leg (e)'s write, leg (d), the stamp flush, the
 *         report and the chain publish, none of which are clock-gated. It was
 *         45s, and 45s was wrong: leg (d) alone is up to 41s, because
 *         `getExchangeRate` makes TWO sequential `fetchQuotes` calls and each
 *         is bounded by `QUOTE_FETCH_BUDGET_MS`. See {@link POST_CALL_TAIL_MS}.
 *  -----
 *   385s  the latest a new call may start, so the worst finish is 540s + tail.
 *
 * ## Why `min` with RUN_TIME_BUDGET_MS
 *
 * Two reasons, and the second is the one that matters. A deadline LOOSER than
 * the throughput wall would let a leg start work the run had already decided it
 * was done with. And it bounds the damage from a nonsense `worstCallMs`: the
 * worst this function can return is today's pre-fix behaviour, never something
 * later than it.
 *
 * The PRICE legs are not gated on this value, because they cannot need to be:
 * `EQUITY_LEG_BUDGET_MS` (300s) and `PRICE_LEG_BUDGET_MS` (365s) are compile-
 * time constants that already sit under it, with
 * {@link SECONDARY_LEG_SLICE_MS} to spare. That is a property of five numbers
 * rather than a comment, so the test file asserts it — if a future edit raises
 * a price-leg wall past this deadline, or GROWS the tail until the deadline
 * sinks below one, that case goes red rather than the ack deadline going
 * silently over. It is not hypothetical: correcting the tail from 45s to 60s
 * moved this deadline from 400s to 385s, which is what took
 * `PRICE_LEG_BUDGET_MS` from 380s to 365s in the same change.
 */
export function latestUpstreamCallStartMs(worstCallMs: number): number {
  const worst =
    Number.isFinite(worstCallMs) && worstCallMs > 0 ? worstCallMs : 0;
  return Math.max(
    0,
    Math.min(RUN_TIME_BUDGET_MS, ACK_DEADLINE_MS - worst - POST_CALL_TAIL_MS),
  );
}

/**
 * The latest wall clock a run can reach, given where its last call may start.
 *
 * The whole point of the ladder above, expressed as one number so a test can
 * compare it against {@link ACK_DEADLINE_MS} instead of re-deriving the
 * arithmetic in an assertion — a test that restates the calculation it is
 * checking passes for the same reason the code does.
 */
export function worstCaseRunMs(
  lastCallStartMs: number,
  worstCallMs: number,
  tailMs: number,
): number {
  return lastCallStartMs + worstCallMs + tailMs;
}

/**
 * The point at which leg (a) YIELDS so leg (b) is never starved.
 *
 * Without this, the NAV leg is the class that always sorts last, and the class
 * that always sorts last is the one a wall-clock truncation always drops. That
 * is not merely unfair: an unvisited row keeps its stale rotation marker and
 * therefore LEADS the next page, so the starved leg is starved again on every
 * link — a livelock, not a delay. MONEY-1255 (A2) hit exactly this with the
 * `bseOnly` partition and fixed it by keeping the subset in PAGE ORDER; here
 * the two legs are separate queries, so the equivalent fix is a reserved slice
 * of the clock.
 *
 * The floor it guarantees is `PRICE_LEG_BUDGET_MS - EQUITY_LEG_BUDGET_MS`, so
 * 65s today. This used to read "300s of 420s leaves leg (b) at least 120s",
 * which was stated against the wrong wall: leg (b) has stopped at
 * {@link PRICE_LEG_BUDGET_MS} since MONEY-1263/1264 reserved a slice for legs
 * (e) and (f), never at `RUN_TIME_BUDGET_MS`, so the floor was 80s the day that
 * sentence was written and is 65s now. Leg (b)'s population is a fraction of
 * the equity one and one NAV call is ~2s, so 65s is a real page rather than a
 * token — but it is a real floor, not a comfortable one, and lowering
 * `PRICE_LEG_BUDGET_MS` any further means lowering this in the same edit.
 */
export const EQUITY_LEG_BUDGET_MS = 300_000;

/**
 * The point at which the PRICE legs stop, reserving the tail for legs (e)+(f).
 *
 * MONEY-1263 / MONEY-1264. Leg (b) used to run to `RUN_TIME_BUDGET_MS` itself,
 * which was correct while it was the LAST leg that costs upstream time. It no
 * longer is, and the consequence is not "the new legs are a bit slow" — it is
 * that they would NEVER RUN. Both price legs are rotations over populations
 * far larger than one page (41,371 active listings, 49,414 of them funds), so
 * they consume every millisecond offered to them on every ordinary night. A
 * leg that runs after them with no reserved slice reads "budget already spent"
 * on its first check, reports `notReached`, and does so for the life of the job
 * — a structurally dead leg reporting a defensible-looking verdict, which is
 * the MONEY-980 finding-2 shape reintroduced by scheduling rather than by a
 * filter.
 *
 * 365s leaves the two new legs {@link SECONDARY_LEG_SLICE_MS} against the
 * derived call deadline ({@link latestUpstreamCallStartMs}, 385s today).
 * Sizing, at their measured cost: three market-wide Tiingo calls (~2s each, one
 * of them up to 1.35 MB at quarter-end), one listing join, one carried-symbol
 * lookup, and the row writes. A typical weekday fits in ~8s; the slice is for
 * the quarter-end spike, and a call that starts inside it is separately allowed
 * to overrun, because the deadline already reserves one worst call plus the
 * tail.
 *
 * The slice is stated against the CALL DEADLINE and not against
 * `RUN_TIME_BUDGET_MS`, because the deadline is what the new legs are actually
 * gated on. Sizing it against 420s would have described a 55s slice the legs
 * never had.
 *
 * ## Why it moved from 380s
 *
 * It did not move for its own reasons — the SLICE is unchanged. The deadline
 * underneath it moved, from 400s to 385s, when {@link POST_CALL_TAIL_MS} was
 * re-derived from its real terms and gained the 30s of FX bound the old
 * hand-picked 45s had left out. At 380s the slice would have been 5s: leg (e)'s
 * two calls plus leg (f)'s first page are ~6s on a typical night, so leg (f)
 * would have been refused on roughly half of them and reported `notReached` —
 * the structurally-dead-leg outcome this constant exists to prevent, reached by
 * leaving a number alone rather than by setting it.
 *
 * The cost is 15s of price-leg page per link, out of 365s. The rows not visited
 * keep their stale rotation marker and LEAD the next page, so it is a delay to
 * the rotation and nothing else — the same argument the paragraph below makes.
 *
 * The price legs pay for that slice out of their own page, which is the right
 * side to take it from: an unvisited row keeps its stale rotation marker and
 * LEADS the next page, so 40s costs the rotation a delay and nothing else.
 *
 * ## Why the new legs run LAST rather than first
 *
 * Running them first would be simpler — no reserved slice at all, since the
 * price legs already check the clock from `startedAt` and would just get less
 * of it. It is rejected because of what a 403 does. A refusal circuit-breaks
 * the run, and legs (e)/(f) hit endpoint families (`/tiingo/corporate-actions`,
 * `/tiingo/news`) whose entitlement is SEPARATE from `/tiingo/daily`'s. First
 * in the order, a revoked corporate-actions beta would kill the entire US price
 * backbone every night — a calendar nobody reads taking down the prices
 * everything reads. Last in the order, the price work is already banked.
 *
 * That ordering buys a second thing for free: see
 * {@link describeSecondaryRefusal}. By the time leg (e) calls, the same token
 * has already been accepted by `/tiingo/daily`, so a 403 here is separable into
 * "entitlement" in a way MONEY-980 finding 1 established the status alone never
 * is.
 */
export const PRICE_LEG_BUDGET_MS = 365_000;

/**
 * The room legs (e) and (f) are guaranteed between the price wall and the call
 * deadline.
 *
 * A DECLARED requirement rather than a derived one, so it can be checked from
 * both directions: the test file recomputes the deadline from the client's own
 * constants read off disk and asserts that
 * `deadline - PRICE_LEG_BUDGET_MS >= SECONDARY_LEG_SLICE_MS`. That is the case
 * that goes red if either wall moves, if the tail grows, or if the retry ladder
 * lengthens — none of which announce themselves in this file.
 *
 * 20s against a measured typical cost of ~8s (three market-wide calls, a
 * listing join, a carried-symbol lookup) leaves room for the quarter-end spike
 * without pretending the legs are free.
 */
export const SECONDARY_LEG_SLICE_MS = 20_000;

/** EOD page size for leg (a) when the message names none. */
export const DEFAULT_US_EOD_BATCH_SIZE = 800;

/** NAV page size for leg (b) when the message names none. */
export const DEFAULT_US_MF_BATCH_SIZE = 200;

/**
 * Ceiling on either page size.
 *
 * A page is a runaway guard, not the throughput control — the wall clock and
 * `requestBudgetForRun` are. This exists so a forged or fat-fingered payload
 * cannot ask for a 500,000-row `findMany` that blows the container's memory
 * before the wall clock gets a chance to stop anything.
 */
export const MAX_BATCH_SIZE = 5_000;

/** Trailing window, in calendar days, fetched per symbol when unspecified. */
export const DEFAULT_LOOKBACK_DAYS = 5;

/**
 * Hard ceiling on the trailing window.
 *
 * THE CLAMP IS THE SAFETY PROPERTY, not a tidy default. One Tiingo request
 * returns a symbol's ENTIRE history when `startDate` reaches far enough back —
 * AAPL is 11,517 bars and 820,616 bytes in a single 2.4s call. Multiply that by
 * 14,041 active symbols and the "nightly" job is a multi-gigabyte, multi-hour
 * pull that cannot finish inside the ack deadline and eats a visible fraction
 * of the monthly bandwidth allowance. Whole-history pulls belong to the
 * BACKFILL, which has `CandleBackfillCheckpoint` precisely so it can be
 * resumed; this job must never accidentally become it.
 *
 * 5 days is the default because the cron is `2-6` (Tue-Sat IST): a Saturday
 * run covers Friday's session, and if that run is lost the following Tuesday's
 * run (whose target is Monday) must still reach back past Sunday and Saturday
 * to Friday. 5 calendar days does; 3 does not.
 */
export const MAX_LOOKBACK_DAYS = 30;

/** Rows stamped per `updateMany` while a leg walks its page. */
export const STAMP_CHUNK_SIZE = 100;

/**
 * Hard ceiling on how many times one trigger may re-publish itself.
 *
 * THE TERMINATION PROOF LIVES HERE and it deliberately consults nothing.
 * Every chained publish carries `chainDepth + 1`, and `shouldChainAnotherBatch`
 * refuses once the NEXT depth would REACH this value — so a chain is at most
 * `MAX_CHAIN_DEPTH` messages long no matter what the population does, what the
 * upstream returns, or whether any row moved. Every other stop condition in
 * that function can only end it SOONER, so none of them can break the bound.
 *
 * ## Sizing, corrected — the old note was wrong three ways
 *
 * It read "20 links x 420s = 2h20m ... ahead of `sync-prod-to-qa-feeds-us` at
 * 13:30 and QA's own run at 14:30". None of those three claims survives a
 * check, and the arithmetic one is the dangerous kind: it UNDERSTATED the span.
 *
 *   - **420s is not a link's bound.** `RUN_TIME_BUDGET_MS` is the THROUGHPUT
 *     wall — the point past which no new SYMBOL is started. A link may still be
 *     inside a 155s call at that moment and then run the whole tail. A link's
 *     real bound is {@link ACK_DEADLINE_MS} itself, by construction of
 *     {@link latestUpstreamCallStartMs}: 385s + 155s + 60s = 600s. So the
 *     chain's worst span is 20 x 600s = 3h20m, not 2h20m — from the 11:00 IST
 *     trigger, ~14:20 IST. A typical link ends near 420s + tail and the whole
 *     chain near 13:40, but a bound sized on the typical case is not a bound.
 *   - **`sync-prod-to-qa-feeds-us` DOES NOT EXIST.** No such Cloud Run job, no
 *     such scheduler entry, no such string anywhere in the repo outside the
 *     sentence that invented it. The feeds mirror
 *     (`sync-prod-to-qa-feeds-eod` / `-daily`) is India's bhavcopy path; the US
 *     legs archive nothing and replay nothing.
 *   - **QA does not run this job at all.** `us-eod-sync-daily` is in
 *     `PROD_ONLY_JOBS` (`scripts/ops/setup-scheduler.sh`), because `candles`
 *     and `fx_rates` are in `REFERENCE_COLLECTIONS` and QA RECEIVES what prod
 *     computed rather than re-fetching it — deliberately, since Tiingo is a
 *     paid metered API. There is no "QA's own run at 14:30" to be ahead of.
 *
 * ## What the chain span actually has to clear
 *
 * The only real overlap risk is prod's EOD chain against QA's
 * `us-instrument-master-sync-daily`, which is now PROD_ONLY as well — it
 * was the last US job running in both environments, and the overlap this
 * paragraph warned about is therefore gone: two envs can no longer pace
 * independently against one Tiingo account. What remains true is the
 * reason it mattered — `tiingo-pacer.ts` state is module scope, shared
 * inside one process and with nothing across processes, so any future
 * second consumer puts 2x the COMMERCIAL ceiling on an API that
 * publishes no quota header and gives no feedback but a 429.
 * QA-DIRECT and cannot be synced down — and it spends the same paid quota on
 * the same token.
 *
 * A worst-case 20-link chain from 11:00 IST reaches ~14:20, so it CAN overlap
 * that 14:00 start. What overlapping costs is worth stating plainly, because it
 * is not a race for rows: the pacer's state (`tiingo-pacer.ts`) is MODULE
 * SCOPE, so it is shared between every Tiingo client inside ONE process and
 * shared with nothing across processes. Two environments pacing independently
 * at the full COMMERCIAL ceiling put 2x that ceiling on an API that reports
 * NOTHING about remaining quota — no header, verified — so the first feedback
 * is a 429, which is the one failure a retry makes worse. Nothing here detects
 * it; the spacing is the whole mitigation.
 *
 * At `DEFAULT_US_EOD_BATCH_SIZE` (800) a link is up to 16,000 symbol-syncs a
 * night. The ACTIVE population is now 41,371 listings (of 72,685 total, since
 * funds joined the master on 2026-08-28), so a full rotation NO LONGER
 * completes in one night — it takes ~3 — and `rotationWrapped` simply stops
 * firing on a typical night. That is the stale-first rotation working as
 * designed rather than a regression: every row still advances, and the marker
 * guarantees the oldest are always next.
 */
export const MAX_CHAIN_DEPTH = 20;

/**
 * Requests this run may issue, derived from the ACTIVE PLAN.
 *
 * The derivation is the whole argument, so it is written out: a run lasts at
 * most `budgetMs`, which is `budgetMs / 3_600_000` of an hour, so it may spend
 * that same fraction of an hourly allowance and stay inside the ceiling — and
 * the property composes across a chain, because each link derives its own cap
 * from its own duration share. Twenty links of 420s span 2h20m and are capped
 * at 20 x (perHour x 7/60) = 2.33 x perHour requests, i.e. exactly the hourly
 * rate sustained over 2.33 hours.
 *
 * `limits` is PASSED IN, never read from the environment here: `tiingoLimits()`
 * resolves `TIINGO_PLAN` per call and defaults to the LOWER (COMMERCIAL) pair,
 * because guessing high walks a run into a 429 wall mid-page while guessing low
 * only makes it slower (MONEY-1262).
 *
 * This is a SECOND stop condition beside the wall clock, not a replacement:
 * the clock bounds the ack deadline, this bounds the quota, and on a fast night
 * the quota is what binds.
 */
export function requestBudgetForRun(
  limits: RateCeilings,
  budgetMs: number = RUN_TIME_BUDGET_MS,
): number {
  if (!Number.isFinite(limits.perHour) || limits.perHour <= 0) return 0;
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return 0;
  return Math.max(1, Math.floor(limits.perHour * (budgetMs / 3_600_000)));
}

/**
 * What ONE `fetchTiingoEod` call costs the plan-derived request budget.
 *
 * ## Why anything is charged for a call that FAILED
 *
 * `state.requestsIssued` used to be incremented AFTER `fetchTiingoEod`
 * RETURNED, so the `catch` charged the budget NOTHING. But `getArchived` inside
 * the client walks a retry ladder — `MAX_RETRIES` attempts with 5s/10s/20s
 * backoff — and every attempt goes through `paceRequest()` and spends real
 * quota. A night of 5xx or timeouts could therefore issue several times
 * `requestBudget` while `stoppedOnQuota` never fired, defeating the one guard
 * whose stated job is "stopping rather than discovering the ceiling as a 429"
 * (MONEY-980 review, finding 8).
 *
 * ## The counting choice: WORST CASE ON FAILURE, floor on success
 *
 * The client reports no attempt count — `fetchTiingoEod` returns
 * `{bars, bytes} | null` and the ladder is entirely internal — so "have the
 * client report what it spent" is not available without changing its return
 * type. That leaves counting the worst case, charged where it is actually
 * plausible:
 *
 *   - a call that RETURNS is charged 1. It may have retried once and then
 *     succeeded, which we cannot see; that undercount is bounded by the ladder
 *     and only happens on a night that is otherwise working.
 *   - a call that THROWS is charged `maxAttemptsPerCall`. A transport/5xx or
 *     rate-limit throw means the ladder ran to exhaustion, so this is the exact
 *     figure rather than a pessimistic one.
 *
 * The two deliberate over-counts both land on a run that is ENDING anyway and
 * are therefore free: a 401/403 throws on attempt 1 without retrying, and
 * `paceRequest`'s daily-cap `TiingoRateLimitError` throws before any HTTP
 * request at all. Both circuit-break the run. Erring toward OVER-counting is
 * the safe direction for a ceiling we cannot observe: it stops the run early,
 * where under-counting walks it into a 429.
 *
 * ## The ladder length is a PARAMETER, never a copy
 *
 * `tiingo-client.ts` exports `MAX_RETRIES` and the processor passes it in. A
 * constant restated here would be one rule spelled twice — the MONEY-1255
 * shape — and would keep this module's arithmetic passing while the client's
 * ladder moved underneath it. Taking it as an argument is also what keeps this
 * function pure: the logic module takes only `import type` from core.
 *
 * A non-finite or sub-1 ladder length falls back to 1 rather than 0: a request
 * that reached the pacer spent quota whatever the caller claims about the
 * ladder, and charging 0 is the defect this function exists to remove.
 */
export function requestsSpentByCall(
  threw: boolean,
  maxAttemptsPerCall: number,
): number {
  if (!threw) return 1;
  if (!Number.isFinite(maxAttemptsPerCall) || maxAttemptsPerCall < 1) return 1;
  return Math.floor(maxAttemptsPerCall);
}

/**
 * True while the run may start ANOTHER symbol.
 *
 * Pure so the budget is testable without a clock: the caller passes `Date.now()`
 * and the run's start. Checked BETWEEN symbols — see the headroom arithmetic on
 * `RUN_TIME_BUDGET_MS` for why that is safe.
 */
export function isWithinRunBudget(
  startedAtMs: number,
  nowMs: number,
  budgetMs: number = RUN_TIME_BUDGET_MS,
): boolean {
  return nowMs - startedAtMs < budgetMs;
}

// ---------------------------------------------------------------------------
// MESSAGE SANITISATION
// ---------------------------------------------------------------------------

/**
 * Sanitise the `chainDepth` carried on an inbound message.
 *
 * The value comes off a Pub/Sub payload, so it is `unknown` until proven
 * otherwise: a missing, negative, fractional, NaN or absurd value must not be
 * able to buy extra links. Anything that is not a finite non-negative number
 * reads as depth 0, and anything above the ceiling is CLAMPED TO it — so a
 * forged large value ENDS the chain rather than wrapping it.
 */
export function normalizeChainDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(Math.floor(value), MAX_CHAIN_DEPTH);
}

/** Clamp a page size into `1..MAX_BATCH_SIZE`, falling back to `fallback`. */
export function clampBatchSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.min(Math.floor(value), MAX_BATCH_SIZE);
}

/** Clamp the trailing window into `1..MAX_LOOKBACK_DAYS`. */
export function clampLookbackDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return DEFAULT_LOOKBACK_DAYS;
  }
  return Math.min(Math.floor(value), MAX_LOOKBACK_DAYS);
}

// ---------------------------------------------------------------------------
// DATES — the US session, resolved in the exchange's own calendar
// ---------------------------------------------------------------------------

/**
 * Today's date in the US EXCHANGE's calendar, `YYYY-MM-DD`.
 *
 * `Intl` with an IANA zone rather than a fixed offset, because the offset is
 * not fixed: New York is UTC-5 in winter and UTC-4 in summer, and a hardcoded
 * one is wrong for roughly half the year — which for a run this close to
 * midnight ET is the difference between naming one calendar day and its
 * neighbour. `en-CA` is used only because it formats as `YYYY-MM-DD`.
 *
 * Pure given `nowMs`.
 */
export function usCalendarDate(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

/**
 * Normalise a raw ET hour into `0..23`, with a SAFE fallback.
 *
 * Split out so both hazards are testable directly — neither is reachable
 * through {@link usCalendarHour} on our runtime, and a guard nothing can
 * exercise is a guard nobody can prove.
 *
 * **24 is a real value.** `hourCycle` has an `h24` spelling that renders
 * midnight as `"24"`, one letter from the `h23` used below. MEASURED on this
 * runtime (Node 22.22.3 / ICU 78.2): `h23`, `hour12: false` and the default
 * all render 00:30 ET as `"00"`, while `h24` renders it `"24"`. So the option
 * below is not what makes midnight safe — this normalisation is. A 24 reaching
 * the comparison would read as "after the close" and name a session that has
 * not opened, which is exactly the defect {@link resolveUsSessionDate} exists
 * to prevent, reintroduced one layer down.
 *
 * **Unparseable falls back to the CLOSE hour, never to 0.** 0 would shift every
 * session date back a day on every run; the close hour reproduces the old
 * "today in New York" behaviour, which is the conservative reading — it can
 * never name a session that has not happened.
 */
export function normalizeEtHour(raw: number): number {
  if (!Number.isFinite(raw)) return US_SESSION_CLOSE_HOUR_ET;
  if (raw === 24) return 0;
  return raw;
}

/**
 * The hour (0-23) in the US exchange's calendar.
 *
 * Read alongside the DATE because the date alone stopped being enough when the
 * trigger moved to 11:00 IST — see {@link resolveUsSessionDate}. `hourCycle:
 * "h23"` is the explicit, unambiguous spelling; {@link normalizeEtHour} is what
 * makes the result correct even if it changes.
 */
export function usCalendarHour(nowMs: number): number {
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(new Date(nowMs));
  return normalizeEtHour(Number.parseInt(text, 10));
}

/**
 * The hour the US equity session closes, in the exchange's own calendar.
 *
 * The boundary is the CLOSE (16:00 ET) rather than the 17:30 ET publication or
 * the 20:00 ET end of the correction window, because this constant answers
 * "which session is this run reporting on", and that is settled at the close.
 * Both scheduled triggers land after midnight ET, so the distinction is
 * academic today — it is written down so the next schedule move does not have
 * to rediscover which of the three times it needs.
 */
export const US_SESSION_CLOSE_HOUR_ET = 16;

/** Day-of-week index (0 = Sunday) for a `YYYY-MM-DD` string, calendar-only. */
function dayOfWeek(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00.000Z`).getUTCDay();
}

/** Walk a `YYYY-MM-DD` string back `days` calendar days. */
export function shiftIsoDate(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00.000Z`);
  if (!Number.isFinite(ms)) return isoDate;
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The US session day this run is reporting on, `YYYY-MM-DD`.
 *
 * ## Why this is not simply "today in New York"
 *
 * It used to be, and that was correct for EXACTLY ONE clock. At the original
 * 07:00 IST trigger (01:30 UTC) it is 20:30/21:30 the PREVIOUS evening in New
 * York, so the NY calendar day IS the session that closed a few hours earlier
 * and no arithmetic was needed.
 *
 * The trigger moved to **11:00 IST** so leg (b) lands after Tiingo publishes
 * fund NAVs at 12:00 AM ET. 11:00 IST is 05:30 UTC, which in New York is
 * **00:30 (EST) / 01:30 (EDT) — just past midnight on the NEXT calendar day**.
 * "Today in New York" therefore became a session that has not OPENED yet (it
 * opens 09:30 ET, i.e. 19:00/20:00 IST that evening), and leg (d) would have
 * stamped `FxRate.date` with it — shifting every converted portfolio value by
 * a day, silently, in the one column whose purpose is to say WHICH day.
 *
 * So the rule is stated in terms of the CLOSE rather than the calendar: the
 * session being reported is the most recent one that has finished. If the NY
 * clock has not yet passed {@link US_SESSION_CLOSE_HOUR_ET}, today's session is
 * still ahead of us (or in progress) and the answer is the previous day. Then
 * a Saturday or Sunday is walked back to Friday, so a manual run at any hour on
 * any day still names a real session. That is correct under BOTH clocks — the
 * old 07:00 slot lands after the close and gets the same answer it always did —
 * which is the property that makes the next schedule move safe.
 *
 * NO US MARKET-HOLIDAY CALENDAR IS CONSULTED, and that is deliberate: this job
 * never asks "was there a session on day D". It fetches a trailing WINDOW and
 * writes whatever bars come back, so a holiday is simply a day with no bar —
 * self-announcing, and needing no table we would have to maintain and could get
 * wrong. This date is used only to label leg (d)'s FX row and to log what the
 * run was about.
 */
export function resolveUsSessionDate(nowMs: number): string {
  let date = usCalendarDate(nowMs);
  // Before the close, the most recent FINISHED session is yesterday's. This is
  // the line the 07:00 -> 11:00 IST move made load-bearing.
  if (usCalendarHour(nowMs) < US_SESSION_CLOSE_HOUR_ET) {
    date = shiftIsoDate(date, -1);
  }
  const dow = dayOfWeek(date);
  if (dow === 6)
    date = shiftIsoDate(date, -1); // Saturday -> Friday
  else if (dow === 0) date = shiftIsoDate(date, -2); // Sunday -> Friday
  return date;
}

/**
 * `startDate` for the per-symbol EOD request: the session date minus the
 * trailing window.
 *
 * A WINDOW rather than "the last stored bar + 1" on purpose. The window heals a
 * missed run for free (the same property that makes `xbrl-sync` and
 * `circulars-sync` backfillable) and it re-reads the days Tiingo is still
 * CORRECTING — equities publish at 17:30 ET and corrections land until 20:00
 * ET, so a bar fetched on the night of day D can legitimately change. Re-upsert
 * of an unchanged bar is a no-op on `@@unique([symbol, exchange, timeframe,
 * ts])`; a correction never seen is permanent.
 */
export function resolveWindowStart(
  sessionDate: string,
  lookbackDays: number,
): string {
  return shiftIsoDate(sessionDate, -Math.abs(lookbackDays));
}

/** UTC midnight of a `YYYY-MM-DD` — the storage convention for `ts` / `date`. */
export function utcMidnight(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

// ---------------------------------------------------------------------------
// SHAPING
// ---------------------------------------------------------------------------

/**
 * The `Candle.listingId` for a bar, given what the instrument row carries.
 *
 * A ticker is not a security: Tiingo's master holds two `DOW`/`NYSE` rows —
 * Dow Chemical (1972-2017) and Dow Inc. (2019-) — and 834 delisted US rows
 * share a ticker with a live one. `listingId` is what stops a full-range read
 * concatenating two companies into one price series, and `Candle.listingId` is
 * NOT nullable, so this must always produce something. (Since MONEY-1522,
 * `buildListingId` THROWS on a blank symbol or exchange — no real instrument
 * row carries one, and a throw is louder than a `:NYSE:…` id nobody can join.)
 *
 * Format comes from `buildListingId` in `tiingo-logic.ts` — IMPORTED, not
 * restated. It used to be restated here "only because that module is not in the
 * core export map yet", with the instruction to collapse the two once it was.
 * It was: `./market-data/tiingo/tiingo-logic` is in `packages/core`'s exports,
 * and this file already imported TYPES from that exact module three lines
 * above the comment claiming it could not. Collapsed in MONEY-1496, which
 * writes `listing_id` for every US bar in the lake and so cannot afford two
 * spellings — a listing id built two ways that disagree by one character
 * silently splits one security's history into two.
 *
 * A row whose `listingId` is absent is COUNTED by the caller. That count is the
 * falsifiability: a persistently non-zero fallback count means the instrument
 * sync is not stamping `listingId`, and the bars written under the synthetic
 * `:unknown` id will not join to the real listing later.
 */
export function resolveCandleListingId(args: {
  symbol: string;
  exchange: string;
  listingId?: string | null;
  listingStartDate?: Date | null;
}): { listingId: string; synthesised: boolean } {
  const explicit = args.listingId?.trim();
  if (explicit) return { listingId: explicit, synthesised: false };
  const start = args.listingStartDate
    ? args.listingStartDate.toISOString().slice(0, 10)
    : null;
  return {
    listingId: buildListingId(args.symbol, args.exchange, start),
    synthesised: true,
  };
}

/**
 * Map Tiingo bars onto `Candle` write rows.
 *
 * ## Finiteness and volume clamping are NOT done here, deliberately
 *
 * An earlier draft filtered non-finite prices and coerced volume itself. That
 * is a second sanitizer beside `sanitizeCandleWrites`, which the repository
 * already runs and — crucially — REPORTS on (`droppedNonFinite`,
 * `clampedVolume` on `CandleWriteResult`). Pre-filtering does not make the data
 * safer, it makes those two counters permanently zero, so a symbol whose feed
 * starts emitting garbage becomes invisible instead of visible. One rule, one
 * place, and the place that can report it wins.
 *
 * `volume` is therefore handed over as the raw number. `CandleWriteRow` accepts
 * `number | bigint` precisely so a caller does not have to risk `BigInt(NaN)`,
 * which THROWS rather than producing a bad value — and a throw here would cost
 * the whole symbol rather than one bar.
 *
 * The only thing filtered is a malformed DATE, because `ts` is the one field
 * this function has to construct rather than pass through, and
 * `new Date("nonsense")` is an Invalid Date that would travel further before
 * being noticed.
 */
export function toCandleRows(args: {
  symbol: string;
  exchange: string;
  listingId: string;
  /**
   * `ACTIVE` | `DELISTED`, straight off the master row.
   *
   * Passed THROUGH rather than defaulted here. `putCandles` routes a bar to
   * Mongo or to a GCS cold shard from this plus the bar's year, and the module
   * that owns that rule owns its default too — a second "absent means ACTIVE"
   * spelled here would be the one that eventually disagrees.
   */
  listingStatus?: string | null;
  /**
   * MONEY-1617 — every master window of this symbol ON THIS VENUE. Each bar is
   * filed under the window covering its session (`clipBarsToListingWindows`);
   * a bar no window covers is DROPPED and counted, never filed under
   * `listingId`. An empty list clips to nothing — the fetched listing keeps
   * every bar, which is the pre-MONEY-1617 behaviour, not a new failure.
   */
  windows: readonly ListingRow[];
  bars: readonly EodBarInput[];
}): { rows: CandleUpsert[]; dropped: Record<ClipDropReason, number> } {
  const { symbol, exchange, listingId, listingStatus, windows, bars } = args;
  const fetched: ListingRow = windows.find(
    (w) => w.listingId === listingId,
  ) ?? {
    symbol,
    exchange,
    listingId,
    listingStartDate: null,
    listingEndDate: null,
    listingStatus: listingStatus ?? "ACTIVE",
  };
  const clip = clipBarsToListingWindows({ bars, windows, fetched });
  const rows: CandleUpsert[] = [];
  for (const { bar, listingId: assigned, listingStatus: status } of clip.kept) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date)) continue;
    rows.push({
      symbol,
      exchange,
      timeframe: US_TIMEFRAME_D1,
      ts: utcMidnight(bar.date),
      listingId: assigned,
      // The ASSIGNED window's status routes the bar: a predecessor's session
      // belongs in its (delisted) cold tier, not the fetched listing's.
      listingStatus: assigned === listingId ? (listingStatus ?? null) : status,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume,
      divCash: bar.divCash,
      splitFactor: bar.splitFactor,
      source: US_EOD_SOURCE,
    });
  }
  return { rows, dropped: clip.dropped };
}

// ---------------------------------------------------------------------------
// LEG (b) — FUND NAVs
// ---------------------------------------------------------------------------

/** One `us_fund_nav` row, ready for Prisma. */
export interface UsFundNavRow {
  permaTicker: string;
  symbol: string;
  /** The session the NAV describes, UTC midnight. */
  date: Date;
  nav: number;
  /**
   * The distribution paid on this session, in fund currency.
   *
   * ALWAYS A NUMBER here, never null — and the difference is the column's whole
   * contract. `UsFundNav.divCash` is nullable so that ABSENT can mean "this row
   * predates the column"; a row this function produces was MEASURED, so its
   * no-distribution state is `0` and not null. Emitting null would manufacture
   * the one state the schema reserves for rows nobody measured, and on Mongo
   * `{divCash: null}` matches neither absent nor zero, so the two are not
   * recoverable from each other afterwards.
   */
  divCash: number;
  /**
   * The split factor for this session — PRESENT ONLY WHEN IT IS NOT 1.
   *
   * `undefined` means "no split", and that is a REAL ANSWER here rather than an
   * unmeasured one — the opposite of `divCash`, where the no-distribution state
   * is an explicit `0`. The two columns differ on purpose: a distribution of 0
   * is a fact worth recording on all ~73.5M rows, while a split factor of 1 is
   * the same fact restated 99.996% of the time, and Mongo stores an absent
   * field in zero bytes.
   *
   * NEVER null. Null would be a third state on a column whose whole design is
   * that absent means one specific thing.
   */
  splitFactor?: number;
  source: string;
}

/** What {@link toFundNavRows} refused, and why — counted, never swallowed. */
export interface FundNavShaping {
  rows: UsFundNavRow[];
  /** Bars dropped for a malformed date. */
  badDate: number;
  /** Bars dropped for a non-finite or non-positive NAV. */
  badNav: number;
  /** Repeats of one `(permaTicker, date)` inside this response. First wins. */
  dupInBatch: number;
  /**
   * Bars whose `divCash` was non-finite or negative and became 0.
   *
   * CLAMPED rather than dropped: the distribution is secondary and the NAV is
   * the primary datum, so a garbage `divCash` must not cost a real price point.
   * Counted rather than repaired silently, the same way `CandleWriteResult`
   * treats `clampedVolume` — a feed that starts emitting nonsense here has to
   * be visible, and a repair nobody counts is invisible by construction.
   *
   * Expected to stay 0: `parseTiingoEodCsv` already coerces a non-finite
   * `divCash` to 0 at the parse boundary, and 0 negative values were found
   * across 95,597 measured fund bars. It exists because this function's input
   * is a plain interface that a repair script or a future feed can satisfy
   * without going through that parser.
   */
  divCashClamped: number;
  /**
   * Bars claiming a split factor that is non-finite or non-positive.
   *
   * Recorded as NO SPLIT (the key is omitted) and counted, because absent means
   * "no split" here and silently writing that for a garbage value would make
   * the one state this column can assert into a guess. Zero would divide by
   * zero in any adjustment; a NaN would poison the cumulative product for every
   * bar before it.
   *
   * Expected to stay 0 — `parseTiingoEodCsv` already coerces a non-positive
   * factor to 1 at the parse boundary. It exists because this function's input
   * is a plain interface a repair script can satisfy without that parser, and
   * because a split is the one event here whose corruption is catastrophic
   * rather than cosmetic.
   */
  splitFactorRefused: number;
}

/**
 * Map a fund's `/tiingo/daily` bars onto `UsFundNav` rows.
 *
 * ## A NAV IS NOT A CANDLE, and this is the measurement that settled it
 *
 * Probed against our live token on 2026-08-28 — VFIAX (6,484 bars, 2000-2026),
 * FXAIX (3,852, 2011-), VWELX (11,760, 1979-), 22,096 fund bars in total:
 *
 *     open == high == low == close   in 22,096 of 22,096 rows   (0 differ)
 *     volume == 0                    in 22,096 of 22,096 rows
 *     splitFactor == 1               in 22,096 of 22,096 rows
 *
 * So four of `Candle`'s columns carry no information for a fund: three are
 * copies of the NAV and one is a constant zero. Writing them was not merely
 * wasteful — funds are 49,414 of 72,685 US listings and **72% of the bars in
 * every hot-window depth** (105.9M rows for a 10-year window with them, 33.8M
 * without), so the redundancy was the single largest term in the storage
 * budget.
 *
 * ## `divCash` IS CARRIED, and it is why a NAV row is not just a price
 *
 * `divCash` is NOT constant. Across a WIDER probe than the one above — 13 funds
 * and 95,597 bars — it is non-zero on 994 of them, and the amounts are not
 * rounding: RYVYX pays 63.394 against a 585.79 NAV on 2024-12-12, a 10.8%
 * one-day distribution. A NAV series without it does not merely understate
 * total return, it draws a CLIFF on the payout date that never happened.
 *
 * So it rides through to `UsFundNav.divCash`. It costs one Float per row and
 * ZERO extra requests — the column is already in the bytes leg (b) downloaded
 * for the NAV itself.
 *
 * ## `splitFactor` IS carried, SPARSELY — and the earlier reason was wrong
 *
 * The column was first omitted on the strength of a narrower measurement of
 * mine: "splitFactor was 1 in all 22,096 rows". That number was true and
 * UNREPRESENTATIVE — three large index/balanced funds that happen never to have
 * split. The wider probe falsifies it:
 *
 *     SWPPX  2025-08-15   NAV 100.05 ->  16.63   splitFactor  6
 *     DODGX  2025-10-27   NAV 282.70 ->  17.78   splitFactor 16
 *     FCNTX  2018-08-10   NAV 138.17 ->  13.73   splitFactor 10
 *     FSPTX  2018-08-10   NAV 186.45 ->  18.52   splitFactor 10
 *
 * Four in 95,597 rows (0.004%) — but two of them inside the last four months,
 * and each is an 83-94% apparent one-day collapse in an unadjusted series.
 * "Funds do not split" is FALSE and must not be inferred from this file.
 *
 * Those four ARE also recoverable by joining `UsCorporateAction` on
 * `(permaTicker, "SPLIT", exDate)` — `/tiingo/corporate-actions/splits?exDate=`
 * carries all four, keyed by the same permaTicker this table uses. They are
 * stored here ANYWAY, because that join is only as complete as the
 * corporate-actions day-walk backfill has been run, and a reader cannot tell
 * "no split" from "the walk has not reached 2018 yet".
 *
 * Storing it costs nothing BECAUSE it is sparse: the key is written only when
 * the value is not 1, so at 0.004% incidence the column is absent on ~73.5M
 * rows and Mongo stores an absent field in zero bytes. Writing 1.0 everywhere
 * would spend ~1.5 GB recording that nothing happened, which is what made the
 * "never varied, so omit it" argument attractive in the first place — sparsity
 * dissolves the trade-off instead of picking a side of it.
 *
 * Leg (c) also still DERIVES both events from these same bars in memory and
 * reports them per run, so a split is never invisible to the run that saw it.
 *
 * ## Refusals are counted, never dropped quietly
 *
 * `date` is the one field this function CONSTRUCTS rather than passes through,
 * so a malformed one would travel as an Invalid Date. A non-positive NAV is
 * refused too: `nav` feeds valuation arithmetic, and a 0 is not a cheap fund, it
 * is a parse failure wearing a number.
 */
export function toFundNavRows(args: {
  symbol: string;
  permaTicker: string;
  bars: readonly EodBarInput[];
}): FundNavShaping {
  const { symbol, permaTicker, bars } = args;
  const out: FundNavShaping = {
    rows: [],
    badDate: 0,
    badNav: 0,
    dupInBatch: 0,
    divCashClamped: 0,
    splitFactorRefused: 0,
  };
  const seen = new Set<string>();

  for (const bar of bars) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bar.date)) {
      out.badDate++;
      continue;
    }
    // The NAV is the CLOSE. Not the open, and not an average of the four: they
    // are all the same number in every measured row, and if they ever stop
    // being, `close` is the one that means "the published NAV for the session".
    const nav = bar.close;
    if (!Number.isFinite(nav) || nav <= 0) {
      out.badNav++;
      continue;
    }
    // The table's own `@@unique([permaTicker, date])`, applied in memory. Two
    // bars for one date inside one response would otherwise be two upserts to
    // one key in a single run, where the second overwrites the first and BOTH
    // are counted as written.
    if (seen.has(bar.date)) {
      out.dupInBatch++;
      continue;
    }
    seen.add(bar.date);
    // Clamped, not dropped, and counted. A garbage distribution must not cost a
    // real NAV; a silently repaired one must not be invisible.
    let divCash = bar.divCash;
    if (!Number.isFinite(divCash) || divCash < 0) {
      divCash = 0;
      out.divCashClamped++;
    }
    // SPARSE. The key is OMITTED for the overwhelmingly common no-split case,
    // never written as 1 and never written as null — see `UsFundNavRow.splitFactor`.
    const sf = bar.splitFactor;
    let splitFactor: number | undefined;
    if (!Number.isFinite(sf) || sf <= 0) {
      out.splitFactorRefused++;
    } else if (isRealSplit(sf)) {
      // EPSILON, never `!== 1`. AAPL's 7-for-1 is stored as 7.000007000007001
      // upstream, so a factor that is arithmetically 1 can arrive as
      // 1.0000000001 — and an exact test would write that as a "split",
      // populating a column whose whole value is that ABSENT means no split.
      splitFactor = sf;
    }

    out.rows.push({
      permaTicker,
      symbol,
      date: utcMidnight(bar.date),
      nav,
      divCash,
      ...(splitFactor !== undefined ? { splitFactor } : {}),
      source: US_EOD_SOURCE,
    });
  }
  return out;
}

/**
 * Why a fund with no `permaTicker` is SKIPPED rather than written.
 *
 * `UsFundNav.permaTicker` is REQUIRED and is half of `@@unique([permaTicker,
 * date])`; `UsInstrument.permaTicker` is OPTIONAL, filled by a separate paced
 * `searchSyncedAt` rotation. So on night one — and for every fund that rotation
 * has not reached — there is no key to write under.
 *
 * The tempting fix is to substitute the symbol. It must not be done: a ticker
 * recycles, so a fabricated key would file two funds' NAVs under one identity
 * and the row would look completely ordinary. Skipping is the "prefer
 * not-claiming over compensating" direction, and it is only safe BECAUSE it is
 * counted: `mfSkippedNoPermaTicker` climbing while `mfNavWritten` sits at zero
 * says the enrichment leg is behind, which is a different problem from Tiingo
 * being dark and points at a different job.
 */
export const MF_NAV_NEEDS_PERMATICKER =
  "skipped: UsFundNav requires a permaTicker (it is half of the unique key) " +
  "and this listing has none yet — us-instrument-master-sync's search leg " +
  "fills it. NOT substituted with the symbol: tickers recycle, so a fabricated " +
  "key would merge two funds' NAV histories into one identity.";

// ---------------------------------------------------------------------------
// LEG (c) — CORPORATE ACTIONS, DERIVED
// ---------------------------------------------------------------------------

/**
 * One corporate action, READ OFF A PRICE BAR rather than fetched.
 *
 * ## Why leg (c) has no endpoint of its own
 *
 * Tiingo's dedicated corporate-actions endpoints are NOT entitled on our plan.
 * All four forms were tested against our live token on 2026-08-28 and all four
 * answered 403:
 *
 *     /tiingo/corporate-actions/AAPL/splits
 *     /tiingo/corporate-actions/AAPL/distributions
 *     /tiingo/corporate-actions/splits?exDate=…
 *     /tiingo/corporate-actions/distributions?exDate=…
 *
 * So leg (c) cannot fetch a feed, and building it as one would be a job that
 * 403s every night while reporting a healthy quiet market — the exact shape
 * that hid Tickertape's block for five months (MONEY-1220).
 *
 * It does not need one. `divCash` and `splitFactor` are COLUMNS ON THE EOD
 * RESPONSE we are already downloading for legs (a) and (b): a bar with
 * `divCash > 0` IS a distribution on that ex-date, and a bar with
 * `splitFactor != 1` IS a split. The delta therefore costs ZERO extra requests
 * and ZERO extra quota, and it cannot go stale relative to the prices, because
 * it is the same bytes.
 *
 * ## What it is FOR
 *
 * The adjusted series is computed at READ time (CRSP back-adjustment from the
 * latest bar), which is what makes a new corporate action a cache concern
 * rather than a rewrite of up to 11,517 historical rows per event.
 *
 * Leg (c) DERIVES the delta and REPORTS it; it applies nothing. It used to
 * evict a namespace no code in this repository writes — see
 * {@link CA_EVICTION_UNAVAILABLE} for the measurement, and for where the
 * eviction belongs once the read path grows a cache. The derivation is worth
 * keeping on its own: it is free, it cannot drift from the prices because it IS
 * the prices, and it is the record of which securities an action touched on
 * which ex-date.
 *
 * ## What it deliberately does NOT do
 *
 * It does not write `CorporateAction` rows. That table is India's, fed by
 * Screener/NSE, and READ BY THE FIFO PAIRING COST-BASIS ADJUSTMENT. A US split
 * landing in it under a bare ticker would adjust an Indian holding's cost basis
 * — silently, plausibly, and wrongly. Widening that table to carry a market is
 * its own ticket, not a side effect of a price sync.
 */
export interface DerivedCorporateAction {
  symbol: string;
  exchange: string;
  /** Ex-date, `YYYY-MM-DD` — the bar the action was read from. */
  date: string;
  kind: "DIVIDEND" | "SPLIT";
  divCash: number;
  splitFactor: number;
}

/** Read the corporate actions out of one symbol's freshly-fetched bars. */
export function detectCorporateActions(args: {
  symbol: string;
  exchange: string;
  bars: readonly EodBarInput[];
}): DerivedCorporateAction[] {
  const { symbol, exchange, bars } = args;
  const out: DerivedCorporateAction[] = [];
  for (const bar of bars) {
    const div = Number.isFinite(bar.divCash) ? bar.divCash : 0;
    const split =
      Number.isFinite(bar.splitFactor) && bar.splitFactor > 0
        ? bar.splitFactor
        : 1;
    if (isRealSplit(split)) {
      out.push({
        symbol,
        exchange,
        date: bar.date,
        kind: "SPLIT",
        divCash: div,
        splitFactor: split,
      });
    } else if (div > 0) {
      out.push({
        symbol,
        exchange,
        date: bar.date,
        kind: "DIVIDEND",
        divCash: div,
        splitFactor: split,
      });
    }
  }
  return out;
}

/**
 * WHY LEG (c) EVICTS NOTHING — the namespace it invalidated never existed.
 *
 * This was `adjustedSeriesCachePattern()`, returning
 * `candles:adj:{exchange}:{symbol}:*` and handed to `clearCachePattern`. That
 * string appeared in exactly ONE place in the repository: the function that
 * minted it. Nothing WROTE it, so every call deleted 0 keys, `caKeysCleared`
 * was structurally 0, and the falsifiability this leg's own comment defined —
 * "actions detected and zero keys cleared, night after night, means the pattern
 * and the repository's key namespace have drifted apart" — was TRIPPED FROM DAY
 * ONE. A signal that is red on every healthy run is not a signal; it is the
 * thing an operator mutes, which is how the real drift would later go unseen.
 *
 * ## What the namespace actually is (read 2026-08-28)
 *
 * The ONLY cache in the candle module is the COLD SHARD cache
 * (`candle-cold-store.ts`): module `CANDLE_COLD_CACHE_MODULE = "candles-cold"`,
 * scope `"_global"`, identifier `buildCandleColdKey()` =
 * `candles/{market}/{timeframe}/{symbol}/{year}`. `generateCacheKey` renders
 * that as `candles-cold:_global:candles/US/D1/AAPL/2019:default`, with a
 * `…/2019%3Alast-good:default` twin for the stale-fallback copy.
 *
 * It caches RAW bars for one CLOSED symbol-year read out of GCS. It does NOT
 * cache the adjusted series: `CandleRepository.getCandles` runs
 * `adjustCandleSeries` on every call and caches nothing at all.
 *
 * ## So a corporate action does not stale it
 *
 * A split read off today's bar changes no closed year's RAW prices — adjustment
 * is applied over the merged series at READ time, and this job writes the new
 * bar into hot Mongo, which WINS the hot/cold merge. Evicting `candles-cold`
 * would discard entries that are still correct: pure cost, zero correctness
 * gain, against a cache whose entire purpose is keeping a decade of GCS round
 * trips off the read path.
 *
 * ## THE ENTRY POINT NOW EXISTS. That half of the old argument is RETRACTED.
 *
 * This used to say `CandleRepository` "exposes no eviction or invalidation
 * method" and that two of the four cache-key segments were private to modules
 * this job must not restate. Both were true when written and the first has
 * stopped being: `CandleRepository.evictColdShards()` exists, because
 * `putCandles` now WRITES cold shards and a GCS object that has moved under a
 * 6h cache is a stale read — so the invalidation became a requirement of the
 * WRITE path rather than a favour to this one. The private segments were
 * lifted into `COLD_CACHE_SCOPE` and `COLD_CACHE_LAST_GOOD_SUFFIX` at the same
 * time, for the same reason.
 *
 * Leg (c) still applies nothing, and the reason is now the WHOLE reason rather
 * than one of two:
 *
 *   `candles-cold` holds RAW bars for CLOSED symbol-years. The adjusted series
 *   is recomputed by `getCandles` on every call and cached nowhere. Tonight's
 *   split lands in hot Mongo, which WINS the hot/cold merge. So a corporate
 *   action stales nothing in that namespace, and evicting on one would discard
 *   entries that are still correct — pure cost, zero correctness gain, against
 *   a cache whose only job is keeping a decade of GCS round trips off the read
 *   path.
 *
 * That is a stronger position than the old one, not a weaker one: "we cannot"
 * is an argument that expires the moment somebody adds the method, and this one
 * does not. It expires only if `CandleRepository` grows an ADJUSTED-series
 * cache, at which point the eviction belongs beside the write that invalidates
 * it — still not here.
 */
export const CA_EVICTION_UNAVAILABLE =
  "derived only, evicted nothing — and deliberately, not for want of a method: " +
  "the sole candle cache namespace is `candles-cold`, which holds RAW bars for " +
  "CLOSED symbol-years, while the adjusted series is recomputed on every read " +
  "and cached nowhere. Tonight's action lands in hot Mongo, which wins the " +
  "merge, so evicting a cold shard would discard correct data. " +
  "CandleRepository.evictColdShards() DOES exist (putCandles needs it for its " +
  "own shard writes) and leg (c) still must not call it. When that repository " +
  "grows an ADJUSTED-series cache, the eviction belongs THERE, beside the write " +
  "that invalidates it.";

/** Distinct `(symbol, exchange)` pairs touched by a set of actions, in order. */
export function affectedSecurities(
  actions: readonly DerivedCorporateAction[],
): Array<{ symbol: string; exchange: string }> {
  const seen = new Set<string>();
  const out: Array<{ symbol: string; exchange: string }> = [];
  for (const a of actions) {
    const key = `${a.exchange}:${a.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol: a.symbol, exchange: a.exchange });
  }
  return out;
}

// ---------------------------------------------------------------------------
// LEG (e) - CORPORATE-ACTIONS CALENDAR (MONEY-1263)
//
// A CALENDAR. Not an adjustment source, and not a replacement for leg (c).
//
// ## Nothing here parses, shapes, keys or dedupes a corporate action
//
// All of that lives in `tiingo-corp-actions-logic.ts` and is imported. That is
// not deference - it is the same rule this module's header states about echoed
// interfaces, applied to behaviour: `dedupeCorpActions` keyed on anything but
// `(permaTicker, type, exDate)` silently drops a real split for a real company
// (two `reax` rows, two companies, one ex-date), and a second implementation of
// that rule living here would be free to drift from the one the backfill uses.
// What this file owns is what the JOB decides - which ex-date to ask about,
// whether the leg is healthy, and what the run says about a refusal.
// ---------------------------------------------------------------------------

/**
 * WHY LEG (c) DID NOT MOVE ONTO THE DEDICATED ENDPOINTS - the measurement.
 *
 * Beta access to `/tiingo/corporate-actions/{splits,distributions}` was GRANTED
 * and the endpoints were re-probed. Leg (c) still reads `divCash`/`splitFactor`
 * off the EOD bars, because the measurement says switching buys nothing:
 *
 *   symbol   endpoint   bars w/ divCash   both   only-endpoint   only-bars   mismatches
 *   AAPL           91                90     90               1           0            0
 *   KO            258               257    257               1           0            0
 *   GE            157               157    157               0           0            0
 *
 * 504 events, ZERO amount mismatches, ZERO date mismatches, and splits agree
 * too. The single argument for switching was `splitStatus` - the flag Tiingo
 * was said to set to "c" on a CANCELLED split, which a bar's `splitFactor`
 * column cannot express. THAT FIELD DOES NOT EXIST in live responses: verified
 * across all 67 split rows and all 2,035 distribution rows returned. So the
 * derived path is not a degraded stand-in with a known blind spot; on this
 * evidence it is the same data, arriving in bytes we already pay for.
 *
 * Leg (c) therefore stays exactly as it is, and leg (e) is a DIFFERENT JOB: it
 * records FORWARD-dated ex-dates and the announcement metadata (declaration,
 * record and payment dates) that no price bar carries, so the platform can say
 * "AAPL goes ex on Friday" instead of only "AAPL went ex last Friday".
 *
 * ## The separation is load-bearing, not stylistic
 *
 * If leg (e)'s rows ever reached the adjustment path they would double-count
 * every event leg (c) already read off the same day's bar - the two agree on
 * 504 of 504 events, which is exactly what makes silent duplication possible.
 * `UsCorporateAction` is written by leg (e) and read by NOTHING in this job;
 * `Candle.divCash` / `Candle.splitFactor` remain the sole adjustment inputs. A
 * source scan in the test file asserts that, because a comment cannot fail a
 * build.
 */
export const CA_CALENDAR_NOT_AN_ADJUSTMENT_SOURCE =
  "leg (e) is a forward CALENDAR, never an adjustment input: 504 events " +
  "measured across AAPL/KO/GE showed zero amount and zero date disagreement " +
  "with the `divCash`/`splitFactor` columns leg (c) already reads off the " +
  "bars, and `splitStatus` - the cancelled-split flag that was the whole " +
  "argument for switching - does not exist in live responses (0 of 67 splits, " +
  "0 of 2,035 distributions). Adjustment stays on Candle.divCash/splitFactor; " +
  "us_corporate_actions is written here and read by nothing in this job.";

/**
 * Rows per `symbol: {in: [...]}` lookup, for both new legs.
 *
 * A quarter-end ex-date is 6,482 rows and a market-wide news day names
 * hundreds of distinct tickers. One `in` clause that long is a query document
 * megabytes wide that the driver has to build and ship; chunking costs a
 * handful of indexed round trips instead. It is a request SHAPE limit, not a
 * throughput control - the wall clock is that, as always.
 */
export const CA_LOOKUP_CHUNK_SIZE = 500;

/** Split a list into fixed-size chunks. Empty in, empty out; never a 0-size loop. */
export function chunkList<T>(items: readonly T[], size: number): T[][] {
  const step = Number.isFinite(size) && size >= 1 ? Math.floor(size) : 1;
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    out.push(items.slice(i, i + step));
  }
  return out;
}

/**
 * Does this row carry CASH - `> 0`, never `!= null`.
 *
 * `distribution` is NULLABLE and separately ZEROABLE and the two are different
 * things: three genuine `0.0` rows exist in the live data (AAPL 2022-12-23
 * among them, fully populated with payment, record and declaration dates - a
 * real announced event that happens to carry no cash). `parseDistributionsCsv`
 * preserves that distinction all the way to the column, so `!= null` here would
 * answer "the field is present" and call a zero-cash calendar entry a dividend.
 *
 * ## The rows are still WRITTEN
 *
 * This is a REPORTING predicate, not a filter on the upsert. A 0.0 distribution
 * is a real calendar fact, and dropping it would make our calendar disagree
 * with the feed for reasons no reader could reconstruct. What the predicate is
 * for is the COUNT the run reports: a night where every distribution is 0.0 is
 * a feed-shape change worth seeing, and it is invisible if the two are
 * conflated.
 */
export function isCashDistribution(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * The next TRADING day after a `YYYY-MM-DD`, weekends skipped.
 *
 * No US market-holiday calendar is consulted, for the reason stated on
 * {@link resolveUsSessionDate} and restated in `enumerateExDates`: this repo
 * carries an INDIAN holiday calendar and no US one, and inventing a second
 * source of truth to save ~9 days a year would have to be maintained forever
 * to avoid skipping a day the market actually traded. The consequence for THIS
 * leg is written down on {@link resolveCalendarExDate} rather than left to be
 * discovered from an alert.
 */
export function nextTradingDayAfter(isoDate: string): string {
  let date = shiftIsoDate(isoDate, 1);
  for (let i = 0; i < 7; i++) {
    const dow = new Date(`${date}T00:00:00.000Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return date;
    date = shiftIsoDate(date, 1);
  }
  return date;
}

/**
 * The ONE ex-date leg (e) asks about, given the session this run reports on.
 *
 * ## Why exactly one day, and why the NEXT one
 *
 * The market-wide form takes exactly one `exDate` and REJECTS `startExDate` /
 * `endExDate` (measured - those work only on the per-ticker form, and omitting
 * `exDate` is a 400), so the horizon is bought in units of two requests. One
 * forward day is chosen because it is the horizon we have MEASUREMENTS for: a
 * typical weekday returns 100-400 distribution rows and 2-5 splits, spiking to
 * 6,482 rows / 1.35 MB at a quarter end. Nothing was measured about an ex-date
 * four weeks out, and an unmeasured horizon would make an empty answer
 * unreadable - a thin day far ahead (announcements simply not filed yet) and a
 * broken route both return zero, which is the shape this whole job is written
 * against.
 *
 * ## The schedule makes one day per run cover every trading day exactly once
 *
 * The cron is `2-6` IST (Tue-Sat), and `resolveUsSessionDate` walks a weekend
 * back to Friday, so the session dates a week produces are Mon..Fri and this
 * function maps them onto Tue..Fri plus Mon:
 *
 *     IST run     session (D)   target (D+1 trading)
 *     Tue         Mon           Tue
 *     Wed         Tue           Wed
 *     Thu         Wed           Thu
 *     Fri         Thu           Fri
 *     Sat         Fri           MON     <- the weekend skip closes the gap
 *
 * Every US trading day is asked about exactly once, on the night before it. No
 * gaps and no overlap, without a cursor, a marker or any cross-run state.
 *
 * ## Two consequences, both named rather than discovered later
 *
 * A LOST RUN loses that day's calendar as far as the nightly leg is concerned -
 * the same unbackfillable-by-schedule shape as `institutional-flow-sync`.
 * Unlike that job it is repairable, and the repair already exists in principle:
 * the routes take an arbitrary `exDate`, `enumerateExDates` walks a range, and
 * `UsCorporateAction` carries a plain `@@index([exDate])` for exactly that.
 *
 * A US MARKET HOLIDAY on the target day returns zero rows legitimately, roughly
 * nine nights a year (verified: a non-trading day answers the literal `None` on
 * both routes). {@link judgeCalendarLegVerdict} calls that `dark` anyway and
 * {@link judgeUsEodHealth} names the holiday as the first candidate cause,
 * because the alternative - treating an empty whole-market feed as acceptable -
 * is precisely the reading that hid Tickertape's block for five months.
 */
export function resolveCalendarExDate(sessionDate: string): string {
  return nextTradingDayAfter(sessionDate);
}

/**
 * Index the master's occupancy windows by UPPERCASE ticker, for ONE ex-date.
 *
 * `toUsCorporateActionRows` takes `listings: Map<upperTicker,
 * CorpActionListingWindow>` and runs each candidate through `resolveListingId`,
 * which rejects a window the ex-date falls outside. That is the disambiguation
 * mechanism, and this function is what feeds it: the master holds MORE THAN ONE
 * row per US ticker for 2,196 tickers, 834 of them a delisted row sharing a
 * ticker with a live one, so a map built by iteration order would hand a
 * forward-dated action to whichever row Mongo returned first.
 *
 * The rule is therefore: keep a symbol only when EXACTLY ONE of its candidate
 * windows contains the ex-date.
 *
 *   0 candidates cover it  -> omit. The action is for a security we do not
 *                             carry on that date; `listingId` stays null, which
 *                             is the schema's own documented state for it.
 *   1 candidate covers it  -> keep. Unambiguous, and checked rather than
 *                             assumed.
 *   2+ candidates cover it -> omit. Two live windows over one ticker on one day
 *                             is a master defect, and resolving it by picking
 *                             one would splice a corporate action into the
 *                             wrong company's history - silently, plausibly,
 *                             and unrecoverably. A null costs a later pass.
 *
 * `resolveListingId` is a VALUE import from `tiingo-corp-actions-logic`, which
 * this module's header would otherwise forbid. It is allowed because that file
 * is a proven pure leaf - its only import is `splitCsvLine`, the same zero-cost
 * splitter `tiingo-logic` uses - so nothing is constructed at load and the
 * tests stay hermetic. Re-implementing the window check here to preserve a
 * type-only rule would be the drift the rule exists to prevent.
 */
export function buildListingWindowIndex(args: {
  exDate: string;
  rows: ReadonlyArray<{
    symbol: string;
    listingId: string | null;
    listingStartDate: Date | null;
    listingEndDate: Date | null;
  }>;
}): Map<string, CorpActionListingWindow> {
  const { exDate, rows } = args;
  const candidates = new Map<string, CorpActionListingWindow[]>();

  for (const row of rows) {
    const listingId =
      typeof row.listingId === "string" ? row.listingId.trim() : "";
    if (!listingId) continue;
    const symbol =
      typeof row.symbol === "string" ? row.symbol.trim().toUpperCase() : "";
    if (!symbol) continue;

    const window: CorpActionListingWindow = {
      listingId,
      listingStartDate: isoDayOrNull(row.listingStartDate),
      listingEndDate: isoDayOrNull(row.listingEndDate),
    };
    // Only windows that actually CONTAIN the ex-date are candidates, and the
    // containment test is the one `toUsCorporateActionRows` will apply anyway.
    if (resolveListingId(exDate, window) === null) continue;

    const bucket = candidates.get(symbol);
    if (bucket) bucket.push(window);
    else candidates.set(symbol, [window]);
  }

  const out = new Map<string, CorpActionListingWindow>();
  for (const [symbol, windows] of candidates) {
    if (windows.length === 1) out.set(symbol, windows[0]!);
  }
  return out;
}

/** A `Date` as `YYYY-MM-DD`, or null - never an Invalid Date's `toISOString()` throw. */
function isoDayOrNull(value: Date | null): string | null {
  if (!(value instanceof Date)) return null;
  const ms = value.getTime();
  if (!Number.isFinite(ms)) return null;
  return value.toISOString().slice(0, 10);
}

/**
 * Judge leg (e). FOUR reachable states, and `noPopulation` is not one of them.
 *
 * Leg (e) has no local population to be empty: the routes are market-wide and
 * the table accepts a row for a security we do not carry (`listingId` is
 * nullable precisely so a coverage gap is recorded rather than discarded). So
 * there is no query that can return zero rows and mean "there is nothing of
 * this type" - the state is unreachable, and a branch returning it would be
 * dead code that reads as coverage. It is left out, the shared
 * {@link UsEodLegVerdict} union is kept so every leg's verdict stays comparable
 * on one flat result, and a test asserts the produced set is exactly
 * {notQueried, notReached, dark, healthy} so this claim is CHECKED rather than
 * asserted in prose.
 *
 * `attempted` is CALLS ISSUED (0, 1 or 2), not rows: it is the only thing this
 * leg can count before the answer arrives, and counting it after each call is
 * what stops a route that 403s on every request from reporting a full number
 * (MONEY-1255).
 *
 * A 404 - which `fetchDistributionsByExDate` reports as `null` and which means
 * a MOVED ENDPOINT rather than an empty day - contributes to `attempted` and
 * nothing to `rowsReceived`, so it lands as `dark`. That is the right bucket:
 * it is a failure, and the run says so.
 */
export function judgeCalendarLegVerdict(args: {
  /** `null` when the leg never ran - the run had already circuit-broken. */
  attempted: number | null;
  /** Rows RECEIVED across both routes, before dedupe. */
  rowsReceived: number;
}): UsEodLegVerdict {
  const { attempted, rowsReceived } = args;
  if (attempted === null) return "notQueried";
  if (attempted <= 0) return "notReached";
  return legIsDark(attempted, rowsReceived) ? "dark" : "healthy";
}

// ---------------------------------------------------------------------------
// LEG (f) - US NEWS — RETIRED (MONEY-1309)
//
// `newsSymbolsMentioned` and `judgeNewsLegVerdict` lived here. Both are gone
// with the leg rather than kept "in case": a judge with no caller is a judge
// nothing exercises, and its six carefully-distinguished verdicts would rot
// into a description of a job that no longer runs.
//
// The reasoning they encoded did NOT go with them. The `0`-vs-`null` rule for
// an unanswered master lookup — `0` means "we asked and carry none of these",
// `null` means "we could not ask", and collapsing them sends an operator to a
// healthy job while a database is down — is enforced in
// `processors/tiingo-news-poll.ts`, which REFUSES to write at all when every
// lookup chunk threw. That is stricter than judging it after the fact, and it
// is available to that job because a 2-minute poller can simply re-ask,
// where a nightly leg had one chance at the session.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SECONDARY-ENDPOINT REFUSALS - what the price legs let us say about a 403
// ---------------------------------------------------------------------------

/**
 * Name a 403 on a SECONDARY endpoint family, using the price legs as a control.
 *
 * MONEY-980 finding 1 established that this job cannot tell a rejected token
 * from an unentitled endpoint: both are 403, and the classification the client
 * once attempted was read off a response body the archive seam throws away
 * before anyone sees it. That remains true of any 403 taken in isolation.
 *
 * Legs (e) and (f) are not in isolation. They run AFTER legs (a)+(b), against
 * the SAME token, on a different endpoint family. So if the price legs received
 * bars this run, the token demonstrably works, and a refusal here is an
 * ENTITLEMENT refusal - a fact the run OBSERVED rather than a classification it
 * guessed. That is the whole reason the ordering in {@link PRICE_LEG_BUDGET_MS}
 * is worth its reserved slice.
 *
 * When the price legs received nothing - they were skipped, truncated, or dark
 * themselves - the control is absent and the honest answer is the old one: both
 * causes, both checks, neither ruled out.
 */
export function describeSecondaryRefusal(args: {
  /** e.g. "corporate-actions", "news". */
  endpointFamily: string;
  /** Did legs (a)+(b) receive any bars this run? The control. */
  priceLegsSawBars: boolean;
  /** `TiingoAuthError.message`, carried verbatim from the client. */
  detail: string | null;
}): string {
  const { endpointFamily, priceLegsSawBars, detail } = args;
  const tail = detail ? ` Client said: ${detail}` : "";
  if (priceLegsSawBars) {
    return (
      `TIINGO REFUSED /tiingo/${endpointFamily} (401/403) while /tiingo/daily ` +
      "answered with bars on the SAME token in this same run. The token is " +
      "therefore not the cause: this is an ENTITLEMENT refusal on the " +
      `${endpointFamily} family - check the plan/beta grant, not ` +
      `TIINGO_API_KEY.${tail}`
    );
  }
  return (
    `TIINGO REFUSED /tiingo/${endpointFamily} (401/403) and this run has NO ` +
    "control: the price legs received no bars, so the token was never " +
    "independently confirmed. Check BOTH the TIINGO_API_KEY for this " +
    `environment AND the ${endpointFamily} entitlement. Neither heals on ` +
    `retry.${tail}`
  );
}

// The four NEWS_* reason strings that stood here — floor rejection, offset
// ceiling, write deadline and unanswered master lookup — went with leg (f)
// (MONEY-1309). The two that still describe a live contract were carried into
// `processors/tiingo-news-poll.ts` as `NEWS_FLOOR_REJECTED_REASON` and
// `NEWS_LOOKUP_UNAVAILABLE_REASON`, reworded for a poller that re-asks every
// two minutes instead of getting one attempt at a session. The write-deadline
// and offset-ceiling sentences did not survive as constants because the poller's
// window is minutes rather than a whole session: it can neither fill a page nor
// run out of write budget on an ordinary tick, and a named sentence for a state
// that cannot occur is a comment pretending to be a guard.

// ---------------------------------------------------------------------------
// SELF-CHAIN
// ---------------------------------------------------------------------------

/** Inputs to the self-chain decision. All OBSERVED by the caller, none inferred. */
export interface UsEodChainInput {
  /** This run's depth (0 for a scheduler trigger). */
  chainDepth: number;
  /** Rows leg (a) pulled, and the `take` it used. */
  equitySelected: number;
  equityBatchSize: number;
  /** Rows leg (b) pulled, and the `take` it used. */
  mfSelected: number;
  mfBatchSize: number;
  /** Rows whose rotation marker actually MOVED this run. */
  stamped: number;
  /** The run circuit-broke on a Tiingo rate limit. */
  rateLimited: boolean;
  /**
   * Tiingo REFUSED the request (401/403) — a rejected token OR an unentitled
   * endpoint, and this layer cannot tell which.
   *
   * ONE field where there were two (MONEY-980 review, finding 1). The client
   * decided `isTokenProblem` from a response BODY it never had, so the
   * entitlement arm was unreachable; and for the chain the distinction never
   * mattered anyway — both are deterministic and both mean a fresh link
   * collects the identical refusal.
   */
  accessRefused: boolean;
  /** The message named explicit `symbols` — a targeted repair, not a rotation. */
  symbolScoped: boolean;
  /**
   * Leg (a)'s page led with a row THIS chain had already stamped, i.e. the
   * EQUITY rotation has come full circle and its next page would re-fetch
   * symbols this chain synced minutes ago.
   *
   * ## Per LEG, because one wrap used to end the other leg's chain
   *
   * There was ONE `rotationWrapped` flag and it was derived from leg (a)'s page
   * alone — the processor passed `isFirstPage: true` for EQUITY only, so the MF
   * page's marker was never even read. Once the equity partition wrapped at
   * link k, `shouldChainAnotherBatch` returned false with a FULL page of
   * never-synced funds still pending, every night, forever. At ~49k MF listings
   * and 200 a link the NAV rotation advanced `200 x k` rows a night and could
   * never catch up — while leg (b) reported `healthy` on every run, because it
   * genuinely did fetch bars for the 200 funds it reached.
   *
   * The two legs are separate queries over disjoint partitions with their own
   * page sizes and their own rotation speeds. A partition that has come full
   * circle says nothing whatsoever about the other one, so one flag could only
   * ever be right about one of them.
   */
  equityRotationWrapped: boolean;
  /** As {@link equityRotationWrapped}, for leg (b)'s own page. */
  mfRotationWrapped: boolean;
}

/**
 * Does ONE leg still have un-visited work its next page would reach?
 *
 * Both halves are required and they fail in opposite directions:
 *
 *   a SHORT page  -> the whole partition fit in this page; there is no next one
 *   a WRAPPED page -> there IS a next page and it is rows this chain already
 *                     synced, so fetching it spends an unobservable quota to
 *                     re-do finished work
 *
 * A page size of 0 (or worse) means the leg was never asked for anything, which
 * is not work pending — without that term a forged `batchSize: 0` message would
 * make `selected >= batchSize` trivially true and chain to the ceiling on an
 * empty page.
 */
export function legHasMoreWork(
  selected: number,
  batchSize: number,
  rotationWrapped: boolean,
): boolean {
  if (!(batchSize > 0)) return false;
  if (rotationWrapped) return false;
  return selected >= batchSize;
}

/**
 * Should this run publish a follow-up message?
 *
 * ## Why this terminates
 *
 * Condition 1 alone bounds the chain at `MAX_CHAIN_DEPTH` messages, because
 * every published link carries `chainDepth + 1` and this function refuses once
 * the NEXT depth would reach the ceiling. That bound holds regardless of the
 * database, the upstream, the clock or the queue — none of which this function
 * consults. Every other condition can only stop the chain SOONER, so none of
 * them can break the bound; they exist to stop it sooner for a REASON.
 *
 *  1. **Depth.** The next link would reach `MAX_CHAIN_DEPTH`.
 *  2. **Rate limited.** `API_LIMITS`-style budgets are PER RUN, so a fresh link
 *     re-arms the breaker straight back into the tarpit. MONEY-853 wrote this
 *     down after a whole-market run hit a per-IP 429 wall and every retry spent
 *     its budget collecting the same error.
 *  3. **Access refused.** A 401/403 — rejected token or unentitled endpoint,
 *     indistinguishable here and deterministic either way. Chaining re-collects
 *     the identical refusal twenty times and pages nobody any faster.
 *  4. **Scoped.** An explicit `symbols` list is a finite manual target with no
 *     next page; chaining would re-fetch the same tickers to the ceiling.
 *  5. **No progress.** Not one row was stamped — e.g. every `updateMany` threw.
 *     Chaining here re-selects the identical page forever, which is the
 *     runaway-poll shape this repo already has an incident for.
 *  6. **Neither leg has more work.** Per leg, and that is the whole of
 *     {@link legHasMoreWork}: a leg still has work when its page came back FULL
 *     and its rotation has not wrapped. Chaining while EITHER leg qualifies.
 *
 *     This subsumes what used to be two separate conditions — a single
 *     `rotationWrapped` and a "both legs came back short" drain test — and
 *     merging them was the fix rather than tidying. Kept apart, the wrap flag
 *     was global while the drain test was per leg, so one partition wrapping
 *     ended the other partition's chain (see {@link UsEodChainInput}). Kept
 *     apart the OTHER way — per-leg wrap, global drain — a wrapped-but-full
 *     equity page beside a drained MF page would chain to the ceiling doing
 *     nothing. Both facts are per leg, so the condition has to be too.
 *
 *     Unlike `stock-document-extract`, a processed row here does not LEAVE the
 *     selected set — it moves to the back of a stale-first queue — so "the page
 *     came back short" can never be the drained signal on its own.
 */
export function shouldChainAnotherBatch(input: UsEodChainInput): boolean {
  const {
    chainDepth,
    equitySelected,
    equityBatchSize,
    mfSelected,
    mfBatchSize,
    stamped,
    rateLimited,
    accessRefused,
    symbolScoped,
    equityRotationWrapped,
    mfRotationWrapped,
  } = input;

  if (chainDepth + 1 >= MAX_CHAIN_DEPTH) return false;
  if (rateLimited) return false;
  if (accessRefused) return false;
  if (symbolScoped) return false;
  if (stamped <= 0) return false;
  return (
    legHasMoreWork(equitySelected, equityBatchSize, equityRotationWrapped) ||
    legHasMoreWork(mfSelected, mfBatchSize, mfRotationWrapped)
  );
}

/**
 * Has ONE leg's rotation come full circle within this chain?
 *
 * Pure arithmetic over two numbers the CALLER observed — that leg's page's
 * oldest `usEodSyncedAt` and the epoch ms the chain's first link started. A
 * null oldest marker means the page still leads with never-synced rows, which
 * is the opposite of wrapped. An absent or non-finite `chainStartedAtMs` (a
 * hand-made message, a forged payload) reads as NOT wrapped, which can only let
 * the chain run its already-bounded length — never longer.
 *
 * Called ONCE PER LEG. The function was always per-page; what was wrong was the
 * caller, which read leg (a)'s page and applied the answer to both partitions —
 * see {@link UsEodChainInput.equityRotationWrapped}.
 */
export function hasRotationWrapped(
  pageOldestSyncedAtMs: number | null,
  chainStartedAtMs: number | null,
): boolean {
  if (pageOldestSyncedAtMs === null || !Number.isFinite(pageOldestSyncedAtMs)) {
    return false;
  }
  if (chainStartedAtMs === null || !Number.isFinite(chainStartedAtMs)) {
    return false;
  }
  return pageOldestSyncedAtMs >= chainStartedAtMs;
}

/**
 * Sanitise the `chainStartedAt` carried on an inbound message.
 *
 * Returns null for anything that is not a plausible epoch-ms stamp. A garbage
 * value must not be usable to force `rotationWrapped` true and mute the chain,
 * nor to force it false — null gives the safe reading (not wrapped, chain runs
 * its bounded length).
 */
export function normalizeChainStartedAt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

// ---------------------------------------------------------------------------
// HEALTH — one verdict per LEG, because a total hides a dead leg
// ---------------------------------------------------------------------------

/**
 * Is a leg DARK — i.e. it asked upstream for symbols and got no bars at all?
 *
 * BARS RECEIVED, never bars WRITTEN, and that distinction is the whole point.
 * `CandleRepository.putCandles` PRESERVES a row already held at equal-or-stronger
 * provenance, so on the night after a US market holiday every bar in the
 * trailing window is already stored, `created + upgraded` is 0, and a
 * written-based test would call a perfectly healthy run dark ~10 times a year.
 * A monitor that fires on correct behaviour is a monitor somebody mutes.
 *
 * Bars received has neither problem: a live leg returns the window whether or
 * not anything in it is new, and a leg that is 403'd, mis-selected or pointed
 * at an empty population returns nothing.
 */
export function legIsDark(attempted: number, barsReceived: number): boolean {
  return attempted > 0 && barsReceived === 0;
}

/**
 * What a price leg PROVED about itself tonight — MONEY-980 finding 2.
 *
 * `legIsDark` is a two-way test and two ways were not enough. It requires
 * `attempted > 0`, so a leg that can NEVER attempt anything — because its
 * population is empty — is not dark, and the run therefore reported it as
 * HEALTHY. That is precisely the failure this job's module header is written
 * against, arrived at from the other side: not "a 403 looks like a quiet night"
 * but "a structurally dead leg looks like a working one".
 *
 * It was not hypothetical when it was found. Leg (b) selects
 * `assetType ∈ US_MF_ASSET_TYPES` (then `instrumentType ∈ {MF, MUTUAL_FUND}`
 * on `instrument_mappings`), and the only writer of US rows filtered funds out
 * UPSTREAM: `TIINGO_US_ASSET_TYPES` was
 * `{Stock, ETF}`, the exchange lists excluded the `NMFQS` fund venue, and
 * `usInstrumentTypeFor` returned only `EQUITY | ETF`. So `mfAttempted` was 0
 * every night, `legIsDark(0, 0)` was false, and a leg advertised in the topic
 * doc, the scheduler description, the monitor comment and CLAUDE.md had never
 * once run — while reading as healthy.
 *
 * The POPULATION has since been fixed (2026-08-28: funds admitted to the
 * master, 49,414 MF listings of 72,685), so `noPopulation` should no longer be
 * leg (b)'s steady state. This verdict stays regardless, and the distinction
 * matters: the population fix makes the leg WORK, and this makes the leg
 * ANSWERABLE. If funds ever drop out of the master again — a provider change, a
 * venue removed from `TIINGO_US_EXCHANGES`, a `listingStatus` sweep — the run
 * says so on the first night instead of reading as a healthy quiet one.
 *
 * ## Five states, because each is a DIFFERENT SENTENCE
 *
 *   `healthy`       symbols were requested and bars came back. EARNED, never
 *                   defaulted to.
 *   `dark`          symbols were requested and ZERO bars came back. A failure.
 *   `noPopulation`  the query RAN and matched no rows. Not a failure and not
 *                   silence: there is nothing of this type to sync, which is a
 *                   claim about the instrument master, not about tonight.
 *   `notReached`    rows exist, but the wall clock or the request budget
 *                   stopped the run before its first symbol. No evidence
 *                   either way; the rotation heals it next link.
 *   `notQueried`    the leg never issued its `findMany` — the run had already
 *                   circuit-broken on a rate limit or a 403.
 *   `undetermined`  the leg RAN and the run cannot say how it went, because a
 *                   lookup it needed to judge itself did not answer. Produced
 *                   only by the retired leg (f)'s judge (MONEY-1309), whose
 *                   master lookup could fail to answer; the price legs read
 *                   their population from the same `findMany` whose failure
 *                   would throw the run, so they have no such state. The
 *                   VARIANT is kept: it costs nothing and a future leg that
 *                   depends on a second query will need it.
 *
 * Collapsing any of the last three into `healthy` restores the blind spot.
 * Collapsing `notReached` or `notQueried` into `noPopulation` would be a NEW
 * lie of the same class — asserting an empty population from a query that never
 * ran, which is the fail-open-cached-as-fact shape this repo has a standing
 * rule against.
 *
 * The rule keeps working UNCHANGED if the population is later added: the moment
 * one `MF` row exists, `selected` is non-zero and the leg is judged on
 * attempted-vs-received exactly like leg (a).
 *
 * `selected` is `null` for a leg whose query never ran, which is why it is not
 * simply 0 — 0 is an ANSWER and null is the absence of one.
 */
export type UsEodLegVerdict =
  | "healthy"
  | "dark"
  | "noPopulation"
  | "notReached"
  | "notQueried"
  | "undetermined";

/**
 * Judge ONE price leg. Pure; `dark` is delegated so the rule has one home.
 *
 * NEVER returns `undetermined`: a price leg's population comes from the same
 * `findMany` that would throw the whole run if the database were unreachable,
 * so there is no state in which this leg ran and cannot be judged. That is
 * asserted rather than assumed — see the test file.
 */
export function judgeLegVerdict(args: {
  selected: number | null;
  attempted: number;
  barsReceived: number;
}): UsEodLegVerdict {
  const { selected, attempted, barsReceived } = args;
  if (selected === null) return "notQueried";
  if (selected <= 0) return "noPopulation";
  if (attempted <= 0) return "notReached";
  return legIsDark(attempted, barsReceived) ? "dark" : "healthy";
}

/**
 * The `selected` this run reports to Datadog — "work OWED A WRITE", not "rows
 * looked at".
 *
 * MONEY-1250 changed the meaning of this counter across the repo for exactly
 * this reason: the monitor is `clamp(selected) - clamp(written) > 0`, so a
 * `selected` that counts the population SCANNED pages on every correct quiet
 * night. Here "owed" is:
 *
 *   - bars that came back and were NOT already stored at equal-or-stronger
 *     provenance (`created + upgraded + failed + droppedNonFinite` from
 *     `CandleWriteResult`) — a `preserved` bar was owed nothing, and that is
 *     what makes a holiday read 0-0 instead of 800-0;
 *   - plus, for any leg judged DARK, the SYMBOLS it requested — each was owed
 *     at least one bar and got none, so a leg that 403s every call reports
 *     `selected 800, written 0` and pages somebody, instead of reporting
 *     `0 - 0 = 0` and looking exactly like the quiet night above;
 *   - plus the FX leg's one row.
 *
 * The units are deliberately mixed in that middle term and it is worth being
 * explicit about it: a dark leg has no bars to count, so the only honest
 * measure of what it failed to deliver is what it asked for. `bse-announcements-sync`
 * reached the opposite conclusion for its own shape and had to add a
 * self-judgement because its monitor could never fire on a zero-fetch run; this
 * job carries BOTH — the counter can fire, and `judgeUsEodHealth` names the leg
 * either way.
 *
 * ## Legs (e) and (f) join on exactly the same terms
 *
 * MONEY-1263 / MONEY-1264. Their `owed` is rows the run tried to upsert; their
 * DARK contribution is the CALLS they issued, not rows, for the same reason the
 * price legs contribute symbols: a leg that received nothing has no rows to
 * count, so the only honest measure of what it failed to deliver is what it
 * asked for. Two calls and one call are small numbers, and that is fine - the
 * monitor is `clamp(selected) - clamp(written) > 0`, so any non-zero
 * contribution is all a dark leg needs to stop reading as a genuinely idle
 * 0-0 night.
 */
export function computeSelected(input: {
  equityOwed: number;
  equityAttempted: number;
  equityBars: number;
  mfOwed: number;
  mfAttempted: number;
  mfBars: number;
  fxAttempted: number;
  /** Leg (e): rows the run tried to upsert, the calls it issued, rows received. */
  caOwed: number;
  caAttempted: number;
  caRows: number;
}): number {
  const {
    equityOwed,
    equityAttempted,
    equityBars,
    mfOwed,
    mfAttempted,
    mfBars,
    fxAttempted,
    caOwed,
    caAttempted,
    caRows,
  } = input;
  let selected = equityOwed + mfOwed + fxAttempted + caOwed;
  if (legIsDark(equityAttempted, equityBars)) selected += equityAttempted;
  if (legIsDark(mfAttempted, mfBars)) selected += mfAttempted;
  if (legIsDark(caAttempted, caRows)) selected += caAttempted;
  return selected;
}

/** Everything `judgeUsEodHealth` needs, all counted AFTER the call it counts. */
export interface UsEodHealthInput {
  /**
   * Rows leg (a)'s `findMany` returned, or `null` if that query never ran.
   *
   * NOT the same question as `equityAttempted`, and conflating them is the
   * MONEY-980 finding-2 defect: `attempted` is 0 both when the population is
   * EMPTY and when the wall clock stopped the run before its first symbol, and
   * the old rule read the second as the first ("the Tiingo instrument sync has
   * not populated them") — a confident, wrong sentence.
   */
  equitySelected: number | null;
  /** Symbols leg (a) actually issued a request for. */
  equityAttempted: number;
  /** Bars leg (a) RECEIVED. See `legIsDark` for why this is not bars written. */
  equityBars: number;
  /** Rows leg (b)'s `findMany` returned, or `null` if that query never ran. */
  mfSelected: number | null;
  /** Funds leg (b) actually issued a request for. */
  mfAttempted: number;
  /** Bars/NAVs leg (b) RECEIVED. */
  mfBars: number;
  /**
   * Funds leg (b) skipped for want of a permaTicker, BEFORE issuing a request.
   *
   * A blind spot this input exists to close: without it the leg reads `healthy`
   * on the exact night when `UsFundNav` gained nothing, because
   * `us-instrument-master-sync`'s search rotation has not filled `permaTicker`
   * on a single fund. That is the "a leg whose population is empty by
   * construction reads as healthy forever" shape, one layer in: the population
   * is fine, the KEY is missing.
   *
   * DISJOINT FROM `mfAttempted`, and that is the whole contract. It used to be
   * a SUBSET: the fund was fetched and then discarded, so it counted in both.
   * MONEY-1291 moved the guard ahead of the request — Tiingo is paid and
   * metered, and 46,908 of 49,846 funds carried no key — so a skipped fund now
   * issues nothing and increments only this. Funds reached is
   * `mfAttempted + mfSkippedNoPermaTicker`.
   *
   * Anything comparing the two must be read in that light. `skipped >= attempted`
   * USED to mean "every fund was unkeyable"; it now means only "the unkeyable
   * ones outnumbered the keyable ones", which on a 94%-unkeyable population is
   * the ordinary nightly shape.
   */
  mfSkippedNoPermaTicker: number;
  /** 1 when leg (d) tried, 0 when it was skipped. */
  fxAttempted: number;
  /** 1 when leg (d) persisted its row. */
  fxWritten: number;
  /** Upstream calls that failed — NOT rows. */
  transportFailures: number;
  rateLimited: boolean;
  /**
   * Tiingo refused the request with a 401/403 — see `UsEodChainInput`.
   *
   * ONE flag, not two. The pair it replaces (`authFailed`, `entitlementBlocked`)
   * produced a branch that could never fire and a message that told the
   * operator "this is NOT a token problem" on the strength of a response body
   * nobody had read (MONEY-980 review, finding 1).
   */
  accessRefused: boolean;
  /**
   * The refusal's operator-facing text, taken verbatim from
   * `TiingoAuthError.message` (i.e. `tiingoAuthMessage()`).
   *
   * PASSED IN rather than composed here, for two reasons that both matter.
   * This module takes only `import type` from `@usemoney/core`, so it cannot
   * call the exported builder; and re-typing the sentence would give the
   * platform two wordings for one refusal, which is how the wrong one survives
   * an outage. `null` falls back to a short generic line — a message is
   * evidence, and inventing one would be the same defect from the other side.
   */
  accessRefusedDetail?: string | null;

  // -- LEG (e), the corporate-actions calendar (MONEY-1263) ----------------

  /**
   * Calls leg (e) issued, or `null` when it never ran.
   *
   * `null` and `0` are DIFFERENT ANSWERS, and the distinction is the same one
   * MONEY-980 finding 2 was about, one leg over: `null` is "the run had
   * circuit-broken before this leg", `0` is "the leg was reached but the wall
   * clock or the request budget stopped it before its first call". Collapsing
   * them puts a leg that was never asked into the same bucket as one that ran
   * out of clock, and only one of those is a reason to look at the schedule.
   */
  caAttempted: number | null;
  /** Rows leg (e) RECEIVED across both routes, before dedupe. */
  caRows: number;
  /** Tiingo refused `/tiingo/corporate-actions` with a 401/403. */
  caRefused: boolean;
  /** That refusal's client text, verbatim. See `accessRefusedDetail`. */
  caRefusedDetail?: string | null;

  // -- LEG (f) IS RETIRED — MONEY-1309 --------------------------------------
  //
  // Nine news inputs used to be REQUIRED here. They are gone rather than made
  // optional: an optional health input defaults to whatever `undefined` means
  // to the judge, and this interface's own comment on `legs` argues that an
  // optional verdict is one an operator has to notice is missing.
}

/**
 * The run's verdict, plus one verdict PER LEG.
 *
 * `legs` is returned on every path, including the early run-level failures, and
 * it is carried into the job outcome. A leg that cannot be judged healthy must
 * never reach an operator as silence — the whole finding-2 defect was a leg
 * whose emptiness had no field to appear in.
 */
export interface UsEodHealthVerdict {
  ok: boolean;
  reason?: string;
  /**
   * One verdict per leg, on every path.
   *
   * `ca` joined in MONEY-1263 and it is FLAT and REQUIRED here rather than
   * nested or optional, for the reason the two price legs are: an optional
   * verdict is one an operator has to notice is missing, and the defect this
   * shape exists to prevent is a leg whose state had no field to appear in.
   *
   * `news` was here too until MONEY-1309 retired leg (f). It is REMOVED rather
   * than pinned to `notQueried` forever — a verdict that can only ever hold one
   * value is not a verdict, and an operator reading `news=notQueried` on every
   * run would reasonably conclude the leg is broken rather than gone.
   */
  legs: {
    equity: UsEodLegVerdict;
    mf: UsEodLegVerdict;
    ca: UsEodLegVerdict;
  };
}

/**
 * One sentence per non-healthy leg, naming the CAUSE rather than the symptom.
 *
 * `noPopulation` is leg-specific because the two legs fail it for different
 * reasons and an operator needs the one that applies. Everything else is
 * generic, so a leg that later grows a population keeps working through the
 * same text.
 */
/**
 * One sentence per non-healthy SECONDARY leg (e)/(f).
 *
 * Separate from {@link describeLeg} rather than a third and fourth arm on it,
 * because the two families fail for different reasons and share almost no
 * text: a price leg that selected nothing is a claim about
 * `us_instruments`, while a market-wide feed leg that came back empty is a
 * claim about the feed. Folding them together would produce a sentence general
 * enough to be true of both and therefore useful for neither.
 *
 * `dark` returns null here because a dark secondary leg is reported by a
 * run-level branch that has the counts to say something specific.
 *
 * It took `"CA" | "NEWS"` until MONEY-1309 retired leg (f).
 */
function describeSecondaryLeg(
  // "CA" only since MONEY-1309 retired leg (f). Kept as a UNION of one rather
  // than dropped, because the parameter is what makes this function's shape say
  // "there is a family of secondary legs" — leg (e) was the second of two and
  // will not be the last.
  leg: "CA",
  verdict: UsEodLegVerdict,
): string | null {
  switch (verdict) {
    case "healthy":
    case "dark":
      return null;
    case "noPopulation":
      return (
        `${leg} CALENDAR leg reported an EMPTY POPULATION, which ` +
        "`judgeCalendarLegVerdict` cannot produce: that leg has no local " +
        "population to be empty (its routes are market-wide and the table " +
        "deliberately accepts a row for a security we do not carry). If " +
        "you are reading this sentence, the judge changed and this note " +
        "is the evidence."
      );
    case "notReached":
      return (
        `${leg} CALENDAR leg was reached but issued NO call - the wall clock ` +
        "or the plan request budget stopped the run first. The target " +
        "ex-date is asked about only on the night before it, so unlike " +
        "the price legs this is a day the nightly rotation does not " +
        "re-offer; a day-walk repair is what fills it."
      );
    case "notQueried":
      return (
        `${leg} CALENDAR leg never ran - the run had already circuit-broken ` +
        "on a rate limit or a refusal. Its state tonight is UNKNOWN, not " +
        "healthy."
      );
    case "undetermined":
      // UNREACHABLE for this leg and deliberately left as a null rather than a
      // sentence. The only leg that could ever produce `undetermined` was the
      // NEWS leg, whose master lookup could fail to answer; leg (e) reads no
      // local population at all. MONEY-1309 removed the producer, not the
      // state — `UsEodLegVerdict` still declares it and a future secondary leg
      // may need it.
      return null;
  }
}

function describeLeg(
  leg: "EOD" | "NAV",
  verdict: UsEodLegVerdict,
): string | null {
  switch (verdict) {
    case "healthy":
    case "dark":
      return null;
    case "noPopulation":
      return leg === "EOD"
        ? "EOD leg has an EMPTY POPULATION: no `us_instruments` row " +
            "matches {listingStatus:'ACTIVE', assetType in {Stock, ETF}}, so " +
            "the Tiingo instrument sync has not populated them."
        : "NAV leg has an EMPTY POPULATION: no ACTIVE `us_instruments` row " +
            "carries assetType 'Mutual Fund'. The leg selected nothing " +
            "because there is nothing of that type — a different statement " +
            "from 'the leg failed', and from silence. This is NOT the expected " +
            "steady state: the instrument master carries ~49,414 MF listings " +
            "since 2026-08-28, so an empty page means the US master sync has " +
            "not run in this environment, or funds have dropped out of it " +
            "(asset-type filter, `NMFQS` removed from the exchange list, or a " +
            "listingStatus sweep). Check `us-instrument-master-sync` first.";
    case "notReached":
      return (
        `${leg} leg selected rows but reached NO symbol — the wall clock ` +
        "or the plan request budget stopped the run first. No evidence either " +
        "way; those rows keep their stale marker and lead the next page."
      );
    case "notQueried":
      return (
        `${leg} leg never ran its query — the run had already circuit-` +
        "broken. Its state tonight is UNKNOWN, not healthy."
      );
    case "undetermined":
      return (
        `${leg} leg reported UNDETERMINED, which \`judgeLegVerdict\` cannot ` +
        "produce: a price leg reads its population from the same `findMany` " +
        "whose failure would throw the whole run, so there is no state in " +
        "which it ran and cannot be judged. If you are reading this sentence, " +
        "the judge changed and this note is the evidence."
      );
  }
}

/**
 * Judge the run, leg by leg.
 *
 * ## Why not just `selected > 0 && written === 0`
 *
 * Because a total hides a dead leg. This job runs four legs against ONE
 * upstream: if the NAV leg 403s while the equity leg writes 70,000 bars, the
 * run's totals are magnificent and the fund NAVs have silently stopped — which
 * is precisely the shape MONEY-1255 found in `stock-document-sync`, where a
 * per-source counter incremented BEFORE the call it counted made a source that
 * 403s on every request still report a full number.
 *
 * Every counter fed in here is incremented AFTER its call returns, and every
 * leg is judged on its own attempted-vs-RECEIVED pair. The ordering of the
 * rules is diagnostic: the causes that explain the whole run come first, so an
 * operator reads one sentence rather than four symptoms.
 *
 * ## `ok` is not the only output, and that is the finding-2 fix
 *
 * A leg with an EMPTY POPULATION is not a failure — paging somebody nightly for
 * a known, accepted, upstream-caused emptiness is how a monitor gets muted, and
 * a muted monitor is how the leg that is ACTUALLY broken goes unseen. But it is
 * not healthy either, and it must not be silence. So `ok` stays true while
 * `legs` names the state and `reason` carries the sentence into `skippedReason`
 * on the job outcome, where it is visible on every run without being an alarm.
 *
 * A run where BOTH legs selected nothing IS a failure: it means the Tiingo
 * instrument sync has never populated `us_instruments` at all, which reads
 * identically to a fully-drained queue unless somebody says so.
 */
export function judgeUsEodHealth(input: UsEodHealthInput): UsEodHealthVerdict {
  const {
    equitySelected,
    equityAttempted,
    equityBars,
    mfSelected,
    mfAttempted,
    mfBars,
    mfSkippedNoPermaTicker,
    fxAttempted,
    fxWritten,
    transportFailures,
    rateLimited,
    accessRefused,
    accessRefusedDetail,
    caAttempted,
    caRows,
    caRefused,
    caRefusedDetail,
  } = input;

  const legs = {
    equity: judgeLegVerdict({
      selected: equitySelected,
      attempted: equityAttempted,
      barsReceived: equityBars,
    }),
    mf: judgeLegVerdict({
      selected: mfSelected,
      attempted: mfAttempted,
      barsReceived: mfBars,
    }),
    ca: judgeCalendarLegVerdict({
      attempted: caAttempted,
      rowsReceived: caRows,
    }),
  } as const;

  // THE CONTROL for every secondary-endpoint 403 below. Legs (a)+(b) hit
  // `/tiingo/daily` with the same token, FIRST; if they received bars the
  // token is confirmed working, and a refusal on another endpoint family is
  // then separable into "entitlement" - which MONEY-980 finding 1 established
  // the status alone never is. See `describeSecondaryRefusal`.
  const priceLegsSawBars = equityBars > 0 || mfBars > 0;

  // ONE refusal branch, because there is one fact to report.
  //
  // This was TWO branches — "TIINGO REJECTED THE TOKEN (403 with a `detail`
  // body)" and "TIINGO ENTITLEMENT REFUSED (403 with an EMPTY body)" — and
  // both sentences claimed to have read a body that never reached this code:
  // the archive seam throws on a non-OK status without reading it, so
  // `classifyTiingoError` was called with an empty string at every site and
  // every 403 took the entitlement arm. The result was an operator being told
  // "this is NOT a token problem" about the one cause that changes between
  // deploys, while the token arm was unreachable (MONEY-980 review, finding 1).
  //
  // The text is the CLIENT's, carried through verbatim, because it is the one
  // declaration that names both causes and both checks. A branch that cannot
  // fire is worse than no branch: it reads as coverage.
  if (accessRefused) {
    return {
      ok: false,
      legs,
      reason:
        accessRefusedDetail ??
        "TIINGO REFUSED THIS RUN (401/403) and the cause is not separable " +
          "here — check BOTH the TIINGO_API_KEY for this environment AND the " +
          "plan's endpoint entitlements. Neither heals on retry.",
    };
  }
  if (rateLimited) {
    return {
      ok: false,
      legs,
      reason:
        `Tiingo rate-limited this run after ${transportFailures} failed ` +
        "call(s); the leg was circuit-broken and the chain deliberately did " +
        "NOT continue (a fresh link re-arms the breaker into the same wall).",
    };
  }
  // BOTH legs' queries ran and BOTH matched nothing. Keyed on `selected`, never
  // on `attempted`: a budget-truncated run also has `attempted === 0`, and
  // telling an operator the instrument sync is empty when it is merely slow
  // sends them to the wrong system.
  if (legs.equity === "noPopulation" && legs.mf === "noPopulation") {
    return {
      ok: false,
      legs,
      reason:
        "NO US INSTRUMENTS SELECTED. `us_instruments` holds no rows matching " +
        "{listingStatus:'ACTIVE'} with an assetType in {Stock, ETF, Mutual " +
        "Fund} — the Tiingo instrument sync has not populated them. This is " +
        "not an idle night.",
    };
  }
  if (legs.equity === "dark") {
    return {
      ok: false,
      legs,
      reason:
        `EOD leg dark: requested ${equityAttempted} symbol(s), received 0 bars ` +
        `(${transportFailures} transport failure(s)).`,
    };
  }
  if (legs.mf === "dark") {
    return {
      ok: false,
      legs,
      reason:
        `NAV leg dark: requested ${mfAttempted} fund(s), received 0 bars. US ` +
        "mutual-fund NAVs publish after 12:00 AM ET and this job runs 11:00 " +
        "IST (00:30 ET under EST, 01:30 under EDT), so the run is PAST the " +
        "publication boundary in both — this is a failure, not a timing miss.",
    };
  }
  // EVERY fund this run reached was unkeyable. The leg is not dark — it fetched
  // and received NAVs — but it stored nothing, and nothing about `mfBars` can
  // say so. Named separately from a dark leg because the remedy is a DIFFERENT
  // JOB: `us-instrument-master-sync`'s search rotation, not Tiingo.
  //
  // The condition is EVERY fund, not any: a partial skip is the expected steady
  // state while that rotation catches up, and failing the run nightly for a
  // known, self-healing backlog is how a monitor gets muted.
  //
  // "EVERY fund" is `mfAttempted === 0`, NOT `skipped >= attempted`. The two
  // counters became DISJOINT in MONEY-1291 (see `mfSkippedNoPermaTicker`), and
  // the old comparison survived the change reading like the sentence it used to
  // be. Measured on the counters this branch's own production fixture emits —
  // 2 keyable funds fetched and written, 2 unkeyable skipped — it failed a run
  // that WORKED, with `legs.mf === "healthy"` and a sentence false in every
  // clause. On a 94%-unkeyable population that is not an edge case, it is most
  // nights.
  //
  // The other direction was worse and silent: an all-unkeyable page has
  // `mfAttempted === 0`, so the old guard could not fire at all and the run
  // reported ok with a `notReached` note blaming the wall clock — for a leg
  // that stored nothing and whose rows were, in fact, stamped.
  //
  // No `legs.mf !== "dark"` term is needed, still, but for a NEW reason: `dark`
  // requires `attempted > 0`, and this branch requires `attempted === 0`, so
  // they cannot both hold. The dark branch above returning first is belt and
  // braces rather than the load-bearing ordering it used to be.
  if (mfAttempted === 0 && mfSkippedNoPermaTicker > 0) {
    return {
      ok: false,
      legs,
      reason:
        `NAV leg wrote NOTHING: all ${mfSkippedNoPermaTicker} fund(s) reached ` +
        "this run were skipped before any request, for want of an " +
        "`UsInstrument.permaTicker` — which `UsFundNav` requires as half of " +
        "its unique key. The symbol is deliberately NOT substituted (tickers " +
        "recycle). Nothing is wrong with Tiingo and nothing is wrong with the " +
        "clock. Fix is upstream: run `us-instrument-master-sync`'s search leg " +
        "until permaTicker is populated for the fund partition.",
    };
  }
  if (fxAttempted > 0 && fxWritten === 0) {
    return {
      ok: false,
      legs,
      reason:
        "FX leg dark: the USDINR rate could not be resolved, so every " +
        "USD-denominated value converts against a stale rate.",
    };
  }
  // MONEY-1309: a `newsFloorRejected` branch stood AHEAD of this one, because
  // the 90-day floor is the failure that does NOT announce itself upstream — a
  // 403 is at least an error, while a pre-floor request is an HTTP 200 carrying
  // rows about the wrong days. That ordering argument is intact and moved with
  // the leg: `tiingo-news-poll` reports its floor rejection ahead of both of
  // its own refusal branches.
  if (caRefused) {
    return {
      ok: false,
      legs,
      reason: describeSecondaryRefusal({
        endpointFamily: "corporate-actions",
        priceLegsSawBars,
        detail: caRefusedDetail ?? null,
      }),
    };
  }
  // A dark secondary leg fails the RUN, and the ~9 nights a year on which that
  // is a US market holiday are paid for deliberately.
  //
  // This file argues the OPPOSITE way about `legIsDark` reading bars RECEIVED
  // rather than bars WRITTEN, and the two are consistent. There, the ~10
  // holiday-night false alarms carried NO diagnostic content at all - the run
  // was structurally correct and there was nothing to go and look at - so
  // firing was pure noise and the fix was to stop firing. Here the alarm
  // arrives with the ex-date it asked about and the holiday named as the first
  // candidate, so an operator settles it in seconds. And the alternative is
  // worse in a way the other case's was not: a whole-market feed allowed to
  // return zero without comment is exactly the reading that hid Tickertape's
  // 403 for five months. `ok:false` costs an ERROR log line and a
  // `skippedReason` on this route; it does not page anyone by itself.
  if (legs.ca === "dark") {
    return {
      ok: false,
      legs,
      reason:
        `CA CALENDAR leg dark: issued ${caAttempted ?? 0} call(s) to ` +
        "/tiingo/corporate-actions and received 0 rows across BOTH the " +
        "distributions and splits routes. A US MARKET HOLIDAY on the target " +
        "ex-date produces this legitimately (~9 nights a year - no holiday " +
        "calendar is consulted anywhere in this job, by design). Anything " +
        "else means the routes are refusing, renamed, or answering an " +
        "ex-date we are not asking about: a typical weekday is 100-400 " +
        "distributions plus 2-5 splits.",
    };
  }
  // MONEY-1309: the `legs.news === "dark"` and `=== "undetermined"` branches
  // went with leg (f). NOTE what "dark" meant for news and how differently the
  // poller has to read it — a whole US SESSION returning zero articles is a
  // failure, because a market-wide day is ~30-400; a two-MINUTE window
  // returning zero is the ordinary case. Porting that branch across unchanged
  // would have failed the run roughly 700 times a day.

  // Healthy RUN, but say out loud what each leg did or could not do. A leg that
  // selected nothing is reported here rather than passing as healthy — the
  // MONEY-980 finding-2 blind spot, and the one state `legIsDark` could not see.
  const notes = [
    describeLeg("EOD", legs.equity),
    describeLeg("NAV", legs.mf),
    describeSecondaryLeg("CA", legs.ca),
    // MONEY-1309: two more notes stood here, both for leg (f) — the offset
    // ceiling and the write deadline. Each was a note rather than a verdict for
    // a reason worth keeping: a truncated day is `healthy` on every count a
    // verdict reads (it fetched, it matched, it wrote), so a completeness gap
    // can only be said BESIDE the verdicts, never inside them.
  ].filter((n): n is string => n !== null);

  return notes.length > 0
    ? { ok: true, legs, reason: notes.join(" ") }
    : { ok: true, legs };
}
