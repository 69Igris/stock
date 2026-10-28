/**
 * US instrument master -> `us_instruments` — the I/O half (MONEY-980, TASK B1).
 *
 * Reads Tiingo's daily `supported_tickers.zip` and writes `UsInstrument`. All
 * selection, diffing and sweep judgement is pure and lives in
 * `us-instrument-sync-logic.ts`; this file is the fetch, the Prisma calls and
 * the counters, nothing else.
 *
 * ## This is NOT an `InstrumentProvider`, and that is the whole point
 *
 * It used to be — `TiingoInstrumentProvider` rode `syncInstruments()` and wrote
 * the US universe into `instrument_mappings` beside India's. That is gone, for
 * three reasons that are worth keeping written down because the pull to merge
 * the two tables again will recur:
 *
 *   1. `instrument_mappings` has 143 read sites and 37 of them are India-facing
 *      with NO venue clause. Three are nightly jobs — `refreshAllQuotes`,
 *      `runHistoricalBackfill`, `peers-sync` — that select `{isActive: true}`
 *      across the whole table and would have swept ~23k US tickers into Yahoo,
 *      writing a SECOND US price series beside `candles`. None of those readers
 *      is buggy; they were correct for every row that table held for two years.
 *   2. `deactivateStaleInstruments` scopes itself
 *      `exchangeFilter?.length ? {exchange: {in}} : {}`. ONE forgotten argument
 *      retires the other market's entire universe, with a 10% ratio breaker as
 *      the only backstop and a `COMPLETED` sync log either way. Two collections
 *      make that call unable to see a US row AT ALL — safe by construction
 *      rather than safe by remembering, which is the only kind that survives a
 *      year of edits.
 *   3. `instrument_mappings` is `@@unique([yahooSymbol])` and a US Yahoo symbol
 *      IS the bare ticker, so it could hold ONE row per ticker. That forced the
 *      selection to drop 1,440 repeated listings — the recycled and delisted
 *      tail this backbone exists to hold.
 *
 * Point 2 is verified rather than asserted: `deactivateStaleInstruments` reads
 * `prisma.instrumentMapping` and this file never writes to it. There is no
 * argument to forget.
 *
 * ## Why the write path is `createMany` + grouped `updateMany`, not upserts
 *
 * The 600s Pub/Sub ack deadline. 74,125 individual upserts at concurrency 10 is
 * minutes of round trips, and an overrun is not a slow run — Pub/Sub redelivers
 * and a SECOND copy of the job starts concurrently. So the run does one
 * `findMany`, diffs in memory, and issues a bounded number of bulk statements.
 * See `UsInstrumentWritePlan.updateGroups` for why grouping collapses the
 * steady-state ~41k daily updates into a handful of statements.
 */

import { prisma } from "@usemoney/database";

import { fetchSupportedTickers } from "../tiingo/tiingo-client";
import { findPhantomWindows } from "../databento/databento-symbology";
import {
  isUsMasterSyncEnabled,
  judgeUsStaleSweep,
  planUsInstrumentWrites,
  selectUsListings,
  type StoredUsListing,
  type UsListingStats,
} from "./us-instrument-sync-logic";

/**
 * Rows per bulk statement.
 *
 * `createMany` is one round trip per chunk, so the chunk is sized for the
 * DOCUMENT payload rather than for latency: 1,000 `UsInstrument` documents is
 * well under Mongo's 16 MB command limit at ~150 bytes each. `updateMany`
 * carries a `listingId: {in: [...]}` array instead, and a very large `$in` is
 * the shape that has bitten this repo before — `deactivateStaleInstruments`
 * chunks its own id list at 200 for exactly that reason — so the update chunk
 * stays conservative.
 */
const CREATE_CHUNK = 1_000;
const UPDATE_CHUNK = 500;

/**
 * Wall clock for the write half of the reconcile.
 *
 * This leg had NO time bound at all, and it is the one that needs it most: the
 * first armed run creates 74,125 rows through ~75 `createMany` chunks and then
 * issues up to ~10k grouped `updateMany`s, inside a Pub/Sub push subscription
 * whose ack deadline is 600s. An overrun is not slowness — Pub/Sub REDELIVERS,
 * so a second copy of the reconcile runs CONCURRENTLY with the first, and the
 * two race on `@@unique([listingId])` while each records the loser's chunk as
 * `failed`.
 *
 * Concurrency limits cannot express this (that is the `edgar-cik.ts` note: a
 * throughput control is not a deadline), and neither can a chunk size — which
 * is the rule this repo states at length for every other job.
 *
 * ## Why 120s and not 420s
 *
 * This was 420s, documented as "leaves 180s for the fetch that precedes the
 * loops, the sweep, and the two enricher legs that follow". That reserve did
 * not exist, and the arithmetic is worth writing out because the number LOOKED
 * like every other 420s in this repo:
 *
 * The two enricher legs do NOT run after a reserve carved out of this budget.
 * They hold ABSOLUTE deadlines against the JOB's start —
 * `usEnrichmentDeadlines(startedAtMs)` returns `startedAtMs + 252s` for names
 * and `startedAtMs + 420s` for the permaTicker search — and this leg is called
 * at the top of the same depth-0 run, so its window is the SAME window, not one
 * in front of it. At 420s a master run that used its budget crossed both
 * deadlines before either enricher started; each then selected its page, found
 * the clock already past, wrote nothing, and reported
 * `namesWritten=0 transportFailures=0` — a leg that reads healthy because it
 * was never given anything to do, which is the exact shape
 * `usEnrichmentDeadlines`'s own doc-comment argues against.
 *
 *   600s   Pub/Sub ack deadline
 *  -120s   this budget: fetch + `findMany` + both bulk loops + the sweep
 *  -132s   what is left of the name leg's absolute 252s share
 *  -168s   the search leg's slice, 252s -> 420s
 *  ------
 *   180s   headroom — one in-flight chunk, one in-flight metered request
 *          (30s `EXCHANGE_FETCH_TIMEOUT_MS`), the chain publish.
 *
 * 120s is a budget this leg does not normally approach: one archived public zip
 * (undated, `current/`), one projected `findMany`, ~75 `createMany` chunks on
 * the first armed run and a handful of grouped `updateMany`s thereafter. A run
 * that genuinely needs longer TRUNCATES — which is designed for, defers the
 * sweep, reports `remaining`, and re-proposes the identical diff tomorrow —
 * instead of silently zeroing both enrichers for the night.
 *
 * The deeper fix is NOT here and is deliberately not done here: the enrichers
 * should divide what REMAINS of the 600s at the moment enrichment starts,
 * rather than a fixed proportion of a window that something else has already
 * spent. That is `usEnrichmentDeadlines` in `us-instrument-names-logic.ts`
 * (one extra `nowMs` argument, the ceiling staying absolute against the job's
 * start), and the constant here is sized so the current split is HONEST in the
 * meantime rather than so the bug is hidden.
 *
 * Checked BETWEEN chunks, so the true wall is the budget plus one chunk.
 */
export const US_SYNC_WRITE_BUDGET_MS = 120_000;

export interface UsInstrumentSyncResult {
  /** Selection counters, or null when the leg did not run. */
  stats: UsListingStats | null;
  /** Rows created this run. */
  created: number;
  /** Rows updated this run. */
  updated: number;
  /**
   * Rows a bulk statement could not write.
   *
   * REAL, not decorative. Each chunk is wrapped so one rejected statement costs
   * its own rows and not the whole reconcile — and the count is the chunk's
   * SIZE, which is the honest number: a rejected `createMany`/`updateMany`
   * writes nothing, and Prisma does not report which member offended.
   *
   * The alternative was a field that no code path could ever set to non-zero,
   * which is exactly the defect `InstrumentSyncResult.deactivated` carried for
   * the life of that field — documented as "the number that makes the
   * catastrophic failure visible" while being structurally pinned at 0.
   */
  failed: number;
  /** Rows whose stored values already matched. */
  unchanged: number;
  /**
   * MONEY-1617 — master windows of five days or less overlapping a longer
   * window of the same symbol on the same venue (`isPhantomWindow`). FLAGGED,
   * never deleted: the resolver every candle writer and the lake gate route
   * through gives the longer window any session both cover.
   */
  phantomWindows: number;
  /** ACTIVE stored rows the master no longer carries. */
  staleCandidates: number;
  /** Of those, the number actually flipped DELISTED. */
  retired: number;
  /** Present when the ratio breaker refused the sweep. */
  sweepRefusedReason?: string;
  /** True when US_MASTER_SYNC=off — a deliberate skip, not a failure. */
  disabled: boolean;
  /**
   * The write loops stopped on the run budget with work still planned.
   *
   * NOT an error, and NOT the same as `failed`: nothing was rejected, we simply
   * ran out of clock. The reconcile is a full diff against a freshly fetched
   * master, so the next run re-proposes exactly what did not land — but a
   * caller that cannot tell "reconciled 74,125" from "reconciled 20,000 and
   * stopped" has no way to know the table is still converging.
   */
  truncated: boolean;
  /** Rows still planned when the budget ran out. 0 unless `truncated`. */
  remaining: number;
}

/**
 * Fetch the master and reconcile `us_instruments` against it.
 *
 * THROWS on an upstream or parse failure. That is deliberate and the opposite
 * of the two enrichers next door: an enricher that throws costs a column, and
 * this leg IS the job — a caller that cannot tell a dark master from a healthy
 * no-op has no signal at all (the `providerTransportFailures` argument in
 * `workers/src/processors/us-instrument-master-sync.ts`).
 */
export async function syncUsInstruments(opts?: {
  /** Absolute epoch-ms deadline for the write loops. Injected so it is testable. */
  deadlineAt?: number;
  /** Clock injection — never read the wall clock directly in a bounded loop. */
  now?: () => number;
}): Promise<UsInstrumentSyncResult> {
  const now = opts?.now ?? Date.now;
  const deadlineAt = opts?.deadlineAt ?? now() + US_SYNC_WRITE_BUDGET_MS;
  const result: UsInstrumentSyncResult = {
    stats: null,
    created: 0,
    updated: 0,
    truncated: false,
    remaining: 0,
    failed: 0,
    unchanged: 0,
    phantomWindows: 0,
    staleCandidates: 0,
    retired: 0,
    disabled: false,
  };

  if (!isUsMasterSyncEnabled()) {
    result.disabled = true;
    console.warn(
      "[us-instrument-sync] disabled by US_MASTER_SYNC=off — the master " +
        "upsert AND the stale sweep are both skipped",
    );
    return result;
  }

  const rows = await fetchSupportedTickers();
  const { listings, stats } = selectUsListings(rows);
  result.stats = stats;

  console.log(
    `[us-instrument-sync] master: ${stats.fetched} rows -> ${stats.inScope} ` +
      `US core -> ${stats.kept} listings ` +
      `(${stats.active} active / ${stats.delisted} delisted; ` +
      `${stats.distinctSymbols} distinct tickers, ` +
      `${stats.recycledListings} on a shared ticker; dropped ` +
      `${stats.duplicateListingIdDropped} duplicate-listingId rows across ` +
      `${stats.duplicateListingIdGroups} groups)`,
  );

  // Structurally impossible under the Map key, measured anyway: a regression
  // here does not throw, it silently fails 92 writes a night on
  // @@unique([listingId]).
  if (stats.duplicateListingIds.length > 0) {
    console.warn(
      `[us-instrument-sync] ${stats.duplicateListingIds.length} listingIds ` +
        `were emitted more than once — every duplicate past the first WILL ` +
        `fail on @@unique([listingId]). Samples: ` +
        stats.duplicateListingIds.slice(0, 5).join(", "),
    );
  }

  // A total collapse means the master's format changed, the token lost access,
  // or the archive replayed something unusable. Fail LOUDLY and BEFORE the
  // sweep: an empty selection reaching it reads as "every US listing was
  // withdrawn at once", and while `judgeUsStaleSweep` would refuse that, a
  // refusal is a second line of defence and not a reason to skip the first.
  if (listings.length === 0) {
    throw new Error(
      `Tiingo master returned 0 usable US listings ` +
        `(${stats.fetched} rows fetched, ${stats.inScope} in scope) — ` +
        `format change, token scope change, or an unusable archived object`,
    );
  }

  const phantoms = findPhantomWindows(
    listings.map((l) => ({
      symbol: l.symbol,
      exchange: l.exchange,
      listingId: l.listingId,
      listingStatus: l.listingStatus,
      listingStartDate: l.listingStartDate
        ? new Date(`${l.listingStartDate}T00:00:00Z`)
        : null,
      listingEndDate: l.listingEndDate
        ? new Date(`${l.listingEndDate}T00:00:00Z`)
        : null,
    })),
  );
  result.phantomWindows = phantoms.length;
  if (phantoms.length > 0) {
    console.warn(
      `[us-instrument-sync] ${phantoms.length} PHANTOM window(s) (<=5 days, ` +
        `overlapping a longer window on the same venue) — they lose every ` +
        `session a longer window also covers. e.g. ` +
        phantoms
          .slice(0, 8)
          .map((p) => p.listingId)
          .join(", "),
    );
  }

  const stored: StoredUsListing[] = await prisma.usInstrument.findMany({
    select: {
      listingId: true,
      assetType: true,
      listingStatus: true,
      listingEndDate: true,
    },
  });

  const plan = planUsInstrumentWrites(listings, stored);
  result.unchanged = plan.unchanged;
  result.staleCandidates = plan.staleListingIds.length;

  // `remaining` counts EVERY row still planned, across both loops.
  //
  // It used to count only the rest of the loop that happened to be running:
  // truncating in the CREATES loop set `truncated`, and `if (result.truncated)
  // break` then skipped every update group WITHOUT adding it — so a run that
  // stopped after 20k of 74k creates and 41k pending updates reported
  // `remaining: 54,000` instead of 95,000. Truncating inside update group *k*
  // was the same defect one level down: the rest of group *k* was counted and
  // groups *k+1..n* were not. Either way a monitor keyed on `remaining` reads a
  // nearly-converged table while most of the diff has not been attempted, which
  // is the ONE thing this field exists to prevent.
  const plannedUpdateRows = plan.updateGroups.reduce(
    (n, group) => n + group.listingIds.length,
    0,
  );

  // Per-chunk isolation on BOTH loops. A single rejected statement — a
  // duplicate `listingId` that slipped past the selection, a transient write
  // error — must cost its own chunk and not the other 73,000 rows; the next
  // night's diff re-proposes exactly what did not land.
  for (let i = 0; i < plan.creates.length; i += CREATE_CHUNK) {
    if (now() >= deadlineAt) {
      result.truncated = true;
      // The rest of the creates AND every update row below, which the
      // `if (result.truncated) break` guard is about to skip wholesale.
      result.remaining += plan.creates.length - i + plannedUpdateRows;
      break;
    }
    const chunk = plan.creates.slice(i, i + CREATE_CHUNK);
    try {
      const res = await prisma.usInstrument.createMany({ data: chunk });
      result.created += res.count;
    } catch (error) {
      result.failed += chunk.length;
      console.error(
        `[us-instrument-sync] createMany failed for ${chunk.length} rows ` +
          `(first: ${chunk[0]?.listingId}):`,
        error,
      );
    }
  }

  for (let g = 0; g < plan.updateGroups.length; g++) {
    if (result.truncated) break;
    const group = plan.updateGroups[g]!;
    for (let i = 0; i < group.listingIds.length; i += UPDATE_CHUNK) {
      if (now() >= deadlineAt) {
        result.truncated = true;
        // The rest of THIS group, plus every group behind it. The outer `break`
        // above ends the run without visiting them, so nothing else will count
        // them.
        result.remaining += group.listingIds.length - i;
        for (let h = g + 1; h < plan.updateGroups.length; h++) {
          result.remaining += plan.updateGroups[h]!.listingIds.length;
        }
        break;
      }
      const chunk = group.listingIds.slice(i, i + UPDATE_CHUNK);
      try {
        const res = await prisma.usInstrument.updateMany({
          where: { listingId: { in: chunk } },
          data: group.data,
        });
        result.updated += res.count;
      } catch (error) {
        result.failed += chunk.length;
        console.error(
          `[us-instrument-sync] updateMany failed for ${chunk.length} rows ` +
            `(first: ${chunk[0]}):`,
          error,
        );
      }
    }
  }

  // ── The stale sweep ────────────────────────────────────────────────────────
  //
  // The denominator is the ACTIVE STORED population INCLUDING the candidates,
  // counted from the same `findMany` the diff used rather than from a second
  // query — a breaker whose numerator and denominator come from two different
  // reads is the MONEY-1093 shape (a denominator and a numerator from different
  // populations is how a defect reads as healthy).
  //
  // A TRUNCATED run does not sweep. The sweep flips ACTIVE rows to DELISTED,
  // and its safety argument rests on the diff being fully applied: rows the
  // master no longer carries. After a budget stop the writes are half-applied,
  // and while the stale set itself is computed from the fetched master rather
  // than from what landed, running a destructive pass on a run that already
  // failed to finish its constructive one is the wrong instinct — the next run
  // recomputes the whole diff and sweeps then. Recorded as a refusal so it is
  // visible rather than silent.
  if (result.truncated) {
    result.sweepRefusedReason = `run budget exhausted with ${result.remaining} row(s) still planned — sweep deferred to the next run`;
    return result;
  }

  const verdict = judgeUsStaleSweep({
    candidates: plan.staleListingIds.length,
    activePopulation: plan.activeStored,
  });
  if (!verdict.proceed) {
    result.sweepRefusedReason = verdict.reason;
    console.error(`[us-instrument-sync] ${verdict.reason}`);
  } else {
    for (let i = 0; i < plan.staleListingIds.length; i += UPDATE_CHUNK) {
      const chunk = plan.staleListingIds.slice(i, i + UPDATE_CHUNK);
      try {
        const res = await prisma.usInstrument.updateMany({
          where: { listingId: { in: chunk } },
          data: { listingStatus: "DELISTED" },
        });
        result.retired += res.count;
      } catch (error) {
        result.failed += chunk.length;
        console.error(
          `[us-instrument-sync] stale sweep failed for ${chunk.length} rows:`,
          error,
        );
      }
    }
  }

  console.log(
    `[us-instrument-sync] wrote created=${result.created} ` +
      `updated=${result.updated} failed=${result.failed} ` +
      `unchanged=${result.unchanged} ` +
      `staleCandidates=${result.staleCandidates} retired=${result.retired}` +
      (result.sweepRefusedReason ? " (sweep REFUSED)" : ""),
  );

  return result;
}
