/**
 * The prod -> QA sync's per-collection freshness record, as rules rather than
 * as prose — MONEY-1488 (the record) and MONEY-1487 (the order it decides).
 *
 * ## Why this module exists when nothing in production imports it
 *
 * `scripts/ops/sync-prod-to-qa.sh` runs as a Cloud Run job off
 * `scripts/ops/sync-job/Dockerfile`, which is `google/cloud-sdk:slim` plus the
 * mongo CLIs and COPYs exactly ONE file. There is no Node in that image and
 * there deliberately never will be (MONEY-1238 rewrote the post-restore re-link
 * from `npx tsx` onto mongosh for exactly this reason — the tsx call could not
 * run once, and reported success every night for months). So the rules below
 * CANNOT be imported by the thing that runs them.
 *
 * What they can be is EXECUTABLE BY A TEST, which is what both tickets ask for:
 * "a bash-only ordering rule is a rule nothing can check". The bash/mongosh side
 * implements the same two rules, and
 * `packages/core/__tests__/market-data/sync-prod-to-qa-exit-code.spawntest.ts`
 * drives the REAL script against canned facts — the stub supplies only the
 * facts, the script's own `sort` produces the order — and asserts the two
 * agree. So the duplication is pinned by BEHAVIOUR, not by a source scan
 * asserting that a string exists.
 *
 * That is stated plainly because it IS a duplication and this repo has been
 * burned by every unpinned one. It is the strongest arrangement available given
 * a runtime that cannot load TypeScript.
 */

/**
 * What the sync recorded for one collection on its last VISIT.
 *
 * VISIT, not write: a collection the empty-guard skipped is a healthy no-op and
 * must still stamp, or it keeps a stale marker for ever and — because this is
 * also the sort key — never rotates to the front again (MONEY-1255).
 */
export type QaSyncState =
  /** dump + restore both exited 0. QA holds prod's copy. */
  | "RESTORED"
  /** prod had 0 rows. QA UNTOUCHED — the empty-guard. */
  | "SKIPPED_EMPTY"
  /** `--tier=sample` matched 0 of N rows. QA UNTOUCHED. */
  | "SKIPPED_SAMPLE_MISS"
  /**
   * The prod count failed, or the sample plan refused the collection. QA
   * UNTOUCHED and the copy never STARTED — which is a different fact from
   * "the copy failed", and the reason the two are not one value.
   */
  | "COUNT_FAILED"
  /** dump or restore exited non-zero. QA may hold a PARTIAL copy. */
  | "FAILED"
  /**
   * MONEY-1519 — the rows may all be present but a unique index is NOT: the
   * unique-key-first step failed, or mongorestore reported "error creating
   * indexes for". Distinct from FAILED because the fix differs: the data copy
   * worked and QA is running without the key its writers depend on.
   */
  | "INDEX_BUILD_FAILED"
  /**
   * Stamped BEFORE the pipeline and never overwritten. A process killed at the
   * 3600s task timeout cannot write "I was killed", so the intent is written
   * first and the ABSENCE of an end stamp is the signal. QA may hold a
   * scattered PARTIAL copy.
   */
  | "IN_FLIGHT";

/**
 * The states that mean `mongorestore --drop` may have dropped QA's copy and
 * not finished replacing it — or, for INDEX_BUILD_FAILED (MONEY-1519), finished
 * it without the unique key that keeps it duplicate-free.
 *
 * This is the set MONEY-1486's delta bound has to consult before it may trust
 * anything: `mongorestore` inserts in ARBITRARY order
 * (`--maintainInsertionOrder` is off by default) and the archive is in prod's
 * natural order, not watermark order. So a killed restore leaves a SCATTERED
 * subset with no `--drop` to roll it back, and QA's live `max(field)` is then
 * the highest value that happened to land — a `$gt` from there excludes every
 * un-landed row below it for ever. The bound must come from a recorded CLEAN
 * completion; that is the whole reason this record exists.
 */
export const PARTIALLY_APPLIED_STATES: readonly QaSyncState[] = [
  "FAILED",
  "INDEX_BUILD_FAILED",
  "IN_FLIGHT",
];

/** One row of `qa_sync_outcomes`, as the mongosh writer stores it. */
export interface QaSyncRecord {
  /** The collection name. It is the document `_id`, so the key IS the identity. */
  readonly collection: string;
  readonly lastState: QaSyncState;
  /** Epoch ms of the last VISIT, whatever its outcome. The sort key. */
  readonly lastAttemptAtMs: number;
  /** Epoch ms of the last CLEAN completion, or null if there has never been one. */
  readonly lastSuccessAtMs: number | null;
}

export type SyncFreshness =
  /** No record at all — this collection has never been visited here. */
  | "NEVER"
  /** Last visited longer ago than the threshold. */
  | "STALE"
  | "FRESH";

export interface SyncFreshnessRow {
  readonly collection: string;
  readonly freshness: SyncFreshness;
  readonly lastState: QaSyncState | null;
  /** Days since the last visit, or null when there has never been one. */
  readonly ageDays: number | null;
  /** `lastState` is in {@link PARTIALLY_APPLIED_STATES}. */
  readonly partiallyApplied: boolean;
}

/**
 * How stale a collection may get before the report says so.
 *
 * 3 days rather than 1: the reference sync runs daily, so 1 would fire on a
 * single missed night, and the defect this record exists for was THREE WEEKS
 * (34 collections unsynced since 2026-08-31). Mirrored as `STALE_AFTER_DAYS` in
 * `scripts/ops/sync-prod-to-qa.sh`, and the spawntest compares the two.
 */
export const DEFAULT_STALE_AFTER_DAYS = 3;

const MS_PER_DAY = 86_400_000;

/** Index records by collection, last write wins. */
function byCollection(
  records: readonly QaSyncRecord[],
): Map<string, QaSyncRecord> {
  const out = new Map<string, QaSyncRecord>();
  for (const r of records) out.set(r.collection, r);
  return out;
}

/**
 * The order the restore loop should walk the manifest in.
 *
 * RULE: least-recently-VISITED first; ties broken by position in the manifest.
 * A collection with no record sorts at 0, i.e. FIRST — never-synced is the most
 * urgent thing in the list, and it is exactly the state the 34 starved
 * collections were in.
 *
 * VISITED and not SUCCEEDED, and that polarity is load-bearing in the other
 * direction: `candles` (29M rows) has failed every run since 2026-09-01 after
 * burning 25-29 minutes of a 60-minute budget, and a success-keyed order would
 * park it at the head for ever and starve the other 53. A collection too big to
 * finish must not be allowed to monopolise the queue by failing.
 *
 * Returns the manifest itself, unchanged, when there are no records — which is
 * also the fallback the script prints loudly if it cannot read them.
 */
export function planSyncOrder(
  manifest: readonly string[],
  records: readonly QaSyncRecord[],
): string[] {
  const seen = byCollection(records);
  return manifest
    .map((collection, index) => ({
      collection,
      index,
      at: seen.get(collection)?.lastAttemptAtMs ?? 0,
    }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((e) => e.collection);
}

/**
 * The freshness verdict per collection, in manifest order.
 *
 * `nowMs` is a parameter rather than a `Date.now()` call so the rule is a pure
 * function of its inputs and a test can execute it at a fixed instant.
 */
export function classifySyncFreshness(
  manifest: readonly string[],
  records: readonly QaSyncRecord[],
  nowMs: number,
  staleAfterDays: number = DEFAULT_STALE_AFTER_DAYS,
): SyncFreshnessRow[] {
  const seen = byCollection(records);
  const staleMs = staleAfterDays * MS_PER_DAY;
  return manifest.map((collection) => {
    const rec = seen.get(collection);
    if (rec === undefined || !Number.isFinite(rec.lastAttemptAtMs)) {
      return {
        collection,
        freshness: "NEVER",
        lastState: null,
        ageDays: null,
        partiallyApplied: false,
      };
    }
    const ageMs = nowMs - rec.lastAttemptAtMs;
    return {
      collection,
      freshness: ageMs > staleMs ? "STALE" : "FRESH",
      lastState: rec.lastState,
      ageDays: ageMs / MS_PER_DAY,
      partiallyApplied: PARTIALLY_APPLIED_STATES.includes(rec.lastState),
    };
  });
}

/**
 * Whether a recorded outcome may be used as a delta copy's lower bound —
 * MONEY-1486.
 *
 * Only a CLEAN completion qualifies. Everything else either left QA untouched
 * (so there is no bound to take) or may have left a scattered partial subset
 * (so any bound taken from QA skips rows permanently).
 */
export function mayUseAsDeltaBound(rec: QaSyncRecord | undefined): boolean {
  return (
    rec !== undefined &&
    rec.lastState === "RESTORED" &&
    rec.lastSuccessAtMs !== null &&
    Number.isFinite(rec.lastSuccessAtMs)
  );
}
