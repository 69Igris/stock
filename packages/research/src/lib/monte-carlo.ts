/**
 * Monte Carlo Simulation for Forward Price Scenarios
 *
 * Uses Geometric Brownian Motion (GBM) to simulate future price paths
 * based on historical daily returns. Produces bull/base/bear scenarios
 * with confidence intervals.
 *
 * DISCLAIMER: All projections are statistical estimates based on historical data.
 * Past performance does not guarantee future results.
 */

// ─── Types ──────────────────────────────────────────────────

export interface MonteCarloScenario {
  targetPrice: number;
  probability: number;
  returnPct: number;
  conditions: string[];
}

export interface MonteCarloResult {
  scenarios: {
    bull: MonteCarloScenario;
    base: MonteCarloScenario;
    bear: MonteCarloScenario;
  };
  simulations: number;
  confidenceInterval: { lower95: number; upper95: number };
  expectedReturn: number;
  disclaimer: string;
}

// ─── Constants ──────────────────────────────────────────────

const SEBI_DISCLAIMER =
  "DISCLAIMER: These projections are based on historical data and statistical models. " +
  "Past performance does not guarantee future results. This is not investment advice. " +
  "Please consult a SEBI-registered advisor before making investment decisions.";

const DEFAULT_SIMULATIONS = 10_000;
const TRADING_DAYS_PER_YEAR = 252;

// ─── Box-Muller Transform ───────────────────────────────────

/**
 * Generate a pair of independent standard normal random variables
 * using the Box-Muller transform (deterministic seeded RNG not needed
 * for Monte Carlo - standard Math.random suffices).
 */
function boxMullerRandom(): number {
  let u1 = 0;
  let u2 = 0;
  // Avoid log(0)
  while (u1 === 0) u1 = Math.random();
  while (u2 === 0) u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

// ─── Statistics Helpers ─────────────────────────────────────

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function percentile(sorted: number[], pct: number): number {
  const idx = (pct / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower]!;
  const weight = idx - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

// ─── GBM Simulation ─────────────────────────────────────────

/**
 * Run Monte Carlo simulation using Geometric Brownian Motion.
 *
 * @param currentPrice - Current stock price
 * @param dailyReturns - Historical daily log returns (or simple returns)
 * @param daysForward  - Number of trading days to simulate (default 252 = 1 year)
 * @param numSimulations - Number of simulation paths (default 10000)
 * @returns MonteCarloResult with bull/base/bear scenarios and confidence intervals
 */
export function runMonteCarloSimulation(
  currentPrice: number,
  dailyReturns: number[],
  daysForward: number = TRADING_DAYS_PER_YEAR,
  numSimulations: number = DEFAULT_SIMULATIONS,
): MonteCarloResult {
  if (dailyReturns.length < 20) {
    // Not enough data for meaningful simulation - return flat scenarios
    return {
      scenarios: {
        bull: {
          targetPrice: Math.round(currentPrice * 1.2 * 100) / 100,
          probability: 25,
          returnPct: 20,
          conditions: ["Insufficient historical data - using rough estimate"],
        },
        base: {
          targetPrice: currentPrice,
          probability: 50,
          returnPct: 0,
          conditions: ["Insufficient historical data - using rough estimate"],
        },
        bear: {
          targetPrice: Math.round(currentPrice * 0.8 * 100) / 100,
          probability: 25,
          returnPct: -20,
          conditions: ["Insufficient historical data - using rough estimate"],
        },
      },
      simulations: 0,
      confidenceInterval: {
        lower95: Math.round(currentPrice * 0.7 * 100) / 100,
        upper95: Math.round(currentPrice * 1.3 * 100) / 100,
      },
      expectedReturn: 0,
      disclaimer: SEBI_DISCLAIMER,
    };
  }

  // Step 1: Calculate drift (mu) and volatility (sigma) from historical returns
  const mu = mean(dailyReturns);
  const sigma = stdDev(dailyReturns);
  const dt = 1; // 1 trading day

  // Step 2: Simulate paths using GBM
  // S(t+1) = S(t) * exp((mu - sigma^2/2)*dt + sigma*sqrt(dt)*Z)
  const drift = (mu - (sigma * sigma) / 2) * dt;
  const diffusionScale = sigma * Math.sqrt(dt);

  const terminalPrices: number[] = new Array(numSimulations);

  for (let sim = 0; sim < numSimulations; sim++) {
    let price = currentPrice;
    for (let day = 0; day < daysForward; day++) {
      const z = boxMullerRandom();
      price = price * Math.exp(drift + diffusionScale * z);
    }
    terminalPrices[sim] = price;
  }

  // Step 3: Sort terminal prices for percentile extraction
  terminalPrices.sort((a, b) => a - b);

  // Step 4: Extract percentiles
  const bearPrice = Math.round(percentile(terminalPrices, 10) * 100) / 100;
  const basePrice = Math.round(percentile(terminalPrices, 50) * 100) / 100;
  const bullPrice = Math.round(percentile(terminalPrices, 90) * 100) / 100;

  const lower95 = Math.round(percentile(terminalPrices, 2.5) * 100) / 100;
  const upper95 = Math.round(percentile(terminalPrices, 97.5) * 100) / 100;

  // Step 5: Compute probabilities (% of simulations in each zone)
  // Bear zone: below 25th percentile
  // Base zone: 25th to 75th percentile
  // Bull zone: above 75th percentile
  const p25 = percentile(terminalPrices, 25);
  const p75 = percentile(terminalPrices, 75);

  let bearCount = 0;
  let baseCount = 0;
  let bullCount = 0;
  for (let i = 0; i < numSimulations; i++) {
    const p = terminalPrices[i]!;
    if (p < p25) bearCount++;
    else if (p > p75) bullCount++;
    else baseCount++;
  }

  const bearProbability = Math.round((bearCount / numSimulations) * 100);
  const baseProbability = Math.round((baseCount / numSimulations) * 100);
  const bullProbability = Math.round((bullCount / numSimulations) * 100);

  // Step 6: Compute expected return
  const avgTerminal = mean(terminalPrices);
  const expectedReturn =
    Math.round(((avgTerminal - currentPrice) / currentPrice) * 10000) / 100;

  // Step 7: Generate condition descriptions
  const annualizedVol =
    Math.round(sigma * Math.sqrt(TRADING_DAYS_PER_YEAR) * 10000) / 100;
  const annualizedDrift = Math.round(mu * TRADING_DAYS_PER_YEAR * 10000) / 100;

  const bullReturn =
    Math.round(((bullPrice - currentPrice) / currentPrice) * 10000) / 100;
  const baseReturn =
    Math.round(((basePrice - currentPrice) / currentPrice) * 10000) / 100;
  const bearReturn =
    Math.round(((bearPrice - currentPrice) / currentPrice) * 10000) / 100;

  return {
    scenarios: {
      bull: {
        targetPrice: bullPrice,
        probability: bullProbability,
        returnPct: bullReturn,
        conditions: [
          `90th percentile of ${numSimulations.toLocaleString()} simulations`,
          `Annualized drift: ${annualizedDrift}%, Volatility: ${annualizedVol}%`,
          "Assumes sustained momentum and favorable market conditions",
        ],
      },
      base: {
        targetPrice: basePrice,
        probability: baseProbability,
        returnPct: baseReturn,
        conditions: [
          `Median (50th percentile) of ${numSimulations.toLocaleString()} simulations`,
          `Annualized drift: ${annualizedDrift}%, Volatility: ${annualizedVol}%`,
          "Continuation of historical return/risk profile",
        ],
      },
      bear: {
        targetPrice: bearPrice,
        probability: bearProbability,
        returnPct: bearReturn,
        conditions: [
          `10th percentile of ${numSimulations.toLocaleString()} simulations`,
          `Annualized drift: ${annualizedDrift}%, Volatility: ${annualizedVol}%`,
          "Adverse market conditions or company-specific headwinds",
        ],
      },
    },
    simulations: numSimulations,
    confidenceInterval: { lower95, upper95 },
    expectedReturn,
    disclaimer: SEBI_DISCLAIMER,
  };
}
