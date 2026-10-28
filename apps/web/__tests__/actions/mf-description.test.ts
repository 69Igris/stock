/**
 * MONEY-620 — getOrGenerateMfDescriptionAction END-TO-END (real handler).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a SHADOW: under "// EXTRACTED LOGIC (mirrors
 * mf-description.ts)" it re-declared the cache-key + prompt logic and asserted
 * the COPIES, importing NOTHING from `lib/actions/mf-description.ts`. So the real
 * cache-first short-circuit, the "fund already has a description" path, the
 * Gemini generation + DB persist, the no-DB-record branch, the global cache
 * scoping, and the catch → friendly error were unexercised.
 *
 * This rewrite drives the REAL exported `getOrGenerateMfDescriptionAction`
 * through the `require.cache` seam (stubbing `@usemoney/database`, `getCached`/
 * `setCached`, and the Gemini boundary) and asserts the action's OWN
 * orchestration: cache hit → no DB / no model; existing description → cached +
 * returned, no model; missing description → model generates → mutualFundMaster
 * .update persists → setCached writes (under the "mf-metadata" namespace keyed by
 * schemeCode); no-DB-record → generates + caches but no update; a thrown step →
 * friendly error.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/mf-description.ts
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
  fund: {
    id: string;
    description: string | null;
    schemeName: string | null;
    amcName: string | null;
    category: string | null;
    plan: string | null;
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

const ACTION_REL = "../../lib/actions/mf-description";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

interface MfDescModule {
  getOrGenerateMfDescriptionAction: (
    schemeCode: string
  ) => Promise<{ success: boolean; description?: string; error?: string }>;
}

function freshHarness(): Harness {
  return {
    cacheHit: null,
    fund: {
      id: "fund-1",
      description: null,
      schemeName: "Axis Bluechip Fund",
      amcName: "Axis MF",
      category: "Large Cap",
      plan: "Direct",
    },
    modelResponse: "Axis Bluechip invests in large-cap equities.",
    prismaCalls: [],
    getCalls: [],
    setCalls: [],
    modelPrompts: [],
  };
}

function loadAction(h: Harness): MfDescModule {
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
        mutualFundMaster: {
          findUnique: (args: unknown) => {
            h.prismaCalls.push({ method: "findUnique", args });
            if (h.failAt === "find") {
              return Promise.reject(new Error("db find failed"));
            }
            return Promise.resolve(h.fund);
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
  return require(ACTION_REL) as MfDescModule;
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — getOrGenerateMfDescriptionAction (real handler, mocked I/O)", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  after(() => {
    restoreCache();
  });

  it("cache HIT → returns cached, no DB read, no model call", async () => {
    h.cacheHit = "Cached MF description";
    const action = loadAction(h);
    const res = await action.getOrGenerateMfDescriptionAction("120503");
    assert.equal(res.success, true);
    assert.equal(res.description, "Cached MF description");
    assert.equal(h.prismaCalls.length, 0);
    assert.equal(h.modelPrompts.length, 0);
    // GLOBAL cache, keyed by schemeCode under the mf-metadata namespace.
    assert.equal(h.getCalls[0]!.resource, "mf-metadata");
    assert.equal(h.getCalls[0]!.scope, "_global");
    assert.deepEqual(h.getCalls[0]!.filters, { schemeCode: "120503" });
  });

  it("fund already has a description → returns + caches it, no model call", async () => {
    h.fund = {
      id: "fund-1",
      description: "Existing MF description from DB",
      schemeName: "Axis Bluechip",
      amcName: "Axis MF",
      category: "Large Cap",
      plan: "Direct",
    };
    const action = loadAction(h);
    const res = await action.getOrGenerateMfDescriptionAction("120503");
    assert.equal(res.success, true);
    assert.equal(res.description, "Existing MF description from DB");
    assert.equal(h.modelPrompts.length, 0);
    assert.equal(h.setCalls.length, 1);
    assert.equal(h.setCalls[0]!.value, "Existing MF description from DB");
  });

  it("missing description → model generates → DB.update persists → cache writes", async () => {
    h.fund = {
      id: "fund-77",
      description: null,
      schemeName: "Parag Parikh Flexi Cap",
      amcName: "PPFAS",
      category: "Flexi Cap",
      plan: "Direct",
    };
    h.modelResponse = "PPFCF is a flexi-cap fund with global exposure.";
    const action = loadAction(h);
    const res = await action.getOrGenerateMfDescriptionAction("122639");
    assert.equal(res.success, true);
    assert.equal(
      res.description,
      "PPFCF is a flexi-cap fund with global exposure."
    );
    const update = h.prismaCalls.find((c) => c.method === "update");
    assert.ok(update);
    assert.equal(
      (update!.args as { where: { id: string } }).where.id,
      "fund-77"
    );
    assert.equal(
      (update!.args as { data: { description: string } }).data.description,
      "PPFCF is a flexi-cap fund with global exposure."
    );
    assert.equal(h.setCalls.length, 1);
  });

  it("no DB record → still generates + caches, but performs NO update", async () => {
    h.fund = null;
    h.modelResponse = "An Indian mutual fund.";
    const action = loadAction(h);
    const res = await action.getOrGenerateMfDescriptionAction("999999");
    assert.equal(res.success, true);
    assert.equal(res.description, "An Indian mutual fund.");
    assert.equal(
      h.prismaCalls.some((c) => c.method === "update"),
      false
    );
    assert.equal(h.setCalls.length, 1);
  });

  it("a thrown DB find → friendly error (no internal leak)", async () => {
    h.failAt = "find";
    const action = loadAction(h);
    const res = await action.getOrGenerateMfDescriptionAction("120503");
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /Failed to generate description/);
  });

  it("a thrown model call → friendly error", async () => {
    h.fund = {
      id: "fund-1",
      description: null,
      schemeName: "X",
      amcName: "Y",
      category: "Z",
      plan: "Direct",
    };
    h.failAt = "model";
    const action = loadAction(h);
    const res = await action.getOrGenerateMfDescriptionAction("120503");
    assert.equal(res.success, false);
    assert.match(res.error ?? "", /Failed to generate description/);
  });
});
