/**
 * MONEY-980 — candle eviction. The only job in this repo that DELETES prices.
 *
 * Every export exercised here is the REAL symbol `candle-evict.ts` calls — no
 * shadow re-implementations, no Prisma, no GCS, no timers, so nothing here can
 * orphan the runner.
 *
 * The properties asserted are the ones whose failure is silent and permanent:
 *
 *   - a selection that tests `hotLoadedAt` for null matches ZERO rows on Mongo
 *     and the job reports a clean, healthy, entirely empty run forever;
 *   - a containment guard that checks "the object exists" instead of "the
 *     object holds this row" deletes bars a truncated shard never had;
 *   - a window boundary restated instead of derived drifts a year and either
 *     deletes early or retains forever;
 *   - a page that cannot advance past rows it may not delete starves everything
 *     behind them (MONEY-1211 / MONEY-1255);
 *   - a kill switch read with `Boolean()` arms the one configuration meant to
 *     keep the deletes off.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
  isEvictionArmed,
  isEvictionDisabled,
  isWithinRunBudget,
  judgeEvictRun,
  ledgerYearsForDeletions,
  nextEvictStep,
  normalizeChainDepth,
  normalizeRule,
  normalizeSkipRows,
  orderIntradayLeaves,
  partitionByShardCoverage,
  partitionIntradayBySessionAuthority,
  resolveEvictApply,
  depthBandEnd,
  resolveRuleScope,
  ruleDepthBandEnd,
  toColdBarFromCandidate,
  windowFloorTs,
  yearBounds,
  intradaySessionCutoff,
  DEFAULT_EVICT_BATCH_SIZE,
  EVICT_RULES,
  HOT_LOAD_TTL_DAYS,
  INTRADAY_LEAF_ORDER,
  LEDGER_BUDGET_MS,
  MAX_CHAIN_DEPTH,
  RUN_TIME_BUDGET_MS,
  type EvictCandidate,
  type EvictTally,
} from "../../src/processors/candle-evict-logic";
import {
  hotWindowFloorYear,
  intradayHotFloorTs,
  CANDLE_COLD_TIMEOUT_MS,
  INTRADAY_TIMEFRAMES,
  type CandleBar,
} from "@usemoney/core/market-data/candles";
import {
  usMarketDateKey,
  usMarketDayBoundsUtc,
} from "@usemoney/core/market-data/us-market-hours";

const WORKERS = join(import.meta.dirname, "..", "..");
const PROCESSOR = readFileSync(
  join(WORKERS, "src", "processors", "candle-evict.ts"),
  "utf8",
);
const ROUTE = readFileSync(
  join(WORKERS, "src", "routes", "candle-evict.ts"),
  "utf8",
);

/** Comments out, LINE before BLOCK (MONEY-1143 — see candle-hot-load.test.ts). */
const PROCESSOR_CODE = PROCESSOR.replace(/\/\/[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const ROUTE_CODE = ROUTE.replace(/\/\/[^\n]*/g, "").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The prod Cloud Run spec. The fan-out's two ceilings are DECLARED there. */
const PROD_SPEC = readFileSync(join(WORKERS, "cloudbuild.prod.yaml"), "utf8");

const d = (iso: string): Date => new Date(`${iso}T00:00:00Z`);

function candidate(over: Partial<EvictCandidate> = {}): EvictCandidate {
  return {
    id: "aaaaaaaaaaaaaaaaaaaaaaaa",
    symbol: "DOW",
    exchange: "NYSE",
    timeframe: "D1",
    ts: d("2015-06-01"),
    listingId: "DOW:NYSE:2019-03-20",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 1_000,
    divCash: 0,
    splitFactor: 1,
    source: "TIINGO",
    ...over,
  };
}

function tally(over: Partial<EvictTally> = {}): EvictTally {
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
    ...over,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   The two boundaries
   ──────────────────────────────────────────────────────────────────────── */

describe("hotLoadCutoff", () => {
  it("is exactly HOT_LOAD_TTL_DAYS before the injected clock", () => {
    const now = d("2026-08-28");
    assert.equal(
      now.getTime() - hotLoadCutoff(now).getTime(),
      HOT_LOAD_TTL_DAYS * 24 * 60 * 60 * 1000,
    );
  });

  it("a row stamped EXACTLY at the cutoff is NOT due (`lt`, not `lte`)", () => {
    // Strict, so a row read at this instant 30 days ago survives one more run.
    // The direction matters: the guard's whole posture is that keeping a row is
    // cheap and visible while deleting one is unbounded and invisible.
    const now = d("2026-08-28");
    const where = buildEvictWhere("LOADED", now);
    assert.ok("hotLoadedAt" in where);
    assert.equal(
      (where as { hotLoadedAt: { lt: Date } }).hotLoadedAt.lt.getTime(),
      hotLoadCutoff(now).getTime(),
    );
  });
});

describe("windowFloorTs", () => {
  it("is DERIVED from hotWindowFloorYear, not a second copy of the arithmetic", () => {
    // The whole reason it is a function and not `now.getUTCFullYear() - 10`:
    // two spellings of one rule, and on this pair a one-year drift is a year of
    // prices deleted early or retained forever.
    for (const iso of ["2026-08-28", "2027-01-01", "2019-12-31"]) {
      const now = d(iso);
      assert.equal(
        windowFloorTs(now).getTime(),
        Date.UTC(hotWindowFloorYear(now), 0, 1),
        `floor disagrees with core at ${iso}`,
      );
    }
  });

  it("puts 1 January of the floor year INSIDE the window", () => {
    // `lt` against 1 Jan means the floor year itself is kept — the window is
    // inclusive of its oldest year, matching `resolveCandleDestination`'s
    // `barYear >= hotWindowFloorYear(now)`.
    const now = d("2026-08-28");
    assert.equal(windowFloorTs(now).toISOString(), "2016-01-01T00:00:00.000Z");
    assert.equal(hotWindowFloorYear(now), 2016);
  });

  it("rolls on 1 January, and the rollover is testable because the clock is injected", () => {
    assert.equal(
      windowFloorTs(new Date("2026-12-31T23:59:59Z")).toISOString(),
      "2016-01-01T00:00:00.000Z",
    );
    assert.equal(
      windowFloorTs(new Date("2027-01-01T00:00:00Z")).toISOString(),
      "2017-01-01T00:00:00.000Z",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Selection — POSITIVE on tier, always
   ──────────────────────────────────────────────────────────────────────── */

describe("buildEvictWhere", () => {
  it("selects LOADED positively on tier", () => {
    const where = buildEvictWhere("LOADED", d("2026-08-28"));
    assert.equal(where.tier, "LOADED");
  });

  it("selects WINDOW positively on tier, NEVER by testing hotLoadedAt for null", () => {
    // A Mongo `db push` creates indexes and not fields, so on every row
    // predating the column the attribute is ABSENT and BOTH `{null}` and
    // `{not: null}` return ZERO. `{tier: "WINDOW"}` is the only test that
    // works, and `@@index([tier, hotLoadedAt])` exists for exactly it.
    const where = buildEvictWhere("WINDOW", d("2026-08-28"));
    assert.equal(where.tier, "WINDOW");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(where, "hotLoadedAt"),
      "the WINDOW arm must not mention hotLoadedAt at all",
    );
    assert.ok("ts" in where);
  });

  it("the WINDOW arm bounds on ts and the LOADED arm does not", () => {
    // Two rules that disagree about the same row, which is why `tier` exists:
    // "2015 AAPL, outside the window, delete" vs "2015 AAPL, a user is reading
    // it right now, keep".
    const loaded = buildEvictWhere("LOADED", d("2026-08-28"));
    const window = buildEvictWhere("WINDOW", d("2026-08-28"));
    assert.ok(!Object.prototype.hasOwnProperty.call(loaded, "ts"));
    assert.ok(!Object.prototype.hasOwnProperty.call(window, "hotLoadedAt"));
  });
});

describe("buildEvictWhere — WINDOW_INTRADAY (MONEY-1373)", () => {
  const now = d("2026-08-28");

  it("selects the intraday timeframes positively, bounded on ts", () => {
    const where = buildEvictWhere("WINDOW_INTRADAY", now);
    // Same TIER. The intraday rule is not a new tier, it is a second, far
    // tighter boundary over the rows `tier: "WINDOW"` already holds — an M1
    // symbol-year is ~242,000 rows against D1's ~252.
    assert.equal(where.tier, "WINDOW");
    assert.ok("timeframe" in where);
    assert.deepEqual(
      (where as { timeframe: { in: string[] } }).timeframe.in.slice().sort(),
      [...INTRADAY_TIMEFRAMES].sort(),
    );
    assert.deepEqual(
      (where as { ts: { lt: Date } }).ts.lt,
      intradayHotFloorTs(now),
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(where, "hotLoadedAt"),
      "no arm may test hotLoadedAt for null — see the module header",
    );
  });

  it("THE TWO WINDOW RULES SELECT DISJOINT POPULATIONS", () => {
    // THE POINT OF THE `notIn`. The two predicates overlap on their own — a
    // twelve-year-old M1 bar satisfies BOTH `ts < 1 Jan 2016` and
    // `ts < now - 45d`. Both arms archive-then-delete into the same shard key,
    // so the overlap loses no data; what it loses is the MEANING of the two
    // counters. `WINDOW` would report evicting intraday rows and
    // `WINDOW_INTRADAY` would report a smaller backlog than it has, so the one
    // number that says "the daily boundary is keeping up with the minute feed"
    // would be measuring the annual one.
    //
    // MUTATION: drop the `notIn` from the plain WINDOW arm and this goes red.
    const annual = buildEvictWhere("WINDOW", now) as {
      tier: string;
      timeframe: { notIn: string[] };
      ts: { lt: Date };
    };
    const intraday = buildEvictWhere("WINDOW_INTRADAY", now) as {
      tier: string;
      timeframe: { in: string[] };
      ts: { lt: Date };
    };

    assert.equal(annual.tier, intraday.tier, "both are tier WINDOW");
    assert.ok(
      Array.isArray(annual.timeframe.notIn),
      "the plain WINDOW arm must EXCLUDE the intraday timeframes",
    );
    assert.ok(Array.isArray(intraday.timeframe.in));
    // The two timeframe sets are complements of one another over the same list,
    // so no row can satisfy both WHEREs however the ts bounds overlap.
    assert.deepEqual(
      annual.timeframe.notIn.slice().sort(),
      intraday.timeframe.in.slice().sort(),
    );
    for (const tf of intraday.timeframe.in) {
      assert.ok(
        !annual.timeframe.notIn.every((x) => x !== tf),
        `${tf} must be excluded from the annual arm`,
      );
    }
    // And the boundaries genuinely DO overlap, which is why the timeframe split
    // is load-bearing rather than decorative.
    assert.ok(
      intraday.ts.lt.getTime() > annual.ts.lt.getTime(),
      "the intraday floor is far more recent than the year floor",
    );
  });

  it("`notIn` is safe on timeframe and would NOT be on hotLoadedAt", () => {
    // A Mongo `db push` creates indexes and not fields, so on an OPTIONAL
    // column both `{f: null}` and `{f: {not: null}}` return ZERO (MONEY-1050 /
    // 1205 / 1234 / 1236). `Candle.timeframe` is a REQUIRED String with no
    // default — it is present on every row that has ever been written — so a
    // negative test on it cannot reach that trap. Pinned against the schema
    // itself rather than asserted in prose.
    const schema = readFileSync(
      join(WORKERS, "..", "packages", "database", "prisma", "schema.prisma"),
      "utf8",
    );
    assert.match(
      schema,
      /^\s*timeframe\s+String\s/m,
      "Candle.timeframe must stay a REQUIRED String, or the notIn arm is unsafe",
    );
    assert.ok(
      !/^\s*timeframe\s+String\?/m.test(schema),
      "an optional timeframe would make `notIn` match zero rows on legacy rows",
    );
  });
});

describe("evictOrderBy", () => {
  it("leads with the INDEXED key, ascending", () => {
    assert.deepEqual(evictOrderBy("LOADED")[0], { hotLoadedAt: "asc" });
    assert.deepEqual(evictOrderBy("WINDOW")[0], { ts: "asc" });
    // MONEY-1373. `@@index([ts])` backs this for BOTH window rules, and the
    // `skip` accumulator is positional — a rule handed an unordered page pages
    // over rows it never looked at.
    assert.deepEqual(evictOrderBy("WINDOW_INTRADAY")[0], { ts: "asc" });
  });

  it("breaks ties on id, which is what makes the skip accumulator sound", () => {
    // One promotion stamps a whole symbol-year with the SAME instant, so ties
    // are the norm here. A page boundary falling inside a run of equal
    // timestamps has no defined position without a total order — and `skip` is
    // positional.
    for (const rule of EVICT_RULES) {
      assert.deepEqual(evictOrderBy(rule).at(-1), { id: "asc" });
      assert.equal(evictOrderBy(rule).length, 2);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Grouping
   ──────────────────────────────────────────────────────────────────────── */

describe("groupCandidatesByShard", () => {
  it("groups by TICKER-year, with the exchange deliberately OUT of the key", () => {
    // Matching `buildCandleColdKey`: 928 tickers in Tiingo's master trade on
    // more than one exchange and a shard follows the SECURITY. Splitting by
    // exchange here would read the same object twice and, on the WINDOW rule,
    // make two read-modify-writes of one key overwrite each other.
    const { groups } = groupCandidatesByShard([
      candidate({ exchange: "NYSE" }),
      candidate({ exchange: "NASDAQ", id: "b" }),
    ]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.rows.length, 2);
    assert.equal(groups[0]!.symbol, "DOW");
    assert.equal(groups[0]!.year, 2015);
    assert.equal(groups[0]!.market, "US");
  });

  it("splits by YEAR — a shard is a symbol-year", () => {
    const { groups } = groupCandidatesByShard([
      candidate({ ts: d("2015-06-01") }),
      candidate({ ts: d("2016-06-01"), id: "b" }),
    ]);
    assert.equal(groups.length, 2);
  });

  it("separates non-US rows POSITIVELY rather than letting them fall through", () => {
    // `Candle` holds no India rows today, and there are no India shards to
    // verify against — so an India row could only ever be kept. Counting it by
    // NAME is what stops it hiding inside the "shard missing" number, which is
    // the one that should wake somebody.
    const { groups, nonUs } = groupCandidatesByShard([
      candidate({ exchange: "NSE" }),
      candidate({ exchange: "NASDAQ", id: "b" }),
    ]);
    assert.equal(nonUs.length, 1);
    assert.equal(nonUs[0]!.exchange, "NSE");
    assert.equal(groups.length, 1);
  });

  it("refuses a row whose ts is not a real instant", () => {
    // Its year is NaN, so its shard key would be `candles/US/D1/DOW/NaN` — a
    // perfectly valid GCS key no writer has ever used, which would read as
    // `absent` and be indistinguishable from a genuinely missing shard.
    const { groups, nonUs } = groupCandidatesByShard([
      candidate({ ts: new Date("not-a-date") }),
    ]);
    assert.equal(groups.length, 0);
    assert.equal(nonUs.length, 1);
  });

  it("keeps two groups with a SPACE-ambiguous identity apart", () => {
    // `NYSE ARCA` contains a space, so a printable delimiter collides two
    // different tuples onto one group — `candleKey` uses NUL for this reason.
    const { groups } = groupCandidatesByShard([
      candidate({ symbol: "X", timeframe: "D1 X", exchange: "NASDAQ" }),
      candidate({
        symbol: "X D1",
        timeframe: "X",
        exchange: "NASDAQ",
        id: "b",
      }),
    ]);
    assert.equal(groups.length, 2);
  });

  it("carries every price column onto the cold bar it would archive", () => {
    // The WINDOW rule ARCHIVES before it deletes, so a dropped column here is a
    // column the shard does not have and the row cannot be recovered from.
    const bar = toColdBarFromCandidate(
      candidate({ divCash: 0.25, splitFactor: 4 }),
    );
    assert.deepEqual(Object.keys(bar).sort(), [
      "close",
      "divCash",
      "exchange",
      "high",
      "listingId",
      "low",
      "open",
      "source",
      "splitFactor",
      "symbol",
      "timeframe",
      "ts",
      "volume",
    ]);
    assert.equal(bar.divCash, 0.25);
    assert.equal(bar.splitFactor, 4);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   THE GUARD — delete only what the shard demonstrably holds
   ──────────────────────────────────────────────────────────────────────── */

function shardBar(over: Partial<CandleBar> = {}): CandleBar {
  return {
    symbol: "DOW",
    exchange: "NYSE",
    timeframe: "D1",
    ts: d("2015-06-01"),
    listingId: "DOW:NYSE:2019-03-20",
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 1_000,
    divCash: 0,
    splitFactor: 1,
    source: "TIINGO",
    ...over,
  };
}

describe("partitionByShardCoverage", () => {
  it("deletes a row the shard holds", () => {
    const row = candidate();
    const { deletable, notInShard } = partitionByShardCoverage(
      [row],
      [shardBar()],
    );
    assert.equal(deletable.length, 1);
    assert.equal(notInShard.length, 0);
  });

  it("KEEPS a row a PRESENT shard does not hold", () => {
    // "The object exists" is not enough. A shard written before a repair, or
    // truncated by the read-modify-write bug `mergeColdBars` exists to prevent,
    // exists and is missing bars — and a row deleted from Mongo whose bar is
    // not in the shard is GONE.
    const row = candidate({ ts: d("2015-06-02") });
    const { deletable, notInShard } = partitionByShardCoverage(
      [row],
      [shardBar({ ts: d("2015-06-01") })],
    );
    assert.equal(deletable.length, 0);
    assert.equal(notInShard.length, 1);
  });

  it("KEEPS everything when the shard is EMPTY", () => {
    const { deletable, notInShard } = partitionByShardCoverage(
      [candidate()],
      [],
    );
    assert.equal(deletable.length, 0);
    assert.equal(notInShard.length, 1);
  });

  it("discriminates by EXCHANGE inside a ticker-keyed shard", () => {
    // The shard carries every venue the ticker traded on. A NASDAQ row must not
    // be deleted because the NYSE bar for the same date happens to be there —
    // they are different rows under `@@unique([symbol, exchange, timeframe, ts])`.
    const nasdaqRow = candidate({ exchange: "NASDAQ" });
    const { deletable, notInShard } = partitionByShardCoverage(
      [nasdaqRow],
      [shardBar({ exchange: "NYSE" })],
    );
    assert.equal(deletable.length, 0);
    assert.equal(notInShard.length, 1);
  });

  it("discriminates by TIMEFRAME too", () => {
    const { deletable } = partitionByShardCoverage(
      [candidate({ timeframe: "W1" })],
      [shardBar({ timeframe: "D1" })],
    );
    assert.equal(deletable.length, 0);
  });

  it("splits a mixed group instead of taking an all-or-nothing decision", () => {
    const held = candidate({ ts: d("2015-06-01") });
    const missing = candidate({ ts: d("2015-06-02"), id: "b" });
    const { deletable, notInShard } = partitionByShardCoverage(
      [held, missing],
      [shardBar({ ts: d("2015-06-01") })],
    );
    assert.deepEqual(
      deletable.map((r) => r.id),
      ["aaaaaaaaaaaaaaaaaaaaaaaa"],
    );
    assert.deepEqual(
      notInShard.map((r) => r.id),
      ["b"],
    );
  });

  it("every row is accounted for in exactly one bucket", () => {
    const rows = [
      candidate({ ts: d("2015-06-01") }),
      candidate({ ts: d("2015-06-02"), id: "b" }),
      candidate({ ts: d("2015-06-03"), id: "c" }),
    ];
    const { deletable, notInShard } = partitionByShardCoverage(rows, [
      shardBar({ ts: d("2015-06-01") }),
      shardBar({ ts: d("2015-06-03") }),
    ]);
    assert.equal(deletable.length + notInShard.length, rows.length);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The ledger
   ──────────────────────────────────────────────────────────────────────── */

describe("ledgerYearsForDeletions", () => {
  it("collapses a symbol-year to ONE (listingId, year) pair", () => {
    const pairs = ledgerYearsForDeletions([
      candidate({ ts: d("2015-06-01") }),
      candidate({ ts: d("2015-09-01"), id: "b" }),
    ]);
    assert.deepEqual(pairs, [{ listingId: "DOW:NYSE:2019-03-20", year: 2015 }]);
  });

  it("keeps two listings of ONE ticker apart", () => {
    // The recycled-ticker case again: Dow Chemical and Dow Inc. have separate
    // `us_instruments` rows, so clearing one's ledger must not touch the other.
    const pairs = ledgerYearsForDeletions([
      candidate({ listingId: "DOW:NYSE:2019-03-20" }),
      candidate({ listingId: "DOW:NYSE:1972-06-01", id: "b" }),
    ]);
    assert.equal(pairs.length, 2);
  });

  it("DROPS a row with no listingId rather than keying on the empty string", () => {
    // A blank key would `$pull` from whichever `us_instruments` document
    // happened to carry a blank `listingId`.
    assert.deepEqual(
      ledgerYearsForDeletions([candidate({ listingId: "" })]),
      [],
    );
  });

  it("drops an unparseable ts rather than emitting year NaN", () => {
    assert.deepEqual(
      ledgerYearsForDeletions([candidate({ ts: new Date("nope") })]),
      [],
    );
  });
});

describe("yearBounds", () => {
  it("is a half-open UTC year, so 31 December belongs to exactly one side", () => {
    const b = yearBounds(2015);
    assert.equal(b.gte.toISOString(), "2015-01-01T00:00:00.000Z");
    assert.equal(b.lt.toISOString(), "2016-01-01T00:00:00.000Z");
    assert.ok(new Date("2015-12-31T23:59:59.999Z") < b.lt);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Switches
   ──────────────────────────────────────────────────────────────────────── */

describe("the kill switch", () => {
  it('disables ONLY on the literal "off"', () => {
    assert.equal(isEvictionDisabled({ CANDLE_EVICT: "off" }), true);
    assert.equal(isEvictionDisabled({ CANDLE_EVICT: "OFF" }), true);
    assert.equal(isEvictionDisabled({ CANDLE_EVICT: " off " }), true);
  });

  it('does NOT disable on "false", and that is the whole point', () => {
    // `Boolean("false")` is `true`. A truthiness check here would run the job
    // in the one configuration meant to keep it off — and `"off"` is the
    // repo-wide convention (EDGAR_CIK_ENRICH, BSE_MASTER_ENRICH), so inventing
    // a second one would leave an operator guessing which var takes which.
    assert.equal(isEvictionDisabled({ CANDLE_EVICT: "false" }), false);
    assert.equal(isEvictionDisabled({ CANDLE_EVICT: "0" }), false);
    assert.equal(isEvictionDisabled({ CANDLE_EVICT: "on" }), false);
    assert.equal(isEvictionDisabled({}), false);
  });
});

describe("the arming switch", () => {
  it('arms ONLY on the literal "true"', () => {
    assert.equal(isEvictionArmed({ CANDLE_EVICT_APPLY: "true" }), true);
    assert.equal(isEvictionArmed({ CANDLE_EVICT_APPLY: "false" }), false);
    assert.equal(isEvictionArmed({ CANDLE_EVICT_APPLY: "1" }), false);
    assert.equal(isEvictionArmed({ CANDLE_EVICT_APPLY: "TRUE" }), false);
    assert.equal(isEvictionArmed({}), false);
  });

  it('ABSENT and "false" are the same behaviour but must be distinguishable states', () => {
    // Both disarm. They ship PRESENT-and-false so an operator READS the state
    // instead of inferring it — "absent" is exactly how MF_METADATA_PROVIDER
    // disabled its job silently for months (MONEY-1214).
    assert.equal(
      isEvictionArmed({}),
      isEvictionArmed({ CANDLE_EVICT_APPLY: "false" }),
    );
  });

  it("a message can NARROW the arm but can never set it", () => {
    const armed = { CANDLE_EVICT_APPLY: "true" };
    const disarmed = { CANDLE_EVICT_APPLY: "false" };
    assert.equal(resolveEvictApply({ apply: false }, armed), false, "narrows");
    assert.equal(
      resolveEvictApply({ apply: true }, disarmed),
      false,
      "cannot arm",
    );
    assert.equal(resolveEvictApply(undefined, disarmed), false);
    assert.equal(resolveEvictApply(undefined, armed), true);
    assert.equal(resolveEvictApply({}, armed), true);
  });

  it("`msg.apply ?? env` and NOT `msg.apply || env`", () => {
    // The inverse would make publish rights on this topic sufficient to start
    // deleting price history. Arming is a deploy, which is a review.
    assert.equal(resolveEvictApply({ apply: true }, {}), false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Throughput + the chain
   ──────────────────────────────────────────────────────────────────────── */

describe("the run budget", () => {
  it("leaves at least 150s of headroom inside the 600s ack deadline", () => {
    // Overrunning does not make the run slow: Pub/Sub redelivers, a SECOND copy
    // starts on the same page, and two runs race to delete the same rows while
    // both read-modify-write the same GCS object.
    assert.ok(600_000 - RUN_TIME_BUDGET_MS >= 150_000, `${RUN_TIME_BUDGET_MS}`);
  });

  it("is a wall clock with an injected `now`, not a batch size", () => {
    assert.equal(isWithinRunBudget(0, RUN_TIME_BUDGET_MS - 1), true);
    assert.equal(isWithinRunBudget(0, RUN_TIME_BUDGET_MS), false);
    assert.equal(isWithinRunBudget(0, RUN_TIME_BUDGET_MS + 1), false);
  });
});

describe("normalizeChainDepth", () => {
  it("reads anything unusable as 0", () => {
    for (const v of [undefined, null, "3", NaN, Infinity, -1, {}, []]) {
      assert.equal(normalizeChainDepth(v), 0, `${String(v)}`);
    }
  });

  it("CLAMPS a forged large value to the ceiling, so forging it ENDS the chain", () => {
    assert.equal(normalizeChainDepth(1e9), MAX_CHAIN_DEPTH);
    assert.equal(
      nextEvictStep({
        rule: "LOADED",
        skipRows: 0,
        selected: 1_000,
        batchSize: 1_000,
        kept: 0,
        chainDepth: normalizeChainDepth(1e9),
        ruleScoped: false,
      }),
      null,
      "a clamped depth must terminate, never wrap",
    );
  });

  it("floors a fractional depth", () => {
    assert.equal(normalizeChainDepth(3.9), 3);
  });
});

describe("nextEvictStep", () => {
  const base = {
    rule: "LOADED" as const,
    skipRows: 0,
    selected: 1_000,
    batchSize: 1_000,
    kept: 0,
    chainDepth: 0,
    ruleScoped: false,
  };

  it("THE TERMINATION PROOF: refuses once the next depth would reach the ceiling", () => {
    // It consults no database, no clock and no queue, so the bound holds
    // however the population behaves. Every other condition can only stop the
    // chain sooner.
    assert.notEqual(
      nextEvictStep({ ...base, chainDepth: MAX_CHAIN_DEPTH - 2 }),
      null,
    );
    assert.equal(
      nextEvictStep({ ...base, chainDepth: MAX_CHAIN_DEPTH - 1 }),
      null,
    );
    assert.equal(nextEvictStep({ ...base, chainDepth: MAX_CHAIN_DEPTH }), null);
  });

  it("a FULL page continues the same rule with the skip advanced by what it KEPT", () => {
    // The population shrinks as the job works it: a deleted row leaves the set,
    // a kept one does not. So the next unseen row is at exactly skip + kept.
    assert.deepEqual(nextEvictStep({ ...base, skipRows: 40, kept: 7 }), {
      rule: "LOADED",
      skipRows: 47,
    });
  });

  it("a page that deleted EVERYTHING does not advance the skip", () => {
    assert.deepEqual(nextEvictStep({ ...base, skipRows: 40, kept: 0 }), {
      rule: "LOADED",
      skipRows: 40,
    });
  });

  it("a page it could delete NOTHING from still advances past it", () => {
    // THIS is the MONEY-1211 / MONEY-1255 guard. Without the accumulator, a
    // block of `batchSize` rows whose shard is missing would be re-selected
    // every run, delete nothing, and starve everything behind them forever —
    // no error, no alert, no data.
    assert.deepEqual(nextEvictStep({ ...base, skipRows: 0, kept: 1_000 }), {
      rule: "LOADED",
      skipRows: 1_000,
    });
  });

  it("a SHORT page moves to the next rule with a fresh skip", () => {
    assert.deepEqual(
      nextEvictStep({ ...base, selected: 3, skipRows: 900, kept: 3 }),
      { rule: "WINDOW", skipRows: 0 },
    );
  });

  it("a short page moves WINDOW on to WINDOW_INTRADAY", () => {
    // MONEY-1373. This case used to read "a short page on the LAST rule ends
    // the chain" and asserted `null` — correct while WINDOW *was* last. Left
    // unchanged it would have gone green again the moment somebody dropped the
    // intraday rule back off the end of EVICT_RULES.
    assert.deepEqual(
      nextEvictStep({ ...base, rule: "WINDOW", selected: 0, kept: 0 }),
      { rule: "WINDOW_INTRADAY", skipRows: 0 },
    );
  });

  it("a short page on the LAST rule ends the chain", () => {
    assert.equal(
      nextEvictStep({
        ...base,
        rule: "WINDOW_INTRADAY",
        selected: 0,
        kept: 0,
      }),
      null,
    );
  });

  it("a rule-SCOPED run never advances to the other rule", () => {
    assert.equal(
      nextEvictStep({ ...base, selected: 0, ruleScoped: true }),
      null,
    );
  });

  it("a scoped run still pages through its OWN rule", () => {
    assert.deepEqual(nextEvictStep({ ...base, ruleScoped: true, kept: 5 }), {
      rule: "LOADED",
      skipRows: 5,
    });
  });

  it("a degenerate batch cannot page", () => {
    assert.equal(nextEvictStep({ ...base, batchSize: 0, selected: 0 }), null);
  });

  it("a rule with a FULL page still hands over once it has spent its depth band", () => {
    // The starvation guard, at the boundary. LOADED owns depths [0, 6) at
    // MAX_CHAIN_DEPTH 20 / 3 rules, so depth 4 continues LOADED and depth 5
    // hands the chain to WINDOW even though the page came back completely
    // full. MUTATION: drop the `bandSpent` branch from `nextEvictStep` and the
    // second assertion returns {rule: "LOADED"} — which is the shipped bug.
    assert.deepEqual(
      nextEvictStep({ ...base, chainDepth: 4, skipRows: 40, kept: 7 }),
      { rule: "LOADED", skipRows: 47 },
    );
    assert.deepEqual(
      nextEvictStep({ ...base, chainDepth: 5, skipRows: 40, kept: 7 }),
      { rule: "WINDOW", skipRows: 0 },
    );
  });

  it("the LAST rule keeps every link to the ceiling — no band strands a remainder", () => {
    // WINDOW_INTRADAY has nobody to hand to, so the two links left over by
    // `floor(20 / 3) = 6` must not end its chain early. That remainder is not
    // hypothetical any more (MONEY-1373): an even 6/12/18 split would leave
    // depths 18-19 belonging to no rule at all, on the rule with the largest
    // and fastest-growing population.
    assert.equal(ruleDepthBandEnd("LOADED"), 6);
    assert.equal(ruleDepthBandEnd("WINDOW"), 12);
    assert.equal(ruleDepthBandEnd("WINDOW_INTRADAY"), MAX_CHAIN_DEPTH);
    assert.deepEqual(
      nextEvictStep({
        ...base,
        rule: "WINDOW_INTRADAY",
        chainDepth: 15,
        kept: 3,
      }),
      { rule: "WINDOW_INTRADAY", skipRows: 3 },
    );
  });

  it("the bands COVER the whole depth budget at shapes today's constants hide", () => {
    // At 20/2 an even split and "the last rule owns the ceiling" give the same
    // answer for WINDOW, so the two assertions above cannot tell a correct
    // implementation from one that strands the remainder. `depthBandEnd` takes
    // the constants as arguments precisely so this can be checked.
    //
    // MUTATION: drop the `index >= ruleCount - 1` clause and the last band ends
    // at 18, so depths 18-19 belong to no rule at all.
    assert.deepEqual(
      [0, 1, 2].map((i) => depthBandEnd(i, 3, 20)),
      [6, 12, 20],
    );
    // Bands are contiguous and non-empty for every shape we could grow into.
    for (const count of [1, 2, 3, 4, 7]) {
      for (const max of [7, 20, 21]) {
        const ends = Array.from({ length: count }, (_, i) =>
          depthBandEnd(i, count, max),
        );
        assert.equal(ends[count - 1], max, `last band ${count}/${max}`);
        for (let i = 1; i < count; i++) {
          assert.ok(
            ends[i]! >= ends[i - 1]!,
            `band ${i} of ${count}/${max} runs backwards`,
          );
        }
      }
    }
  });

  it("a SCOPED run is never handed over — the operator asked for one rule", () => {
    assert.deepEqual(
      nextEvictStep({ ...base, chainDepth: 9, ruleScoped: true, kept: 4 }),
      { rule: "LOADED", skipRows: 4 },
    );
  });

  it("terminates within MAX_CHAIN_DEPTH links even on an endless population", () => {
    // The property, run rather than asserted: a page that is always full and
    // always keeps everything is the worst case, and it still stops.
    let depth = 0;
    let links = 0;
    let step: ReturnType<typeof nextEvictStep> = {
      rule: "LOADED",
      skipRows: 0,
    };
    while (step !== null && links < 1_000) {
      links++;
      step = nextEvictStep({
        rule: step.rule,
        skipRows: step.skipRows,
        selected: 1_000,
        batchSize: 1_000,
        kept: 1_000,
        chainDepth: depth,
        ruleScoped: false,
      });
      depth++;
    }
    assert.ok(links <= MAX_CHAIN_DEPTH, `ran ${links} links`);
  });

  it("EVERY RULE RUNS on a night when the first rule NEVER drains", () => {
    // THE BUG THIS FILE EXISTED TO CATCH AND DID NOT.
    //
    // The old version of the test above asserted only `links <= 20` — it drove
    // exactly this population, watched WINDOW never appear, and passed. With
    // EVICT_RULES = [LOADED, WINDOW] and >= 1,000 LOADED rows due, the chain
    // walked LOADED for every link and the WINDOW rule — the one that bounds
    // `candles` at year rollover, and the ONLY one that archives before it
    // deletes — ran ZERO times, every night, for as long as the backlog
    // lasted. `judgeEvictRun` returned ok throughout, because LOADED deleted
    // rows.
    //
    // Driven the way `chainNext` drives it: the message the chain publishes,
    // fed back through `resolveRuleScope` exactly as the processor reads it.
    const visited: string[] = [];
    let msg: { rule?: string; ruleScoped?: boolean; chainDepth?: number } = {};
    let skipRows = 0;

    for (let link = 0; link < MAX_CHAIN_DEPTH + 5; link++) {
      const { rule, ruleScoped } = resolveRuleScope(msg);
      visited.push(rule);
      const step = nextEvictStep({
        rule,
        skipRows,
        // A page that is always FULL and from which nothing can be deleted:
        // the worst case for both starvation and the skip accumulator.
        selected: 1_000,
        batchSize: 1_000,
        kept: 1_000,
        chainDepth: msg.chainDepth ?? 0,
        ruleScoped,
      });
      if (step === null) break;
      msg = {
        rule: step.rule,
        ruleScoped,
        chainDepth: (msg.chainDepth ?? 0) + 1,
      };
      skipRows = step.skipRows;
    }

    for (const rule of EVICT_RULES) {
      assert.ok(
        visited.includes(rule),
        `rule ${rule} never ran in one night's chain: ${visited.join(" -> ")}`,
      );
    }
    assert.ok(visited.length <= MAX_CHAIN_DEPTH, `ran ${visited.length} links`);
  });

  it("an OPERATOR-scoped chain still refuses to touch the other rule", () => {
    // The behaviour the scope flag protects, driven through the same loop. A
    // hand-published {"rule":"LOADED"} must page LOADED and stop — never reach
    // WINDOW — however long it runs.
    const visited: string[] = [];
    let msg: { rule?: string; ruleScoped?: boolean; chainDepth?: number } = {
      rule: "LOADED",
    };
    let skipRows = 0;

    for (let link = 0; link < MAX_CHAIN_DEPTH + 5; link++) {
      const { rule, ruleScoped } = resolveRuleScope(msg);
      visited.push(rule);
      assert.equal(ruleScoped, true, `link ${link} lost the operator's scope`);
      const step = nextEvictStep({
        rule,
        skipRows,
        selected: 1_000,
        batchSize: 1_000,
        kept: 1_000,
        chainDepth: msg.chainDepth ?? 0,
        ruleScoped,
      });
      if (step === null) break;
      msg = {
        rule: step.rule,
        ruleScoped,
        chainDepth: (msg.chainDepth ?? 0) + 1,
      };
      skipRows = step.skipRows;
    }

    assert.ok(
      !visited.includes("WINDOW"),
      `a scoped LOADED chain reached WINDOW: ${visited.join(" -> ")}`,
    );
  });
});

describe("resolveRuleScope", () => {
  it("a scheduler trigger is the FIRST rule, UNSCOPED", () => {
    assert.deepEqual(resolveRuleScope({}), {
      rule: "LOADED",
      ruleScoped: false,
    });
    assert.deepEqual(resolveRuleScope(undefined), {
      rule: "LOADED",
      ruleScoped: false,
    });
  });

  it("an OPERATOR naming a rule is SCOPED", () => {
    assert.deepEqual(resolveRuleScope({ rule: "WINDOW" }), {
      rule: "WINDOW",
      ruleScoped: true,
    });
  });

  it("a CHAINED link carries the same rule and is NOT scoped", () => {
    // The whole defect in one assertion: this message and the one above are
    // indistinguishable on `rule` alone, and reading the scope off `rule`'s
    // presence made every link past the first look operator-scoped.
    assert.deepEqual(resolveRuleScope({ rule: "WINDOW", ruleScoped: false }), {
      rule: "WINDOW",
      ruleScoped: false,
    });
  });

  it("`ruleScoped` is only ever honoured ALONGSIDE a rule", () => {
    // Forging it introduces no state the field could not already produce: with
    // nothing named there is nothing to scope.
    assert.deepEqual(resolveRuleScope({ ruleScoped: true }), {
      rule: "LOADED",
      ruleScoped: false,
    });
  });

  it("a junk rule falls back to the first rule, unscoped", () => {
    for (const rule of ["loaded", "", 7, null, {}]) {
      assert.deepEqual(
        resolveRuleScope({ rule }),
        { rule: "LOADED", ruleScoped: false },
        `${String(rule)}`,
      );
    }
  });
});

describe("chainKeptBeforeUnexamined", () => {
  const row = (id: string): EvictCandidate => candidate({ id });

  it("with nothing skipped it is exactly `page - deleted`", () => {
    const page = [row("a"), row("b"), row("c")];
    assert.equal(chainKeptBeforeUnexamined(page, new Set(), new Set(["a"])), 2);
  });

  it("STOPS AT THE FIRST UNEXAMINED ROW, even when later rows were kept", () => {
    // THE DEFECT. Page order is [a, b, c]; the run iterates by SHARD GROUP, so
    // it examined group {a, c} and never reached {b}. `examined - deleted` is
    // 2, which advances the skip past `b` — a row nobody looked at — and
    // strands it for the rest of the chain.
    //
    // MUTATION: return `pageRows.length - deletedIds.size` and this is 2.
    assert.equal(
      chainKeptBeforeUnexamined(
        [row("a"), row("b"), row("c")],
        new Set(["b"]),
        new Set(),
      ),
      1,
    );
  });

  it("counts deletions BEFORE the break, because those rows really left the set", () => {
    // [a, b, c]: `a` deleted, `b` never examined, `c` examined and kept. The
    // prefix before the break is [a] alone and `a` is gone, so the skip does
    // not move — which is right: the population shrank by one, so the first
    // unseen row `b` now sits at exactly the same absolute position.
    assert.equal(
      chainKeptBeforeUnexamined(
        [row("a"), row("b"), row("c")],
        new Set(["b"]),
        new Set(["a"]),
      ),
      0,
    );
  });

  it("a page where the FIRST row was never examined does not advance at all", () => {
    assert.equal(
      chainKeptBeforeUnexamined(
        [row("a"), row("b")],
        new Set(["a", "b"]),
        new Set(),
      ),
      0,
    );
  });

  it("never exceeds `examined - deleted`, so it can only re-examine work", () => {
    // The safety direction, stated as a property over every skip pattern.
    // Re-examining a kept row is idempotent; stepping over an unexamined one is
    // permanent for the rest of the chain.
    //
    // `deleted` is derived from `skipped` rather than fixed, because a row the
    // run never examined cannot have been deleted by it — a fixture that says
    // otherwise tests a state the processor cannot produce.
    const page = [row("a"), row("b"), row("c"), row("d")];
    for (const skipped of [
      new Set<string>(),
      new Set(["d"]),
      new Set(["b", "d"]),
      new Set(["a"]),
      new Set(["a", "b", "c", "d"]),
    ]) {
      const deleted = new Set(
        page
          .filter((r) => !skipped.has(r.id))
          .map((r) => r.id)
          .slice(0, 1),
      );
      const examined = page.filter((r) => !skipped.has(r.id)).length;
      assert.ok(
        chainKeptBeforeUnexamined(page, skipped, deleted) <=
          examined - deleted.size,
        `skipped=${[...skipped].join(",")}`,
      );
    }
  });
});

describe("message normalisation", () => {
  it("clampBatchSize falls back rather than paging zero rows forever", () => {
    for (const v of [undefined, null, "500", 0, -1, NaN, {}]) {
      assert.equal(clampBatchSize(v), DEFAULT_EVICT_BATCH_SIZE, `${String(v)}`);
    }
    assert.equal(clampBatchSize(50), 50);
    assert.equal(clampBatchSize(1e9), 10_000, "capped");
  });

  it("normalizeSkipRows refuses a negative, which would re-select the head", () => {
    assert.equal(normalizeSkipRows(-5), 0);
    assert.equal(normalizeSkipRows(NaN), 0);
    assert.equal(normalizeSkipRows("7"), 0);
    assert.equal(normalizeSkipRows(7.9), 7);
  });

  it("normalizeRule accepts only the two real rules", () => {
    assert.equal(normalizeRule("LOADED"), "LOADED");
    assert.equal(normalizeRule("WINDOW"), "WINDOW");
    assert.equal(normalizeRule("loaded"), null);
    assert.equal(normalizeRule("COLD"), null);
    assert.equal(normalizeRule(undefined), null);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Counters + verdict
   ──────────────────────────────────────────────────────────────────────── */

describe("evictTallyBalances", () => {
  it("closes when every examined row landed in exactly one bucket", () => {
    assert.equal(
      evictTallyBalances(
        tally({
          selected: 10,
          examined: 8,
          deleted: 5,
          keptNoShard: 3,
          budgetSkipped: 2,
        }),
      ),
      true,
    );
  });

  it("fails when a row was counted twice", () => {
    assert.equal(
      evictTallyBalances(
        tally({ selected: 10, examined: 10, deleted: 5, keptNoShard: 6 }),
      ),
      false,
    );
  });

  it("fails when a selected row was neither examined nor budget-skipped", () => {
    // The bucket that would otherwise absorb a row silently. An untrustworthy
    // zero reads as healthy, which is the whole failure class this job's
    // counters exist to make visible.
    assert.equal(
      evictTallyBalances(tally({ selected: 10, examined: 5, deleted: 5 })),
      false,
    );
  });

  it("a FAILED deleteMany chunk still BALANCES", () => {
    // It used not to. `deleteFailures` was outside the sum, so a rejected chunk
    // printed "TALLY DOES NOT BALANCE ... the counters cannot be relied on" on
    // top of the real error — a balance check that cries on runs it has nothing
    // to say about is a balance check nobody reads.
    //
    // MUTATION: drop `t.deleteFailures` from `accounted` and this is false.
    assert.equal(
      evictTallyBalances(
        tally({ selected: 10, examined: 10, deleted: 7, deleteFailures: 3 }),
      ),
      true,
    );
  });

  it("a CONCURRENTLY-REMOVED row balances, with NO exception behind it", () => {
    // The stronger half: `tally.deleted += res.count` means a row somebody else
    // deleted first produces the same imbalance and nothing throws at all. All
    // three of this suite's original fixtures carried `deleteFailures: 0`, so
    // neither shape had a test.
    //
    // MUTATION: drop `t.deleteVanished` from `accounted` and this is false.
    assert.equal(
      evictTallyBalances(
        tally({ selected: 10, examined: 10, deleted: 8, deleteVanished: 2 }),
      ),
      true,
    );
  });

  it("still fails when the delete buckets DOUBLE-count a row", () => {
    // Adding two buckets must not make the predicate unfalsifiable.
    assert.equal(
      evictTallyBalances(
        tally({
          selected: 10,
          examined: 10,
          deleted: 8,
          deleteVanished: 2,
          deleteFailures: 1,
        }),
      ),
      false,
    );
  });
});

describe("judgeEvictRun", () => {
  const ok = {
    tally: tally(),
    disabled: false,
    armed: true,
    coldStoreRegistered: true,
  };

  it("a disabled run is HEALTHY and says so", () => {
    const v = judgeEvictRun({ ...ok, disabled: true });
    assert.equal(v.ok, true);
    assert.match(v.reason ?? "", /CANDLE_EVICT=off/);
  });

  it("NO COLD STORE is UNHEALTHY, not idle", () => {
    // Without one every shard read answers `absent`, the guard refuses every
    // row and the job can never delete anything. A job that cannot do its work
    // must not report a clean run.
    const v = judgeEvictRun({ ...ok, coldStoreRegistered: false });
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /no cold store registered/);
  });

  it("a DRY RUN is healthy and carries the would-have-deleted count", () => {
    const v = judgeEvictRun({
      ...ok,
      armed: false,
      tally: tally({ selected: 40, examined: 40, keptNotArmed: 40 }),
    });
    assert.equal(v.ok, true);
    assert.match(v.reason ?? "", /DRY RUN — 40 row\(s\)/);
  });

  it("a MISSING shard is unhealthy — the two stores disagree", () => {
    // Not a failed run: the rows are safe, which is the point. But it never
    // fixes itself and it blocks the drain, so it must not read as green.
    const v = judgeEvictRun({
      ...ok,
      tally: tally({ selected: 5, examined: 5, keptNoShard: 5 }),
    });
    assert.equal(v.ok, false);
    assert.match(v.reason ?? "", /no cold shard/);
  });

  it("a shard READ failure is healthy-but-named — absence is not failure", () => {
    const v = judgeEvictRun({
      ...ok,
      tally: tally({
        selected: 5,
        examined: 5,
        keptShardUnreadable: 5,
        shardReadFailures: 1,
      }),
    });
    assert.equal(v.ok, true);
    assert.match(v.reason ?? "", /shard read\(s\) failed/);
  });

  it("an empty population is healthy and NAMED, never a bare silent zero", () => {
    const v = judgeEvictRun(ok);
    assert.equal(v.ok, true);
    assert.match(v.reason ?? "", /nothing due for eviction/);
  });

  it("a real deletion run carries no reason at all", () => {
    const v = judgeEvictRun({
      ...ok,
      tally: tally({ selected: 10, examined: 10, deleted: 10 }),
    });
    assert.deepEqual(v, { ok: true });
  });

  it("names the DISARM before anything downstream of it", () => {
    // A dry run keeps every row, so it would otherwise trip the "missing shard"
    // branch and report a false disagreement. Ordering is the fix.
    const v = judgeEvictRun({
      ...ok,
      armed: false,
      tally: tally({
        selected: 5,
        examined: 5,
        keptNotArmed: 5,
        keptNoShard: 0,
      }),
    });
    assert.match(v.reason ?? "", /not-armed/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   SOURCE SCAN — the ORDERING, which is what separates eviction from data loss
   ──────────────────────────────────────────────────────────────────────── */

describe("candle-evict.ts orders its I/O safely", () => {
  it("ARCHIVES a WINDOW group BEFORE it reads the shard back to verify", () => {
    // WINDOW rows have never been archived — Mongo is the only copy — so a rule
    // that merely deleted them would destroy a year of prices for every symbol,
    // once a year, silently.
    const archive = PROCESSOR_CODE.indexOf('rule === "WINDOW"');
    // `readColdShardUncached`, not `readColdShard` — MONEY-1373 switched EVERY
    // eviction read, the D1 path included. Naming the old symbol here would
    // have made this scan read nothing and pass forever.
    const readBack = PROCESSOR_CODE.indexOf("await readColdShardUncached({");
    assert.ok(archive > 0 && readBack > 0, "both call sites present");
    assert.ok(archive < readBack, "archive must precede the verifying read");
  });

  it("never deletes without going through the containment guard first", () => {
    const guard = PROCESSOR_CODE.indexOf("partitionByShardCoverage(");
    const del = PROCESSOR_CODE.indexOf("await deleteRows(");
    assert.ok(guard > 0 && del > 0);
    assert.ok(guard < del, "the guard must precede the delete");
  });

  it("the ONLY deleteMany is inside deleteRows, keyed by _id", () => {
    const deletes = PROCESSOR_CODE.match(/prisma\.candle\.deleteMany\(/g) ?? [];
    assert.equal(
      deletes.length,
      1,
      "one delete site, and it is the guarded one",
    );
    assert.match(PROCESSOR_CODE, /where: \{ id: \{ in: slice\.map/);
  });

  it("counts deletions from the DRIVER's answer, after the call", () => {
    // Reporting the ask instead of the answer is the shape that hid a
    // five-month outage (MONEY-1220), and here it would claim rows were removed
    // that a concurrent writer had already taken.
    // `tally[into]` since MONEY-1373 — the leaf deletes two populations
    // through this one function and they need separate counters. The property
    // under test is unchanged: the number comes from `res.count`, after the
    // call, never from the size of what was asked for.
    assert.match(PROCESSOR_CODE, /tally\[into\] \+= res\.count/);
    assert.ok(
      !/tally\[?(\.deleted|into\])\]? \+= slice\.length/.test(PROCESSOR_CODE),
      "the count must never come from the batch size",
    );
  });

  it("a failed archive KEEPS the group instead of falling through to the delete", () => {
    assert.match(
      PROCESSOR_CODE,
      /const archived = await archiveGroup\(group, tally\);\s*if \(!archived\) continue;/,
    );
  });

  it("distinguishes a FAILED shard read from an ABSENT one", () => {
    // Collapsing them is this repo's most expensive recurring bug, and on the
    // DELETE side it decides whether a GCS outage reads as "there is no shard".
    assert.match(PROCESSOR_CODE, /outcome\.status === "failed"/);
    assert.match(PROCESSOR_CODE, /outcome\.status === "absent"/);
    assert.match(PROCESSOR_CODE, /tally\.shardReadFailures\+\+/);
    assert.match(PROCESSOR_CODE, /tally\.keptNoShard \+=/);
  });

  it("the ledger COUNTS what remains before it pulls a year", () => {
    // A page can cut a symbol-year in half. Clearing on "we deleted some 2015
    // rows" would leave the ledger claiming a year is cold while half of it is
    // still hot — a completeness claim at the wrong granularity (MONEY-1189).
    const body = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("async function clearLedgerYears"),
    );
    const count = body.indexOf("prisma.candle.count(");
    const pull = body.indexOf("$pull");
    assert.ok(count > 0 && pull > 0);
    assert.ok(count < pull, "count first, then pull");
    assert.match(body, /if \(remaining > 0\) continue;/);
    assert.match(
      body,
      /tier: "LOADED"/,
      "the remaining-rows count is tier-positive",
    );
  });

  it("only the LOADED rule touches the ledger", () => {
    // `hotLoadedYears` records hot LOADS. A WINDOW row was never loaded.
    assert.match(PROCESSOR_CODE, /rule === "LOADED" && deleted\.length > 0/);
  });

  it("the run budget is checked BETWEEN shard groups, never inside one", () => {
    const body = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("for (let i = 0; i < groups.length; i++)"),
      PROCESSOR_CODE.indexOf("await deleteRows(coverage.deletable"),
    );
    assert.match(
      body,
      /isWithinRunBudget\(startedAt, Date\.now\(\), RUN_TIME_BUDGET_MS\)/,
    );
    assert.match(body, /tally\.budgetSkipped \+=/);
  });

  it("a dry run still VERIFIES, and its count is NOT `deleted`", () => {
    assert.match(
      PROCESSOR_CODE,
      /if \(!applied\) \{\s*tally\.keptNotArmed \+=/,
    );
  });

  it("reports the outcome with the deletion count as `written`, at EVERY exit", () => {
    // A deleting job's "written" is what it REMOVED. Pairing `selected` with
    // anything else breaks `reportJobOutcome`'s one real signal — found work,
    // produced nothing — and the count has to be right on the throw path too,
    // which is the exit an operator is most likely to be reading.
    const emits = [
      ...PROCESSOR_CODE.matchAll(/reportJobOutcome\(\{[\s\S]*?\}\);/g),
    ].map((m) => m[0]);
    // 3 paged (early-skip, success, catch) + 2 planner + 2 leaf — MONEY-1373.
    assert.equal(emits.length, 7, "every exit of all three shapes reports");
    for (const emit of emits) {
      assert.match(emit, /job: "candle-evict"/);
      assert.match(
        emit,
        // The PLANNER's `written` is messages published — it deletes nothing,
        // and reporting a deletion count it never computed would be a lie in
        // the one field the alarm reads. The LEAF adds `deletedOutranked`,
        // because a leaf whose only work was closing an outranked-row hole did
        // real work and must not trip `selected > 0 && written === 0`.
        /written: (tally\.deleted \+ tally\.deletedOutranked|tally\.deleted|published|0)/,
        "written must be what the run REMOVED or PUBLISHED, never the ask",
      );
      assert.ok(
        !/written: (tally\.selected|units\.length)/.test(emit),
        "the ASK is not the ANSWER",
      );
    }
    // The four post-query emits carry the shard-read failures, which are CALLS
    // rather than rows and must not be folded into `failed`.
    assert.equal(
      (
        PROCESSOR_CODE.match(/transportFailures: tally\.shardReadFailures/g) ??
        []
      ).length,
      4,
    );
  });

  it("reads the rule's SCOPE from resolveRuleScope, never from the rule's presence", () => {
    // THE WINDOW-STARVATION BUG, pinned at its source. `scopedRule !== null`
    // was true for every chained link, because the chain stamps `rule` on all
    // of them.
    assert.match(
      PROCESSOR_CODE,
      /const \{ rule, ruleScoped \} = resolveRuleScope\(msg\);/,
    );
    assert.ok(
      !/ruleScoped:\s*\w+Rule !== null/.test(PROCESSOR_CODE),
      "the scope must not be re-derived from whether a rule was named",
    );
  });

  it("the chained message CARRIES the scope forward", () => {
    // Without it the next link re-derives `true` from its own `rule` and the
    // chain can never reach the second rule.
    const chainMsg = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("const next: CandleEvictMessage = {"),
      PROCESSOR_CODE.indexOf("await topic.publishMessage("),
    );
    assert.match(chainMsg, /rule: step\.rule/);
    assert.match(chainMsg, /chainDepth: chainDepth \+ 1/);
    assert.match(chainMsg, /\bruleScoped,/);
  });

  it("the ROUTE narrows `ruleScoped` as a real boolean, never a spread", () => {
    // A field declared on the message type and forwarded by NOBODY is silently
    // inert — that is exactly what happened to `createMissing` (MONEY-1235),
    // and here the inert value is the one that keeps the chain moving.
    assert.match(
      ROUTE_CODE,
      /typeof raw\.ruleScoped === "boolean"\s*\?\s*\{ ruleScoped: raw\.ruleScoped \}/,
    );
    assert.ok(
      !/\.\.\.raw\b/.test(ROUTE_CODE),
      "every field is read and narrowed, never spread",
    );
  });

  it("the chain's `kept` comes from chainKeptBeforeUnexamined, not from the tally", () => {
    // `examined - deleted` counts kept rows that sort AFTER the first row the
    // budget cut off, and `skip + kept` then lands past rows nobody examined.
    const chainCall = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("chained = await chainNext({"),
      PROCESSOR_CODE.indexOf("if (!verdict.ok) log.error"),
    );
    assert.match(chainCall, /kept: chainKeptBeforeUnexamined\(/);
    assert.ok(
      !/kept: tally\.examined - tally\.deleted/.test(PROCESSOR_CODE),
      "the whole-page figure steps over unexamined rows",
    );
    // And the ids it needs are actually collected where the budget breaks.
    assert.match(PROCESSOR_CODE, /unexaminedIds\.add\(row\.id\)/);
  });

  it("counts the gap between the ask and the DRIVER's answer", () => {
    // `res.count < slice.length` is a concurrent removal, not an error. Left
    // uncounted it balanced nowhere and printed as a broken tally.
    assert.match(
      PROCESSOR_CODE,
      /tally\.deleteVanished \+= Math\.max\(0, slice\.length - res\.count\)/,
    );
  });

  it("only rows from a chunk that did NOT throw count as deleted", () => {
    // A multi-chunk delete whose second chunk was rejected leaves those rows in
    // Mongo. Calling them deleted mis-positions the chain AND hands the ledger
    // a year it must not clear.
    assert.match(
      PROCESSOR_CODE,
      /deleted\.push\(\.\.\.\(await deleteRows\(coverage\.deletable, tally\)\)\)/,
    );
    assert.ok(
      !/deleted\.push\(\.\.\.coverage\.deletable\)/.test(PROCESSOR_CODE),
      "the ask is not the answer on the delete side either",
    );
  });

  it("the LEDGER pass is bounded by its OWN wall, checked between pairs", () => {
    // It runs AFTER the group loop has spent RUN_TIME_BUDGET_MS, so sharing
    // that budget would read "already over" on exactly the runs that need
    // bounding — and it costs TWO round trips per distinct (listingId, year),
    // up to `batchSize` of them, against a headroom line that costed the whole
    // pass at "~2s".
    const body = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("async function clearLedgerYears"),
    );
    assert.match(
      body,
      /const deadlineMs = RUN_TIME_BUDGET_MS \+ LEDGER_BUDGET_MS;/,
    );
    assert.match(
      body,
      /isWithinRunBudget\(startedAt, Date\.now\(\), deadlineMs\)/,
    );
    // The check must come BEFORE the two round trips, or it does not bound them.
    const check = body.indexOf("isWithinRunBudget(");
    const count = body.indexOf("prisma.candle.count(");
    assert.ok(check > 0 && count > 0 && check < count, "check, then query");
    // And what it did not reach is REPORTED, not swallowed.
    assert.match(body, /return \{ cleared, skipped \};/);
    assert.match(PROCESSOR_CODE, /ledgerYearsSkipped = ledger\.skipped/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   MONEY-1373 — WINDOW_INTRADAY: the planner, the leaf, and the five
   inequalities that make the fan-out's sizing falsifiable
   ──────────────────────────────────────────────────────────────────────── */

/** An intraday candidate. The base helper is D1/NYSE, which is the other rule. */
function intraday(over: Partial<EvictCandidate> = {}): EvictCandidate {
  return candidate({
    symbol: "AAPL",
    exchange: "NASDAQ",
    timeframe: "M1",
    ts: new Date("2026-07-01T14:31:00Z"),
    listingId: "AAPL:NASDAQ:1980-12-12",
    source: "TIINGO_RT",
    ...over,
  });
}

/** A cold bar. Same shape as `toColdBarFromCandidate` produces. */
function coldBar(over: Partial<CandleBar> = {}): CandleBar {
  return {
    symbol: "AAPL",
    exchange: "NASDAQ",
    timeframe: "M1",
    ts: new Date("2026-07-01T14:31:00Z"),
    listingId: "AAPL:NASDAQ:1980-12-12",
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 100,
    divCash: 0,
    splitFactor: 1,
    source: "TIINGO_RT",
    ...over,
  };
}

describe("intradaySessionCutoff — WHOLE SESSIONS, in ET", () => {
  it("snaps the 45-day floor DOWN to the start of the session containing it", () => {
    // A raw `now - 45d` lands mid-session, which would put a session's morning
    // in a cold shard and its afternoon in Mongo — and every authority question
    // about that (symbol, timeframe, session) then has two answers depending on
    // time of day.
    const now = new Date("2026-08-15T18:00:00Z");
    const floor = intradayHotFloorTs(now);
    const cutoff = intradaySessionCutoff(now);
    assert.ok(
      cutoff.getTime() <= floor.getTime(),
      "never evicts past the floor",
    );
    assert.equal(usMarketDateKey(cutoff), usMarketDateKey(floor));
    assert.equal(
      cutoff.getTime(),
      usMarketDayBoundsUtc(usMarketDateKey(floor)).startMs,
    );
  });

  it("is the ET day start on a 25-HOUR DST day, not a 24h subtraction", () => {
    // 2026-11-01 is the first Sunday in November — fall back, 02:00 EDT ->
    // 01:00 EST — so the ET day is 25 hours long. ET midnight is still EDT
    // (UTC-4), which puts the boundary at 04:00Z; a UTC-anchored or
    // 86,400,000-based cutoff lands an hour out and takes an extra hour of a
    // neighbouring session with it.
    const now = new Date("2026-12-16T18:00:00Z"); // -45d = 2026-11-01T18:00Z
    assert.equal(usMarketDateKey(intradayHotFloorTs(now)), "2026-11-01");
    assert.equal(
      intradaySessionCutoff(now).toISOString(),
      "2026-11-01T04:00:00.000Z",
    );
    const b = usMarketDayBoundsUtc("2026-11-01");
    assert.equal(b.endMs - b.startMs, 25 * 60 * 60 * 1000);
  });

  it("the planner and the leaf read the SAME cutoff", () => {
    // A leaf that recomputed a floor of its own would drift from the plan by
    // however long the fan-out took, and on the boundary session that
    // difference is exactly the half-session split this function prevents.
    const now = new Date("2026-08-15T18:00:00Z");
    const plan = buildIntradayPlanPipeline(now)[0]!.$match as {
      ts: { $lt: { $date: string } };
    };
    const leaf = buildIntradayUnitWhere(
      { symbol: "AAPL", timeframe: "M1" },
      now,
    );
    assert.equal(plan.ts.$lt.$date, intradaySessionCutoff(now).toISOString());
    assert.equal(leaf.ts.lt.getTime(), intradaySessionCutoff(now).getTime());
  });
});

describe("buildIntradayPlanPipeline", () => {
  it("selects POSITIVELY on tier and only the intraday timeframes", () => {
    const match = buildIntradayPlanPipeline(d("2026-08-15"))[0]!.$match as {
      tier: string;
      timeframe: { $in: string[] };
    };
    assert.equal(match.tier, "WINDOW");
    assert.deepEqual(
      [...match.timeframe.$in].sort(),
      [...INTRADAY_TIMEFRAMES].sort(),
    );
  });

  it("spells the date as Extended JSON, never a bare Date or a number", () => {
    // `$runCommandRaw` serialises through Extended JSON RELAXED mode. A raw
    // millisecond number reaches the driver as "Failed to convert 'JSON' to
    // 'BSON'" — an error naming neither the field nor the shape, and only
    // visible once a real database is attached.
    const match = buildIntradayPlanPipeline(d("2026-08-15"))[0]!.$match as {
      ts: { $lt: unknown };
    };
    const lt = match.ts.$lt as { $date?: unknown };
    assert.equal(typeof lt.$date, "string");
    assert.ok(!(lt instanceof Date));
  });

  it("groups by the PAIR, so the unit of work is (symbol, timeframe)", () => {
    const group = buildIntradayPlanPipeline(d("2026-08-15"))[1]!.$group as {
      _id: Record<string, string>;
    };
    assert.deepEqual(group._id, { symbol: "$symbol", timeframe: "$timeframe" });
  });
});

describe("orderIntradayLeaves — cheapest shard first", () => {
  it("publishes H1 before M1", () => {
    // Measured 2026-09-07: an H1 year-shard is 133 KB / 21 ms; an M1 year-shard
    // is 7.95 MB gzipped and ~160-250 MB of resident heap while decoded. The
    // large burst goes LAST, when the earlier leaves have released their heap.
    const out = orderIntradayLeaves([
      { symbol: "AAPL", timeframe: "M1" },
      { symbol: "AAPL", timeframe: "H1" },
    ]);
    assert.deepEqual(
      out.map((u) => u.timeframe),
      ["H1", "M1"],
    );
  });

  it("an UNKNOWN timeframe sorts LAST, never first", () => {
    // `indexOf` returns -1, and -1 sorts ahead of H1 — which would put the one
    // shard nobody has measured at the head of the burst.
    const out = orderIntradayLeaves([
      { symbol: "AAPL", timeframe: "M3" },
      { symbol: "AAPL", timeframe: "H1" },
      { symbol: "AAPL", timeframe: "M1" },
    ]);
    assert.deepEqual(
      out.map((u) => u.timeframe),
      ["H1", "M1", "M3"],
    );
  });

  it("is a total order — symbol breaks the tie, so the fan-out is deterministic", () => {
    const out = orderIntradayLeaves([
      { symbol: "MSFT", timeframe: "M1" },
      { symbol: "AAPL", timeframe: "M1" },
    ]);
    assert.deepEqual(
      out.map((u) => u.symbol),
      ["AAPL", "MSFT"],
    );
  });

  it("[premise] every intraday timeframe has a declared rank", () => {
    // A scan whose ordering table is missing a live timeframe silently ranks it
    // last-by-accident rather than by decision.
    for (const tf of INTRADAY_TIMEFRAMES) {
      assert.ok(
        INTRADAY_LEAF_ORDER.includes(tf),
        `${tf} is an intraday timeframe with no rank in INTRADAY_LEAF_ORDER`,
      );
    }
  });
});

describe("partitionIntradayBySessionAuthority", () => {
  it("SAME SOURCE archives, and keeps what the shard already holds", () => {
    const rows = [intraday({ id: "a", source: "TIINGO_RT" })];
    const shard = [
      coldBar({ ts: new Date("2026-07-01T14:30:00Z"), source: "TIINGO_RT" }),
    ];
    const p = partitionIntradayBySessionAuthority(rows, shard, "M1");
    assert.equal(p.archive.length, 1);
    assert.equal(p.outranked.length, 0);
    assert.equal(p.dropped.length, 0);
    assert.equal(
      p.shardBars.length,
      2,
      "existing bar retained + the archived one",
    );
  });

  it("DATABENTO over a TIINGO_RT session DISPLACES — archive plus a drop", () => {
    // Trade-derived bars with real volume outrank quote mids carrying a
    // structural `volume: 0`. Not a merge: a merge is exactly the mixed session
    // the one-source rule exists to forbid.
    const rows = [intraday({ id: "a", source: "DATABENTO" })];
    const shard = [
      coldBar({ ts: new Date("2026-07-01T14:30:00Z"), source: "TIINGO_RT" }),
    ];
    const p = partitionIntradayBySessionAuthority(rows, shard, "M1");
    assert.equal(p.archive.length, 1);
    assert.equal(p.outranked.length, 0);
    assert.deepEqual(
      p.dropped.map((b) => b.source),
      ["TIINGO_RT"],
    );
    assert.deepEqual(
      p.shardBars.map((b) => b.source),
      ["DATABENTO"],
      "the displaced bar must NOT survive into the written object",
    );
    assert.equal(p.verdicts[0]?.action, "displace");
  });

  it("TIINGO_RT against a DATABENTO shard on ANOTHER EXCHANGE is OUTRANKED", () => {
    // THE CASE `candleKey` CANNOT SEE. A shard is TICKER-keyed and carries every
    // venue, so `(AAPL, NASDAQ, M1, t)` and `(AAPL, NYSE, M1, t)` are different
    // natural keys and the SAME ET session. Containment therefore answers
    // nothing about authority: `partitionByShardCoverage` would call these rows
    // `notInShard` and KEEP them, and while they sit in Mongo
    // `mergeHotAndCold`'s hot precedence serves the quote mids OVER the
    // trade-derived shard.
    const rows = [
      intraday({ id: "a", exchange: "NASDAQ", source: "TIINGO_RT" }),
    ];
    const shard = [
      coldBar({
        exchange: "NYSE",
        ts: new Date("2026-07-01T15:00:00Z"),
        source: "DATABENTO",
      }),
    ];
    const p = partitionIntradayBySessionAuthority(rows, shard, "M1");
    assert.equal(p.archive.length, 0, "must NOT be archived into the shard");
    assert.deepEqual(
      p.outranked.map((r) => r.id),
      ["a"],
    );
    assert.equal(p.dropped.length, 0);
    assert.deepEqual(
      p.shardBars.map((b) => b.source),
      ["DATABENTO"],
      "the shard is left exactly as it was",
    );
    // The contrast, stated: containment alone would have kept the row forever.
    assert.equal(partitionByShardCoverage(rows, shard).deletable.length, 0);
  });

  it("a NON-INTRADAY refusal is KEPT, never deleted as outranked", () => {
    // `decideSessionWrite` refuses a D1 displacement with `d1: true`. The route
    // narrows a leaf's timeframe to the intraday set so the processor cannot
    // reach this — but on a DELETE path an unreachable branch must still
    // resolve to KEEP: deleting a daily row because a stronger source holds its
    // session would destroy history the shard does not carry under that key.
    const rows = [intraday({ id: "a", timeframe: "D1", source: "TIINGO_RT" })];
    const shard = [
      coldBar({
        timeframe: "D1",
        ts: new Date("2026-07-01T15:00:00Z"),
        source: "DATABENTO",
      }),
    ];
    const p = partitionIntradayBySessionAuthority(rows, shard, "D1");
    assert.deepEqual(
      p.refused.map((r) => r.id),
      ["a"],
    );
    assert.equal(p.outranked.length, 0, "a D1 refusal must never be deleted");
    assert.equal(p.archive.length, 0);
  });

  it("a session carrying TWO sources gets ONE VERDICT PER SOURCE", () => {
    // A session left mixed by an interrupted write is what
    // `decideSessionWrite`'s multi-source signature exists for. The two halves
    // must be able to receive DIFFERENT answers: one outranks the shard, the
    // other does not.
    const rows = [
      intraday({ id: "rt", source: "TIINGO_RT" }),
      intraday({
        id: "db",
        source: "DATABENTO",
        ts: new Date("2026-07-01T14:32:00Z"),
      }),
    ];
    const shard = [
      coldBar({
        exchange: "NYSE",
        ts: new Date("2026-07-01T15:00:00Z"),
        source: "DATABENTO",
      }),
    ];
    const p = partitionIntradayBySessionAuthority(rows, shard, "M1");
    assert.equal(p.verdicts.length, 2, "one verdict per (session, source)");
    assert.deepEqual(
      p.archive.map((r) => r.id),
      ["db"],
      "the DATABENTO half is already ours — same source, so it archives",
    );
    assert.deepEqual(
      p.outranked.map((r) => r.id),
      ["rt"],
      "the TIINGO_RT half loses to the shard's DATABENTO session",
    );
  });

  it("the session WINDOW is the ET day's real length, not a flat 24 hours", () => {
    // The complement of the case above, and only this arrangement can tell the
    // two apart: here it is the SHARD bar that sits in the post-market tail
    // (00:30Z = 19:30 ET on 2026-01-15) while the Mongo row sits at 10:00 ET
    // the same session. A `dateKey + 24h` window starts at 00:00Z and ENDS
    // before the shard bar, so the session reads as EMPTY, the verdict flips
    // from `refuse` to `write`, and the leaf archives a quote-mid bar into a
    // session Databento already owns — the mixed session the whole rule exists
    // to forbid. `usMarketDayBoundsUtc("2026-01-15")` is 05:00Z -> 05:00Z.
    const rows = [
      intraday({
        id: "rth",
        ts: new Date("2026-01-15T15:00:00Z"),
        source: "TIINGO_RT",
      }),
    ];
    const shard = [
      coldBar({
        exchange: "NYSE",
        ts: new Date("2026-01-16T00:30:00Z"),
        source: "DATABENTO",
      }),
    ];
    assert.equal(usMarketDateKey(rows[0]!.ts), "2026-01-15");
    assert.equal(usMarketDateKey(shard[0]!.ts), "2026-01-15");
    assert.equal(
      usMarketDayBoundsUtc("2026-01-15").startMs,
      Date.parse("2026-01-15T05:00:00Z"),
    );
    const p = partitionIntradayBySessionAuthority(rows, shard, "M1");
    assert.deepEqual(
      p.outranked.map((r) => r.id),
      ["rth"],
      "a flat 24h window would have missed the shard's post-market bar",
    );
    assert.equal(p.archive.length, 0);
  });

  it("a NEIGHBOURING session's shard bar does not outrank this one", () => {
    // The OTHER direction of the same boundary, and the one that loses data.
    // The case above proves the window is long enough; this proves it is not
    // too long. A window that over-reaches — the degenerate `return true` — puts
    // the NEXT session's DATABENTO bar into `existingSources` for THIS session,
    // `decideSessionWrite` answers `refuse`, and the leaf DELETES the Mongo
    // rows as outranked while nothing in the shard covers the session they came
    // from. Silent, and unrecoverable: Mongo was the only copy.
    //
    // 2026-01-15 and 2026-01-16 are consecutive sessions; the shard bar is at
    // 15:00Z on the 16th, which is squarely inside the 16th and outside the
    // 15th (whose bounds are 05:00Z -> 05:00Z).
    const rows = [
      intraday({
        id: "day15",
        ts: new Date("2026-01-15T15:00:00Z"),
        source: "TIINGO_RT",
      }),
    ];
    const shard = [
      coldBar({
        exchange: "NYSE",
        ts: new Date("2026-01-16T15:00:00Z"),
        source: "DATABENTO",
      }),
    ];
    assert.equal(usMarketDateKey(rows[0]!.ts), "2026-01-15");
    assert.equal(usMarketDateKey(shard[0]!.ts), "2026-01-16");
    const p = partitionIntradayBySessionAuthority(rows, shard, "M1");
    assert.deepEqual(
      p.archive.map((r) => r.id),
      ["day15"],
      "the 15th has no DATABENTO bar of its own; it must be ARCHIVED",
    );
    assert.equal(
      p.outranked.length,
      0,
      "a bar from the NEXT session outranked this one — the window over-reaches",
    );
  });

  it("a row the shard ALREADY holds is not written twice", () => {
    // The re-run shape: a previous leaf archived the row and its `deleteMany`
    // threw, so the row is still in Mongo and its exact natural key is already
    // in the object. Without the de-dupe the shard grows a duplicate bar on
    // every retry, and `merge: false` means nothing upstream would collapse it.
    const rows = [intraday({ id: "a", source: "TIINGO_RT" })];
    const shard = [coldBar({ source: "TIINGO_RT" })]; // same ts, same key
    const p = partitionIntradayBySessionAuthority(rows, shard, "M1");
    assert.equal(p.archive.length, 1);
    assert.equal(
      p.shardBars.length,
      1,
      "the archived bar replaces the existing one rather than joining it",
    );
  });

  it("the partition is TOTAL — every row lands in exactly one bucket", () => {
    // What makes the leaf's tally close. A row counted twice or not at all
    // makes every counter below it untrustworthy, and an untrustworthy zero
    // reads as healthy.
    const rows = [
      intraday({ id: "a", source: "TIINGO_RT" }),
      intraday({
        id: "b",
        source: "DATABENTO",
        ts: new Date("2026-07-02T14:31:00Z"),
      }),
      intraday({
        id: "c",
        source: "TIINGO_RT",
        ts: new Date("2026-07-03T14:31:00Z"),
      }),
    ];
    const shard = [
      coldBar({
        exchange: "NYSE",
        ts: new Date("2026-07-01T15:00:00Z"),
        source: "DATABENTO",
      }),
      coldBar({ ts: new Date("2026-07-02T15:00:00Z"), source: "TIINGO_RT" }),
    ];
    const p = partitionIntradayBySessionAuthority(rows, shard, "M1");
    const ids = [...p.archive, ...p.outranked, ...p.refused]
      .map((r) => r.id)
      .sort();
    assert.deepEqual(ids, ["a", "b", "c"]);
    assert.equal(
      p.archive.length + p.outranked.length + p.refused.length,
      rows.length,
    );
  });

  it("sessions are cut in ET, so a post-market bar joins the RIGHT day", () => {
    // Under EST the US day runs to 20:00 ET = 01:00Z the NEXT UTC day. A UTC
    // key puts the tail of one session and the head of the next on opposite
    // sides of itself, and whichever writer lands first locks the other out of
    // both.
    const post = new Date("2026-01-16T00:30:00Z"); // 19:30 ET on 2026-01-15
    assert.equal(usMarketDateKey(post), "2026-01-15");
    const rows = [intraday({ id: "post", ts: post, source: "TIINGO_RT" })];
    const shard = [
      coldBar({
        exchange: "NYSE",
        ts: new Date("2026-01-15T15:00:00Z"), // 10:00 ET, SAME ET session
        source: "DATABENTO",
      }),
    ];
    const p = partitionIntradayBySessionAuthority(rows, shard, "M1");
    assert.deepEqual(
      p.outranked.map((r) => r.id),
      ["post"],
      "a UTC day key would have called this an empty session and archived it",
    );
  });
});

describe("evictTallyBalances counts the outranked deletions", () => {
  it("a leaf that ONLY deleted outranked rows balances", () => {
    assert.equal(
      evictTallyBalances(
        tally({ selected: 4, examined: 4, deletedOutranked: 4 }),
      ),
      true,
    );
  });

  it("leaving them out of the sum does NOT balance", () => {
    // The direction that matters: an unaccounted bucket prints "TALLY DOES NOT
    // BALANCE" on a correct run, and a balance check that cries on correct runs
    // is a balance check nobody reads.
    assert.equal(
      evictTallyBalances(tally({ selected: 4, examined: 4, deleted: 2 })),
      false,
    );
  });

  it("both deletion buckets sum together", () => {
    assert.equal(
      evictTallyBalances(
        tally({ selected: 5, examined: 5, deleted: 3, deletedOutranked: 2 }),
      ),
      true,
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   SOURCE SCAN — the fan-out's shape
   ──────────────────────────────────────────────────────────────────────── */

describe("candle-evict.ts routes the two message shapes", () => {
  it("a LEAF returns BEFORE chainNext is ever reached", () => {
    // The termination proof for the fan-out, and it is structural rather than
    // arithmetic: there is no depth counter here because a leaf publishes
    // nothing. If a leaf could chain, one planner message would become an
    // unbounded tree.
    const leaf = PROCESSOR_CODE.indexOf(
      "if (msg?.unit) return processIntradayLeaf",
    );
    const chain = PROCESSOR_CODE.indexOf("chained = await chainNext({");
    assert.ok(leaf > 0, "the leaf dispatch is present");
    assert.ok(chain > 0 && leaf < chain, "the leaf must return first");
    const body = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("async function processIntradayLeaf"),
    );
    assert.ok(
      !/chainNext\(/.test(body),
      "a leaf must never publish a follow-up of any kind",
    );
  });

  it("the PLAN is terminal too — it fans out instead of chaining", () => {
    const plan = PROCESSOR_CODE.indexOf(
      'if (rule === "WINDOW_INTRADAY") return processIntradayPlan',
    );
    assert.ok(plan > 0, "the plan dispatch is present");
    assert.ok(
      plan < PROCESSOR_CODE.indexOf("chained = await chainNext({"),
      "the plan must return before the chain",
    );
    const body = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("async function processIntradayPlan"),
      PROCESSOR_CODE.indexOf("async function processIntradayLeaf"),
    );
    assert.ok(!/chainNext\(/.test(body));
  });

  it("the PLANNER THROWS on a cursor the server kept open", () => {
    // A truncated plan evicts a PREFIX of the universe, reports success, and
    // leaves the tail growing with nothing to distinguish it from a small
    // population — MONEY-1189's wrong-granularity class, reached through
    // `firstBatch`. `aggregateAll` in databento-repo.ts makes the same call.
    const body = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("async function processIntradayPlan"),
      PROCESSOR_CODE.indexOf("async function processIntradayLeaf"),
    );
    assert.match(body, /cursor\?\.id \?\? "0"\) !== "0"/);
    const guard = body.indexOf('!== "0"');
    const publish = body.indexOf("topic.publishMessage(");
    assert.ok(guard > 0 && publish > 0, "both sites present");
    assert.ok(guard < publish, "the guard must precede the fan-out");
    assert.match(body.slice(guard, publish), /throw new Error\(/);
  });

  it("EVERY eviction read is the UNCACHED one, D1 included", () => {
    // `readColdShard` writes the decoded shard into Redis TWICE per key (the
    // fresh entry and its `:last-good` twin) with no size guard. A 242,000-bar
    // M1 shard is ~36 MB as JSON and the first intraday night walks ~14,570
    // units — tens of gigabytes, to answer a question asked once.
    assert.ok(
      !/\breadColdShard\(/.test(PROCESSOR_CODE),
      "the cached read must not appear on the eviction path at all",
    );
    assert.equal(
      (PROCESSOR_CODE.match(/readColdShardUncached\(\{/g) ?? []).length,
      3,
      "the paged path's verify, plus the leaf's read and its verify",
    );
    assert.ok(
      !/readColdShard,/.test(PROCESSOR_CODE),
      "the cached read is not even imported",
    );
  });

  it("the leaf's deletable set comes from the VERIFYING READ, not the write", () => {
    // The write's own success is never the evidence. `writeColdShard` returning
    // is "GCS accepted some bytes"; the only proof a row may be deleted is a
    // READ showing the shard holds its exact natural key. Assigning
    // `deletable = part.archive` would delete on the strength of the ask.
    const body = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("async function processIntradayLeaf"),
    );
    assert.match(
      body,
      /const coverage = partitionByShardCoverage\(part\.archive, verify\.bars\);/,
    );
    assert.match(body, /deletable = coverage\.deletable;/);
    assert.ok(
      !/deletable = part\.archive/.test(body),
      "the archive list is the ASK; only the verified coverage may be deleted",
    );
    const read = body.indexOf("const verify = await readColdShardUncached({");
    const assign = body.indexOf("deletable = coverage.deletable;");
    const del = body.indexOf("await deleteRows(deletable, tally);");
    assert.ok(
      read > 0 && assign > read && del > assign,
      "read, verify, delete",
    );
  });

  it("the leaf writes the shard with merge:false, over a UNIONED array", () => {
    // A merge here would resurrect exactly the bars a displacement just
    // dropped. `partitionIntradayBySessionAuthority` has already unioned the
    // existing bars in, minus the drops — the harvest's own union-then-write
    // shape.
    const body = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("async function processIntradayLeaf"),
    );
    assert.match(body, /bars: part\.shardBars,\s*merge: false,/);
  });

  it("outranked rows are deleted into their OWN counter", () => {
    const body = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("async function processIntradayLeaf"),
    );
    assert.match(
      body,
      /deleteRows\(part\.outranked, tally, "deletedOutranked"\)/,
    );
    // And only after the armed check — a dry run counts them, it does not act.
    const dry = body.indexOf("if (!base.applied)");
    const del = body.indexOf("deleteRows(part.outranked");
    assert.ok(dry > 0 && del > 0 && dry < del);
  });

  it("the planner fans out in ALL-SETTLED waves, not one awaited publish each", () => {
    // 14,570 sequential publishes at ~20ms is ~290s — half the ack deadline
    // spent making the planner the bottleneck it exists to remove.
    const body = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("async function processIntradayPlan"),
      PROCESSOR_CODE.indexOf("async function processIntradayLeaf"),
    );
    assert.match(body, /await Promise\.allSettled\(/);
    assert.match(body, /LEAF_PUBLISH_CHUNK/);
    assert.match(body, /orderIntradayLeaves\(/);
  });

  it("the planner publishes even when DISARMED, and says so", () => {
    // Refusing to fan out while disarmed would make the disarmed run report a
    // healthy zero for a population nobody measured. Each leaf dry-runs its own
    // verification, which is the point of a dry run on a destructive job.
    const body = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("async function processIntradayPlan"),
      PROCESSOR_CODE.indexOf("async function processIntradayLeaf"),
    );
    assert.match(body, /base\.applied\s*\?\s*""/);
    assert.match(body, /NOT ARMED, publishing anyway/);
    // The fan-out's ONLY condition is that there is something to fan out.
    // Asserted as the literal guard rather than as the absence of a pattern:
    // "no `applied` near a publish" is satisfied by every spelling that puts
    // the flag somewhere else, including `units.length > 0 && base.applied`.
    assert.match(body, /if \(units\.length > 0\) \{/);
    const guard = /if \(units\.length[^)]*\) \{/.exec(body);
    assert.ok(guard && !guard[0].includes("applied"), guard?.[0]);
  });

  it("a published leaf narrows `apply`, and can never ARM one", () => {
    const body = PROCESSOR_CODE.slice(
      PROCESSOR_CODE.indexOf("async function processIntradayPlan"),
      PROCESSOR_CODE.indexOf("async function processIntradayLeaf"),
    );
    assert.match(
      body,
      /msg\?\.apply === false \? \{ apply: false as const \} : \{\}/,
    );
    assert.ok(
      !/apply: true/.test(body),
      "publish rights on the topic must never be enough to start deleting",
    );
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   THE FIVE INEQUALITIES

   Each is a relation between numbers that live in different files, so either
   side moving fails the suite. Where a term is declared elsewhere it is READ
   from there — a constant restated in a test proves the test agrees with
   itself (MONEY-980's `latestUpstreamCallStartMs` guard held for every value
   of the constant under test, including a wrong one).
   ──────────────────────────────────────────────────────────────────────── */

/**
 * CPU one M1 year-shard costs a leaf, end to end.
 *
 * Measured 2026-09-07 on node 22 with the real `encodeColdShard` /
 * `decodeColdShard` / `mergeColdBars` over 242,000 bars: encode 1,042 ms,
 * decode 486 ms, merge 122 ms = 1,650 ms. 3,000 is that with 1.8x headroom.
 */
const M1_SHARD_CPU_BUDGET_MS = 3_000;

/**
 * The largest row count one leaf can select.
 *
 * `INTRADAY_HOT_WINDOW_DAYS` (45) sessions, and the 24x5 venue produces bars
 * across the whole ET calendar day rather than only 04:00-20:00 — measured
 * 1,016-1,408 M1 rows per symbol-session on QA, avg 1,233. 60 x 1,440 is the
 * ceiling with room for the boundary session the whole-session cutoff keeps.
 */
const MAX_LEAF_ROWS = 60 * 1_440;

/**
 * Wall clock allowed per `deleteMany` of `DELETE_CHUNK` ids.
 *
 * An ALLOWANCE, not a measurement — roughly 10x a typical indexed 500-id
 * `deleteMany`. Named so the arithmetic is visible rather than assumed; if a
 * leaf is ever observed overrunning, this is the term to measure first.
 */
const DELETE_CHUNK_MS = 500;

/** 600s Pub/Sub ack deadline, less 60s for the query, the report and the tail. */
const LEAF_DEADLINE_MS = 540_000;

/** Resident heap while ONE decoded M1 year-shard is alive. Measured 160-250 MB. */
const M1_LEAF_PEAK_MB = 250;

/** Units the fan-out must drain in a night: 507 M1 symbols + ~14,063 H1. */
const INTRADAY_UNITS_CEILING = 507 + 14_063;

/** A realistic worst leaf: an M1 shard RMW, transfers included. */
const LEAF_WORST_MS = 5_000;

/** The fan-out must finish inside the night it started. */
const FAN_OUT_DRAIN_CEILING_MS = 4 * 60 * 60 * 1_000;

/** Rows the manifest's shipped entries add per session: 507x960 + 14,063x16. */
const SESSION_INFLOW_ROWS = 507 * 960 + 14_063 * 16;

/** `DELETE_CHUNK`, read from the processor rather than restated. */
function deleteChunk(): number {
  const m = /const DELETE_CHUNK = (\d+);/.exec(PROCESSOR_CODE);
  assert.ok(m, "DELETE_CHUNK is not declared in candle-evict.ts");
  return Number(m![1]);
}

/**
 * A `key: value` off the prod Cloud Run spec.
 *
 * ANCHORED `^\s+key: value$`, and that is not tidiness. A bare
 * `/containerConcurrency: (\d+)/` matched the PROSE at the top of the file
 * first — the comment explaining why the memory limit is what it is — so the
 * inequality below was reading its own justification instead of the deployed
 * value, and a mutation raising the real key to 40 passed. A scan can pin the
 * wrong artifact and look exactly like a working one.
 */
function specNumber(pattern: RegExp, what: string): number {
  const m = pattern.exec(PROD_SPEC);
  assert.ok(m, `cloudbuild.prod.yaml declares no ${what} this scan can read`);
  assert.ok(
    !m![0].includes("#"),
    `${what} was read off a COMMENT line, not a YAML key: ${m![0].trim()}`,
  );
  return Number(m![1]);
}

const maxScale = (): number =>
  specNumber(
    /^\s+autoscaling\.knative\.dev\/maxScale: "(\d+)"\s*$/m,
    "maxScale",
  );
const containerConcurrency = (): number =>
  specNumber(/^\s+containerConcurrency: (\d+)\s*$/m, "containerConcurrency");
const memoryMi = (): number => {
  const m = /^\s+memory: (\d+)(Gi|Mi)\s*$/m.exec(PROD_SPEC);
  assert.ok(m, "cloudbuild.prod.yaml declares no memory: limit");
  assert.ok(!m![0].includes("#"), "memory was read off a COMMENT line");
  return m![2] === "Gi" ? Number(m![1]) * 1024 : Number(m![1]);
};

describe("MONEY-1373 — the five inequalities", () => {
  it("[premise] every term is read from a real declaration", () => {
    // A scan that reads nothing passes forever. All four external terms are
    // asserted plausible before anything is derived from them.
    assert.equal(CANDLE_COLD_TIMEOUT_MS, 20_000);
    assert.ok(deleteChunk() >= 100 && deleteChunk() <= 1_000);
    assert.ok(maxScale() >= 1 && maxScale() <= 1_000);
    assert.ok(containerConcurrency() >= 1 && containerConcurrency() <= 1_000);
    assert.ok(memoryMi() >= 256, `parsed an implausible ${memoryMi()} MiB`);
    // The three terms come from the MAIN worker container, which is the FIRST
    // of the two services in this spec — `tiingo-realtime` further down runs
    // maxScale 1 / concurrency 1 and would make every inequality below trivially
    // true. Pinned by value so a reordering of the file is caught.
    assert.equal(maxScale(), 20);
    assert.equal(containerConcurrency(), 10);
  });

  it("(1) ONE LEAF fits the ack deadline, worst case", () => {
    // Two shard groups (a leaf spans a year boundary in early January), each
    // paying three bounded round trips plus the codec, then the deletes.
    const shardWork = 2 * (3 * CANDLE_COLD_TIMEOUT_MS + M1_SHARD_CPU_BUDGET_MS);
    const deletes = Math.ceil(MAX_LEAF_ROWS / deleteChunk()) * DELETE_CHUNK_MS;
    assert.ok(
      shardWork + deletes <= LEAF_DEADLINE_MS,
      `a worst-case leaf needs ${shardWork + deletes}ms against a ` +
        `${LEAF_DEADLINE_MS}ms budget. Overrunning does not make the run slow — ` +
        `Pub/Sub redelivers and a second copy read-modify-writes the same GCS ` +
        `object, which is the one operation here that can LOSE data.`,
    );
  });

  it("(2) THE FAN-OUT drains inside the night it started", () => {
    // Both divisors are READ from the deployed spec, not assumed: lowering
    // either one is a throughput change that this inequality must see.
    const parallelism = maxScale() * containerConcurrency();
    const wall = (INTRADAY_UNITS_CEILING * LEAF_WORST_MS) / parallelism;
    assert.ok(
      wall <= FAN_OUT_DRAIN_CEILING_MS,
      `${INTRADAY_UNITS_CEILING} leaves at ${LEAF_WORST_MS}ms over ` +
        `${parallelism}-way parallelism is ${Math.round(wall / 60_000)} minutes`,
    );
  });

  it("(3) MEMORY — a full container of M1 leaves fits the limit", () => {
    // THE REASON THE BUMP IS NOT OPTIONAL. This failed at `memory: 1Gi`, which
    // could not hold two of these leaves, let alone ten. An OOM kill on Cloud
    // Run takes the whole container and every other in-flight message with it,
    // each possibly mid-write — so this is a data-loss guard, not a tuning one.
    const need = M1_LEAF_PEAK_MB * containerConcurrency();
    assert.ok(
      need <= memoryMi(),
      `${containerConcurrency()} concurrent M1 leaves peak at ~${need} MB ` +
        `against a declared ${memoryMi()} MiB limit`,
    );
  });

  it("(4) CAPACITY scales with UNITS, not with MAX_CHAIN_DEPTH x batch", () => {
    // The whole point of the redesign, stated as arithmetic. It also fails the
    // day somebody routes intraday back through the row-paged chain: that
    // path's ceiling is MAX_CHAIN_DEPTH x DEFAULT_EVICT_BATCH_SIZE = 20,000
    // rows a night against ~712,000 arriving per session.
    assert.ok(
      INTRADAY_UNITS_CEILING * MAX_LEAF_ROWS >= SESSION_INFLOW_ROWS * 1.5,
      "the fan-out cannot cover one session's inflow with 50% headroom",
    );
    assert.ok(
      MAX_CHAIN_DEPTH * DEFAULT_EVICT_BATCH_SIZE < SESSION_INFLOW_ROWS,
      "the row-paged chain's ceiling is no longer below the intraday inflow — " +
        "if that is genuinely true, this whole fan-out was unnecessary; far " +
        "more likely one of the two constants moved by accident",
    );
  });

  it("(5) the D1 rules' numbers are UNCHANGED by any of this", () => {
    // The paged path still governs LOADED and WINDOW, and none of its sizing
    // was touched. Pinned so a future edit to the intraday half cannot quietly
    // retune the rule that deletes a decade of daily prices once a year.
    assert.equal(MAX_CHAIN_DEPTH, 20);
    assert.equal(DEFAULT_EVICT_BATCH_SIZE, 1_000);
    assert.equal(RUN_TIME_BUDGET_MS, 420_000);
    assert.equal(LEDGER_BUDGET_MS, 60_000);
    assert.equal(HOT_LOAD_TTL_DAYS, 30);
    // And the paged path is still bounded by its wall clock, not by a count.
    assert.ok(RUN_TIME_BUDGET_MS + LEDGER_BUDGET_MS < 600_000);
  });
});
