/**
 * Did a `replay`-mode run actually replay anything? — MONEY-1194.
 *
 * ## The incident
 *
 * QA ran with `FEED_ARCHIVE_MODE=replay`, the prod→QA `feeds/` mirror existed
 * and worked, and QA still scraped NSE and BSE for the ENTIRE daily bhavcopy,
 * every weekday. The 2026-08-13 19:54 IST run on `stockbook-workers-qa-00306`
 * ended `replayHits=0 replayMisses=2` — a 100% miss rate on both exchanges,
 * 8,172 prices all fetched from the exchanges directly.
 *
 * The cause was a schedule collision (prod archived day D at 21:00 IST on D;
 * the mirror copied at 00:45 IST on D+1; QA asked for day D at 21:00 IST on D,
 * ~3h45m too early) and it is fixed in `scripts/ops/setup-scheduler.sh`. This
 * module exists because of the OTHER half: nothing noticed for weeks.
 *
 * The replay miss is by design a SOFT failure — `getFeedAsset` falls back to the
 * exchange, so the run succeeds, the prices are correct, and
 * `MarketDataSyncLog.source` reads "BHAVCOPY" exactly as it does on a replayed
 * run. The counters that could tell those apart were already being printed and
 * nothing asserted on them. `workers/cloudbuild.qa.yaml` had literally written
 * down this failure mode in a comment — *"QA would scrape exactly as much as
 * before while the logs claimed it was replaying"* — and it happened anyway.
 *
 * ## Why the decision is pure and lives here
 *
 * Same posture as `run-completion.ts` and `fo-summary-coverage.ts`: the process
 * shell (a worker processor that has a Prisma client, a network and a Datadog
 * client) stays a three-line dispatch it cannot get interestingly wrong, and the
 * judgement — which combinations of counters mean "the replay contract was
 * broken" — is a pure function with real assertions on it.
 *
 * ## Why `partial-miss` is deliberately quieter than `total-miss`
 *
 * An alert that always fires is not a signal (the same reasoning that made
 * `report-archive-drift-weekly` diff against the LAST OBSERVATION rather than
 * against the registry). A single asset can miss on QA every single day through
 * no fault of the schedule: if the exchange never published a file, prod
 * archived nothing, so QA's read for it misses forever. Paging on that would
 * train everyone to ignore the line that matters. So a partial miss is stated at
 * info level; only "we replayed NOTHING" and "the flag is armed but there is no
 * store at all" are warnings.
 */

import type { FeedArchiveCounters, FeedArchiveMode } from "./feed-archive";

/** Why the verdict came out the way it did — also the metric tag. */
export type ReplayHealthReason =
  /** Not in replay mode; this guard has no opinion (prod archives, local is off). */
  | "not-replaying"
  /** Replay is armed but no store was registered — nothing CAN be replayed. */
  | "no-store"
  /** The archive was never consulted this run; nothing can be concluded. */
  | "no-reads"
  /** Every archive read fell back to the exchange. The MONEY-1194 shape. */
  | "total-miss"
  /** Some reads hit, some fell back. */
  | "partial-miss"
  /** Every archive read was served from the archive. */
  | "healthy";

/** How loudly the shell should say it. */
export type ReplayHealthLevel = "warn" | "info" | "none";

export interface ReplayHealthInput {
  /** The resolved `FEED_ARCHIVE_MODE` for this process. */
  mode: FeedArchiveMode;
  /**
   * Whether an archive backend is registered (`getFeedArchiveStore() !== null`).
   *
   * Load-bearing, and NOT derivable from the counters: with `mode=replay` and no
   * store, `getFeedAsset` skips the replay branch entirely, so every counter
   * stays 0 — indistinguishable from "this run fetched nothing". That is a live
   * configuration: `initFeedArchive()` refuses to register the GCS store when
   * `GCP_STORAGE_BUCKET` is unset, and the only trace is one startup warning
   * that scrolls away.
   */
  storeRegistered: boolean;
  /** The counter DELTA for this run (see `diffFeedArchiveCounters`). */
  counters: Pick<
    FeedArchiveCounters,
    "replayHits" | "replayMisses" | "replayRejected"
  >;
}

export interface ReplayHealthVerdict {
  /**
   * True when the run did not get what `replay` promised — the metric/alert
   * trigger. Deliberately broader than {@link ReplayHealthVerdict.level}: a
   * partial miss IS a degradation (bytes were scraped that should not have
   * been), it just does not deserve to page.
   */
  degraded: boolean;
  reason: ReplayHealthReason;
  level: ReplayHealthLevel;
  /** Operator-facing line; null when there is nothing worth saying. */
  message: string | null;
  /** Archive reads served from the archive. */
  hits: number;
  /** Archive reads that fell back to the exchange (misses + rejects). */
  fellBack: number;
  /** Archive reads attempted (hits + misses + rejects). */
  reads: number;
}

/**
 * Judge one run's feed-archive replay behaviour.
 *
 * `no-reads` is NOT a failure and must never become one: it is what a run looks
 * like when it legitimately fetched nothing (an early throw, a day whose files
 * were all already resolved, a job that requests no archived asset at all), and
 * it is indistinguishable from those cases using counters alone. The armed-but-
 * inert configuration that WOULD hide there is caught by `storeRegistered`
 * instead, which is exact.
 */
export function judgeReplayHealth(
  input: ReplayHealthInput,
): ReplayHealthVerdict {
  const hits = Math.max(0, input.counters.replayHits);
  const misses = Math.max(0, input.counters.replayMisses);
  const rejected = Math.max(0, input.counters.replayRejected);
  const fellBack = misses + rejected;
  const reads = hits + fellBack;

  const base = { hits, fellBack, reads };

  if (input.mode !== "replay") {
    return {
      ...base,
      degraded: false,
      reason: "not-replaying",
      level: "none",
      message: null,
    };
  }

  if (!input.storeRegistered) {
    return {
      ...base,
      degraded: true,
      reason: "no-store",
      level: "warn",
      message:
        "REPLAY INERT: FEED_ARCHIVE_MODE=replay but no feed-archive store is " +
        "registered, so every byte in this run came from the exchange. " +
        "initFeedArchive() skips registration when GCP_STORAGE_BUCKET is " +
        "unset — check this service's env (MONEY-1194).",
    };
  }

  if (reads === 0) {
    return {
      ...base,
      degraded: false,
      reason: "no-reads",
      level: "none",
      message: null,
    };
  }

  if (hits === 0) {
    return {
      ...base,
      degraded: true,
      reason: "total-miss",
      level: "warn",
      message:
        `REPLAY MISS-ONLY: 0 of ${reads} archive read(s) hit ` +
        `(${misses} missing, ${rejected} rejected) — every byte in this run ` +
        "was scraped from the exchange despite FEED_ARCHIVE_MODE=replay. " +
        "Either the mirror has not copied this day's objects yet or the keys " +
        "do not match. Check that sync-prod-to-qa-feeds ran AFTER prod " +
        "archived the day and BEFORE this job (MONEY-1194).",
    };
  }

  if (fellBack > 0) {
    return {
      ...base,
      degraded: true,
      reason: "partial-miss",
      level: "info",
      message:
        `replay partial: ${hits} of ${reads} archive read(s) hit; ` +
        `${fellBack} fell back to the exchange (${misses} missing, ` +
        `${rejected} rejected).`,
    };
  }

  return {
    ...base,
    degraded: false,
    reason: "healthy",
    level: "none",
    message: null,
  };
}
