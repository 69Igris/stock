/**
 * Report Archive Sync — MONEY-1097 (Data Engine P2).
 *
 * Walks `REPORT_REGISTRY` and archives every enabled NSE/BSE report family for
 * a trading day. It fetches bytes and stores them. It does **not parse**, by
 * design.
 *
 * ## Why archive-first
 *
 * NSE prunes its archives — P1 proved it for one feed with real 404s: the PR
 * daily-report zips are unavailable for 1995, 2000 and 2010. (An earlier
 * version of this comment also claimed BSE's pre-UDiFF EQ_ISINCODE zips were
 * "gone entirely"; that was a probe-classification artifact, not a finding —
 * those probes returned 200 + an HTML page, never a 404.)
 * Every week spent designing parsers is a week of files aging out of reach.
 * Bytes on GCS can be parsed at leisure; bytes never fetched are unrecoverable.
 * Parsers are P4's problem (MONEY-1100).
 *
 * ## Everything goes through `getFeedAsset`
 *
 * Not `fetch`, and not `fetchExchangeAsset` either. `getFeedAsset` is the seam
 * MONEY-1085 built: it applies the browser headers, honours
 * `FEED_ARCHIVE_MODE` (archive on prod / replay on QA), runs the payload sanity
 * check, and writes to the `feeds/{exchange}/{feed}/{YYYY}/{MM}/{basename}`
 * layout. Using it means this job needed no archive code of its own and that QA
 * mirroring works for these feeds on the day it is switched on, with no further
 * changes here.
 *
 * That rule is NOT machine-enforced here, and it would be wrong to imply it is.
 * `no-feed-fetch-bypass.test.ts` scans `packages/core/src` only — it can see
 * neither `workers/` nor `packages/research`, so it cannot observe this file at
 * all. This job now carries the majority of the platform's exchange fetches,
 * and `runDriftGuard` deliberately makes 12 un-seamed calls to www.nseindia.com
 * per week via `fetchNseApiJson` (a JSON index, not a feed file — it is read to
 * DECIDE, never archived). Widening that scan to workers/ is worth doing; until
 * then the discipline here is convention, and a future worker-side fetch that
 * skips `getFeedAsset` would opt its feed out of the archive with a green suite.
 *
 * ## Two runs a night
 *
 * 19:30 IST catches the prompt publishers; 21:45 IST catches the late ones.
 * The second run skips families the first already archived (see
 * `completedFamilyIds`) but deliberately RETRIES the absent ones — a 404 at
 * 19:30 is usually "not published yet", which is the entire reason the second
 * run exists.
 *
 * A 404 is never an error here. Weekend, exchange holiday, pre-EOD and
 * not-published-today all present as 404, and treating any of them as a failure
 * would make the job cry wolf nightly.
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { prisma } from "@usemoney/database";
import type { ReportArchiveSyncMessage } from "@usemoney/types/pubsub";
import {
  familiesDue,
  allFamilies,
  tokIsoDay,
  type ReportFamily,
  type ReportCadence,
} from "@usemoney/core/market-data";
import {
  getFeedAsset,
  validateFeedPayload,
  BSE_REFERER,
  NSE_REFERER,
  diffFeedArchiveCounters,
  emptyFeedAssetOutcome,
  readFeedArchiveCounters,
  resolveFeedArchiveMode,
} from "@usemoney/core/market-data";
import { fetchNseApiJson } from "@usemoney/research/data-sources/nse-filings";
import { resolveTargetDay } from "./bhavcopy-sync-logic";
import {
  completedFamilyIds,
  selectFamiliesToFetch,
  tallyOutcomes,
  recordsFailedFrom,
  summarizeRun,
  diffObservedFileKeys,
  extractFileKeys,
  previousObservedKeys,
  DRIFT_GUARD_KEYS,
  type FamilyResult,
  type ReportArchiveRunMetadata,
} from "./report-archive-sync-logic";

const SYNC_TYPE = "REPORT_ARCHIVE";
const SOURCE = "EXCHANGE_REPORTS";

/**
 * Pacing between family fetches.
 *
 * ~15 enabled families today and up to ~50 once the unverified rows are
 * confirmed, all against two hosts that 403 under load. 1.2s keeps a full run
 * near a minute — comfortably inside the 600s Pub/Sub ack deadline — while
 * staying slower than a person clicking around the site.
 */
const FETCH_DELAY_MS = 1200;

/**
 * Wall-clock ceiling for the fetch loop.
 *
 * `setup-pubsub.sh` uses `--ack-deadline=600`. 420s leaves room for the sync-log
 * writes and the optional drift sweep while keeping the whole run comfortably
 * inside the deadline, so Pub/Sub never redelivers on top of a live run.
 */
const RUN_BUDGET_MS = 420_000;

const log = {
  info: (...a: unknown[]) => console.log("[report-archive-sync]", ...a),
  warn: (...a: unknown[]) => console.warn("[report-archive-sync]", ...a),
  error: (...a: unknown[]) => console.error("[report-archive-sync]", ...a),
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Start of the target IST day, in UTC — for "did an earlier run today finish this?". */
function istDayStartUtc(day: Date): Date {
  return new Date(`${tokIsoDay(day)}T00:00:00.000+05:30`);
}

export async function processReportArchiveSync(
  data: ReportArchiveSyncMessage,
): Promise<void> {
  const day = resolveTargetDay(data.date);
  const dayKey = tokIsoDay(day);
  const cadence: ReportCadence | "all" | "none" = data.cadence ?? "daily";

  const runMetadata: ReportArchiveRunMetadata = {
    day: dayKey,
    cadence,
    results: [],
  };

  const syncLog = await prisma.marketDataSyncLog.create({
    data: {
      syncType: SYNC_TYPE,
      source: SOURCE,
      status: "RUNNING",
      metadata: { ...runMetadata },
    },
  });

  // Same snapshot-and-diff pattern as bhavcopy-sync: `source` is identical
  // whether bytes were replayed or scraped, so without these counters a QA that
  // silently stopped replaying looks exactly like a healthy run.
  const feedArchiveBefore = readFeedArchiveCounters();
  const feedArchiveDelta = () => ({
    mode: resolveFeedArchiveMode(),
    ...diffFeedArchiveCounters(feedArchiveBefore, readFeedArchiveCounters()),
  });

  const results: FamilyResult[] = [];

  try {
    // "none" is the drift-guard-only run: it fires on a Saturday, so asking
    // for the day's families would produce a full set of meaningless 404s.
    const due = cadence === "none" ? [] : familiesDue(day, cadence);

    // What an earlier run TODAY already finished. Indexed by
    // (syncType, startedAt) on MarketDataSyncLog.
    // Bounded on BOTH sides. The lower bound alone let a backfill for a past
    // date pick up tonight's runs; `completedFamilyIds` now also matches on the
    // recorded `metadata.day`, so the two guards are independent.
    const priorRuns = await prisma.marketDataSyncLog.findMany({
      where: {
        syncType: SYNC_TYPE,
        startedAt: {
          gte: istDayStartUtc(day),
          lt: new Date(istDayStartUtc(day).getTime() + 36 * 60 * 60 * 1000),
        },
        id: { not: syncLog.id },
      },
      select: { metadata: true },
      orderBy: { startedAt: "desc" },
      take: 10,
    });
    const alreadyDone = completedFamilyIds(priorRuns, dayKey);

    // An explicit familyIds list is an operator override for a one-off re-run,
    // so it bypasses the skip set — otherwise "re-fetch this family" would
    // silently do nothing when today's run already got it.
    //
    // Resolved against the WHOLE registry, not against `due`. Intersecting with
    // `due` meant a targeted repair silently did nothing in exactly the cases
    // an operator would reach for it — a family just flipped `enabled` in a
    // hotfix, or any repair issued against the drift-guard job (whose `due` is
    // empty by construction) — while the docs promise it bypasses the skip set.
    // An id that matches nothing is WARNED about rather than dropped.
    let requested: ReportFamily[];
    if (data.familyIds !== undefined) {
      const wanted = new Set(data.familyIds);
      requested = allFamilies().filter((f) => wanted.has(f.id));
      const unmatched = [...wanted].filter(
        (id) => !requested.some((f) => f.id === id),
      );
      if (unmatched.length > 0) {
        log.warn(
          `familyIds contained ${unmatched.length} id(s) that match no registry ` +
            `family and were IGNORED: ${unmatched.join(", ")}`,
        );
      }
      if (requested.length === 0) {
        log.warn(
          `familyIds was supplied but resolved to NOTHING — this run will fetch ` +
            `nothing. That is almost certainly not what was intended.`,
        );
      }
    } else {
      requested = selectFamiliesToFetch(due, alreadyDone);
    }

    for (const id of alreadyDone) {
      if (due.some((f) => f.id === id) && !requested.some((f) => f.id === id)) {
        results.push({
          id,
          outcome: "skipped",
          detail: "archived earlier today",
        });
      }
    }

    log.info(
      `${dayKey} (${cadence}): ${due.length} due, ${requested.length} to fetch, ` +
        `${results.length} already archived today`,
    );
    // `selected` is what this run intended to FETCH — families already archived
    // today were never write candidates, so a same-day re-run reports 0 and
    // cannot alarm. An empty cadence bucket is caught by the guard below, which
    // is a provisioning bug rather than a zero-write one.
    reportJobOutcome({
      job: "report-archive-sync",
      selected: requested.length,
      written: results.filter((r) => r.outcome === "archived").length,
      failed: results.filter((r) => r.outcome === "failed").length,
    });

    // A cadence bucket with NO families is a provisioning bug, not a quiet day.
    //
    // `report-archive-monthly` is scheduled but zero registry families declare
    // cadence "monthly" today, so every 3rd of the month it would create a sync
    // log, fetch nothing and complete with recordsProcessed 0 — indistinguishable
    // from a month where everything 404'd, which is precisely the zero-signal
    // shape this subsystem exists to avoid. Saying so out loud costs nothing and
    // makes the empty bucket self-announcing.
    if (cadence !== "none" && due.length === 0) {
      log.warn(
        `NO families are due for cadence "${cadence}" on ${dayKey}. If this ` +
          `cadence has a cron, it is currently a no-op — either add families ` +
          `to the registry or remove the schedule.`,
      );
    }

    // Wall-clock budget, because the ack deadline is not advisory.
    //
    // 34 families x a 30s fetch timeout + pacing is ~1060s against a 600s
    // `--ack-deadline`. Worse, `fetchWithTimeout` clears its timer when HEADERS
    // arrive, so the `arrayBuffer()` read is untimed and one stalled socket can
    // hang the loop indefinitely. Overrunning does not merely delay the run:
    // Pub/Sub redelivers while run #1 is still live, and the two runs hammer
    // the same 403-prone hosts in parallel. Stopping early leaves the rest as
    // non-terminal outcomes, so the 21:45 run picks them up — which is exactly
    // what the second run is for.
    const deadline = Date.now() + RUN_BUDGET_MS;
    for (let i = 0; i < requested.length; i++) {
      if (Date.now() > deadline) {
        const remaining = requested.slice(i);
        log.warn(
          `RUN BUDGET (${RUN_BUDGET_MS / 1000}s) exhausted after ${i}/${requested.length} ` +
            `families — stopping so the Pub/Sub ack deadline cannot expire and ` +
            `trigger a concurrent redelivery. Not fetched this run: ` +
            `${remaining.map((f) => f.id).join(", ")}`,
        );
        for (const f of remaining) {
          results.push({
            id: f.id,
            outcome: "failed",
            detail: "run budget exhausted before this family was attempted",
          });
        }
        break;
      }
      const family = requested[i]!;
      results.push(await archiveFamily(family, day));
      if (i < requested.length - 1) await sleep(FETCH_DELAY_MS);
    }

    if (data.driftGuard === true) {
      // Its OWN lookup, deliberately not `priorRuns`.
      //
      // `priorRuns` is scoped to the target trading day, and the guard runs
      // weekly — so the previous observation is always ~7 days outside that
      // window (and `take: 10` would evict it anyway: 5 weekdays x 2 runs).
      // Reusing it left `previousObservedKeys` returning null every single
      // week, pinning the guard in baseline mode forever: the added/removed
      // warnings — the only alert this job ships — could never fire, while the
      // unit tests stayed green because they hand-feed a prior observation.
      const priorObservations = await prisma.marketDataSyncLog.findMany({
        where: { syncType: SYNC_TYPE, id: { not: syncLog.id } },
        select: { metadata: true },
        orderBy: { startedAt: "desc" },
        take: 60,
      });
      const sweep = await runDriftGuard(priorObservations);
      if (sweep) {
        runMetadata.observedFileKeys = sweep.observed;
        runMetadata.unregisteredFileKeys = sweep.unregistered;
      }
    }

    const counts = tallyOutcomes(results);
    runMetadata.results = results;

    await prisma.marketDataSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "COMPLETED",
        // "Processed" is what we actually captured. Absent/skipped are neither
        // successes nor failures and are visible in `metadata.results`.
        recordsProcessed: counts.archived,
        // MONEY-1238 — the decision is `recordsFailedFrom`, not an inline sum.
        // The inline version read `counts.failed + counts.rejected` and omitted
        // `store-failed` — bytes we fetched and do NOT have — so the sync log
        // recorded `recordsFailed: 0` on the night an evening of files was lost.
        recordsFailed: recordsFailedFrom(counts),
        completedAt: new Date(),
        metadata: { ...runMetadata, feedArchive: feedArchiveDelta() },
      },
    });

    const fa = feedArchiveDelta();
    log.info(
      `Done ${summarizeRun(dayKey, counts)} ` +
        `(feed archive mode=${fa.mode} archived=${fa.archived} ` +
        `skipped=${fa.archiveSkipped} failed=${fa.archiveFailed} ` +
        `timedOut=${fa.archiveTimedOut} replayHits=${fa.replayHits})`,
    );
  } catch (err) {
    runMetadata.results = results;
    await prisma.marketDataSyncLog.update({
      where: { id: syncLog.id },
      data: {
        status: "FAILED",
        recordsProcessed: tallyOutcomes(results).archived,
        recordsFailed: results.length,
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : "Unknown error",
        metadata: { ...runMetadata, feedArchive: feedArchiveDelta() },
      },
    });
    throw err;
  }
}

/**
 * Fetch and archive one family.
 *
 * Isolated per family: one dead URL must never abort the rest of the night's
 * archiving, so everything is caught and turned into a result row.
 */
async function archiveFamily(
  family: ReportFamily,
  day: Date,
): Promise<FamilyResult> {
  const url = family.buildUrl(day);
  if (!url) {
    return { id: family.id, outcome: "absent", detail: "no URL for this date" };
  }

  const referer = family.exchange === "BSE" ? BSE_REFERER : NSE_REFERER;

  const descriptor = {
    exchange: family.exchange,
    feed: family.feed,
    date: day,
    // Rolling families (bulk.csv, index constituent lists) have no date in
    // their upstream filename, so every day would archive to the same
    // basename and overwrite the previous day. Prefixing the day makes the
    // history accrue — which for constituent lists IS the product.
    // A family-supplied basename wins. The `/api/reports` door is a REST route,
    // so deriving from the URL path yields `reports` plus the whole query
    // string as a collision discriminator — an unreadable, extension-less name
    // that also defeats `feedContentType` (a 68 KB zip stored as
    // application/octet-stream). Families that need one now build it.
    basename: family.buildBasename
      ? family.buildBasename(day)
      : family.rolling
        ? `${tokIsoDay(day)}-${url.split("/").pop()}`
        : undefined,
  };

  // Per-CALL outcome sink. The previous version diffed the process-wide
  // `archived` counter across this call, which measures monotonicity rather
  // than attribution: the workers service runs containerConcurrency: 10 with
  // no mutex, so a concurrent bhavcopy-sync / instrument-sync / redelivered
  // run archiving its OWN feed made this family's delta positive even when its
  // own write had failed — handing it the TERMINAL `archived` outcome,
  // suppressing every retry for the day, and losing the file while NSE prunes.
  // That is precisely the MONEY-1100 loss `store-failed` exists to prevent.
  const assetOutcome = emptyFeedAssetOutcome();

  try {
    const res = await getFeedAsset(url, referer, descriptor, assetOutcome);

    if (!res) {
      // 404 — not published yet, weekend, holiday, or a wrong path. Retryable
      // by design: the 21:45 run exists for the "not published yet" case.
      return { id: family.id, outcome: "absent", detail: "404" };
    }

    // ── Deriving the outcome HONESTLY ──────────────────────────────────
    //
    // `getFeedAsset` returns a Response in three very different situations and
    // they are indistinguishable from the return value alone:
    //
    //   1. archive mode + payload valid   → bytes stored in GCS
    //   2. archive mode + payload INVALID → `archiveSkipped++`, nothing stored
    //   3. mode off (today's state)       → returns the raw response, no check,
    //                                       nothing stored
    //
    // The first version branched on `!res` only, so all three logged
    // "archived N bytes" and wrote a TERMINAL `archived` outcome — which then
    // suppressed the 21:45 retry for case 2, the one case the retry exists for.
    // With the archive disarmed it also reported `recordsProcessed: 34` on a
    // run that stored nothing, one line above `mode=off archived=0`.
    //
    // So the bytes are validated HERE with the same pure predicate the archive
    // uses, and the counter delta says whether anything actually landed.
    const buf = Buffer.from(await res.arrayBuffer());
    const check = validateFeedPayload(descriptor, url, buf);

    if (!check.ok) {
      log.warn(`${family.id}: REJECTED ${buf.length} bytes — ${check.reason}`);
      return {
        id: family.id,
        outcome: "rejected",
        bytes: buf.length,
        detail: check.reason,
      };
    }

    const stored = assetOutcome.stored;
    if (stored) {
      log.info(`${family.id}: archived ${buf.length} bytes`);
      return { id: family.id, outcome: "archived", bytes: buf.length };
    }
    // Not stored. WHY matters for terminality (MONEY-1100 postmortem):
    // disarmed → `fetched`, terminal — a re-fetch would not store either.
    // ARMED but nothing landed → the GCS write failed → `store-failed`,
    // retryable, so the 21:45 run re-fetches instead of skipping bytes we
    // do not actually have. The night the archive was first armed, these
    // were recorded as terminal `fetched` and the whole evening's files
    // needed manual recovery.
    const mode = resolveFeedArchiveMode();
    const outcome = mode === "archive" ? "store-failed" : "fetched";
    log.warn(
      `${family.id}: ${outcome === "store-failed" ? "STORE FAILED for" : "fetched (NOT stored)"} ${buf.length} bytes (mode=${mode})`,
    );
    return {
      id: family.id,
      outcome,
      bytes: buf.length,
      detail: `archive mode=${mode}`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`${family.id}: ${detail}`);
    return { id: family.id, outcome: "failed", detail };
  }
}

/**
 * Registry-vs-live drift guard.
 *
 * Polls NSE's own `daily-reports?key=…` index for each section and reports what
 * is NEW since the last observation, so a report NSE starts publishing shows up
 * in the logs the week it appears rather than whenever someone next reads the
 * docs.
 *
 * Strictly WARN-only and fully swallowed: this is an observability feature
 * riding a job whose real work is archiving, and it must never be able to fail
 * that. Returns the observed keys so they become the next run's baseline.
 */
interface DriftSweep {
  /** Every fileKey observed this sweep — the next run's baseline. */
  observed: string[];
  /** Of those, the ones no registry family claims (coverage, not an alert). */
  unregistered: string[];
}

async function runDriftGuard(
  priorRuns: ReadonlyArray<{ metadata: unknown }>,
): Promise<DriftSweep | null> {
  const observed = new Set<string>();
  let succeeded = 0;

  for (const key of DRIFT_GUARD_KEYS) {
    // `fetchNseApiJson` never throws — it returns null on 403, an Akamai
    // challenge page, a timeout or bad JSON. So success has to be counted, not
    // assumed from the absence of an exception.
    const payload = await fetchNseApiJson(
      `/api/daily-reports?key=${encodeURIComponent(key)}`,
    );
    if (payload === null) {
      log.warn(`drift guard: ${key} returned nothing (blocked or malformed)`);
    } else {
      succeeded++;
      for (const fileKey of extractFileKeys(payload)) observed.add(fileKey);
    }
    await sleep(FETCH_DELAY_MS);
  }

  // A sweep where NOTHING answered must not be persisted as an observation.
  //
  // The session cookie is cached for five minutes, so a single Akamai
  // challenge poisons all twelve keys and the sweep yields []. Storing that as
  // "what NSE published this week" would make next week report ~200 keys
  // DISAPPEARED and the week after ~200 NEW — pure noise, from a fail-open
  // default cached as a value. Returning null leaves the last GOOD baseline in
  // place, which is the whole point of keeping one.
  if (succeeded === 0) {
    log.warn(
      `drift guard: ALL ${DRIFT_GUARD_KEYS.length} sections failed — NOT ` +
        `recording an observation. The previous baseline stands.`,
    );
    return null;
  }

  const current = [...observed].sort();

  // Registry fileKeys, NOT family ids.
  //
  // The first version compared NSE's fileKeys ("EGR-NCL-CONTRACT-DELTA")
  // against our internal ids ("nse-egr-bhavcopy") — two namespaces that never
  // intersect, so `unregistered` was always the ENTIRE observed set and the
  // baseline line printed an alarming, meaningless number. Only families that
  // declare `nseFileKeys` can participate, so the coverage is stated rather
  // than implied.
  const registryKeys = new Set<string>(
    allFamilies().flatMap((f) => [...(f.nseFileKeys ?? [])]),
  );
  const diff = diffObservedFileKeys(
    previousObservedKeys(priorRuns),
    current,
    registryKeys,
  );

  if (diff.baseline) {
    log.info(
      `drift guard: BASELINE established with ${current.length} fileKeys from ` +
        `${succeeded}/${DRIFT_GUARD_KEYS.length} sections. ` +
        `${registryKeys.size} fileKey(s) are mapped to registry families so far, ` +
        `so "unregistered" is not yet a meaningful count. No warnings on a ` +
        `first run — next week's diff is the real signal.`,
    );
    return { observed: current, unregistered: diff.unregistered };
  }

  if (diff.added.length > 0) {
    log.warn(
      `drift guard: NSE published ${diff.added.length} NEW fileKey(s) since ` +
        `the last check — consider adding registry entries: ${diff.added.join(", ")}`,
    );
  }
  if (diff.removed.length > 0) {
    log.warn(
      `drift guard: ${diff.removed.length} fileKey(s) DISAPPEARED: ${diff.removed.join(", ")}`,
    );
  }
  if (diff.added.length === 0 && diff.removed.length === 0) {
    log.info(`drift guard: no change (${current.length} fileKeys)`);
  }

  // MONEY-1238 — `unregistered` finally has a reader. Deliberately INFO and
  // deliberately not an alert: it is a standing count (~150 keys the registry
  // does not claim), and a number that is large every week is coverage, not a
  // signal. `added`/`removed` above remain the alert. Reported as a RATIO so
  // the line says something on its own instead of needing the registry beside
  // it, and persisted onto the run so week-over-week movement is queryable.
  log.info(
    `drift guard: ${diff.unregistered.length}/${current.length} observed ` +
      `fileKey(s) are claimed by NO registry family (coverage: ` +
      `${current.length - diff.unregistered.length}/${current.length})`,
  );

  return { observed: current, unregistered: diff.unregistered };
}
