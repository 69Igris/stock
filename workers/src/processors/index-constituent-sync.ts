/**
 * Index Constituent Sync Processor (MONEY-301; archive-first since
 * MONEY-1100 P4.3).
 *
 * Refreshes the `IndexConstituent` table with the latest members for
 * each tracked NSE broad-market index. Cloud Scheduler triggers this
 * Sunday 03:00 IST so weekly index rebalances are picked up before
 * Monday open.
 *
 * Three source strategies, tried in order per index id:
 *
 *   1. **Archive** (the eight indices the P2 registry captures) — read
 *      the LATEST dated `ind_{slug}list.csv` from the GCS feed archive
 *      (`feeds/NSE/index-constituents/{slug}/…`, written daily by
 *      report-archive-sync) and parse NSE's actual membership. This is
 *      the scrape-once rule: the nightly job already fetched the file
 *      from NSE, so this worker reads OUR bytes and never touches the
 *      exchange. On QA the prefix is empty until the feeds/ mirror job
 *      is provisioned (see setup-sync-job.sh), so QA degrades to the
 *      ladder below — the exact pre-P4.3 behavior.
 *
 *   2. **Static** (Nifty 50 / Bank Nifty / Nifty IT) — hand-curated
 *      emergency arrays. Kept because they protect the screener filter
 *      from a GCS outage, but they DO go stale: the pinned Bank Nifty
 *      list was 12 names while NSE's real file has 14.
 *
 *   3. **Mcap-rank** (everything else) — derive members from the local
 *      `StockRatios.marketCap` ranking. A best-effort approximation,
 *      now only a fallback / the source for indices the archive does
 *      not cover (nifty200, midcap150, smallcap250, …).
 *
 * A parsed set only REPLACES existing rows when it passes
 * `shouldReplaceMembership` — the delete-then-create write means a bad
 * parse would otherwise erase an index, not just skew it.
 *
 * Idempotent - clears the rows for the target index before inserting
 * the fresh batch. `forceRefresh` only matters as a future flag once
 * we add an upstream-hash short-circuit.
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import type { IndexConstituentSyncMessage } from "@usemoney/types";
import { prisma } from "@usemoney/database";
import { listFiles, downloadFile } from "@usemoney/storage";
import {
  parseIndexConstituentList,
  pickLatestConstituentKey,
  constituentKeyDate,
  shouldReplaceMembership,
  planMembershipUpdate,
  INDEX_ID_TO_CONSTITUENT_SLUG,
} from "@usemoney/core/market-data";

// Workers prefer raw console.log over @usemoney/logger to keep cold
// starts fast - the structured logger is an option but not required
// here. See workers/src/processors/sparkline-sync.ts for the pattern.
const logger = {
  info: (data: unknown, msg: string) =>
    console.log(`[index-sync] ${msg}`, data),
  error: (data: unknown, msg: string) =>
    console.error(`[index-sync] ${msg}`, data),
};

const STATIC_NIFTY_50: readonly string[] = [
  "RELIANCE",
  "HDFCBANK",
  "ICICIBANK",
  "INFY",
  "TCS",
  "BHARTIARTL",
  "ITC",
  "SBIN",
  "LT",
  "HINDUNILVR",
  "AXISBANK",
  "BAJFINANCE",
  "KOTAKBANK",
  "MARUTI",
  "M&M",
  "ASIANPAINT",
  "TITAN",
  "SUNPHARMA",
  "HCLTECH",
  "ULTRACEMCO",
  "TATAMOTORS",
  "WIPRO",
  "ONGC",
  "POWERGRID",
  "NTPC",
  "TATASTEEL",
  "ADANIPORTS",
  "ADANIENT",
  "JSWSTEEL",
  "COALINDIA",
  "GRASIM",
  "HINDALCO",
  "BAJAJFINSV",
  "TECHM",
  "DRREDDY",
  "CIPLA",
  "INDUSINDBK",
  "BPCL",
  "EICHERMOT",
  "NESTLEIND",
  "HEROMOTOCO",
  "BRITANNIA",
  "DIVISLAB",
  "APOLLOHOSP",
  "SHREECEM",
  "BAJAJ-AUTO",
  "TATACONSUM",
  "SBILIFE",
  "HDFCLIFE",
  "LTIM",
];

const STATIC_BANK_NIFTY: readonly string[] = [
  "HDFCBANK",
  "ICICIBANK",
  "AXISBANK",
  "SBIN",
  "KOTAKBANK",
  "INDUSINDBK",
  "BANKBARODA",
  "PNB",
  "BANDHANBNK",
  "FEDERALBNK",
  "AUBANK",
  "IDFCFIRSTB",
];

const STATIC_NIFTY_IT: readonly string[] = [
  "TCS",
  "INFY",
  "WIPRO",
  "HCLTECH",
  "TECHM",
  "LTIM",
  "MPHASIS",
  "PERSISTENT",
  "COFORGE",
  "LTTS",
];

const STATIC_INDICES: Record<string, readonly string[]> = {
  nifty50: STATIC_NIFTY_50,
  banknifty: STATIC_BANK_NIFTY,
  niftyit: STATIC_NIFTY_IT,
};

interface McapRankSpec {
  start: number;
  end: number;
}

// Keep these ids in lock-step with `MCAP_RANK_SPECS` in
// apps/web/lib/screener/index-constituents.ts. The web fallback uses
// the same ranks at query time when the table is empty (cold start /
// failed sync), so divergence shows up as a screener mismatch.
const MCAP_RANK_SPECS: Record<string, McapRankSpec> = {
  niftynext50: { start: 51, end: 100 },
  nifty100: { start: 1, end: 100 },
  nifty200: { start: 1, end: 200 },
  nifty500: { start: 1, end: 500 },
  niftylargemid250: { start: 1, end: 250 },
  niftymidcap50: { start: 101, end: 150 },
  niftymidcap100: { start: 101, end: 200 },
  niftymidcap150: { start: 101, end: 250 },
  niftysmallcap50: { start: 251, end: 300 },
  niftysmallcap100: { start: 251, end: 350 },
  niftysmallcap250: { start: 251, end: 500 },
  niftymidsmall400: { start: 101, end: 500 },
  niftytotalmarket: { start: 1, end: 750 },
  niftymicrocap250: { start: 501, end: 750 },
};

const ALL_INDEX_IDS: string[] = [
  ...Object.keys(STATIC_INDICES),
  ...Object.keys(MCAP_RANK_SPECS),
];

interface ConstituentRow {
  symbol: string;
  /** Null for archive rows — NSE's list files publish no rank or weight. */
  rank: number | null;
}

type Strategy = "archive" | "static" | "mcap-rank";

interface ResolvedConstituents {
  rows: ConstituentRow[];
  strategy: Strategy;
  /** ISO day of the archived file the rows came from (archive only). */
  fileDate?: string | null;
}

/**
 * One archive attempt, WITH the reason it failed — MONEY-1238.
 *
 * `strategy` was computed per index and then DROPPED: `syncIndex` returned it,
 * but `processIndexConstituentSync`'s declared result type omitted it, so the
 * route, the JSON body and every log line downstream saw only `{indexId, count,
 * ok, reason}`. An index that silently stopped resolving from the real NSE file
 * and started serving a 12-name hand-typed array from 2023 (Bank Nifty; NSE's
 * own file has 14) reported `ok: true, count: 12` and looked healthy.
 *
 * Carried by RETURN VALUE, never module state: the workers service runs
 * `containerConcurrency: 10` with no mutex, so a shared map would attribute one
 * run's miss to another's index — the same misattribution
 * `emptyFeedAssetOutcome` exists to prevent in report-archive-sync.
 */
interface ArchiveAttempt {
  resolved: ResolvedConstituents | null;
  /**
   * Why the archive could not serve this index, or null when it did — or when
   * the index is not archive-covered at all, which is the DESIGN (the ladder),
   * not a degradation.
   */
  miss: string | null;
}

function archiveMiss(
  indexId: string,
  prefix: string,
  why: string,
): ArchiveAttempt {
  logger.error(
    { indexId, prefix, why },
    "[index-sync] ARCHIVE MISS — falling back to the static/mcap ladder",
  );
  return { resolved: null, miss: why };
}

/**
 * Latest archived membership for an index id, or null when the archive
 * cannot serve it: id not covered, empty prefix (QA before the feeds/
 * mirror, or a listFiles error — it returns [] for both), download
 * failure, or a file that parses to nothing (HTML error page).
 * Null always means "fall down the ladder", never "empty index".
 */
async function resolveFromArchive(indexId: string): Promise<ArchiveAttempt> {
  const slug = INDEX_ID_TO_CONSTITUENT_SLUG[indexId];
  // Not archive-covered at all. The ladder is the DESIGN here, not a
  // degradation, so it is the one miss that is not reported.
  if (!slug) return { resolved: null, miss: null };
  const prefix = `feeds/NSE/index-constituents/${slug}/`;
  const keys = await listFiles(prefix);
  if (keys.length === 0) {
    // `listFiles` returns [] for an empty prefix AND for an error it swallowed,
    // and nothing available here can separate them — that ambiguity lives in
    // @usemoney/storage. What CAN be said is which prefix came back empty, so
    // "QA has no mirror yet" and "prod's archive stopped being written" are at
    // least distinguishable by WHICH environment logs it.
    return archiveMiss(
      indexId,
      prefix,
      "prefix listed ZERO objects (empty or unreadable)",
    );
  }
  const latest = pickLatestConstituentKey(keys);
  if (!latest) {
    // Objects EXIST and not one is a recognisable `ind_{slug}list` key. That is
    // never a provisioning gap — it is NSE renaming the file or the archiver
    // writing a shape we cannot read, and it must not look like an empty prefix.
    return archiveMiss(
      indexId,
      prefix,
      `${keys.length} object(s) present but NONE matched a dated constituent ` +
        `key — the upstream filename changed`,
    );
  }
  const buf = await downloadFile(latest);
  if (!buf) {
    return archiveMiss(
      indexId,
      prefix,
      `download returned nothing for ${latest}`,
    );
  }
  const parsed = parseIndexConstituentList(buf.toString("utf8"));
  if (parsed.rows.length === 0) {
    logger.error(
      { indexId, key: latest, reasons: parsed.reasons },
      "[index-sync] archived list parsed to zero rows — falling back",
    );
    return archiveMiss(indexId, prefix, `parsed ZERO rows from ${latest}`);
  }
  if (Object.keys(parsed.reasons).length > 0) {
    logger.info(
      { indexId, key: latest, reasons: parsed.reasons },
      "[index-sync] archive parse dropped rows",
    );
  }
  return {
    resolved: {
      rows: parsed.rows.map((r) => ({ symbol: r.symbol, rank: null })),
      strategy: "archive",
      fileDate: constituentKeyDate(latest),
    },
    miss: null,
  };
}

async function resolveFallback(
  indexId: string,
): Promise<ResolvedConstituents | null> {
  const stat = STATIC_INDICES[indexId];
  if (stat) {
    return {
      rows: stat.map((symbol, i) => ({ symbol, rank: i + 1 })),
      strategy: "static",
    };
  }
  const rank = MCAP_RANK_SPECS[indexId];
  if (rank) {
    const ranked = await prisma.stockRatios.findMany({
      where: { marketCap: { not: null } },
      orderBy: { marketCap: "desc" },
      skip: Math.max(0, rank.start - 1),
      take: Math.max(0, rank.end - rank.start + 1),
      select: { symbol: true },
    });
    return {
      rows: ranked.map((r, i) => ({ symbol: r.symbol, rank: rank.start + i })),
      strategy: "mcap-rank",
    };
  }
  return null;
}

/**
 * Append point-in-time membership events for an index (MONEY-1189).
 *
 * `IndexConstituent` is `@@unique([indexId, symbol])` and this job replaces it
 * wholesale, so it can only ever answer "who is in the index TODAY". The
 * survivorship-bias-free backtest that P4.3 exists to enable needs "who was in
 * NIFTY 50 on 2019-03-14", so the history has to be accumulated alongside it.
 *
 * ## Archive strategy ONLY
 *
 * This is deliberately not called for `static` or `mcap-rank`. Those are
 * DERIVED views, not observations — an `mcap-rank` index reshuffles whenever
 * market caps move, so recording its weekly diff would stamp a fabricated
 * rebalance into the history every single run, indistinguishable from a real
 * NSE reconstitution. Only a dated archive file is evidence of membership.
 *
 * ## Never fails the sync
 *
 * The constituent write has already committed by the time this runs. History is
 * additive and re-derivable from the same archive
 * (`scripts/data/backfill-index-membership.ts`), so a failure here must not
 * roll back or fail a sync whose primary job succeeded.
 */
async function recordMembershipHistory(
  indexId: string,
  symbols: readonly string[],
  fileDate: string | null,
): Promise<void> {
  // No dated file means no observation date, and stamping "today" would claim
  // an observation we did not make.
  if (!fileDate) return;
  const observedAt = new Date(`${fileDate}T00:00:00.000Z`);
  if (Number.isNaN(observedAt.getTime())) return;

  try {
    const open = await prisma.indexMembership.findMany({
      // MONEY-1236 — the bare `removedOn: null` is correct BY CONSTRUCTION
      // here: this function's own `createMany` below (line 354) passes an
      // explicit `removedOn: null` for every stint it opens, and the only other
      // writer (scripts/data/backfill-index-membership.ts) stamps it in both
      // `create` and `update`. So an open stint always CARRIES the key.
      // Measured on prod 2026-08-21: 924 rows, 0 absent, 924 explicit null.
      // prisma-null-ok: this file's own createMany writes the explicit null
      where: { indexId, removedOn: null },
      select: { symbol: true, lastSeen: true },
    });

    const plan = planMembershipUpdate(
      open.map((o) => ({ symbol: o.symbol, lastSeen: o.lastSeen.getTime() })),
      new Set(symbols),
      observedAt.getTime(),
    );

    if (plan.skip === "stale") {
      logger.error(
        { indexId, fileDate },
        "[index-sync] archive went BACKWARDS — membership history not updated",
      );
      return;
    }
    if (plan.skip === "duplicate") return;

    if (plan.touch.length > 0) {
      await prisma.indexMembership.updateMany({
        // MONEY-1236 — same open-stint contract as the read above: the
        // `createMany` at line 354 writes `removedOn: null` explicitly, so
        // touching the "still present" stints reaches all of them. Measured on
        // prod 2026-08-21: 924 rows, 0 absent, 924 explicit null.
        // prisma-null-ok: this file's own createMany writes the explicit null
        where: { indexId, symbol: { in: plan.touch }, removedOn: null },
        data: { lastSeen: observedAt },
      });
    }
    if (plan.close.length > 0) {
      await prisma.indexMembership.updateMany({
        // MONEY-1236 — same open-stint contract, and this is the arm that would
        // hurt most if it were wrong: a stint it cannot see is never CLOSED.
        // The `createMany` at line 354 writes `removedOn: null` explicitly,
        // so every open stint carries the key. Measured on prod 2026-08-21:
        // 924 rows, 0 absent, 924 explicit null.
        // prisma-null-ok: this file's own createMany writes the explicit null
        where: { indexId, symbol: { in: plan.close }, removedOn: null },
        data: { removedOn: observedAt },
      });
    }
    if (plan.open.length > 0) {
      await prisma.indexMembership.createMany({
        data: plan.open.map((o) => ({
          indexId,
          symbol: o.symbol,
          firstSeen: observedAt,
          lastSeen: observedAt,
          addedOn: o.addedOn === null ? null : new Date(o.addedOn),
          removedOn: null,
        })),
      });
    }

    if (plan.close.length > 0 || plan.open.some((o) => o.addedOn !== null)) {
      logger.info(
        {
          indexId,
          fileDate,
          joined: plan.open
            .filter((o) => o.addedOn !== null)
            .map((o) => o.symbol),
          exited: plan.close,
        },
        "[index-sync] membership change recorded",
      );
    }
  } catch (err) {
    logger.error(
      { err, indexId, fileDate },
      "[index-sync] membership history write failed — constituents are still correct",
    );
  }
}

/** One index's outcome. `strategy` and `archiveMiss` reach the caller now. */
export interface IndexSyncResult {
  indexId: string;
  count: number;
  ok: boolean;
  /** Which rung of the ladder produced the rows. */
  strategy?: Strategy;
  /**
   * Set when this index IS archive-covered and the archive could not serve it,
   * so the rows below came from a hand-typed array or an mcap approximation.
   * Absent for indices the archive never covered — those are on the ladder by
   * design.
   */
  archiveMiss?: string;
  reason?: string;
}

async function syncIndex(indexId: string): Promise<IndexSyncResult> {
  try {
    const attempt = await resolveFromArchive(indexId);
    const archiveMissReason = attempt.miss ?? undefined;
    const resolved = attempt.resolved ?? (await resolveFallback(indexId));
    if (!resolved || resolved.rows.length === 0) {
      return {
        indexId,
        count: 0,
        ok: false,
        archiveMiss: archiveMissReason,
        reason: "no constituents",
      };
    }
    const existing = await prisma.indexConstituent.count({
      where: { indexId },
    });
    const guard = shouldReplaceMembership(resolved.rows.length, existing);
    if (!guard.replace) {
      // Keep the table's last good state — a refused replace is a data
      // problem to investigate, not a reason to erase membership.
      logger.error(
        {
          indexId,
          strategy: resolved.strategy,
          parsed: resolved.rows.length,
          existing,
          reason: guard.reason,
        },
        "[index-sync] replace refused — keeping existing rows",
      );
      return {
        indexId,
        count: existing,
        ok: false,
        strategy: resolved.strategy,
        archiveMiss: archiveMissReason,
        reason: `replace-refused:${guard.reason}`,
      };
    }
    // Replace the entire set for this index in one transaction so the
    // screener never sees a half-populated state.
    await prisma.$transaction([
      prisma.indexConstituent.deleteMany({ where: { indexId } }),
      prisma.indexConstituent.createMany({
        data: resolved.rows.map((r) => ({
          indexId,
          symbol: r.symbol,
          rank: r.rank,
          lastSyncedAt: new Date(),
        })),
      }),
    ]);
    if (resolved.strategy === "archive") {
      logger.info(
        { indexId, count: resolved.rows.length, fileDate: resolved.fileDate },
        "[index-sync] wrote real membership from archive",
      );
      await recordMembershipHistory(
        indexId,
        resolved.rows.map((r) => r.symbol),
        resolved.fileDate ?? null,
      );
    }
    return {
      indexId,
      count: resolved.rows.length,
      ok: true,
      strategy: resolved.strategy,
      archiveMiss: archiveMissReason,
    };
  } catch (err) {
    logger.error({ err, indexId }, "[index-sync] write failed");
    return {
      indexId,
      count: 0,
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function processIndexConstituentSync(
  message: IndexConstituentSyncMessage,
): Promise<{
  ok: boolean;
  /**
   * Archive-covered indices that fell back to a hand-typed array or an mcap
   * approximation this run. NOT a failure — QA has no `feeds/` mirror on some
   * envs and the ladder is exactly what protects the screener — but it IS a
   * silent substitution of stale data for real membership, and it now leaves
   * the processor instead of dying inside `resolveFromArchive`.
   */
  degraded: Array<{ indexId: string; strategy?: Strategy; why: string }>;
  results: IndexSyncResult[];
}> {
  const ids =
    message.indexes && message.indexes.length > 0
      ? message.indexes.filter((id) => ALL_INDEX_IDS.includes(id))
      : ALL_INDEX_IDS;

  logger.info(
    { ids, forceRefresh: message.forceRefresh ?? false },
    "[index-sync] starting",
  );

  const results = await Promise.all(ids.map((id) => syncIndex(id)));

  const degraded = results
    .filter((r) => r.archiveMiss !== undefined && r.strategy !== "archive")
    .map((r) => ({
      indexId: r.indexId,
      strategy: r.strategy,
      why: r.archiveMiss!,
    }));

  const ok = results.every((r) => r.ok);
  // Deliberately NOT folded into `ok`. `ok: false` -> 500 -> Pub/Sub retries,
  // and a retry cannot conjure a `feeds/` mirror that does not exist yet — it
  // would 500 every run on QA forever, which is how an alert gets muted. The
  // degradation is REPORTED (loudly, per index, with the reason) and the run
  // still succeeds, because the ladder did its job.
  if (degraded.length > 0) {
    logger.error(
      { degraded },
      `[index-sync] ${degraded.length} archive-covered index(es) served ` +
        `SUBSTITUTE membership this run — the rows are a static list or an ` +
        `mcap approximation, not NSE's file`,
    );
  }
  logger.info({ results, degraded, ok }, "[index-sync] done");
  // `selected` is the indices attempted; `written` those that produced rows. A
  // DEGRADED index still wrote membership (from a static list), so it is not a
  // failure — but it is reported, because substitute rows are the one thing a
  // constituent count cannot reveal on its own.
  reportJobOutcome({
    job: "index-constituent-sync",
    selected: results.length,
    written: results.filter((r) => r.count > 0).length,
    failed: results.filter((r) => !r.ok).length,
    ...(degraded.length > 0
      ? {
          skippedReason: `${degraded.length} index(es) served SUBSTITUTE membership`,
        }
      : {}),
  });
  return { ok, degraded, results };
}
