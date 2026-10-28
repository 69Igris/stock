/**
 * Candle eviction — the I/O half (MONEY-980).
 *
 * Enforces the two halves of the hot/cold contract that nothing had ever
 * enforced: a `LOADED` year stops being hot 30 days after its last read, and a
 * `WINDOW` year stops being hot when the rolling window rolls past it. Without
 * this job the hot store only ever grows, and `Candle.tier` / `hotLoadedAt` /
 * `UsInstrument.hotLoadedYears` are three columns with no reader.
 *
 * Every decision lives in `candle-evict-logic.ts`, which has zero I/O. This
 * file is the wiring: Prisma, the cold-store port, and the ORDERING between
 * them — which is the part that makes the difference between an eviction and a
 * data loss.
 *
 * ## THE ORDERING, and why it is what it is
 *
 * A row is deleted from Mongo ONLY after a cold shard has been observed to
 * contain a bar with its exact natural key. Never the reverse, and never on the
 * strength of "the write returned successfully".
 *
 *   LOADED   the shard already exists — the row came OUT of it. The job READS
 *            it and checks containment. If the object is absent, unreadable, or
 *            present-but-missing-the-bar, the row STAYS.
 *
 *   WINDOW   the shard does NOT exist yet, and that is the trap. These rows
 *            were written to Mongo because their year was inside the window;
 *            nobody has ever archived them, so Mongo is the ONLY copy. A rule
 *            that merely deleted them would destroy a year of prices for every
 *            symbol, once a year, silently. So the job ARCHIVES first
 *            (`writeColdShard`, which merges rather than replaces), then
 *            RE-READS the object, then deletes what the re-read proves is
 *            there. The write's own success is not accepted as proof: the same
 *            three-outcome read the LOADED path uses is the only evidence
 *            either path acts on, so there is ONE rule rather than two.
 *
 * Deleting less than we could is cheap and visible (rows stay, the counter
 * says so). Deleting more than we should is unbounded and invisible — a
 * shorter price series just draws a shorter chart. Every uncertainty therefore
 * resolves to KEEP.
 *
 * ## The 600s ack deadline
 *
 * Bounded by `RUN_TIME_BUDGET_MS` checked BETWEEN SHARD GROUPS, never by a
 * batch size, and self-chained up to `MAX_CHAIN_DEPTH` follow-ups. Overrunning
 * does not make the run slow — Pub/Sub redelivers and a second copy races the
 * first over the same rows.
 */

import { reportJobOutcome } from "@usemoney/datadog/job-outcome";
import { prisma } from "@usemoney/database";
import type { CandleEvictMessage } from "@usemoney/types/pubsub";
import { PUBSUB_TOPICS, getTopicName } from "@usemoney/types/pubsub";
import { getPubSubClient } from "@usemoney/pubsub/client";
// The BARREL, not the file: `candle-repository.ts` / `candle-cold-store.ts`
// have no subpath of their own in packages/core's `exports` map, and
// `moduleResolution: "bundler"` resolves through that map.
import {
  candleKey,
  getCandleColdStore,
  readColdShardUncached,
  writeColdShard,
  type CandleBar,
} from "@usemoney/core/market-data/candles";
import {
  buildEvictWhere,
  buildIntradayPlanPipeline,
  buildIntradayUnitWhere,
  chainKeptBeforeUnexamined,
  clampBatchSize,
  evictOrderBy,
  evictTallyBalances,
  groupCandidatesByShard,
  hotLoadCutoff,
  isEvictionDisabled,
  isWithinRunBudget,
  judgeEvictRun,
  LEDGER_BUDGET_MS,
  ledgerYearsForDeletions,
  MAX_CHAIN_DEPTH,
  nextEvictStep,
  normalizeChainDepth,
  normalizeSkipRows,
  orderIntradayLeaves,
  partitionByShardCoverage,
  partitionIntradayBySessionAuthority,
  resolveEvictApply,
  resolveRuleScope,
  RUN_TIME_BUDGET_MS,
  toColdBarFromCandidate,
  windowFloorTs,
  yearBounds,
  type EvictCandidate,
  type EvictRule,
  type EvictShardGroup,
  type EvictTally,
  type IntradayUnit,
} from "./candle-evict-logic";

const log = {
  info: (...a: unknown[]) => console.log("[candle-evict]", ...a),
  warn: (...a: unknown[]) => console.warn("[candle-evict]", ...a),
  error: (...a: unknown[]) => console.error("[candle-evict]", ...a),
};

export interface CandleEvictResult extends EvictTally {
  rule: EvictRule;
  /** An OPERATOR pinned the rule — as opposed to the chain carrying it. */
  ruleScoped: boolean;
  skipRows: number;
  /** `hotLoadedYears` entries cleared because the year has no LOADED rows left. */
  ledgerYearsCleared: number;
  /**
   * `(listingId, year)` pairs the ledger pass ran out of clock before reaching.
   *
   * Its own number rather than silence: the rows are already correctly gone, so
   * this is a stale summary and not lost data — but "the ledger is complete"
   * and "the ledger stopped early" would otherwise both print
   * `ledgerYearsCleared: 3`.
   */
  ledgerYearsSkipped: number;
  applied: boolean;
  disabled: boolean;
  chained: boolean;
  chainDepth: number;
  /**
   * Leaf messages the `WINDOW_INTRADAY` PLANNER published — MONEY-1373.
   *
   * Zero on every other path, including a leaf: a leaf never publishes and
   * never chains, which is what makes the fan-out finite without a depth
   * counter to prove it.
   */
  leavesPublished: number;
  /**
   * Leaf publishes that were REJECTED, counted from `Promise.allSettled` rather
   * than inferred from `units - published`. A unit whose message never left is
   * a `(symbol, timeframe)` nothing evicts tonight; tomorrow's plan re-selects
   * it, so this is a delay rather than a loss — but it has to be visible, or a
   * partially-failed fan-out reads as a smaller population.
   */
  leavesFailed: number;
  ok: boolean;
  reason?: string;
}

/** Injectable seam so the outcome line and the clock are testable. */
export interface CandleEvictDeps {
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export async function processCandleEvict(
  msg?: CandleEvictMessage,
  deps: CandleEvictDeps = {},
): Promise<CandleEvictResult> {
  const startedAt = Date.now();
  const env = deps.env ?? process.env;
  const now = deps.now ?? new Date();

  // The rule AND who chose it — two questions, and reading the second off the
  // first is what made the WINDOW rule unreachable. See `resolveRuleScope`.
  const { rule, ruleScoped } = resolveRuleScope(msg);
  const skipRows = normalizeSkipRows(msg?.skipRows);
  const batchSize = clampBatchSize(msg?.batchSize);
  const chainDepth = normalizeChainDepth(msg?.chainDepth);
  const disabled = isEvictionDisabled(env);
  const applied = resolveEvictApply(msg, env);
  const coldStoreRegistered = getCandleColdStore() !== null;

  const tally: EvictTally = {
    selected: 0,
    examined: 0,
    deleted: 0,
    keptNoShard: 0,
    keptShardUnreadable: 0,
    keptNotInShard: 0,
    keptNotArmed: 0,
    keptNonUs: 0,
    budgetSkipped: 0,
    shardWriteFailures: 0,
    shardReadFailures: 0,
    deleteFailures: 0,
    deleteVanished: 0,
    deletedOutranked: 0,
  };
  let ledgerYearsCleared = 0;
  let ledgerYearsSkipped = 0;
  let chained = false;

  // ── The two hard gates, BEFORE any query ─────────────────────────────────
  //
  // Both return early rather than running and finding nothing. A disabled job
  // that still paged the table would spend the query and report a zero that
  // looks like an empty population; a job with no cold store would read every
  // shard as `absent`, keep every row, and produce a page of alarming
  // "shard missing" counters for a configuration problem.
  if (disabled || !coldStoreRegistered) {
    const verdict = judgeEvictRun({
      tally,
      disabled,
      armed: applied,
      coldStoreRegistered,
    });
    if (verdict.ok) log.info(verdict.reason ?? "skipped");
    else log.error(verdict.reason);
    reportJobOutcome({
      job: "candle-evict",
      selected: 0,
      written: 0,
      ...(verdict.reason ? { skippedReason: verdict.reason } : {}),
    });
    return {
      ...tally,
      rule,
      ruleScoped,
      skipRows,
      ledgerYearsCleared: 0,
      ledgerYearsSkipped: 0,
      applied,
      disabled,
      chained: false,
      chainDepth,
      leavesPublished: 0,
      leavesFailed: 0,
      ok: verdict.ok,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    };
  }

  // ── WINDOW_INTRADAY: one topic, TWO MESSAGE SHAPES (MONEY-1373) ─────────
  //
  // The same arrangement `us-filing-insight` uses (MONEY-1324), and here it is
  // not a convenience: the row-paged chain below is ~200x short of the intraday
  // inflow and no batch size can close the gap. `evictOrderBy` is `ts asc`
  // ACROSS ALL SYMBOLS, and 507 symbols emit one M1 bar per minute
  // simultaneously — so a 1,000-row page spans ~2 minutes of market time and
  // touches ~500 distinct (symbol, year) shard GROUPS at ~2 rows each. Each
  // group pays a full ~8 MB read-modify-write plus a verifying read to delete
  // two rows, ~4-6 s; the 420s budget admits ~80 of them, so a link deletes
  // ~160-200 rows against ~712,000 arriving per session.
  //
  // Both halves return BEFORE `chainNext`. A leaf never chains, and the plan is
  // TERMINAL — the fan-out is the continuation. `WINDOW_INTRADAY` is last in
  // `EVICT_RULES`, so the chain reaching it is the chain's final link anyway.
  const base = {
    ruleScoped,
    skipRows,
    applied,
    disabled,
    chainDepth,
    coldStoreRegistered,
  };
  if (msg?.unit) return processIntradayLeaf(msg.unit, tally, now, base);
  if (rule === "WINDOW_INTRADAY") return processIntradayPlan(msg, now, base);

  log.info(
    `Starting rule=${rule} scoped=${ruleScoped} skip=${skipRows} batch=${batchSize} ` +
      `apply=${applied} depth=${chainDepth}/${MAX_CHAIN_DEPTH} ` +
      `cutoff=${hotLoadCutoff(now).toISOString()} ` +
      `windowFloor=${windowFloorTs(now).toISOString()}`,
  );

  try {
    // ── SELECT ────────────────────────────────────────────────────────────
    //
    // POSITIVE on `tier` (see the logic module's header). `skip` is the
    // accumulator the chain carries: deleted rows leave the set and kept rows
    // do not, so the next unseen row sits at exactly `skip + kept`.
    const candidates = (await prisma.candle.findMany({
      where: buildEvictWhere(rule, now),
      orderBy: evictOrderBy(rule),
      skip: skipRows,
      take: batchSize,
      select: {
        id: true,
        symbol: true,
        exchange: true,
        timeframe: true,
        ts: true,
        listingId: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        divCash: true,
        splitFactor: true,
        source: true,
      },
    })) as Array<Omit<EvictCandidate, "volume"> & { volume: bigint }>;

    // BigInt -> number at the store boundary, as `readHot` does it. A `bigint`
    // reaching any arithmetic that also touches a `number` throws; and a shard
    // round-trips through JSON, where `JSON.stringify` rejects a BigInt
    // outright.
    const rows: EvictCandidate[] = candidates.map((row) => ({
      ...row,
      volume: Number(row.volume),
    }));
    tally.selected = rows.length;

    const { groups, nonUs } = groupCandidatesByShard(rows);
    tally.examined += nonUs.length;
    tally.keptNonUs += nonUs.length;

    const deleted: EvictCandidate[] = [];
    // Rows the budget never let us look at. Ids rather than a count, because
    // the chain's `skip` accumulator needs to know WHERE the first of them sits
    // in page order — the groups are iterated in group order, so the skipped
    // set is not a suffix of the page. See `chainKeptBeforeUnexamined`.
    const unexaminedIds = new Set<string>();

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]!;
      // BETWEEN groups, never inside one. See RUN_TIME_BUDGET_MS for the
      // headroom arithmetic against the 600s ack deadline.
      if (!isWithinRunBudget(startedAt, Date.now(), RUN_TIME_BUDGET_MS)) {
        for (let j = i; j < groups.length; j++) {
          for (const row of groups[j]!.rows) unexaminedIds.add(row.id);
          tally.budgetSkipped += groups[j]!.rows.length;
        }
        log.warn(
          `Stopped on the run budget with ${groups.length - i} shard group(s) ` +
            `(${tally.budgetSkipped} row(s)) unexamined; they are still in the ` +
            `set and the next link re-selects them.`,
        );
        break;
      }

      tally.examined += group.rows.length;

      // WINDOW rows have never been archived — Mongo is the only copy. Archive
      // FIRST; a failure here keeps every row in the group.
      //
      // This read `rule === "WINDOW" || rule === "WINDOW_INTRADAY"` until the
      // planner landed, because both rules are the same `tier: "WINDOW"` under
      // different boundaries and both therefore arrive unarchived. Intraday no
      // longer reaches this loop at all — `processCandleEvict` returns to
      // `processIntradayLeaf` / `processIntradayPlan` above — so the disjunct
      // is now unreachable, and TypeScript says so. The reason it was there
      // still holds for whatever non-intraday rule comes next: the condition is
      // a property of the TIER, not of the rule NAME, and getting it wrong is
      // silent — the branch skips to the verifying read, finds no shard, keeps
      // every row and reports `keptNoShard`, which is safe and is also a job
      // that can never delete anything while looking like it is working.
      if (rule === "WINDOW") {
        const archived = await archiveGroup(group, tally);
        if (!archived) continue;
      }

      // UNCACHED — MONEY-1373, and the D1 path is switched with the intraday
      // one so there is ONE rule rather than two. `readColdShard` writes the
      // decoded shard into Redis twice per key (the fresh entry and its
      // `:last-good` twin) with no size guard, which is right for a read path
      // that re-reads a decade of shards per chart and wrong for a verification
      // asked once and never again.
      const outcome = await readColdShardUncached({
        market: group.market,
        timeframe: group.timeframe,
        symbol: group.symbol,
        year: group.year,
      });

      if (outcome.status === "failed") {
        // NOT `absent`. A GCS outage is the absence of an ANSWER, and treating
        // it as "there is no shard" would be the same collapse `ColdShardOutcome`
        // splits three ways to prevent — arriving on the delete side, where it
        // would instead read as "no shard, so keep" only by luck of which
        // default we chose. Counted as its own thing, and after the call.
        tally.shardReadFailures++;
        tally.keptShardUnreadable += group.rows.length;
        log.warn(
          `Shard read FAILED for ${group.market}/${group.timeframe}/` +
            `${group.symbol}/${group.year}; ${group.rows.length} row(s) kept.`,
        );
        continue;
      }
      if (outcome.status === "absent") {
        tally.keptNoShard += group.rows.length;
        log.warn(
          `NO COLD SHARD at ${group.market}/${group.timeframe}/${group.symbol}/` +
            `${group.year} — ${group.rows.length} row(s) KEPT. Mongo is the only ` +
            `copy of those bars; deleting them would be data loss.`,
        );
        continue;
      }

      const coverage = partitionByShardCoverage(group.rows, outcome.bars);
      tally.keptNotInShard += coverage.notInShard.length;
      if (coverage.notInShard.length > 0) {
        log.warn(
          `Shard ${group.market}/${group.timeframe}/${group.symbol}/${group.year} ` +
            `exists but does not hold ${coverage.notInShard.length} of ` +
            `${group.rows.length} row(s); those were KEPT.`,
        );
      }
      if (coverage.deletable.length === 0) continue;

      if (!applied) {
        // DRY RUN. The verification ran in full — that is the point of a dry
        // run on a destructive job — and the rows that WOULD have gone are
        // counted in their own bucket rather than in `deleted`, so the outcome
        // line cannot read as work performed.
        tally.keptNotArmed += coverage.deletable.length;
        continue;
      }

      // The rows from chunks that did not THROW — not every deletable row.
      // A multi-chunk delete whose second chunk was rejected leaves those rows
      // in Mongo, and calling them deleted would both mis-position the chain's
      // skip and hand the ledger a year it must not clear.
      deleted.push(...(await deleteRows(coverage.deletable, tally)));
    }

    // ── LEDGER ────────────────────────────────────────────────────────────
    // Only the LOADED rule touches it: `hotLoadedYears` records hot LOADS, and
    // neither WINDOW row — annual or intraday — was ever loaded.
    if (rule === "LOADED" && deleted.length > 0) {
      const ledger = await clearLedgerYears(deleted, startedAt);
      ledgerYearsCleared = ledger.cleared;
      ledgerYearsSkipped = ledger.skipped;
    }

    if (!evictTallyBalances(tally)) {
      // A tally that does not close means a row was counted twice or not at
      // all. Loud, because every number below it is then untrustworthy — and an
      // untrustworthy zero reads as healthy.
      log.error(
        `TALLY DOES NOT BALANCE: ${JSON.stringify(tally)} — the per-run counters ` +
          `cannot be relied on for this run.`,
      );
    }

    const verdict = judgeEvictRun({
      tally,
      disabled,
      armed: applied,
      coldStoreRegistered,
    });

    log.info(
      `rule=${rule} selected ${tally.selected}, examined ${tally.examined}, ` +
        `deleted ${tally.deleted}, kept[noShard ${tally.keptNoShard}, ` +
        `unreadable ${tally.keptShardUnreadable}, notInShard ${tally.keptNotInShard}, ` +
        `dryRun ${tally.keptNotArmed}, nonUS ${tally.keptNonUs}], ` +
        `deleteFailures ${tally.deleteFailures}, vanished ${tally.deleteVanished}, ` +
        `budgetSkipped ${tally.budgetSkipped}, ledgerYearsCleared ${ledgerYearsCleared}, ` +
        `ledgerYearsSkipped ${ledgerYearsSkipped}`,
    );

    reportJobOutcome({
      job: "candle-evict",
      selected: tally.selected,
      // A deleting job's "written" is what it removed — the number that says
      // the run did its work. `selected > 0 && written === 0` is then exactly
      // the alarm the metric is for: rows were due and none went. Every
      // LEGITIMATE zero (disabled, unarmed, no shard) carries a
      // `skippedReason`, so a dry run cannot page anyone.
      written: tally.deleted,
      failed: tally.deleteFailures + tally.shardWriteFailures,
      transportFailures: tally.shardReadFailures,
      ...(verdict.reason ? { skippedReason: verdict.reason } : {}),
    });

    chained = await chainNext({
      msg,
      rule,
      skipRows,
      batchSize,
      chainDepth,
      tally,
      ruleScoped,
      // NOT `examined - deleted`. The groups are walked in group order while
      // the page is in row order, so a budget break truncates a NON-PREFIX and
      // the whole-page figure would advance the skip past rows nobody examined.
      kept: chainKeptBeforeUnexamined(
        rows,
        unexaminedIds,
        new Set(deleted.map((r) => r.id)),
      ),
    });

    if (!verdict.ok) log.error(verdict.reason);
    else if (verdict.reason) log.info(verdict.reason);

    return {
      ...tally,
      rule,
      ruleScoped,
      skipRows,
      ledgerYearsCleared,
      ledgerYearsSkipped,
      applied,
      disabled,
      chained,
      chainDepth,
      leavesPublished: 0,
      leavesFailed: 0,
      ok: verdict.ok,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
    };
  } catch (error) {
    const reason = `candle-evict failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    log.error(reason);
    reportJobOutcome({
      job: "candle-evict",
      selected: tally.selected,
      written: tally.deleted,
      failed: tally.deleteFailures + tally.shardWriteFailures,
      transportFailures: tally.shardReadFailures,
      skippedReason: reason,
    });
    return {
      ...tally,
      rule,
      ruleScoped,
      skipRows,
      ledgerYearsCleared,
      ledgerYearsSkipped,
      applied,
      disabled,
      chained,
      chainDepth,
      leavesPublished: 0,
      leavesFailed: 0,
      ok: false,
      reason,
    };
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   Internals
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Archive a WINDOW group's bars to its cold shard. Returns whether it landed.
 *
 * `merge` is left at its default TRUE, and that is load-bearing rather than
 * cautious: a GCS write is a REPLACE, a page can cut a symbol-year in half, and
 * a `merge: false` here would delete the other half of the year from the object
 * on its way to archiving this half. `mergeColdBars` owns the union rule.
 *
 * A failure keeps the whole group. The rows are still in Mongo and the next run
 * retries them, which is the only correct direction: an archive that did not
 * land is a row with exactly one copy.
 */
async function archiveGroup(
  group: EvictShardGroup,
  tally: EvictTally,
): Promise<boolean> {
  const bars: CandleBar[] = group.rows.map(toColdBarFromCandidate);
  try {
    await writeColdShard({
      market: group.market,
      timeframe: group.timeframe,
      symbol: group.symbol,
      year: group.year,
      bars,
    });
    return true;
  } catch (error) {
    // AFTER the call it counts. Incrementing beside the loop variable is how a
    // leg that fails on every request still reports a full-looking number
    // (MONEY-1255).
    tally.shardWriteFailures++;
    tally.keptShardUnreadable += group.rows.length;
    log.warn(
      `Could not archive ${group.market}/${group.timeframe}/${group.symbol}/` +
        `${group.year} (${group.rows.length} row(s)); they were KEPT: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Rows per `deleteMany`. Bounded so one `$in` stays a sane query. */
const DELETE_CHUNK = 500;

/**
 * Delete verified rows by `_id`. Returns the rows that are GONE.
 *
 * Rows, not a count, because two callers need to know WHICH: the chain's skip
 * accumulator (a row still in Mongo must stay in front of the cursor) and the
 * ledger (a year is only re-counted if something in it actually went).
 *
 * A chunk that threw contributes nothing — those rows are still there. A chunk
 * that succeeded contributes ALL of its rows, including any the driver did not
 * count: `res.count < slice.length` means somebody else removed them first, so
 * they are gone from the population even though they are not gone BY US, and
 * the two facts get separate counters.
 *
 * `into` names WHICH counter the successes land in (MONEY-1373). The intraday
 * leaf deletes two populations through this one function — rows it archived,
 * and rows a stronger source already owns — and folding them together would
 * hide the second: `deletedOutranked` climbing night after night is the only
 * signal that the Databento append's own delete leg is failing. The failure
 * and vanished counters stay SHARED, because those are properties of the
 * `deleteMany`, not of why the rows were selected.
 */
async function deleteRows(
  rows: readonly EvictCandidate[],
  tally: EvictTally,
  into: "deleted" | "deletedOutranked" = "deleted",
): Promise<EvictCandidate[]> {
  const removed: EvictCandidate[] = [];
  for (let i = 0; i < rows.length; i += DELETE_CHUNK) {
    const slice = rows.slice(i, i + DELETE_CHUNK);
    try {
      const res = await prisma.candle.deleteMany({
        where: { id: { in: slice.map((r) => r.id) } },
      });
      // From the DRIVER's count, after the call — not from `slice.length`. A
      // row a concurrent writer already removed is not one we deleted, and
      // reporting the ask instead of the answer is the shape that hid a
      // five-month outage (MONEY-1220).
      tally[into] += res.count;
      // The gap between the ask and the answer, counted rather than dropped.
      // Left out of the tally it balanced nowhere, so a benign concurrent
      // removal printed "TALLY DOES NOT BALANCE" with no exception behind it.
      tally.deleteVanished += Math.max(0, slice.length - res.count);
      removed.push(...slice);
    } catch (error) {
      tally.deleteFailures += slice.length;
      log.warn(
        `deleteMany failed for ${slice.length} row(s): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return removed;
}

/**
 * Clear `UsInstrument.hotLoadedYears` entries that no longer have hot rows.
 *
 * COUNT FIRST, THEN PULL. A page can cut a symbol-year in half, so "we deleted
 * some 2015 rows" is not "2015 is no longer hot" — clearing on the first
 * condition would leave the ledger claiming a year is cold while half of it
 * sits in Mongo, which is the same class of lie as a completeness check at the
 * wrong granularity (MONEY-1189).
 *
 * `$pull` through `$runCommandRaw` because Prisma's scalar-list update offers
 * only `set` and `push`: `set` needs a read-modify-write that loses a
 * concurrent promotion of a different year, and `push` cannot remove anything.
 *
 * ## It has its OWN wall, and it needs one
 *
 * This pass runs after the group loop has already spent `RUN_TIME_BUDGET_MS`,
 * so sharing that budget would mean "already over" on exactly the runs that
 * need bounding. It costs TWO round trips per distinct `(listingId, year)` and
 * a 1,000-row page can hold 1,000 of them — 2,000 round trips, against a
 * headroom line that used to cost the whole pass at "~2s". The deadline is
 * absolute at `startedAt + RUN_TIME_BUDGET_MS + LEDGER_BUDGET_MS` and checked
 * BETWEEN pairs; what it does not reach is RETURNED, not swallowed.
 */
async function clearLedgerYears(
  deleted: readonly EvictCandidate[],
  startedAt: number,
): Promise<{ cleared: number; skipped: number }> {
  const deadlineMs = RUN_TIME_BUDGET_MS + LEDGER_BUDGET_MS;
  const entries = ledgerYearsForDeletions(deleted);
  let cleared = 0;
  let skipped = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (!isWithinRunBudget(startedAt, Date.now(), deadlineMs)) {
      skipped = entries.length - i;
      log.warn(
        `Ledger pass stopped on its own budget with ${skipped} ` +
          `(listingId, year) pair(s) unvisited. The rows are already deleted ` +
          `and correct; hotLoadedYears is a stale SUMMARY until the next run.`,
      );
      break;
    }
    const bounds = yearBounds(entry.year);
    const remaining = await prisma.candle.count({
      where: {
        listingId: entry.listingId,
        // POSITIVE on tier, exactly as the selection is.
        tier: "LOADED",
        ts: { gte: bounds.gte, lt: bounds.lt },
      },
    });
    if (remaining > 0) continue;

    try {
      await prisma.$runCommandRaw({
        update: "us_instruments",
        updates: [
          {
            q: { listingId: entry.listingId },
            u: { $pull: { hotLoadedYears: entry.year } },
            multi: false,
          },
        ],
        ordered: false,
      });
      cleared++;
    } catch (error) {
      // The rows are already gone and correct; a ledger that still lists the
      // year is a stale SUMMARY, not lost data. Never fail the run for it.
      log.warn(
        `Could not clear hotLoadedYears ${entry.year} for ${entry.listingId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { cleared, skipped };
}

/**
 * Publish the next link, if there is one.
 *
 * The termination proof is `nextEvictStep`, which consults no database, no
 * clock and no queue — see its doc. A failed publish costs one delayed page and
 * must never fail a run that otherwise succeeded: the daily scheduler starts a
 * fresh chain regardless.
 */
async function chainNext(opts: {
  msg: CandleEvictMessage | undefined;
  rule: EvictRule;
  skipRows: number;
  batchSize: number;
  chainDepth: number;
  tally: EvictTally;
  ruleScoped: boolean;
  kept: number;
}): Promise<boolean> {
  const {
    msg,
    rule,
    skipRows,
    batchSize,
    chainDepth,
    tally,
    ruleScoped,
    kept,
  } = opts;

  const step = nextEvictStep({
    rule,
    skipRows,
    selected: tally.selected,
    batchSize,
    kept,
    chainDepth,
    ruleScoped,
  });

  if (step === null) {
    log.info(
      `Not chaining (depth ${chainDepth}/${MAX_CHAIN_DEPTH}, rule ${rule}, ` +
        `selected ${tally.selected}/${batchSize}, scoped ${ruleScoped})`,
    );
    return false;
  }

  if (step.rule !== rule) {
    // LOUD, because the two reasons a rule yields are not the same event and
    // the second one used to be invisible: a rule that still has a full page of
    // work is being cut off so the rules behind it are not starved for the
    // night (`ruleDepthBandEnd`).
    log.info(
      tally.selected >= batchSize
        ? `Handing the chain from ${rule} to ${step.rule} at depth ` +
            `${chainDepth + 1}: ${rule} still has a FULL page of work but has ` +
            `spent its depth band. Its remainder waits for tomorrow's chain; ` +
            `without this handover ${step.rule} would not run at all tonight.`
        : `Handing the chain from ${rule} to ${step.rule} at depth ` +
            `${chainDepth + 1}: ${rule} is drained.`,
    );
  }

  try {
    const pubsub = getPubSubClient();
    const topic = pubsub.topic(getTopicName(PUBSUB_TOPICS.CANDLE_EVICT));
    // The follow-up inherits the ORIGINAL scope (page size, apply narrowing) so
    // a tuned run stays tuned. Only the rule, the skip and the depth move.
    const next: CandleEvictMessage = {
      ...msg,
      batchSize,
      rule: step.rule,
      skipRows: step.skipRows,
      chainDepth: chainDepth + 1,
      // The OPERATOR's intent, carried verbatim rather than re-derived. Every
      // link carries `rule`, so without this field the next link would read
      // itself as scoped and refuse to advance to the rule after it.
      ruleScoped,
    };
    await topic.publishMessage({ json: next });
    log.info(
      `Chained candle-evict ${chainDepth + 1}/${MAX_CHAIN_DEPTH} ` +
        `(rule ${step.rule}, skip ${step.skipRows})`,
    );
    return true;
  } catch (error) {
    log.warn(
      `Failed to chain the next candle-evict batch: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/* ─────────────────────────────────────────────────────────────────────────
   WINDOW_INTRADAY — a planner and its leaves (MONEY-1373)
   ──────────────────────────────────────────────────────────────────────── */

/** Everything both halves need from the caller that already resolved it. */
interface IntradayRunBase {
  ruleScoped: boolean;
  skipRows: number;
  applied: boolean;
  disabled: boolean;
  chainDepth: number;
  coldStoreRegistered: boolean;
}

/**
 * `cursor.batchSize` for the planning aggregation.
 *
 * Sized past the whole population rather than tuned: 507 M1 units plus ~14,063
 * H1 units is ~14,570, and the reply carries two short strings per row. The
 * number is not the guard — the `cursor.id !== 0` throw below is.
 */
const PLAN_CURSOR_BATCH = 100_000;

/** Leaves per `Promise.allSettled` wave. */
const LEAF_PUBLISH_CHUNK = 500;

interface PlanCursorReply {
  cursor?: {
    firstBatch?: Array<{ _id?: { symbol?: unknown; timeframe?: unknown } }>;
    id?: unknown;
  };
}

/** A zeroed tally. The two intraday halves each start from one. */
function emptyTally(): EvictTally {
  return {
    selected: 0,
    examined: 0,
    deleted: 0,
    keptNoShard: 0,
    keptShardUnreadable: 0,
    keptNotInShard: 0,
    keptNotArmed: 0,
    keptNonUs: 0,
    budgetSkipped: 0,
    shardWriteFailures: 0,
    shardReadFailures: 0,
    deleteFailures: 0,
    deleteVanished: 0,
    deletedOutranked: 0,
  };
}

/**
 * THE PLANNER. Groups the due intraday rows into `(symbol, timeframe)` units
 * and publishes ONE LEAF PER UNIT back onto this same topic.
 *
 * ## It deletes nothing and it never chains
 *
 * Its tally stays all-zero on purpose: it examines no rows, so `selected: 0` is
 * the honest answer and `evictTallyBalances` closes trivially. The unit counts
 * live in `leavesPublished` / `leavesFailed` and in the outcome metric, where
 * `selected` is UNITS and `written` is messages that left.
 *
 * ## A TRUNCATED PLAN IS THE FAILURE THIS THROWS TO PREVENT
 *
 * `$runCommandRaw` returns `cursor.firstBatch` and, if the server has more, a
 * NON-ZERO `cursor.id`. Following the cursor is not available through Prisma's
 * raw command, and — more to the point — a short answer here does not look
 * short: it evicts a PREFIX of the universe, reports success, and leaves the
 * tail growing forever with nothing to distinguish it from a small population.
 * That is MONEY-1189's wrong-granularity class exactly. `aggregateAll` in
 * `packages/core/src/market-data/databento/databento-repo.ts:423` makes the
 * same call for the same reason; the shape is restated here rather than
 * imported because that module is Databento's and this is not.
 *
 * ## It publishes even when DISARMED, and says so
 *
 * A leaf does its own dry-run verification — reads the shard, partitions the
 * sessions, counts what it WOULD delete — which is the whole point of a dry run
 * on a destructive job and is exactly what the row-paged rules already do.
 * Refusing to fan out while disarmed would make the disarmed run report a
 * healthy zero for a population nobody measured.
 */
async function processIntradayPlan(
  msg: CandleEvictMessage | undefined,
  now: Date,
  base: IntradayRunBase,
): Promise<CandleEvictResult> {
  const tally = emptyTally();
  let published = 0;
  let failed = 0;

  const finish = (ok: boolean, reason?: string): CandleEvictResult => ({
    ...tally,
    rule: "WINDOW_INTRADAY",
    ruleScoped: base.ruleScoped,
    skipRows: base.skipRows,
    ledgerYearsCleared: 0,
    ledgerYearsSkipped: 0,
    applied: base.applied,
    disabled: base.disabled,
    chained: false,
    chainDepth: base.chainDepth,
    leavesPublished: published,
    leavesFailed: failed,
    ok,
    ...(reason ? { reason } : {}),
  });

  try {
    const reply = (await prisma.$runCommandRaw({
      aggregate: "candles",
      pipeline: buildIntradayPlanPipeline(now),
      cursor: { batchSize: PLAN_CURSOR_BATCH },
      // 22.8M hot intraday rows at steady state. A `$group` over that spills.
      allowDiskUse: true,
    } as never)) as PlanCursorReply;

    const rows = reply.cursor?.firstBatch ?? [];
    if (String(reply.cursor?.id ?? "0") !== "0") {
      throw new Error(
        `candle-evict plan: the server returned ${rows.length} unit(s) and ` +
          `kept the cursor OPEN, so this plan is PARTIAL. Refusing to fan out ` +
          `— a short plan evicts a prefix of the universe and reports success, ` +
          `which is indistinguishable from a small population (MONEY-1189).`,
      );
    }

    const units = orderIntradayLeaves(
      rows
        .map((r) => ({ symbol: r._id?.symbol, timeframe: r._id?.timeframe }))
        .filter(
          (u): u is IntradayUnit =>
            typeof u.symbol === "string" &&
            u.symbol !== "" &&
            typeof u.timeframe === "string" &&
            u.timeframe !== "",
        ),
    );

    log.info(
      `PLAN ${units.length} intraday unit(s) due below ` +
        `${buildIntradayUnitWhere({ symbol: "", timeframe: "" }, now).ts.lt.toISOString()}` +
        (base.applied
          ? ""
          : " — NOT ARMED, publishing anyway: each leaf dry-runs its own " +
            "verification, and refusing to fan out would report a healthy " +
            "zero for a population nobody measured"),
    );

    if (units.length > 0) {
      const pubsub = getPubSubClient();
      const topic = pubsub.topic(getTopicName(PUBSUB_TOPICS.CANDLE_EVICT));
      for (let i = 0; i < units.length; i += LEAF_PUBLISH_CHUNK) {
        // ALL-SETTLED WAVES, not one awaited publish each. 14,570 sequential
        // publishes at ~20ms is ~290s, which would spend half the ack deadline
        // on the fan-out alone and make the planner the very bottleneck it
        // exists to remove.
        const wave = await Promise.allSettled(
          units.slice(i, i + LEAF_PUBLISH_CHUNK).map((unit) =>
            topic.publishMessage({
              json: {
                // NARROWS ONLY, exactly as everywhere else: a leaf can be told
                // not to delete, never told to.
                ...(msg?.apply === false ? { apply: false as const } : {}),
                rule: "WINDOW_INTRADAY" as const,
                ruleScoped: true,
                unit,
              },
            }),
          ),
        );
        for (const r of wave) {
          if (r.status === "fulfilled") published++;
          else failed++;
        }
      }
    }

    reportJobOutcome({
      job: "candle-evict",
      selected: units.length,
      written: published,
      failed,
    });

    if (failed > 0) {
      const reason =
        `${failed} of ${units.length} intraday leaf publish(es) were rejected; ` +
        `those units are not evicted tonight and tomorrow's plan re-selects them`;
      log.error(reason);
      return finish(false, reason);
    }
    log.info(`Published ${published} intraday leaf message(s)`);
    return finish(
      true,
      units.length === 0 ? "no intraday unit is due for eviction" : undefined,
    );
  } catch (error) {
    const reason = `candle-evict intraday plan failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    log.error(reason);
    reportJobOutcome({
      job: "candle-evict",
      selected: 0,
      written: published,
      failed: failed + 1,
      skippedReason: reason,
    });
    return finish(false, reason);
  }
}

/**
 * A LEAF. One `(symbol, timeframe)`, one (two at 1 January) shard
 * read-modify-write, and its own rows deleted.
 *
 * ## No wall clock, no chain, no depth band — and that is the point
 *
 * The unit of work IS the unit of delivery, so the 600s ack deadline bounds ONE
 * shard read-modify-write rather than a page of them: ~5 s for M1, ~1 s for H1
 * against the measured codec. `RUN_TIME_BUDGET_MS` exists because the row-paged
 * rules can be handed more work than fits a message; a leaf cannot be. Nothing
 * here can truncate, so nothing here needs a follow-up to reach the remainder,
 * and there is no `skip` accumulator whose soundness has to be argued.
 *
 * A year boundary is the only reason a leaf touches two shards: `ts` selects up
 * to `INTRADAY_HOT_WINDOW_DAYS` back, so on 1-14 January part of the unit sits
 * in the previous year's object. `groupCandidatesByShard` produces both.
 *
 * ## The verifying read is UNCACHED, and so is every other one now
 *
 * `readColdShardUncached`, never `readColdShard`. The cached read writes the
 * decoded shard into Redis twice (the fresh entry and its `:last-good` twin),
 * with no size guard; a 242,000-bar M1 shard is ~36 MB as JSON and the first
 * intraday night walks ~14,570 units. That is tens of gigabytes pushed into a
 * cache to answer a question asked once. The D1 path above was switched with
 * it — one rule, not two.
 */
async function processIntradayLeaf(
  unit: IntradayUnit,
  tally: EvictTally,
  now: Date,
  base: IntradayRunBase,
): Promise<CandleEvictResult> {
  const label = `${unit.symbol}/${unit.timeframe}`;

  const finish = (ok: boolean, reason?: string): CandleEvictResult => ({
    ...tally,
    rule: "WINDOW_INTRADAY",
    ruleScoped: true,
    skipRows: 0,
    ledgerYearsCleared: 0,
    ledgerYearsSkipped: 0,
    applied: base.applied,
    disabled: base.disabled,
    chained: false,
    chainDepth: base.chainDepth,
    leavesPublished: 0,
    leavesFailed: 0,
    ok,
    ...(reason ? { reason } : {}),
  });

  try {
    const candidates = (await prisma.candle.findMany({
      where: buildIntradayUnitWhere(unit, now),
      select: {
        id: true,
        symbol: true,
        exchange: true,
        timeframe: true,
        ts: true,
        listingId: true,
        open: true,
        high: true,
        low: true,
        close: true,
        volume: true,
        divCash: true,
        splitFactor: true,
        source: true,
      },
    })) as Array<Omit<EvictCandidate, "volume"> & { volume: bigint }>;

    // BigInt -> number at the store boundary, as the paged path does it: a
    // `bigint` reaching arithmetic that also touches a `number` throws, and a
    // shard round-trips through JSON, which rejects BigInt outright.
    const rows: EvictCandidate[] = candidates.map((row) => ({
      ...row,
      volume: Number(row.volume),
    }));
    tally.selected = rows.length;

    const { groups, nonUs } = groupCandidatesByShard(rows);
    tally.examined += nonUs.length;
    tally.keptNonUs += nonUs.length;

    for (const group of groups) {
      tally.examined += group.rows.length;
      const shardLabel = `${group.market}/${group.timeframe}/${group.symbol}/${group.year}`;

      const existing = await readColdShardUncached({
        market: group.market,
        timeframe: group.timeframe,
        symbol: group.symbol,
        year: group.year,
      });
      if (existing.status === "failed") {
        // NOT `absent`. A GCS outage is the absence of an ANSWER; reading it as
        // "there is no shard" would decide an authority question from a
        // network failure.
        tally.shardReadFailures++;
        tally.keptShardUnreadable += group.rows.length;
        log.warn(
          `Shard read FAILED for ${shardLabel}; ${group.rows.length} row(s) kept.`,
        );
        continue;
      }
      const shardBars = existing.status === "present" ? existing.bars : [];

      const part = partitionIntradayBySessionAuthority(
        group.rows,
        shardBars,
        group.timeframe,
      );
      // Unreachable from here — the route narrows a leaf's timeframe to the
      // intraday set and the `where` pins it — but accounted rather than
      // dropped, and accounted as a hot/cold DISAGREEMENT so `judgeEvictRun`
      // says so out loud if it ever happens.
      tally.keptNotInShard += part.refused.length;

      let deletable: EvictCandidate[] = [];
      if (part.archive.length > 0) {
        try {
          await writeColdShard({
            market: group.market,
            timeframe: group.timeframe,
            symbol: group.symbol,
            year: group.year,
            bars: part.shardBars,
            // The array IS the object. `partitionIntradayBySessionAuthority`
            // already unioned the existing bars in, minus what a displacement
            // removes — the harvest's own union-then-write shape. A merge here
            // would resurrect exactly the bars a displacement just dropped.
            merge: false,
          });
        } catch (error) {
          tally.shardWriteFailures++;
          tally.keptShardUnreadable +=
            part.archive.length + part.outranked.length;
          log.warn(
            `Could not archive ${shardLabel} (${part.archive.length} row(s)); ` +
              `they were KEPT, and so were ${part.outranked.length} outranked ` +
              `row(s) from the same group: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
          continue;
        }

        // The write's own success is NOT the evidence. Same rule as the paged
        // path: the only proof a row may be deleted is a READ that shows the
        // shard holding its exact natural key.
        const verify = await readColdShardUncached({
          market: group.market,
          timeframe: group.timeframe,
          symbol: group.symbol,
          year: group.year,
        });
        if (verify.status === "failed") {
          tally.shardReadFailures++;
          tally.keptShardUnreadable +=
            part.archive.length + part.outranked.length;
          log.warn(`Verifying read FAILED for ${shardLabel}; rows kept.`);
          continue;
        }
        if (verify.status === "absent") {
          tally.keptNoShard += part.archive.length + part.outranked.length;
          log.warn(
            `NO COLD SHARD at ${shardLabel} immediately after writing it — ` +
              `rows KEPT. Mongo is the only copy.`,
          );
          continue;
        }

        const coverage = partitionByShardCoverage(part.archive, verify.bars);
        tally.keptNotInShard += coverage.notInShard.length;
        if (coverage.notInShard.length > 0) {
          log.warn(
            `Shard ${shardLabel} does not hold ${coverage.notInShard.length} of ` +
              `${part.archive.length} archived row(s); those were KEPT.`,
          );
        }
        deletable = coverage.deletable;
      }

      if (part.dropped.length > 0) {
        log.info(
          `DISPLACED ${part.dropped.length} bar(s) out of ${shardLabel}: ` +
            `${[...new Set(part.dropped.map((b) => b.source))].join(", ")} lost ` +
            `the session to a stronger source.`,
        );
      }

      if (!base.applied) {
        // DRY RUN. The verification ran in full — the point of a dry run on a
        // destructive job — and both populations are counted where they cannot
        // read as work performed.
        tally.keptNotArmed += deletable.length + part.outranked.length;
        continue;
      }

      await deleteRows(deletable, tally);
      if (part.outranked.length > 0) {
        // Archived by NOBODY, and correctly so: the shard already holds this
        // session from a stronger source. These rows are the residue of a
        // failed `deleteSessionRows` in the Databento append, and while they
        // sit here `mergeHotAndCold`'s hot precedence SERVES them over the
        // stronger shard bars.
        await deleteRows(part.outranked, tally, "deletedOutranked");
        log.warn(
          `${part.outranked.length} row(s) of ${shardLabel} were outranked by ` +
            `the shard's own session source and deleted WITHOUT archiving. A ` +
            `count that climbs nightly means the append's delete leg is failing.`,
        );
      }
    }

    if (!evictTallyBalances(tally)) {
      log.error(
        `TALLY DOES NOT BALANCE: ${JSON.stringify(tally)} — the per-run ` +
          `counters cannot be relied on for this leaf.`,
      );
    }

    const verdict = judgeEvictRun({
      tally,
      disabled: base.disabled,
      armed: base.applied,
      coldStoreRegistered: base.coldStoreRegistered,
    });

    log.info(
      `LEAF ${label} selected ${tally.selected}, examined ${tally.examined}, ` +
        `deleted ${tally.deleted}, outranked ${tally.deletedOutranked}, ` +
        `kept[noShard ${tally.keptNoShard}, unreadable ${tally.keptShardUnreadable}, ` +
        `notInShard ${tally.keptNotInShard}, dryRun ${tally.keptNotArmed}, ` +
        `nonUS ${tally.keptNonUs}], deleteFailures ${tally.deleteFailures}, ` +
        `vanished ${tally.deleteVanished}`,
    );

    reportJobOutcome({
      job: "candle-evict",
      selected: tally.selected,
      // BOTH deletion buckets. An outranked row is work performed — it closes a
      // hole where weaker hot bars were being served over a stronger shard —
      // and leaving it out would make a leaf that did nothing else report the
      // `selected > 0 && written === 0` alarm for a completed job.
      written: tally.deleted + tally.deletedOutranked,
      failed: tally.deleteFailures + tally.shardWriteFailures,
      transportFailures: tally.shardReadFailures,
      ...(verdict.reason ? { skippedReason: verdict.reason } : {}),
    });

    if (!verdict.ok) log.error(verdict.reason);
    else if (verdict.reason) log.info(verdict.reason);
    return finish(verdict.ok, verdict.reason);
  } catch (error) {
    const reason = `candle-evict leaf ${label} failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    log.error(reason);
    reportJobOutcome({
      job: "candle-evict",
      selected: tally.selected,
      written: tally.deleted + tally.deletedOutranked,
      failed: tally.deleteFailures + tally.shardWriteFailures,
      transportFailures: tally.shardReadFailures,
      skippedReason: reason,
    });
    return finish(false, reason);
  }
}
