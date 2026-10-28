/**
 * MONEY-1062 P4a — stock-tabs.service ported query/cache seams (REAL service
 * fns, injected fake prisma + cache + market-status + the two dynamic-imported
 * collaborators via each function's `deps` seam).
 *
 * `@usemoney/services` runs its suite as ESM (no require.cache module-mocking),
 * so every collaborator is injected through `StockTabsDeps`. This pins the
 * faithful port on the code that SHIPS:
 *   - the exact Prisma where/orderBy/take/select per tab,
 *   - the `discover` cache module + `_global` scope + per-tab cache KEY,
 *   - the live-vs-closed TTL (driven by the injected NSE market status),
 *   - the action QUIRKS: no-instrument/no-row → success+empty/null (not error),
 *     news limit clamp [1,50], ratios/technicals cached-null = MISS, peers
 *     coercion + slice(12), shareholding error swallow, technicals oldest-first
 *     candle order.
 *
 * The pure seams (splitFinancialsByStatement / findCloseIndexAtOrBefore /
 * pctReturnTo / numOrNull) are unit-tested directly at the top.
 *
 * Source: packages/services/src/stock-tabs.service.ts (+ ./stock-tabs-logic)
 * pinned against apps/web/lib/actions/stock-tabs.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getStockFinancials,
  getStockPeers,
  getStockTabNews,
  getStockReturns,
  getShareholding,
  getStockRatios,
  getStockTechnicals,
  // MONEY-1235 — the ported period comparator + the two-clock helper.
  parseFinancialPeriodKey,
  compareFinancialPeriodsDesc,
  sortFinancialRowsNewestFirst,
  latestOfTwo,
  type StockTabsDeps,
} from "../src/stock-tabs.service";
import {
  numOrNull,
  splitFinancialsByStatement,
  findCloseIndexAtOrBefore,
  pctReturnTo,
} from "../src/stock-tabs-logic";

// ════════════════════════════════════════════════════════════════════════════
// Pure seams (stock-tabs-logic.ts)
// ════════════════════════════════════════════════════════════════════════════

describe("P4a pure: numOrNull", () => {
  it("passes finite numbers, nulls NaN/Infinity/non-numeric/nullish", () => {
    assert.equal(numOrNull(42), 42);
    assert.equal(numOrNull("3.5"), 3.5);
    assert.equal(numOrNull(NaN), null);
    assert.equal(numOrNull(Infinity), null);
    assert.equal(numOrNull(-Infinity), null);
    assert.equal(numOrNull("abc"), null);
    assert.equal(numOrNull(null), null);
    assert.equal(numOrNull(undefined), null);
  });
});

describe("P4a pure: splitFinancialsByStatement", () => {
  it("buckets by statementType and DROPS unknown/missing types, preserving order", () => {
    const rows = [
      { statementType: "INCOME", period: "Q1" },
      { statementType: "BALANCE_SHEET", period: "Q1" },
      { statementType: "CASH_FLOW", period: "Q1" },
      { statementType: "INCOME", period: "Q2" },
      { statementType: "WEIRD", period: "Q1" },
      { statementType: null, period: "Q1" },
    ];
    const out = splitFinancialsByStatement(rows);
    assert.deepEqual(
      out.income.map((r) => r.period),
      ["Q1", "Q2"],
    );
    assert.equal(out.balance.length, 1);
    assert.equal(out.cashflow.length, 1);
  });
});

describe("P4a pure: return-window helpers", () => {
  const closes = [
    { date: new Date("2026-07-10"), close: 110 }, // idx 0 (latest)
    { date: new Date("2026-07-09"), close: 100 }, // idx 1 (1 day back)
    { date: new Date("2026-06-10"), close: 90 }, // ~30 days back
  ];
  it("pctReturnTo computes % vs latest and guards bad inputs", () => {
    assert.equal(pctReturnTo(closes, 1), 10); // (110-100)/100*100
    assert.equal(pctReturnTo(closes, -1), null);
    assert.equal(pctReturnTo(closes, 99), null);
    assert.equal(pctReturnTo([{ date: new Date(), close: 5 }], 0), 0);
    assert.equal(
      pctReturnTo(
        [
          { date: new Date(), close: 5 },
          { date: new Date(), close: 0 },
        ],
        1,
      ),
      null, // non-positive past close
    );
  });
  it("findCloseIndexAtOrBefore finds the first bar at/before N days", () => {
    assert.equal(findCloseIndexAtOrBefore(closes, 1), 1);
    assert.equal(findCloseIndexAtOrBefore(closes, 30), 2);
    assert.equal(findCloseIndexAtOrBefore(closes, 3650), -1);
    assert.equal(findCloseIndexAtOrBefore([], 7), -1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Service seam scaffolding
// ════════════════════════════════════════════════════════════════════════════

type Rec = Record<string, unknown>;

interface DbCfg {
  instrument?: { id: string } | null;
  financials?: Rec[];
  peers?: { peers: unknown } | null;
  news?: Rec[];
  daily?: Rec[];
  ratios?: Rec | null;
}
interface DbCalls {
  instrument: Rec[];
  financials: Rec[];
  peers: Rec[];
  news: Rec[];
  daily: Rec[];
  ratios: Rec[];
}

interface CacheSet {
  module: unknown;
  scope: unknown;
  key: unknown;
  data: unknown;
  ttl: unknown;
}

interface Harness {
  deps: StockTabsDeps;
  calls: DbCalls;
  cacheGets: Array<{ key: unknown }>;
  cacheSets: CacheSet[];
}

/**
 * Build a deps seam. `cached` seeds the (single) getCached return; `isLive`
 * drives the TTL branch; `shareholding` / `indicators` feed the two injected
 * collaborators.
 */
function mkDeps(
  opts: {
    db?: DbCfg;
    cached?: unknown;
    isLive?: boolean;
    shareholding?: unknown;
    shareholdingThrows?: boolean;
    indicators?: Rec;
    onCandles?: (candles: Array<{ close: number }>) => void;
  } = {},
): Harness {
  const calls: DbCalls = {
    instrument: [],
    financials: [],
    peers: [],
    news: [],
    daily: [],
    ratios: [],
  };
  const cacheGets: Array<{ key: unknown }> = [];
  const cacheSets: CacheSet[] = [];
  const cfg = opts.db ?? {};

  const db = {
    instrumentMapping: {
      findFirst: async (a: Rec) => {
        calls.instrument.push(a);
        return cfg.instrument ?? null;
      },
    },
    stockFinancials: {
      findMany: async (a: Rec) => {
        calls.financials.push(a);
        return cfg.financials ?? [];
      },
    },
    stockPeers: {
      findFirst: async (a: Rec) => {
        calls.peers.push(a);
        return cfg.peers ?? null;
      },
    },
    stockNews: {
      findMany: async (a: Rec) => {
        calls.news.push(a);
        return cfg.news ?? [];
      },
    },
    dailyPrice: {
      findMany: async (a: Rec) => {
        calls.daily.push(a);
        return cfg.daily ?? [];
      },
    },
    stockRatios: {
      findFirst: async (a: Rec) => {
        calls.ratios.push(a);
        return cfg.ratios ?? null;
      },
    },
  };

  const getCachedFake = async <T>(
    _module: unknown,
    _scope: unknown,
    key: unknown,
  ): Promise<T | null> => {
    cacheGets.push({ key });
    return (opts.cached as T | null | undefined) ?? null;
  };
  const setCachedFake = async <T>(
    module: unknown,
    scope: unknown,
    key: unknown,
    data: T,
    _filters?: unknown,
    config?: { ttl?: unknown },
  ): Promise<void> => {
    cacheSets.push({ module, scope, key, data, ttl: config?.ttl });
  };

  const deps: StockTabsDeps = {
    prisma: db as unknown as StockTabsDeps["prisma"],
    getCached: getCachedFake as unknown as StockTabsDeps["getCached"],
    setCached: setCachedFake as unknown as StockTabsDeps["setCached"],
    getNseMarketStatus: () => ({ isLive: opts.isLive ?? true }),
    fetchShareholdingChain: async () => {
      if (opts.shareholdingThrows) throw new Error("scrape failed");
      return opts.shareholding as never;
    },
    computeIndicators: (candles) => {
      opts.onCandles?.(candles as Array<{ close: number }>);
      return (opts.indicators ?? {}) as never;
    },
  };

  return { deps, calls, cacheGets, cacheSets };
}

// ════════════════════════════════════════════════════════════════════════════
// Financials
// ════════════════════════════════════════════════════════════════════════════

describe("P4a service: getStockFinancials", () => {
  it("cache HIT returns cached and never touches prisma", async () => {
    const h = mkDeps({
      cached: { income: [{ period: "cached" }], balance: [], cashflow: [] },
    });
    const r = await getStockFinancials(
      { symbol: "RELIANCE", exchange: "NSE" },
      h.deps,
    );
    assert.ok(r.success && r.data.income[0]!.period === "cached");
    assert.equal(h.calls.instrument.length, 0);
    assert.equal(h.calls.financials.length, 0);
  });

  /**
   * MONEY-1145 — REWRITTEN, and the old version is worth recording because it
   * specified the bug.
   *
   * It asserted "no active InstrumentMapping ⇒ do NOT query financials", which
   * sounds like a sensible short-circuit and was in fact the mechanism that hid
   * the entire collection. Financials are keyed on (symbol, exchange) — their
   * declared `@@unique` — so instrument resolution has nothing to do with
   * whether rows exist. Measured on the dev DB: 0 of 32,359 rows were reachable
   * through the instrumentId path, because re-seeding `instrument_mappings`
   * re-mints ObjectIds and orphans every dependent row.
   *
   * The contract now is: resolution is irrelevant, always ask the natural key.
   */
  it("unresolvable instrument still queries by the natural key", async () => {
    const h = mkDeps({ db: { instrument: null } });
    const r = await getStockFinancials(
      { symbol: "NOPE", exchange: "NSE" },
      h.deps,
    );
    assert.ok(r.success);
    assert.equal(
      h.calls.financials.length,
      1,
      "a missing InstrumentMapping must NOT suppress the query — rows are " +
        "keyed on (symbol, exchange), not on the mapping's ObjectId",
    );
    assert.deepEqual(h.calls.financials[0]!.where, {
      symbol: "NOPE",
      exchange: "NSE",
      // MONEY-1207: the DEFAULT moved QUARTERLY -> ANNUAL. QUARTERLY has 0
      // rows platform-wide, so every caller that omitted the arg — i.e. every
      // apps/api request — received an empty payload. Same assertion strength.
      periodType: "ANNUAL",
    });
  });

  it("queries (symbol,exchange,periodType) with the exact shape + writes the discover cache key (live TTL)", async () => {
    const h = mkDeps({
      db: {
        instrument: { id: "instr_1" },
        financials: [
          { statementType: "INCOME", period: "Q1", revenue: 5 },
          { statementType: "CASH_FLOW", period: "Q1", freeCashFlow: 1 },
        ],
      },
      isLive: true,
    });
    const r = await getStockFinancials(
      { symbol: "RELIANCE", exchange: "NSE", periodType: "QUARTERLY" },
      h.deps,
    );
    assert.ok(r.success);
    assert.deepEqual(
      r.data.income.map((x) => x.period),
      ["Q1"],
    );
    assert.equal(r.data.cashflow.length, 1);

    // MONEY-1145 — no instrument resolution happens on this path any more.
    // It was a round trip whose only effect was to gate the real query behind
    // a mutable id.
    assert.equal(
      h.calls.instrument.length,
      0,
      "financials must not resolve an InstrumentMapping at all",
    );
    // financials query — the model's declared @@unique, which is also what the
    // writer upserts on, so reader and writer agree across re-seeds.
    const q = h.calls.financials[0]!;
    assert.deepEqual(q.where, {
      symbol: "RELIANCE",
      exchange: "NSE",
      periodType: "QUARTERLY",
    });
    assert.deepEqual(q.orderBy, { period: "desc" });
    assert.equal(q.take, 150);

    // ── MONEY-1300: the SELECT asks for `basis` ───────────────────────────
    //
    // An Indian company files the same period twice under SEBI/Ind AS and for a
    // holding company the two differ by a MULTIPLE — 360ONE FY2025
    // `totalAssets` is 19,768 Cr consolidated against 7,332 Cr standalone.
    // `StockFinancials` keeps ONE row per period, so the figure this endpoint
    // ships is correct and unattributable without the column.
    //
    // A hardcoded `select` that omits a column makes "we never asked" print as
    // "the row has no value" — the same defect class the F3 reconcile gate hit,
    // and it is invisible from the payload because the field is simply absent
    // rather than wrong.
    assert.equal(
      (q.select as Record<string, unknown>).basis,
      true,
      "the financials select must ask for `basis`",
    );

    // …and NEVER filters on it. `basis` is provenance for readers, never a
    // guard: on MongoDB the attribute is ABSENT (not null) on ~32,359 rows, so
    // a `basis: null` filter matches nothing and returns ZERO — the class
    // behind MONEY-1050 / 1234 / 1235.
    assert.ok(
      !Object.prototype.hasOwnProperty.call(
        q.where as Record<string, unknown>,
        "basis",
      ),
      "`basis` must never appear in the where clause",
    );

    // cache write: module=discover, scope=_global, keyed, live TTL = 1h
    const set = h.cacheSets[0]!;
    assert.equal(set.module, "discover");
    assert.equal(set.scope, "_global");
    // `-v2` since MONEY-1204 / 14c.8. The reader now selects `source`, and
    // every cache entry written before that deploy lacks the field — serving one
    // would make the source badge render "—" on a row that has a source. The
    // bump is what makes the new column trustworthy immediately instead of
    // 1-6 hours later, and this assertion is what stops it being reverted by
    // someone who reads the key as noise.
    // MONEY-1207: -v3 because `periodEnd` joined the payload (a stale entry
    // would sort the TTM column wrongly, not merely miss a field), and the
    // default period type moved QUARTERLY -> ANNUAL because QUARTERLY has 0
    // rows platform-wide, so every caller that omitted it got an empty payload.
    // MONEY-1235: -v4 because `fetchedAt` joined it AND the buckets are now
    // ordered server-side. A warm -v3 entry is in the old lexicographic DB
    // order, so serving one hands a mobile client "Q4-2026" ahead of the newer
    // "Q1-2027" — a wrong ORDER, not a missing field.
    // MONEY-1300: -v5 because `basis` joined it. A warm -v4 entry carries no
    // basis on any row, so every period of it would report "not stated" while
    // the database knows the answer — the data is there, we would simply not be
    // serving it, for the 1-6 hours the TTL runs.
    // Same strictness, deliberately restated — not weakened.
    assert.equal(set.key, "stock-financials-v5:RELIANCE:NSE:QUARTERLY");
    assert.equal(set.ttl, 60 * 60);
  });

  // ── MONEY-1300 ────────────────────────────────────────────────────────────
  it("ships each row's basis to the /v1 payload, absent included", async () => {
    // Whose accounts the figures are, per PERIOD. The mobile client renders a
    // number it cannot otherwise attribute: consolidated covers the parent and
    // its subsidiaries, standalone the parent alone, and for a holding company
    // that is 19,768 Cr against 7,332 Cr for the same FY2025 total assets.
    //
    // The absent row is the load-bearing case. On MongoDB a `db push` creates
    // indexes and never fields, so `basis` is MISSING — not null — on the
    // ~32,359 rows the XBRL projection has not rewritten. It must reach the
    // client as absent rather than being defaulted to CONSOLIDATED anywhere in
    // this path; the client normalises it to "not stated" at the render
    // boundary, and inventing the group's basis here would put a claim on a
    // figure that no filing supports.
    const h = mkDeps({
      db: {
        financials: [
          {
            statementType: "INCOME",
            period: "FY 2025",
            revenue: 5,
            basis: "CONSOLIDATED",
          },
          {
            statementType: "INCOME",
            period: "FY 2024",
            revenue: 4,
            basis: "STANDALONE",
          },
          // No `basis` key at all — the pre-projection shape.
          { statementType: "INCOME", period: "FY 2019", revenue: 3 },
        ],
      },
    });
    const r = await getStockFinancials(
      { symbol: "X", exchange: "NSE" },
      h.deps,
    );
    assert.ok(r.success);
    const byPeriod = new Map(r.data.income.map((x) => [x.period, x]));
    assert.equal(byPeriod.get("FY 2025")!.basis, "CONSOLIDATED");
    assert.equal(byPeriod.get("FY 2024")!.basis, "STANDALONE");
    assert.equal(byPeriod.get("FY 2019")!.basis, undefined);
  });

  it("defaults periodType to ANNUAL and uses the closed TTL when market is shut", async () => {
    const h = mkDeps({
      db: { instrument: { id: "i" }, financials: [] },
      isLive: false,
    });
    await getStockFinancials({ symbol: "TCS", exchange: "BSE" }, h.deps);
    assert.equal(
      h.calls.financials[0]!.where!["periodType" as never],
      "ANNUAL",
    );
    assert.equal(h.cacheSets[0]!.key, "stock-financials-v5:TCS:BSE:ANNUAL");
    assert.equal(h.cacheSets[0]!.ttl, 6 * 60 * 60); // closed
  });

  // ── MONEY-1235: the /v1 payload is ORDERED, not DB-ordered ────────────────
  //
  // This bucket used to ship in `orderBy: { period: "desc" }` order under a
  // comment saying "let the client sort". The WEB client does — the tab
  // re-sorts with `sortByPeriodDesc`. The MOBILE client consuming
  // `GET /v1/stocks/:symbol/financials?periodType=QUARTERLY` is a different
  // codebase in a different repo, so if it renders array order it gets a
  // LEXICOGRAPHIC one. Prod holds 71,450 quarterly filings and ZERO quarterly
  // `stock_financials` rows, so this order arrives with the first rows the XBRL
  // projection ever writes — nothing existing regresses, and the existing
  // "passthrough" parity assertions could never have caught it.

  it("orders each bucket newest-first: Q1-2027 leads Q4-2026, not the reverse", async () => {
    const h = mkDeps({
      db: {
        // Handed to the service in the LEXICOGRAPHIC order the DB returns.
        financials: [
          {
            statementType: "INCOME",
            period: "Q4-2026",
            periodEnd: new Date("2026-03-31T00:00:00.000Z"),
          },
          {
            statementType: "INCOME",
            period: "Q3-2026",
            periodEnd: new Date("2025-12-31T00:00:00.000Z"),
          },
          {
            statementType: "INCOME",
            period: "Q1-2027",
            periodEnd: new Date("2026-06-30T00:00:00.000Z"),
          },
        ],
      },
    });
    const r = await getStockFinancials(
      { symbol: "RELIANCE", exchange: "NSE", periodType: "QUARTERLY" },
      h.deps,
    );
    assert.ok(r.success);
    assert.deepEqual(
      r.data.income.map((x) => x.period),
      ["Q1-2027", "Q4-2026", "Q3-2026"],
    );
    // The DB order is still requested as a deterministic tiebreak — the sort is
    // an addition, not a replacement.
    assert.deepEqual(h.calls.financials[0]!.orderBy, { period: "desc" });
    // And the CACHED copy is the ordered one, so a warm read is not a
    // differently-ordered read.
    const cachedIncome = (
      h.cacheSets[0]!.data as { income: Array<{ period: string }> }
    ).income;
    assert.deepEqual(
      cachedIncome.map((x) => x.period),
      ["Q1-2027", "Q4-2026", "Q3-2026"],
    );
  });

  it("orders correctly with NO periodEnd at all (the legacy rows)", async () => {
    // Every row written before MONEY-1207 has a null `periodEnd`. The label
    // fallback has to carry the whole order on its own — and this is exactly
    // why the sort is in CODE: on Mongo a MISSING field sorts in a fixed
    // position, so `orderBy: { periodEnd: "desc" }` would place these
    // confidently and wrongly.
    const h = mkDeps({
      db: {
        financials: [
          { statementType: "INCOME", period: "Q4-2026" },
          { statementType: "INCOME", period: "Q1-2027" },
          { statementType: "INCOME", period: "Q2-2026" },
        ],
      },
    });
    const r = await getStockFinancials(
      { symbol: "R", exchange: "NSE", periodType: "QUARTERLY" },
      h.deps,
    );
    assert.ok(r.success);
    assert.deepEqual(
      r.data.income.map((x) => x.period),
      ["Q1-2027", "Q4-2026", "Q2-2026"],
    );
  });

  it("a dated row outranks an undated one, and TTM never leads", async () => {
    // The post-switchover ANNUAL shape: the projection writes `periodEnd` on
    // every FY row it touches, and can never touch the TTM row (`periodLabel()`
    // structurally never emits "TTM"), which Tickertape stored with
    // `endDate: ""` — i.e. null.
    const h = mkDeps({
      db: {
        financials: [
          { statementType: "INCOME", period: "TTM", periodEnd: null },
          {
            statementType: "INCOME",
            period: "FY 2025",
            periodEnd: new Date("2025-03-31T00:00:00.000Z"),
          },
          {
            statementType: "INCOME",
            period: "FY 2026",
            periodEnd: new Date("2026-03-31T00:00:00.000Z"),
          },
        ],
      },
    });
    const r = await getStockFinancials(
      { symbol: "R", exchange: "NSE" },
      h.deps,
    );
    assert.ok(r.success);
    assert.deepEqual(
      r.data.income.map((x) => x.period),
      ["FY 2026", "FY 2025", "TTM"],
    );
  });

  it("sorts each statement bucket independently", async () => {
    const h = mkDeps({
      db: {
        financials: [
          { statementType: "INCOME", period: "Q4-2026" },
          { statementType: "BALANCE_SHEET", period: "Q4-2026" },
          { statementType: "INCOME", period: "Q1-2027" },
          { statementType: "CASH_FLOW", period: "Q3-2026" },
          { statementType: "BALANCE_SHEET", period: "Q1-2027" },
          { statementType: "CASH_FLOW", period: "Q1-2027" },
        ],
      },
    });
    const r = await getStockFinancials(
      { symbol: "R", exchange: "NSE", periodType: "QUARTERLY" },
      h.deps,
    );
    assert.ok(r.success);
    for (const bucket of [r.data.income, r.data.balance, r.data.cashflow]) {
      assert.equal(bucket[0]!.period, "Q1-2027");
    }
  });
});

// ── MONEY-1235 pure: the ported period comparator ────────────────────────────

describe("MONEY-1235 pure: sortFinancialRowsNewestFirst", () => {
  it("parses the Indian-fiscal quarter labels periodLabel() emits", () => {
    assert.deepEqual(parseFinancialPeriodKey("Q1-2027"), {
      year: 2027,
      quarter: 1,
    });
    assert.deepEqual(parseFinancialPeriodKey("FY 2026"), {
      year: 2026,
      quarter: null,
    });
    // "TTM" carries no digits at all — which is how it ends up sorted behind
    // every real period instead of being guessed into place.
    assert.deepEqual(parseFinancialPeriodKey("TTM"), {
      year: null,
      quarter: null,
    });
  });

  it("compareFinancialPeriodsDesc puts an unparseable label LAST", () => {
    assert.ok(compareFinancialPeriodsDesc("TTM", "FY 2019") > 0);
    assert.ok(compareFinancialPeriodsDesc("Q1-2027", "Q4-2026") < 0);
    assert.ok(compareFinancialPeriodsDesc("Q4-2026", "Q3-2026") < 0);
  });

  it("does not mutate the caller's array", () => {
    const rows = [{ period: "Q4-2026" }, { period: "Q1-2027" }];
    sortFinancialRowsNewestFirst(rows);
    assert.equal(rows[0]!.period, "Q4-2026");
  });

  it("treats an Invalid Date as ABSENT rather than as the epoch", () => {
    // `new Date("").getTime()` is NaN. Coercing it would file the row at 1970 —
    // confidently last — instead of falling through to the label.
    const out = sortFinancialRowsNewestFirst([
      { period: "Q3-2026", periodEnd: "" },
      { period: "Q1-2027", periodEnd: "" },
    ]);
    assert.deepEqual(
      out.map((r) => r.period),
      ["Q1-2027", "Q3-2026"],
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Peers
// ════════════════════════════════════════════════════════════════════════════

describe("P4a service: getStockPeers", () => {
  it("coerces varied peer shapes, caps at 12, writes 6h TTL", async () => {
    const peers = Array.from({ length: 15 }, (_, i) => ({
      ticker: `P${i}`,
      fullName: `Peer ${i}`,
      mcap: i,
      priceToEarnings: "12.5",
      returnOnEquity: NaN, // poison → null
      changePct: i,
    }));
    const h = mkDeps({ db: { instrument: { id: "i" }, peers: { peers } } });
    const r = await getStockPeers(
      { symbol: "RELIANCE", exchange: "NSE" },
      h.deps,
    );
    assert.ok(r.success);
    assert.equal(r.data.length, 12); // sliced
    assert.equal(r.data[0]!.symbol, "P0");
    assert.equal(r.data[0]!.name, "Peer 0");
    assert.equal(r.data[0]!.pe, 12.5); // string coerced
    assert.equal(r.data[0]!.roe, null); // NaN → null
    assert.equal(h.cacheSets[0]!.key, "stock-peers:RELIANCE:NSE");
    assert.equal(h.cacheSets[0]!.ttl, 6 * 60 * 60);
  });

  // MONEY-1145 — same rewrite as financials above. Peers had an extra reason
  // never to gate on resolution: the writer stores a SENTINEL instrumentId
  // ("0000…") when it cannot resolve the instrument, so those rows were
  // addressable ONLY by (symbol, exchange).
  it("unresolvable instrument still queries peers by the natural key", async () => {
    const h = mkDeps({ db: { instrument: null } });
    const r = await getStockPeers({ symbol: "X", exchange: "NSE" }, h.deps);
    assert.ok(r.success);
    assert.equal(
      h.calls.peers.length,
      1,
      "a missing InstrumentMapping must not suppress the peers query",
    );
    assert.deepEqual(h.calls.peers[0]!.where, { symbol: "X", exchange: "NSE" });
  });

  it("non-array peers → empty array", async () => {
    const h = mkDeps({
      db: { instrument: { id: "i" }, peers: { peers: null } },
    });
    const r = await getStockPeers({ symbol: "X", exchange: "NSE" }, h.deps);
    assert.deepEqual(r, { success: true, data: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// News (limit clamp)
// ════════════════════════════════════════════════════════════════════════════

describe("P4a service: getStockTabNews", () => {
  it("clamps limit to 50 (over-max) and keys the cache by the clamped limit", async () => {
    const h = mkDeps({ db: { news: [] } });
    await getStockTabNews({ symbol: "RELIANCE", limit: 200 }, h.deps);
    assert.equal(h.calls.news[0]!.take, 50);
    assert.equal(h.cacheSets[0]!.key, "stock-news:RELIANCE:50");
  });

  it("clamps a non-positive limit to 1 and defaults absent to 12", async () => {
    const h1 = mkDeps({ db: { news: [] } });
    await getStockTabNews({ symbol: "R", limit: 0 }, h1.deps);
    assert.equal(h1.calls.news[0]!.take, 1);

    const h2 = mkDeps({ db: { news: [] } });
    await getStockTabNews({ symbol: "R" }, h2.deps);
    assert.equal(h2.calls.news[0]!.take, 12);
  });

  it("maps rows (pubDate ISO, whitelisted sentiment) with orderBy pubDate desc, live TTL 5m", async () => {
    const h = mkDeps({
      db: {
        news: [
          {
            title: "t",
            link: "l",
            pubDate: new Date("2026-07-01T00:00:00.000Z"),
            source: "s",
            snippet: "sn",
            sentiment: "BULLISH", // not whitelisted → null
          },
          {
            title: "t2",
            link: "l2",
            pubDate: null,
            source: "s",
            snippet: null,
            sentiment: "POSITIVE",
          },
        ],
      },
      isLive: true,
    });
    const r = await getStockTabNews({ symbol: "R", limit: 5 }, h.deps);
    assert.ok(r.success);
    assert.equal(r.data[0]!.pubDate, "2026-07-01T00:00:00.000Z");
    assert.equal(r.data[0]!.sentiment, null); // BULLISH not in whitelist
    assert.equal(r.data[1]!.pubDate, null);
    assert.equal(r.data[1]!.sentiment, "POSITIVE");
    assert.deepEqual(h.calls.news[0]!.orderBy, { pubDate: "desc" });
    assert.deepEqual(h.calls.news[0]!.where, { symbol: "R" });
    assert.equal(h.cacheSets[0]!.ttl, 5 * 60); // live
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Returns
// ════════════════════════════════════════════════════════════════════════════

describe("P4a service: getStockReturns", () => {
  it("<2 closes → empty map (no cache write)", async () => {
    const h = mkDeps({
      db: { instrument: { id: "i" }, daily: [{ date: new Date(), close: 1 }] },
    });
    const r = await getStockReturns({ symbol: "R", exchange: "NSE" }, h.deps);
    assert.deepEqual(r, { success: true, data: {} });
    assert.equal(h.cacheSets.length, 0);
  });

  it("computes 1D from the previous close and queries DailyPrice desc take 1500", async () => {
    const h = mkDeps({
      db: {
        instrument: { id: "i" },
        daily: [
          { date: new Date("2026-07-10"), close: 110 },
          { date: new Date("2026-07-09"), close: 100 },
        ],
      },
      isLive: false,
    });
    const r = await getStockReturns({ symbol: "R", exchange: "NSE" }, h.deps);
    assert.ok(r.success);
    assert.equal(r.data["1D"], 10); // (110-100)/100*100
    assert.equal(r.data["1W"], null); // no bar ≥7d back
    const q = h.calls.daily[0]!;
    assert.deepEqual(q.orderBy, { date: "desc" });
    assert.equal(q.take, 1500);
    assert.deepEqual(q.select, { date: true, close: true });
    assert.equal(h.cacheSets[0]!.key, "stock-returns:R:NSE");
    assert.equal(h.cacheSets[0]!.ttl, 6 * 60 * 60); // closed
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Shareholding
// ════════════════════════════════════════════════════════════════════════════

describe("P4a service: getShareholding", () => {
  it("maps the chain rows and caches only when non-empty", async () => {
    const h = mkDeps({
      shareholding: [
        { quarter: "Q1", promoter: 50, fii: 20, dii: 15, public: 15, extra: 1 },
      ],
    });
    const r = await getShareholding(
      { symbol: "RELIANCE", exchange: "NSE" },
      h.deps,
    );
    assert.ok(r.success);
    assert.deepEqual(r.data.shareholding, [
      { quarter: "Q1", promoter: 50, fii: 20, dii: 15, public: 15 },
    ]);
    assert.equal(h.cacheSets[0]!.key, "stock-shareholding:RELIANCE:NSE");
  });

  it("empty chain → success with empty, no cache write", async () => {
    const h = mkDeps({ shareholding: [] });
    const r = await getShareholding({ symbol: "R", exchange: "NSE" }, h.deps);
    assert.deepEqual(r, { success: true, data: { shareholding: [] } });
    assert.equal(h.cacheSets.length, 0);
  });

  /**
   * MONEY-1146 — REWRITTEN. The previous version asserted the bug as a feature:
   *
   *   it("SWALLOWS a fetch error → success with empty (quirk)")
   *
   * It was mirroring the web action's behaviour for parity, and the name is an
   * honest description of what the code did. But swallowing meant a blocked
   * scrape, a rate-limit, a vendor layout change and a genuinely uncovered
   * symbol were all reported identically — so a permanently broken feature was
   * indistinguishable from one with nothing to show, and nothing surfaced it.
   *
   * Parity is preserved: web now reports failures too.
   */
  it("a fetch error is reported as a FAILURE, not as empty data", async () => {
    const h = mkDeps({ shareholdingThrows: true });
    const r = await getShareholding({ symbol: "R", exchange: "NSE" }, h.deps);
    assert.equal(
      r.success,
      false,
      "a failed scrape must not be indistinguishable from a symbol with no data",
    );
  });

  it("a genuinely empty upstream result is still a SUCCESS", async () => {
    // The over-correction guard: if every empty answer became an error, every
    // uncovered stock would render a red failure panel.
    const h = mkDeps({ shareholding: [] });
    const r = await getShareholding({ symbol: "R", exchange: "NSE" }, h.deps);
    assert.deepEqual(r, { success: true, data: { shareholding: [] } });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Ratios
// ════════════════════════════════════════════════════════════════════════════

describe("P4a service: getStockRatios", () => {
  it("maps the row (poison → null, source default, ISO fetchedAt) and keys the cache", async () => {
    const h = mkDeps({
      db: {
        ratios: {
          pe: 25,
          pb: NaN, // poison → null
          roe: "18", // coerced
          recommendation: null,
          source: null, // → default TICKERTAPE
          fetchedAt: new Date("2026-07-01T00:00:00.000Z"),
        },
      },
    });
    const r = await getStockRatios(
      { symbol: "RELIANCE", exchange: "NSE" },
      h.deps,
    );
    assert.ok(r.success && r.data);
    assert.equal(r.data.pe, 25);
    assert.equal(r.data.pb, null);
    assert.equal(r.data.roe, 18);
    assert.equal(r.data.source, "TICKERTAPE");
    assert.equal(r.data.fetchedAt, "2026-07-01T00:00:00.000Z");
    assert.deepEqual(h.calls.ratios[0]!.where, {
      symbol: "RELIANCE",
      exchange: "NSE",
    });
    // MONEY-1235: -v2 because `ratiosDerivedAt` + `dataAsOf` joined the payload
    // and a warm entry lacking them would report day-fresh ratios as months old.
    assert.equal(h.cacheSets[0]!.key, "stock-ratios-v2:RELIANCE:NSE");
  });

  // ── MONEY-1235: the two clocks a StockRatios row runs on ──────────────────

  it("reports dataAsOf = max(fetchedAt, ratiosDerivedAt) — the DERIVED age", async () => {
    // The live shape after the switchover: `xbrl-ratios-daily` recomputed 26 of
    // the 28 columns last night and stamped `ratiosDerivedAt`, while
    // `fetchedAt` still says March because the only writer that ever set it
    // (Tickertape) now 403s our Cloud Run egress. A client shown `fetchedAt`
    // sees five-month-old numbers that are in fact hours old.
    const h = mkDeps({
      db: {
        ratios: {
          pe: 25,
          source: "NSE_XBRL",
          fetchedAt: new Date("2026-03-12T21:40:00.000Z"),
          ratiosDerivedAt: new Date("2026-08-20T16:30:00.000Z"),
        },
      },
    });
    const r = await getStockRatios({ symbol: "R", exchange: "NSE" }, h.deps);
    assert.ok(r.success && r.data);
    assert.equal(r.data.dataAsOf, "2026-08-20T16:30:00.000Z");
    assert.equal(r.data.ratiosDerivedAt, "2026-08-20T16:30:00.000Z");
    // `fetchedAt` is NOT redefined as the max. It is the honest age of the two
    // columns nothing writes any more — `targetPrice` and `recommendation` —
    // and `StockAnalystSnapshot` gates its whole card on it.
    assert.equal(r.data.fetchedAt, "2026-03-12T21:40:00.000Z");
  });

  it("a row the derive has never touched reports its fetchedAt as dataAsOf", async () => {
    const h = mkDeps({
      db: {
        ratios: {
          pe: 9,
          source: "TICKERTAPE",
          fetchedAt: new Date("2026-03-12T21:40:00.000Z"),
          ratiosDerivedAt: null,
        },
      },
    });
    const r = await getStockRatios({ symbol: "R", exchange: "NSE" }, h.deps);
    assert.ok(r.success && r.data);
    assert.equal(r.data.dataAsOf, "2026-03-12T21:40:00.000Z");
    assert.equal(r.data.ratiosDerivedAt, null);
  });

  it("both clocks unset → dataAsOf is null, never 1970", async () => {
    // `Math.max(-Infinity, -Infinity)` through `new Date` is an Invalid Date,
    // and an epoch date is "stale by 56 years". Both are wrong answers to
    // "we do not know".
    const h = mkDeps({
      db: {
        ratios: { pe: 9, source: "X", fetchedAt: null, ratiosDerivedAt: null },
      },
    });
    const r = await getStockRatios({ symbol: "R", exchange: "NSE" }, h.deps);
    assert.ok(r.success && r.data);
    assert.equal(r.data.dataAsOf, null);
    assert.equal(r.data.fetchedAt, null);
  });

  it("latestOfTwo ignores an Invalid Date instead of letting NaN win", () => {
    const good = new Date("2026-08-20T16:30:00.000Z");
    assert.equal(
      latestOfTwo(new Date("nope"), good),
      "2026-08-20T16:30:00.000Z",
    );
    assert.equal(latestOfTwo(good, undefined), "2026-08-20T16:30:00.000Z");
    assert.equal(latestOfTwo(null, null), null);
  });

  it("missing row → data:null, no cache write", async () => {
    const h = mkDeps({ db: { ratios: null } });
    const r = await getStockRatios({ symbol: "R", exchange: "NSE" }, h.deps);
    assert.deepEqual(r, { success: true, data: null });
    assert.equal(h.cacheSets.length, 0);
  });

  it("a cached NULL is treated as a MISS (re-reads the row) — quirk", async () => {
    const h = mkDeps({
      cached: null,
      db: { ratios: { pe: 9, source: "X", fetchedAt: null } },
    });
    const r = await getStockRatios({ symbol: "R", exchange: "NSE" }, h.deps);
    assert.ok(r.success && r.data);
    assert.equal(r.data.pe, 9);
    assert.equal(h.calls.ratios.length, 1); // did NOT short-circuit on cached null
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Technicals
// ════════════════════════════════════════════════════════════════════════════

describe("P4a service: getStockTechnicals", () => {
  it("<30 closes → data:null (no compute)", async () => {
    let computed = false;
    const daily = Array.from({ length: 10 }, (_, i) => ({
      date: new Date(2026, 0, i + 1),
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    }));
    const h = mkDeps({
      db: { instrument: { id: "i" }, daily },
      onCandles: () => {
        computed = true;
      },
    });
    const r = await getStockTechnicals(
      { symbol: "R", exchange: "NSE" },
      h.deps,
    );
    assert.deepEqual(r, { success: true, data: null });
    assert.equal(computed, false);
  });

  it("reverses closes to OLDEST-first for computeIndicators and maps the snapshot", async () => {
    // 30 desc rows: close = 100 (newest) down to 71 (oldest).
    const daily = Array.from({ length: 30 }, (_, i) => ({
      date: new Date(2026, 5, 30 - i), // newest first
      open: 1,
      high: 1,
      low: 1,
      close: 100 - i,
      volume: 1,
    }));
    let firstCandleClose = -1;
    let candleCount = -1;
    const h = mkDeps({
      db: { instrument: { id: "i" }, daily },
      indicators: {
        rsi14: 55,
        sma20: 90,
        goldenCross: true,
        deathCross: undefined,
      },
      isLive: true,
      onCandles: (candles) => {
        firstCandleClose = candles[0]!.close;
        candleCount = candles.length;
      },
    });
    const r = await getStockTechnicals(
      { symbol: "R", exchange: "NSE" },
      h.deps,
    );
    assert.ok(r.success && r.data);
    // Oldest-first: first candle is the OLDEST close (71), not the newest (100).
    assert.equal(firstCandleClose, 71);
    assert.equal(candleCount, 30);
    assert.equal(r.data.price, 100); // newest close (closesDesc[0])
    assert.equal(r.data.rsi14, 55);
    assert.equal(r.data.sma20, 90);
    assert.equal(r.data.goldenCross, true);
    assert.equal(r.data.deathCross, null); // undefined → null
    assert.equal(r.data.sampleSize, 30);
    assert.equal(h.calls.daily[0]!.take, 400);
    assert.equal(h.cacheSets[0]!.key, "stock-technicals:R:NSE");
    assert.equal(h.cacheSets[0]!.ttl, 30 * 60); // live
  });
});
