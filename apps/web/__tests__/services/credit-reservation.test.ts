/**
 * Credit Reservation Service — cost estimation (REAL export, de-shadowed).
 *
 * Source: packages/services/src/credit-reservation.service.ts `estimateAnalysisCost`.
 *
 * PREVIOUSLY A SHADOW: this file re-declared its own `ANALYSIS_COSTS` +
 * `estimateAnalysisCost` inline and asserted the COPY. The copy had gone stale
 * (it billed `multi_comparison` at base 3 / +1-per-stock, while the real source
 * bills the L4-comprehensive depth base 8 / +8-per-stock since 2026-05-08), so
 * the suite was green while asserting wrong numbers — exactly the failure mode
 * the no-shadow policy exists to kill.
 *
 * De-shadowed: we now import & assert the REAL exported `estimateAnalysisCost`.
 * The function is pure, but its module top-level imports `prisma` from
 * `@usemoney/database`; we stub that boundary via `require.cache` BEFORE
 * requiring the module so no PrismaClient is constructed and no connection is
 * ever opened (the suite stays pure + exits clean). CWD must be `apps/web`.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

// ── stub the prisma boundary, then load the REAL module ──────────────────────

type ModuleCache = Record<string, { exports: unknown } | undefined>;
function moduleCache(): ModuleCache {
  return (require as unknown as { cache: ModuleCache }).cache;
}

const SILENT_LOGGER = {
  debug() {},
  error() {},
  info() {},
  warn() {},
  trace() {},
  fatal() {},
  child() {
    return SILENT_LOGGER;
  },
};

interface CostEstimate {
  credits: number;
  estimatedMinutes: number;
  segments: number;
}
interface AnalysisCostOptions {
  underlyingStocks?: number;
  params?: number;
  modelTier?: "flash" | "pro";
}
type EstimateFn = (
  analysisType: string,
  symbols?: string[],
  opts?: AnalysisCostOptions
) => CostEstimate;

const priorEntries: Array<[string, { exports: unknown } | undefined]> = [];
let estimateAnalysisCost!: EstimateFn;

before(() => {
  const cache = moduleCache();
  const stub = (path: string, exports: unknown) => {
    priorEntries.push([path, cache[path]]);
    cache[path] = { exports };
  };
  // A no-op prisma object — the cost function never touches it, and stubbing it
  // means `new PrismaClient()` never runs at module eval (no env read / handle).
  stub(require.resolve("@usemoney/database"), {
    __esModule: true,
    prisma: {},
    default: {},
  });
  stub(require.resolve("@usemoney/logger"), {
    __esModule: true,
    dbLogger: SILENT_LOGGER,
    getLogger: () => SILENT_LOGGER,
    default: SILENT_LOGGER,
  });
  // Ensure a fresh eval that binds to our stubs.
  const modPath =
    require.resolve("../../../../packages/services/src/credit-reservation.service");
  priorEntries.push([modPath, cache[modPath]]);
  delete cache[modPath];

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod =
    require("../../../../packages/services/src/credit-reservation.service") as {
      estimateAnalysisCost: EstimateFn;
    };
  estimateAnalysisCost = mod.estimateAnalysisCost;
});

after(() => {
  const cache = moduleCache();
  for (const [path, prior] of priorEntries) {
    if (prior === undefined) delete cache[path];
    else cache[path] = prior;
  }
  priorEntries.length = 0;
});

// ── tests against the REAL exported function ─────────────────────────────────

describe("Credit Reservation Service — estimateAnalysisCost (real export)", () => {
  describe("comprehensive_stock", () => {
    it("costs 5 credits / 6 segments / 15 min, regardless of symbol count", () => {
      const a = estimateAnalysisCost("comprehensive_stock", ["RELIANCE"]);
      assert.equal(a.credits, 5);
      assert.equal(a.segments, 6);
      assert.equal(a.estimatedMinutes, 15);
      const b = estimateAnalysisCost("comprehensive_stock", [
        "RELIANCE",
        "TCS",
      ]);
      assert.equal(b.credits, a.credits); // perStockCredit is 0
    });
  });

  describe("multi_comparison (L4-comprehensive depth: base 8 + 8/stock)", () => {
    it("costs 8 for a single stock", () => {
      assert.equal(
        estimateAnalysisCost("multi_comparison", ["TCS"]).credits,
        8
      );
    });

    it("costs 8 + 8×(n-1) for n stocks (5 stocks → 40)", () => {
      assert.equal(
        estimateAnalysisCost("multi_comparison", ["A", "B", "C", "D", "E"])
          .credits,
        40
      );
      assert.equal(
        estimateAnalysisCost("multi_comparison", ["TCS", "INFY", "WIPRO"])
          .credits,
        24 // 8 + 2×8
      );
    });

    it("has stockCount+1 segments (one per stock + synthesis)", () => {
      assert.equal(
        estimateAnalysisCost("multi_comparison", ["TCS", "INFY", "WIPRO"])
          .segments,
        4
      );
    });

    it("defaults to 1 symbol (base only) when none / empty provided", () => {
      assert.equal(estimateAnalysisCost("multi_comparison").credits, 8);
      assert.equal(estimateAnalysisCost("multi_comparison", []).credits, 8);
    });
  });

  describe("portfolio_optimization / portfolio_roast / l4_comprehensive", () => {
    it("portfolio_optimization → 5 credits, 4 segments", () => {
      const c = estimateAnalysisCost("portfolio_optimization");
      assert.equal(c.credits, 5);
      assert.equal(c.segments, 4);
    });

    it("portfolio_roast → 3 credits, 3 segments, 8 min", () => {
      const c = estimateAnalysisCost("portfolio_roast");
      assert.equal(c.credits, 3);
      assert.equal(c.segments, 3);
      assert.equal(c.estimatedMinutes, 8);
    });

    it("l4_comprehensive → 8 credits, 12 segments", () => {
      const c = estimateAnalysisCost("l4_comprehensive");
      assert.equal(c.credits, 8);
      assert.equal(c.segments, 12);
    });
  });

  describe("mf_analysis — single-fund, underlying-scaled, hard-cap 30", () => {
    it("base 6 with no underlyings", () => {
      assert.equal(estimateAnalysisCost("mf_analysis").credits, 6);
    });

    it("adds 0.5 per underlying constituent, rounded up", () => {
      // 6 + 0.5×10 = 11.
      assert.equal(
        estimateAnalysisCost("mf_analysis", ["FUND"], { underlyingStocks: 10 })
          .credits,
        11
      );
    });

    it("clamps to the hard cap of 30 no matter how many underlyings", () => {
      assert.equal(
        estimateAnalysisCost("mf_analysis", ["FUND"], {
          underlyingStocks: 10000,
        }).credits,
        30
      );
    });
  });

  describe("mf_comparison depths — fund + underlying + param scaling, capped", () => {
    it("deep: base 10 + 6/fund + 0.5/underlying + 1/param, cap 50", () => {
      // 2 funds, 4 underlyings, 3 params: 10 + 6×1 + 0.5×4 + 1×3 = 21.
      assert.equal(
        estimateAnalysisCost("mf_comparison_deep", ["A", "B"], {
          underlyingStocks: 4,
          params: 3,
        }).credits,
        21
      );
      // Cap holds.
      assert.equal(
        estimateAnalysisCost(
          "mf_comparison_deep",
          ["A", "B", "C", "D", "E", "F", "G", "H"],
          {
            underlyingStocks: 1000,
            params: 1000,
          }
        ).credits,
        50
      );
    });

    it("custom: pro model tier applies the 1.5× multiplier (then caps at 100)", () => {
      // base 20, 1 fund, 0 underlying/param → 20 × 1.5 = 30.
      assert.equal(
        estimateAnalysisCost("mf_comparison_custom", ["A"], {
          modelTier: "pro",
        }).credits,
        30
      );
      // flash tier → no multiplier.
      assert.equal(
        estimateAnalysisCost("mf_comparison_custom", ["A"], {
          modelTier: "flash",
        }).credits,
        20
      );
    });
  });

  describe("hardening: non-finite scaling inputs can't poison the cost", () => {
    it("a NaN underlyingStocks does not produce a NaN credit cost", () => {
      const c = estimateAnalysisCost("mf_analysis", ["FUND"], {
        underlyingStocks: NaN,
      });
      assert.ok(Number.isFinite(c.credits));
      assert.equal(c.credits, 6); // NaN → 0 underlyings → base only
    });

    it("an Infinity params does not produce an Infinity credit cost", () => {
      const c = estimateAnalysisCost("mf_comparison_deep", ["A"], {
        params: Infinity,
      });
      assert.ok(Number.isFinite(c.credits));
    });
  });
});
