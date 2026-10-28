/**
 * Historical feed backfill — MONEY-941 (Data Engine P3).
 *
 * Walks every backfillable registry family day by day and pushes the bytes
 * through `getFeedAsset` into the GCS feed archive, checkpointing each
 * (family, date) so the run is resumable.
 *
 * ## Why a Cloud Run JOB and not the push worker
 *
 * `report-archive-sync` is a Pub/Sub push handler with a 600s ack deadline;
 * this walks ~30 years at 1 rps and runs for hours. Putting it behind Pub/Sub
 * would guarantee redelivery mid-run and two walkers racing the same days.
 * A Job has no ack deadline, is restartable, and can be sharded by family
 * across several invocations.
 *
 * ## The rule everything else follows from
 *
 * **A 404 is a gap, never the end of history.** P1 established that NSE's
 * archive is sparse and non-monotonic — 1994-11-03 present, 11-04 a genuine
 * 404, 12-01 present again. Any walker that stops at the first miss, or
 * bisects for an edge, silently amputates whatever lies beyond the hole and
 * then reports success. So misses are checkpointed as MISSING and the walk
 * continues; only K consecutive weekday misses BELOW the declared floor end a
 * range (see `shouldEndRange`).
 *
 * Related: `nse-holidays.ts` covers FY26-27 only, so the walker must not
 * consult it for historical years. Weekend-skip plus 404-as-gap is the whole
 * calendar rule.
 *
 * ## Usage
 *
 *   node --import tsx scripts/jobs/feed-backfill.ts --dry-run
 *   node --import tsx scripts/jobs/feed-backfill.ts \
 *     --families=nse-cm-legacy --from=1994-11-01 --to=2024-07-05 --rps=1
 *
 * Env equivalents (for the Cloud Run Job): BACKFILL_FAMILIES, BACKFILL_FROM,
 * BACKFILL_TO, BACKFILL_RPS, BACKFILL_EXPLORE_DAYS.
 *
 * ## `--special-sessions` (MONEY-1613)
 *
 * Walks EXACTLY the weekend special-session calendar
 * (`india-special-sessions.ts`) instead of weekdays, for the families the
 * four India lake tables read — minus `bse-cm-legacy`, whose files have no
 * date column and so can never prove a session — unless `--families` says
 * otherwise. A file is
 * archived only when its OWN date column is the requested day
 * (`checkSessionDate`, applied inside `getFeedAsset` before the write):
 *
 *   another day's file (a stale or next-day copy)  MISSING  [session-date] …
 *   no date column / unreadable / mixed dates      ERROR    [session-date] …
 *   HTML (BSE legacy, niftyindices)                ERROR    [payload] …
 *   404                                            MISSING  404
 *
 *   node --import tsx scripts/jobs/feed-backfill.ts --special-sessions --dry-run
 *
 * Run it on PROD, where `FEED_ARCHIVE_MODE=archive`. QA receives the bytes via
 * the nightly feeds mirror rather than by walking the exchanges a second time.
 */

import { prisma } from "@usemoney/database";
// MONEY-1205 T5 — Cloud Run JOBS pin their image at provision time, so this
// process can be running code weeks older than the deployed service with no
// outward sign. This prints the commit it is actually running.
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
// This job is its OWN entry point — it does NOT boot through workers/src/index.ts,
// which is where initFeedArchive() is called for the push worker. Importing it
// here is what actually wires the GCS store behind getFeedAsset. See
// requireArchiveWired() below for why forgetting this is not a survivable bug.
import { initFeedArchive } from "../../workers/src/lib/feed-archive-store";
import {
  familiesForBackfill,
  getFeedAsset,
  getFeedArchiveStore,
  validateFeedPayload,
  BSE_REFERER,
  NSE_REFERER,
  resolveFeedArchiveMode,
  type ReportFamily,
  isoDay,
  planFamily,
  planSpecialSessions,
  specialSessionCandidateDates,
  checkSessionDate,
  FAMILIES_WITHOUT_DATE_COLUMN,
  emptyFeedAssetOutcome,
  advanceRange,
  shouldEndRange,
  emptyHostState,
  noteHostOutcome,
  hostIsPaused,
  backfillBackoffMs,
  shouldAbort,
  emptyErrorRuns,
  advanceErrorRuns,
  type FeedErrorKind,
  type ErrorRuns,
  emptyTally,
  summarizeFamily,
  DEFAULT_K_MISS,
  DEFAULT_TRANSPORT_STOP_LOSS,
  DEFAULT_PAYLOAD_STOP_LOSS,
  shouldTryDoor,
  type FamilyTally,
  type HostState,
  type RangeState,
} from "@usemoney/core/market-data";
import { allIndiaFamilies } from "@usemoney/lake/india-sink-logic";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

// ─── Args ────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const arg = (name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const DRY_RUN = argv.includes("--dry-run");
const SPECIAL_SESSIONS = argv.includes("--special-sessions");
const FAMILIES = (arg("families") ?? process.env.BACKFILL_FAMILIES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const FROM = arg("from") ?? process.env.BACKFILL_FROM ?? "1994-01-01";
const TO = arg("to") ?? process.env.BACKFILL_TO ?? isoDay(new Date());
const RPS = Number(arg("rps") ?? process.env.BACKFILL_RPS ?? 1) || 1;
const EXPLORE_DAYS = Number(
  arg("explore") ?? process.env.BACKFILL_EXPLORE_DAYS ?? 0,
);
const K_MISS = Number(arg("kmiss") ?? DEFAULT_K_MISS) || DEFAULT_K_MISS;

const MIN_INTERVAL_MS = Math.max(1, Math.round(1000 / RPS));

const log = {
  info: (...a: unknown[]) => console.log("[feed-backfill]", ...a),
  warn: (...a: unknown[]) => console.warn("[feed-backfill]", ...a),
};

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
async function pace(): Promise<void> {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

// ─── Checkpoints ─────────────────────────────────────────────────────

/** Days already terminal for a family, as `YYYY-MM-DD`. */
async function loadCheckpoints(family: string): Promise<Set<string>> {
  const rows = await prisma.feedBackfillProgress.findMany({
    where: { family, status: { in: ["DONE", "MISSING"] } },
    select: { date: true },
  });
  return new Set(rows.map((r) => isoDay(r.date)));
}

/**
 * Record one day's outcome. Upsert on the compound unique so a job that dies
 * mid-day and restarts cannot double-write.
 */
async function checkpoint(
  family: string,
  day: Date,
  status: "DONE" | "MISSING" | "ERROR",
  bytes: number,
  detail?: string,
): Promise<void> {
  if (DRY_RUN) return;
  const date = new Date(`${isoDay(day)}T00:00:00.000Z`);
  await prisma.feedBackfillProgress.upsert({
    where: { family_date: { family, date } },
    create: { family, date, status, bytes, detail },
    update: { status, bytes, detail, at: new Date() },
  });
}

// ─── One day ─────────────────────────────────────────────────────────

type DayOutcome = {
  status: "DONE" | "MISSING" | "ERROR";
  /** Set only when status is ERROR. Decides which stop-loss the day feeds. */
  kind?: FeedErrorKind;
  bytes: number;
  detail?: string;
};

/** Is this a throttle rather than an ordinary failure? */
function isThrottle(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return m.includes("403") || m.includes("429");
}

async function fetchDay(
  family: ReportFamily,
  day: Date,
  hosts: Map<string, HostState>,
): Promise<DayOutcome> {
  const url = family.buildUrl(day);
  if (!url)
    return { status: "MISSING", bytes: 0, detail: "no URL for this date" };

  const host = new URL(url).host;
  const state = hosts.get(host) ?? emptyHostState();

  if (hostIsPaused(state, Date.now())) {
    const secs = Math.ceil((state.pausedUntil - Date.now()) / 1000);
    log.warn(`${host} paused for ${secs}s more — sleeping`);
    await sleep(state.pausedUntil - Date.now());
  }

  const referer = family.exchange === "BSE" ? BSE_REFERER : NSE_REFERER;
  const descriptor = {
    exchange: family.exchange,
    feed: family.feed,
    date: day,
    basename: family.buildBasename?.(day),
  };
  // MONEY-1613 — on a special-session date the file must BE that day's
  // session. Checked inside the seam before the archive write, so a stale copy
  // of another day is never archived under a weekend key, and again below to
  // name the outcome.
  const sessionCheck = SPECIAL_SESSIONS
    ? (b: Buffer) => checkSessionDate(b, isoDay(day))
    : undefined;

  for (let attempt = 0; attempt < 3; attempt++) {
    await pace();
    try {
      const outcome = emptyFeedAssetOutcome();
      const res = await getFeedAsset(
        url,
        referer,
        descriptor,
        outcome,
        undefined,
        sessionCheck,
      );
      hosts.set(host, noteHostOutcome(state, false, Date.now()));

      // 404 — a GAP, not an error and not the end of history.
      if (!res) return { status: "MISSING", bytes: 0, detail: "404" };

      const buf = Buffer.from(await res.arrayBuffer());
      const check = validateFeedPayload(descriptor, url, buf);
      if (!check.ok) {
        // A 200 whose body is not this feed — a holiday notice, an interstitial,
        // or a throttle page. Which of those it is CANNOT be told from the
        // bytes, so it stays ERROR rather than MISSING: MISSING is terminal, and
        // a throttled day recorded MISSING becomes a permanent silent gap that
        // resume never revisits.
        //
        // `payload` is what keeps that safe choice from aborting the walk. The
        // host answered, so this is not evidence it stopped serving us.
        return {
          status: "ERROR",
          kind: "payload",
          bytes: buf.length,
          detail: `[payload] ${check.reason}`,
        };
      }
      const session = sessionCheck?.(buf);
      if (session && !session.ok) {
        // Another day's file is a definite "no session under this key", so it
        // is terminal. Anything it could not prove is retried.
        return session.terminal
          ? {
              status: "MISSING",
              bytes: 0,
              detail: `[session-date] ${session.reason}`,
            }
          : {
              status: "ERROR",
              kind: "payload",
              bytes: buf.length,
              detail: `[session-date] ${session.reason}`,
            };
      }
      if (resolveFeedArchiveMode() === "archive" && !outcome.stored) {
        // DONE is terminal, so it must mean the object EXISTS. A write that
        // failed or timed out is retried next run, and counts toward the
        // transport stop-loss: a storage outage makes every fetch discarded
        // exchange traffic, exactly like a host that stopped serving us.
        return {
          status: "ERROR",
          kind: "transport",
          bytes: buf.length,
          detail:
            "[archive] fetched but not stored — write failed or timed out",
        };
      }
      return { status: "DONE", bytes: buf.length };
    } catch (err) {
      const throttled = isThrottle(err);
      const next = noteHostOutcome(state, throttled, Date.now());
      hosts.set(host, next);

      // Archives-door fallback (P1 CONFIRMED the door serves old dates).
      //
      // Tried BEFORE the 15-minute host pause, because a successful door fetch
      // means the walk never has to pause at all. Gated on the family having a
      // CONFIRMED descriptor — `shouldTryDoor` returns false without one, and
      // that gate is the important half: a guessed door name 404s exactly like
      // an absent file, so the walk would record MISSING for days that exist.
      // No family carries a confirmed descriptor today (see
      // `ReportFamily.doorDescriptor`), so this is armed but dormant.
      if (
        shouldTryDoor(next.consecutiveThrottles, Boolean(family.doorDescriptor))
      ) {
        log.warn(
          `${family.id} ${isoDay(day)}: ${next.consecutiveThrottles} throttles ` +
            `on ${host} — the archives door would be tried here once a ` +
            `confirmed doorDescriptor exists for this family.`,
        );
      }

      if (!throttled || attempt === 2) {
        // The request itself failed — 403/429 after retries, a socket error, a
        // 5xx, a timeout. This is the only kind of failure that is evidence the
        // host stopped serving us, so it is the only kind that may abort a run.
        return {
          status: "ERROR",
          kind: "transport",
          bytes: 0,
          detail: `[transport] ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      await sleep(backfillBackoffMs(attempt));
    }
  }
  return {
    status: "ERROR",
    kind: "transport",
    bytes: 0,
    detail: "[transport] retries exhausted",
  };
}

// ─── Main ────────────────────────────────────────────────────────────

/**
 * Refuse to walk when the archive is meant to be on but is not wired.
 *
 * This exists because the failure it guards is INVISIBLE. `getFeedAsset`
 * returns a perfectly good Response whether or not a store is registered, so a
 * job with no store fetches every file correctly, counts it as archived, writes
 * a DONE checkpoint — and discards the bytes. The run reports success.
 *
 * It is worse than a plain no-op: resume skips terminal checkpoints, so the
 * next run walks straight past those days and the gap becomes permanent and
 * silent. That is exactly what happened on the first prod walk — 397
 * bse-index-history and 54 nse-cm-legacy days recorded DONE with zero objects
 * in GCS. Hours of exchange traffic spent to store nothing.
 *
 * A crash on line one is strictly better than a walk that lies.
 */
function requireArchiveWired(): void {
  const mode = resolveFeedArchiveMode();
  if (mode === "off") return;

  if (!getFeedArchiveStore()) {
    throw new Error(
      `FEED_ARCHIVE_MODE=${mode} but no feed archive store is registered. ` +
        `initFeedArchive() did not wire one — check GCP_STORAGE_BUCKET is set. ` +
        `Refusing to walk: every fetch would be discarded and checkpointed DONE.`,
    );
  }
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Without this the job logs to
  // stdout only: `initLogger()` had exactly one caller in the whole repo.
  await initJobTelemetry();
  reportBuildProvenance(log, "feed-backfill");

  initFeedArchive();
  requireArchiveWired();
  if (SPECIAL_SESSIONS && !DRY_RUN && resolveFeedArchiveMode() !== "archive") {
    // PROD-ONLY: outside archive mode every fetch is exchange traffic whose
    // bytes are discarded.
    throw new Error(
      `--special-sessions needs FEED_ARCHIVE_MODE=archive (prod); it is ` +
        `${resolveFeedArchiveMode()}. Refusing to fetch from NSE/BSE.`,
    );
  }

  const candidates = SPECIAL_SESSIONS ? specialSessionCandidateDates() : [];
  const plans = familiesForBackfill(
    FROM,
    TO,
    FAMILIES.length
      ? FAMILIES
      : SPECIAL_SESSIONS
        ? allIndiaFamilies().filter(
            (f) => !FAMILIES_WITHOUT_DATE_COLUMN.includes(f),
          )
        : undefined,
  );

  log.info(
    `${plans.length} families, ${FROM}..${TO}, ${RPS} rps, K-miss ${K_MISS}` +
      `${EXPLORE_DAYS ? `, exploring ${EXPLORE_DAYS}d below each floor` : ""}` +
      `${DRY_RUN ? " (DRY RUN)" : ""}`,
  );
  log.info(`archive mode: ${resolveFeedArchiveMode()}`);
  if (resolveFeedArchiveMode() !== "archive" && !DRY_RUN) {
    log.warn(
      "FEED_ARCHIVE_MODE is not 'archive' — bytes will be fetched and DISCARDED. " +
        "Run this on prod, or the entire walk accomplishes nothing durable.",
    );
  }

  const hosts = new Map<string, HostState>();
  let totalErrors = 0;
  /**
   * Families abandoned by the PAYLOAD stop-loss — MONEY-1238. Not fatal (a feed
   * that did not exist in the requested era is a legitimate outcome of a
   * historical backfill), but it means the family got NO data, so it must not
   * vanish into a mid-run warn line that scrolls past.
   */
  const abandonedFamilies: string[] = [];
  // Deliberately spans families: a host that has stopped serving us does not
  // recover because the walk moved to the next family on the same host. The
  // PAYLOAD streak is per-family instead (declared inside the loop) — a wrong
  // URL era is a property of one family, not of the host.
  let runs: ErrorRuns = emptyErrorRuns();

  for (const { family, from, to } of plans) {
    const done = DRY_RUN ? new Set<string>() : await loadCheckpoints(family.id);
    const plan = SPECIAL_SESSIONS
      ? planSpecialSessions(family, from, to, done, candidates)
      : planFamily(family, from, to, done, EXPLORE_DAYS);

    log.info(
      `${family.id}: ${plan.days.length} ` +
        `${SPECIAL_SESSIONS ? "special-session dates" : "weekdays"} to walk ` +
        `(${done.size} already checkpointed) ${from}..${to}`,
    );
    if (DRY_RUN) continue;

    let range: RangeState = { consecutiveMisses: 0, belowFloor: false };
    const tally: FamilyTally = emptyTally();

    for (const day of plan.days) {
      const out = await fetchDay(family, day, hosts);
      await checkpoint(family.id, day, out.status, out.bytes, out.detail);

      if (out.status === "DONE") {
        tally.done++;
        tally.bytes += out.bytes;
      } else if (out.status === "MISSING") {
        tally.missing++;
      } else {
        tally.error++;
        totalErrors++;
      }

      runs = advanceErrorRuns(runs, out.status, out.kind, day);

      range = advanceRange(range, out.status, isoDay(day), plan.floorIso);
      if (shouldEndRange(range, K_MISS)) {
        log.info(
          `${family.id}: ${range.consecutiveMisses} consecutive weekday misses ` +
            `below the declared floor (${plan.floorIso}) — treating ${isoDay(day)} ` +
            `as the true edge of history and moving on.`,
        );
        break;
      }

      // TRANSPORT stop-loss — kills the whole run. The host is refusing us, and
      // moving to the next family would just keep hammering the same host.
      if (shouldAbort(runs.transport, DEFAULT_TRANSPORT_STOP_LOSS)) {
        log.warn(
          `STOP-LOSS (transport): ${runs.transport} consecutive request ` +
            `failures — aborting the run (${totalErrors} total errors). The ` +
            `host is not serving us. Checkpoints are saved, so re-running ` +
            `resumes here.`,
        );
        log.info(summarizeFamily(family.id, tally));
        // A deliberate abort is still a FAILED RUN — MONEY-1238. This `return`
        // resolved main() normally, so the `.catch` below never ran and
        // `process.exitCode` stayed 0: `feed-backfill-prod` reported SUCCEEDED
        // while NSE was refusing our egress and the backfill had stopped early.
        // Set rather than thrown, so the job status is honest without the run
        // being reported as a crash — the checkpoints ARE saved and re-running
        // genuinely does resume here, which a stack trace would misrepresent.
        process.exitCode = 1;
        return;
      }

      // PAYLOAD stop-loss — skips THIS family only. The host is answering 200
      // for every one of these days but the body is never this feed, which means
      // the URL pattern is wrong for this era, not that the host is unwell.
      // Measured on calendar-adjacent weekdays so a RESUMED plan — where past
      // errors arrive back-to-back while sitting months apart — cannot trip it.
      if (runs.payload >= DEFAULT_PAYLOAD_STOP_LOSS) {
        log.warn(
          `STOP-LOSS (payload): ${runs.payload} consecutive trading days where ` +
            `${family.id} answered 200 with something that is not this feed ` +
            `(through ${isoDay(day)}). Skipping this family — its URL pattern ` +
            `is likely wrong for this era. Other families continue.`,
        );
        abandonedFamilies.push(family.id);
        break;
      }
    }

    log.info(summarizeFamily(family.id, tally));
  }

  if (abandonedFamilies.length > 0) {
    // Reported at the END, where it cannot scroll away, and in the same line
    // the operator reads to decide whether the backfill worked.
    log.warn(
      `Backfill finished, but ${abandonedFamilies.length} family(ies) were ` +
        `ABANDONED by the payload stop-loss and hold no data for this range: ` +
        `${abandonedFamilies.join(", ")}. Their URL pattern is likely wrong ` +
        `for this era — confirm before treating the range as covered.`,
    );
  }
  log.info("Backfill complete.");
}

main()
  .catch((err: unknown) => {
    console.error("[feed-backfill] failed:", err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
