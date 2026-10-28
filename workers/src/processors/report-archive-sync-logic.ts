/**
 * PURE decision logic for report-archive-sync — MONEY-1097 (Data Engine P2).
 *
 * No Prisma, no fetch, no GCS. Everything here is a function of its arguments,
 * so the two decisions that actually matter — "should we re-fetch this family
 * tonight?" and "did NSE start publishing something new?" — are unit-testable
 * without standing up a worker, a database or the exchange.
 *
 * The I/O half lives in `report-archive-sync.ts`.
 */

import type { ReportFamily } from "@usemoney/core/market-data";

// ─── Per-family outcomes ─────────────────────────────────────────────

/**
 * What happened to one family on one day.
 *
 * `absent` is deliberately NOT a terminal state. The evening run fires at 19:30
 * IST and several NSE families publish late; the 21:45 run exists precisely to
 * catch them. If a 404 counted as "done", the second run would skip exactly the
 * files it was added to collect — the job would look like it worked while
 * doing nothing.
 */
export type FamilyOutcome =
  /** Validated bytes that REACHED GCS. Terminal. */
  | "archived"
  /**
   * Validated bytes that were NOT stored because the archive is DISARMED
   * (`FEED_ARCHIVE_MODE` unset). Terminal for the day: a re-fetch would not
   * store them either.
   *
   * Distinct from `archived` because conflating them was a lie the sync log
   * told. `getFeedAsset` hands back a Response whether or not it stored
   * anything, so branching on "did I get a Response" reported every fetch as
   * archived — including runs where zero bytes reached GCS.
   *
   * NOT the outcome for an ARMED archive whose write failed — that is
   * `store-failed`, and the split is the MONEY-1100 postmortem: the night the
   * archive was first armed, transient GCS failures were recorded as
   * `fetched`, the 21:45 run skipped every one of them as "done", and the
   * day's files had to be recovered by hand while NSE prunes.
   */
  | "fetched"
  /**
   * Archive ARMED, bytes validated, but the GCS write did not land.
   * Retryable — the whole point of the 21:45 run is a second chance at bytes
   * we do not have yet, and these are exactly that.
   */
  | "store-failed"
  /** 404 — not published yet, holiday, or a wrong URL. Retryable. */
  | "absent"
  /** Fetched, but the bytes failed the payload check. Retryable. */
  | "rejected"
  /** Threw. Retryable. */
  | "failed"
  /** Skipped because an earlier run today already finished it. */
  | "skipped";

/**
 * Outcomes that mean "there is nothing left to do for this family today".
 *
 * `rejected` is deliberately absent. Bytes that failed the payload check are
 * usually a throttle page, and the 21:45 run is exactly when to ask again —
 * treating them as done would suppress the retry the second run exists for.
 */
const TERMINAL: ReadonlySet<FamilyOutcome> = new Set<FamilyOutcome>([
  "archived",
  "fetched",
  "skipped",
]);

// Declared as TYPE ALIASES, not interfaces, and that is load-bearing rather
// than stylistic: both are written straight into `MarketDataSyncLog.metadata`,
// whose Prisma type is `InputJsonValue`. TypeScript gives type aliases an
// implicit index signature and interfaces none, so the interface form fails to
// assign with a "not assignable to undefined" error that reads like nonsense.
export type FamilyResult = {
  id: string;
  outcome: FamilyOutcome;
  /** HTTP-ish detail or error text, for the log line. */
  detail?: string;
  bytes?: number;
};

/** The metadata shape this job writes onto its MarketDataSyncLog row. */
export type ReportArchiveRunMetadata = {
  day: string;
  cadence: string;
  results: FamilyResult[];
  /** Observed NSE daily-report fileKeys, when the drift guard ran. */
  observedFileKeys?: string[];
  /**
   * Observed fileKeys no registry family claims — MONEY-1238.
   *
   * `DriftDiff.unregistered` is documented as "INFORMATION for whoever reads
   * the run", and it had NO reader at all: `diffObservedFileKeys` computed it,
   * `runDriftGuard` destructured `added` and `removed` and dropped it on the
   * floor. It is the registry's COVERAGE measure — the count of NSE files we
   * can see and are not archiving — so it belongs in the persisted run, where
   * it can be diffed across weeks, rather than in a log line that scrolls away.
   */
  unregisteredFileKeys?: string[];
};

// ─── Skip-if-already-archived ────────────────────────────────────────

/**
 * Family ids that an earlier run TODAY already finished.
 *
 * Reads prior runs' persisted results rather than asking GCS. Two reasons, and
 * the second is the load-bearing one:
 *
 *   1. It is one Mongo read for the whole run instead of one GCS `exists()`
 *      per family.
 *   2. **It works when the archive is switched off.** `FEED_ARCHIVE_MODE` is
 *      unset in both Cloud Run specs today (MONEY-1085 shipped dormant), so
 *      there is no GCS object to stat — `exists()` would return false for
 *      every family, the 21:45 run would re-fetch all ~15 enabled families that
 *      19:30 already got, and we would double our load on NSE/BSE every
 *      weekday for no benefit. Deriving the skip set from what we RECORDED
 *      keeps the second run cheap regardless of whether archiving is armed.
 *
 * Malformed/legacy metadata is ignored rather than thrown on: a bad row must
 * degrade to "nothing known, fetch it again", never abort the night's run.
 */
export function completedFamilyIds(
  priorRuns: ReadonlyArray<{ metadata?: unknown }>,
  day: string,
): Set<string> {
  const done = new Set<string>();
  for (const run of priorRuns) {
    const meta = run.metadata;
    if (!meta || typeof meta !== "object") continue;
    // A prior run only counts for the SAME trading day.
    //
    // Without this, an operator backfill was a guaranteed no-op: the caller's
    // query is `startedAt >= start-of-target-day` with no upper bound, so
    // asking for 2026-07-20 pulled in the last five NIGHTS' runs, whose results
    // are full of terminal entries for other days. Every family got filtered
    // out and the job completed having fetched nothing — while NSE prunes.
    // Matching on the recorded day makes the skip set correct no matter how
    // sloppy the query window is.
    if ((meta as { day?: unknown }).day !== day) continue;
    const results = (meta as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;
    for (const entry of results) {
      if (!entry || typeof entry !== "object") continue;
      const { id, outcome } = entry as { id?: unknown; outcome?: unknown };
      if (typeof id !== "string" || typeof outcome !== "string") continue;
      if (TERMINAL.has(outcome as FamilyOutcome)) done.add(id);
    }
  }
  return done;
}

/** Families still worth fetching, given what earlier runs today finished. */
export function selectFamiliesToFetch(
  due: readonly ReportFamily[],
  alreadyDone: ReadonlySet<string>,
): ReportFamily[] {
  return due.filter((f) => !alreadyDone.has(f.id));
}

// ─── Run summary ─────────────────────────────────────────────────────

export interface RunCounts {
  archived: number;
  /** Validated but NOT stored (archive disarmed) — see `FamilyOutcome.fetched`. */
  fetched: number;
  /** Archive armed but the write did not land — see `FamilyOutcome`. */
  "store-failed": number;
  absent: number;
  rejected: number;
  failed: number;
  skipped: number;
}

export function tallyOutcomes(results: readonly FamilyResult[]): RunCounts {
  const counts: RunCounts = {
    archived: 0,
    fetched: 0,
    "store-failed": 0,
    absent: 0,
    rejected: 0,
    failed: 0,
    skipped: 0,
  };
  for (const r of results) counts[r.outcome]++;
  return counts;
}

/**
 * What the sync log should record as FAILED — MONEY-1238.
 *
 * A pure function rather than an expression inlined at the write site, because
 * the expression was WRONG for a year and nothing could see it: it read
 * `counts.failed + counts.rejected`, silently omitting `store-failed`.
 *
 * `store-failed` means the archive was ARMED, the bytes passed the payload
 * check, and the GCS write did not land — bytes we fetched and do NOT have. The
 * night the archive first went live (the MONEY-1100 postmortem) an evening of
 * files was lost while the run recorded `recordsFailed: 0`.
 *
 * `absent` and `skipped` are deliberately excluded and must stay excluded: a
 * 404 is a market holiday as often as a fault (the module header's first rule),
 * and a skip is work another run of the same day already completed.
 */
export function recordsFailedFrom(counts: RunCounts): number {
  return counts.failed + counts.rejected + counts["store-failed"];
}

/**
 * One-line run summary.
 *
 * `absent` is reported separately from `failed` because they mean different
 * things operationally — a night of all-absent is a holiday, a night of
 * all-failed is an outage — and collapsing them is how MONEY-1085's zero-signal
 * failure happened in the first place.
 */
export function summarizeRun(day: string, counts: RunCounts): string {
  return (
    `${day}: archived ${counts.archived}, fetched-not-stored ${counts.fetched}, ` +
    `store-failed ${counts["store-failed"]}, ` +
    `absent ${counts.absent}, rejected ${counts.rejected}, ` +
    `failed ${counts.failed}, skipped ${counts.skipped}`
  );
}

// ─── Drift guard ─────────────────────────────────────────────────────

/**
 * NSE report sections the drift guard polls via `/api/daily-reports?key=…`.
 * Each is a separate archive family upstream; a new file appearing under any of
 * them is a report we are not archiving.
 */
export const DRIFT_GUARD_KEYS = [
  "CM",
  "FO",
  "WDM",
  "CBM",
  "TRI-PARTY",
  "SLBS",
  "SME",
  "INDEX",
  "CD",
  "COM",
  "NBF",
  "EGR",
] as const;

export interface DriftDiff {
  /** True on the very first run: there is no prior set to compare against. */
  baseline: boolean;
  /** fileKeys present now but absent from the previous observation. */
  added: string[];
  /** fileKeys that disappeared since the previous observation. */
  removed: string[];
  /** fileKeys not claimed by any registry family (informational). */
  unregistered: string[];
}

/**
 * Diff what NSE publishes today against what we saw last time.
 *
 * ## Why it diffs against the PREVIOUS OBSERVATION, not against the registry
 *
 * Diffing straight against the registry is the obvious design and it is
 * unusable: the registry names ~50 families and NSE's daily-reports API exposes
 * a couple of hundred fileKeys, so every single weekly run would warn about
 * ~150 "unknown" keys. A warning that fires identically every week is not a
 * signal, and the one week NSE actually adds something, that addition is
 * invisible inside the same wall of text.
 *
 * Comparing to the previous run's observed set makes the alert mean exactly one
 * thing: **NSE started publishing something new since last week.** It is also
 * self-seeding — the first run stores a baseline and warns about nothing, so
 * there is no hand-maintained list of "keys we know about" to go stale.
 *
 * `unregistered` is still computed, but as INFORMATION for whoever reads the
 * run, not as the alert.
 */
export function diffObservedFileKeys(
  previous: readonly string[] | null,
  current: readonly string[],
  registryKeys: ReadonlySet<string>,
): DriftDiff {
  const currentSet = new Set(current);
  const unregistered = [...currentSet]
    .filter((k) => !registryKeys.has(k))
    .sort();

  if (previous === null) {
    return { baseline: true, added: [], removed: [], unregistered };
  }

  const previousSet = new Set(previous);
  return {
    baseline: false,
    added: [...currentSet].filter((k) => !previousSet.has(k)).sort(),
    removed: [...previousSet].filter((k) => !currentSet.has(k)).sort(),
    unregistered,
  };
}

/**
 * Pull the fileKeys out of one `/api/daily-reports?key=…` payload.
 *
 * The response buckets files by publication window (`CurrentDay`,
 * `PreviousDay`, `FutureDay`), and the same fileKey appears in more than one
 * bucket — so every array is scanned and the result de-duplicated. Anything
 * that is not a `{fileKey: string}` object is skipped rather than throwing:
 * this runs inside a WARN-only guard, and a shape change upstream must not be
 * able to fail the night's archiving.
 */
export function extractFileKeys(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const keys = new Set<string>();
  for (const bucket of Object.values(payload as Record<string, unknown>)) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      if (!entry || typeof entry !== "object") continue;
      const key = (entry as { fileKey?: unknown }).fileKey;
      if (typeof key === "string" && key.trim()) keys.add(key.trim());
    }
  }
  return [...keys].sort();
}

/** The most recent prior observation, or null when there is none. */
export function previousObservedKeys(
  priorRuns: ReadonlyArray<{ metadata?: unknown }>,
): string[] | null {
  for (const run of priorRuns) {
    const meta = run.metadata;
    if (!meta || typeof meta !== "object") continue;
    const observed = (meta as { observedFileKeys?: unknown }).observedFileKeys;
    if (
      Array.isArray(observed) &&
      // An EMPTY observation is never a baseline — it is a failed sweep.
      //
      // `fetchNseApiJson` returns null on ANY failure and the NSE session
      // cookie is cached for five minutes, so one Akamai challenge poisons all
      // twelve keys and the sweep yields []. Accepting that as "what NSE
      // published" would make the next run report ~200 keys DISAPPEARED and the
      // one after ~200 NEW — two weeks of noise indistinguishable from the real
      // signal, produced by caching a fail-open default as a value.
      observed.length > 0 &&
      observed.every((k) => typeof k === "string")
    ) {
      return observed as string[];
    }
  }
  return null;
}
