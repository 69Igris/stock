/* =====================================================================
   US instrument master -> `us_instruments` — pure selection + planning
   (MONEY-980, TASK B1)
   ---------------------------------------------------------------------
   Turns Tiingo's `supported_tickers.csv` into the rows `syncUsInstruments`
   writes into `UsInstrument`. No Prisma, no network, no clock — the
   sibling `us-instrument-sync.ts` is the only I/O in the pair.

   ## Why this exists NEXT TO `selectPrimaryListings` rather than replacing it

   They answer two different questions and the answers genuinely differ.

   `selectPrimaryListings` collapses the master to ONE listing per TICKER
   because `InstrumentMapping` is `@@unique([yahooSymbol])` and a US Yahoo
   symbol IS the bare ticker. That is still the right shape for the PRICE
   backfill (`scripts/jobs/tiingo-us-backfill.ts` and the corp-actions
   backfill both use it): `/tiingo/daily/<ticker>/prices` takes no venue
   qualifier and serves only the CURRENT occupant, so one request per
   ticker is the whole fetchable universe.

   This file collapses the master to one row per LISTING ID, because
   `UsInstrument` is `@@unique([listingId])` and `@@index([symbol,
   exchange])` is deliberately NOT unique. The delisted tail is the
   reason the table exists.

   ## What that costs and buys, measured against the live master 2026-08-28

     108,489 rows in the file
      74,217 pass `isUsCoreSecurity` (USD + 8 US venues + Stock/ETF/Fund)
      74,125 distinct listingIds  <- what this file keeps
      72,685 distinct tickers     <- what `selectPrimaryListings` keeps

   So moving to `us_instruments` RECOVERS 1,440 listings that the ticker
   collapse dropped: 1,131 tickers that repeat on ONE venue (genuine
   recycling — `DOW`@NYSE is Dow Chemical 1972-2017 and Dow Inc. 2019-)
   and 330 that repeat across venues, of which only 123 have overlapping
   windows (a real dual listing) and 207 are sequential, i.e. recycling
   one venue-hop away.

   ## What still has to be dropped, and it is NOT zero

   `listingId` is `{symbol}:{exchange}:{startDate}` and the master files
   83 of them MORE THAN ONCE — 92 surplus rows. They are not two
   securities; they are one security with a stale row beside a live one,
   differing by `endDate` (82 of the 83) and sometimes also `assetType`
   (28) — e.g. `APPC`@BATS/2026-06-30 appears as a `Stock` ending
   2026-06-30 and as an `ETF` ending 2026-08-27, and Tiingo's own
   metadata for APPC says "Corgi APP 2x Daily ETF".

   Left alone, an upsert loop would write both to the SAME document and
   the last one wins — so whether `APPC` reads ACTIVE or DELISTED would
   be decided by CSV line order. `selectUsListings` therefore breaks
   every collision with `beatsListing`, the same total order
   `selectPrimaryListings` uses, imported rather than re-derived.

   Six groups contain rows that `beatsListing` cannot separate (`NUR`,
   `CAE`, `CNL`, `GLAS`, `GORO`, `TRLV` — the file simply repeats a line).
   Those are byte-identical in all six columns, so an arbitrary winner
   still produces a DETERMINISTIC stored row, which is the property that
   matters and the one `selectUsListings` is tested for.

   ## The `US_EXCHANGES` filter is gone, on purpose

   `selectPrimaryListings` drops in-scope rows whose venue is missing
   from `US_EXCHANGES`, because that set is what makes a Yahoo symbol
   suffix-free and a US row written `AAPL.NS` collides with a real NSE
   row. `UsInstrument` HAS NO `yahooSymbol` — there is no suffix to get
   wrong — so the filter would be a rule with nothing behind it. The venue
   scope is already `TIINGO_US_EXCHANGES`, enforced by `isUsCoreSecurity`
   one call earlier. (It also happens to drop 0 rows today; that is not
   why it goes.)
   ===================================================================== */

import {
  buildListingId,
  deriveListingStatus,
  isUsCoreSecurity,
  maxEndDate,
  type TiingoMasterRow,
} from "../tiingo/tiingo-logic";
import { beatsListing, isoToDate } from "./tiingo-instruments-logic";

/** One occupancy window, resolved and ready to become a `UsInstrument` row. */
export interface UsListing {
  /** `{symbol}:{exchange}:{startDate}` — the only unique on the model. */
  listingId: string;
  symbol: string;
  exchange: string;
  /**
   * TIINGO'S OWN SPELLING (`Stock` | `ETF` | `Mutual Fund`), not the
   * `EQUITY`/`ETF`/`MF` enum `InstrumentMapping.instrumentType` carries.
   * `UsInstrument.assetType` documents the former and `@@index([assetType,
   * listingStatus])` is read with it, so translating here would put two
   * vocabularies on one column.
   */
  assetType: string;
  listingStatus: "ACTIVE" | "DELISTED";
  /** ISO `YYYY-MM-DD` as the master prints it; converted to Date on write. */
  listingStartDate: string | null;
  listingEndDate: string | null;
}

export interface UsListingStats {
  /** Rows in the master, before any filter. */
  fetched: number;
  /** Rows passing `isUsCoreSecurity`. */
  inScope: number;
  /** Listings kept. Expect `inScope - duplicateListingIdDropped`. */
  kept: number;
  /**
   * Surplus rows discarded because another row carried the SAME listingId.
   * Measured 92 on 2026-08-28 across 83 groups. NOT recycling — see the header.
   */
  duplicateListingIdDropped: number;
  /** listingIds the master filed more than once. */
  duplicateListingIdGroups: number;
  active: number;
  delisted: number;
  /** Distinct tickers among the kept listings. */
  distinctSymbols: number;
  /**
   * Kept listings whose ticker is ALSO held by at least one other kept listing.
   *
   * The number `selectPrimaryListings` used to throw away, reported rather than
   * assumed: these are exactly the rows the ticker collapse could not store,
   * and exactly the rows `/tiingo/daily/<ticker>` will refuse to name (it
   * answers for the CURRENT occupant only). A reader who expects 100% name
   * coverage needs to see this number first.
   */
  recycledListings: number;
  /** The reference date `deriveListingStatus` graded against. */
  fileMaxEndDate: string | null;
  /**
   * listingIds emitted more than once. MUST be empty — the Map key makes it
   * structurally impossible — and it is measured anyway, because "the key
   * guarantees it" stops being true the moment someone changes the key. The
   * unique index would turn a regression here into a write failure, silently
   * counted, on 92 rows a night.
   */
  duplicateListingIds: string[];
}

export interface UsListingSelection {
  listings: UsListing[];
  stats: UsListingStats;
}

/**
 * Collapse the master to ONE row per `listingId`.
 *
 * ## The status reference date comes from the IN-SCOPE rows
 *
 * `deriveListingStatus` grades `endDate` against the newest date PRESENT rather
 * than against today's clock, so a Monday run, a holiday, or a replay of
 * yesterday's archived file cannot mark the whole market delisted. The
 * reference is computed over the rows being graded, NOT over all 108,489: the
 * file also carries CNY, HKD and AUD listings on venues we do not ingest, and a
 * single mis-stamped future date on one of those would silently redefine
 * "active" for the entire US universe.
 *
 * With no in-scope rows there is no reference and nothing to grade, so this
 * returns EMPTY rather than defaulting everything to DELISTED. The caller
 * treats empty as a FAILURE — an empty selection reaching the stale sweep is
 * "every US security delisted at once".
 */
export function selectUsListings(
  rows: readonly TiingoMasterRow[],
): UsListingSelection {
  const stats: UsListingStats = {
    fetched: rows.length,
    inScope: 0,
    kept: 0,
    duplicateListingIdDropped: 0,
    duplicateListingIdGroups: 0,
    active: 0,
    delisted: 0,
    distinctSymbols: 0,
    recycledListings: 0,
    fileMaxEndDate: null,
    duplicateListingIds: [],
  };

  const inScope = rows.filter(isUsCoreSecurity);
  stats.inScope = inScope.length;

  const refDate = maxEndDate(inScope);
  stats.fileMaxEndDate = refDate;
  if (refDate === null || inScope.length === 0) return { listings: [], stats };

  /** listingId -> winning row so far. */
  const winners = new Map<string, TiingoMasterRow>();
  const collided = new Set<string>();
  for (const row of inScope) {
    const id = buildListingId(row.ticker, row.exchange, row.startDate);
    const held = winners.get(id);
    if (!held) {
      winners.set(id, row);
      continue;
    }
    collided.add(id);
    stats.duplicateListingIdDropped++;
    // The SAME total order `selectPrimaryListings` uses. Within a listingId
    // group, symbol / exchange / startDate are equal by construction, so the
    // decision falls to ACTIVE-beats-DELISTED and then to the later `endDate` —
    // which is what separates a stale row from the live one beside it.
    if (beatsListing(row, held, refDate)) winners.set(id, row);
  }
  stats.duplicateListingIdGroups = collided.size;

  const listings: UsListing[] = [];
  const symbolCounts = new Map<string, number>();
  for (const row of winners.values()) {
    const listingStatus = deriveListingStatus(row, refDate);
    if (listingStatus === "ACTIVE") stats.active++;
    else stats.delisted++;
    symbolCounts.set(row.ticker, (symbolCounts.get(row.ticker) ?? 0) + 1);
    listings.push({
      listingId: buildListingId(row.ticker, row.exchange, row.startDate),
      symbol: row.ticker,
      exchange: row.exchange,
      assetType: row.assetType,
      listingStatus,
      listingStartDate: row.startDate,
      listingEndDate: row.endDate,
    });
  }
  stats.kept = listings.length;
  stats.distinctSymbols = symbolCounts.size;
  for (const l of listings) {
    if ((symbolCounts.get(l.symbol) ?? 0) > 1) stats.recycledListings++;
  }

  // Measured, not argued — see the field's comment.
  const seen = new Set<string>();
  for (const l of listings) {
    if (seen.has(l.listingId)) stats.duplicateListingIds.push(l.listingId);
    seen.add(l.listingId);
  }

  return { listings, stats };
}

// ─────────────────────────────────────────────────────────────────────────────
// The write plan
// ─────────────────────────────────────────────────────────────────────────────

/** The columns the diff needs off an existing row. Nothing else is read. */
export interface StoredUsListing {
  listingId: string;
  assetType: string;
  listingStatus: string;
  listingEndDate: Date | null;
}

/** CREATE payload. `name` is deliberately absent — see `planUsInstrumentWrites`. */
export interface UsInstrumentCreateData {
  listingId: string;
  symbol: string;
  exchange: string;
  assetType: string;
  listingStatus: string;
  listingStartDate: Date | null;
  listingEndDate: Date | null;
}

/**
 * UPDATE payload for a row that already exists.
 *
 * Three fields, and the omissions are the point (the MONEY-1093 rule: a nightly
 * writer that guesses reverts a better-informed writer within 24h, with no
 * error).
 *
 *   - `symbol`, `exchange`, `listingStartDate` are the three components of
 *     `listingId`. They cannot change for a given listingId, so writing them
 *     could only ever be a no-op or a corruption.
 *   - `name` is NOT here. The master has no name column; `us-instrument-names`
 *     fills it from `/tiingo/daily/<ticker>`, and a nightly write of `null` or
 *     of the ticker would undo that leg every single night.
 *   - the rotation markers, `cik`, `permaTicker`, `openFIGIComposite` and the
 *     cold/hot ledgers belong to other writers. This one never touches them.
 */
export interface UsInstrumentUpdateData {
  assetType: string;
  listingStatus: string;
  listingEndDate: Date | null;
}

export interface UsInstrumentUpdateGroup {
  /** Every listingId that takes this exact payload. */
  listingIds: string[];
  data: UsInstrumentUpdateData;
}

export interface UsInstrumentWritePlan {
  creates: UsInstrumentCreateData[];
  /**
   * Updates GROUPED by identical payload, so one `updateMany` covers thousands
   * of rows.
   *
   * Not an optimisation for its own sake — it is what keeps this job inside the
   * 600s Pub/Sub ack deadline. Every ACTIVE listing's `listingEndDate` moves on
   * every trading day, so the steady-state night has ~41k updates; as
   * per-row writes at concurrency 10 that is minutes of round trips, and an
   * overrun means Pub/Sub redelivers while the run is still executing. The
   * master's own `endDate` values are bimodal (measured 2026-08-28: 38,480 rows
   * at 2026-08-27 and 27,303 at 2026-08-26 — equities and fund NAVs land a day
   * apart), so the grouping collapses those ~41k writes into a handful of
   * distinct payloads.
   */
  updateGroups: UsInstrumentUpdateGroup[];
  /** Rows whose stored values already match the master. */
  unchanged: number;
  /**
   * Stored rows that are ACTIVE and whose listingId the master no longer
   * carries — the stale-sweep candidates. NOT deleted; see `judgeUsStaleSweep`.
   */
  staleListingIds: string[];
  /** ACTIVE stored rows, the sweep's denominator (INCLUDING the candidates). */
  activeStored: number;
}

/** ISO `YYYY-MM-DD` for a stored Date, or null. Comparison only. */
function isoOf(d: Date | null): string | null {
  if (d === null) return null;
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Diff the master's listings against what is stored.
 *
 * PURE, and that is what makes the write path testable at all: the I/O sibling
 * does one `findMany`, calls this, and carries out exactly what comes back.
 *
 * ## Unchanged rows are not written
 *
 * A row whose three mutable columns already match is skipped rather than
 * re-written. That is not only cheaper — it is what makes `updatedAt` mean
 * something, and it keeps a converged night's write count near zero so a
 * NON-zero one is readable.
 */
export function planUsInstrumentWrites(
  listings: readonly UsListing[],
  stored: readonly StoredUsListing[],
): UsInstrumentWritePlan {
  const plan: UsInstrumentWritePlan = {
    creates: [],
    updateGroups: [],
    unchanged: 0,
    staleListingIds: [],
    activeStored: 0,
  };

  const byId = new Map<string, StoredUsListing>();
  for (const s of stored) {
    byId.set(s.listingId, s);
    if (s.listingStatus === "ACTIVE") plan.activeStored++;
  }

  /** payload signature -> group, so one updateMany serves every row in it. */
  const groups = new Map<string, UsInstrumentUpdateGroup>();
  const seenInMaster = new Set<string>();

  for (const l of listings) {
    seenInMaster.add(l.listingId);
    const existing = byId.get(l.listingId);
    if (!existing) {
      plan.creates.push({
        listingId: l.listingId,
        symbol: l.symbol,
        exchange: l.exchange,
        assetType: l.assetType,
        listingStatus: l.listingStatus,
        listingStartDate: isoToDate(l.listingStartDate) ?? null,
        listingEndDate: isoToDate(l.listingEndDate) ?? null,
      });
      continue;
    }

    if (
      existing.assetType === l.assetType &&
      existing.listingStatus === l.listingStatus &&
      isoOf(existing.listingEndDate) === l.listingEndDate
    ) {
      plan.unchanged++;
      continue;
    }

    const data: UsInstrumentUpdateData = {
      assetType: l.assetType,
      listingStatus: l.listingStatus,
      listingEndDate: isoToDate(l.listingEndDate) ?? null,
    };
    // NUL as the separator, spelled as an ESCAPE and never as the byte: a
    // literal NUL makes this file BINARY to git, so it gets no diff in
    // `git diff`, `gh pr diff` or a code review, and the file would ship
    // unreviewed. It is the right separator -- no assetType, status or ISO
    // date can contain it, so two distinct payloads cannot collide on one
    // key and have one written with the other's data. Only the spelling was
    // wrong, and it was wrong here once before on this branch
    // (`us-eod-sync.ts`).
    const key = `${l.assetType}\u0000${l.listingStatus}\u0000${l.listingEndDate ?? ""}`;
    const group = groups.get(key);
    if (group) group.listingIds.push(l.listingId);
    else groups.set(key, { listingIds: [l.listingId], data });
  }

  plan.updateGroups = [...groups.values()];

  for (const s of stored) {
    if (s.listingStatus === "ACTIVE" && !seenInMaster.has(s.listingId)) {
      plan.staleListingIds.push(s.listingId);
    }
  }

  return plan;
}

// ─────────────────────────────────────────────────────────────────────────────
// The stale sweep
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A listing the master stopped publishing is flipped to DELISTED — never
 * deleted, and never below these bounds.
 *
 * ## Why DELISTED and not a delete
 *
 * `Candle.listingId` points at this row. Deleting it orphans a security's whole
 * price history behind an id nothing resolves, and `us_instruments` is a
 * REFERENCE collection synced prod -> QA, so the deletion would propagate.
 * Flipping the status keeps the row and its candles readable, removes it from
 * the EOD job's ACTIVE population (so we stop spending metered requests on a
 * ticker that will 404), and REVERSES ITSELF: if the listing reappears in the
 * master, the next run's diff writes ACTIVE straight back.
 *
 * ## Why a vanish is not the same fact as a delisting
 *
 * Worth stating because the two look alike and are handled differently.
 * `deriveListingStatus` already marks a security DELISTED from its `endDate`
 * WHILE IT IS STILL IN THE FILE — 31,314 of the 74,125 listings are in exactly
 * that state. A row VANISHING is a different event: Tiingo withdrew coverage.
 * We cannot price it either way, so the stored status is the same; the counters
 * are separate so the two are never confused in a log.
 */
export const MAX_US_STALE_RATIO = 0.1;
export const US_STALE_FLOOR = 50;

export interface UsStaleSweepVerdict {
  proceed: boolean;
  /** Present when refused; names the numbers so the log is self-explaining. */
  reason?: string;
}

/**
 * Refuse a sweep that is too large to be a delisting event.
 *
 * Mirrors `judgeDeactivationSweep` deliberately, including the floor and the
 * incoherent-population arm. The failure it exists for is different in origin
 * and identical in shape: there, a provider run with the wrong exchange scope;
 * here, a master fetch that returned a TRUNCATED file. Both produce a plausible
 * run that quietly retires most of the universe.
 *
 * Refusing beats sweeping-and-alerting for the reason the India version gives:
 * reversing a sweep means knowing which rows this run flipped, and once the
 * status is written that set is gone.
 */
export function judgeUsStaleSweep(input: {
  /** Rows this sweep would flip DELISTED. */
  candidates: number;
  /** ACTIVE stored rows, INCLUDING the candidates. */
  activePopulation: number;
}): UsStaleSweepVerdict {
  const { candidates, activePopulation } = input;
  if (candidates <= 0) return { proceed: true };

  // Below the floor, a proportion says nothing useful — a five-row fixture
  // losing two rows is 40% and entirely fine.
  if (candidates < US_STALE_FLOOR) return { proceed: true };

  // A zero population with candidates is incoherent: the candidates came FROM
  // it. Treat it as a failure to measure, not as a ratio of infinity.
  if (activePopulation <= 0) {
    return {
      proceed: false,
      reason:
        `refusing to retire ${candidates} US listing(s): the active ` +
        "population measured 0, which cannot be true when the candidates " +
        "came from it",
    };
  }

  const ratio = candidates / activePopulation;
  if (ratio > MAX_US_STALE_RATIO) {
    return {
      proceed: false,
      reason:
        `refusing to retire ${candidates} of ${activePopulation} active US ` +
        `listing(s) (${(ratio * 100).toFixed(1)}%, ceiling ` +
        `${(MAX_US_STALE_RATIO * 100).toFixed(0)}%). A sweep this large is a ` +
        "truncated or partially-parsed supported_tickers.zip, not a delisting " +
        "event — check the master's row count and the feed archive before " +
        "re-running.",
    };
  }
  return { proceed: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// The kill switch
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `US_MASTER_SYNC` — the off switch for the master leg (MONEY-980, TASK B2).
 *
 * ## Why it had to exist
 *
 * Before this there was NO way to stop the US master job in an environment
 * short of unsetting `TIINGO_API_KEY`, which kills every Tiingo path in the
 * repo — EOD prices, corporate actions, news, the search enricher — to disable
 * one leg. `EDGAR_CIK_ENRICH` and `TIINGO_SEARCH_ENRICH` gate their own
 * enrichers; the leg that performs the full 74k-row upsert AND the stale sweep
 * had no gate at all.
 *
 * ## Compared against the LITERAL string, never `Boolean()`
 *
 * `Boolean("false")` is `true`. Coercing here would arm the job in precisely
 * the configuration meant to keep it off — the mistake `XBRL_PROJECTION_APPLY`
 * and `resolveTiingoPlan` both carry a comment about.
 *
 * ## Absent means ON, and "off" is the only value that disables
 *
 * Matching `EDGAR_CIK_ENRICH`'s existing semantics, so an operator does not
 * have to remember which of two spellings this one uses. The env var ships
 * PRESENT-and-`"off"` in `workers/cloudbuild.prod.yaml` rather than being left
 * out, because absent and "off" must not be the same state on the deploy side:
 * "absent" is exactly how `MF_METADATA_PROVIDER` disabled its job silently for
 * months (MONEY-1214).
 *
 * Read PER CALL, never captured in a module const — a module-scope read freezes
 * at import, so a worker that loads config after boot (or a test that sets the
 * env afterwards) silently gets the default. That exact bug is documented on
 * `bse-client.ts`'s retry config.
 */
export function isUsMasterSyncEnabled(
  raw: string | undefined = process.env.US_MASTER_SYNC,
): boolean {
  return raw?.trim().toLowerCase() !== "off";
}
