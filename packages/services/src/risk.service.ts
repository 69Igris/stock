/**
 * Risk Service
 *
 * Portfolio risk analysis: concentration, correlation, VaR, drawdown,
 * risk-adjusted returns, and rebalancing suggestions.
 * Source: apps/web/lib/actions/risk.ts
 */

import { prisma } from "@usemoney/database";
import { getCached, setCached } from "@usemoney/core";
// Subpath, NOT the root barrel: these are pure in-process helpers (a dedupe
// registry and a string builder). The service tests stub the ROOT
// `@usemoney/core` with a catch-all Proxy that answers any unmodelled export
// with a no-op, so from the root `singleFlight` silently became `async () => {}`
// and the LIVE service tests got `undefined` instead of their result. The I/O
// boundary those tests DO need to control (getCached / setCached) stays on the
// root import above.
import { singleFlight, generateCacheKey } from "@usemoney/core/cache";
import { dbLogger as logger } from "@usemoney/logger";
import type {
  ConcentrationResult,
  CorrelationMatrixResult,
  VaRResult,
  DrawdownResult,
  RiskAdjustedReturnsResult,
  RebalancingResult,
} from "@usemoney/research";
import { resolveSymbol } from "@usemoney/research";
import {
  computePortfolioConcentrationTool,
  computeCorrelationMatrixTool,
  computeVarTool,
  computeDrawdownTool,
  computeRiskAdjustedReturnsTool,
  computeRebalancingTool,
  computeBetaTool,
  fetchPriceHistoryTool,
  type BetaResult,
} from "@usemoney/research/tools";
import type { ServiceResult } from "./types";
import { runStressTest, type StressTestResult } from "./risk-stress-test";
import {
  mapHoldingsData,
  mergeHoldingSectors,
  holdingSectorKey,
  sumHoldingsValue,
  topHoldingsByValue,
  collectSortedDates,
  buildDailyValueSeries,
  computeReturnsFromSeries,
  computeBenchmarkReturns,
  buildCloseByDate,
} from "./risk-logic";

// ── Types ──────────────────────────────────────────────────────────

export interface PortfolioRiskResult {
  concentration: ConcentrationResult;
  correlation: CorrelationMatrixResult | null;
  var: VaRResult | null;
  drawdown: DrawdownResult | null;
  riskAdjustedReturns: RiskAdjustedReturnsResult | null;
  rebalancing: RebalancingResult;
  /**
   * Stress-test scenarios applied to current portfolio composition.
   * Computed purely from sector weights against fixed historical-event
   * impact factors (see `risk-stress-test.ts`). Always populated.
   */
  stressTest: StressTestResult;
  /**
   * Portfolio beta vs NIFTY 50. Null when the benchmark history is
   * unavailable or we have fewer than 20 paired daily returns.
   */
  beta: BetaResult | null;
}

const MAX_HOLDINGS_FOR_CORRELATION = 15;

// ── Fallback defaults (used when compute tools return no data) ────

const EMPTY_CONCENTRATION: ConcentrationResult = {
  topHoldings: [],
  sectorWeights: [],
  hhi: 0,
  level: "low",
  warnings: [],
};

const EMPTY_REBALANCING: RebalancingResult = {
  holdings: [],
  totalDrift: 0,
  needsRebalancing: false,
  driftThreshold: 5,
};

// ── Service Functions ──────────────────────────────────────────────

export async function getPortfolioRisk(
  userId: string,
): Promise<ServiceResult<PortfolioRiskResult>> {
  try {
    // MONEY-705 stampede protection. This is the highest-value site in the
    // package: a cold key fans out ~16 EXTERNAL Yahoo price-history fetches
    // (top-15 holdings + ^NSEI), and before this every concurrent request on an
    // expired key ran its own fan-out. The flight key IS the cache key, so the
    // userId segment guarantees one user's risk report can never be handed to
    // another. The flight resolves to the whole ServiceResult so the mid-body
    // "No holdings found" failure keeps its exact shape — and, being a failure,
    // is still never written to the cache.
    return await singleFlight(
      generateCacheKey("risk" as const, userId, "portfolio"),
      () => resolvePortfolioRisk(userId),
    );
  } catch (error) {
    logger.error(
      { error: error instanceof Error ? error.message : String(error), userId },
      "Portfolio risk analysis service error",
    );
    return {
      success: false,
      error: "Failed to analyze portfolio risk. Please try again.",
    };
  }
}

/** Cache-read → compute → cache-write body, run at most once per user per flight. */
async function resolvePortfolioRisk(
  userId: string,
): Promise<ServiceResult<PortfolioRiskResult>> {
  // Check cache
  const cached = await getCached<PortfolioRiskResult>(
    "risk" as const,
    userId,
    "portfolio",
  );
  if (cached) {
    logger.debug({ userId }, "Portfolio risk from cache");
    return { success: true, data: cached };
  }

  logger.debug({ userId }, "Portfolio risk cache miss");

  // Fetch user holdings directly via Prisma
  const dbHoldings = await prisma.holding.findMany({
    where: { userId },
    select: {
      symbol: true,
      sector: true,
      exchange: true,
      quantity: true,
      averagePrice: true,
      currentPrice: true,
    },
  });

  if (!dbHoldings.length) {
    return {
      success: false,
      error: "No holdings found. Connect a broker to analyze portfolio risk.",
    };
  }

  // MONEY-1121 - resolve sectors the broker sync didn't write. Holding.sector
  // is null on every row, so the sector-allocation donut rendered a single
  // "Unknown 100%" slice even though InstrumentMapping knew the sector for
  // each symbol. One lookup, keyed on symbol+exchange because the same ticker
  // lists on both NSE and BSE.
  const needSector = dbHoldings.filter((h) => !h.sector);
  let holdingsWithSector = dbHoldings;
  if (needSector.length > 0) {
    const instruments = await prisma.instrumentMapping.findMany({
      where: { symbol: { in: needSector.map((h) => h.symbol) } },
      select: { symbol: true, exchange: true, sector: true },
    });
    const sectorByKey = new Map(
      instruments.map((i) => [
        holdingSectorKey(i.symbol, i.exchange),
        i.sector,
      ]),
    );
    holdingsWithSector = mergeHoldingSectors(dbHoldings, sectorByKey);
  }

  // Prepare holdings data. `mapHoldingsData` finite-guards each
  // (currentPrice || averagePrice) * quantity so a corrupt sync row (NaN /
  // Infinity price or quantity) cannot poison the value, the total, or any
  // downstream weight. See ./risk-logic.ts.
  const holdingsData = mapHoldingsData(holdingsWithSector);

  const totalValue = sumHoldingsValue(holdingsData);

  // 1. Concentration
  const concentrationResult = await computePortfolioConcentrationTool.execute({
    holdings: holdingsData,
  });
  const concentration =
    (concentrationResult.data as ConcentrationResult) || EMPTY_CONCENTRATION;

  // 2. Fetch price histories for top holdings (capped at 15). Finite-safe
  // sort (a NaN value sinks rather than corrupting the order).
  const topHoldings = topHoldingsByValue(
    holdingsData,
    MAX_HOLDINGS_FOR_CORRELATION,
  );

  const priceHistories: Record<
    string,
    Array<{ date: string; close: number }>
  > = {};
  let portfolioReturns: number[] = [];
  let valueSeries: Array<{ date: string; value: number }> = [];

  // Fetch histories in parallel
  const historyPromises = topHoldings.map(async (h) => {
    const yahooSymbol = resolveSymbol(h.symbol, "NSE");
    const result = await fetchPriceHistoryTool.execute({
      symbol: yahooSymbol,
      period: "1y",
    });
    if (result.success && result.data) {
      const data = result.data as Record<string, unknown>;
      const prices = (data.prices || data) as Array<{
        date: string;
        close: number;
      }>;
      if (Array.isArray(prices) && prices.length > 0) {
        priceHistories[h.symbol] = prices;
      }
    }
  });

  await Promise.allSettled(historyPromises);

  // 3. Correlation matrix
  let correlation: CorrelationMatrixResult | null = null;
  if (Object.keys(priceHistories).length >= 2) {
    const corrResult = await computeCorrelationMatrixTool.execute({
      priceHistories,
    });
    if (corrResult.success) {
      correlation = corrResult.data as CorrelationMatrixResult;
    }
  }

  // 4. Compute portfolio returns and value series for VaR/Drawdown.
  // `buildDailyValueSeries` finite-guards each `close × weight` term and the
  // weight itself (zero/non-finite totalValue → weight 0, no divide-by-zero),
  // emitting only finite, strictly-positive day values; `computeReturnsFromSeries`
  // drops any non-finite return so one corrupt day cannot fail the compute
  // tools' all-finite gate and silently null EVERY metric. See ./risk-logic.ts.
  const sortedDates = collectSortedDates(priceHistories);

  if (sortedDates.length > 20) {
    valueSeries = buildDailyValueSeries(
      topHoldings,
      priceHistories,
      totalValue,
      sortedDates,
    );
    portfolioReturns = computeReturnsFromSeries(valueSeries);
  }

  // 5. VaR
  let varResult: VaRResult | null = null;
  if (portfolioReturns.length >= 20) {
    const varOutput = await computeVarTool.execute({
      portfolioReturns,
      portfolioValue: totalValue,
    });
    if (varOutput.success) {
      varResult = varOutput.data as VaRResult;
    }
  }

  // 6. Drawdown
  let drawdown: DrawdownResult | null = null;
  if (valueSeries.length >= 5) {
    const ddOutput = await computeDrawdownTool.execute({ valueSeries });
    if (ddOutput.success) {
      drawdown = ddOutput.data as DrawdownResult;
    }
  }

  // 7. Risk-adjusted returns
  let riskAdjustedReturns: RiskAdjustedReturnsResult | null = null;
  if (portfolioReturns.length >= 20) {
    const rarOutput = await computeRiskAdjustedReturnsTool.execute({
      dailyReturns: portfolioReturns,
      maxDrawdown: drawdown?.maxDrawdown,
    });
    if (rarOutput.success) {
      riskAdjustedReturns = rarOutput.data as RiskAdjustedReturnsResult;
    }
  }

  // 8. Rebalancing
  const rebalancingResult = await computeRebalancingTool.execute({
    holdings: holdingsData.map((h) => ({
      symbol: h.symbol,
      value: h.value,
    })),
  });
  const rebalancing =
    (rebalancingResult.data as RebalancingResult) || EMPTY_REBALANCING;

  // 9. Stress-test scenarios - pure compute against current sector mix.
  const stressTest = runStressTest(holdingsData);

  // 10. Beta vs NIFTY 50. Fetch the index history with the same period
  // used for the portfolio (1y) and pair-compute against
  // `portfolioReturns`. Yahoo's NIFTY 50 symbol is `^NSEI`.
  let beta: BetaResult | null = null;
  if (portfolioReturns.length >= 20) {
    const niftyResult = await fetchPriceHistoryTool.execute({
      symbol: "^NSEI",
      period: "1y",
    });
    if (niftyResult.success && niftyResult.data) {
      const data = niftyResult.data as Record<string, unknown>;
      const prices = (data.prices || data) as Array<{
        date: string;
        close: number;
      }>;
      if (Array.isArray(prices) && prices.length >= 21) {
        // Build benchmark daily returns aligned to the portfolio's value
        // series so the paired series stays date-consistent.
        // `computeBenchmarkReturns` skips dates with no/`<= 0`/non-finite
        // prev close (divide-by-zero) and drops non-finite returns, so a
        // single corrupt benchmark close cannot null out beta. See
        // ./risk-logic.ts.
        const closeByDate = buildCloseByDate(prices);
        const benchmarkReturns = computeBenchmarkReturns(
          valueSeries,
          closeByDate,
        );
        if (benchmarkReturns.length >= 20) {
          const betaOut = await computeBetaTool.execute({
            portfolioReturns,
            benchmarkReturns,
          });
          if (betaOut.success && betaOut.data) {
            beta = betaOut.data as BetaResult;
          }
        }
      }
    }
  }

  const result: PortfolioRiskResult = {
    concentration,
    correlation,
    var: varResult,
    drawdown,
    riskAdjustedReturns,
    rebalancing,
    stressTest,
    beta,
  };

  // Cache for 5 minutes
  await setCached("risk" as const, userId, "portfolio", result, undefined, {
    ttl: 300,
    enableMemory: true,
    enableRedis: true,
  });

  return { success: true, data: result };
}
