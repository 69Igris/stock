/**
 * MF-metadata-sync processor — PURE helpers (no Prisma / network).
 *
 * `mf-metadata-sync.ts` builds its Prisma `where`, resolves its params, decides
 * whether to rate-limit between funds, and JUDGES THE RUN'S HEALTH using the
 * exports here; the test re-declared a whole `processMfMetadataSync` copy and
 * asserted the copy (a shadow that would stay green even if the real WHERE
 * clause / cap regressed). Those pure bits live here and the processor imports
 * + CALLS them. Mirrors `mf-sync-logic.ts`.
 *
 * @see workers/src/processors/mf-metadata-sync.ts (caller)
 * @see packages/core/src/market-data/instruments/mf-metadata-provider.ts
 */

export const DEFAULT_BATCH_SIZE = 500;
export const DEFAULT_DELAY_MS = 1000;
export const STALE_DAYS = 7;
/** Progress is logged every N funds. */
export const PROGRESS_LOG_EVERY = 50;

export interface MfMetadataSyncParams {
  batchSize: number;
  delayMs: number;
  forceReEnrich: boolean;
}

/** Resolve the job message into concrete params, applying defaults. */
export function resolveMfMetadataParams(data: {
  batchSize?: number;
  delayMs?: number;
  forceReEnrich?: boolean;
}): MfMetadataSyncParams {
  return {
    batchSize: data.batchSize ?? DEFAULT_BATCH_SIZE,
    delayMs: data.delayMs ?? DEFAULT_DELAY_MS,
    forceReEnrich: data.forceReEnrich ?? false,
  };
}

/** The `metadataSyncedAt` cutoff: funds synced before this are stale. */
export function computeStaleDate(now: Date = new Date()): Date {
  const staleDate = new Date(now);
  staleDate.setDate(staleDate.getDate() - STALE_DAYS);
  return staleDate;
}

export type MfMetadataWhere =
  | { isActive: true }
  | {
      isActive: true;
      OR: [
        { metadataSyncedAt: { isSet: false } },
        { metadataSyncedAt: null },
        { metadataSyncedAt: { lt: Date } },
      ];
    };

/**
 * Build the `MutualFundMaster.findMany` WHERE clause.
 * - force re-enrich → every active fund.
 * - otherwise → active funds that were NEVER enriched (the field is absent OR
 *   explicitly null) OR are stale (> STALE_DAYS).
 *
 * ## The `isSet: false` branch is load-bearing (MONEY-1205)
 *
 * **Prisma + MongoDB: `{ field: null }` does NOT match a document where the
 * field is entirely ABSENT** — it only matches an explicit stored `null`. The
 * repo already knew this (`scripts/seed/seed-mf-metadata.ts:48-52` comments it,
 * and `reference_prisma_mongo_not_false_missing_fields` records the same class
 * from MONEY-1050), but this builder shipped with `{ metadataSyncedAt: null }`
 * as its only "never enriched" branch.
 *
 * Measured on prod 2026-08-18 over 14,223 active schemes:
 *
 * ```
 *   metadataSyncedAt BSON type  date: 7,263   missing: 6,960
 *   OLD where (null | lt)  selects  7,263      <- only the already-attempted rows
 *   NEW where (+ isSet)    selects 14,223
 * ```
 *
 * So the 6,960 funds that had NEVER been touched were the *only* ones the job
 * could never reach — it re-picked the same 7,263 previously-attempted rows
 * forever. Both branches are kept: `isSet:false` for absent, `null` for an
 * explicitly-stored null (a shape a partial write or a future migration can
 * produce), because neither predicate subsumes the other.
 */
export function buildMfMetadataWhere(
  forceReEnrich: boolean,
  staleDate: Date = computeStaleDate(),
): MfMetadataWhere {
  if (forceReEnrich) return { isActive: true };
  return {
    isActive: true,
    OR: [
      { metadataSyncedAt: { isSet: false } },
      { metadataSyncedAt: null },
      { metadataSyncedAt: { lt: staleDate } },
    ],
  };
}

/**
 * Whether to sleep (rate-limit) after processing the fund at `index` in a list
 * of `total` funds: every iteration except the last.
 */
export function shouldSleepAfterIndex(index: number, total: number): boolean {
  return index < total - 1;
}

/** Whether to emit a progress log line after the fund at `index` (1-based step). */
export function shouldLogProgress(index: number): boolean {
  return (index + 1) % PROGRESS_LOG_EVERY === 0;
}

// ============== RUN HEALTH (MONEY-1189 class) ==============

/** Per-run tallies the health judgement reads. */
export interface MfMetadataRunTally {
  /** Funds the cursor selected. */
  selected: number;
  /** Funds where >= 1 field was written. */
  enriched: number;
  /** Funds where the provider was actually reached (any outcome). */
  attempted: number;
  /** Funds whose `metadataSyncedAt` was stamped (cursor advanced). */
  stamped: number;
  /** Total fields written across the batch. */
  fieldsExtracted: number;
}

export type MfMetadataHealthReason =
  | "ok"
  | "empty-batch"
  | "provider-dead"
  | "no-fund-reachable"
  | "cursor-stuck";

export interface MfMetadataHealth {
  ok: boolean;
  level: "info" | "error";
  reason: MfMetadataHealthReason;
  message: string;
}

/**
 * Judge whether a completed batch is evidence the pipeline works.
 *
 * This is the MONEY-1189 lesson applied to enrichment: the old processor logged
 * `Done: enriched=0, failed=500` and returned normally, so Pub/Sub acked, Cloud
 * Scheduler recorded a success, and the job "ran successfully" on 2026-08-16
 * having written nothing — for the third consecutive month, against an upstream
 * that had been returning 404 for every ISIN the whole time.
 *
 * The rule: **a provider that yields 0 usable rows across a full batch is a
 * failure, not a quiet line.** Two distinct ways that happens, kept separate
 * because they need different fixes:
 *
 *  - `provider-dead` — we reached the provider for >= 1 fund and it produced
 *    nothing anywhere. The upstream is the problem.
 *  - `no-fund-reachable` — we selected funds but never reached the provider for
 *    a single one (e.g. every selected fund lacks an ISIN). OUR data is the
 *    problem, and a healthy provider would not fix it.
 *
 * An EMPTY batch is explicitly fine: with the cursor fixed, "nothing is stale"
 * is a real steady state and must not be an error.
 */
export function judgeMfMetadataHealth(
  tally: MfMetadataRunTally,
): MfMetadataHealth {
  const { selected, enriched, attempted, stamped, fieldsExtracted } = tally;

  if (selected === 0) {
    return {
      ok: true,
      level: "info",
      reason: "empty-batch",
      message: "No funds were due for enrichment.",
    };
  }

  // THE CURSOR IS PART OF THE HEALTH VERDICT — MONEY-1238.
  //
  // `stamped` is documented as "cursor advanced", and it was computed, printed,
  // and read by nothing.
  //
  // Guarded on `enriched > 0` and placed directly above the success rung,
  // because that is the ONLY state nothing else catches: enrich 3 of 500, stamp
  // none, and `enriched > 0` returns a clean bill of health while the same 500
  // funds are re-selected every Sunday, forever — MONEY-1211 exactly, a
  // rotation that never rotates, with the detector present but unwired.
  //
  // It must NOT pre-empt `provider-dead` / `no-fund-reachable` below. A dead
  // provider also stamps nothing, so an unguarded `stamped === 0` check would
  // answer "the cursor is stuck" for an upstream outage and send the operator
  // to the wrong system. Those rungs are the more actionable diagnosis and keep
  // priority; this one only covers the case they cannot see.
  //
  // A PARTIAL stamp is legitimate — a fund that errored should be retried — so
  // it rides in the success message rather than failing the run.
  if (enriched > 0 && stamped === 0) {
    return {
      ok: false,
      level: "error",
      reason: "cursor-stuck",
      message:
        `Enriched ${enriched}/${selected} funds but stamped NONE, so the ` +
        `cursor did not advance: the next run re-reads this identical page ` +
        `and the rest of the universe is never reached. The enrichment count ` +
        `is why this does not look like a failure.`,
    };
  }

  if (enriched > 0) {
    return {
      ok: true,
      level: "info",
      reason: "ok",
      message:
        `Enriched ${enriched}/${selected} funds with ${fieldsExtracted} fields` +
        `; cursor advanced for ${stamped}/${selected}` +
        (stamped < selected
          ? ` — the ${selected - stamped} unstamped fund(s) will be re-selected.`
          : `.`),
    };
  }

  if (attempted === 0) {
    return {
      ok: false,
      level: "error",
      reason: "no-fund-reachable",
      message:
        `Selected ${selected} funds but reached the provider for NONE of them ` +
        `(every one was skipped before the fetch — most likely no ISIN). ` +
        `A working provider would not change this outcome.`,
    };
  }

  return {
    ok: false,
    level: "error",
    reason: "provider-dead",
    message:
      `Reached the provider for ${attempted} of ${selected} selected funds and ` +
      `extracted ZERO usable fields. Treating this as a failed run rather than ` +
      `logging enriched=0 and exiting 0.`,
  };
}
