/**
 * MONEY-620 — mutual-fund discovery server actions END-TO-END (real handlers).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE WAS REWRITTEN (shadow → de-shadow)
 * ───────────────────────────────────────────────────────────────────────────
 * The previous version was a SHADOW: it re-declared per-category limiting,
 * category-count grouping, AMC de-duplication and a where-clause builder — then
 * asserted the COPIES, importing NOTHING from `lib/actions/discover-mf.ts`. The
 * real `discover-mf.ts` actions are intentionally THIN wrappers over
 * `@usemoney/services`, so the grouping/sort logic the shadow asserted lives in
 * the service, NOT the action — the test was asserting code that isn't even on
 * this layer. What the ACTIONS actually own (and what a wrapper-layer test must
 * pin) is: the forwarding contract (which service fn, with which normalized
 * args/defaults) and `getMfsBySchemeCodesAction`'s OWN input gate.
 *
 * This rewrite drives the REAL exported `getMfDiscoverDataAction`,
 * `getMfByCategoryAction`, `getMfsBySchemeCodesAction` through the
 * `require.cache` seam (stubbing the `@usemoney/services` boundary) and asserts:
 *   - getMfDiscoverDataAction: pass-through of the service result.
 *   - getMfByCategoryAction: forwards null→"all", applies the sortBy default
 *     ("nav") + limit default (20), and forwards plan/amc/search.
 *   - getMfsBySchemeCodesAction: empty array → [] WITHOUT calling the service;
 *     >50 codes → [] WITHOUT calling the service (cap); a valid array forwards
 *     the codes to the service.
 *
 * Runs under the default `node --import tsx --test` (CJS). CWD must be apps/web.
 *
 * Source: apps/web/lib/actions/discover-mf.ts
 */

import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

interface ServiceCall {
  fn: string;
  args: unknown[];
}

interface Harness {
  discoverResult: unknown;
  byCategoryResult: unknown;
  bySchemeCodesResult: unknown;
  serviceCalls: ServiceCall[];
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

const ACTION_REL = "../../lib/actions/discover-mf";

function restoreCache(): void {
  const cache = moduleCache();
  for (const [path, prior] of priorCacheEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorCacheEntries.clear();
  delete cache[require.resolve(ACTION_REL)];
}

interface DiscoverMfModule {
  getMfDiscoverDataAction: () => Promise<{ success: boolean; data?: unknown }>;
  getMfByCategoryAction: (
    category: string | null,
    options?: Record<string, unknown>
  ) => Promise<{ success: boolean; data?: unknown }>;
  getMfsBySchemeCodesAction: (
    schemeCodes: string[]
  ) => Promise<{ success: boolean; data?: unknown }>;
}

function freshHarness(): Harness {
  return {
    discoverResult: { success: true, data: { funds: [] } },
    byCategoryResult: { success: true, data: [{ schemeCode: "1" }] },
    bySchemeCodesResult: { success: true, data: [{ schemeCode: "1" }] },
    serviceCalls: [],
  };
}

function loadAction(h: Harness): DiscoverMfModule {
  const cache = moduleCache();

  const servicesPath = require.resolve("@usemoney/services");
  const actionPath = require.resolve(ACTION_REL);
  snapshotOnce(servicesPath);

  cache[servicesPath] = {
    exports: {
      __esModule: true,
      getMfDiscoverData: (...args: unknown[]) => {
        h.serviceCalls.push({ fn: "getMfDiscoverData", args });
        return Promise.resolve(h.discoverResult);
      },
      getMfsByCategory: (...args: unknown[]) => {
        h.serviceCalls.push({ fn: "getMfsByCategory", args });
        return Promise.resolve(h.byCategoryResult);
      },
      getMfsBySchemeCodes: (...args: unknown[]) => {
        h.serviceCalls.push({ fn: "getMfsBySchemeCodes", args });
        return Promise.resolve(h.bySchemeCodesResult);
      },
    },
  };

  delete cache[actionPath];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(ACTION_REL) as DiscoverMfModule;
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

describe("MONEY-620 — discover-mf actions (real wrappers, mocked service)", () => {
  let h: Harness;
  beforeEach(() => {
    h = freshHarness();
  });
  after(() => {
    restoreCache();
  });

  describe("getMfDiscoverDataAction", () => {
    it("passes the service result through unchanged", async () => {
      h.discoverResult = { success: true, data: { funds: [{ a: 1 }] } };
      const action = loadAction(h);
      const res = await action.getMfDiscoverDataAction();
      assert.deepEqual(res, h.discoverResult);
      assert.equal(h.serviceCalls[0]!.fn, "getMfDiscoverData");
    });
  });

  describe("getMfByCategoryAction (arg normalization + defaults)", () => {
    it("null category → 'all'; applies sortBy='nav' + limit=20 defaults", async () => {
      const action = loadAction(h);
      await action.getMfByCategoryAction(null);
      const call = h.serviceCalls.find((c) => c.fn === "getMfsByCategory");
      assert.ok(call);
      assert.equal(call!.args[0], "all");
      const opts = call!.args[1] as Record<string, unknown>;
      assert.equal(opts.sortBy, "nav");
      assert.equal(opts.limit, 20);
    });

    it("forwards an explicit category + plan/amc/search/sort/limit", async () => {
      const action = loadAction(h);
      await action.getMfByCategoryAction("Large Cap", {
        plan: "Direct",
        amcName: "Axis",
        search: "blue",
        sortBy: "returns1Y",
        limit: 5,
      });
      const call = h.serviceCalls.find((c) => c.fn === "getMfsByCategory");
      assert.equal(call!.args[0], "Large Cap");
      const opts = call!.args[1] as Record<string, unknown>;
      assert.equal(opts.plan, "Direct");
      assert.equal(opts.amcName, "Axis");
      assert.equal(opts.search, "blue");
      assert.equal(opts.sortBy, "returns1Y");
      assert.equal(opts.limit, 5);
    });
  });

  describe("getMfsBySchemeCodesAction (own input gate)", () => {
    it("empty array → [] WITHOUT calling the service", async () => {
      const action = loadAction(h);
      const res = await action.getMfsBySchemeCodesAction([]);
      assert.equal(res.success, true);
      assert.deepEqual(res.data, []);
      assert.equal(h.serviceCalls.length, 0);
    });

    it(">50 codes → [] WITHOUT calling the service (cap)", async () => {
      const big = Array.from({ length: 51 }, (_, i) => `${i}`);
      const action = loadAction(h);
      const res = await action.getMfsBySchemeCodesAction(big);
      assert.equal(res.success, true);
      assert.deepEqual(res.data, []);
      assert.equal(h.serviceCalls.length, 0);
    });

    it("a valid array forwards the codes to the service", async () => {
      h.bySchemeCodesResult = {
        success: true,
        data: [{ schemeCode: "120503" }],
      };
      const action = loadAction(h);
      const res = await action.getMfsBySchemeCodesAction(["120503", "122639"]);
      assert.equal(res.success, true);
      const call = h.serviceCalls.find((c) => c.fn === "getMfsBySchemeCodes");
      assert.ok(call);
      assert.deepEqual(call!.args[0], ["120503", "122639"]);
    });
  });
});
