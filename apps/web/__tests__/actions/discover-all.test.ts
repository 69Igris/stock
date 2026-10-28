/**
 * MONEY-620 — discover surface cross-action contracts (real handlers).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a SHADOW: it re-declared the previousClose>0 filter,
 * the ETF sort comparators, an MF "top performers" filter and the stock-
 * description cache decision tree — then asserted the COPIES, importing NOTHING
 * from any of the three sources it named (discover-indices.ts, discover-mf.ts,
 * stock-description.ts).
 *
 * The deep per-action behaviour now lives in the dedicated de-shadows
 * (discover-indices.test.ts, discover-mf.test.ts, stock-description.test.ts).
 * This file is repurposed as the cross-action CONTRACT suite the /discover page
 * actually depends on — driving the REAL exported actions through the
 * `require.cache` seam and pinning the input-cap / cache-first guards that keep
 * the discover surface cheap and safe:
 *   - getInstrumentsBySymbolsAction (indices): the empty / >50 cap short-circuits
 *     to [] with NO DB query (the page hydrates search results with this).
 *   - getMfsBySchemeCodesAction (mf): the same empty / >50 cap short-circuits to
 *     [] with NO service call.
 *   - getOrGenerateDescriptionAction (stock): a cache HIT returns instantly with
 *     NO DB / NO model — the per-card description must never hammer the model.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Sources: discover-indices.ts, discover-mf.ts, stock-description.ts
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const priorCacheEntries = new Map<string, { exports: unknown } | undefined>();
function snapshotOnce(path: string): void {
  if (!priorCacheEntries.has(path)) {
    priorCacheEntries.set(path, moduleCache()[path]);
  }
}

const INDICES_REL = "../../lib/actions/discover-indices";
const MF_REL = "../../lib/actions/discover-mf";
const STOCK_DESC_REL = "../../lib/actions/stock-description";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  for (const r of [INDICES_REL, MF_REL, STOCK_DESC_REL]) {
    delete cache[require.resolve(r)];
  }
}

// Shared recorders across the three modules.
const rec = {
  prismaCalls: 0,
  serviceCalls: 0,
  modelCalls: 0,
  descCacheHit: null as string | null,
};

function stubBoundaries(): void {
  const cache = moduleCache();
  const dbPath = require.resolve("@usemoney/database");
  const corePath = require.resolve("@usemoney/core");
  const servicesPath = require.resolve("@usemoney/services");
  const modelsPath = require.resolve("../../lib/gemini/models");
  for (const p of [dbPath, corePath, servicesPath, modelsPath]) snapshotOnce(p);

  const recordingModel = () =>
    new Proxy(
      {},
      {
        get() {
          return (..._a: unknown[]) => {
            rec.prismaCalls += 1;
            return Promise.resolve([]);
          };
        },
      }
    );
  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: new Proxy(
        {},
        {
          get() {
            return recordingModel();
          },
        }
      ),
    },
  };
  cache[corePath] = {
    exports: {
      __esModule: true,
      getCached: (_r: string, _s: string, kind: string) => {
        // Only the stock-description path uses a hit in these tests.
        if (kind === "description") return Promise.resolve(rec.descCacheHit);
        return Promise.resolve(null);
      },
      setCached: () => Promise.resolve(),
    },
  };
  cache[servicesPath] = {
    exports: {
      __esModule: true,
      getIndices: () => Promise.resolve({ success: true, data: [] }),
      getMfDiscoverData: () => Promise.resolve({ success: true, data: {} }),
      getMfsByCategory: () => Promise.resolve({ success: true, data: [] }),
      getMfsBySchemeCodes: () => {
        rec.serviceCalls += 1;
        return Promise.resolve({ success: true, data: [{ schemeCode: "1" }] });
      },
    },
  };
  cache[modelsPath] = {
    exports: {
      __esModule: true,
      getGeminiModel: () => ({}),
      generateWithTimeout: () => {
        rec.modelCalls += 1;
        return Promise.resolve("generated description");
      },
    },
  };
}

interface IndicesMod {
  getInstrumentsBySymbolsAction: (
    s: string[],
    t: "ETF" | "INDEX",
    y?: string[]
  ) => Promise<{ success: boolean; data?: unknown[] }>;
}
interface MfMod {
  getMfsBySchemeCodesAction: (
    c: string[]
  ) => Promise<{ success: boolean; data?: unknown[] }>;
}
interface StockDescMod {
  getOrGenerateDescriptionAction: (
    symbol: string,
    exchange: string
  ) => Promise<{ success: boolean; description?: string }>;
}

function loadAll(): {
  indices: IndicesMod;
  mf: MfMod;
  desc: StockDescMod;
} {
  const cache = moduleCache();
  stubBoundaries();
  for (const r of [INDICES_REL, MF_REL, STOCK_DESC_REL]) {
    delete cache[require.resolve(r)];
  }
  return {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    indices: require(INDICES_REL) as IndicesMod,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mf: require(MF_REL) as MfMod,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    desc: require(STOCK_DESC_REL) as StockDescMod,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — discover surface cross-action contracts (real handlers)", () => {
  after(() => {
    restoreCache();
  });

  it("indices: empty symbols → [] with NO DB query (cheap hydration)", async () => {
    rec.prismaCalls = 0;
    const { indices } = loadAll();
    const res = await indices.getInstrumentsBySymbolsAction([], "INDEX");
    assert.equal(res.success, true);
    assert.deepEqual(res.data, []);
    assert.equal(rec.prismaCalls, 0);
  });

  it("indices: >50 symbols → [] with NO DB query (cap)", async () => {
    rec.prismaCalls = 0;
    const { indices } = loadAll();
    const big = Array.from({ length: 51 }, (_, i) => `S${i}`);
    const res = await indices.getInstrumentsBySymbolsAction(big, "ETF");
    assert.deepEqual(res.data, []);
    assert.equal(rec.prismaCalls, 0);
  });

  it("mf: empty scheme codes → [] with NO service call", async () => {
    rec.serviceCalls = 0;
    const { mf } = loadAll();
    const res = await mf.getMfsBySchemeCodesAction([]);
    assert.deepEqual(res.data, []);
    assert.equal(rec.serviceCalls, 0);
  });

  it("mf: >50 scheme codes → [] with NO service call (cap)", async () => {
    rec.serviceCalls = 0;
    const { mf } = loadAll();
    const big = Array.from({ length: 51 }, (_, i) => `${i}`);
    const res = await mf.getMfsBySchemeCodesAction(big);
    assert.deepEqual(res.data, []);
    assert.equal(rec.serviceCalls, 0);
  });

  it("mf: a valid array DOES call the service (forwarding works)", async () => {
    rec.serviceCalls = 0;
    const { mf } = loadAll();
    const res = await mf.getMfsBySchemeCodesAction(["120503"]);
    assert.equal(res.success, true);
    assert.equal(rec.serviceCalls, 1);
  });

  it("stock description: a cache HIT returns instantly with NO DB / NO model", async () => {
    rec.prismaCalls = 0;
    rec.modelCalls = 0;
    rec.descCacheHit = "Cached company description";
    const { desc } = loadAll();
    const res = await desc.getOrGenerateDescriptionAction("RELIANCE", "NSE");
    assert.equal(res.success, true);
    assert.equal(res.description, "Cached company description");
    assert.equal(rec.prismaCalls, 0, "no DB on a description cache hit");
    assert.equal(rec.modelCalls, 0, "no model on a description cache hit");
    rec.descCacheHit = null;
  });
});
