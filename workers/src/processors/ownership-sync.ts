/**
 * Ownership Sync Processor — MONEY-1098 (P5.4), rebuilt MONEY-1207,
 * legs 5 + 6 added MONEY-1205.
 *
 * Ingestion for the whole active NSE **and BSE** equity universe. Six feeds —
 * four from NSE's corporate-filings APIs, one from NSE's XBRL archive, one from
 * BSE:
 *
 *   1. `corporate-share-holdings-master` (per symbol) → `ShareholdingPattern`,
 *      upserted on `(symbol, exchange, quarter)` with `exchange` pinned to
 *      "NSE" — see {@link SHAREHOLDING_EXCHANGE}.
 *   2. `corporates-pit`                  (per symbol) → `InsiderEvent` PIT rows.
 *   3. `corporate-sast-reg29`            (per symbol) → `InsiderEvent` SAST rows.
 *   4. `corporate-pledgedata`            (BULK, one call) → `InsiderEvent`
 *      PLEDGE rows for the whole market.
 *   5. `nsearchives.nseindia.com/corporate/xbrl/SHP_*.xml` (per FILING) →
 *      `ShareholdingBreakdown`, the FII/DII split. Leg `shpXbrl`.
 *   6. `api.bseindia.com` SHP endpoints (per SCRIP) → `ShareholdingPattern` +
 *      `ShareholdingBreakdown`, both stamped `exchange: "BSE"`. Leg `bse`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MONEY-1205 ADDED, AND WHY.
 *
 *   LEG 5 — feed 1's endpoint carries NO FII/DII AT ALL. Both columns were null
 *   on 100% of prod's 7,953 stored rows, which downstream reads as "this
 *   company has no institutional holders" rather than "we never fetched it".
 *   The split is in the filing, and feed 1's OWN payload already links it
 *   (`xbrl`, beside `xbrlFileSize`) — so leg 5 needs no discovery endpoint at
 *   all: it walks the summary rows we already store. Every write is gated on
 *   `reconcileWithSummary`, because that link is the thing that can be wrong.
 *
 *   LEG 6 — 8,139 BSE-only symbols had ZERO shareholding rows, by construction
 *   rather than by accident: feeds 1-4 are keyed on the NSE trading symbol, so
 *   a company NSE does not list can never be reached through them however many
 *   times the queue comes round. 7,802 of them are reachable at BSE.
 *
 *   Both legs adopt the MONEY-1207 machinery rather than inventing a parallel
 *   one: their own entry in `WALKING_LEGS`, their own cursor in the sync log,
 *   their own share of `perLegBudgetMs`, and their outcome in
 *   `decideRunStatus`. What they added to it is that a "queue" is now PER LEG —
 *   see `legWalk[].queueLength` and `perLegPassDays`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT MONEY-1207 CHANGED, AND WHY. The job was not broken; it was STARVED, and
 * every counter it wrote said "COMPLETED". Measured over its first eight prod
 * runs (2026-08-11 .. 2026-08-17):
 *
 *   - `weekShard` + `rotateSlice(600)` advanced the window 600 symbols a week
 *     while the 420s budget only ever consumed 310-410 (`skippedForBudget`
 *     190-290 on EVERY run). Simulated against the real 10,437-name universe, a
 *     full NSE pass took **7 WEEKS** — and covered no BSE listing at all —
 *     against a 7-DAY target. Worse, those 7 weeks are an accident of
 *     `gcd(600, shardSize)`; shard 6 is exactly 1,500 symbols today and has only
 *     FIVE distinct window starts, so it closes purely because consumption
 *     (310-410) happens to exceed its 300-symbol step. HDFCBANK hashes to
 *     shard 1 and was not reached in either of the two weeks prod has run.
 *     NIFTY50 coverage after 8 runs: 13/50.
 *   - the completion `update` REPLACED `metadata`, dropping the `shardFull` /
 *     `skippedByCap` / `cycleWeeks` telemetry the `create` had written. The one
 *     instrument that could have shown the starvation erased itself on every
 *     successful run.
 *   - a run in which all three per-symbol legs parsed ZERO rows out of ~390
 *     non-empty payloads (2026-08-16) was still recorded `COMPLETED`.
 *
 * The replacements, in order:
 *
 *   PRIORITY QUEUE — `buildOwnershipQueue` orders the universe Nifty 50 ->
 *   Nifty 100 family -> Nifty 500 family -> rest of NSE -> BSE-only, so the
 *   names that matter are reached on the first run, not on the run their hash
 *   bucket happens to come up.
 *
 *   CURSOR, NOT STRIDE — the queue position is persisted in the sync log, ONE
 *   PER LEG, and advances by what the run actually CONSUMED. A short run resumes
 *   exactly where it stopped, so full coverage takes ceil(queue / consumed) runs
 *   with no blind spot at any budget. A fixed stride cannot make that promise
 *   unless it is always achieved, and this one never was.
 *
 *   PER-LEG BUDGET — each per-symbol leg walks its own slice under its own share
 *   of the wall clock, so one slow feed cannot spend the whole run. Combined
 *   with `legs` (already message-tunable) this is what lets ops split the feeds
 *   across separate schedulers and multiply daily throughput without a deploy.
 *
 *   HONEST STATUS — see {@link decideRunStatus}. A leg that fetched real payloads
 *   and parsed nothing is a PARSER FAILURE, and the run says so.
 *
 * PROD-ONLY (scrape-once): it hits nseindia.com per symbol, which is precisely
 * the class of job `PROD_ONLY_JOBS` exists for. QA gets the tables via
 * `sync-prod-to-qa.sh`.
 *
 * IDEMPOTENT by construction. Shareholding keys on `(symbol, exchange, quarter)`;
 * insider events key on a sha256 of `insiderEventKey(row)` — the all-business-fields
 * identity, because insider filings ship NO stable id and NSE serves a rolling
 * window, so every run re-reads the same disclosures. Re-running a slice, or
 * Pub/Sub redelivering one, rewrites the same rows.
 *
 * I/O seam — untested at this layer per repo posture. EVERY decision this file
 * makes that is not I/O — the parsers, the queue, the cursor, the run verdict
 * and the metadata merge — lives in
 * `@usemoney/research/data-sources/ownership-logic` and is unit-tested in
 * `workers/__tests__/ownership-logic.test.ts`. They live there rather than here
 * because this module imports Prisma at module scope, and a unit test that
 * reached in for them would construct a PrismaClient it has no use for.
 */

import { createHash } from "node:crypto";
import prisma, { type Prisma } from "@usemoney/database";
import {
  // Leg 5 — the SHP XBRL filing. `inspectShareholdingXbrl` rather than
  // `parseShareholdingXbrl`: the two do the same work and the second throws the
  // refusal REASON away. A run that downloads 1,500 filings and writes 0 rows
  // has to be able to say whether that was 1,500 unknown taxonomies or 1,500
  // successful reads of empty documents, and only the outcome union can.
  inspectShareholdingXbrl,
  reconcileWithSummary,
  SHAREHOLDING_RECONCILE_TOLERANCE_PCT,
  SHP_MEMBERS,
  // Leg 6 — BSE. `parseBseShareholding` takes `normalizeQuarter` INJECTED
  // because it lives in @usemoney/core while that function lives in
  // @usemoney/research, which depends on core. The real function is passed
  // below; re-implementing it would key BSE rows differently from NSE rows and
  // the two would never join.
  fetchBseShareholding,
  fetchBseShpQuarters,
  parseBseShareholding,
  bseShpSummaryUrl,
  fetchBseScripMaster,
  getFeedAsset,
  type ShareholdingBreakdownParse,
  type ShareholdingReconcileVerdict,
} from "@usemoney/core/market-data";
import {
  fetchShareholdingMaster,
  fetchInsiderTradingPit,
  fetchSastReg29,
  fetchPledgeData,
  runPacedPerSymbol,
  NSE_PER_SYMBOL_DELAY_MS,
  NSE_PER_SYMBOL_CONCURRENCY,
} from "@usemoney/research/data-sources/nse-filings";
import {
  parseShareholdingMaster,
  parseInsiderPit,
  parseSastReg29,
  parsePledgeData,
  normalizeCompanyName,
  insiderEventKey,
  buildOwnershipQueue,
  resolveCursorIndex,
  sliceQueue,
  advanceCursor,
  projectedPassDays,
  decideRunStatus,
  mergeSyncMetadata,
  readStoredCursors,
  FULL_PASS_ALERT_DAYS,
  INDEX_TIER_BY_ID,
  OWNERSHIP_TIER_LABEL,
  normalizeQuarter,
  // MONEY-1205 — leg 5 (SHP XBRL) and leg 6 (BSE). Every decision either leg
  // makes that is not I/O lives here, for the same reason the rest already
  // does: this module imports Prisma at module scope.
  SHP_XBRL_FEED_SLUG,
  SHP_XBRL_REFERER,
  shpXbrlArchiveDay,
  pendingShpFilings,
  decideBreakdownWrite,
  buildBseScripIndex,
  buildBseShpQueue,
  pendingBseQuarters,
  type OwnershipCursor,
  type OwnershipQueue,
  type ShareholdingRow,
  type InsiderEventRow,
  type ParseOutcome,
  type BseShpQueue,
  type RunStatus,
} from "@usemoney/research/data-sources/ownership-logic";

const logger = {
  info: (...args: unknown[]) => console.log("[ownership-sync]", ...args),
  warn: (...args: unknown[]) => console.warn("[ownership-sync]", ...args),
  error: (...args: unknown[]) => console.error("[ownership-sync]", ...args),
};

const SYNC_TYPE = "OWNERSHIP_SYNC";

export type OwnershipLeg =
  | "shareholding"
  | "pit"
  | "sast"
  | "pledge"
  | "shpXbrl"
  | "bse";

const ALL_LEGS: OwnershipLeg[] = [
  "shareholding",
  "pit",
  "sast",
  "pledge",
  "shpXbrl",
  "bse",
];
/**
 * The three legs that walk the NSE UNIVERSE queue. `pledge` is one bulk call,
 * not a walk; `shpXbrl` and `bse` walk queues of their own (see
 * {@link WALKING_LEGS}).
 */
const PER_SYMBOL_LEGS = ["shareholding", "pit", "sast"] as const;
/**
 * Every leg that walks A queue, in the order a combined run executes them.
 *
 * The distinction from {@link PER_SYMBOL_LEGS} is the whole of MONEY-1205's
 * structural change: a "queue" stopped being one list. `shpXbrl` walks the
 * symbols that have an UNFETCHED filing — 440 today, shrinking to near zero in
 * the steady state and refilling each quarter — and `bse` walks the BSE-listed
 * universe keyed by scrip code. Each carries its own cursor under its own name
 * in the sync log, so all five advance independently and a leg-per-job schedule
 * needs no new machinery.
 */
const WALKING_LEGS = [
  "shareholding",
  "pit",
  "sast",
  "shpXbrl",
  "bse",
] as const satisfies readonly OwnershipLeg[];

export interface OwnershipSyncMessage {
  /**
   * Explicit symbols — bypasses the queue AND the cursor entirely.
   *
   * This is the targeted-backfill door and it deliberately does NOT advance any
   * cursor: a one-off re-sync of 20 names must not push the scheduled pass 20
   * symbols forward, which would blind exactly those 20 on the next run.
   */
  symbols?: string[];
  /**
   * Safety bound on the slice size (default {@link DEFAULT_MAX_SYMBOLS}).
   *
   * NOT the pacing knob any more. The WALL CLOCK is what limits a run; this only
   * stops the slice array growing without bound. Setting it BELOW what the
   * budget can consume is wasteful — the run ends early and the pass takes
   * longer — but it cannot blind anything, because the cursor advances by what
   * was CONSUMED, never by this number. That asymmetry is the whole point of the
   * MONEY-1207 rework: under the old `rotateSlice` stride the equivalent
   * mis-setting silently skipped symbols.
   */
  maxSymbols?: number;
  /** Wall-clock budget in ms for the WHOLE run (default {@link RUN_BUDGET_MS}). */
  budgetMs?: number;
  /** Quiet time between per-symbol calls within a lane. */
  delayMs?: number;
  /** Concurrent lanes over the slice. */
  concurrency?: number;
  /**
   * Subset of feeds to run. Omitted / empty = all six.
   *
   * Each per-symbol leg carries its OWN cursor, so splitting the feeds across
   * separate schedulers is safe and is the intended way to raise throughput:
   * a run given one leg spends the whole budget on it and its cursor advances
   * ~3x further, while the other legs' cursors sit untouched until their own
   * job runs.
   */
  legs?: OwnershipLeg[];
  /**
   * How many times a day THIS message is scheduled. Used only to project how
   * long a full pass takes; see {@link FULL_PASS_ALERT_DAYS}.
   *
   * It has to be told to us — the processor cannot see its own cron. Under-
   * stating it (or leaving it at the default 1) makes the projection
   * PESSIMISTIC, so the alert fires early rather than late, which is the right
   * direction for a coverage alarm.
   */
  runsPerDay?: number;
}

/**
 * 420s, matching report-archive-sync. Leaves ~180s of the 600s ack deadline for
 * the sync-log write and for requests already in flight when the budget trips.
 */
const RUN_BUDGET_MS = 420_000;
/**
 * Slice bound. Deliberately far above what a 420s budget consumes (measured:
 * 310-410 symbols with three legs interleaved, ~760 with one), so the wall clock
 * is the limiter and the cursor advances by real throughput.
 */
const DEFAULT_MAX_SYMBOLS = 2_000;
/** Concurrent insider upserts per chunk (the bulk pledge feed is market-wide). */
const WRITE_CHUNK = 25;
/**
 * How many recent sync logs to scan for a leg's cursor.
 *
 * A leg only writes its cursor on the runs it actually ran, so with the feeds
 * split across schedulers a given leg's last cursor can be several runs back.
 * Overshooting this is harmless — a missing cursor restarts the pass at Nifty 50
 * rather than blinding anything.
 */
const CURSOR_LOOKBACK_RUNS = 25;
/**
 * XBRL filings fetched per symbol per run (leg 5).
 *
 * A bound, not a target. Prod holds 18.1 stored quarters per symbol on average
 * and 47 for the deepest, so an unbounded per-symbol backfill would let ONE
 * name spend a whole leg's wall clock while the queue behind it never moves.
 * Four means the newest year lands on the first visit and the rest fills in
 * over subsequent passes; because the queue shrinks as symbols complete, later
 * passes reach further with the same budget.
 */
const SHP_XBRL_MAX_PER_SYMBOL = 4;
/**
 * BSE quarters fetched per scrip per run (leg 6), and it is 2 rather than 4 for
 * a reason the NSE leg does not have: each quarter costs TWO requests (summary
 * + public detail) on top of the one-per-scrip quarter index, so 2 quarters is
 * already 5 requests where leg 5's 4 filings are 4.
 */
const BSE_MAX_QUARTERS_PER_SYMBOL = 2;
/** Per-request timeout for a filing. Filings run ~150 KB; 20s is generous. */
const SHP_XBRL_TIMEOUT_MS = 20_000;

// ── Prisma delegates ─────────────────────────────────────────────────────────
//
// The models exist now, so these are the REAL generated delegates and the write
// payloads below are type-checked against schema.prisma — which is the only
// thing that would have caught `employeeTrustsPct` being misspelled at the call
// site rather than at 2am in prod.
//
// The string-keyed probe survives on purpose. It is what let a worker deployed
// ahead of a migration log `modelsMissing` instead of throwing "Cannot read
// properties of undefined", and it is the form
// packages/core/__tests__/market-data/prod-only-sync-coverage.test.ts scans for
// to prove this PROD_ONLY processor writes the two collections QA syncs down.

type ShareholdingDelegate = typeof prisma.shareholdingPattern;
type InsiderDelegate = typeof prisma.insiderEvent;
type BreakdownDelegate = typeof prisma.shareholdingBreakdown;

interface OwnershipDelegates {
  shareholding: ShareholdingDelegate | null;
  insider: InsiderDelegate | null;
  breakdown: BreakdownDelegate | null;
}

function ownershipDelegates(): OwnershipDelegates {
  const client = prisma as unknown as Record<string, unknown>;
  const probe = (name: string): unknown => {
    const delegate = client[name];
    if (
      typeof delegate === "object" &&
      delegate !== null &&
      typeof (delegate as { upsert?: unknown }).upsert === "function"
    ) {
      return delegate;
    }
    return null;
  };
  return {
    shareholding: probe("shareholdingPattern") as ShareholdingDelegate | null,
    insider: probe("insiderEvent") as InsiderDelegate | null,
    breakdown: probe("shareholdingBreakdown") as BreakdownDelegate | null,
  };
}

// ── Counters ─────────────────────────────────────────────────────────────────

/**
 * Aggregated parse counters across every symbol in the run.
 *
 * These ARE the falsification instrument for the four response shapes:
 * `keyHits` says which alias actually matched (per field), `reasons` says why
 * rows were refused, and `unmapped` — MONEY-1207 — says when a key we have
 * VERIFIED is present produced nothing anyway. That last one is the counter
 * whose absence let `public_val` stay unmapped across 7,953 rows: `keyHits` can
 * only ever report what DID match, so a lost alias is silent by construction.
 */
interface Tally {
  fetched: number;
  emptyResponses: number;
  rows: number;
  skipped: number;
  written: number;
  writeFailed: number;
  reasons: Record<string, number>;
  keyHits: Record<string, number>;
  unmapped: Record<string, number>;
  /**
   * DISCOVERY requests — a call that finds out WHETHER there is anything to
   * fetch, as opposed to one that should produce rows. Only leg 6 has one (BSE's
   * per-scrip quarter index).
   *
   * Kept out of `fetched` deliberately. `decideRunStatus` judges a leg barren
   * on `fetched - emptyResponses >= 20 && rows === 0`, and in the steady state
   * a BSE run is ~700 index calls finding nothing new — a legitimately quiet
   * fortnight between filing seasons. Counting those as data fetches would
   * report PARTIAL every day the market has nothing to say.
   */
  discoveryFetched: number;
  discoveryEmpty: number;
}

function newTally(): Tally {
  return {
    fetched: 0,
    emptyResponses: 0,
    rows: 0,
    skipped: 0,
    written: 0,
    writeFailed: 0,
    reasons: {},
    keyHits: {},
    unmapped: {},
    discoveryFetched: 0,
    discoveryEmpty: 0,
  };
}

function mergeCounts(
  into: Record<string, number>,
  from: Record<string, number>,
): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function absorb<T>(tally: Tally, outcome: ParseOutcome<T>): T[] {
  tally.rows += outcome.rows.length;
  tally.skipped += outcome.skipped;
  mergeCounts(tally.reasons, outcome.reasons);
  mergeCounts(tally.keyHits, outcome.keyHits);
  mergeCounts(tally.unmapped, outcome.unmapped);
  return outcome.rows;
}

// ── Writers ──────────────────────────────────────────────────────────────────

/** sha256 of the all-fields identity → the fixed-width `dedupeKey` column. */
function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * EVERY row this processor writes is stamped `exchange: "NSE"`, and that is a
 * PROVENANCE claim, not a lookup of where we found the symbol.
 *
 * All four endpoints are `www.nseindia.com/api/*` keyed on the NSE trading
 * symbol, so whatever comes back is NSE's statement about an NSE listing —
 * including for a symbol we only knew from BSE's master, which simply means NSE
 * lists it too. Stamping such a row `"BSE"` would file NSE's data under BSE's
 * name, and with `exchange` now IN the unique key it would also collide with the
 * BSE provider's own row for the same company.
 *
 * That split is what makes the two writers safe side by side: this one can only
 * ever produce `(symbol, "NSE", quarter)` and the BSE provider can only ever
 * produce `(symbol, "BSE", quarter)`, so for the 2,465 dual-listed symbols they
 * write two rows instead of overwriting one. Before `exchange` joined the key
 * (MONEY-1207) the first BSE write would have erased the NSE row silently, since
 * both legitimately name the same company.
 */
const SHAREHOLDING_EXCHANGE = "NSE";

/**
 * The BSE side of that same claim — MONEY-1205.
 *
 * A row written from `api.bseindia.com` is BSE's statement about a BSE listing,
 * keyed on BSE's scrip code. Stamping it `"NSE"` would file BSE's data under
 * NSE's name AND, with `exchange` in the unique key, upsert straight over the
 * NSE row for all 2,465 dual-listed symbols — not a duplicate, an ERASURE, and
 * a silent one, since both rows legitimately name the same company.
 *
 * That the two constants are DIFFERENT is what makes the two writers
 * structurally incapable of colliding: this file's NSE paths can only ever
 * produce `(symbol, "NSE", quarter)` and its BSE paths only
 * `(symbol, "BSE", quarter)`.
 */
const BSE_SHAREHOLDING_EXCHANGE = "BSE";

async function writeShareholding(
  delegates: OwnershipDelegates,
  rows: ShareholdingRow[],
  tally: Tally,
  // REQUIRED, not defaulted. `exchange` is half of a unique key and `source` is
  // the provenance that explains it; a default that supplies either is one
  // refactor away from supplying the wrong one to a new caller, which is
  // exactly what the BSE leg is.
  exchange: string,
  source: string,
): Promise<void> {
  const model = delegates.shareholding;
  if (!model || rows.length === 0) return;

  for (const row of rows) {
    // `exchange` is a KEY COMPONENT, so it is spelled out on the create rather
    // than left to the column default — a default that silently supplies half a
    // unique key is one refactor away from supplying the wrong half.
    const payload = {
      promoterPct: row.promoterPct,
      pledgedPct: row.pledgedPct,
      fiiPct: row.fiiPct,
      diiPct: row.diiPct,
      publicPct: row.publicPct,
      employeeTrustsPct: row.employeeTrustsPct,
      underlyingDrsPct: row.underlyingDrsPct,
      raw: row.raw,
      source,
    };
    try {
      await model.upsert({
        where: {
          symbol_exchange_quarter: {
            symbol: row.symbol,
            exchange,
            quarter: row.quarter,
          },
        },
        create: {
          symbol: row.symbol,
          exchange,
          quarter: row.quarter,
          ...payload,
        },
        // `exchange` is deliberately NOT here: it is part of the identity the
        // `where` already matched on, so an update that touched it could only
        // ever move a row out from under its own key.
        update: payload,
      });
      tally.written++;
    } catch (err) {
      tally.writeFailed++;
      logger.warn(
        `shareholding upsert failed ${row.symbol}/${row.quarter}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }
}

/**
 * Bounded-parallel because the PLEDGE leg is market-wide: one bulk response can
 * carry thousands of rows, and walking them strictly sequentially inside the
 * budget would spend it on round-trips. Bounded, not unbounded — an unlimited
 * `Promise.all` over a whole bulk payload opens as many Mongo operations as
 * there are rows.
 *
 * Each row catches its own error, so one bad upsert costs one row, not a chunk.
 */
async function writeInsiderEvents(
  delegates: OwnershipDelegates,
  rows: InsiderEventRow[],
  source: string,
  tally: Tally,
): Promise<void> {
  const model = delegates.insider;
  if (!model || rows.length === 0) return;

  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    await Promise.all(
      chunk.map(async (row) => {
        // Hash ONCE: `where` and `create.dedupeKey` must be the same string, and
        // computing it twice is one refactor away from them diverging.
        const dedupeKey = hashKey(insiderEventKey(row));
        try {
          await model.upsert({
            where: { dedupeKey },
            create: {
              dedupeKey,
              symbol: row.symbol,
              date: row.date,
              person: row.person,
              category: row.category,
              action: row.action,
              // BigInt like InstitutionalDeal.qty: a share count in a high-float
              // penny name overflows Int32, and a silent truncation there is
              // indistinguishable from a real number.
              qty: row.qty === null ? null : BigInt(row.qty),
              value: row.value,
              raw: row.raw,
              source,
            },
            // Only the payload refreshes. Every identity field is already in the
            // key, so an update that touched them would be a no-op at best and a
            // key/row disagreement at worst.
            update: { raw: row.raw, source },
          });
          tally.written++;
        } catch (err) {
          tally.writeFailed++;
          logger.warn(
            `insider upsert failed ${row.symbol}/${row.category}: ${
              err instanceof Error ? err.message : err
            }`,
          );
        }
      }),
    );
  }
}

// ── Breakdown writer (legs 5 + 6) ────────────────────────────────────────────

/** Every column of `ShareholdingBreakdown` except the three identity fields. */
interface BreakdownPayload {
  promoterPct: number | null;
  promoterPledgedPct: number | null;
  fiiPct: number | null;
  diiPct: number | null;
  mutualFundPct: number | null;
  insurancePct: number | null;
  banksFiPct: number | null;
  alternateInvPct: number | null;
  govtPct: number | null;
  publicPct: number | null;
  retailPct: number | null;
  employeeTrustPct: number | null;
  custodianDrPct: number | null;
  nonPromoterNonPublicPct: number | null;
  promoterShares: bigint | null;
  fiiShares: bigint | null;
  diiShares: bigint | null;
  publicShares: bigint | null;
  totalShares: bigint | null;
  sourceUrl: string | null;
  raw: string;
  source: string;
}

/**
 * `number | null` -> `bigint | null`, refusing anything that is not a whole,
 * finite share count.
 *
 * BSE reports its counts as JSON numbers while the column is BigInt. `BigInt()`
 * THROWS on a fractional or non-finite input, so the naive conversion turns one
 * odd payload into a failed scheduled job — and a `Math.round` would instead
 * store a share count nobody filed. Absence is the honest third answer, and it
 * is the one this repo already insists on everywhere `""`/`-` appears.
 */
function toShareCount(value: number | null | undefined): bigint | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (!Number.isInteger(value)) return null;
  if (!Number.isSafeInteger(value)) return null;
  return BigInt(value);
}

/**
 * Upsert one breakdown row on `(symbol, exchange, quarter)`.
 *
 * `exchange` is spelled out on the create for the same reason
 * {@link writeShareholding} spells it out: it is a KEY COMPONENT, and it is
 * deliberately absent from `update`, where touching it could only ever move a
 * row out from under its own key.
 */
async function writeBreakdown(
  delegates: OwnershipDelegates,
  symbol: string,
  exchange: string,
  quarter: string,
  payload: BreakdownPayload,
  tally: Tally,
): Promise<void> {
  const model = delegates.breakdown;
  if (!model) return;
  try {
    await model.upsert({
      where: { symbol_exchange_quarter: { symbol, exchange, quarter } },
      create: { symbol, exchange, quarter, ...payload },
      update: payload,
    });
    tally.written++;
  } catch (err) {
    tally.writeFailed++;
    logger.warn(
      `breakdown upsert failed ${symbol}/${exchange}/${quarter}: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
}

/** An NSE XBRL parse -> the write payload. Percentages are already 0–100. */
function breakdownFromXbrl(
  parse: ShareholdingBreakdownParse,
  sourceUrl: string,
): BreakdownPayload {
  return {
    promoterPct: parse.promoterPct,
    promoterPledgedPct: parse.promoterPledgedPct,
    fiiPct: parse.fiiPct,
    diiPct: parse.diiPct,
    mutualFundPct: parse.mutualFundPct,
    insurancePct: parse.insurancePct,
    banksFiPct: parse.banksFiPct,
    alternateInvPct: parse.alternateInvPct,
    govtPct: parse.govtPct,
    publicPct: parse.publicPct,
    retailPct: parse.retailPct,
    employeeTrustPct: parse.employeeTrustPct,
    custodianDrPct: parse.custodianDrPct,
    nonPromoterNonPublicPct: parse.nonPromoterNonPublicPct,
    // Already BigInt on this side — the XBRL parser reads them as such because
    // an Indian large cap's share count exceeds 2^53 in paise-denominated
    // derivations.
    promoterShares: parse.promoterShares,
    fiiShares: parse.fiiShares,
    diiShares: parse.diiShares,
    publicShares: parse.publicShares,
    totalShares: parse.totalShares,
    sourceUrl,
    // The recognised members verbatim, plus the provenance that says HOW the
    // two derived totals were reached. `diiMode: "summed-legs"` means the filing
    // stated no DII total and the number below it can only understate; without
    // it in `raw` that distinction is unrecoverable from the row.
    raw: safeStringify({
      categories: parse.categories,
      taxonomyVersion: parse.taxonomyVersion,
      scale: parse.scale,
      scaleSource: parse.scaleSource,
      diiMode: parse.diiMode,
      fiiMode: parse.fiiMode,
      isin: parse.isin,
      reportDate: parse.reportDate,
      memberHits: parse.memberHits,
      reasons: parse.reasons,
    }),
    source: "NSE_SHP_XBRL",
  };
}

/**
 * JSON, or a recorded refusal — never a throw.
 *
 * `categories` is a plain record of numbers and strings so this cannot
 * realistically cycle, but a writer that can throw inside a 700-symbol walk
 * turns one odd document into a lost slice.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "{}";
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

// ── Universe ─────────────────────────────────────────────────────────────────

/**
 * Normalised company-name -> NSE symbol, for the pledge feed's name-only rows.
 *
 * NSE-only on purpose: the pledge feed is an NSE publication naming NSE-listed
 * companies, so resolving one of its names to a BSE-only symbol would attribute
 * an NSE disclosure to a company NSE never mentioned.
 *
 * First writer wins on a collision so the result is deterministic; ambiguous
 * names simply stay unresolved rather than being attributed to whichever row
 * Mongo returned last.
 */
async function buildNameToSymbolMap(): Promise<ReadonlyMap<string, string>> {
  const rows = await prisma.instrumentMapping.findMany({
    where: { exchange: "NSE", isActive: true, instrumentType: "EQUITY" },
    select: { symbol: true, name: true },
  });
  const map = new Map<string, string>();
  for (const r of rows) {
    const key = normalizeCompanyName(r.name);
    if (key && !map.has(key)) map.set(key, r.symbol);
  }
  return map;
}

/**
 * The ownership universe: active NSE **and BSE** equities.
 *
 * It used to be NSE-only, with a comment calling the BSE gap "known rather than
 * a bug". Founder decision on MONEY-1207 overrides that: coverage is every NSE
 * and BSE listed entity. Measured on prod 2026-08-18 — NSE 10,437, BSE 10,604,
 * 2,465 sharing a symbol, so 18,576 distinct names after dedupe.
 *
 * The known cost is written down rather than hidden: all four endpoints are
 * `www.nseindia.com/api/*` keyed on the NSE trading symbol, so the 8,139
 * BSE-only names are expected to answer empty. They are fetched LAST (tier 4)
 * and their `emptyResponses` are counted per tier, so the first full pass
 * measures the waste instead of anyone having to guess at it.
 */
async function loadActiveUniverse(): Promise<
  Array<{ symbol: string; exchange: string }>
> {
  const rows = await prisma.instrumentMapping.findMany({
    where: {
      exchange: { in: ["NSE", "BSE"] },
      isActive: true,
      instrumentType: "EQUITY",
    },
    select: { symbol: true, exchange: true },
  });
  return rows;
}

/**
 * Current index membership, for the priority tiers.
 *
 * `removedOn: null` is the live stint. A failure here must NOT fail the run —
 * it costs priority ORDER, not coverage, and refusing to sync 18,576 symbols
 * because the Nifty 50 list could not be read would be a strictly worse outcome.
 */
async function loadIndexMembers(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const rows = await prisma.indexMembership.findMany({
      where: {
        // MONEY-1236 — the bare `removedOn: null` is correct: every writer
        // stamps the key. index-constituent-sync.ts passes an explicit
        // `removedOn: null` in `recordMembershipHistory`'s `createMany` (line
        // 354), and scripts/data/backfill-index-membership.ts writes it in both
        // `create` and `update`. Measured on prod 2026-08-21: 924 rows,
        // 0 absent, 924 explicit null.
        // prisma-null-ok: open stints carry an explicit null (0 absent of 924)
        removedOn: null,
        indexId: { in: Object.keys(INDEX_TIER_BY_ID) },
      },
      select: { indexId: true, symbol: true },
    });
    for (const r of rows) {
      const list = out.get(r.indexId);
      if (list) list.push(r.symbol);
      else out.set(r.indexId, [r.symbol]);
    }
  } catch (err) {
    logger.warn(
      `index membership load failed — the queue will be unprioritised (every ` +
        `symbol still gets fetched, just not indices-first): ${
          err instanceof Error ? err.message : err
        }`,
    );
  }
  return out;
}

/**
 * Newest-first scan for each leg's last cursor.
 *
 * First writer wins per leg, so a run that only executed `shareholding` cannot
 * clobber `pit`'s position. A leg whose cursor is older than
 * {@link CURSOR_LOOKBACK_RUNS} restarts its pass at the head of the queue —
 * wasteful, never blinding.
 */
async function loadCursors(): Promise<Record<string, OwnershipCursor>> {
  const out: Record<string, OwnershipCursor> = {};
  try {
    const recent = await prisma.marketDataSyncLog.findMany({
      where: { syncType: SYNC_TYPE },
      orderBy: { startedAt: "desc" },
      take: CURSOR_LOOKBACK_RUNS,
      select: { metadata: true },
    });
    for (const row of recent) {
      for (const [leg, cursor] of Object.entries(
        readStoredCursors(row.metadata),
      )) {
        if (!(leg in out)) out[leg] = cursor;
      }
    }
  } catch (err) {
    logger.warn(
      `cursor load failed — starting this pass at the head of the queue: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
  return out;
}

// ── Leg 5: the SHP XBRL filing ───────────────────────────────────────────────

/**
 * GET one filing, or null.
 *
 * Routed through `getFeedAsset` so archive/replay applies for free: prod
 * archives every filing once under `feeds/NSE/shp-xbrl/{YYYY}/{MM}/…` and QA
 * replays those bytes instead of scraping `nsearchives.nseindia.com` per
 * (symbol, quarter). The descriptor's `date` is the QUARTER END — see
 * `shpXbrlArchiveDay` for why that, and not the day we happen to fetch.
 *
 * The `.xml` gate has ALREADY run (`isFetchableXbrlUrl`, inside
 * `pendingShpFilings`) before a candidate reaches here, so the sentinel URL
 * costs no request. The `<!` check below is the second, different guard: NSE's
 * throttle response is a 200 carrying HTML, which the extension cannot predict
 * — and an HTML page frozen into the archive would be replayed forever.
 *
 * Never throws. One unreachable filing must cost one filing.
 */
async function fetchShpXml(
  url: string,
  quarter: string,
): Promise<string | null> {
  try {
    const resp = await getFeedAsset(
      url,
      SHP_XBRL_REFERER,
      {
        exchange: "NSE",
        feed: SHP_XBRL_FEED_SLUG,
        date: shpXbrlArchiveDay(quarter),
      },
      undefined,
      { timeoutMs: SHP_XBRL_TIMEOUT_MS },
    );
    if (!resp) return null;
    const text = await resp.text();
    if (text.trim() === "") return null;
    if (text.trimStart().startsWith("<!")) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * The symbols that still have at least one unfetched filing.
 *
 * TWO grouped counts, not a scan of `raw`: `shareholding_breakdown` rows are
 * only ever written from a `shareholding_patterns` row of the same
 * (symbol, exchange, quarter), so the breakdown quarter set is a SUBSET of the
 * pattern one — which makes `patternCount > breakdownCount` an exact test for
 * "something is missing", not an approximation. The exact quarters are resolved
 * per symbol inside the walk, where the set is at most 47 rows.
 *
 * The known residue: ~89 of prod's 7,953 rows carry NSE's `/corporate/xbrl/-`
 * sentinel and can never produce a breakdown row, so their symbols stay in this
 * queue permanently. They cost two indexed reads per visit and ZERO requests
 * (the sentinel is refused before the fetch), and they are counted under
 * `noXbrlLink` so the residue is measured rather than assumed.
 */
async function loadShpXbrlQueue(order: readonly string[]): Promise<string[]> {
  const [patterns, breakdowns] = await Promise.all([
    prisma.shareholdingPattern.groupBy({
      by: ["symbol"],
      where: { exchange: SHAREHOLDING_EXCHANGE },
      _count: { _all: true },
    }),
    prisma.shareholdingBreakdown.groupBy({
      by: ["symbol"],
      where: { exchange: SHAREHOLDING_EXCHANGE },
      _count: { _all: true },
    }),
  ]);

  const done = new Map<string, number>();
  for (const b of breakdowns) done.set(b.symbol, b._count._all);

  const pending = new Set<string>();
  for (const p of patterns) {
    if (p._count._all > (done.get(p.symbol) ?? 0)) pending.add(p.symbol);
  }

  // Walked in the MAIN queue's priority order (Nifty 50 first), so the split
  // that matters most is filled first. A pending symbol the universe query does
  // not know about — delisted since its pattern row was written — is appended
  // rather than dropped: its filing is still the correct historical record.
  const ordered = order.filter((s) => pending.has(s));
  const seen = new Set(ordered);
  for (const s of pending) if (!seen.has(s)) ordered.push(s);
  return ordered;
}

/** One symbol's worth of leg-5 work. Fetches at most {@link SHP_XBRL_MAX_PER_SYMBOL}. */
async function runShpXbrlSymbol(
  symbol: string,
  delegates: OwnershipDelegates,
  tally: Tally,
  ctx: {
    deadline: number;
    delayMs: number;
    sleep: (ms: number) => Promise<void>;
    memberHits: Record<string, number>;
    disagreements: Array<Record<string, unknown>>;
  },
): Promise<void> {
  const [rows, stored] = await Promise.all([
    prisma.shareholdingPattern.findMany({
      where: { symbol, exchange: SHAREHOLDING_EXCHANGE },
      select: {
        symbol: true,
        quarter: true,
        raw: true,
        promoterPct: true,
        publicPct: true,
      },
    }),
    prisma.shareholdingBreakdown.findMany({
      where: { symbol, exchange: SHAREHOLDING_EXCHANGE },
      select: { quarter: true },
    }),
  ]);

  const { pending, reasons } = pendingShpFilings(
    rows,
    new Set(stored.map((s) => s.quarter)),
    SHP_XBRL_MAX_PER_SYMBOL,
  );
  mergeCounts(tally.reasons, reasons);

  for (let i = 0; i < pending.length; i++) {
    // Checked per FILING, not per symbol: a symbol with four pending quarters
    // is four requests, and letting all four run because the symbol started
    // inside the budget is how a per-leg share overruns into the next leg's.
    if (Date.now() > ctx.deadline) {
      bump(tally.reasons, "deadline");
      return;
    }
    // Paced on the same clock as the walk itself, so a symbol with four
    // filings issues requests at the same rate as four symbols with one.
    if (i > 0 && ctx.delayMs > 0) await ctx.sleep(ctx.delayMs);

    const candidate = pending[i]!;
    const xml = await fetchShpXml(candidate.url, candidate.quarter);
    tally.fetched++;
    if (xml === null) {
      tally.emptyResponses++;
      continue;
    }

    const outcome = inspectShareholdingXbrl(xml);
    if (outcome.kind !== "ok") {
      tally.skipped++;
      bump(tally.reasons, `xbrl:${outcome.kind}`);
      continue;
    }
    const parse = outcome.parse;
    tally.rows++;
    for (const [role, member] of Object.entries(parse.memberHits)) {
      bump(ctx.memberHits, `${role}:${member}`);
    }

    // The reconciliation, BEFORE the write and never after it. The XBRL URL
    // comes out of the summary payload, so a mis-keyed row or a restated filing
    // pointing at the wrong document arrives here as a perfectly valid filing
    // for the WRONG company — and this table upserts last-filing-wins.
    const verdict: ShareholdingReconcileVerdict = reconcileWithSummary(
      parse,
      {
        symbol: candidate.symbol,
        quarter: candidate.quarter,
        promoterPct: candidate.promoterPct,
        publicPct: candidate.publicPct,
        isin: candidate.isin,
      },
      // Passed explicitly rather than defaulted so the sync log can record the
      // threshold a verdict was reached under; a tolerance that only exists in
      // a deploy makes an old verdict un-reproducible.
      SHAREHOLDING_RECONCILE_TOLERANCE_PCT,
    );
    const decision = decideBreakdownWrite(verdict);
    bump(tally.reasons, `reconcile:${decision.reason}`);

    if (!decision.write) {
      tally.skipped++;
      if (verdict.status === "disagree" && ctx.disagreements.length < 25) {
        ctx.disagreements.push({
          symbol: candidate.symbol,
          quarter: candidate.quarter,
          field: verdict.field,
          filing: verdict.breakdownValue,
          summary: verdict.summaryValue,
          deltaPct: verdict.deltaPct,
          url: candidate.url,
        });
      }
      logger.warn(
        `reconcile REFUSED ${candidate.symbol}/${candidate.quarter}: ` +
          `${decision.reason} — the stored summary row is left untouched`,
      );
      continue;
    }

    // Keyed on the SUMMARY's quarter, not the filing's. `reconcileWithSummary`
    // has already refused any filing that names a different one, so the two are
    // either equal or the filing did not state one — and keying on the summary
    // is what guarantees `shareholding_breakdown` joins `shareholding_patterns`
    // on (symbol, exchange, quarter) for every row this leg writes.
    await writeBreakdown(
      delegates,
      candidate.symbol,
      SHAREHOLDING_EXCHANGE,
      candidate.quarter,
      breakdownFromXbrl(parse, candidate.url),
      tally,
    );
  }
}

// ── Leg 6: BSE shareholding ──────────────────────────────────────────────────

/** One scrip's worth of leg-6 work: one index call + up to N (summary+public) pairs. */
async function runBseSymbol(
  symbol: string,
  scripCode: string,
  delegates: OwnershipDelegates,
  tally: Tally,
  ctx: {
    deadline: number;
    delayMs: number;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<void> {
  // The quarter index is a DISCOVERY call and is counted separately from the
  // data calls on purpose. In the steady state most scrips have nothing new, so
  // a run is mostly index calls with zero rows — folding those into `fetched`
  // would make `decideRunStatus` call a legitimately quiet quarter a barren leg
  // every single day between filing seasons.
  tally.discoveryFetched++;
  const quarters = await fetchBseShpQuarters(scripCode);
  if (quarters === null || quarters.length === 0) {
    tally.discoveryEmpty++;
    return;
  }

  const stored = await prisma.shareholdingPattern.findMany({
    where: { symbol, exchange: BSE_SHAREHOLDING_EXCHANGE },
    select: { quarter: true },
  });
  const { pending, reasons } = pendingBseQuarters(
    quarters,
    new Set(stored.map((s) => s.quarter)),
    BSE_MAX_QUARTERS_PER_SYMBOL,
  );
  mergeCounts(tally.reasons, reasons);

  for (let i = 0; i < pending.length; i++) {
    if (Date.now() > ctx.deadline) {
      bump(tally.reasons, "deadline");
      return;
    }
    if (ctx.delayMs > 0) await ctx.sleep(ctx.delayMs);

    const { quarter: q, expectedKey } = pending[i]!;
    const payload = await fetchBseShareholding(scripCode, q.qtrId);
    tally.fetched++;
    if (payload === null) {
      tally.emptyResponses++;
      continue;
    }

    // The INJECTED `normalizeQuarter` is the real one from ownership-logic.
    // Re-implementing it here would key BSE rows differently from every NSE row
    // and the two tables would never join.
    const parse = parseBseShareholding(payload, { normalizeQuarter });
    if (parse === null) {
      // A bogus scripcode AND a bogus qtrid both answer 200 with a complete
      // SEBI skeleton of `0.00`. The parser's metadata-table gate is what
      // refuses them, and there is deliberately NO second, looser check here:
      // a `Table1.length` test upstream would pass the skeleton (it has six
      // fully-populated zero rows) and read as a corroborating guard.
      tally.skipped++;
      bump(tally.reasons, "bseUnparseable");
      continue;
    }
    mergeCounts(tally.reasons, parse.reasons);
    tally.rows++;

    if (expectedKey !== null && parse.quarter !== expectedKey) {
      // The label pre-filter and `fld_enddate` disagree. Not fatal — the
      // payload's own end date is the authority and is what gets written — but
      // it means the pre-filter will re-offer this quarter next pass, so it is
      // counted rather than left to look like normal traffic.
      bump(tally.reasons, "labelKeyMismatch");
    }

    await writeShareholding(
      delegates,
      [
        {
          symbol,
          quarter: parse.quarter,
          promoterPct: parse.summary.promoterPct,
          pledgedPct: parse.summary.pledgedPct,
          fiiPct: parse.summary.fiiPct,
          diiPct: parse.summary.diiPct,
          publicPct: parse.summary.publicPct,
          employeeTrustsPct: parse.summary.employeeTrustsPct,
          underlyingDrsPct: parse.summary.underlyingDrsPct,
          raw: parse.raw,
        },
      ],
      tally,
      BSE_SHAREHOLDING_EXCHANGE,
      "BSE_SHP",
    );

    await writeBreakdown(
      delegates,
      symbol,
      BSE_SHAREHOLDING_EXCHANGE,
      parse.quarter,
      {
        promoterPct: parse.breakdown.promoterPct,
        promoterPledgedPct: parse.breakdown.promoterPledgedPct,
        fiiPct: parse.breakdown.fiiPct,
        diiPct: parse.breakdown.diiPct,
        mutualFundPct: parse.breakdown.mutualFundPct,
        insurancePct: parse.breakdown.insurancePct,
        banksFiPct: parse.breakdown.banksFiPct,
        alternateInvPct: parse.breakdown.alternateInvPct,
        govtPct: parse.breakdown.govtPct,
        publicPct: parse.breakdown.publicPct,
        retailPct: parse.breakdown.retailPct,
        employeeTrustPct: parse.breakdown.employeeTrustPct,
        custodianDrPct: parse.breakdown.custodianDrPct,
        nonPromoterNonPublicPct: parse.breakdown.nonPromoterNonPublicPct,
        promoterShares: toShareCount(parse.breakdown.promoterShares),
        fiiShares: toShareCount(parse.breakdown.fiiShares),
        diiShares: toShareCount(parse.breakdown.diiShares),
        publicShares: toShareCount(parse.breakdown.publicShares),
        totalShares: toShareCount(parse.breakdown.totalShares),
        sourceUrl: bseShpSummaryUrl(scripCode, q.qtrId),
        // COMPACT, deliberately — not `parse.raw` a second time.
        //
        // BSE's two payloads stringify to ~63 KB for one (scrip, quarter)
        // (measured: RELIANCE Jun-2026, 62,976 chars). The PATTERN row above
        // already stores those bytes verbatim as the re-parseable audit
        // artifact, and the two rows share `(symbol, exchange, quarter)` — so
        // writing them again here buys nothing and doubles the collection to
        // ~2.5 GB over a first full pass (10,604 scrips x 2 quarters x 63 KB
        // x 2), all of which then has to cross the prod -> QA mongodump.
        //
        // What is kept is what the pattern row does NOT carry: the encumbrance
        // figure that is not a schema column (a promoter can be 99.99%
        // encumbered with pledge null), whether pledge was declared at all, the
        // per-skip tally, and BSE's own quarter handle + end date so the exact
        // pair that produced this row can be re-requested from `sourceUrl`.
        raw: safeStringify({
          scripCode: parse.scripCode,
          companyName: parse.companyName,
          qtrId: parse.qtrId,
          quarterRaw: parse.quarterRaw,
          totalEncumberedPct: parse.totalEncumberedPct,
          pledgeDeclared: parse.pledgeDeclared,
          reasons: parse.reasons,
        }),
        source: "BSE_SHP",
      },
      tally,
    );
  }
}

/**
 * Build leg 6's queue: BSE-listed actives whose scrip code the master resolves.
 *
 * ONE master fetch per run, not one per symbol — 12,664 rows answer the
 * identity question for the whole universe, and 10,604 per-symbol lookups would
 * answer it 10,604 times.
 */
async function loadBseQueue(
  universe: ReadonlyArray<{ symbol: string; exchange: string }>,
  tierOf: ReadonlyMap<string, number>,
): Promise<{ queue: BseShpQueue; identity: Record<string, number> }> {
  const [master, bseRows] = await Promise.all([
    fetchBseScripMaster(),
    prisma.instrumentMapping.findMany({
      where: {
        exchange: BSE_SHAREHOLDING_EXCHANGE,
        isActive: true,
        instrumentType: "EQUITY",
      },
      select: { symbol: true, isin: true },
    }),
  ]);

  const index = buildBseScripIndex(
    master.map((m) => ({
      scripId: m.scripId,
      scripCode: m.scripCode,
      isin: m.isin,
    })),
    bseRows,
  );
  const queue = buildBseShpQueue(universe, index.bySymbol, tierOf);
  return {
    queue,
    identity: {
      masterRows: index.masterRows,
      resolvedBySymbol: index.resolvedBySymbol,
      resolvedByIsin: index.resolvedByIsin,
      ambiguousIsin: index.ambiguousIsin,
      unresolved: index.unresolved,
    },
  };
}

// ── Run outcome + retry class (MONEY-1238 #8) ────────────────────────────────

/**
 * What the run decided, handed back to the route.
 *
 * The processor used to be `Promise<void>` and only LOGGED the verdict, so
 * `decideRunStatus`'s FAILED — an empty symbol queue, missing Prisma models,
 * "0 rows written across N non-empty payloads" — could not reach Pub/Sub,
 * whose retry is driven entirely by a non-2xx status. The route returned a
 * flat `{success:true}, 200` and its own catch-block comment described a retry
 * path the verdict was structurally incapable of triggering.
 */
export interface OwnershipRunOutcome {
  status: RunStatus;
  /** See {@link isRetriableOwnershipFailure}. Always false unless FAILED. */
  retriable: boolean;
  notes: string[];
  barrenLegs: string[];
  missingModels: string[];
  queueFailures: string[];
  symbolsAttempted: number;
  symbolsFailed: number;
  totalRows: number;
  totalWritten: number;
  durationMs: number;
  /** Projected days for a full pass, or null when the run walks no queue. */
  projectedPassDays: number | null;
  /** True when the projection is past {@link FULL_PASS_ALERT_DAYS}. */
  passDaysAlert: boolean;
}

/**
 * Is this FAILED run worth a Pub/Sub redelivery?
 *
 * Follows the `isRetriableFailure` idiom `xbrl-sync` already established
 * (MONEY-1200): the response code is chosen by FAILURE CLASS, never by `ok`.
 * Pub/Sub redelivers on any non-2xx, so blanket-500ing a FAILED verdict turns
 * a DETERMINISTIC failure into five identical full-fan-out runs against NSE
 * before the dead-letter policy catches it.
 *
 * DETERMINISTIC, therefore 200 + a loud outcome:
 *
 *   - `missingModels` — a Prisma model absent from the generated client is
 *     absent on every redelivery until a schema push AND a redeploy. No retry
 *     can make it appear, and this processor deliberately keeps fetching and
 *     parsing when it happens ("so the shape counters are recorded"), so each
 *     attempt pays the FULL per-symbol NSE fan-out and writes nothing.
 *   - a barren / zero-write run — the same bytes parse the same way every
 *     time. This is the parser-or-shape failure the verdict exists to name,
 *     and it is healed by teaching the parser, not by asking NSE again.
 *
 * TRANSIENT, therefore 500:
 *
 *   - a queue that could not be BUILT (`queueFailures`: the BSE scrip master
 *     403'd, the pending-filing index threw) or a UNIVERSE query that returned
 *     zero active equities. Those are infrastructure faults that heal by
 *     themselves, and the run fails BEFORE it can do anything useful.
 *
 * ...but only while the retry is still CHEAP. `symbolsAttempted > 0` means the
 * expensive part already ran, so a redelivery would re-walk every symbol to
 * re-attempt one broken leg. That is the retry storm the xbrl-sync note is
 * about, and it costs the same whether the cause is transient or not.
 *
 * Pure and exported so the matrix is unit-testable without a run.
 */
export function isRetriableOwnershipFailure(input: {
  status: RunStatus;
  missingModels: readonly string[];
  queueFailures: readonly string[];
  emptyUniverseQueue: boolean;
  symbolsAttempted: number;
}): boolean {
  if (input.status !== "FAILED") return false;
  if (input.missingModels.length > 0) return false;
  if (input.symbolsAttempted > 0) return false;
  return input.queueFailures.length > 0 || input.emptyUniverseQueue;
}

// ── Processor ────────────────────────────────────────────────────────────────

export async function processOwnershipSync(
  data: OwnershipSyncMessage,
): Promise<OwnershipRunOutcome> {
  const startedAt = Date.now();
  const legs = new Set<OwnershipLeg>(
    data.legs && data.legs.length > 0 ? data.legs : ALL_LEGS,
  );
  const maxSymbols = data.maxSymbols ?? DEFAULT_MAX_SYMBOLS;
  const budgetMs = data.budgetMs ?? RUN_BUDGET_MS;
  const runDeadline = startedAt + budgetMs;
  const runsPerDay = data.runsPerDay ?? 1;

  const delegates = ownershipDelegates();
  const missingModels: string[] = [];
  if (!delegates.shareholding) missingModels.push("ShareholdingPattern");
  if (!delegates.insider) missingModels.push("InsiderEvent");
  if (!delegates.breakdown) missingModels.push("ShareholdingBreakdown");
  if (missingModels.length > 0) {
    // Loud, recorded, and now FAILED rather than COMPLETED. The run continues so
    // the FETCH + PARSE counters still land in the log; only the writes are
    // skipped.
    logger.error(
      `Prisma models not migrated yet: ${missingModels.join(", ")} — fetching and ` +
        `parsing anyway so the shape counters are recorded, but NOTHING WILL BE WRITTEN.`,
    );
  }

  // ── Symbol selection ──────────────────────────────────────────────────────
  const explicit =
    data.symbols && data.symbols.length > 0
      ? Array.from(
          new Set(
            data.symbols
              .map((s) =>
                s
                  .replace(/\.(NS|BO)$/i, "")
                  .trim()
                  .toUpperCase(),
              )
              .filter((s) => s !== ""),
          ),
        ).sort()
      : null;

  const perSymbolLegs = PER_SYMBOL_LEGS.filter((l) => legs.has(l));
  const walkLegs = WALKING_LEGS.filter((l) => legs.has(l));

  let queue: OwnershipQueue = {
    symbols: [],
    entries: new Map(),
    tierCounts: {},
  };
  let cursors: Record<string, OwnershipCursor> = {};
  /**
   * Per-leg walk queues. The three NSE legs share the universe queue; `shpXbrl`
   * and `bse` get their own, because "the queue" stopped being one list
   * (MONEY-1205).
   */
  const legQueues: Partial<Record<OwnershipLeg, string[]>> = {};
  /** Leg-specific evidence for the sync log (identity resolution, queue sizes). */
  const legInfo: Record<string, unknown> = {};
  /** A leg whose queue could not be BUILT. Distinct from one with nothing to do. */
  const queueFailures: string[] = [];
  let bseScrip: ReadonlyMap<string, string> = new Map();
  const shpDisagreements: Array<Record<string, unknown>> = [];
  const shpMemberHits: Record<string, number> = {};

  if (explicit) {
    queue = {
      symbols: explicit,
      entries: new Map(
        explicit.map((s) => [s, { symbol: s, exchange: "NSE", tier: -1 }]),
      ),
      tierCounts: { explicit: explicit.length },
    };
    for (const leg of walkLegs) legQueues[leg] = explicit;
    if (legs.has("bse")) {
      // An explicit backfill still needs the scrip codes; only the QUEUE and the
      // cursor are bypassed, never the identity lookup.
      try {
        const built = await loadBseQueue(
          explicit.map((s) => ({ symbol: s, exchange: "BSE" })),
          new Map(),
        );
        bseScrip = built.queue.scripBySymbol;
        legQueues.bse = built.queue.symbols;
        legInfo.bseIdentity = built.identity;
      } catch (err) {
        queueFailures.push("bse");
        // CLEARED, not left as the explicit list. Without the scrip index every
        // symbol resolves to `noScripCode`, so walking them would spend the
        // leg's whole budget producing one counter — and `queueFailures` has
        // already made the run FAILED.
        legQueues.bse = [];
        logger.error(
          `BSE scrip index failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    logger.info(
      `Explicit symbol list (${explicit.length}) — the queue and every cursor ` +
        `are bypassed, so the scheduled pass is not advanced.`,
    );
  } else if (walkLegs.length > 0) {
    const [universe, indexMembers] = await Promise.all([
      loadActiveUniverse(),
      loadIndexMembers(),
    ]);
    queue = buildOwnershipQueue(universe, indexMembers);
    cursors = await loadCursors();
    for (const leg of perSymbolLegs) legQueues[leg] = queue.symbols;
    logger.info(
      `Universe ${universe.length} rows -> queue ${queue.symbols.length} distinct symbols ` +
        `(${Object.entries(queue.tierCounts)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}); head = ${queue.symbols.slice(0, 3).join(", ")}`,
    );

    if (legs.has("shpXbrl")) {
      try {
        const pendingQueue = await loadShpXbrlQueue(queue.symbols);
        legQueues.shpXbrl = pendingQueue;
        legInfo.shpXbrlQueue = { pendingSymbols: pendingQueue.length };
        logger.info(
          `shpXbrl queue: ${pendingQueue.length} symbol(s) with an unfetched ` +
            `filing (head = ${pendingQueue.slice(0, 3).join(", ") || "none"}). ` +
            `An EMPTY queue here is the healthy steady state — every stored ` +
            `summary row already has its breakdown.`,
        );
      } catch (err) {
        // NOT the same thing as "nothing pending". A failed index build that
        // degraded to an empty queue would read as full coverage.
        queueFailures.push("shpXbrl");
        logger.error(
          `shpXbrl queue build failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (legs.has("bse")) {
      try {
        const tierOf = new Map<string, number>();
        for (const [symbol, entry] of queue.entries)
          tierOf.set(symbol, entry.tier);
        const built = await loadBseQueue(universe, tierOf);
        bseScrip = built.queue.scripBySymbol;
        legQueues.bse = built.queue.symbols;
        legInfo.bseIdentity = built.identity;
        legInfo.bseTierCounts = built.queue.tierCounts;
        legInfo.bseUnresolved = built.queue.unresolved;
        logger.info(
          `bse queue: ${built.queue.symbols.length} scrip(s) resolved ` +
            `(bySymbol ${built.identity.resolvedBySymbol}, byIsin ` +
            `${built.identity.resolvedByIsin}, ambiguousIsin ` +
            `${built.identity.ambiguousIsin}, unresolved ` +
            `${built.identity.unresolved}) from a ${built.identity.masterRows}-row master`,
        );
      } catch (err) {
        queueFailures.push("bse");
        logger.error(
          `bse queue build failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  // Per-leg wall clock. The whole run still has to land inside the Pub/Sub ack
  // deadline, so the run budget is DIVIDED, never multiplied — the leg split
  // that raises throughput is the one across SCHEDULERS, where each job hands
  // its single leg the entire budget.
  //
  // MEASURED TRADE-OFF, because it points the wrong way if you only read the
  // word "budget". The old code interleaved all three fetches inside ONE paced
  // step, so the 600ms inter-symbol delay was amortised across three requests:
  // (3 x ~1.06s fetch + 0.6s) / 3 lanes = 0.79 symbols/s -> ~360 symbols in
  // 456s, which matches the eight prod runs exactly. Per-leg walks pay the
  // 600ms once PER REQUEST: (1.06 + 0.6) / 3 = 1.81 symbols/s, so a leg given
  // the WHOLE 420s reaches ~760 symbols — but three legs sharing 140s each
  // reach only ~253.
  //
  // So a single all-legs job is ~30% SLOWER under this scheme, and the split
  // across schedulers is not a nice-to-have: it is what pays for the change and
  // then some (760 vs 360 symbols per leg per run). The shipped schedule in
  // scripts/ops/setup-scheduler.sh therefore runs ONE leg per job.
  //
  // A second reason not to combine them, sharper than the first: `legDeadline`
  // is clamped to the RUN deadline, so any overrun by an earlier leg (or by the
  // bulk pledge call, which runs before all of them) comes out of the LAST leg's
  // share. With three legs the third can be left with almost nothing, and its
  // cursor barely moves while the other two advance normally — a slow, uneven
  // pass that no single counter would make obvious.
  //
  // MONEY-1205 divides by `walkLegs`, not `perSymbolLegs`: `shpXbrl` and `bse`
  // walk queues too, and leaving them out of the divisor would hand a five-leg
  // run three shares of wall clock for five consumers — the last two would run
  // on whatever the first three left, i.e. usually nothing, and their cursors
  // would barely move while every counter looked normal.
  const perLegBudgetMs =
    walkLegs.length > 0 ? Math.floor(budgetMs / walkLegs.length) : budgetMs;

  logger.info(
    `Ownership sync start: legs [${Array.from(legs).join(", ")}], ` +
      `budget ${Math.round(budgetMs / 1000)}s (${Math.round(perLegBudgetMs / 1000)}s per ` +
      `per-symbol leg), cap ${maxSymbols}, concurrency ` +
      `${data.concurrency ?? NSE_PER_SYMBOL_CONCURRENCY}, delay ` +
      `${data.delayMs ?? NSE_PER_SYMBOL_DELAY_MS}ms, runsPerDay ${runsPerDay}`,
  );

  const startMetadata: Record<string, unknown> = {
    queueLength: queue.symbols.length,
    tierCounts: queue.tierCounts,
    legQueueLengths: Object.fromEntries(
      walkLegs.map((l) => [l, legQueues[l]?.length ?? 0]),
    ),
    maxSymbols,
    budgetMs,
    perLegBudgetMs,
    runsPerDay,
    legs: Array.from(legs),
    explicitSymbols: explicit !== null,
    cursorsBefore: cursors,
    reconcileTolerancePct: SHAREHOLDING_RECONCILE_TOLERANCE_PCT,
    ...legInfo,
  };

  const syncLog = await prisma.marketDataSyncLog
    .create({
      data: {
        syncType: SYNC_TYPE,
        source: "NSE",
        status: "RUNNING",
        metadata: startMetadata as Prisma.InputJsonObject,
      },
      select: { id: true, metadata: true },
    })
    .catch(() => null);

  const tallies: Record<OwnershipLeg, Tally> = {
    shareholding: newTally(),
    pit: newTally(),
    sast: newTally(),
    pledge: newTally(),
    shpXbrl: newTally(),
    bse: newTally(),
  };

  // ── 1. Bulk pledge (ONE request for the whole market) ─────────────────────
  // Outside the paced walk on purpose: it is not per-symbol, so pacing it
  // against the queue would be meaningless, and running it first means a budget
  // cut on the per-symbol walk never costs the market-wide leg.
  if (legs.has("pledge")) {
    const t = tallies.pledge;
    try {
      const payload = await fetchPledgeData();
      t.fetched++;
      if (payload === null) t.emptyResponses++;
      else {
        // The bulk feed identifies companies by NAME only — it has no symbol
        // field at all — so without this map every row is unattributable and
        // the leg writes nothing (verified: 0 of 1,540 rows before, 1,457
        // after). Built once per run from our own instrument master; the
        // remainder are counted `unresolvedName`, never guessed.
        const nameToSymbol = await buildNameToSymbolMap();
        const rows = absorb(t, parsePledgeData(payload, nameToSymbol));
        await writeInsiderEvents(delegates, rows, "NSE_PLEDGE", t);
      }
    } catch (err) {
      logger.warn(
        `pledge leg failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    logger.info(
      `pledge: ${t.rows} rows, ${t.skipped} skipped, ${t.written} written`,
    );
  }

  // ── 2. Per-leg paced walks ────────────────────────────────────────────────
  //
  // One walk PER LEG, each over its own slice from its own cursor. Legs that run
  // together therefore stay in lockstep (same queue, same throughput) while legs
  // split across schedulers advance independently — which is the whole point of
  // the `legs` knob.
  //
  // Seeded from the cursors read at run START and only the legs THIS run walked
  // are overwritten, so a shareholding-only job cannot clobber `pit`'s position.
  // Two runs of the SAME leg overlapping (a Pub/Sub redelivery on top of a live
  // run) both start from the same cursor and both advance to the same place:
  // duplicated work, never a skipped symbol. The 20-minute stagger between the
  // three scheduled legs is what keeps that from being the normal case.
  const cursorsAfter: Record<string, OwnershipCursor> = { ...cursors };
  const legWalk: Record<
    string,
    {
      sliced: number;
      processed: number;
      failed: number;
      skippedForBudget: number;
      from: number;
      queueLength: number;
    }
  > = {};

  const legDelayMs = data.delayMs ?? NSE_PER_SYMBOL_DELAY_MS;
  const sleep = (ms: number): Promise<void> =>
    new Promise((r) => setTimeout(r, ms));

  for (const leg of walkLegs) {
    const legSymbols = legQueues[leg] ?? [];
    if (legSymbols.length === 0) continue;
    const from = explicit ? 0 : resolveCursorIndex(legSymbols, cursors[leg]);
    const slice = sliceQueue(legSymbols, from, maxSymbols);
    if (slice.length === 0) continue;

    // Never past the RUN deadline: the ack deadline is the hard boundary and a
    // per-leg share must not be able to sum past it.
    const legDeadline = Math.min(runDeadline, Date.now() + perLegBudgetMs);
    const t = tallies[leg];
    const xbrlCtx = {
      deadline: legDeadline,
      delayMs: legDelayMs,
      sleep,
      memberHits: shpMemberHits,
      disagreements: shpDisagreements,
    };

    const walk = await runPacedPerSymbol(
      slice,
      async (symbol) => {
        if (leg === "shpXbrl") {
          await runShpXbrlSymbol(symbol, delegates, t, xbrlCtx);
          return;
        }
        if (leg === "bse") {
          const scripCode = bseScrip.get(symbol);
          if (scripCode === undefined) {
            // Only reachable if the queue and the index disagree; counted
            // rather than silently treated as a symbol with nothing to file.
            bump(t.reasons, "noScripCode");
            return;
          }
          await runBseSymbol(symbol, scripCode, delegates, t, {
            deadline: legDeadline,
            delayMs: legDelayMs,
            sleep,
          });
          return;
        }

        const payload =
          leg === "shareholding"
            ? await fetchShareholdingMaster(symbol)
            : leg === "pit"
              ? await fetchInsiderTradingPit(symbol)
              : await fetchSastReg29(symbol);
        t.fetched++;
        if (payload === null) {
          t.emptyResponses++;
          return;
        }
        if (leg === "shareholding") {
          const rows = absorb(t, parseShareholdingMaster(symbol, payload));
          await writeShareholding(
            delegates,
            rows,
            t,
            SHAREHOLDING_EXCHANGE,
            "NSE_SHP",
          );
        } else if (leg === "pit") {
          const rows = absorb(t, parseInsiderPit(symbol, payload));
          await writeInsiderEvents(delegates, rows, "NSE_PIT", t);
        } else {
          const rows = absorb(t, parseSastReg29(symbol, payload));
          await writeInsiderEvents(delegates, rows, "NSE_SAST", t);
        }
      },
      {
        delayMs: data.delayMs,
        concurrency: data.concurrency,
        deadline: legDeadline,
        onError: (symbol, err) =>
          logger.warn(
            `${leg} symbol ${symbol} failed: ${
              err instanceof Error ? err.message : err
            }`,
          ),
      },
    );

    // CONSUMED, not the cap. This single line is the MONEY-1207 fix: the old
    // code advanced by a constant 600 while consuming 310-410, so the window
    // stepped over ~220 symbols and only recovered them weeks later, by an
    // arithmetic accident (see ownership-logic's superseded-sharder note).
    const consumed = walk.processed + walk.failed;
    legWalk[leg] = {
      sliced: slice.length,
      processed: walk.processed,
      failed: walk.failed,
      skippedForBudget: walk.skippedForBudget,
      from,
      // The leg's OWN queue length. Recorded per leg because the five legs no
      // longer share one: projecting `bse`'s 10,604 scrips against the
      // universe's 18,576 would report a pass that has not happened.
      queueLength: legSymbols.length,
    };
    if (!explicit) {
      cursorsAfter[leg] = advanceCursor(legSymbols, from, consumed);
    }

    logger.info(
      `${leg}: walked ${consumed}/${slice.length} from queue index ${from} of ` +
        `${legSymbols.length} (${walk.skippedForBudget} left for the next run) -> ` +
        `${t.rows} rows, ${t.written} written`,
    );
  }

  // ── 3. Coverage projection + the completeness alarm ───────────────────────
  //
  // The SLOWEST leg sets the pass length, because the pass is only complete when
  // every leg has walked the queue. Taking the max (or the sum) would report a
  // pass that has not happened.
  //
  // MONEY-1205 projects PER LEG against that leg's OWN queue and takes the
  // slowest. Before, one length served every leg, which was true only while
  // every leg walked the same list — `bse` walks 10,604 scrips and `shpXbrl`
  // walks however many symbols still owe a filing (440 today, ~0 in the steady
  // state), so a single shared length would have understated one and wildly
  // overstated the other.
  const perLegConsumed = walkLegs.map(
    (l) => (legWalk[l]?.processed ?? 0) + (legWalk[l]?.failed ?? 0),
  );
  const consumedPerRun =
    perLegConsumed.length === 0 ? 0 : Math.min(...perLegConsumed);
  // Only a run that WALKS a queue can say anything about how long a pass takes.
  // An explicit-symbol backfill does not walk one, and a pledge-only run has no
  // queue at all — for both, "unknown" is the truthful answer, and letting the
  // empty-queue branch return 0 would record "instant coverage".
  const projectsCoverage = !explicit && walkLegs.length > 0;
  const perLegPassDays: Record<string, number | null> = {};
  for (const leg of walkLegs) {
    const w = legWalk[leg];
    // A leg with an EMPTY queue genuinely has nothing to cover. That is the
    // healthy steady state for `shpXbrl` and must not be reported as a stalled
    // pass, so `projectedPassDays`'s own 0-length answer (0 days) is used
    // rather than the "did not run" one.
    if (!w) {
      perLegPassDays[leg] = (legQueues[leg]?.length ?? 0) === 0 ? 0 : null;
      continue;
    }
    perLegPassDays[leg] = projectedPassDays(
      w.queueLength,
      w.processed + w.failed,
      runsPerDay,
    );
  }
  // The SLOWEST leg sets the pass, and an indeterminate leg makes the whole
  // projection indeterminate — a max() over a set containing "unknown" is not a
  // number, and reporting the largest KNOWN value would understate.
  const legDays = walkLegs.map((l) => perLegPassDays[l] ?? null);
  const passDays = !projectsCoverage
    ? null
    : legDays.some((d) => d === null)
      ? null
      : Math.max(0, ...(legDays as number[]));
  // ONE predicate, computed once (MONEY-1238 #8). It used to be evaluated here
  // for the log and AGAIN, inline, for the `passDaysAlert` metadata field 136
  // lines below — two copies of one rule, and the metadata copy had no reader
  // at all. A boolean named "alert" that nothing reads is worse than no flag:
  // it reads as coverage.
  const passDaysAlert = passDays !== null && passDays > FULL_PASS_ALERT_DAYS;
  if (passDaysAlert) {
    const slowest = walkLegs
      .map(
        (l) =>
          `${l} ${(perLegPassDays[l] ?? 0).toFixed(1)}d over ${legWalk[l]?.queueLength ?? 0}`,
      )
      .join(", ");
    logger.error(
      `COVERAGE ALERT: at ${runsPerDay} run(s)/day the slowest leg needs ` +
        `${passDays.toFixed(1)} days for a full pass, past the ` +
        `${FULL_PASS_ALERT_DAYS}-day target (${slowest}). Add scheduler slots (the ` +
        `cheapest lever), split legs across separate jobs, or raise concurrency. ` +
        `Nothing is being BLINDED — the cursor advances by real throughput — but ` +
        `the tail of the queue is this far behind.`,
    );
  } else if (passDays === null && projectsCoverage) {
    logger.error(
      `COVERAGE ALERT: could not determine the pass length — per-leg ` +
        `${JSON.stringify(perLegPassDays)}. A run that walks nothing makes no ` +
        `progress at all, which no cadence can fix.`,
    );
  }

  // `SHP_MEMBERS` is a set of ORDERED CANDIDATE lists, several of which are
  // declared guesses (the Table IV custodian/DR names have never been seen in a
  // live filing). The module's own falsification rule is that a candidate which
  // never appears in `memberHits` across a prod run is a candidate that does not
  // exist — so the run reports exactly that, rather than leaving the guess
  // permanently unfalsified in a comment.
  const shpRolesSeen = new Set(
    Object.keys(shpMemberHits).map((k) => k.split(":")[0]!),
  );
  const shpRolesUnseen =
    tallies.shpXbrl.rows > 0
      ? Object.keys(SHP_MEMBERS).filter((r) => !shpRolesSeen.has(r))
      : [];

  const unmappedTotal = ALL_LEGS.reduce(
    (n, l) => n + Object.values(tallies[l].unmapped).reduce((a, b) => a + b, 0),
    0,
  );
  if (unmappedTotal > 0) {
    logger.error(
      `KEY MAPPING ALERT: ${unmappedTotal} row(s) carried a VERIFIED payload key ` +
        `that produced no value — our alias list has regressed, not the feed. ` +
        ALL_LEGS.map((l) => `${l}=${JSON.stringify(tallies[l].unmapped)}`).join(
          " ",
        ),
    );
  }

  const totalRows = ALL_LEGS.reduce((n, l) => n + tallies[l].rows, 0);
  const totalWritten = ALL_LEGS.reduce((n, l) => n + tallies[l].written, 0);
  const totalWriteFailed = ALL_LEGS.reduce(
    (n, l) => n + tallies[l].writeFailed,
    0,
  );
  // ATTEMPTED, not SLICED. The slice is now a 2,000-symbol safety bound that the
  // budget never gets through, so counting it here would inflate the denominator
  // ~3x and push `decideRunStatus`'s 5% failure floor from ~38 symbols to ~300 —
  // i.e. the tolerance would silently scale with a constant that has nothing to
  // do with how many symbols were actually tried.
  const symbolsAttempted = walkLegs.reduce(
    (n, l) => n + (legWalk[l]?.processed ?? 0) + (legWalk[l]?.failed ?? 0),
    0,
  );
  const symbolsFailed = walkLegs.reduce(
    (n, l) => n + (legWalk[l]?.failed ?? 0),
    0,
  );

  const verdict = decideRunStatus({
    legs: ALL_LEGS.filter((l) => legs.has(l)).map((l) => ({
      leg: l,
      fetched: tallies[l].fetched,
      emptyResponses: tallies[l].emptyResponses,
      rows: tallies[l].rows,
      written: tallies[l].written,
      bulk: l === "pledge",
    })),
    totalWritten,
    writeFailed: totalWriteFailed,
    symbolsAttempted,
    symbolsFailed,
    missingModels,
    // An empty UNIVERSE queue is never a real market state, and neither is a
    // leg whose queue could not be BUILT — the scrip master 403'd, the pending
    // index threw. Both present as "there was nothing to walk", which is
    // exactly the serene-COMPLETED shape this rule exists to refuse.
    //
    // `shpXbrl` is deliberately NOT in that set when its queue is merely EMPTY:
    // every stored summary row already having its breakdown is the goal, not a
    // failure. A build FAILURE for it still lands here, via `queueFailures`.
    emptyQueue:
      queueFailures.length > 0 ||
      (perSymbolLegs.length > 0 && queue.symbols.length === 0) ||
      (legs.has("bse") &&
        !explicit &&
        !queueFailures.includes("bse") &&
        (legQueues.bse?.length ?? 0) === 0),
  });

  const summary =
    `Ownership sync ${verdict.status} in ${Math.round((Date.now() - startedAt) / 1000)}s: ` +
    `${totalRows} rows parsed, ${totalWritten} written` +
    ALL_LEGS.map(
      (l) =>
        ` | ${l}: fetched=${tallies[l].fetched} empty=${tallies[l].emptyResponses} ` +
        `rows=${tallies[l].rows} skipped=${tallies[l].skipped}`,
    ).join("");
  if (verdict.status === "COMPLETED") logger.info(summary);
  else logger.error(`${summary} :: ${verdict.notes.join("; ")}`);

  if (syncLog) {
    await prisma.marketDataSyncLog
      .update({
        where: { id: syncLog.id },
        data: {
          status: verdict.status,
          recordsProcessed: totalWritten,
          recordsFailed: totalWriteFailed + symbolsFailed,
          completedAt: new Date(),
          errorMessage:
            verdict.notes.length > 0
              ? verdict.notes.join("; ").slice(0, 1000)
              : null,
          // MERGED, not replaced — see mergeSyncMetadata. Everything the create
          // recorded about the queue survives the completion write.
          metadata: mergeSyncMetadata(syncLog.metadata, {
            missingModels,
            durationMs: Date.now() - startedAt,
            symbolsAttempted,
            symbolsFailed,
            consumedPerRun,
            projectedPassDays: passDays,
            perLegPassDays,
            passDaysAlert,
            unmappedTotal,
            barrenLegs: verdict.barrenLegs,
            statusNotes: verdict.notes,
            queueFailures,
            legWalk,
            cursors: cursorsAfter,
            queueHead: queue.symbols.slice(0, 5),
            tierLabels: OWNERSHIP_TIER_LABEL,
            // Leg 5 evidence. `shpMemberHits` is which XBRL member actually
            // matched, per role — the only thing that can distinguish a guessed
            // taxonomy member from a real one that no filer happened to use.
            shpMemberHits,
            shpRolesUnseen,
            // Reconcile disagreements, capped at 25. NOT a summary count: a
            // disagreement is only actionable with both sides and the delta,
            // and a row that was REFUSED leaves no other trace anywhere.
            shpReconcileDisagreements: shpDisagreements,
            // Per-leg shape evidence. The reason this job logs at all.
            legStats: Object.fromEntries(
              ALL_LEGS.map((l) => [
                l,
                {
                  fetched: tallies[l].fetched,
                  emptyResponses: tallies[l].emptyResponses,
                  discoveryFetched: tallies[l].discoveryFetched,
                  discoveryEmpty: tallies[l].discoveryEmpty,
                  rows: tallies[l].rows,
                  skipped: tallies[l].skipped,
                  written: tallies[l].written,
                  writeFailed: tallies[l].writeFailed,
                  reasons: tallies[l].reasons,
                  keyHits: tallies[l].keyHits,
                  unmapped: tallies[l].unmapped,
                },
              ]),
            ),
          }) as Prisma.InputJsonObject,
        },
      })
      .catch((err: unknown) =>
        logger.warn(
          `sync log update failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
  }

  // RETURNED, not merely logged (MONEY-1238 #8). `decideRunStatus` can say
  // FAILED for an empty queue, missing models, or a zero-write run; until this
  // line existed, none of those could reach Pub/Sub, because the processor was
  // `Promise<void>` and the route answered a flat 200. The route turns this
  // into the status code — see `isRetriableOwnershipFailure` for why that is
  // not a blanket 500.
  return {
    status: verdict.status,
    retriable: isRetriableOwnershipFailure({
      status: verdict.status,
      missingModels,
      queueFailures,
      emptyUniverseQueue:
        perSymbolLegs.length > 0 && queue.symbols.length === 0,
      symbolsAttempted,
    }),
    notes: verdict.notes,
    barrenLegs: verdict.barrenLegs,
    missingModels,
    queueFailures,
    symbolsAttempted,
    symbolsFailed,
    totalRows,
    totalWritten,
    durationMs: Date.now() - startedAt,
    projectedPassDays: passDays,
    passDaysAlert,
  };
}
