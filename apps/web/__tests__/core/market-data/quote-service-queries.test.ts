/**
 * MONEY-704 / MONEY-1124 — quote-service query shape + upsert batching
 * (REAL source, recording Prisma double).
 *
 * Drives the ACTUAL exported `getLatestQuotes` / `refreshAllQuotes` from
 * `packages/core/src/market-data/prices/quote-service.ts` (via the
 * `@usemoney/core/market-data` barrel the web app itself imports), with
 * `@usemoney/database` swapped for a recording double through the established
 * `require.cache` seam. No DB, no network, no timers.
 *
 * WHY THIS FILE EXISTS — this is the regression guard against the
 * full-collection scans coming back. `getLatestQuotes` used to run
 * `prisma.latestQuote.findMany({})` and `prisma.instrumentMapping.findMany({})`
 * and then `.filter()` in Node, under comments claiming Prisma compiles
 * `{ in: [...] }` into `$expr` with N `$eq` comparisons. It does not — it emits
 * a plain `$in`, and `LatestQuote.instrumentId` is `@unique`, so the bounded
 * form is an index lookup. These tests assert the WHERE clause is present and
 * bounded, so "just filter it in JS" cannot be reintroduced silently.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: packages/core/src/market-data/prices/quote-service.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
// Derived, not hard-coded: the batch width is a tuning constant (it must stay
// at or under half the Prisma pool), and a test that repeats the number just
// has to be edited every time it moves, which is how it drifts out of sync.
//
// Imported from the PURE logic module, not the `@usemoney/core/market-data`
// barrel: the barrel reaches the Prisma-backed service, which needs DATABASE_URL
// and would load before this file's require.cache stubs are installed.
import { UPSERT_BATCH_SIZE } from "../../../../../packages/core/src/market-data/prices/quote-logic";

// ── recorder ────────────────────────────────────────────────────────

interface PrismaCall {
  model: string;
  method: string;
  args: Record<string, unknown>;
}

interface InstrumentRow {
  id: string;
  yahooSymbol: string;
  instrumentType?: string;
}

interface QuoteRow {
  instrumentId: string;
  price: number;
  change: number | null;
  changePercent: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  previousClose: number | null;
  volume: number | null;
  marketCap: number | null;
  timestamp: Date;
  updatedAt: Date;
  source: string;
}

interface Harness {
  calls: PrismaCall[];
  /** LatestQuote rows the DB "contains", keyed by instrumentId. */
  quotes: Map<string, QuoteRow>;
  /** InstrumentMapping rows the DB "contains", keyed by id. */
  instruments: Map<string, InstrumentRow>;
  /** instrumentIds whose upsert should reject (with a NON-conflict error). */
  upsertRejects: Set<string>;
  /** Concurrency instrumentation for the batched upserts. */
  inFlight: number;
  maxInFlight: number;
  /** Number of times concurrency rose from 0 → 1 (i.e. batch starts). */
  batchStarts: number;
  upsertOrder: string[];
}

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const CORE_MARKET_DATA = "@usemoney/core/market-data";
const priorEntries = new Map<string, { exports: unknown } | undefined>();

function snapshotOnce(path: string): void {
  if (!priorEntries.has(path)) priorEntries.set(path, moduleCache()[path]);
}

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorEntries.clear();
}

function freshHarness(): Harness {
  return {
    calls: [],
    quotes: new Map(),
    instruments: new Map(),
    upsertRejects: new Set(),
    inFlight: 0,
    maxInFlight: 0,
    batchStarts: 0,
    upsertOrder: [],
  };
}

function makeQuoteRow(instrumentId: string, updatedAt: Date): QuoteRow {
  return {
    instrumentId,
    price: 100,
    change: 1,
    changePercent: 1,
    open: 99,
    high: 101,
    low: 98,
    previousClose: 99,
    volume: 1000,
    marketCap: null,
    timestamp: updatedAt,
    updatedAt,
    source: "YAHOO",
  };
}

/** Extract the `in` array from a `{ field: { in: [...] } }` where clause. */
function inList(
  args: Record<string, unknown>,
  field: string
): string[] | undefined {
  const where = args.where as Record<string, unknown> | undefined;
  const clause = where?.[field] as { in?: string[] } | undefined;
  return clause?.in;
}

/**
 * The double reads the CURRENT harness on every call rather than capturing one:
 * `quote-service.ts` binds `prisma` at module load, so swapping the
 * `@usemoney/database` exports per test would not reach an already-loaded
 * service. One stable double + a mutable harness keeps every test isolated
 * without re-requiring the (heavy) market-data barrel.
 */
function makeRecordingPrisma(current: () => Harness): unknown {
  return {
    latestQuote: {
      findMany: (args: Record<string, unknown> = {}) => {
        const h = current();
        h.calls.push({ model: "latestQuote", method: "findMany", args });
        const ids = inList(args, "instrumentId");
        const rows = [...h.quotes.values()];
        return Promise.resolve(
          ids ? rows.filter((r) => ids.includes(r.instrumentId)) : rows
        );
      },
      upsert: async (args: Record<string, unknown>) => {
        const h = current();
        const where = args.where as { instrumentId: string };
        const id = where.instrumentId;
        if (h.inFlight === 0) h.batchStarts += 1;
        h.inFlight += 1;
        h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
        h.upsertOrder.push(id);
        try {
          // Yield across a few microtasks so genuinely-parallel work overlaps
          // while genuinely-sequential work does not. No timers involved.
          await Promise.resolve();
          await Promise.resolve();
          if (h.upsertRejects.has(id)) {
            throw new Error(`upsert failed for ${id}`);
          }
          const row = makeQuoteRow(id, new Date());
          h.quotes.set(id, row);
          return row;
        } finally {
          h.inFlight -= 1;
        }
      },
    },
    instrumentMapping: {
      findMany: (args: Record<string, unknown> = {}) => {
        const h = current();
        h.calls.push({ model: "instrumentMapping", method: "findMany", args });
        const ids = inList(args, "id");
        const where = (args.where ?? {}) as Record<string, unknown>;
        let rows = [...h.instruments.values()];
        if (ids) rows = rows.filter((r) => ids.includes(r.id));
        const typeFilter = (where.instrumentType as { in?: string[] })?.in;
        if (typeFilter) {
          rows = rows.filter(
            (r) => r.instrumentType && typeFilter.includes(r.instrumentType)
          );
        }
        return Promise.resolve(rows);
      },
    },
  };
}

interface QuoteServiceModule {
  getLatestQuotes: (
    instrumentIds: string[],
    fetchQuotes: (symbols: string[]) => Promise<Map<string, unknown>>,
    ttlMs?: number
  ) => Promise<Map<string, unknown>>;
  refreshAllQuotes: (
    fetchQuotes: (symbols: string[]) => Promise<Map<string, unknown>>,
    options?: { instrumentIds?: string[]; batchSize?: number }
  ) => Promise<{ refreshed: number; failed: number }>;
}

let harness: Harness = freshHarness();
let serviceModule: QuoteServiceModule | null = null;

/**
 * Install the double and load the real service ONCE, before anything else can
 * pull in `@usemoney/database`.
 */
function loadService(h: Harness): QuoteServiceModule {
  harness = h;
  if (serviceModule) return serviceModule;

  const cache = moduleCache();
  const dbPath = require.resolve("@usemoney/database");
  snapshotOnce(dbPath);

  const prisma = makeRecordingPrisma(() => harness);
  cache[dbPath] = { exports: { __esModule: true, prisma, default: prisma } };

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  serviceModule = require(CORE_MARKET_DATA) as QuoteServiceModule;
  return serviceModule;
}

function yahooQuote(symbol: string) {
  return {
    symbol,
    price: 250,
    change: 2,
    changePercent: 0.8,
    open: 248,
    high: 252,
    low: 247,
    previousClose: 248,
    volume: 5000,
    timestamp: new Date(),
  };
}

// ════════════════════════════════════════════════════════════════════
describe("MONEY-704 — quote-service uses bounded $in, never a collection scan", () => {
  let h: Harness;
  const originalError = console.error;

  beforeEach(() => {
    h = freshHarness();
  });

  after(() => {
    restoreCache();
    console.error = originalError;
  });

  // ── 3. $in query shape ──────────────────────────────────────────
  describe("getLatestQuotes query shape", () => {
    it("filters latest_quotes by a bounded instrumentId.in — NOT an absent/empty where", async () => {
      const ids = ["i1", "i2", "i3"];
      for (const id of ids) h.quotes.set(id, makeQuoteRow(id, new Date()));

      const svc = loadService(h);
      await svc.getLatestQuotes(ids, async () => new Map());

      const call = h.calls.find(
        (c) => c.model === "latestQuote" && c.method === "findMany"
      );
      assert.ok(call, "latestQuote.findMany must have run");
      assert.ok(
        call!.args.where,
        "MONEY-704 regression: latestQuote.findMany({}) reads the WHOLE collection"
      );
      assert.deepEqual(inList(call!.args, "instrumentId"), ids);
    });

    it("filters instrument_mappings by a bounded id.in when refreshing stale rows", async () => {
      const stale = new Date(Date.now() - 10 * 60 * 1000);
      h.quotes.set("i1", makeQuoteRow("i1", stale));
      h.instruments.set("i1", { id: "i1", yahooSymbol: "AAA.NS" });

      const svc = loadService(h);
      await svc.getLatestQuotes(["i1"], async () => new Map());

      const call = h.calls.find(
        (c) => c.model === "instrumentMapping" && c.method === "findMany"
      );
      assert.ok(call, "instrumentMapping.findMany must have run");
      assert.ok(
        call!.args.where,
        "MONEY-704 regression: a bare findMany reads the whole instrument universe"
      );
      assert.deepEqual(inList(call!.args, "id"), ["i1"]);
    });

    it("issues NO query at all for an empty id list", async () => {
      const svc = loadService(h);
      const out = await svc.getLatestQuotes([], async () => new Map());

      assert.equal(out.size, 0);
      assert.equal(h.calls.length, 0);
    });

    it("chunks a >500-id list into bounded queries instead of falling back to a scan", async () => {
      const ids = Array.from({ length: 1_250 }, (_, i) => `i${i}`);
      for (const id of ids) h.quotes.set(id, makeQuoteRow(id, new Date()));

      const svc = loadService(h);
      const out = await svc.getLatestQuotes(ids, async () => new Map());

      const quoteCalls = h.calls.filter((c) => c.model === "latestQuote");
      assert.equal(quoteCalls.length, 3, "ceil(1250/500) bounded queries");
      for (const call of quoteCalls) {
        const list = inList(call.args, "instrumentId");
        assert.ok(list, "every chunk must still carry a where clause");
        assert.ok(
          list!.length <= 500,
          `chunk of ${list!.length} exceeds the cap`
        );
      }
      assert.equal(out.size, 1_250, "the union covers every requested id");
    });

    it("fresh cached rows short-circuit before any instrument lookup", async () => {
      h.quotes.set("i1", makeQuoteRow("i1", new Date()));

      const svc = loadService(h);
      let fetched = 0;
      await svc.getLatestQuotes(["i1"], async () => {
        fetched += 1;
        return new Map();
      });

      assert.equal(fetched, 0, "a fresh DB row must not call Yahoo");
      assert.equal(
        h.calls.some((c) => c.model === "instrumentMapping"),
        false
      );
    });
  });

  describe("refreshAllQuotes query shape", () => {
    it("uses a bounded id.in when the caller supplies instrumentIds", async () => {
      h.instruments.set("i1", {
        id: "i1",
        yahooSymbol: "AAA.NS",
        instrumentType: "EQUITY",
      });

      const svc = loadService(h);
      await svc.refreshAllQuotes(async () => new Map(), {
        instrumentIds: ["i1"],
      });

      const call = h.calls.find((c) => c.model === "instrumentMapping");
      assert.ok(call);
      assert.deepEqual(inList(call!.args, "id"), ["i1"]);
      assert.equal(
        (call!.args.where as Record<string, unknown>).isActive,
        true,
        "the isActive predicate must stay in the DB"
      );
    });

    it("pushes the instrumentType filter into the DB for the full-universe sweep", async () => {
      h.instruments.set("eq", {
        id: "eq",
        yahooSymbol: "AAA.NS",
        instrumentType: "EQUITY",
      });
      h.instruments.set("bond", {
        id: "bond",
        yahooSymbol: "BBB.NS",
        instrumentType: "DEBT",
      });

      const svc = loadService(h);
      const seen: string[][] = [];
      await svc.refreshAllQuotes(async (symbols) => {
        seen.push(symbols);
        return new Map();
      });

      const call = h.calls.find((c) => c.model === "instrumentMapping");
      assert.ok(call);
      const where = call!.args.where as Record<string, unknown>;
      assert.deepEqual((where.instrumentType as { in: string[] }).in, [
        "EQUITY",
        "INDEX",
        "ETF",
      ]);
      assert.deepEqual(
        seen,
        [["AAA.NS"]],
        "the DEBT row must never reach Node, let alone Yahoo"
      );
    });
  });

  // ── 4. batched upserts ──────────────────────────────────────────
  describe("MONEY-1124 — upserts are batched, with per-symbol failure isolation", () => {
    function seedStale(count: number): string[] {
      const ids: string[] = [];
      const stale = new Date(Date.now() - 10 * 60 * 1000);
      for (let i = 0; i < count; i++) {
        const id = `i${i}`;
        ids.push(id);
        h.quotes.set(id, makeQuoteRow(id, stale));
        h.instruments.set(id, { id, yahooSymbol: `S${i}.NS` });
      }
      return ids;
    }

    it("60 symbols upsert in ceil(60/UPSERT_BATCH_SIZE) batches of at most UPSERT_BATCH_SIZE concurrent writes", async () => {
      const ids = seedStale(60);
      const svc = loadService(h);

      const out = await svc.getLatestQuotes(ids, async (symbols) => {
        const map = new Map<string, unknown>();
        for (const s of symbols) map.set(s, yahooQuote(s));
        return map;
      });

      assert.equal(out.size, 60);
      assert.equal(h.upsertOrder.length, 60);
      assert.equal(
        h.maxInFlight,
        UPSERT_BATCH_SIZE,
        "batch width must be UPSERT_BATCH_SIZE"
      );
      assert.equal(
        h.batchStarts,
        Math.ceil(60 / UPSERT_BATCH_SIZE),
        "ceil(60/UPSERT_BATCH_SIZE) batches"
      );
    });

    it("does NOT serialise: a single batch overlaps its writes", async () => {
      // Exactly one batch's worth, so the whole set must be in flight at once.
      const ids = seedStale(UPSERT_BATCH_SIZE);
      const svc = loadService(h);

      await svc.getLatestQuotes(ids, async (symbols) => {
        const map = new Map<string, unknown>();
        for (const s of symbols) map.set(s, yahooQuote(s));
        return map;
      });

      assert.equal(h.batchStarts, 1);
      assert.equal(
        h.maxInFlight,
        UPSERT_BATCH_SIZE,
        "one batch's worth of symbols must all be in flight together"
      );
    });

    it("one rejected symbol does not fail the rest of its batch", async () => {
      console.error = () => {};
      const ids = seedStale(30);
      h.upsertRejects.add("i7");

      const svc = loadService(h);
      const out = await svc.getLatestQuotes(ids, async (symbols) => {
        const map = new Map<string, unknown>();
        for (const s of symbols) map.set(s, yahooQuote(s));
        return map;
      });

      assert.equal(out.size, 29, "29 of 30 still resolved");
      assert.equal(out.has("i7"), false);
      assert.equal(
        h.upsertOrder.length,
        30,
        "every symbol was still attempted"
      );
      console.error = originalError;
    });

    it("a rejection in the FIRST batch does not stop the second batch running", async () => {
      console.error = () => {};
      const ids = seedStale(40);
      h.upsertRejects.add("i0");

      const svc = loadService(h);
      const out = await svc.getLatestQuotes(ids, async (symbols) => {
        const map = new Map<string, unknown>();
        for (const s of symbols) map.set(s, yahooQuote(s));
        return map;
      });

      assert.equal(h.batchStarts, Math.ceil(40 / UPSERT_BATCH_SIZE));
      assert.equal(out.size, 39);
      assert.equal(out.has("i39"), true, "the last batch still ran");
      console.error = originalError;
    });
  });
});
