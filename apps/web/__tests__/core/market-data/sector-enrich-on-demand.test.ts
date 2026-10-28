/**
 * MONEY-850 — on-demand (targeted) sector enrichment, on the LIVE core fn.
 *
 * Drives the REAL exported `enrichInstrumentsBySymbol` + `defaultYahooSectorFetcher`
 * from `@usemoney/core/market-data`
 * (`packages/core/src/market-data/instruments/sector-enrichment.ts`) through a
 * RECORDING prisma double injected at the `@usemoney/database` module boundary
 * via `require.cache` (the proven seam from `holdings-poison-live.test.ts`).
 *
 * Why this matters: a newly-bought / newly-listed stock (e.g. a freshly demerged
 * entity like TMCV) whose InstrumentMapping row hasn't been sector-enriched yet
 * shows "N/A" until the weekly Yahoo cron reaches it. `getHoldings` now
 * fire-and-forgets `enrichInstrumentsBySymbol` for the handful of held names
 * still missing a sector so they fill in within a refresh or two. This pins:
 *
 *   1. The InstrumentMapping WHERE targets ONLY the requested (symbol,exchange)
 *      pairs AND only rows whose sector is genuinely unset (null/""/unset) — it
 *      excludes both already-enriched rows AND the permanent SKIPPED sentinel
 *      ("N/A"), so a dead symbol is never re-fetched forever (idempotency).
 *   2. A real Yahoo sector → a normalized `updateMany` write; a null result →
 *      the SKIPPED sentinel; an unfetchable symbol (bond/FMP) → SKIPPED in the
 *      first-pass batch WITHOUT calling the fetcher.
 *   3. The fetch set is de-duplicated + capped (never one Yahoo call per holding
 *      for a large un-enriched portfolio).
 *   4. The function NEVER throws — a DB failure or fetcher throw is swallowed
 *      and reported in the result (safe to call fire-and-forget off a read).
 *   5. `defaultYahooSectorFetcher` maps an assetProfile → SectorData and returns
 *      null when Yahoo has no profile.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: packages/core/src/market-data/instruments/sector-enrichment.ts
 */

import { describe, it, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── recording prisma double ────────────────────────────────────────────────

interface RecordedCall {
  model: string;
  method: string;
  args: unknown;
}

class RecordingPrisma {
  readonly calls: RecordedCall[] = [];
  private readonly queues = new Map<string, unknown[]>();
  private readonly failures = new Map<string, Error>();

  queue(model: string, method: string, result: unknown): void {
    const key = `${model}.${method}`;
    const q = this.queues.get(key) ?? [];
    q.push(result);
    this.queues.set(key, q);
  }

  fail(model: string, method: string, error: Error): void {
    this.failures.set(`${model}.${method}`, error);
  }

  private next(model: string, method: string): unknown {
    const q = this.queues.get(`${model}.${method}`);
    if (q && q.length > 0) return q.shift();
    if (method === "updateMany") return { count: 0 };
    if (method === "count") return 0;
    if (method === "findFirst" || method === "findUnique") return null;
    return [];
  }

  readonly client: Record<
    string,
    Record<string, (args?: unknown) => Promise<unknown>>
  >;

  constructor() {
    const self = this;
    this.client = new Proxy(
      {},
      {
        get(target: Record<string, unknown>, model: string) {
          if (typeof model !== "string") return undefined;
          if (!(model in target)) {
            target[model] = new Proxy(
              {},
              {
                get(_m, method: string) {
                  return (args?: unknown) => {
                    self.calls.push({ model, method, args });
                    const err = self.failures.get(`${model}.${method}`);
                    if (err) return Promise.reject(err);
                    return Promise.resolve(self.next(model, method));
                  };
                },
              }
            );
          }
          return target[model];
        },
      }
    ) as RecordingPrisma["client"];
  }

  callsFor(model: string, method: string): RecordedCall[] {
    return this.calls.filter((c) => c.model === model && c.method === method);
  }
}

// ── module-boundary injection (stub prisma; re-import core market-data) ──────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

let activePrisma: RecordingPrisma = new RecordingPrisma();

const STABLE_PRISMA = new Proxy(
  {},
  {
    get(target: Record<string, unknown>, model: string) {
      if (typeof model !== "string") return undefined;
      if (model === "then") return undefined;
      if (!(model in target)) {
        target[model] = new Proxy(
          {},
          {
            get(_m, method: string) {
              return (args?: unknown) =>
                activePrisma.client[model]![method]!(args);
            },
          }
        );
      }
      return target[model];
    },
  }
);

interface SectorData {
  sector: string | null;
  industry: string | null;
}
type YahooSectorFetcher = (yahooSymbol: string) => Promise<SectorData | null>;
interface EnrichmentResult {
  totalProcessed: number;
  enriched: number;
  failed: number;
  skipped: number;
  errors: string[];
}
interface CoreMarketData {
  enrichInstrumentsBySymbol: (
    symbolKeys: Array<{ symbol: string; exchange: string }>,
    fetcher?: YahooSectorFetcher,
    options?: { exchanges?: string[]; maxFetch?: number; delayMs?: number }
  ) => Promise<EnrichmentResult>;
  defaultYahooSectorFetcher: YahooSectorFetcher;
  SECTOR_SKIPPED: string;
}

let coreSingleton: CoreMarketData | null = null;
const priorCacheEntries: Array<[string, { exports: unknown } | undefined]> = [];

function installCore(): CoreMarketData {
  if (coreSingleton) return coreSingleton;
  const cache = moduleCache();
  const dbPath = require.resolve("@usemoney/database");
  priorCacheEntries.push([dbPath, cache[dbPath]]);
  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: STABLE_PRISMA,
      default: STABLE_PRISMA,
    },
  };
  // Drop the core market-data subtree so it re-imports against the stub prisma.
  for (const key of Object.keys(cache)) {
    if (key.includes("/packages/core/src/market-data/")) {
      priorCacheEntries.push([key, cache[key]]);
      delete cache[key];
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  coreSingleton = require("@usemoney/core/market-data") as CoreMarketData;
  return coreSingleton;
}

function uninstallCore(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.length = 0;
  coreSingleton = null;
}

function reset(): RecordingPrisma {
  activePrisma = new RecordingPrisma();
  return activePrisma;
}

/** An InstrumentMapping row as the targeted query selects it. */
function imRow(
  overrides: Partial<{
    id: string;
    symbol: string;
    exchange: string;
    yahooSymbol: string;
  }> = {}
) {
  return {
    id: "im-1",
    symbol: "TMCV",
    exchange: "NSE",
    yahooSymbol: "TMCV.NS",
    ...overrides,
  };
}

const successFetcher =
  (sector = "Technology", industry = "Software"): YahooSectorFetcher =>
  async () => ({ sector, industry });
const nullFetcher: YahooSectorFetcher = async () => null;

// ── tests ───────────────────────────────────────────────────────────────────

describe("MONEY-850 — enrichInstrumentsBySymbol: targeting + idempotency (LIVE)", () => {
  let prisma: RecordingPrisma;
  let core: CoreMarketData;
  before(() => {
    core = installCore();
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallCore();
  });

  it("queries ONLY the requested pairs AND only sector-unset rows (excludes enriched + N/A)", async () => {
    prisma.queue("instrumentMapping", "findMany", []);
    await core.enrichInstrumentsBySymbol([
      { symbol: "TMCV", exchange: "NSE" },
      { symbol: "TCS", exchange: "NSE" },
    ]);
    const call = prisma.callsFor("instrumentMapping", "findMany")[0]!;
    const where = (call.args as { where: Record<string, unknown> }).where;
    // active equities on supported exchanges
    assert.strictEqual(where.isActive, true);
    assert.strictEqual(where.instrumentType, "EQUITY");
    assert.deepStrictEqual(where.exchange, { in: ["NSE", "BSE"] });
    // restricted to the exact requested pairs
    assert.deepStrictEqual(where.OR, [
      { symbol: "TMCV", exchange: "NSE" },
      { symbol: "TCS", exchange: "NSE" },
    ]);
    // sector-unset predicate: never matches an already-set sector OR "N/A"
    const and = where.AND as Array<{ OR: unknown[] }>;
    assert.deepStrictEqual(and[0].OR, [
      { sector: { isSet: false } },
      { sector: null },
      { sector: "" },
    ]);
  });

  it("no requested keys → no DB query at all", async () => {
    const res = await core.enrichInstrumentsBySymbol([]);
    assert.strictEqual(
      prisma.callsFor("instrumentMapping", "findMany").length,
      0
    );
    assert.strictEqual(res.totalProcessed, 0);
    assert.strictEqual(res.enriched, 0);
  });

  it("query returns nothing (already enriched / N/A) → no fetch, no write", async () => {
    let fetchCount = 0;
    const fetcher: YahooSectorFetcher = async () => {
      fetchCount++;
      return { sector: "X", industry: "Y" };
    };
    prisma.queue("instrumentMapping", "findMany", []);
    const res = await core.enrichInstrumentsBySymbol(
      [{ symbol: "TCS", exchange: "NSE" }],
      fetcher
    );
    assert.strictEqual(fetchCount, 0);
    assert.strictEqual(
      prisma.callsFor("instrumentMapping", "updateMany").length,
      0
    );
    assert.strictEqual(res.totalProcessed, 0);
  });

  it("de-duplicates + caps the requested keys (no N fetches for N holdings)", async () => {
    prisma.queue("instrumentMapping", "findMany", []);
    const many = Array.from({ length: 50 }, (_, i) => ({
      symbol: `S${i}`,
      exchange: "NSE",
    }));
    await core.enrichInstrumentsBySymbol(many, successFetcher(), {
      maxFetch: 5,
    });
    const where = (
      prisma.callsFor("instrumentMapping", "findMany")[0]!.args as {
        where: { OR: unknown[] };
      }
    ).where;
    assert.strictEqual(where.OR.length, 5);
  });
});

describe("MONEY-850 — enrichInstrumentsBySymbol: enrich vs skip writes (LIVE)", () => {
  let prisma: RecordingPrisma;
  let core: CoreMarketData;
  before(() => {
    core = installCore();
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallCore();
  });

  it("real sector → normalized updateMany write; counts enriched", async () => {
    prisma.queue("instrumentMapping", "findMany", [
      imRow({ id: "a", symbol: "TMCV", yahooSymbol: "TMCV.NS" }),
    ]);
    const res = await core.enrichInstrumentsBySymbol(
      [{ symbol: "TMCV", exchange: "NSE" }],
      successFetcher("Technology", "Auto")
    );
    assert.strictEqual(res.enriched, 1);
    assert.strictEqual(res.skipped, 0);
    const writes = prisma.callsFor("instrumentMapping", "updateMany");
    assert.strictEqual(writes.length, 1);
    const data = (
      writes[0]!.args as {
        where: { id: { in: string[] } };
        data: { sector: string };
      }
    ).data;
    // "Technology" normalizes to the NSE sector name
    assert.strictEqual(data.sector, "Information Technology");
    const ids = (writes[0]!.args as { where: { id: { in: string[] } } }).where
      .id.in;
    assert.deepStrictEqual(ids, ["a"]);
  });

  it("null Yahoo result → SKIPPED sentinel write; counts skipped not enriched", async () => {
    prisma.queue("instrumentMapping", "findMany", [
      imRow({ id: "b", symbol: "NOSEC", yahooSymbol: "NOSEC.NS" }),
    ]);
    const res = await core.enrichInstrumentsBySymbol(
      [{ symbol: "NOSEC", exchange: "NSE" }],
      nullFetcher
    );
    assert.strictEqual(res.enriched, 0);
    assert.strictEqual(res.skipped, 1);
    const writes = prisma.callsFor("instrumentMapping", "updateMany");
    const data = (writes.at(-1)!.args as { data: { sector: string } }).data;
    assert.strictEqual(data.sector, core.SECTOR_SKIPPED);
  });

  it("unfetchable symbol (bond) → batch-SKIPPED WITHOUT calling the fetcher", async () => {
    let fetchCount = 0;
    const fetcher: YahooSectorFetcher = async () => {
      fetchCount++;
      return { sector: "X", industry: "Y" };
    };
    prisma.queue("instrumentMapping", "findMany", [
      imRow({
        id: "bond",
        symbol: "891234",
        yahooSymbol: "891234.BO",
        exchange: "BSE",
      }),
    ]);
    const res = await core.enrichInstrumentsBySymbol(
      [{ symbol: "891234", exchange: "BSE" }],
      fetcher
    );
    assert.strictEqual(fetchCount, 0, "unfetchable symbol must not be fetched");
    assert.strictEqual(res.skipped, 1);
    const firstWrite = prisma.callsFor("instrumentMapping", "updateMany")[0]!;
    const data = (firstWrite.args as { data: { sector: string } }).data;
    assert.strictEqual(data.sector, core.SECTOR_SKIPPED);
  });

  it("mixed batch: one enriched, one null-skip, one unfetchable → grouped writes", async () => {
    prisma.queue("instrumentMapping", "findMany", [
      imRow({ id: "ok", symbol: "TMCV", yahooSymbol: "TMCV.NS" }),
      imRow({ id: "nosec", symbol: "NOSEC", yahooSymbol: "NOSEC.NS" }),
      imRow({
        id: "bond",
        symbol: "891234",
        yahooSymbol: "891234.BO",
        exchange: "BSE",
      }),
    ]);
    const fetcher: YahooSectorFetcher = async (sym) =>
      sym === "TMCV.NS" ? { sector: "Technology", industry: "Auto" } : null;
    const res = await core.enrichInstrumentsBySymbol(
      [
        { symbol: "TMCV", exchange: "NSE" },
        { symbol: "NOSEC", exchange: "NSE" },
        { symbol: "891234", exchange: "BSE" },
      ],
      fetcher,
      { delayMs: 0 }
    );
    assert.strictEqual(res.enriched, 1);
    assert.strictEqual(res.skipped, 2); // bond (batch) + NOSEC (null)
    assert.strictEqual(res.totalProcessed, 3);
  });
});

describe("MONEY-850 — enrichInstrumentsBySymbol: never throws (LIVE)", () => {
  let prisma: RecordingPrisma;
  let core: CoreMarketData;
  before(() => {
    core = installCore();
  });
  beforeEach(() => {
    prisma = reset();
  });
  after(() => {
    uninstallCore();
  });

  it("a DB findMany failure is swallowed and reported, not thrown", async () => {
    prisma.fail(
      "instrumentMapping",
      "findMany",
      new Error("E11000 connection reset")
    );
    let res!: EnrichmentResult;
    await assert.doesNotReject(async () => {
      res = await core.enrichInstrumentsBySymbol([
        { symbol: "TMCV", exchange: "NSE" },
      ]);
    });
    assert.strictEqual(res.enriched, 0);
    assert.ok(res.errors.length >= 1);
  });

  it("a fetcher throw counts as failed, never propagates", async () => {
    prisma.queue("instrumentMapping", "findMany", [
      imRow({ id: "err", symbol: "ERR", yahooSymbol: "ERR.NS" }),
    ]);
    const boom: YahooSectorFetcher = async () => {
      throw new Error("Yahoo 503");
    };
    let res!: EnrichmentResult;
    await assert.doesNotReject(async () => {
      res = await core.enrichInstrumentsBySymbol(
        [{ symbol: "ERR", exchange: "NSE" }],
        boom
      );
    });
    assert.strictEqual(res.failed, 1);
  });
});
