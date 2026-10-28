/**
 * Stock-page market sections service — MONEY-1204 (P14 / 14c.1 · 14c.2 · 14c.3).
 *
 * Runs the REAL service functions with a hand-rolled fake Prisma, fake cache and
 * fake market clock injected through `StockSectionsMarketDeps`. No DB, no Redis.
 *
 * What is pinned here is everything the pure helpers cannot see:
 *
 *   - the QUERY SHAPE. `stock_flags` is a ~7.5M-row table and this is its first
 *     application reader, so "one bounded query per kind" (which uses
 *     `@@index([symbol, kind, date desc]) `end-to-end) is a contract, not a
 *     style choice. A future refactor to `where: {symbol}` + `orderBy: date`
 *     would still pass every pure test and would still be a full-history fetch
 *     plus an in-memory sort on every stock page view.
 *   - the cache KEY, the live-vs-closed TTL, and the rule that an EMPTY section
 *     is never written to cache.
 *   - the `IndexConstituent` fallback firing ONLY when `IndexMembership` is
 *     empty — that model has no `[symbol]` index, so an unconditional read is a
 *     collection scan per page view.
 *   - the F&O GATE short-circuiting before SLB / MWPL / ban are touched.
 *   - BigInt never reaching a JSON boundary.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  getStockDeliveryTrend,
  getStockDerivatives,
  getStockFlagsAndIndexes,
  type StockSectionsMarketDeps,
} from "../src/stock-sections-market.service";

const day = (d: string): Date => new Date(`${d}T00:00:00.000Z`);

type Rec = Record<string, unknown>;

interface DbCfg {
  /** kind → rows, so a per-kind query returns only its own rows. */
  flagsByKind?: Record<string, Rec[]>;
  /** kind → that kind's newest MARKET-WIDE day, for the `findFirst` reference. */
  referenceByKind?: Record<string, Date>;
  memberships?: Rec[];
  constituents?: Rec[];
  instrument?: { id: string } | null;
  daily?: Rec[];
  summary?: Rec | null;
  slbLatest?: { date: Date } | null;
  slbRows?: Rec[];
  mwpl?: Rec | null;
  /** Delegate name to blow up on, for the catch-path test. */
  throwOn?: string;
}

interface Calls {
  stockFlag: Rec[];
  stockFlagFindFirst: Rec[];
  indexMembership: Rec[];
  indexConstituent: Rec[];
  instrumentMapping: Rec[];
  dailyPrice: Rec[];
  derivativeSummary: Rec[];
  slbFindFirst: Rec[];
  slbFindMany: Rec[];
  mwplDaily: Rec[];
}

interface CacheSet {
  module: unknown;
  scope: unknown;
  key: unknown;
  data: unknown;
  ttl: unknown;
}

interface Harness {
  deps: StockSectionsMarketDeps;
  calls: Calls;
  cacheGets: Array<{ key: unknown }>;
  cacheSets: CacheSet[];
}

function mkDeps(
  opts: { db?: DbCfg; cached?: unknown; isLive?: boolean } = {},
): Harness {
  const cfg = opts.db ?? {};
  const calls: Calls = {
    stockFlag: [],
    stockFlagFindFirst: [],
    indexMembership: [],
    indexConstituent: [],
    instrumentMapping: [],
    dailyPrice: [],
    derivativeSummary: [],
    slbFindFirst: [],
    slbFindMany: [],
    mwplDaily: [],
  };
  const cacheGets: Array<{ key: unknown }> = [];
  const cacheSets: CacheSet[] = [];

  const boom = (name: string): void => {
    if (cfg.throwOn === name)
      throw new Error("db exploded: connection string leaked");
  };

  const db = {
    stockFlag: {
      findMany: async (a: Rec) => {
        calls.stockFlag.push(a);
        boom("stockFlag");
        const where = a.where as { kind?: string } | undefined;
        const kind = where?.kind ?? "";
        return (cfg.flagsByKind?.[kind] ?? []).slice(0, Number(a.take ?? 1e9));
      },
      // MONEY-1205 — the per-kind, MARKET-WIDE newest day. Note the `where`:
      // `{ kind }` with NO symbol. That is the whole point of the query, so the
      // fake answers off `referenceByKind`, which is deliberately independent
      // of `flagsByKind`: a family can publish market-wide on a day THIS stock
      // has no row for, and that is exactly when a flag has ENDED.
      findFirst: async (a: Rec) => {
        calls.stockFlagFindFirst.push(a);
        boom("stockFlag");
        const kind = (a.where as { kind?: string } | undefined)?.kind ?? "";
        const d = cfg.referenceByKind?.[kind];
        return d ? { date: d } : null;
      },
    },
    indexMembership: {
      findMany: async (a: Rec) => {
        calls.indexMembership.push(a);
        boom("indexMembership");
        return cfg.memberships ?? [];
      },
    },
    indexConstituent: {
      findMany: async (a: Rec) => {
        calls.indexConstituent.push(a);
        return cfg.constituents ?? [];
      },
    },
    instrumentMapping: {
      findFirst: async (a: Rec) => {
        calls.instrumentMapping.push(a);
        boom("instrumentMapping");
        return cfg.instrument ?? null;
      },
    },
    dailyPrice: {
      findMany: async (a: Rec) => {
        calls.dailyPrice.push(a);
        return cfg.daily ?? [];
      },
    },
    derivativeSummary: {
      findFirst: async (a: Rec) => {
        calls.derivativeSummary.push(a);
        boom("derivativeSummary");
        return cfg.summary ?? null;
      },
    },
    slbPosition: {
      findFirst: async (a: Rec) => {
        calls.slbFindFirst.push(a);
        return cfg.slbLatest ?? null;
      },
      findMany: async (a: Rec) => {
        calls.slbFindMany.push(a);
        return cfg.slbRows ?? [];
      },
    },
    mwplDaily: {
      findFirst: async (a: Rec) => {
        calls.mwplDaily.push(a);
        return cfg.mwpl ?? null;
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

  const deps: StockSectionsMarketDeps = {
    prisma: db as unknown as StockSectionsMarketDeps["prisma"],
    getCached: getCachedFake as unknown as StockSectionsMarketDeps["getCached"],
    setCached: setCachedFake as unknown as StockSectionsMarketDeps["setCached"],
    getNseMarketStatus: () => ({ isLive: opts.isLive ?? false }),
  };
  return { deps, calls, cacheGets, cacheSets };
}

const ARGS = { symbol: "RELIANCE", exchange: "NSE" };

// ════════════════════════════════════════════════════════════════════════════
// 14c.1 — flags + index chips
// ════════════════════════════════════════════════════════════════════════════

describe("14c.1 getStockFlagsAndIndexes", () => {
  it("cache HIT short-circuits before any query", async () => {
    const h = mkDeps({
      cached: {
        data: { badges: [], history: {}, indexes: [], referenceDay: null },
        source: null,
        asOf: null,
        empty: true,
      },
    });
    const r = await getStockFlagsAndIndexes(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(h.calls.stockFlag.length, 0);
    assert.equal(h.calls.indexMembership.length, 0);
    assert.equal(h.cacheGets[0]?.key, "stock-flags:RELIANCE:NSE:60");
  });

  it("issues ONE bounded query PER KIND on the (symbol,kind,date) index", async () => {
    // The shape is the contract: equality on (symbol, exchange, kind), index
    // order on date desc, and a `take`. `where:{symbol}` + a global date sort
    // would fetch the stock's entire flag history and sort it in memory.
    const h = mkDeps();
    await getStockFlagsAndIndexes(ARGS, h.deps);
    assert.equal(h.calls.stockFlag.length, 7, "seven StockFlagKinds");
    const kinds = h.calls.stockFlag
      .map((a) => (a.where as { kind: string }).kind)
      .sort();
    assert.deepEqual(kinds, [
      "BAND_CHANGE",
      "FO_BAN",
      "PRICE_BAND",
      "SERIES_CHANGE",
      "SHORT_SELLING",
      "SURVEILLANCE",
      "WK52_HIGH_LOW",
    ]);
    for (const a of h.calls.stockFlag) {
      assert.deepEqual(a.where, {
        symbol: "RELIANCE",
        exchange: "NSE",
        kind: (a.where as { kind: string }).kind,
      });
      assert.deepEqual(a.orderBy, { date: "desc" });
      assert.equal(a.take, 60);
    }
  });

  it("clamps a caller-supplied rowsPerKind and keys the cache on it", async () => {
    const h = mkDeps();
    await getStockFlagsAndIndexes({ ...ARGS, rowsPerKind: 9999 }, h.deps);
    assert.equal(h.calls.stockFlag[0]?.take, 200);
    assert.equal(h.cacheGets[0]?.key, "stock-flags:RELIANCE:NSE:200");
  });

  it("builds badges + per-kind history and does NOT cache an empty section", async () => {
    const empty = mkDeps();
    const r0 = await getStockFlagsAndIndexes(ARGS, empty.deps);
    assert.ok(r0.success && r0.data.empty === true);
    assert.deepEqual(r0.data.data.badges, []);
    assert.equal(r0.data.asOf, null, "empty section must not claim freshness");
    assert.equal(
      empty.cacheSets.length,
      0,
      "a cached 'nothing yet' is fail-open",
    );

    const h = mkDeps({
      db: {
        flagsByKind: {
          SURVEILLANCE: [
            {
              kind: "SURVEILLANCE",
              value: "GSM STAGE - I",
              date: day("2026-08-14"),
              series: null,
              source: "nse-gsm-api",
            },
            {
              kind: "SURVEILLANCE",
              value: "GSM STAGE - I",
              date: day("2026-08-13"),
              series: null,
              source: "nse-gsm-api",
            },
          ],
          PRICE_BAND: [
            {
              kind: "PRICE_BAND",
              value: '{"band":"20"}',
              date: day("2026-08-14"),
              series: "EQ",
              source: "nse-sec-list",
            },
          ],
        },
      },
    });
    const r = await getStockFlagsAndIndexes(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.empty, false);
    assert.equal(r.data.asOf, "2026-08-14T00:00:00.000Z");
    assert.equal(
      r.data.source,
      "nse-gsm-api",
      "the lead badge names the source",
    );
    assert.deepEqual(
      r.data.data.badges.map((b) => b.label),
      ["GSM Stage I", "20% band"],
    );
    assert.equal(r.data.data.badges[0]?.observedSessions, 2);
    assert.equal(r.data.data.history.SURVEILLANCE?.length, 2);
    assert.equal(r.data.data.history.PRICE_BAND?.length, 1);
    assert.equal(
      r.data.data.history.WK52_HIGH_LOW,
      undefined,
      "a kind with no rows gets no history key",
    );
    assert.equal(r.data.data.history.SURVEILLANCE?.[0]?.value, "GSM STAGE - I");
    assert.equal(r.data.data.referenceDay, "2026-08-14T00:00:00.000Z");
  });

  // ── MONEY-1205 ──────────────────────────────────────────────────────────

  it("resolves the reference day PER KIND, market-wide (no symbol in the where)", async () => {
    // The whole defect. `isCurrent` was judged against ONE cross-kind day, and
    // PRICE_BAND / WK52_HIGH_LOW publish the entire universe every session, so
    // they always set the bar and every sparser family read as ended. The
    // denominator has to be the kind's OWN market-wide latest day, which is a
    // `findFirst` with NO symbol in the predicate — a different query from the
    // per-symbol page read, on `@@index([kind, date desc])`.
    const h = mkDeps({
      db: {
        flagsByKind: {
          SHORT_SELLING: [
            {
              kind: "SHORT_SELLING",
              value: '{"qty":106}',
              date: day("2026-08-10"),
              series: "EQ",
              source: "nse-shortselling",
            },
          ],
          PRICE_BAND: [
            {
              kind: "PRICE_BAND",
              value: '{"band":"20"}',
              date: day("2026-08-17"),
              series: "EQ",
              source: "nse-sec-list",
            },
          ],
        },
        referenceByKind: {
          SHORT_SELLING: day("2026-08-10"),
          PRICE_BAND: day("2026-08-17"),
          WK52_HIGH_LOW: day("2026-08-17"),
          SURVEILLANCE: day("2026-08-17"),
          FO_BAN: day("2026-08-17"),
          BAND_CHANGE: day("2026-08-17"),
          SERIES_CHANGE: day("2023-08-22"),
        },
      },
    });
    const r = await getStockFlagsAndIndexes(ARGS, h.deps);
    assert.ok(r.success);

    assert.equal(h.calls.stockFlagFindFirst.length, 7, "one per kind");
    for (const a of h.calls.stockFlagFindFirst) {
      const where = a.where as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(where),
        ["kind"],
        "market-wide: the symbol must NOT be in the predicate",
      );
      assert.deepEqual(a.orderBy, { date: "desc" });
    }

    // "Short sold 106 (ended)" — the reported symptom. Short selling last
    // published on the 10th, which IS this row's day, so it is current.
    const shorts = r.data.data.badges.find((b) => b.kind === "SHORT_SELLING");
    assert.equal(shorts?.isCurrent, true);
    assert.equal(
      r.data.data.referenceDayByKind.SHORT_SELLING,
      "2026-08-10",
      "the map is exposed so a client need not re-derive it",
    );
  });

  it("caches the reference map globally, and NEVER when a family has not landed", async () => {
    // Symbol-independent: one entry serves every stock page. But a map holding
    // a null is the fail-open the standing rule forbids freezing — on QA
    // `surveillance-sync` is prod-only, and pinning `SURVEILLANCE: null` for
    // six hours is an all-clear derived from an absent feed.
    const complete = mkDeps({
      db: {
        memberships: [
          { indexId: "nifty50", lastSeen: day("2026-08-17"), removedOn: null },
        ],
        referenceByKind: {
          SHORT_SELLING: day("2026-08-17"),
          PRICE_BAND: day("2026-08-17"),
          WK52_HIGH_LOW: day("2026-08-17"),
          SURVEILLANCE: day("2026-08-17"),
          FO_BAN: day("2026-08-17"),
          BAND_CHANGE: day("2026-08-17"),
          SERIES_CHANGE: day("2026-08-17"),
        },
      },
    });
    await getStockFlagsAndIndexes(ARGS, complete.deps);
    const refSet = complete.cacheSets.find(
      (c) => c.key === "stock-flags-reference-days",
    );
    assert.ok(refSet, "a complete map is cached");
    assert.equal(refSet.module, "discover");
    assert.equal(refSet.scope, "_global");
    assert.ok(
      !String(refSet.key).includes("RELIANCE"),
      "symbol-independent key",
    );

    const partial = mkDeps({
      db: {
        memberships: [
          { indexId: "nifty50", lastSeen: day("2026-08-17"), removedOn: null },
        ],
        // SURVEILLANCE absent ⇒ null ⇒ must not be frozen.
        referenceByKind: { PRICE_BAND: day("2026-08-17") },
      },
    });
    await getStockFlagsAndIndexes(ARGS, partial.deps);
    assert.equal(
      partial.cacheSets.find((c) => c.key === "stock-flags-reference-days"),
      undefined,
      "a map containing a null must never be cached",
    );
  });

  it("decodes history rows BESIDE the verbatim value, SURVEILLANCE byte-identical", async () => {
    // Four products read this payload: the web popover, /v1 (mobile gets this
    // exact object), research and the alert writers. Three were shipping JSON.
    const h = mkDeps({
      db: {
        flagsByKind: {
          SURVEILLANCE: [
            {
              kind: "SURVEILLANCE",
              value: "GSM STAGE - I",
              date: day("2026-08-17"),
              series: "EQ",
              source: "nse-gsm-api",
            },
          ],
          PRICE_BAND: [
            {
              kind: "PRICE_BAND",
              value: '{"band":"No Band"}',
              date: day("2026-08-17"),
              series: "EQ",
              source: "nse-sec-list",
            },
          ],
          BAND_CHANGE: [
            {
              kind: "BAND_CHANGE",
              value: '{"from":"5","to":"No Band"}',
              date: day("2024-05-21"),
              series: "EQ",
              source: "nse-eq-band-changes",
            },
          ],
        },
        referenceByKind: { PRICE_BAND: day("2026-08-17") },
      },
    });
    const r = await getStockFlagsAndIndexes(ARGS, h.deps);
    assert.ok(r.success);
    const hist = r.data.data.history;

    // The verbatim column SURVIVES — `display` sits beside it, never replaces.
    assert.equal(hist.SURVEILLANCE?.[0]?.value, "GSM STAGE - I");
    assert.equal(
      hist.SURVEILLANCE?.[0]?.display,
      "GSM STAGE - I",
      "SURVEILLANCE decodes byte-identically",
    );

    assert.equal(hist.PRICE_BAND?.[0]?.value, '{"band":"No Band"}');
    assert.equal(hist.PRICE_BAND?.[0]?.display, "no price band (F&O)");

    assert.equal(hist.BAND_CHANGE?.[0]?.value, '{"from":"5","to":"No Band"}');
    assert.equal(
      hist.BAND_CHANGE?.[0]?.display,
      "Price band 5% → no band on 21 May 2024",
      "no `%` after a word, and a POINT event carries its date",
    );
    for (const rows of Object.values(hist)) {
      for (const row of rows) {
        assert.ok(!row.display.includes("{"), `JSON leaked: ${row.display}`);
      }
    }
  });

  it("returns an EMPTY headline for a plain stock while keeping badges + provenance", async () => {
    // Most of the market: a 20% band and a 52-week row, both published for the
    // whole universe every session. The header strip must be empty — and the
    // envelope must STILL name its source, which `badges[0]?.source` only ever
    // did because those two guaranteed a badge on every stock.
    const h = mkDeps({
      db: {
        flagsByKind: {
          PRICE_BAND: [
            {
              kind: "PRICE_BAND",
              value: '{"band":"20"}',
              date: day("2026-08-17"),
              series: "EQ",
              source: "nse-sec-list",
            },
          ],
          WK52_HIGH_LOW: [
            {
              kind: "WK52_HIGH_LOW",
              value: '{"high":1020.5,"low":722}',
              date: day("2026-08-17"),
              series: "EQ",
              source: "nse-52wk-high-low",
            },
          ],
        },
        referenceByKind: {
          PRICE_BAND: day("2026-08-17"),
          WK52_HIGH_LOW: day("2026-08-17"),
        },
      },
    });
    const r = await getStockFlagsAndIndexes(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.data.badges.length, 2, "nothing is lost");
    assert.deepEqual(r.data.data.headline, [], "a flag is an exception");
    assert.equal(
      r.data.source,
      "nse-sec-list",
      "provenance survives an empty headline set",
    );
    assert.equal(r.data.empty, false, "the section still has content");
  });

  it("leads the envelope source with the RENDERED badge when there is one", async () => {
    const h = mkDeps({
      db: {
        flagsByKind: {
          SURVEILLANCE: [
            {
              kind: "SURVEILLANCE",
              value: "GSM STAGE - I",
              date: day("2026-08-17"),
              series: "EQ",
              source: "nse-gsm-api",
            },
          ],
          PRICE_BAND: [
            {
              kind: "PRICE_BAND",
              value: '{"band":"20"}',
              date: day("2026-08-17"),
              series: "EQ",
              source: "nse-sec-list",
            },
          ],
        },
        referenceByKind: {
          SURVEILLANCE: day("2026-08-17"),
          PRICE_BAND: day("2026-08-17"),
        },
      },
    });
    const r = await getStockFlagsAndIndexes(ARGS, h.deps);
    assert.ok(r.success);
    assert.deepEqual(
      r.data.data.headline.map((b) => b.kind),
      ["SURVEILLANCE"],
    );
    assert.equal(r.data.source, "nse-gsm-api");
  });

  it("writes the closed-market TTL under the discover/_global namespace", async () => {
    const closed = mkDeps({
      isLive: false,
      db: {
        memberships: [
          { indexId: "nifty50", lastSeen: day("2026-08-14"), removedOn: null },
        ],
      },
    });
    await getStockFlagsAndIndexes(ARGS, closed.deps);
    assert.equal(closed.cacheSets.length, 1);
    assert.equal(closed.cacheSets[0]?.module, "discover");
    assert.equal(closed.cacheSets[0]?.scope, "_global");
    assert.equal(closed.cacheSets[0]?.key, "stock-flags:RELIANCE:NSE:60");
    assert.equal(closed.cacheSets[0]?.ttl, 6 * 60 * 60);

    const live = mkDeps({
      isLive: true,
      db: {
        memberships: [
          { indexId: "nifty50", lastSeen: day("2026-08-14"), removedOn: null },
        ],
      },
    });
    await getStockFlagsAndIndexes(ARGS, live.deps);
    assert.equal(live.cacheSets[0]?.ttl, 30 * 60);
  });

  it("reads IndexMembership on its open interval and skips the fallback", async () => {
    // `IndexConstituent` has no [symbol] index, so a read of it is a collection
    // scan. It must not fire when membership already answered.
    const h = mkDeps({
      db: {
        memberships: [
          {
            indexId: "nifty50",
            addedOn: day("2026-04-01"),
            firstSeen: day("2026-01-02"),
            lastSeen: day("2026-08-14"),
            removedOn: null,
          },
        ],
      },
    });
    const r = await getStockFlagsAndIndexes(ARGS, h.deps);
    assert.ok(r.success);
    assert.deepEqual(h.calls.indexMembership[0]?.where, {
      symbol: "RELIANCE",
      removedOn: null,
    });
    assert.equal(h.calls.indexConstituent.length, 0, "no collection scan");
    assert.deepEqual(r.data.data.indexes, [
      {
        indexId: "nifty50",
        label: "Nifty 50",
        addedOn: "2026-04-01T00:00:00.000Z",
        lastSeen: "2026-08-14T00:00:00.000Z",
        fallback: false,
      },
    ]);
    assert.equal(
      r.data.fallback,
      undefined,
      "primary source ⇒ no fallback mark",
    );
  });

  it("falls back to IndexConstituent and LABELS the downgrade", async () => {
    const h = mkDeps({
      db: {
        memberships: [],
        constituents: [
          { indexId: "nifty500", lastSyncedAt: day("2026-08-14") },
        ],
      },
    });
    const r = await getStockFlagsAndIndexes(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(h.calls.indexConstituent.length, 1);
    assert.deepEqual(h.calls.indexConstituent[0]?.where, {
      symbol: "RELIANCE",
    });
    assert.equal(r.data.data.indexes[0]?.fallback, true);
    assert.equal(
      r.data.data.indexes[0]?.addedOn,
      null,
      "the snapshot model has no join date — do not invent one",
    );
    assert.equal(
      r.data.fallback,
      true,
      "an unlabelled fallback is a silent downgrade",
    );
    assert.ok(r.data.note && r.data.note.length > 0);
  });

  it("returns a sanitised error instead of leaking the DB message", async () => {
    const h = mkDeps({ db: { throwOn: "stockFlag" } });
    const r = await getStockFlagsAndIndexes(ARGS, h.deps);
    assert.equal(r.success, false);
    assert.equal(
      r.success === false && r.error,
      "Failed to load exchange flags",
    );
    assert.ok(
      !(r.success === false && r.error.includes("connection string")),
      "internal detail must not reach the client",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.2 — delivery
// ════════════════════════════════════════════════════════════════════════════

describe("14c.2 getStockDeliveryTrend", () => {
  it("resolves the instrument first — DailyPrice is keyed on instrumentId", async () => {
    const h = mkDeps({
      db: {
        instrument: { id: "inst-1" },
        daily: [
          {
            date: day("2026-08-14"),
            deliveryPct: 40,
            deliveryQty: 1_000_000n,
            avgPrice: 1450.25,
            trades: 98_765,
            close: 1456.4,
            source: "BHAVCOPY",
          },
        ],
      },
    });
    const r = await getStockDeliveryTrend(ARGS, h.deps);
    assert.ok(r.success);
    assert.deepEqual(h.calls.instrumentMapping[0]?.where, {
      symbol: "RELIANCE",
      exchange: "NSE",
      isActive: true,
    });
    assert.deepEqual(h.calls.dailyPrice[0]?.where, { instrumentId: "inst-1" });
    assert.deepEqual(h.calls.dailyPrice[0]?.orderBy, { date: "desc" });
    assert.equal(h.calls.dailyPrice[0]?.take, 60);
    assert.equal(r.data.source, "BHAVCOPY");
    assert.equal(r.data.asOf, "2026-08-14T00:00:00.000Z");
    assert.equal(r.data.data.latest?.avgPrice, 1450.25);
    assert.equal(r.data.data.latest?.trades, 98_765);
  });

  it("an unresolvable instrument is an EMPTY section, not an error or a 404", async () => {
    const h = mkDeps({ db: { instrument: null } });
    const r = await getStockDeliveryTrend(ARGS, h.deps);
    assert.ok(r.success, "missing instrument must not 500 the stock page");
    assert.equal(r.data.empty, true);
    assert.equal(r.data.data.latest, null);
    assert.equal(h.calls.dailyPrice.length, 0);
    assert.equal(h.cacheSets.length, 0);
  });

  it("rows with NO delivery column are empty, not an all-null chip", async () => {
    // Yahoo rows carry OHLCV and nothing else. `rows.length > 0` alone would
    // render a delivery chip made entirely of nulls and call it data.
    const h = mkDeps({
      db: {
        instrument: { id: "inst-1" },
        daily: [
          {
            date: day("2026-08-14"),
            deliveryPct: null,
            close: 100,
            source: "YAHOO",
          },
          {
            date: day("2026-08-13"),
            deliveryPct: null,
            close: 99,
            source: "YAHOO",
          },
        ],
      },
    });
    const r = await getStockDeliveryTrend(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.empty, true);
    assert.equal(r.data.data.mean20, null);
    assert.equal(h.cacheSets.length, 0);
  });

  it("attributes the chip to the session the number CAME from, not the newest row", async () => {
    // B1 — the bhavcopy for 14-Aug has not landed, so the newest DailyPrice row
    // is Yahoo's: OHLCV, no delivery columns, `source: "YAHOO"`. Stamping the
    // envelope from `rows[0]` credits YAHOO with a delivery figure it never
    // published and dates the panel to a day nothing was measured.
    const h = mkDeps({
      db: {
        instrument: { id: "inst-1" },
        daily: [
          {
            date: day("2026-08-14"),
            deliveryPct: null,
            close: 1456.4,
            source: "YAHOO",
          },
          { date: day("2026-08-13"), deliveryPct: 58.2, source: "BHAVCOPY" },
          { date: day("2026-08-12"), deliveryPct: 61.4, source: "BHAVCOPY" },
          { date: day("2026-08-11"), deliveryPct: 55.9, source: "BHAVCOPY" },
        ],
      },
    });
    const r = await getStockDeliveryTrend(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.data.priceSource, "BHAVCOPY");
    assert.equal(r.data.source, "BHAVCOPY");
    assert.equal(r.data.asOf, "2026-08-13T00:00:00.000Z");
    assert.equal(r.data.data.latest?.deliveryPct, 58.2);
    assert.equal(r.data.data.vsMean20, -0.3);
    assert.equal(r.data.empty, false, "three reported sessions is not empty");
  });

  it("notes the honest n/window when NSE printed `-` on some sessions", async () => {
    const h = mkDeps({
      db: {
        instrument: { id: "inst-1" },
        daily: [
          { date: day("2026-08-14"), deliveryPct: 40, source: "BHAVCOPY" },
          { date: day("2026-08-13"), deliveryPct: null, source: "BHAVCOPY" },
          { date: day("2026-08-12"), deliveryPct: 60, source: "BHAVCOPY" },
        ],
      },
    });
    const r = await getStockDeliveryTrend(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.data.mean20, 50, "null sessions must not average as 0");
    assert.equal(r.data.data.n20, 2);
    assert.equal(r.data.data.window20, 3);
    assert.match(r.data.note ?? "", /2 of the last 3 sessions/);
    assert.equal(h.cacheSets[0]?.key, "stock-delivery:RELIANCE:NSE");
    assert.equal(h.cacheSets[0]?.ttl, 6 * 60 * 60);
  });

  it("never lets a BigInt deliveryQty reach the JSON boundary", async () => {
    const h = mkDeps({
      db: {
        instrument: { id: "inst-1" },
        daily: [
          {
            date: day("2026-08-14"),
            deliveryPct: 40,
            deliveryQty: 1_234_567_890_123n,
            source: "BHAVCOPY",
          },
        ],
      },
    });
    const r = await getStockDeliveryTrend(ARGS, h.deps);
    assert.ok(r.success);
    assert.doesNotThrow(() => JSON.stringify(r.data));
    assert.equal(r.data.data.latest?.deliveryQty, 1_234_567_890_123);
  });

  it("returns a sanitised error on a DB failure", async () => {
    const h = mkDeps({ db: { throwOn: "instrumentMapping" } });
    const r = await getStockDeliveryTrend(ARGS, h.deps);
    assert.equal(r.success, false);
    assert.equal(
      r.success === false && r.error,
      "Failed to load delivery data",
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 14c.3 — F&O
// ════════════════════════════════════════════════════════════════════════════

describe("14c.3 getStockDerivatives", () => {
  const summaryRow = {
    date: day("2026-08-14"),
    futOi: 12_000_000n,
    futOiChange: 2_000_000n,
    futBasisPct: 0.42,
    pcrOi: 1.15,
    pcrVol: 0.88,
    maxPain: 1450,
    maxPainExpiry: day("2026-08-27"),
    rolloverPct: 63.4,
    oiBuildup: "LONG",
    nearFutExpiry: day("2026-08-27"),
    nearFutOi: 9_000_000n,
    nearFutClose: 1462.5,
    callOi: 5_000_000n,
    putOi: 5_750_000n,
    callVol: 800_000n,
    putVol: 704_000n,
    underlyingClose: 1456.4,
    source: "BHAVCOPY_HIST",
  };

  it("GATES on DerivativeSummary — a cash-only stock touches nothing else", async () => {
    // The gate query IS the data query, so it costs nothing extra; the point
    // here is that a non-F&O stock must not render an empty F&O tab AND must
    // not pay for SLB/MWPL/ban reads.
    const h = mkDeps({ db: { summary: null } });
    const r = await getStockDerivatives(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(r.data.data.isFno, false);
    assert.equal(r.data.empty, true);
    assert.equal(h.calls.slbFindFirst.length, 0);
    assert.equal(h.calls.mwplDaily.length, 0);
    assert.equal(h.calls.stockFlag.length, 0);
    assert.equal(h.cacheSets.length, 0, "never cache the empty gate answer");
  });

  it("keeps the SLB ladder per-series for the LATEST day only", async () => {
    // MONEY-1201: summing across series discarded 84.2% of open borrow
    // interest. The second query is keyed on the exact latest date rather than
    // being a `take` over history, so a day is never sliced in half either.
    const h = mkDeps({
      db: {
        summary: summaryRow,
        slbLatest: { date: day("2026-08-13") },
        slbRows: [
          {
            series: "AUG2026",
            openQty: 100_000,
            openValue: 5_000_000,
            expiryDate: day("2026-08-27"),
          },
          {
            series: "SEP2026",
            openQty: 300_000,
            openValue: 15_000_000,
            expiryDate: day("2026-09-24"),
          },
          {
            series: "OCT2026",
            openQty: 600_000,
            openValue: 30_000_000,
            expiryDate: day("2026-10-29"),
          },
        ],
      },
    });
    const r = await getStockDerivatives(ARGS, h.deps);
    assert.ok(r.success);
    assert.deepEqual(h.calls.slbFindMany[0]?.where, {
      symbol: "RELIANCE",
      exchange: "NSE",
      date: day("2026-08-13"),
    });
    assert.equal(
      r.data.data.slb?.seriesCount,
      3,
      "series must NOT be collapsed",
    );
    assert.equal(r.data.data.slb?.totalOpenQty, 1_000_000);
    assert.equal(r.data.data.slbDate, "2026-08-13T00:00:00.000Z");
  });

  it("queries MwplDaily WITHOUT exchange — that model has no such column", async () => {
    const h = mkDeps({
      db: {
        summary: summaryRow,
        mwpl: {
          date: day("2026-08-14"),
          notionalOi: 987_654_321.5,
          futEquivOi: 140_455_762.42,
          mwpl: null,
          utilisationPct: null,
          source: "nse-mwpl",
        },
      },
    });
    const r = await getStockDerivatives(ARGS, h.deps);
    assert.ok(r.success);
    assert.deepEqual(h.calls.mwplDaily[0]?.where, { symbol: "RELIANCE" });
    assert.equal(r.data.data.mwpl?.notionalOi, 987_654_321.5);
    assert.equal(
      r.data.data.mwpl?.band,
      null,
      "utilisationPct is null on every row today ⇒ no band, and no all-clear",
    );
  });

  it("derives ban activity from the DATA's trading day, not the wall clock", async () => {
    const active = mkDeps({
      db: {
        summary: summaryRow, // 2026-08-14
        flagsByKind: {
          FO_BAN: [
            {
              kind: "FO_BAN",
              value: "BAN",
              date: day("2026-08-14"),
              series: null,
              source: "nse-fo-secban",
            },
            {
              kind: "FO_BAN",
              value: "BAN",
              date: day("2026-08-13"),
              series: null,
              source: "nse-fo-secban",
            },
          ],
        },
      },
    });
    const r = await getStockDerivatives(ARGS, active.deps);
    assert.ok(r.success);
    assert.deepEqual(active.calls.stockFlag[0]?.where, {
      symbol: "RELIANCE",
      exchange: "NSE",
      kind: "FO_BAN",
    });
    assert.equal(r.data.data.ban?.active, true);
    assert.equal(r.data.data.ban?.observedSessions, 2);
    assert.equal(r.data.data.ban?.since, "2026-08-13T00:00:00.000Z");

    const stale = mkDeps({
      db: {
        summary: summaryRow,
        flagsByKind: {
          FO_BAN: [
            {
              kind: "FO_BAN",
              value: "BAN",
              date: day("2026-06-02"),
              series: null,
              source: "nse-fo-secban",
            },
          ],
        },
      },
    });
    const r2 = await getStockDerivatives(ARGS, stale.deps);
    assert.ok(r2.success);
    assert.equal(
      r2.data.data.ban?.active,
      false,
      "a June ban is not in force in August",
    );
  });

  it("coerces every BigInt so the F&O payload survives JSON.stringify", async () => {
    const h = mkDeps({ db: { summary: summaryRow } });
    const r = await getStockDerivatives(ARGS, h.deps);
    assert.ok(r.success);
    assert.doesNotThrow(() => JSON.stringify(r.data));
    assert.equal(r.data.data.summary?.futOi, 12_000_000);
    assert.equal(r.data.data.summary?.futOiChangePct, 20);
    assert.equal(r.data.data.summary?.buildup?.label, "Long buildup");
    assert.equal(r.data.empty, false);
    assert.equal(r.data.asOf, "2026-08-14T00:00:00.000Z");
    assert.equal(r.data.source, "BHAVCOPY_HIST");
    assert.equal(h.cacheSets[0]?.key, "stock-derivatives:RELIANCE:NSE");
    assert.equal(h.cacheSets[0]?.ttl, 6 * 60 * 60);
  });

  it("cache HIT short-circuits the gate query", async () => {
    const h = mkDeps({
      cached: {
        data: {
          isFno: true,
          summary: null,
          slb: null,
          slbDate: null,
          mwpl: null,
          ban: null,
        },
        source: null,
        asOf: null,
        empty: false,
      },
    });
    const r = await getStockDerivatives(ARGS, h.deps);
    assert.ok(r.success);
    assert.equal(h.calls.derivativeSummary.length, 0);
    assert.equal(h.cacheGets[0]?.key, "stock-derivatives:RELIANCE:NSE");
  });

  it("returns a sanitised error on a DB failure", async () => {
    const h = mkDeps({ db: { throwOn: "derivativeSummary" } });
    const r = await getStockDerivatives(ARGS, h.deps);
    assert.equal(r.success, false);
    assert.equal(
      r.success === false && r.error,
      "Failed to load derivatives data",
    );
  });
});
