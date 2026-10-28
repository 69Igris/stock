/**
 * MONEY-620 — getOrGenerateDescriptionAction END-TO-END (real handler).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a SHADOW: under "// RE-IMPLEMENTED LOGIC (mirrors
 * stock-description.ts)" it re-declared the cache-key + prompt-building logic
 * and asserted the COPIES, importing NOTHING from `lib/actions/stock-description
 * .ts`. So the real cache-first short-circuit, the "instrument already has a
 * description" path, the Gemini generation + DB persist, the "generate without a
 * DB record" branch, the global (per-instrument, not per-user) cache scoping,
 * and the catch → friendly error were all unexercised.
 *
 * This rewrite drives the REAL exported `getOrGenerateDescriptionAction` through
 * the `require.cache` seam (stubbing `@usemoney/database`, the `getCached`/
 * `setCached` cache, and the Gemini boundary) and asserts the action's OWN
 * orchestration: cache hit → no DB / no model; existing description → cached +
 * returned, no model; missing description → model generates → DB.update persists
 * → setCached writes; no-DB-record → still generates + caches but no update; a
 * thrown step → friendly error.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/stock-description.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

interface PrismaCall {
  method: string;
  args: unknown;
}
interface CacheGetCall {
  resource: string;
  scope: string;
  kind: string;
  filters: unknown;
}
interface CacheSetCall extends CacheGetCall {
  value: unknown;
}

interface Harness {
  cacheHit: string | null;
  instrument: {
    id: string;
    description: string | null;
    name: string | null;
    sector: string | null;
  } | null;
  modelResponse: string;
  failAt?: "find" | "model" | "update";
  prismaCalls: PrismaCall[];
  getCalls: CacheGetCall[];
  setCalls: CacheSetCall[];
  modelPrompts: string[];
}

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

const ACTION_REL = "../../lib/actions/stock-description";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

interface StockDescModule {
  getOrGenerateDescriptionAction: (
    symbol: string,
    exchange: string
  ) => Promise<{ success: boolean; description?: string; error?: string }>;
}

function freshHarness(): Harness {
  return {
    cacheHit: null,
    instrument: {
      id: "instr-1",
      description: null,
      name: "Reliance Industries",
      sector: "Energy",
    },
    modelResponse: "Reliance is a diversified conglomerate.",
    prismaCalls: [],
    getCalls: [],
    setCalls: [],
    modelPrompts: [],
  };
}

function loadAction(h: Harness): StockDescModule {
  const cache = moduleCache();

  const dbPath = require.resolve("@usemoney/database");
  const corePath = require.resolve("@usemoney/core");
  const modelsPath = require.resolve("../../lib/gemini/models");
  const actionPath = require.resolve(ACTION_REL);

  for (const p of [dbPath, corePath, modelsPath]) snapshotOnce(p);

  cache[dbPath] = {
    exports: {
      __esModule: true,
      prisma: {
        instrumentMapping: {
          findFirst: (args: unknown) => {
            h.prismaCalls.push({ method: "findFirst", args });
            if (h.failAt === "find") {
              return Promise.reject(new Error("db find failed"));
            }
            return Promise.resolve(h.instrument);
          },
          update: (args: unknown) => {
            h.prismaCalls.push({ method: "update", args });
            if (h.failAt === "update") {
              return Promise.reject(new Error("db update failed"));
            }
            return Promise.resolve({});
          },
        },
      },
    },
  };
  cache[corePath] = {
    exports: {
      __esModule: true,
      getCached: (
        resource: string,
        scope: string,
        kind: string,
        filters: unknown
      ) => {
        h.getCalls.push({ resource, scope, kind, filters });
        return Promise.resolve(h.cacheHit);
      },
      setCached: (
        resource: string,
        scope: string,
        kind: string,
        value: unknown,
        filters: unknown
      ) => {
        h.setCalls.push({ resource, scope, kind, value, filters });
        return Promise.resolve();
      },
    },
  };
  cache[modelsPath] = {
    exports: {
      __esModule: true,
      getGeminiModel: () => ({ __fake: "model" }),
      generateWithTimeout: (_model: unknown, prompt: string) => {
        h.modelPrompts.push(prompt);
        if (h.failAt === "model") {
          return Promise.reject(new Error("vertex failed"));
        }
        return Promise.resolve(h.modelResponse);
      },
    },
  };

  delete cache[actionPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as StockDescModule;
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — getOrGenerateDescriptionAction (real handler, mocked I/O)", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  after(() => {
    restoreCache();
  });

  it("cache HIT → returns cached, no DB read, no model call", async () => {
    h.cacheHit = "Cached description text";
    const action = loadAction(h);
    const res = await action.getOrGenerateDescriptionAction("RELIANCE", "NSE");
    assert.equal(res.success, true);
    assert.equal(res.description, "Cached description text");
    assert.equal(h.prismaCalls.length, 0);
    assert.equal(h.modelPrompts.length, 0);
    // The cache lookup is GLOBAL (per-instrument), not per-user.
    assert.equal(h.getCalls[0]!.scope, "_global");
    assert.deepEqual(h.getCalls[0]!.filters, {
      symbol: "RELIANCE",
      exchange: "NSE",
    });
  });

  it("instrument already has a description → returns + caches it, no model call", async () => {
    h.instrument = {
      id: "instr-1",
      description: "Existing description from DB",
      name: "Reliance",
      sector: "Energy",
    };
    const action = loadAction(h);
    const res = await action.getOrGenerateDescriptionAction("RELIANCE", "NSE");
    assert.equal(res.success, true);
    assert.equal(res.description, "Existing description from DB");
    assert.equal(h.modelPrompts.length, 0, "must not call the model");
    // It was written back to the global cache.
    assert.equal(h.setCalls.length, 1);
    assert.equal(h.setCalls[0]!.value, "Existing description from DB");
  });

  it("missing description → model generates → DB.update persists → cache writes", async () => {
    h.instrument = {
      id: "instr-99",
      description: null,
      name: "Tata Motors",
      sector: "Automobile",
    };
    h.modelResponse = "Tata Motors makes cars and trucks.";
    const action = loadAction(h);
    const res = await action.getOrGenerateDescriptionAction(
      "TATAMOTORS",
      "NSE"
    );
    assert.equal(res.success, true);
    assert.equal(res.description, "Tata Motors makes cars and trucks.");
    // Persisted to the row by id.
    const update = h.prismaCalls.find((c) => c.method === "update");
    assert.ok(update);
    assert.equal(
      (update!.args as { where: { id: string } }).where.id,
      "instr-99"
    );
    assert.equal(
      (update!.args as { data: { description: string } }).data.description,
      "Tata Motors makes cars and trucks."
    );
    // Cached.
    assert.equal(h.setCalls.length, 1);
    assert.equal(h.setCalls[0]!.value, "Tata Motors makes cars and trucks.");
  });

  it("no DB record → still generates + caches, but performs NO update", async () => {
    h.instrument = null;
    h.modelResponse = "An NSE-listed company.";
    const action = loadAction(h);
    const res = await action.getOrGenerateDescriptionAction("UNKNOWN", "NSE");
    assert.equal(res.success, true);
    assert.equal(res.description, "An NSE-listed company.");
    assert.equal(
      h.prismaCalls.some((c) => c.method === "update"),
      false,
      "must not update a non-existent row"
    );
    assert.equal(h.setCalls.length, 1);
  });

  it("a thrown DB find → friendly error (no internal leak)", async () => {
    h.failAt = "find";
    const action = loadAction(h);
    const res = await action.getOrGenerateDescriptionAction("RELIANCE", "NSE");
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /Failed to generate description/);
  });

  it("a thrown model call → friendly error", async () => {
    h.instrument = {
      id: "instr-1",
      description: null,
      name: "X",
      sector: "Y",
    };
    h.failAt = "model";
    const action = loadAction(h);
    const res = await action.getOrGenerateDescriptionAction("X", "NSE");
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /Failed to generate description/);
  });
});
