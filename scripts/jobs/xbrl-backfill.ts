/**
 * XBRL financials backfill — MONEY-1114 (Data Engine P10 F2).
 *
 * Walks NSE's results index month by month and lands every filing's XBRL into
 * `XbrlFiling`. Same ingest path as the nightly `xbrl-sync` worker — this is
 * only a different WINDOW, deliberately: a backfill that reimplements the write
 * is a backfill that drifts from the nightly one, and then the two disagree
 * about history in ways nobody notices until a chart looks wrong.
 *
 * ## Scope: 2018 onward, and that is a measured fact
 *
 * A filing with no XBRL still carries a well-formed URL ending in a bare dash
 * (`.../corporate/xbrl/-`). It 404s, but it starts with "http", so a
 * `startsWith('http')` check reports ~100% coverage for every year back to
 * 2012. Measured on the `.xml` suffix:
 *
 *     Jul-2012 → Feb-2018    0%     (every record is the stub)
 *     May-2018              89%
 *     Aug-2018              67%
 *     Nov-2018              97%
 *     2019 →                97-98%
 *
 * So `--from-year` defaults to 2018. Walking earlier costs requests and returns
 * nothing but stubs — and, worse, would make the run's own `stubbed` counter
 * look alarming when it is simply describing history.
 *
 * ## Resume is FREE — there is no checkpoint table on purpose
 *
 * `processXbrlSync` skips a filing it already holds BEFORE downloading it, so
 * re-running a month costs one indexed read per record instead of a network
 * round trip. That makes the whole backfill idempotent and interruptible with
 * no extra state to get out of sync with reality.
 *
 * A checkpoint table would be actively worse here. The MONEY-1189 postmortem is
 * a catalogue of checkpoints that recorded DONE for work that had not happened,
 * because the checkpoint was written at a coarser granularity than the thing it
 * described. The database rows ARE the checkpoint here, at exactly the
 * granularity that matters.
 *
 * ## Two indexes, and TWO periods on the older one
 *
 * SEBI's integrated-filing regime split NSE's index in two at the quarter
 * ending Dec-2024. `processXbrlSync` walks whichever index serves the window.
 *
 * This paragraph used to continue: "and walks BOTH when the window straddles
 * the seam. The monthly stride here keeps windows small enough that the seam is
 * crossed exactly once." Both sentences were true and together they were a
 * DEFECT — MONEY-1250. `monthWindows` emits calendar months, and a calendar
 * month never straddles a 1-January boundary, so the straddle rule could not
 * fire for ANY window this script generates. Every 2025 month walked the modern
 * index alone, while the Dec-2024 quarter was still being broadcast through the
 * LEGACY one: 3,901 legacy records over Jan-Mar 2025, ~3,822 of them carrying
 * `qe_Date` 2024-12-31, and prod holding **zero** filings for periodEnd
 * 2024-12-31 against 2,717 for 2024-09-30 and 7,561 for 2025-03-31.
 *
 * The stride is not the bug and is unchanged. Era selection is now
 * `erasForWindow` (`workers/src/processors/xbrl-sync-logic.ts`), which walks
 * both indexes for any window touching the measured OVERLAP PERIOD
 * (2025-01-01 .. 2025-06-30) as well as for a genuine straddle. Re-running
 * `--from=2025-01 --to=2025-06` is what recovers the quarter; the months are
 * cheap because everything already stored is skipped before download.
 *
 * The legacy index also needs `?period=`, which is REQUIRED and takes exactly
 * `Quarterly` or `Annual` (MONEY-1114). It ships hardcoded to Quarterly before
 * this ticket, which is why the whole table was quarterly. Both are walked now,
 * and the results are deduplicated by document — NSE lists the same Q4 XML under
 * both periods.
 *
 * ## Every month of this backfill is a LEGACY month, which is why paging matters
 *
 * 2018-2024 is entirely pre-regime, and the legacy index does not paginate: it
 * ignores `size` and `page` and answers the whole window in one body. Before
 * MONEY-1114 the paging loop therefore re-requested the identical response until
 * its 40-page cap on every month with more than `PAGE_SIZE` records — which is
 * most of them. That is 40 index round trips and a 40x-inflated entry list per
 * month per period, and it lands on THIS script rather than on the nightly job,
 * whose windows are all integrated-era.
 *
 * ## `--annual-existing` — the annual rows for filings already stored
 *
 * A March-quarter document contains the full financial year as a second
 * context, and `xbrl-sync` now writes both rows at ingest. Rows stored BEFORE
 * that are unreachable by a re-run (the pre-download skip) and cannot be fixed
 * from the database either: `XbrlFiling.facts` holds the quarter's values, and
 * `otherPeriods` holds dates with no figures. `--annual-existing` re-reads each
 * stored row's XML and writes the companion.
 *
 * Measured on prod 2026-08-19: of 2,152 stored rows, 2,127 have periodEnd
 * 2026-06-30 — a Q1 filing, whose year-to-date column IS its quarter, so it has
 * no annual context at all. Only the ~20 rows at a March period-end can yield
 * one. This pass is therefore small and cheap TODAY; it exists so that nothing
 * is stranded, not because it is where the annual history comes from. That comes
 * from the ordinary walk below.
 *
 * ## `--archive-existing` — the rows the ingest can no longer reach
 *
 * MONEY-1204 routed `xbrl-sync`'s download through `getFeedAsset`, so from that
 * point on every filing it fetches is archived to
 * `feeds/NSE/results-xbrl/{YYYY}/{MM}/`. Every filing ingested BEFORE that is
 * in `xbrl_filings` with no archived XML — and unreachable by a re-run, because
 * `processXbrlSync` skips a stored filing BEFORE the download. That is the
 * whole point of the skip and it must not be weakened: it is what makes the
 * trailing window cheap.
 *
 * So `--archive-existing` is a SEPARATE pass, not a flag threaded into the
 * ingest. It walks stored rows, probes the archive for each row's object, and
 * re-fetches only the misses through the same `fetchXml` the worker uses. It
 * writes nothing to the database — `XbrlFiling` is already correct; what is
 * missing is bytes in GCS.
 *
 * It is OPT-IN and its first useful form is `--dry-run`, which COUNTS the
 * missing objects and stops. Knowing the number before spending it on NSE
 * traffic is the point: the answer decides whether this is a five-minute job or
 * a multi-day one.
 *
 * Usage:
 *   npx tsx scripts/jobs/xbrl-backfill.ts --dry-run
 *   npx tsx scripts/jobs/xbrl-backfill.ts --from-year=2018 --to-year=2024
 *   npx tsx scripts/jobs/xbrl-backfill.ts --from=2024-01 --to=2024-03
 *   npx tsx scripts/jobs/xbrl-backfill.ts --archive-existing --dry-run
 *   npx tsx scripts/jobs/xbrl-backfill.ts --archive-existing
 *   npx tsx scripts/jobs/xbrl-backfill.ts --annual-existing --dry-run
 *   npx tsx scripts/jobs/xbrl-backfill.ts --annual-existing
 *
 * For a SMALL, targeted run the wrapper pulls DATABASE_URL from Secret Manager
 * rather than having it pasted in by hand:
 *   ./scripts/ops/run-market-data-job.sh xbrl prod --apply --from=2024-05 --to=2024-05
 *
 * It sets no GCS env, so the fetch passes through `getFeedAsset` WITHOUT
 * archiving. That is fine for a spot check and wrong for the walk.
 *
 * ## …but a LAPTOP IS NOT AN ACCEPTABLE HOST for the full walk
 *
 * Seven years at ~2,500 filings a month is on the order of 200,000 downloads at
 * 600 ms apiece — over a day of continuous running. Two agents lost their runs
 * to machine sleep on 2026-08-19. This ships as the Cloud Run job
 * `xbrl-backfill-{env}` (`scripts/ops/setup-feed-backfill-job.sh`, 24 h task
 * timeout), and the shard commands are in
 * `docs/reference/xbrl-backfill-report.md`.
 */

import prisma, { Prisma } from "@usemoney/database";
import {
  processXbrlSync,
  fetchXml,
  backfillAnnualFromXml,
  RUN_TIME_BUDGET_MS,
  DOWNLOAD_DELAY_MS,
  type AnnualBackfillOutcome,
} from "../../workers/src/processors/xbrl-sync";
// This job is its OWN entry point — it does NOT boot through
// workers/src/index.ts, which is where initFeedArchive() is called for the push
// worker. Importing it here is what actually wires the GCS store behind
// getFeedAsset. See requireArchiveWired() below for why forgetting it is not a
// survivable bug.
import { initFeedArchive } from "../../workers/src/lib/feed-archive-store";
import {
  getFeedArchiveStore,
  resolveFeedArchiveMode,
} from "@usemoney/core/market-data";
// MONEY-1252 — one archive-key grammar, shared with the re-parse job.
import { candidateArchiveKeysForFiling } from "../../workers/src/processors/xbrl-sync-logic";
// MONEY-1205 T5 — Cloud Run JOBS pin their image at provision time and a deploy
// of the SERVICE does not move them, so this job can run weeks-old code, exit 0
// and report success while skipping work it has never heard of. The only place
// that drift is observable is this line.
import { reportBuildProvenance } from "@usemoney/core/ops/build-provenance";
import { initJobTelemetry } from "../../workers/src/lib/job-telemetry";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

const DRY_RUN = argv.includes("--dry-run");

/**
 * Re-fetch stored filings whose archived XML is missing. Default OFF.
 *
 * Off by default because it is the only mode here that costs NSE traffic for
 * data we already hold: `XbrlFiling` is complete, only GCS is not. Combine with
 * `--dry-run` to get the count first.
 */
const ARCHIVE_EXISTING = argv.includes("--archive-existing");

/**
 * Derive the ANNUAL companion row for filings ALREADY stored. Default OFF.
 *
 * MONEY-1114's other half. `processXbrlSync` writes the annual row at ingest
 * from here on, but it skips a filing it already holds BEFORE the download —
 * deliberately, that is what makes the trailing window cheap — so rows ingested
 * before this shipped are unreachable by a re-run.
 *
 * It cannot be done from the database. `XbrlFiling.facts` is the parsed
 * `XbrlFinancials` for the QUARTER; its `otherPeriods` record that a full year
 * existed but carry dates only, with no figures. The numbers are in the XML and
 * nowhere else, so this pass re-reads it.
 *
 * Combine with `--dry-run` to count the eligible rows without any NSE traffic.
 */
const ANNUAL_EXISTING = argv.includes("--annual-existing");

/** Stop the archive-existing / annual-existing pass after N rows. 0 = no cap. */
const ARCHIVE_LIMIT = Number(arg("limit") ?? 0);

/**
 * Download-phase budget per monthly window, in SECONDS. Default 4 hours.
 *
 * `processXbrlSync`'s own 480 s default is sized for the Pub/Sub push worker's
 * un-raisable 600 s ack deadline. This is a Cloud Run JOB with a 24 h task
 * timeout and no ack deadline at all, so inheriting 480 s would abandon most of
 * a ~3,000-filing month after eight minutes, mark it `truncatedByBudget`, and
 * move on — and each recovery pass would re-pay the per-entry existence check
 * for everything it already has.
 *
 * Four hours at 600 ms apiece is ~24,000 filings, comfortably more than any
 * month holds, while still bounding a single window so a stuck month cannot
 * consume the whole 24 h task.
 */
const WINDOW_BUDGET_MS = Number(arg("window-budget-sec") ?? 4 * 3600) * 1000;

/** Rows per keyset page when walking `xbrl_filings`. */
const ARCHIVE_PAGE = 500;

/**
 * 2018, because 2012→Feb-2018 is 0% XBRL. See the header — this is the number
 * a `startsWith('http')` check gets wrong by six years.
 */
const DEFAULT_FROM_YEAR = 2018;

const log = {
  info: (...a: unknown[]) => console.log("[xbrl-backfill]", ...a),
  warn: (...a: unknown[]) => console.warn("[xbrl-backfill]", ...a),
};

/** `YYYY-MM` → {y, m} (1-based month), or null. */
function parseMonth(s: string | undefined): { y: number; m: number } | null {
  if (!s) return null;
  const hit = /^(\d{4})-(\d{1,2})$/.exec(s.trim());
  if (!hit) return null;
  const y = Number(hit[1]);
  const m = Number(hit[2]);
  if (m < 1 || m > 12) return null;
  return { y, m };
}

interface MonthWindow {
  label: string;
  from: Date;
  to: Date;
}

/** Inclusive month range → one window per month, oldest first. */
function monthWindows(
  start: { y: number; m: number },
  end: { y: number; m: number },
): MonthWindow[] {
  const out: MonthWindow[] = [];
  let y = start.y;
  let m = start.m;
  while (y < end.y || (y === end.y && m <= end.m)) {
    const from = new Date(Date.UTC(y, m - 1, 1));
    // Day 0 of the NEXT month is the last day of this one — correct for
    // February and leap years without a table.
    const to = new Date(Date.UTC(y, m, 0));
    out.push({
      label: `${y}-${String(m).padStart(2, "0")}`,
      from,
      to,
    });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

// ─── The archive-existing pass (MONEY-1204 P0.2) ─────────────────────

/** Politeness between downloads. Same value the worker uses, for the same host. */
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Refuse to walk when the archive is meant to be on but is not wired.
 *
 * Lifted verbatim in intent from `feed-backfill.ts`, because the failure it
 * guards is IDENTICAL and INVISIBLE: `getFeedAsset` returns a perfectly good
 * Response whether or not a store is registered, so a job with no store fetches
 * every file correctly, counts it, and discards the bytes. The run exits 0 and
 * reports success.
 *
 * It applies to the ORDINARY backfill too, not just `--archive-existing`. That
 * is the bug that already existed here: the moment `xbrl-sync` started fetching
 * through the seam, every `processXbrlSync` call this script makes became an
 * archiving fetch — and this file called neither `initFeedArchive()` nor
 * anything that would notice its absence. `job-entrypoints-wire-archive.test.ts`
 * greps job sources for the literal `getFeedAsset` and so could not see it
 * either, since the call is one module away.
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
        `Refusing to walk: every filing would be fetched from NSE and thrown ` +
        `away while every counter reported success.`,
    );
  }
}

/** A stored filing, reduced to what deciding "is it archived?" needs. */
interface StoredFiling {
  id: string;
  symbol: string;
  sourceUrl: string;
  periodEnd: Date;
  filedAt: Date | null;
}

/**
 * Every archive key this row could plausibly be filed under.
 *
 * MOVED to `workers/src/processors/xbrl-sync-logic.ts` by MONEY-1252, which
 * needed the identical derivation for the re-parse job. Two copies of an
 * archive-key grammar is a stale-copy waiting to happen, and the grammar is
 * FROZEN (~66,950 objects per bucket) — a divergence would not be a bug to fix
 * but objects to migrate. See `candidateArchiveKeysForFiling` for the full
 * reasoning and for the 62-of-62 measurement against the live prod bucket.
 */
const candidateKeys = candidateArchiveKeysForFiling;

interface ArchiveExistingResult {
  scanned: number;
  missing: number;
  refetched: number;
  failed: number;
  /**
   * Rows whose archive probe THREW — MONEY-1238.
   *
   * The probe deliberately treats a read error as PRESENT, and that is the
   * right call: a read outage is not evidence of absence, and treating it as
   * one would re-scrape NSE for thousands of filings we already hold. But
   * "assumed present" and "confirmed present" are different facts, and folding
   * them together made a total IAM or 5xx outage — where every single probe
   * throws — print `MISSING 0` and exit 0, which reads as a fully archived
   * corpus. Counting them keeps the conservative behaviour while making the
   * verdict's basis visible. One increment per ROW at most: the loop breaks on
   * the first throw.
   */
  probeFailed: number;
  /** Rows left unscanned because a cap or the time budget ended the pass. */
  remaining: number;
  stoppedEarly: "limit" | "budget" | null;
}

/**
 * Walk stored filings, count the ones with no archived XML, and (unless this is
 * a dry run) re-fetch them.
 *
 * ## Presence is probed by DOWNLOAD, and that is the expensive part
 *
 * `FeedArchiveStore` exposes exactly `get(key)` and `put(...)` — there is no
 * `exists()` — so the cheapest presence probe available today pulls the object
 * back out of GCS. At ~50 KB a filing that is real egress, which is why
 * `--limit` exists and why the time budget applies to the DRY RUN as well as to
 * the apply.
 *
 * ## A count that stopped early says so
 *
 * `missing` is a FLOOR whenever `stoppedEarly` is set. A completeness number
 * reported at the wrong granularity — "we counted, here is the total" over a
 * partial scan — is the MONEY-1189 defect restated, and it is the one thing a
 * pass whose entire output is a number must not do.
 */
async function archiveExistingPass(
  from: Date,
  to: Date,
): Promise<ArchiveExistingResult> {
  const store = getFeedArchiveStore();
  if (!store) {
    throw new Error(
      "--archive-existing needs a feed archive store: it probes GCS for each " +
        "row's object. Set FEED_ARCHIVE_MODE=archive and GCP_STORAGE_BUCKET " +
        "(run this on prod, which is the env that owns the archive).",
    );
  }

  // The APPLY half additionally needs mode `archive`, and this check is not
  // redundant with the store check above.
  //
  // Under `replay` (QA) a store IS registered, so probing works and every
  // assertion in this function stays true — but `getFeedAsset` would serve the
  // archived bytes back or fall through to NSE and write NOTHING. The pass
  // would report `refetched: N` having archived zero: the MONEY-941 shape
  // exactly, in the one job written to repair it. The DRY RUN is allowed in any
  // mode with a store, because counting is a read.
  const mode = resolveFeedArchiveMode();
  if (!DRY_RUN && mode !== "archive") {
    throw new Error(
      `--archive-existing needs FEED_ARCHIVE_MODE=archive to WRITE (got ` +
        `"${mode}"). Under "replay" every re-fetch would be served from the ` +
        `archive or scraped from NSE and then discarded, while this pass ` +
        `counted it as re-fetched. Run it on prod, or add --dry-run to just ` +
        `count what is missing.`,
    );
  }

  const out: ArchiveExistingResult = {
    scanned: 0,
    missing: 0,
    refetched: 0,
    failed: 0,
    probeFailed: 0,
    remaining: 0,
    stoppedEarly: null,
  };

  // `filedAt: null` rows are ALWAYS included, never filtered out by the date
  // window. They are the modern index's Revisions (3 of 20 measured), and a
  // range filter on a nullable column silently excludes exactly the rows nobody
  // would think to look for.
  // NOT `as const`: Prisma's generated `XbrlFilingWhereInput` types `OR` as a
  // MUTABLE array, so a readonly tuple is rejected.
  //
  // THIS COMMENT USED TO SAY THE OPPOSITE, and it was wrong — MONEY-1236.
  //
  // It claimed `{ filedAt: null }` "matches an ABSENT field as well as an
  // explicitly null one — Mongo's own semantics". That is true of RAW Mongo and
  // false of PRISMA, which is the distinction that has now cost five tickets
  // (MONEY-1050, 1205, 1234, 1235, 1236). A `$runCommandRaw` body would behave
  // as the old comment described; a Prisma `where` does not.
  //
  // It happens to be harmless TODAY: `FilingIndexEntry.broadcastAt` and
  // `revisedAt` are `Date | null`, so `broadcastAt ?? revisedAt` yields `null`
  // rather than `undefined` and `storeFiling`'s `create:` writes the key
  // explicitly. Measured on prod 2026-08-21: 90,188 filings, 1,247 explicit
  // null, ZERO absent. The `isSet` arm is here so that stays true if either
  // field ever becomes optional — at which point the old comment would have
  // guaranteed nobody looked.
  const where: Prisma.XbrlFilingWhereInput = {
    exchange: "NSE",
    OR: [
      { filedAt: { gte: from, lte: to } },
      { filedAt: null },
      { filedAt: { isSet: false } },
    ],
  };

  const total = await prisma.xbrlFiling.count({ where });
  log.info(
    `archive-existing: ${total} stored filing(s) in scope` +
      `${DRY_RUN ? " (DRY RUN — counting only)" : ""}`,
  );

  const startedAt = Date.now();
  let cursor: string | undefined;

  for (;;) {
    const page: StoredFiling[] = await prisma.xbrlFiling.findMany({
      where,
      select: {
        id: true,
        symbol: true,
        sourceUrl: true,
        periodEnd: true,
        filedAt: true,
      },
      orderBy: { id: "asc" },
      take: ARCHIVE_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;

    for (const row of page) {
      if (ARCHIVE_LIMIT > 0 && out.scanned >= ARCHIVE_LIMIT) {
        out.stoppedEarly = "limit";
        break;
      }
      if (Date.now() - startedAt >= RUN_TIME_BUDGET_MS) {
        out.stoppedEarly = "budget";
        break;
      }

      // A stub URL never reaches `xbrl_filings`, but a row whose sourceUrl is
      // not an XML is not something this pass can re-fetch, and counting it as
      // "missing" would put a permanent floor under a number that is supposed
      // to reach zero.
      if (!row.sourceUrl.toLowerCase().endsWith(".xml")) continue;

      out.scanned++;

      let present = false;
      for (const key of candidateKeys(row)) {
        try {
          const bytes = await store.get(key);
          if (bytes && bytes.length > 0) {
            present = true;
            break;
          }
        } catch (err) {
          // A read outage is not evidence of absence. Treating it as one would
          // re-scrape NSE for thousands of filings we already hold.
          log.warn(`archive probe failed for ${key}: ${String(err)}`);
          out.probeFailed++;
          present = true;
          break;
        }
      }
      if (present) continue;

      out.missing++;
      if (DRY_RUN) continue;

      // Re-fetch through the SAME path the worker uses, so the headers, the
      // timeout, the payload check and the archive key all come from one place.
      // `periodEnd` stands in for the index's quarter-end here — see
      // `candidateKeys` for why they are the same date in practice, and why
      // being wrong costs a duplicate object rather than a wrong one.
      const xml = await fetchXml(row.sourceUrl, row.periodEnd);
      if (xml === null) {
        out.failed++;
        log.warn(
          `re-fetch FAILED ${row.symbol} ${row.sourceUrl} — NSE prunes this ` +
            `host, so a persistent failure here may mean the filing is gone`,
        );
      } else {
        out.refetched++;
      }
      await sleep(DOWNLOAD_DELAY_MS);
    }

    if (out.stoppedEarly) break;
  }

  out.remaining = Math.max(0, total - out.scanned);
  return out;
}

// ─── The annual-existing pass (MONEY-1114) ───────────────────────────

interface AnnualExistingResult {
  scanned: number;
  /** Rows whose XML could not be fetched. Not evidence of "no annual". */
  fetchFailed: number;
  written: number;
  noAnnualPeriod: number;
  ambiguous: number;
  unreadable: number;
  remaining: number;
  stoppedEarly: "limit" | "budget" | null;
}

/**
 * Walk stored rows and write the ANNUAL companion each one's document contains.
 *
 * ## Scope: only rows that could POSSIBLY have one
 *
 * `periodType: "QUARTERLY"` — an ANNUAL row is already the thing being derived,
 * and a HALF_YEARLY / NINE_MONTH row's document has the same year column its
 * quarter sibling does, so deriving from it would duplicate work and race the
 * same upsert key.
 *
 * The pass does NOT pre-filter on the period-end month. A March year-end is the
 * overwhelming norm but not a rule — SIEMENS files October-to-September, and its
 * annual column ends 30 September — so filtering on month would silently skip
 * exactly the filers whose fiscal year nobody remembers. The document itself is
 * the filter: no ~365-day context, no row, counted as `noAnnualPeriod`.
 *
 * ## It costs one NSE fetch per row and that is unavoidable
 *
 * `getFeedAsset` under `FEED_ARCHIVE_MODE=archive` (prod) always goes to the
 * exchange; only `replay` reads the archive back. So this is real traffic, which
 * is why it is opt-in, rate-limited by `DOWNLOAD_DELAY_MS`, and why `--dry-run`
 * counts the eligible rows and stops before spending any of it.
 */
async function annualExistingPass(
  from: Date,
  to: Date,
): Promise<AnnualExistingResult> {
  const out: AnnualExistingResult = {
    scanned: 0,
    fetchFailed: 0,
    written: 0,
    noAnnualPeriod: 0,
    ambiguous: 0,
    unreadable: 0,
    remaining: 0,
    stoppedEarly: null,
  };

  // `filedAt: null` rows are ALWAYS included — same reasoning as the
  // archive-existing pass: they are the modern index's Revisions, and a range
  // filter on a nullable column silently excludes exactly the rows nobody would
  // think to look for.
  const where: Prisma.XbrlFilingWhereInput = {
    exchange: "NSE",
    periodType: "QUARTERLY",
    OR: [
      { filedAt: { gte: from, lte: to } },
      { filedAt: null },
      { filedAt: { isSet: false } },
    ],
  };

  const total = await prisma.xbrlFiling.count({ where });
  log.info(
    `annual-existing: ${total} stored QUARTERLY filing(s) in scope` +
      `${DRY_RUN ? " (DRY RUN — counting only, no NSE traffic)" : ""}`,
  );
  if (DRY_RUN) {
    out.remaining = total;
    return out;
  }

  const startedAt = Date.now();
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.xbrlFiling.findMany({
      where,
      select: {
        id: true,
        symbol: true,
        sourceUrl: true,
        isin: true,
        basis: true,
        filerKind: true,
        audited: true,
        periodEnd: true,
        filedAt: true,
      },
      orderBy: { id: "asc" },
      take: ARCHIVE_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;

    for (const row of page) {
      if (ARCHIVE_LIMIT > 0 && out.scanned >= ARCHIVE_LIMIT) {
        out.stoppedEarly = "limit";
        break;
      }
      if (Date.now() - startedAt >= WINDOW_BUDGET_MS) {
        out.stoppedEarly = "budget";
        break;
      }
      if (!row.sourceUrl.toLowerCase().endsWith(".xml")) continue;
      out.scanned++;

      const xml = await fetchXml(row.sourceUrl, row.periodEnd);
      await sleep(DOWNLOAD_DELAY_MS);
      if (xml === null) {
        // A transport failure is NOT "this filing has no annual column". Kept in
        // its own counter so the two can never be added together.
        out.fetchFailed++;
        continue;
      }

      const verdict: AnnualBackfillOutcome = await backfillAnnualFromXml(
        {
          symbol: row.symbol,
          sourceUrl: row.sourceUrl,
          isin: row.isin,
          basis: row.basis,
          filerKind: row.filerKind,
          audited: row.audited,
          filedAt: row.filedAt,
        },
        xml,
      );
      if (verdict === "written") out.written++;
      else if (verdict === "no-annual-period") out.noAnnualPeriod++;
      else if (verdict === "ambiguous") out.ambiguous++;
      else out.unreadable++;
    }

    if (out.stoppedEarly) break;
  }

  out.remaining = Math.max(0, total - out.scanned);
  return out;
}

async function main(): Promise<void> {
  // MONEY-1375 — attach the Datadog log stream. Without this the job logs to
  // stdout only: `initLogger()` had exactly one caller in the whole repo.
  await initJobTelemetry();
  reportBuildProvenance(log, "xbrl-backfill");

  // Wire the GCS store BEFORE anything can fetch. Both paths below reach
  // `getFeedAsset` — the ordinary backfill through `processXbrlSync`'s
  // `fetchXml`, and `--archive-existing` directly — so this is unconditional.
  initFeedArchive();
  requireArchiveWired();

  const now = new Date();
  const explicitFrom = parseMonth(arg("from"));
  const explicitTo = parseMonth(arg("to"));

  const fromYear = Number(arg("from-year") ?? DEFAULT_FROM_YEAR);
  const toYear = Number(arg("to-year") ?? now.getUTCFullYear());

  const start = explicitFrom ?? { y: fromYear, m: 1 };
  const end =
    explicitTo ??
    (toYear === now.getUTCFullYear()
      ? { y: toYear, m: now.getUTCMonth() + 1 }
      : { y: toYear, m: 12 });

  if (
    start.y > end.y ||
    (start.y === end.y && start.m > end.m) ||
    !Number.isFinite(start.y) ||
    !Number.isFinite(end.y)
  ) {
    log.warn(
      `refusing an empty or inverted range: ${JSON.stringify({ start, end })}`,
    );
    process.exitCode = 1;
    return;
  }

  const windows = monthWindows(start, end);

  if (ARCHIVE_EXISTING && ANNUAL_EXISTING) {
    // Two different passes over the same rows that both fetch from NSE. Running
    // them together would double the traffic for one walk and make the counters
    // impossible to attribute. Refuse rather than pick one silently.
    log.warn(
      "--archive-existing and --annual-existing are separate passes; run them " +
        "one at a time.",
    );
    process.exitCode = 1;
    return;
  }

  if (ANNUAL_EXISTING) {
    const rangeFrom = windows[0]!.from;
    const rangeTo = windows[windows.length - 1]!.to;
    log.info(
      `annual-existing: ${windows[0]!.label} → ` +
        `${windows[windows.length - 1]!.label}` +
        `${ARCHIVE_LIMIT > 0 ? `, limit ${ARCHIVE_LIMIT}` : ""}`,
    );

    const r = await annualExistingPass(rangeFrom, rangeTo);

    log.info(
      `annual-existing DONE: scanned ${r.scanned}, ANNUAL rows written ` +
        `${r.written}, no-annual-period ${r.noAnnualPeriod}, ` +
        `fetch-failed ${r.fetchFailed}, ambiguous ${r.ambiguous}, ` +
        `unreadable ${r.unreadable}`,
    );
    if (r.stoppedEarly) {
      log.warn(
        `PARTIAL — stopped on the ${r.stoppedEarly} with ${r.remaining} row(s) ` +
          `unscanned. Re-run to continue; the upsert makes a re-scan idempotent.`,
      );
      process.exitCode = 1;
    }
    // A fetch failure is a filing whose annual row we do NOT have and cannot
    // tell apart from one that has none. Non-zero exit so it is not read as
    // a clean pass.
    if (r.fetchFailed > 0 || r.unreadable > 0) process.exitCode = 1;

    await prisma.$disconnect();
    return;
  }

  if (ARCHIVE_EXISTING) {
    // A DIFFERENT job from the ingest below, sharing only the range. It never
    // walks the index and never writes a row: `xbrl_filings` is already right,
    // the archive is what is missing.
    const rangeFrom = windows[0]!.from;
    const rangeTo = windows[windows.length - 1]!.to;
    log.info(
      `archive-existing: ${windows[0]!.label} → ` +
        `${windows[windows.length - 1]!.label}` +
        `${ARCHIVE_LIMIT > 0 ? `, limit ${ARCHIVE_LIMIT}` : ""}` +
        `, archive mode ${resolveFeedArchiveMode()}`,
    );

    const r = await archiveExistingPass(rangeFrom, rangeTo);

    log.info(
      `archive-existing DONE: scanned ${r.scanned}, MISSING ${r.missing}` +
        `${DRY_RUN ? "" : `, re-fetched ${r.refetched}, failed ${r.failed}`}` +
        `, probe-failed ${r.probeFailed}`,
    );
    if (r.probeFailed > 0) {
      // Same principle the annual-existing pass states below: a row we could
      // not tell apart from an archived one must not be counted as archived
      // silently. `MISSING ${r.missing}` is not a measurement while this is
      // non-zero — it is a lower bound taken over the rows that answered.
      log.warn(
        `UNPROVEN — ${r.probeFailed} row(s) could not be probed (storage read ` +
          `errors), and were assumed PRESENT so a read outage cannot trigger a ` +
          `mass re-scrape. "MISSING ${r.missing}" therefore excludes them. ` +
          `Re-run once storage is healthy before treating the archive as complete.`,
      );
      process.exitCode = 1;
    }
    if (r.stoppedEarly) {
      // The count is a FLOOR. Saying so is the whole difference between this
      // and the wrong-granularity completeness reports MONEY-1189 catalogued.
      log.warn(
        `PARTIAL — stopped on the ${r.stoppedEarly} with ${r.remaining} row(s) ` +
          `unscanned. "MISSING ${r.missing}" is a FLOOR, not a total. Re-run ` +
          `to continue: a row whose object now exists is skipped, so the pass ` +
          `resumes for free.`,
      );
      process.exitCode = 1;
    } else if (DRY_RUN && r.missing > 0) {
      log.warn(
        `${r.missing} stored filing(s) have NO archived XML. Re-run without ` +
          `--dry-run to fetch them; at ${DOWNLOAD_DELAY_MS} ms apiece that is ` +
          `~${Math.ceil((r.missing * DOWNLOAD_DELAY_MS) / 60_000)} minute(s) ` +
          `of NSE traffic, spread over ` +
          `${Math.ceil((r.missing * DOWNLOAD_DELAY_MS) / RUN_TIME_BUDGET_MS)} ` +
          `run(s) of the ${RUN_TIME_BUDGET_MS / 1000}s budget.`,
      );
    }
    if (r.failed > 0) process.exitCode = 1;

    await prisma.$disconnect();
    return;
  }

  log.info(
    `walking ${windows.length} month(s), ${windows[0]!.label} → ` +
      `${windows[windows.length - 1]!.label}${DRY_RUN ? " (DRY RUN)" : ""}`,
  );

  if (DRY_RUN) {
    // A dry run prints the plan and stops. It deliberately does NOT hit the
    // index: the point of --dry-run here is to check the WINDOW arithmetic
    // (which is where an off-by-one silently skips a month), and a run that
    // makes hundreds of requests to prove that is not a dry run.
    for (const w of windows) {
      log.info(
        `  ${w.label}: ${w.from.toISOString().slice(0, 10)} → ${w.to
          .toISOString()
          .slice(0, 10)}`,
      );
    }
    await prisma.$disconnect();
    return;
  }

  const totals = {
    listed: 0,
    stubbed: 0,
    written: 0,
    // MONEY-1114 — ANNUAL rows recovered from the SAME documents, at no extra
    // network cost. Tracked apart from `written` so "how much history do we
    // have" and "how much of it is annual" stay separable; the reconcile gate
    // and every year-over-year ratio depend on the second number.
    writtenAnnual: 0,
    unclassifiedPeriod: 0,
    skippedExisting: 0,
    downloaded: 0,
    unparseable: 0,
    // MONEY-1200. A wide backfill window straddles the regime change and walks
    // BOTH indexes, so it meets both taxonomies — these are exactly the
    // documents the parser used to reject wholesale, and a backfill that does
    // not surface them reports a complete-looking run over an empty table.
    unknownTaxonomy: 0,
    nonFinancial: 0,
    fetchFailed: 0,
  };
  const unknownTaxonomies = new Set<string>();
  const failedWindows: string[] = [];
  const truncatedWindows: string[] = [];

  for (const w of windows) {
    const r = await processXbrlSync({
      from: w.from,
      to: w.to,
      timeBudgetMs: WINDOW_BUDGET_MS,
    });

    totals.listed += r.listed;
    totals.stubbed += r.stubbed;
    totals.written += r.written;
    totals.writtenAnnual += r.writtenAnnual;
    totals.unclassifiedPeriod += r.unclassifiedPeriod;
    totals.skippedExisting += r.skippedExisting;
    totals.downloaded += r.downloaded;
    totals.unparseable += r.unparseable;
    totals.unknownTaxonomy += r.unknownTaxonomy;
    totals.nonFinancial += r.nonFinancial;
    totals.fetchFailed += r.fetchFailed;
    for (const s of r.unknownTaxonomySamples) unknownTaxonomies.add(s);

    if (!r.ok) failedWindows.push(w.label);
    if (r.indexTruncationSuspected.length > 0 || r.truncatedByBudget) {
      truncatedWindows.push(w.label);
    }

    log.info(
      `${w.label}: listed ${r.listed}, stub ${r.stubbed}, ` +
        `written ${r.written} (+${r.writtenAnnual} annual), ` +
        `already-had ${r.skippedExisting}, ` +
        `unparseable ${r.unparseable}, unknown-taxonomy ${r.unknownTaxonomy}, ` +
        `non-financial ${r.nonFinancial}, fetch-failed ${r.fetchFailed}` +
        // `!ok` no longer means only "the index was unreadable" — it now also
        // covers a run that downloaded documents and understood none of them.
        // Printing the old label would send the next investigation to the
        // index when the fault is in the concept table.
        `${
          r.ok
            ? ""
            : r.parseHealthFailure === null
              ? "  <-- INDEX UNREADABLE"
              : `  <-- PARSE HEALTH: ${r.parseHealthFailure}`
        }` +
        `${r.truncatedByBudget ? "  <-- HIT THE PER-RUN DOWNLOAD BUDGET" : ""}`,
    );
  }

  log.info(
    `TOTALS listed ${totals.listed}, stub ${totals.stubbed}, ` +
      `written ${totals.written} (+${totals.writtenAnnual} annual), ` +
      `unclassified-period ${totals.unclassifiedPeriod}, ` +
      `already-had ${totals.skippedExisting}, ` +
      `downloaded ${totals.downloaded}, unparseable ${totals.unparseable}, ` +
      `unknown-taxonomy ${totals.unknownTaxonomy}, ` +
      `non-financial ${totals.nonFinancial}, fetch-failed ${totals.fetchFailed}`,
  );

  if (unknownTaxonomies.size > 0) {
    log.warn(
      `UNKNOWN TAXONOMIES seen (${totals.unknownTaxonomy} documents). The fix ` +
        `is a table entry in xbrl-financials-logic.ts:\n  ` +
        [...unknownTaxonomies].join("\n  "),
    );
  }

  // A backfill that ends without saying which windows are INCOMPLETE is the
  // failure this whole epic keeps hitting: the summary looks like a result, the
  // gaps are invisible, and a later reader treats the coverage as final. Both
  // lists below are printed even when empty is not — silence is reserved for
  // the genuinely clean case, and a non-zero exit makes it un-ignorable.
  if (failedWindows.length > 0) {
    log.warn(
      `INCOMPLETE — the index was unreadable for ${failedWindows.length} ` +
        `window(s): ${failedWindows.join(", ")}. Re-run; already-stored ` +
        `filings are skipped before download, so a re-run is cheap.`,
    );
  }
  if (truncatedWindows.length > 0) {
    log.warn(
      `POSSIBLY TRUNCATED — ${truncatedWindows.length} window(s) hit a cap: ` +
        `${truncatedWindows.join(", ")}. The counts above are a FLOOR for ` +
        `these months, not a total.`,
    );
  }
  if (totals.fetchFailed > 0) {
    // The SAME reasoning the annual-existing pass already states verbatim: "a
    // fetch failure is a filing whose row we do NOT have and cannot tell apart
    // from one that has none". That pass gates on it; so does archive-existing
    // (`r.failed`); this walk — the one that does the bulk of the work — did
    // not, so a window where thousands of filings 404'd printed its counts and
    // exited 0, and the shard was ticked off as done (MONEY-1238).
    log.warn(
      `INCOMPLETE — ${totals.fetchFailed} filing(s) could not be downloaded ` +
        `and are NOT in xbrl_filings. Re-run; already-stored filings are ` +
        `skipped before download, so a re-run only retries these.`,
    );
  }
  if (
    failedWindows.length > 0 ||
    truncatedWindows.length > 0 ||
    totals.fetchFailed > 0
  ) {
    process.exitCode = 1;
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[xbrl-backfill] FAILED", err);
  await prisma.$disconnect();
  process.exit(1);
});
