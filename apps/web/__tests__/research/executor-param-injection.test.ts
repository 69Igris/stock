/**
 * Research Executor - Param Injection Tests (MONEY-218 deep-dive follow-up).
 *
 * The executor's `injectComputationParams` is the seam where a fetched data
 * payload becomes the input to a downstream compute tool. Two regressions
 * have repeatedly burned us:
 *
 *   1. compute_technical_analysis was only ever fed `prices` (closes) - the
 *      OHLCV bars from fetch_price_history were silently dropped, so every
 *      Indian-stock report only ever showed RSI + MACD + SMA even though
 *      compute_technical_analysis can emit ADX, ATR, OBV, MFI, Stochastic,
 *      Williams %R, PSAR, Ichimoku, CCI, ROC, Supertrend, NR4/NR7, Pivots,
 *      VWAP, Bollinger Bands.
 *
 *   2. compute_dcf hardcoded a 1-billion-share fallback that produced a
 *      meaningless "intrinsic value" any time fetch_key_ratios didn't expose
 *      sharesOutstanding (the common case). The fix: inject marketCap from
 *      fetch_stock_price so the DCF tool can derive shares as
 *      marketCap / currentPrice.
 *
 * Both regressions are easy to reintroduce in a future planner refactor -
 * these tests pin the contract so any drift fails CI here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ResearchExecutor,
  ResearchToolRegistry,
  Scratchpad,
  DEFAULT_AGENT_CONFIG,
  type ResearchTask,
  type ResearchToolDef,
} from "@usemoney/research";

function makeRegistry(stubs: ResearchToolDef[]): ResearchToolRegistry {
  const reg = new ResearchToolRegistry();
  for (const stub of stubs) reg.register(stub);
  return reg;
}

function fetchTask(
  id: string,
  tool: string,
  params: Record<string, unknown> = {}
): ResearchTask {
  return {
    id,
    type: "data_fetch",
    tool,
    params,
    dependsOn: [],
    status: "pending",
  };
}

function computeTask(
  id: string,
  tool: string,
  params: Record<string, unknown>,
  dependsOn: string[]
): ResearchTask {
  return {
    id,
    type: "computation",
    tool,
    params,
    dependsOn,
    status: "pending",
  };
}

describe("executor - compute_technical_analysis param injection", () => {
  it("forwards highs / lows / volumes from fetch_price_history bars", async () => {
    const captured: Record<string, unknown>[] = [];

    const fetchPriceHistory: ResearchToolDef = {
      name: "fetch_price_history",
      description: "stub",
      category: "data",
      parameters: {},
      execute: async () => ({
        success: true,
        data: [
          {
            date: "2026-01-01",
            open: 100,
            high: 105,
            low: 98,
            close: 103,
            volume: 1000,
          },
          {
            date: "2026-01-02",
            open: 103,
            high: 108,
            low: 102,
            close: 107,
            volume: 1500,
          },
          {
            date: "2026-01-03",
            open: 107,
            high: 110,
            low: 104,
            close: 109,
            volume: 2000,
          },
        ],
      }),
    };

    const computeTech: ResearchToolDef = {
      name: "compute_technical_analysis",
      description: "stub",
      category: "computation",
      parameters: {},
      execute: async (params) => {
        captured.push(params);
        return { success: true, data: { ok: true } };
      },
    };

    const registry = makeRegistry([fetchPriceHistory, computeTech]);
    const executor = new ResearchExecutor(registry, DEFAULT_AGENT_CONFIG);
    const scratchpad = new Scratchpad();

    const tasks: ResearchTask[] = [
      fetchTask("history", "fetch_price_history"),
      computeTask("technicals", "compute_technical_analysis", {}, ["history"]),
    ];

    await executor.execute(tasks, scratchpad);

    const techParams = captured[0];
    assert.ok(techParams, "compute_technical_analysis must be invoked");
    assert.deepEqual(techParams.prices, [103, 107, 109]);
    assert.deepEqual(techParams.highs, [105, 108, 110]);
    assert.deepEqual(techParams.lows, [98, 102, 104]);
    assert.deepEqual(techParams.volumes, [1000, 1500, 2000]);
  });

  it("does not blow up when bars are missing volume (open-source feeds)", async () => {
    const captured: Record<string, unknown>[] = [];

    const fetchPriceHistory: ResearchToolDef = {
      name: "fetch_price_history",
      description: "stub",
      category: "data",
      parameters: {},
      execute: async () => ({
        success: true,
        data: [
          { date: "2026-01-01", open: 100, high: 105, low: 98, close: 103 },
          { date: "2026-01-02", open: 103, high: 108, low: 102, close: 107 },
        ],
      }),
    };

    const computeTech: ResearchToolDef = {
      name: "compute_technical_analysis",
      description: "stub",
      category: "computation",
      parameters: {},
      execute: async (params) => {
        captured.push(params);
        return { success: true, data: { ok: true } };
      },
    };

    const registry = makeRegistry([fetchPriceHistory, computeTech]);
    const executor = new ResearchExecutor(registry, DEFAULT_AGENT_CONFIG);
    const scratchpad = new Scratchpad();

    const tasks: ResearchTask[] = [
      fetchTask("history", "fetch_price_history"),
      computeTask("technicals", "compute_technical_analysis", {}, ["history"]),
    ];

    await executor.execute(tasks, scratchpad);

    const techParams = captured[0]!;
    assert.deepEqual(techParams.highs, [105, 108]);
    assert.deepEqual(techParams.lows, [98, 102]);
    assert.equal(
      techParams.volumes,
      undefined,
      "volumes must remain undefined when feed has no volume - silent zeroing would corrupt OBV / VWAP / MFI"
    );
  });
});

describe("executor - compute_dcf param injection", () => {
  it("forwards marketCap from fetch_stock_price so DCF can derive shares", async () => {
    const captured: Record<string, unknown>[] = [];

    const fetchPrice: ResearchToolDef = {
      name: "fetch_stock_price",
      description: "stub",
      category: "data",
      parameters: {},
      execute: async () => ({
        success: true,
        data: {
          "RELIANCE.NS": {
            symbol: "RELIANCE.NS",
            price: 2500,
            marketCap: 17_000_000_000_000,
          },
        },
      }),
    };

    const fetchCashFlow: ResearchToolDef = {
      name: "fetch_cash_flow",
      description: "stub",
      category: "data",
      parameters: {},
      execute: async () => ({
        success: true,
        data: {
          annual: [
            {
              period: "Mar 2025",
              operatingCashFlow: 800_000_000_000,
              capitalExpenditure: -300_000_000_000,
              freeCashFlow: 500_000_000_000,
            },
          ],
        },
      }),
    };

    const fetchRatios: ResearchToolDef = {
      name: "fetch_key_ratios",
      description: "stub",
      category: "data",
      parameters: {},
      execute: async () => ({ success: true, data: { beta: 1.1 } }),
    };

    const fetchIncome: ResearchToolDef = {
      name: "fetch_income_statement",
      description: "stub",
      category: "data",
      parameters: {},
      execute: async () => ({
        success: true,
        data: {
          annual: [
            {
              period: "Mar 2025",
              revenue: 9_000_000_000_000,
              netIncome: 700_000_000_000,
            },
          ],
        },
      }),
    };

    const computeWacc: ResearchToolDef = {
      name: "compute_wacc",
      description: "stub",
      category: "computation",
      parameters: {},
      execute: async () => ({
        success: true,
        data: { wacc: 0.11 },
      }),
    };

    const computeDcf: ResearchToolDef = {
      name: "compute_dcf",
      description: "stub",
      category: "computation",
      parameters: {},
      execute: async (params) => {
        captured.push(params);
        return { success: true, data: { intrinsicValue: 2700 } };
      },
    };

    const registry = makeRegistry([
      fetchPrice,
      fetchCashFlow,
      fetchRatios,
      fetchIncome,
      computeWacc,
      computeDcf,
    ]);
    const executor = new ResearchExecutor(registry, DEFAULT_AGENT_CONFIG);
    const scratchpad = new Scratchpad();

    const tasks: ResearchTask[] = [
      fetchTask("price", "fetch_stock_price"),
      fetchTask("cashflow", "fetch_cash_flow"),
      fetchTask("ratios", "fetch_key_ratios"),
      fetchTask("financials", "fetch_income_statement"),
      computeTask("wacc", "compute_wacc", {}, ["ratios", "price"]),
      computeTask("dcf", "compute_dcf", {}, [
        "cashflow",
        "financials",
        "price",
        "ratios",
        "wacc",
      ]),
    ];

    await executor.execute(tasks, scratchpad);

    const dcfParams = captured[0];
    assert.ok(dcfParams, "compute_dcf must be invoked");
    assert.equal(dcfParams.currentPrice, 2500);
    assert.equal(
      dcfParams.marketCap,
      17_000_000_000_000,
      "marketCap injection is required so compute_dcf doesn't fall back to a fake 1B-shares placeholder"
    );
    assert.equal(dcfParams.freeCashFlow, 500_000_000_000);
    assert.equal(dcfParams.operatingCashFlow, 800_000_000_000);
    assert.equal(
      dcfParams.netIncome,
      700_000_000_000,
      "netIncome from income statement is the 3rd-tier FCF fallback for capital-light businesses"
    );
    assert.equal(dcfParams.wacc, 0.11);
  });
});
