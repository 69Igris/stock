/**
 * Candle eviction — PURE decisions (no Prisma, no GCS, no clock, no timers).
 *
 * The sibling `candle-evict.ts` does the I/O and CALLS every export here, so
 * the production path and the tests run the same code. Nothing in this file can
 * orphan a handle or need a database, which is what lets the two rules that
 * DELETE ROWS be exercised exhaustively.
 *
 * ## The two rules, and why one column decides between them
 *
 *   `tier: "LOADED"`, `hotLoadedAt` older than {@link HOT_LOAD_TTL_DAYS}
 *        A year somebody pulled back out of a cold shard on request. It earns
 *        its place in Mongo by being READ; 30 days after the last read it stops
 *        earning it.
 *
 *   `tier: "WINDOW"`, a NON-INTRADAY bar year below {@link hotWindowFloorYear}
 *        A rolling-window row whose year has fallen out of the window. Fires
 *        once a year, for every symbol at the same instant.
 *
 *   `tier: "WINDOW"`, an INTRADAY bar older than {@link intradayHotFloorTs}
 *        MONEY-1373. Same tier, same table, a boundary three orders of
 *        magnitude tighter: an M1 symbol-year is ~242,000 rows against D1's
 *        ~252, so the 10-year rule applied to Databento's feed would park
 *        ~1.2 billion rows in Mongo. Fires EVERY DAY rather than once a year.
 *
 * Without `Candle.tier` the first two are indistinguishable — "2015 AAPL,
 * outside the window, delete" and "2015 AAPL, a user is reading it right now,
 * keep" are the same row — which is exactly why the column exists and why a wall-clock
 * TTL index could not have replaced it.
 *
 * ## Selection is POSITIVE on `tier`, always
 *
 * `{tier: "WINDOW"}`, never `{hotLoadedAt: null}`. A Mongo `db push` creates
 * indexes and not fields, so on every row written before the column existed the
 * attribute is ABSENT, and both `{hotLoadedAt: null}` and
 * `{hotLoadedAt: {not: null}}` return ZERO. That class has caused MONEY-1050,
 * MONEY-1205, MONEY-1234 and MONEY-1235. `@@index([tier, hotLoadedAt])` is
 * declared for exactly the positive query.
 */

import {
  candleKey,
  hotWindowFloorYear,
  intradayHotFloorTs,
  INTRADAY_TIMEFRAMES,
  marketForExchange,
  type CandleBar,
} from "@usemoney/core/market-data/candles";
import {
  usMarketDateKey,
  usMarketDayBoundsUtc,
} from "@usemoney/core/market-data/us-market-hours";
// REUSED, never restated. `decideSessionWrite` is the SAME rule the Databento
// append applies when it writes a session, and the eviction is the other half
// of that conversation — a leaf archives into a shard the append may already
// have filled from a stronger source. Two spellings of one authority rule is
// how a session ends up holding two sources, which is the mixed-volume defect
// MONEY-1309 exists to prevent.
import { decideSessionWrite } from "@usemoney/core/market-data/databento/databento-day-authority";

/* ─────────────────────────────────────────────────────────────────────────
   Rules
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The eviction rules, in the order one run walks them.
 *
 * `WINDOW_INTRADAY` is LAST deliberately. `ruleDepthBandEnd` gives the final
 * rule everything up to `MAX_CHAIN_DEPTH`, so the rule with the largest and
 * fastest-growing population — a daily boundary over a minute-bar feed —
 * inherits every link the two ahead of it drain early, instead of being the one
 * a band remainder strands.
 */
export const EVICT_RULES = ["LOADED", "WINDOW", "WINDOW_INTRADAY"] as const;
export type EvictRule = (typeof EVICT_RULES)[number];

/**
 * How long a hot-loaded year survives its last read.
 *
 * Declared HERE and nowhere else. The stamping side (`CandleRepository`) does
 * not know it and must not: a writer that knew the TTL would be free to
 * disagree with the deleter about it, and this is the one number where a
 * disagreement is measured in deleted rows.
 */
export const HOT_LOAD_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows stamped before this are no longer earning their place in Mongo. */
export function hotLoadCutoff(now: Date): Date {
  return new Date(now.getTime() - HOT_LOAD_TTL_DAYS * DAY_MS);
}

/**
 * The `ts` below which a `WINDOW` row has fallen out of the rolling window.
 *
 * DERIVED from `hotWindowFloorYear`, which is core's single statement of where
 * the window starts, rather than restating `now.getUTCFullYear() -
 * HOT_WINDOW_YEARS`. The two would then be one rule spelled twice — and on this
 * pair a one-year drift is not a rounding difference, it is a year of prices
 * deleted early or a year retained forever.
 *
 * UTC, matching `Candle.ts`'s own definition and `coldYearsForRange`. A
 * boundary computed in a different calendar than the rows it partitions puts 31
 * December on both sides of itself.
 */
export function windowFloorTs(now: Date): Date {
  return new Date(Date.UTC(hotWindowFloorYear(now), 0, 1, 0, 0, 0, 0));
}

/* ─────────────────────────────────────────────────────────────────────────
   Switches — a kill switch and an arming switch, which are not the same thing
   ──────────────────────────────────────────────────────────────────────── */

/**
 * `CANDLE_EVICT=off` — the whole job does nothing. A deliberate skip, not a
 * failure.
 *
 * Compared against the LITERAL string, never `Boolean()`: `Boolean("false")` is
 * `true`, which would leave the one configuration meant to disable the job
 * running it. "off" is therefore the only disabling value and absent means ON,
 * matching `EDGAR_CIK_ENRICH` / `BSE_MASTER_ENRICH` rather than inventing a
 * second convention.
 */
export function isEvictionDisabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (env.CANDLE_EVICT ?? "").trim().toLowerCase() === "off";
}

/**
 * `CANDLE_EVICT_APPLY=true` — the DELETE arm.
 *
 * Ships PRESENT and `"false"` in both cloudbuild specs, because an absent var
 * and a `"false"` var must not be the same state: "absent" is exactly how
 * `MF_METADATA_PROVIDER` disabled its job silently for months (MONEY-1214).
 * Compared against the literal `"true"` for the `Boolean("false")` reason above.
 */
export function isEvictionArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CANDLE_EVICT_APPLY === "true";
}

/**
 * `msg.apply` NARROWS; only the environment can arm.
 *
 * `msg.apply ?? env` and never `msg.apply || env`: an operator dry-running a
 * shape change may turn the deletes off for one run, but publish rights on a
 * topic must not be enough to start deleting price history. Arming is a deploy,
 * which is a review. Same rule as `xbrl-projection`'s `resolveApply`, and the
 * same reason — a write this table cannot undo.
 */
export function resolveEvictApply(
  msg: { apply?: boolean } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (msg?.apply === false) return false;
  return isEvictionArmed(env);
}

/* ─────────────────────────────────────────────────────────────────────────
   Throughput — a wall clock and a chain, never a bigger batch
   ──────────────────────────────────────────────────────────────────────── */

/**
 * Rows per page. A PAGE SIZE and a runaway guard, NOT the throughput control.
 *
 * The per-row cost here is trivial (a compare against an in-memory Set); the
 * cost that matters is per SHARD GROUP — one GCS read, plus a read-modify-write
 * on the WINDOW rule. So a bigger number buys nothing the wall clock does not
 * already govern, which is the lever MONEY-1201 rejected and `workers/CLAUDE.md`
 * names.
 */
export const DEFAULT_EVICT_BATCH_SIZE = 1_000;

/**
 * Wall-clock budget after which the run stops taking a NEW shard group.
 *
 *   600s   Pub/Sub ack deadline — the maximum, and it cannot be raised
 *  -420s   this budget: no new shard group is started past it
 *  ------
 *   180s   headroom, which absorbs, in order:
 *
 *   ~60s   the ONE shard group already in flight. The check is BETWEEN groups,
 *          so the true wall is `budget + one group`. A group's worst case is a
 *          GCS GET + a merge PUT + a verify GET, each bounded by
 *          `CANDLE_COLD_TIMEOUT_MS` (20s) — so ~60s, and bounded rather than
 *          open-ended, unlike `stock-document-extract`'s Document AI call.
 *
 *          THAT TERM IS D1-SIZED AND DESCRIBES NOTHING INTRADAY. It counts
 *          three network round trips and no CPU, which is right for a ~252-bar
 *          daily shard and wrong for an M1 year-shard: measured 2026-09-07 on
 *          node 22 with the real codec, 242,000 bars is 7.95 MB gzipped and
 *          costs 1,042 ms to encode, 486 ms to decode and 122 ms to merge —
 *          ~1.65 s of CPU on top of the transfers, at ~160-250 MB of resident
 *          heap. This budget therefore governs the LOADED and WINDOW rules
 *          only. `WINDOW_INTRADAY` does not page and does not consult it at
 *          all: its unit of work is ONE `(symbol, timeframe)` delivered as its
 *          own message, so the 600s deadline bounds a single shard
 *          read-modify-write instead of a page of them.
 *    60s   {@link LEDGER_BUDGET_MS} — the pass that follows the group loop.
 *          This line used to read "~2s ... and the ledger updates", which was
 *          not derived from anything: the pass costs TWO round trips per
 *          DISTINCT `(listingId, year)` among the deletions, and a 1,000-row
 *          page can hold 1,000 distinct symbol-years. 2,000 round trips, not
 *          two.
 *    ~2s   the page `findMany` and the `deleteMany`s.
 *    ~1s   reportJobOutcome + the chain publish.
 *  ------
 *   ~57s   slack.
 *
 * Overrunning does not make the run slow: Pub/Sub redelivers, a SECOND copy
 * starts on the same page, and two runs then race to delete the same rows while
 * both verify against the same shards. 420s is not a new number —
 * `mf-nav-backfill` and `stock-document-extract` stop on the same wall.
 */
export const RUN_TIME_BUDGET_MS = 420_000;

/**
 * The ledger pass's OWN wall, on top of {@link RUN_TIME_BUDGET_MS}.
 *
 * `clearLedgerYears` runs AFTER the group loop has already spent its budget, so
 * it cannot share it: measured against `RUN_TIME_BUDGET_MS` its deadline is
 * already past on exactly the runs that need bounding, and an unbounded pass
 * there is how a job that stops taking new work at 420s still overruns 600s.
 * Its deadline is therefore ABSOLUTE at
 * `startedAt + RUN_TIME_BUDGET_MS + LEDGER_BUDGET_MS` (480s), checked BETWEEN
 * pairs, which still clears the ack deadline once the worst-case in-flight
 * shard group (~60s) is paid for.
 *
 * Truncating HERE is safe in a way truncating the group loop is not: an entry
 * the pass did not reach is a stale SUMMARY of rows that are already correctly
 * gone, and the next run recomputes it from a fresh page. It is reported as
 * `ledgerYearsSkipped` rather than swallowed — "the ledger is complete" and
 * "the ledger ran out of clock" must not print the same number.
 */
export const LEDGER_BUDGET_MS = 60_000;

/**
 * Hard ceiling on how many times one trigger may re-publish itself.
 *
 * THE TERMINATION PROOF, and it deliberately consults no database, no clock and
 * no queue. Every chained publish carries `chainDepth + 1` and
 * {@link nextEvictStep} refuses once the NEXT depth would reach this value, so
 * a chain is at most this many messages however the population behaves. Every
 * other stop condition can only end it SOONER, so none of them can break the
 * bound.
 */
export const MAX_CHAIN_DEPTH = 20;

/**
 * Sanitise an inbound `chainDepth`.
 *
 * The value arrives off a Pub/Sub payload, so it is `unknown` until proven
 * otherwise. Missing, negative, fractional, NaN or non-numeric reads as 0;
 * anything above the ceiling is CLAMPED TO it, so a forged large value ENDS the
 * chain rather than wrapping it back to the start.
 */
export function normalizeChainDepth(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.min(Math.floor(value), MAX_CHAIN_DEPTH);
}

/** True while the run may start ANOTHER shard group. Clock injected. */
export function isWithinRunBudget(
  startedAtMs: number,
  nowMs: number,
  budgetMs: number = RUN_TIME_BUDGET_MS,
): boolean {
  return nowMs - startedAtMs < budgetMs;
}

/** Page size from a message: positive integers only, else the default. */
export function clampBatchSize(
  value: unknown,
  fallback: number = DEFAULT_EVICT_BATCH_SIZE,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < 1) return fallback;
  return Math.min(n, 10_000);
}

/** Rows to skip. Non-negative integers only. */
export function normalizeSkipRows(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/** A message's `rule`, or null for "walk them all". */
export function normalizeRule(value: unknown): EvictRule | null {
  return EVICT_RULES.includes(value as EvictRule) ? (value as EvictRule) : null;
}

/**
 * Which rule this run walks, and WHETHER AN OPERATOR CHOSE IT.
 *
 * The second half is the one that was wrong, and its failure was silent and
 * total. "An operator scoped this run" was read as `msg.rule !== undefined` —
 * but the chain stamps `rule` on EVERY follow-up (it has to; the link would not
 * know what to walk), so link 0 was unscoped and links 1..N were all scoped.
 * `nextEvictStep` then refused to advance to the next rule on a short page, and
 * with `EVICT_RULES` then `[LOADED, WINDOW]` the WINDOW rule became
 * UNREACHABLE on any night the first LOADED page came back full: the chain walked LOADED to
 * its ceiling and ended without ever running the rule that bounds `candles` at
 * year rollover and the only rule that archives before it deletes. The run
 * reported `ok`, because LOADED had deleted rows.
 *
 * So the intent travels as its OWN field and is not re-derived per link:
 *
 *   `{}`                                  scheduler   -> LOADED, unscoped
 *   `{rule: "WINDOW"}`                    operator    -> WINDOW, SCOPED
 *   `{rule: "WINDOW", ruleScoped: false}` the chain   -> WINDOW, unscoped
 *
 * `ruleScoped` is only ever honoured ALONGSIDE a rule, so forging it introduces
 * no state the field could not already produce: `true` with no rule scopes
 * nothing, and `false` on the last rule only asks to advance past the end of
 * `EVICT_RULES`, which ends the chain.
 */
export function resolveRuleScope(
  msg: { rule?: unknown; ruleScoped?: unknown } | undefined,
): { rule: EvictRule; ruleScoped: boolean } {
  const named = normalizeRule(msg?.rule);
  return {
    rule: named ?? EVICT_RULES[0],
    ruleScoped: named !== null && msg?.ruleScoped !== false,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   Selection
   ──────────────────────────────────────────────────────────────────────── */

/** The `prisma.candle.findMany` WHERE for one rule. Structural, not Prisma-typed. */
export type EvictWhere =
  | { tier: "LOADED"; hotLoadedAt: { lt: Date } }
  | { tier: "WINDOW"; timeframe: { notIn: string[] }; ts: { lt: Date } }
  | { tier: "WINDOW"; timeframe: { in: string[] }; ts: { lt: Date } };

/**
 * Build the selection predicate.
 *
 * `tier` is the literal type on EVERY arm, so a call site cannot widen it to a
 * negative or absent test without failing the compile. There is deliberately no
 * arm that tests `hotLoadedAt` for null — see the module header.
 *
 * ## THE TWO `WINDOW` RULES MUST SELECT DISJOINT POPULATIONS — MONEY-1373
 *
 * The predicates OVERLAP on their own: `ts < 1 Jan (year - 10)` and
 * `ts < now - 45d` both match a twelve-year-old M1 bar. That is not a
 * correctness bug — both arms archive-then-delete into the SAME shard key, so
 * whichever runs first does the work and the other finds nothing — but it makes
 * the two rules' counters lie about each other. `WINDOW` would report having
 * evicted intraday rows, `WINDOW_INTRADAY` would report a smaller backlog than
 * it has, and the one number that is supposed to say "the daily boundary is
 * keeping up with the minute feed" would be measuring the annual one.
 *
 * So the plain `WINDOW` arm EXCLUDES the intraday timeframes and each rule owns
 * exactly its own rows. `notIn` is safe here in a way it would not be one
 * column over: `timeframe` is a REQUIRED String on `Candle` with no default, so
 * it is present on every row that has ever been written. The `hotLoadedAt`
 * null-vs-ABSENT trap the module header describes — where a Mongo `db push`
 * creates indexes and not fields, and both `{f: null}` and `{f: {not: null}}`
 * return ZERO — cannot reach a column that was never optional.
 */
export function buildEvictWhere(rule: EvictRule, now: Date): EvictWhere {
  if (rule === "LOADED") {
    return { tier: "LOADED", hotLoadedAt: { lt: hotLoadCutoff(now) } };
  }
  if (rule === "WINDOW_INTRADAY") {
    return {
      tier: "WINDOW",
      timeframe: { in: [...INTRADAY_TIMEFRAMES] },
      ts: { lt: intradayHotFloorTs(now) },
    };
  }
  return {
    tier: "WINDOW",
    timeframe: { notIn: [...INTRADAY_TIMEFRAMES] },
    ts: { lt: windowFloorTs(now) },
  };
}

/**
 * The ordering. TOTAL, and that is what makes the `skip` accumulator sound.
 *
 * The leading key is index-backed (`@@index([tier, hotLoadedAt])` for LOADED,
 * `@@index([ts])` for WINDOW) and ascending, which is also the right drain
 * order: oldest stamp / oldest bar first. `id` breaks ties, because a page
 * boundary that falls inside a run of equal timestamps has no defined position
 * otherwise — and one promotion stamps a whole symbol-year with the SAME
 * instant, so ties are the norm here rather than the exception.
 */
export function evictOrderBy(rule: EvictRule): Array<Record<string, "asc">> {
  // Both WINDOW rules order by `ts asc`, and the fallthrough already gave them
  // that. Spelled POSITIVELY anyway (MONEY-1373): a `rule === "LOADED" ? … : …`
  // hands every future rule the WINDOW ordering by accident, and an ordering
  // that is merely correct-by-default is the ordering a fourth rule inherits
  // wrongly with nothing to notice it — the leading key would not be indexed
  // and the `skip` accumulator would page over an unordered set.
  if (rule === "LOADED") return [{ hotLoadedAt: "asc" }, { id: "asc" }];
  return [{ ts: "asc" }, { id: "asc" }];
}

/* ─────────────────────────────────────────────────────────────────────────
   Shard grouping + the containment guard
   ──────────────────────────────────────────────────────────────────────── */

/** One candidate row, as the page selects it. */
export interface EvictCandidate {
  id: string;
  symbol: string;
  exchange: string;
  timeframe: string;
  ts: Date;
  listingId: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  divCash: number;
  splitFactor: number;
  source: string;
}

/** The candidates belonging to ONE cold shard object. */
export interface EvictShardGroup {
  market: string;
  timeframe: string;
  symbol: string;
  year: number;
  rows: EvictCandidate[];
}

/**
 * Group candidates by the cold shard that must cover them.
 *
 * The key OMITS the exchange, matching `buildCandleColdKey`: a shard is
 * everything we hold for a ticker in a year across every venue it traded on,
 * and 928 tickers in Tiingo's master appear on more than one exchange. Grouping
 * by exchange here would read the SAME object twice and, worse, would make the
 * WINDOW rule's read-modify-write race itself — two merges of the same key,
 * each overwriting the other's rows.
 *
 * Rows whose market is not US are NOT grouped and come back separately. That is
 * a POSITIVE filter, not a fallthrough: `Candle` holds no India rows today
 * (MONEY-1043 is decided as coexistence) and there are no India shards to
 * verify against, so an India row could only ever be `kept` — counting it as
 * such by NAME is what stops it hiding inside the "shard missing" number, which
 * is the one that should wake somebody.
 */
export function groupCandidatesByShard(rows: readonly EvictCandidate[]): {
  groups: EvictShardGroup[];
  nonUs: EvictCandidate[];
} {
  const groups = new Map<string, EvictShardGroup>();
  const nonUs: EvictCandidate[] = [];
  for (const row of rows) {
    const market = marketForExchange(row.exchange);
    if (market !== "US") {
      nonUs.push(row);
      continue;
    }
    const year = row.ts.getUTCFullYear();
    if (!Number.isInteger(year)) {
      // An `Invalid Date` has no shard and no year. It cannot be verified, so
      // it cannot be deleted; it rides with the non-US bucket rather than
      // inventing a group whose key would be `candles/US/D1/AAPL/NaN`.
      nonUs.push(row);
      continue;
    }
    const key = `${market}\u0000${row.timeframe}\u0000${row.symbol}\u0000${year}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        market,
        timeframe: row.timeframe,
        symbol: row.symbol,
        year,
        rows: [],
      };
      groups.set(key, group);
    }
    group.rows.push(row);
  }
  return { groups: [...groups.values()], nonUs };
}

/** A candidate row as the cold bar it must be archived as. */
export function toColdBarFromCandidate(row: EvictCandidate): CandleBar {
  return {
    symbol: row.symbol,
    exchange: row.exchange,
    timeframe: row.timeframe,
    ts: row.ts,
    listingId: row.listingId,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    divCash: row.divCash,
    splitFactor: row.splitFactor,
    source: row.source,
  };
}

/** What the containment guard decided about one shard group. */
export interface ShardCoverage {
  /** Rows the shard demonstrably holds. SAFE to delete. */
  deletable: EvictCandidate[];
  /** The shard is present but does NOT hold these rows. */
  notInShard: EvictCandidate[];
}

/**
 * DELETE ONLY WHAT THE COLD SHARD DEMONSTRABLY HOLDS.
 *
 * ## Why containment and not mere existence
 *
 * "The object exists" is the check the brief asks for and it is not enough. A
 * shard written before a repair, or truncated by the read-modify-write bug
 * `mergeColdBars` exists to prevent, exists and is missing bars — and a row
 * deleted from Mongo whose bar is not in the shard is GONE. We have already
 * decoded the shard in order to know it exists, so the exact check costs
 * nothing over the approximate one: compare natural keys.
 *
 * The comparison is `candleKey`, the SAME function the unique index mirrors and
 * the same one `mergeHotAndCold` merges by, so "the shard holds this row" means
 * exactly what it means everywhere else. A shard is ticker-keyed and therefore
 * carries every exchange, which is why the key includes the exchange rather
 * than the group being narrowed to one.
 *
 * ## The direction of a miss
 *
 * Every uncertainty resolves to KEEP. An absent shard, an unreadable shard, a
 * shard that answers without the row: all of them leave the row in Mongo, where
 * it is correct and merely expensive. The opposite default would trade a bounded
 * storage cost for unbounded, invisible data loss — and a shorter price series
 * is not visibly wrong, it just draws a shorter chart (`ColdShardOutcome` splits
 * `failed` from `absent` for this reason; this is the same rule on the delete
 * side).
 */
export function partitionByShardCoverage(
  rows: readonly EvictCandidate[],
  shardBars: readonly CandleBar[],
): ShardCoverage {
  const held = new Set(shardBars.map(candleKey));
  const deletable: EvictCandidate[] = [];
  const notInShard: EvictCandidate[] = [];
  for (const row of rows) {
    if (held.has(candleKey(row))) deletable.push(row);
    else notInShard.push(row);
  }
  return { deletable, notInShard };
}

/* ─────────────────────────────────────────────────────────────────────────
   WINDOW_INTRADAY — the planner's selection and the leaf's own decisions
   ──────────────────────────────────────────────────────────────────────── */

/**
 * The `ts` below which an intraday `WINDOW` row is due — snapped DOWN to an ET
 * session boundary, so a leaf only ever moves WHOLE SESSIONS.
 *
 * `intradayHotFloorTs` is `now - 45 days`, which lands at an arbitrary instant
 * inside a trading day. Evicting on that raw boundary would cut a session in
 * half: the morning's bars go cold while the afternoon's stay hot, and the two
 * halves then live in different stores under the SAME
 * `(symbol, timeframe, session)` key that {@link decideSessionWrite} governs.
 * Every authority question about that session — who owns it, may Databento
 * displace it — becomes unanswerable, because the answer differs by time of
 * day.
 *
 * So the cutoff is the START of the ET session that contains the 45-day floor,
 * and the session containing the floor stays hot IN FULL. That costs at most
 * one extra session of hot rows and buys an invariant: a session is entirely
 * hot or entirely cold.
 *
 * ET, not UTC. The US day runs 04:00-20:00 ET, so under EST the post-market
 * tail crosses midnight UTC and a UTC boundary would put the tail of one
 * session and the head of the next on opposite sides of itself — the same
 * defect `usMarketDateKey` was extracted to fix on the write side.
 */
export function intradaySessionCutoff(now: Date): Date {
  return new Date(
    usMarketDayBoundsUtc(usMarketDateKey(intradayHotFloorTs(now))).startMs,
  );
}

/** One `(symbol, timeframe)` the planner fans out as a single leaf message. */
export interface IntradayUnit {
  symbol: string;
  timeframe: string;
}

/**
 * The aggregation that turns the due intraday population into UNITS OF WORK.
 *
 * Shaped for `$runCommandRaw`, so dates are Extended JSON `{ $date: iso }` and
 * NOT bare `Date` objects: Prisma serialises this pipeline through Extended
 * JSON RELAXED mode, where a raw millisecond number reaches the driver as
 * "Failed to convert 'JSON' to 'BSON'" — an error naming neither the field nor
 * the shape, and only visible once a real database is attached
 * (`databento-repo.ts:372`).
 *
 * `$group` and not `$distinct`, because the key is a PAIR. It projects nothing
 * else: the leaf re-selects its own rows, so carrying a count here would be a
 * number that is already stale by the time the leaf reads it.
 */
export function buildIntradayPlanPipeline(
  now: Date,
): Array<Record<string, unknown>> {
  return [
    {
      $match: {
        // POSITIVE on `tier`, exactly as `buildEvictWhere` is — see the module
        // header for why a negative or null test matches ZERO rows on Mongo.
        tier: "WINDOW",
        timeframe: { $in: [...INTRADAY_TIMEFRAMES] },
        ts: { $lt: { $date: intradaySessionCutoff(now).toISOString() } },
      },
    },
    { $group: { _id: { symbol: "$symbol", timeframe: "$timeframe" } } },
  ];
}

/**
 * The leaf's own selection: every due row of ONE unit, whole sessions only.
 *
 * The SAME cutoff the planner used, from the same function. A leaf that
 * recomputed a floor of its own would drift from the plan by however long the
 * fan-out took, and on the boundary session that difference is a half-session
 * split — the exact thing {@link intradaySessionCutoff} exists to prevent.
 *
 * No `skip`, no `take`, no ordering: the unit IS the page. A `(symbol,
 * timeframe)` holds at most `INTRADAY_HOT_WINDOW_DAYS` sessions of bars, which
 * for M1 is ~65,000 rows and for H1 ~720.
 */
export function buildIntradayUnitWhere(
  unit: IntradayUnit,
  now: Date,
): { tier: "WINDOW"; symbol: string; timeframe: string; ts: { lt: Date } } {
  return {
    tier: "WINDOW",
    symbol: unit.symbol,
    timeframe: unit.timeframe,
    ts: { lt: intradaySessionCutoff(now) },
  };
}

/**
 * Publish order for the fan-out: CHEAPEST SHARD FIRST.
 *
 * Measured 2026-09-07 on node 22 with the real `encodeColdShard` /
 * `decodeColdShard`: an H1 year-shard is 133 KB and 21 ms, an M1 year-shard is
 * 7.95 MB gzipped, 1,042 ms to encode, 486 ms to decode, and ~160-250 MB of
 * resident heap while decoded. `S1` is another ~60x on top of M1 and is
 * archive-only by founder decision, so it sorts last of all rather than being
 * omitted — a timeframe that is not in this list would otherwise sort FIRST by
 * an `indexOf` of -1.
 *
 * The order is a MEMORY control, not a fairness one. Cloud Run holds up to
 * `containerConcurrency` messages per container, so a burst of the largest
 * shards is the one arrangement that can OOM-kill an instance and take every
 * other in-flight message with it. Publishing the 14,063 H1 units before the
 * 507 M1 units puts the expensive burst at the end, when the earlier ones have
 * already released their heap.
 */
export const INTRADAY_LEAF_ORDER: readonly string[] = [
  "H1",
  "M15",
  "M5",
  "M1",
  "S1",
];

/** Sort units into {@link INTRADAY_LEAF_ORDER}, symbol-tiebroken for determinism. */
export function orderIntradayLeaves(
  units: readonly IntradayUnit[],
): IntradayUnit[] {
  const rank = (tf: string): number => {
    const i = INTRADAY_LEAF_ORDER.indexOf(tf);
    // An unknown timeframe sorts LAST, never first. `indexOf` returns -1, and
    // -1 sorts ahead of H1 — which would put the one shard nobody has measured
    // at the head of the burst.
    return i < 0 ? INTRADAY_LEAF_ORDER.length : i;
  };
  return [...units].sort(
    (a, b) =>
      rank(a.timeframe) - rank(b.timeframe) ||
      a.symbol.localeCompare(b.symbol) ||
      a.timeframe.localeCompare(b.timeframe),
  );
}

/**
 * What a leaf must do with one shard group's rows, decided PER SESSION.
 *
 * Total over the rows handed in: every row lands in exactly one of `archive`,
 * `outranked` and `refused`, which is what lets the processor's tally close.
 */
export interface IntradaySessionPartition {
  /** Rows to write into the shard, verify, and then delete. */
  archive: EvictCandidate[];
  /**
   * Rows to DELETE WITHOUT ARCHIVING — the shard already holds their session
   * from a stronger source. See `EvictTally.deletedOutranked`.
   */
  outranked: EvictCandidate[];
  /**
   * Rows to KEEP and touch in no way.
   *
   * Reachable only through a `refuse` verdict carrying `d1: true`, which
   * {@link decideSessionWrite} returns for a NON-INTRADAY timeframe. The route
   * narrows a leaf's timeframe to `INTRADAY_TIMEFRAMES` and the leaf's own
   * `where` pins it, so the processor cannot produce one — but this function is
   * exported and pure, and on a DELETE path an unreachable branch must still
   * resolve to KEEP rather than fall through into `outranked`. Deleting a
   * daily row because a stronger source holds its session would destroy history
   * the shard does not carry under that natural key.
   */
  refused: EvictCandidate[];
  /** Bars the shard must hold after this leaf writes it. */
  shardBars: CandleBar[];
  /** Existing shard bars a displacement removes. Reported, not just applied. */
  dropped: CandleBar[];
  /** One line per (session, source) decision, for the log. */
  verdicts: Array<{
    dateKey: string;
    source: string;
    action: "write" | "displace" | "refuse";
    reason: string;
  }>;
}

/**
 * Decide, SESSION BY SESSION, what a leaf may archive and what it may only
 * delete — MONEY-1373.
 *
 * ## Why the shard cannot simply be merged into
 *
 * `writeColdShard`'s default merge unions by natural key and is exactly right
 * for the annual `WINDOW` rule, where one writer owns the year. Intraday has
 * TWO writers with different measurement semantics: the Tiingo realtime sink
 * builds bars from quote MIDS and writes `volume: 0` meaning "this feed does
 * not report volume", while Databento's bars are trade-derived with real
 * volume. A union puts both in one session, and the resulting OHLC changes
 * meaning partway through the day with nothing on the rows to reveal it
 * (MONEY-1309).
 *
 * So each ET session is decided on its own by {@link decideSessionWrite} — the
 * SAME function the Databento append uses, not a second statement of the rule —
 * and the three verdicts map onto the three outcomes above:
 *
 *   `write` / same source   archive; the shard is empty for that session, or
 *                           already ours
 *   `displace`              archive, AND drop the weaker bars the shard holds
 *                           for that session
 *   `refuse` (d1: false)    do NOT archive. DELETE. The shard already holds
 *                           this session from a stronger source, so these
 *                           Mongo rows are duplicate, weaker, and actively
 *                           harmful: `mergeHotAndCold` gives hot precedence,
 *                           so they are SERVED over the stronger shard bars.
 *
 * ## A session may carry TWO sources, and each gets its own verdict
 *
 * A session left mixed by an interrupted write is exactly what
 * `decideSessionWrite` documents its multi-source signature for. Grouping the
 * rows by source and asking once per source heals such a session instead of
 * refusing it forever — and it is the only shape under which the two halves can
 * receive different answers, which they must: one may outrank the shard while
 * the other does not.
 *
 * ## The session key is ET, and `candleKey` cannot see it
 *
 * `candleKey` is `(symbol, exchange, timeframe, ts)`. A shard is TICKER-keyed
 * and carries every exchange a ticker traded on, so two listings' bars for the
 * same instant have DIFFERENT keys and the same session. Containment therefore
 * answers nothing about authority, and the session bounds have to come from
 * `usMarketDayBoundsUtc` — which is also 23 or 25 hours long twice a year, so a
 * fixed 86,400,000 would misfile a whole session's worth of bars.
 */
export function partitionIntradayBySessionAuthority(
  rows: readonly EvictCandidate[],
  shardBars: readonly CandleBar[],
  timeframe: string,
): IntradaySessionPartition {
  const out: IntradaySessionPartition = {
    archive: [],
    outranked: [],
    refused: [],
    shardBars: [],
    dropped: [],
    verdicts: [],
  };

  // Rows by ET session.
  const bySession = new Map<string, EvictCandidate[]>();
  for (const row of rows) {
    const dateKey = usMarketDateKey(row.ts);
    const bucket = bySession.get(dateKey);
    if (bucket) bucket.push(row);
    else bySession.set(dateKey, [row]);
  }

  const dropKeys = new Set<string>();
  for (const [dateKey, sessionRows] of bySession) {
    const bounds = usMarketDayBoundsUtc(dateKey);
    const inSession = shardBars.filter((b) => {
      const ms = b.ts.getTime();
      return ms >= bounds.startMs && ms < bounds.endMs;
    });
    const existingSources = [...new Set(inSession.map((b) => b.source))];

    // By SOURCE within the session — see the header. `Map` preserves insertion
    // order, so the verdict lines come out in the order the rows arrived.
    const bySource = new Map<string, EvictCandidate[]>();
    for (const row of sessionRows) {
      const bucket = bySource.get(row.source);
      if (bucket) bucket.push(row);
      else bySource.set(row.source, [row]);
    }

    for (const [source, sourceRows] of bySource) {
      const verdict = decideSessionWrite({
        incomingSource: source,
        existingSources,
        timeframe,
      });
      out.verdicts.push({
        dateKey,
        source,
        action: verdict.action,
        reason: verdict.reason,
      });

      if (verdict.action === "write") {
        out.archive.push(...sourceRows);
        continue;
      }
      if (verdict.action === "displace") {
        out.archive.push(...sourceRows);
        const deleting = new Set(verdict.deleting);
        for (const bar of inSession) {
          if (deleting.has(bar.source)) dropKeys.add(candleKey(bar));
        }
        continue;
      }
      // refuse. `d1` separates "this is not an intraday series" from "a
      // stronger source owns this session"; only the second is safe to delete.
      if (verdict.d1) out.refused.push(...sourceRows);
      else out.outranked.push(...sourceRows);
    }
  }

  // The shard as it must stand afterwards: what it holds, minus what a
  // displacement removes, minus anything the archive is about to restate,
  // plus the archive. `merge: false` on the write, so this array IS the object
  // — the harvest's own union-then-write shape.
  const archiveKeys = new Set(out.archive.map((r) => candleKey(r)));
  for (const bar of shardBars) {
    const key = candleKey(bar);
    if (dropKeys.has(key)) {
      out.dropped.push(bar);
      continue;
    }
    if (archiveKeys.has(key)) continue;
    out.shardBars.push(bar);
  }
  out.shardBars.push(...out.archive.map(toColdBarFromCandidate));

  return out;
}

/* ─────────────────────────────────────────────────────────────────────────
   Ledger
   ──────────────────────────────────────────────────────────────────────── */

/** One `(listingId, year)` pair whose ledger entry may now be stale. */
export interface LedgerYear {
  listingId: string;
  year: number;
}

/**
 * The `(listingId, year)` pairs a set of deletions may have emptied.
 *
 * MAY, not HAS — the caller must still count what remains before pulling the
 * year, because a page can cut a symbol-year in half and clearing
 * `hotLoadedYears` while half the rows are still hot would make the ledger lie
 * in the direction that matters: a UI would show the year as cold and the
 * eviction would keep re-examining rows it had already written off.
 *
 * Rows with no `listingId` are dropped rather than grouped under `""`. There is
 * no `us_instruments` row to update for them and a blank key would `$pull` from
 * whichever document happened to have a blank `listingId`.
 */
export function ledgerYearsForDeletions(
  rows: readonly EvictCandidate[],
): LedgerYear[] {
  const seen = new Map<string, LedgerYear>();
  for (const row of rows) {
    if (row.listingId === "") continue;
    const year = row.ts.getUTCFullYear();
    if (!Number.isInteger(year)) continue;
    const key = `${row.listingId}\u0000${year}`;
    if (!seen.has(key)) seen.set(key, { listingId: row.listingId, year });
  }
  return [...seen.values()];
}

/** UTC `[start, end)` for one bar year. */
export function yearBounds(year: number): { gte: Date; lt: Date } {
  return {
    gte: new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0)),
    lt: new Date(Date.UTC(year + 1, 0, 1, 0, 0, 0, 0)),
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   The chain
   ──────────────────────────────────────────────────────────────────────── */

/** Everything the chain decision looks at. All observed, none inferred. */
export interface EvictChainInput {
  /** The rule this run walked. */
  rule: EvictRule;
  /** This run's `skip`. */
  skipRows: number;
  /** Rows the page returned. */
  selected: number;
  /** The `take` this run used. `selected < batchSize` means the rule ran dry. */
  batchSize: number;
  /**
   * Rows this run kept that sort BEFORE the first row it never examined.
   *
   * NOT "examined minus deleted". See {@link chainKeptBeforeUnexamined} for why
   * the whole-page figure steps the next link over rows nobody looked at: the
   * page is ordered, the ITERATION is by shard group, and a budget break
   * therefore truncates a NON-PREFIX of the page.
   */
  kept: number;
  /** This run's depth. 0 for a scheduler trigger. */
  chainDepth: number;
  /**
   * An OPERATOR named one rule, so the chain must not advance to the other.
   *
   * NOT "this message carries a `rule`". Every chained follow-up carries one —
   * it has to, or the link would not know what to walk — so deriving this from
   * the field's presence made links 1..N all "scoped" and left the WINDOW rule
   * unreachable on any night the LOADED page came back full. The intent travels
   * as its own field (`CandleEvictMessage.ruleScoped`), set by the publisher
   * that knows it.
   */
  ruleScoped: boolean;
}

/** The next link, or null to end the chain. */
export type EvictNextStep = { rule: EvictRule; skipRows: number } | null;

/**
 * The depth at which `rule` must hand the chain on, however much work it has
 * left. RESERVATION, not a limit — the depth budget is divided BEFORE the run,
 * not competed for.
 *
 * ## The starvation this exists to make impossible
 *
 * `EVICT_RULES` is walked in order and a rule only yields when its page comes
 * back SHORT. With `MAX_CHAIN_DEPTH` links, a `LOADED` backlog of
 * `MAX_CHAIN_DEPTH * batchSize` rows consumes every link, and `WINDOW` — the
 * rule that bounds `candles` at year rollover AND the only one that archives
 * before it deletes — runs ZERO times. Not once: every night, for as long as
 * the backlog lasts, while `judgeEvictRun` reports `ok` because the LOADED leg
 * deleted rows. A dark leg reading healthy one level above the row filter is
 * this repo's most expensive recurring shape (MONEY-1211, MONEY-1220,
 * MONEY-1255), and "the chain ran out of depth" is not a reason a reader ever
 * sees.
 *
 * So each rule owns a contiguous band of depths, `MAX_CHAIN_DEPTH /
 * EVICT_RULES.length` wide — 6 links each at 20/3, with the last rule taking
 * the 2-link remainder as well. A rule that drains early hands over early and
 * the next rule inherits what it did not spend, so the reservation costs
 * nothing when there is no contention. The LAST rule owns everything to the
 * ceiling, so an integer-division remainder is never stranded.
 *
 * Derived from two constants and the run's own depth: no database, no clock, no
 * queue — the same discipline {@link MAX_CHAIN_DEPTH} is held to, because a
 * fairness rule that could itself extend a chain would break the termination
 * proof rather than sit inside it.
 */
export function ruleDepthBandEnd(rule: EvictRule): number {
  return depthBandEnd(
    EVICT_RULES.indexOf(rule),
    EVICT_RULES.length,
    MAX_CHAIN_DEPTH,
  );
}

/**
 * {@link ruleDepthBandEnd}'s arithmetic, with the two constants as ARGUMENTS.
 *
 * Split out so the property is falsifiable INDEPENDENTLY of whatever the live
 * constants happen to be. That mattered before there was a third rule: at
 * `20 / 2` every candidate band rule agreed — `(idx + 1) * share` and "the last
 * rule owns the ceiling" both gave WINDOW 20 — so a test written against the
 * live constants could not tell a correct implementation from one that strands
 * the remainder. `(2, 3, 20)` could, and MONEY-1373 then made that the LIVE
 * shape: without the `index >= ruleCount - 1` clause an even split gives
 * 6/12/18 and depths 18-19 belong to nobody, which is two links of the busiest
 * rule's band lost. Keep the argument form; the next rule count is the same
 * trap one size up.
 *
 * An out-of-range index yields the ceiling: an unknown rule hands over to
 * nobody rather than yielding immediately.
 */
export function depthBandEnd(
  index: number,
  ruleCount: number,
  maxDepth: number,
): number {
  if (index < 0 || index >= ruleCount - 1) return maxDepth;
  const share = Math.max(1, Math.floor(maxDepth / ruleCount));
  return Math.min((index + 1) * share, maxDepth);
}

/**
 * The `kept` figure the chain's `skip` accumulator may safely add.
 *
 * ## Why it is not `examined - deleted`
 *
 * The page is ordered (`ts asc, id asc` / `hotLoadedAt asc, id asc`) but the
 * run ITERATES BY SHARD GROUP, and a group's rows are scattered through the
 * page rather than contiguous in it. A budget break therefore stops on a
 * NON-PREFIX: rows of the groups already processed can sort AFTER rows of the
 * groups that were skipped.
 *
 * `skipRows + (examined - deleted)` then lands past rows the run never looked
 * at. Concretely, a page `[r0(A), r1(B), r2(A)]` that examines group A, keeps
 * both its rows and never reaches B advances the skip by 2 — and `r1`, which
 * nobody examined, is now BEHIND the cursor for the rest of the chain. Bounded
 * and self-healing (tomorrow's chain starts at skip 0), but it is exactly the
 * completeness claim `CandleEvictMessage.skipRows` makes, so it has to be true
 * rather than nearly true.
 *
 * The correct figure counts only the kept rows that sort before the FIRST
 * unexamined row: everything at or past that point is re-selected by the next
 * link. That is never larger than the old figure, so the chain can only
 * re-examine work — which is idempotent — and can never step over it.
 *
 * `deletedIds` carries rows whose `deleteMany` chunk did not throw, including
 * any a concurrent writer had already removed: for POSITIONING, "still in the
 * population" is the only question, and a row someone else deleted is not.
 */
export function chainKeptBeforeUnexamined(
  pageRows: readonly EvictCandidate[],
  unexaminedIds: ReadonlySet<string>,
  deletedIds: ReadonlySet<string>,
): number {
  let firstUnexamined = pageRows.length;
  for (let i = 0; i < pageRows.length; i++) {
    if (unexaminedIds.has(pageRows[i]!.id)) {
      firstUnexamined = i;
      break;
    }
  }
  let kept = 0;
  for (let i = 0; i < firstUnexamined; i++) {
    if (!deletedIds.has(pageRows[i]!.id)) kept++;
  }
  return kept;
}

/**
 * Should this run publish a follow-up, and for what?
 *
 * ## Why `skip` and not a cursor
 *
 * The population SHRINKS as the job works it: a deleted row leaves the set, a
 * KEPT one does not. So after a page of `batchSize` rows of which `kept`
 * survived, the next unseen row sits at exactly `skipRows + kept` — no cursor
 * value to carry, no dependence on `_id` comparison semantics, and no way to
 * step over a row that is still there.
 *
 * That accumulator is also what makes a permanently-unverifiable block harmless.
 * With a bare "select the head again" the first `batchSize` rows whose shard is
 * missing would be re-selected every single run, delete nothing, and starve
 * everything behind them forever — MONEY-1211's shape (681 of 781 symbols
 * selected once and skipped nightly thereafter), and MONEY-1255's (a queue whose
 * oldest rows were pushed further down every cycle). Advancing past what we kept
 * means the drain reaches the end of the population within one chain regardless.
 *
 * The skip RESETS between chains, so tomorrow's run re-examines the kept rows —
 * which is what a transient GCS failure needs and what a genuinely missing shard
 * deserves to keep reporting.
 *
 * ## Four independent reasons to stop, ANY of which ends the chain
 *
 *  1. **Depth.** The next link would reach `MAX_CHAIN_DEPTH`. This one alone
 *     bounds the chain; the rest can only stop it sooner.
 *  2. **Rule drained.** A short page means there is no next page for this rule,
 *     so the chain moves to the next rule with a fresh skip — or ends.
 *  3. **Scoped.** A message that named one rule does exactly that rule.
 *  4. **Degenerate batch.** `batchSize <= 0` cannot page.
 *
 * ## And ONE reason to hand over without stopping
 *
 * A rule that still has a full page of work yields anyway once it has spent its
 * {@link ruleDepthBandEnd} band. Without that, the FIRST rule with a backlog
 * takes every link and the rules behind it never run at all — silently, and
 * with a healthy verdict, because the busy rule did delete rows. A scoped run
 * never hands over: the operator asked for one rule.
 */
export function nextEvictStep(input: EvictChainInput): EvictNextStep {
  const { rule, skipRows, selected, batchSize, kept, chainDepth, ruleScoped } =
    input;

  if (chainDepth + 1 >= MAX_CHAIN_DEPTH) return null;
  if (batchSize <= 0) return null;

  const idx = EVICT_RULES.indexOf(rule);
  const next = idx < 0 ? undefined : EVICT_RULES[idx + 1];

  // A FULL page means there is more of this rule to walk — but not at the price
  // of every rule behind it.
  if (selected >= batchSize) {
    const bandSpent = chainDepth + 1 >= ruleDepthBandEnd(rule);
    if (!ruleScoped && bandSpent && next !== undefined) {
      return { rule: next, skipRows: 0 };
    }
    return { rule, skipRows: skipRows + kept };
  }

  // Short page: this rule is drained. Move to the next one, unless the caller
  // scoped the run.
  if (ruleScoped) return null;
  return next === undefined ? null : { rule: next, skipRows: 0 };
}

/* ─────────────────────────────────────────────────────────────────────────
   Health
   ──────────────────────────────────────────────────────────────────────── */

/** The per-run tally the verdict reads. */
export interface EvictTally {
  selected: number;
  examined: number;
  deleted: number;
  keptNoShard: number;
  keptShardUnreadable: number;
  keptNotInShard: number;
  keptNotArmed: number;
  keptNonUs: number;
  budgetSkipped: number;
  shardWriteFailures: number;
  shardReadFailures: number;
  /** Rows in a `deleteMany` chunk that THREW. They are still in Mongo. */
  deleteFailures: number;
  /**
   * Rows a `deleteMany` chunk did not report removing, without throwing.
   *
   * We verified them, asked for them, and the driver's count came back short:
   * somebody else got there first — a redelivered copy of this job, or a
   * concurrent chain link on the same page. They ARE gone, so they are not
   * `deleted` by us and not kept either, and before this bucket existed the
   * difference landed nowhere and printed as a tally that does not balance.
   */
  deleteVanished: number;
  /**
   * Rows deleted WITHOUT being archived, because the shard already holds that
   * session from a STRONGER source — MONEY-1373.
   *
   * Its own bucket rather than a share of `deleted`, because the two are
   * different events and only one of them is routine. These rows are the
   * RESIDUE OF A FAILED `deleteSessionRows`: the Databento append displaced a
   * `TIINGO_RT` session, wrote its own bars, and the delete half did not land
   * (`databento-session-writer.ts` catches exactly that). While they sit in
   * Mongo, `mergeHotAndCold` gives hot rows precedence — so the weaker
   * quote-derived bars are served OVER the trade-derived shard, silently, for
   * as long as they remain. Deleting them closes a live hole; a number that
   * climbs every night says the append's delete leg is broken.
   */
  deletedOutranked: number;
}

/**
 * Is the run's own arithmetic closed?
 *
 * Every examined row must land in exactly one bucket. A tally that does not
 * close means a row was counted twice or not at all, and a counter nobody can
 * trust is worse than no counter — it is the shape in which "we deleted 0"
 * reads as healthy. Exported so the processor can assert it and a test can
 * break it.
 *
 * The two DELETE-side buckets are part of the sum and were once missing from
 * it, which made this predicate fire on the two occasions it had nothing to say
 * about: a `deleteMany` that threw printed "TALLY DOES NOT BALANCE ... the
 * counters cannot be relied on" on top of the real error, and a row a
 * concurrent writer removed first printed the same line with no error at all.
 * A balance check that cries on correct runs is a balance check nobody reads.
 */
export function evictTallyBalances(t: EvictTally): boolean {
  const accounted =
    t.deleted +
    t.deletedOutranked +
    t.deleteFailures +
    t.deleteVanished +
    t.keptNoShard +
    t.keptShardUnreadable +
    t.keptNotInShard +
    t.keptNotArmed +
    t.keptNonUs;
  return (
    accounted === t.examined && t.examined + t.budgetSkipped === t.selected
  );
}

/** The run's verdict. `reason` is required reading whenever `ok` is false. */
export interface EvictVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Judge the run.
 *
 * A zero-delete run is NOT automatically unhealthy — an empty population is the
 * normal steady state for the WINDOW rule 364 days a year, and for the LOADED
 * rule until somebody actually reads cold history. What IS unhealthy is finding
 * work and producing nothing for a reason that is not a deliberate skip, which
 * is precisely `reportJobOutcome`'s `selected > 0 && written === 0`.
 *
 * So the reasons are ORDERED by which one a reader needs first: a disabled or
 * unarmed job explains everything downstream of it, and reporting "0 deleted"
 * without that context is the silence the job-outcome metric exists to replace.
 */
export function judgeEvictRun(args: {
  tally: EvictTally;
  disabled: boolean;
  armed: boolean;
  coldStoreRegistered: boolean;
}): EvictVerdict {
  const { tally, disabled, armed, coldStoreRegistered } = args;

  if (disabled) {
    return {
      ok: true,
      reason: "disabled (CANDLE_EVICT=off) — nothing selected",
    };
  }
  if (!coldStoreRegistered) {
    // NOT ok. Without a cold store every shard read answers `absent`, so the
    // guard refuses every row and the job can never delete anything — a job
    // that cannot do its work must not report a clean run.
    return {
      ok: false,
      reason:
        "no cold store registered — every row is unverifiable, so nothing can be evicted. " +
        "Call initCandleColdStore() at process start (needs GCP_STORAGE_BUCKET).",
    };
  }
  if (!armed) {
    return {
      ok: true,
      reason:
        `not-armed (CANDLE_EVICT_APPLY !== 'true'); DRY RUN — ` +
        `${tally.keptNotArmed} row(s) would have been deleted`,
    };
  }
  if (tally.deleteFailures > 0) {
    return {
      ok: false,
      reason: `${tally.deleteFailures} row(s) failed to delete`,
    };
  }
  if (tally.shardWriteFailures > 0) {
    return {
      ok: false,
      reason: `${tally.shardWriteFailures} shard(s) could not be archived; their rows were kept`,
    };
  }
  if (tally.keptNoShard > 0 || tally.keptNotInShard > 0) {
    // Not a failed RUN — the rows are safe, which is the point — but it is the
    // one outcome that means the two stores disagree about what we hold, and
    // that never fixes itself.
    return {
      ok: false,
      reason:
        `${tally.keptNoShard} row(s) have no cold shard and ${tally.keptNotInShard} ` +
        `are missing from the shard that exists; all were KEPT. The hot and cold ` +
        `stores disagree — re-archive before this can drain.`,
    };
  }
  if (tally.shardReadFailures > 0) {
    return {
      ok: true,
      reason: `${tally.shardReadFailures} shard read(s) failed; their rows were kept for the next run`,
    };
  }
  if (tally.selected === 0) {
    return { ok: true, reason: "nothing due for eviction" };
  }
  return { ok: true };
}
