/* =====================================================================
   US company names — pure parse + attribution  (MONEY-980, TASK B3)
   ---------------------------------------------------------------------
   `supported_tickers.zip` has SIX columns —
   `ticker,exchange,assetType,priceCurrency,startDate,endDate` — and NONE
   of them is a name. `UsInstrument.name` therefore starts null on every
   one of the 74,125 rows the master creates, and this leg fills it from
   `https://api.tiingo.com/tiingo/daily/<ticker>`.

   It is load-bearing rather than cosmetic. Delisted listings are
   user-visible in search (31,314 of the 74,125), and a result reading
   `HOS` with no company name is not findable by anyone who does not
   already know it is Hornbeck Offshore Services.

   No I/O here: `us-instrument-names.ts` is the fetch and the rotation.

   ## What the endpoint actually returns (probed 2026-08-28, live token)

   The key set is exactly
   `{ticker, name, description, startDate, endDate, exchangeCode}` — the
   same six on every 200 measured. `permaTicker` is NOT among them.

     AAPL      200  "Apple Inc"                      1980-12-12  NASDAQ
     VFIAX     200  "VANGUARD 500 INDEX ..."         2000-11-13  NMFQS
     HOS       200  "Hornbeck Offshore Services Inc" 2004-03-26  NYSE
     CTEST-I   200   name: null                      2019-07-25  NYSE
     LEH       200  "LEHMAN BROTHERS HOLDINGS INC"   null        null
     ENE       404  {"detail":"Not found."}

   Three things follow, and each one is a rule below rather than a hope:

   1. **`name` CAN BE NULL on a 200.** `CTEST-I` is an exchange test
      ticker. A parser that trusted the field would write `"null"` or
      `""` into a column whose null-ness is the signal search ranks on.
   2. **Mutual funds and DELISTED securities are named.** The leg is
      worth running over the whole table, not only the live equities.
   3. **A 404 is a real answer** ("no such security"), not a broken
      endpoint — `fetchExchangeAsset` already maps it to `null`.

   ## THE HAZARD: the endpoint answers for the CURRENT occupant only

   This is the same trap `resolveSearchMatch` and the EDGAR CIK join are
   both written against, and here it is sharper because `us_instruments`
   DELIBERATELY stores the predecessors that `instrument_mappings` could
   not hold.

     DOW  -> "Dow Inc",                startDate 2019-03-20, NYSE
     BRKL -> "Corgi BRKB 2x Daily ETF", startDate 2026-07-07, BATS

   The master holds `DOW:NYSE:1972-06-01` (Dow Chemical) and
   `BRKL:NASDAQ:1998-03-25` (Brookline Bancorp) as well. Writing the
   response's name onto those rows labels a 45-year-old chemicals company
   "Dow Inc" — silently, and indistinguishably from correct data.

   ## The corroboration key is `startDate`, and ONLY `startDate`

   Measured over 38 probed tickers covering 57 master rows:

     37/38  the metadata `startDate` matched EXACTLY ONE master row
     37/37  ... and `exchangeCode` agreed with that row's exchange
      1/38  matched two rows — `CCSI`, which is a duplicate-listingId
             group that `selectUsListings` collapses to one row before
             the database ever sees it
      0/38  matched no row

   `endDate` is NOT usable and the same measurement is why: it disagreed
   on 7 of 37 rows (e.g. `BUPXX` master 2026-08-26 against metadata
   2026-08-27 — fund NAVs and equity closes land a day apart, and the two
   sources snapshot at different moments). A corroboration key that is
   wrong 19% of the time would have made this leg inert, which is exactly
   the failure `edgar-cik-logic.ts`'s header records the BSE enricher
   shipping: a check copied without measuring rejected every row while
   the job looked healthy.
   ===================================================================== */

/** One `/tiingo/daily/<ticker>` metadata response, after a tolerant parse. */
export interface TiingoDailyMetadata {
  ticker: string;
  /** Null on a real 200 — see `CTEST-I` in the header. */
  name: string | null;
  /** ISO `YYYY-MM-DD`, or null (measured null for `LEH`). */
  startDate: string | null;
  endDate: string | null;
  exchangeCode: string | null;
}

/**
 * The stored row a name is being attributed to. Three fields, all of which the
 * rotation query already selects.
 */
export interface UsNameTarget {
  symbol: string;
  exchange: string;
  /** ISO `YYYY-MM-DD` — the third component of `listingId`. */
  listingStartDate: string | null;
}

export type UsNameResolution =
  | { kind: "resolved"; name: string }
  /** A 200 that carried no usable name. An ANSWER, not a failure. */
  | { kind: "unnamed" }
  /** The response describes a DIFFERENT occupancy of this ticker. */
  | { kind: "not-this-listing"; reason: string }
  /** Nothing to corroborate against, so nothing is written. */
  | { kind: "unverifiable"; reason: string };

/**
 * Decide whether this metadata response may name this stored listing.
 *
 * Refusing is the whole point. Every arm below that is not `resolved` leaves
 * the column null, and a null name is a distinction search can act on ("rank
 * this last"). A WRONG name is not recoverable by any later run, because
 * nothing downstream can tell it from a right one.
 *
 * ## Why an absent metadata `startDate` refuses rather than writes
 *
 * `LEH` answers 200 with a real name and null dates, which looks like the exact
 * case this leg exists for. It is not reachable from our population: `LEH` is
 * NOT IN `supported_tickers.zip` at all (checked — the file has seven
 * `LEH`-prefixed tickers and no `LEH` row), so no `UsInstrument` row exists for
 * it. Every one of the 38 probed tickers that IS in the master carried a
 * startDate.
 *
 * So the null-startDate branch is, on today's data, unreachable — and the
 * conservative arm costs nothing. Writing anyway would need proof that the
 * ticker holds exactly ONE listing, which is a per-row COUNT query against a
 * non-unique index, on a leg that already spends one metered HTTP request per
 * row. If `unverifiable` ever reads large in production, that count is the fix;
 * until then it would be machinery for a case that does not occur.
 */
export function resolveUsListingName(
  target: UsNameTarget,
  meta: TiingoDailyMetadata,
): UsNameResolution {
  const want = target.symbol.trim().toUpperCase();
  const got = meta.ticker.trim().toUpperCase();
  if (want !== got) {
    return {
      kind: "not-this-listing",
      reason: `asked for ${want}, response is for ${got}`,
    };
  }

  const name = meta.name?.trim() ?? "";
  if (name === "") return { kind: "unnamed" };

  if (target.listingStartDate === null) {
    return {
      kind: "unverifiable",
      reason: "the stored listing has no start date to corroborate against",
    };
  }
  if (meta.startDate === null) {
    return {
      kind: "unverifiable",
      reason: `metadata for ${want} carries no startDate`,
    };
  }
  if (meta.startDate !== target.listingStartDate) {
    return {
      kind: "not-this-listing",
      reason:
        `metadata for ${want} starts ${meta.startDate}, this listing starts ` +
        `${target.listingStartDate} — the endpoint answers for the CURRENT ` +
        `occupant of a ticker`,
    };
  }

  // Corroboration, not identity: absent is fine (LEH-shaped), disagreeing is
  // not. `endDate` is deliberately NOT checked — see the header measurement.
  const venue = meta.exchangeCode?.trim() ?? "";
  if (venue !== "" && venue !== target.exchange) {
    return {
      kind: "not-this-listing",
      reason:
        `metadata for ${want} is on ${venue}, this listing is on ` +
        `${target.exchange}`,
    };
  }

  return { kind: "resolved", name };
}

/**
 * Tolerant parse: a malformed body is `null`, never a throw.
 *
 * `ticker` is the only REQUIRED field, because it is the one this module
 * compares against what was asked for. Everything else may legitimately be
 * null on a live 200.
 */
export function parseTiingoMetadata(text: string): TiingoDailyMetadata | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.ticker !== "string" || r.ticker.trim() === "") return null;

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;

  return {
    ticker: r.ticker,
    name: str(r.name),
    startDate: str(r.startDate),
    endDate: str(r.endDate),
    exchangeCode: str(r.exchangeCode),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sizing — the 600s deadline, the metered quota, and the convergence sum
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rows the NAME leg may visit in one run.
 *
 * ## The arithmetic, stated rather than implied
 *
 * `paceTiingoRequest` spreads requests evenly at `3_600_000 / perHour` ms.
 * On COMMERCIAL (20,000/hr — the default, and what both cloudbuild specs set)
 * that is **180 ms per request**, so:
 *
 *     1,200 rows x 180 ms = 216 s   this leg
 *       800 rows x 180 ms = 144 s   the search leg, in the same job
 *     ------------------------------
 *                          360 s   < US_ENRICH_BUDGET_MS (420 s)
 *
 * The page is the binding constraint at nominal pacing and the wall-clock
 * budget is the guard against a slow night; neither alone is enough. Both legs
 * get a page rather than one leg getting the whole run, so a converging NAME
 * backfill cannot starve the search enricher for a week.
 *
 * ## Convergence
 *
 * `US_ENRICH_MAX_CHAIN_DEPTH` is the number of RUNS a trigger produces, not the
 * number of follow-ups: `shouldChainUsEnrichment` refuses once `chainDepth + 1`
 * would REACH it, so depths 0..6 execute and depth 6 publishes nothing. Seven
 * runs a night:
 *
 *     7 x 1,200 =  8,400 names/night   -> 74,125 / 8,400 =  9 nights
 *     7 x   800 =  5,600 search/night  -> 41,371 / 5,600 =  8 nights
 *
 * against a population of 74,125 listings (72,685 distinct tickers, 41,371
 * ACTIVE). Total metered spend 14,000/night on top of `us-eod-sync`'s ~41,371,
 * i.e. ~55k of COMMERCIAL's 150,000/day ceiling.
 *
 * ## The steady state is much cheaper than the fill, and deliberately so
 *
 * A visited row is stamped whether or not it produced a write, so the rotation
 * always advances; but the CALL is skipped for a row that already has a name
 * AND is DELISTED. A delisted security cannot rename, so re-asking is spend
 * with no possible new information. ACTIVE rows keep being re-fetched, which is
 * what keeps a renamed live company current — 41,371 requests per ~8-night
 * cycle, ~5,200/night.
 *
 * ## The ceiling is NOT 74,125
 *
 * 1,440 listings share a ticker with another listing, and `/tiingo/daily/` only
 * ever answers for the current occupant, so at most 72,685 rows can ever be
 * named. `notThisListing` counts the rest; a reader expecting 100% coverage
 * needs that number, not a bug report.
 */
export const US_NAME_PAGE_SIZE = 1_200;

/** Rows the permaTicker SEARCH leg may visit in one run. See above. */
export const US_SEARCH_PAGE_SIZE = 800;

/**
 * No new item is STARTED past this point in a run.
 *
 * 600 s is the Pub/Sub ack deadline (its maximum, not a setting) and running
 * past it is not a slow job — the message is redelivered and a SECOND copy runs
 * concurrently. The check is BETWEEN items, so the true wall is
 * `budget + one item`:
 *
 *    420 s  budget
 *   -----
 *    180 s  headroom, absorbing
 *      ~30 s  the one request in flight (30 s `EXCHANGE_FETCH_TIMEOUT_MS`);
 *             a full 4-attempt ladder is longer, and is why the headroom is
 *             not sized to a single nominal call
 *       ~2 s  the two `findMany`s and the chain publish
 *
 * Same 420 s as `stock-document-extract` and `mf-nav-backfill`, for the same
 * reason and with more headroom to spare: a metadata body is ~1 KB against that
 * job's multi-MB PDFs.
 */
export const US_ENRICH_BUDGET_MS = 420_000;

/**
 * Hard ceiling on how many times one trigger may re-publish itself.
 *
 * THE TERMINATION PROOF LIVES HERE and does not depend on the database: every
 * chained message carries `chainDepth + 1` and `shouldChainUsEnrichment`
 * refuses once the NEXT depth would reach this value. So a chain is at most
 * `US_ENRICH_MAX_CHAIN_DEPTH` messages long no matter what the tables do. Every
 * other condition can only stop it SOONER.
 *
 * Sized 7 (= 7 runs, depths 0..6) by the CLOCK, not by the queue. The prod
 * trigger is `0 10 * * 2-6` and `us-eod-sync` fires at 11:00 against the SAME
 * metered account; `paceTiingoRequest` is per-process module state, so two jobs
 * running concurrently on different Cloud Run instances pace independently and
 * the effective rate doubles. 7 x 420 s = 49 min is the worst case and lands
 * before 11:00 with the two jobs disjoint (nominal pacing is 7 x 360 s =
 * 42 min). A deeper chain would converge a night sooner and spend the saving on
 * a rate ceiling nobody can observe — Tiingo publishes no quota headers, so a
 * 429 is the only feedback and it arrives too late to steer by.
 */
export const US_ENRICH_MAX_CHAIN_DEPTH = 7;

/**
 * Sanitise the `chainDepth` carried on an inbound Pub/Sub message.
 *
 * The value arrives as `unknown`: a missing, negative, fractional, NaN or
 * absurd value must not be able to buy extra links. Anything that is not a
 * finite non-negative number reads as depth 0, and anything above the ceiling
 * is CLAMPED to it — so a forged large value ENDS the chain rather than
 * wrapping it.
 */
export function normalizeUsChainDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(Math.floor(value), US_ENRICH_MAX_CHAIN_DEPTH);
}

/** Inputs to the self-chain decision. All observed, none inferred. */
export interface UsEnrichmentChainInput {
  /** This run's depth (0 for a scheduler trigger). */
  chainDepth: number;
  /** Rows the NAME leg pulled this run. */
  nameSelected: number;
  /** The `take` the NAME leg used. */
  namePageSize: number;
  /** Rows the SEARCH leg pulled this run. */
  searchSelected: number;
  /** The `take` the SEARCH leg used. */
  searchPageSize: number;
}

/**
 * Should this run publish a follow-up?
 *
 * Only when the ceiling allows AND at least one leg filled its page — a leg
 * that came back short has drained its rotation for tonight, and two short legs
 * mean there is nothing left to chain FOR.
 *
 * Note what is deliberately NOT a condition: "rows were written". These legs
 * converge, so a fully-converged night writes ZERO and must still advance the
 * rotation. Making progress the chain condition would stop the job the moment
 * it finished its job.
 *
 * A page-filling leg is not proof of remaining work either — the rotation could
 * have selected the last exact page — but it can only cost ONE extra empty run,
 * and the depth ceiling bounds the whole thing regardless.
 */
export function shouldChainUsEnrichment(
  input: UsEnrichmentChainInput,
): boolean {
  if (input.chainDepth + 1 >= US_ENRICH_MAX_CHAIN_DEPTH) return false;
  return (
    input.nameSelected >= input.namePageSize ||
    input.searchSelected >= input.searchPageSize
  );
}

/**
 * Split one run's wall-clock budget between the two paced legs.
 *
 * ## Why a split at all, rather than "names first, then whatever is left"
 *
 * Because sequential draining starves the loser for a whole convergence cycle.
 * The NAME leg is the one with 74,125 rows to fill; run it to exhaustion first
 * and the permaTicker enricher gets zero rows a night for nine nights, while
 * every log line reads normally. That is the shape this repo keeps paying for
 * — a leg that reports healthy because it was never given anything to do.
 *
 * ## Why it is proportional to the PAGE SIZES and not 50/50
 *
 * So the split and the pages cannot disagree. At nominal COMMERCIAL pacing
 * (180 ms/request) a full page costs 216 s for names and 144 s for search; the
 * proportional deadlines are 252 s and 420 s, which sit just above each. Both
 * legs therefore finish their page on a normal night and the budget only bites
 * when the upstream is slow — which is exactly when it should.
 *
 * ## The deadlines are ABSOLUTE against the JOB's start, not the leg's
 *
 * The 600 s Pub/Sub ack clock starts when the message is delivered, not when
 * the enrichment does. On a depth-0 run the master upsert and the EDGAR join
 * have already spent part of it, so the enrichers correctly get less. A budget
 * measured from each leg's own start would be a budget that grows with
 * everything that ran before it, which is how a run overshoots the deadline and
 * gets redelivered while still executing.
 */
export function usEnrichmentDeadlines(startedAtMs: number): {
  nameDeadlineAtMs: number;
  searchDeadlineAtMs: number;
} {
  const total = US_NAME_PAGE_SIZE + US_SEARCH_PAGE_SIZE;
  const nameShare = Math.round(
    (US_ENRICH_BUDGET_MS * US_NAME_PAGE_SIZE) / total,
  );
  return {
    nameDeadlineAtMs: startedAtMs + nameShare,
    searchDeadlineAtMs: startedAtMs + US_ENRICH_BUDGET_MS,
  };
}
