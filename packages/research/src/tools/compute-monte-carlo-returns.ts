/**
 * Monte Carlo Forward Price Simulation (Geometric Brownian Motion)
 *
 * Simulates N forward price paths over a horizon using GBM:
 *   S_{t+1} = S_t * exp((mu - sigma^2/2) * dt + sigma * sqrt(dt) * Z),  dt = 1/252
 * where mu/sigma are the annualized drift/volatility estimated from historical
 * daily log returns (or accepted directly as annualizedReturn/annualizedVol),
 * and Z ~ N(0,1) is drawn via the Box-Muller transform from a SEEDED mulberry32
 * PRNG so output is fully DETERMINISTIC for a given seed.
 *
 * Outputs percentile cones, expected terminal price, and probability
 * observations. SEBI: observations only - no buy/sell/hold/target advice.
 *
 * PURE compute tool: no network/db/io. All inputs arrive via params, injected
 * by the executor from upstream fetch results:
 *   - currentPrice  <- fetch_stock_price[firstKey].price
 *   - closes        <- fetch_price_history.prices[].close
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export interface MonteCarloReturnsResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  currentPrice?: number;
  horizonDays?: number;
  simulations?: number;
  seed?: number;
  /** Source of the drift/vol estimates. */
  estimateSource?: "historical_closes" | "provided_annualized";
  /** Annualized drift used in the simulation (decimal, e.g. 0.12 = 12%). */
  annualizedReturn?: number;
  /** Annualized volatility used in the simulation (decimal, e.g. 0.25 = 25%). */
  annualizedVol?: number;
  /** Terminal-price percentile cone across all simulated paths. */
  percentiles?: {
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
  };
  /** Mean terminal price across simulations. */
  expectedTerminalPrice?: number;
  /** Expected total return at horizon (decimal vs currentPrice). */
  expectedReturn?: number;
  /** 5th-percentile terminal price (VaR-style downside reference). */
  p5TerminalPrice?: number;
  /** Probability a path ends above the current price (0-1). */
  probAboveCurrent?: number;
  /** Probability a path ends >20% below the current price (0-1). */
  probLossGt20?: number;
  /** Probability a path ends at or above targetPrice (0-1, if targetPrice given). */
  probAboveTarget?: number;
  /** Echoed target price, if supplied. */
  targetPrice?: number;
  /** Neutral, non-advisory observations. */
  observations: string[];
}

const TRADING_DAYS_PER_YEAR = 252;
const DEFAULT_HORIZON_DAYS = 252;
const DEFAULT_SIMULATIONS = 1000;
const DEFAULT_SEED = 42;
const MAX_SIMULATIONS = 50_000;
const MAX_HORIZON_DAYS = 252 * 10;

// ─── Seeded PRNG (mulberry32) ───────────────────────────────
// Deterministic 32-bit PRNG so simulation output is reproducible for tests.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Box-Muller (uses the seeded PRNG) ──────────────────────
function boxMuller(rng: () => number): number {
  let u1 = 0;
  let u2 = 0;
  // Avoid log(0).
  while (u1 === 0) u1 = rng();
  while (u2 === 0) u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// ─── Statistics helpers ─────────────────────────────────────
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function sampleStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const variance =
    values.reduce((s, v) => s + (v - avg) * (v - avg), 0) /
    (values.length - 1);
  return Math.sqrt(variance);
}

/** Linear-interpolated percentile from an ascending-sorted array. */
function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (pct / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower]!;
  const weight = idx - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Coerce an unknown array of close prices into a clean number[] (positive, finite). */
function parseCloses(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const raw of value) {
    // Accept bare numbers OR objects like { close: number }.
    let candidate: unknown = raw;
    if (raw && typeof raw === "object" && "close" in raw) {
      candidate = (raw as { close: unknown }).close;
    }
    const n = toFiniteNumber(candidate);
    if (n !== null && n > 0) out.push(n);
  }
  return out;
}

export const computeMonteCarloReturnsTool: ResearchToolDef = {
  name: "compute_monte_carlo_returns",
  description:
    "Monte Carlo (GBM) forward price simulation - percentile cones, expected terminal price, downside/upside probabilities",
  category: "computation",
  parameters: {
    currentPrice: {
      type: "number",
      description: "Current price (from fetch_stock_price[firstKey].price)",
      required: true,
    },
    symbol: {
      type: "string",
      description: "Symbol for labelling the result",
    },
    closes: {
      type: "array",
      description:
        "Historical daily close prices oldest→newest (fetch_price_history.prices[].close); used to derive drift/vol",
    },
    annualizedReturn: {
      type: "number",
      description:
        "Override annualized drift (decimal, e.g. 0.12). Used if closes are insufficient",
    },
    annualizedVol: {
      type: "number",
      description:
        "Override annualized volatility (decimal, e.g. 0.25). Used if closes are insufficient",
    },
    horizonDays: {
      type: "number",
      description: "Trading days to simulate forward",
      default: DEFAULT_HORIZON_DAYS,
    },
    simulations: {
      type: "number",
      description: "Number of simulated paths",
      default: DEFAULT_SIMULATIONS,
    },
    seed: {
      type: "number",
      description: "PRNG seed for deterministic output",
      default: DEFAULT_SEED,
    },
    targetPrice: {
      type: "number",
      description:
        "Optional target price to compute probability of ending at/above it",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    try {
      const symbol =
        typeof params.symbol === "string" && params.symbol.trim() !== ""
          ? params.symbol.trim()
          : undefined;

      const currentPrice = toFiniteNumber(params.currentPrice);
      if (currentPrice === null || currentPrice <= 0) {
        const result: MonteCarloReturnsResult = {
          available: false,
          reason: "currentPrice is missing or non-positive",
          symbol,
          observations: [],
        };
        return { success: true, data: result };
      }

      // ── Derive annualized drift (mu) and volatility (sigma) ──
      const closes = parseCloses(params.closes);
      const overrideReturn = toFiniteNumber(params.annualizedReturn);
      const overrideVol = toFiniteNumber(params.annualizedVol);

      let annualizedReturn: number;
      let annualizedVol: number;
      let estimateSource: MonteCarloReturnsResult["estimateSource"];

      if (closes.length >= 30) {
        // Daily log returns → annualized drift/vol.
        const logReturns: number[] = [];
        for (let i = 1; i < closes.length; i++) {
          const prev = closes[i - 1]!;
          const curr = closes[i]!;
          if (prev > 0 && curr > 0) logReturns.push(Math.log(curr / prev));
        }
        const dailyMu = mean(logReturns);
        const dailySigma = sampleStdDev(logReturns);
        annualizedReturn = dailyMu * TRADING_DAYS_PER_YEAR;
        annualizedVol = dailySigma * Math.sqrt(TRADING_DAYS_PER_YEAR);
        estimateSource = "historical_closes";
      } else if (overrideVol !== null) {
        annualizedReturn = overrideReturn ?? 0;
        annualizedVol = overrideVol;
        estimateSource = "provided_annualized";
      } else {
        const result: MonteCarloReturnsResult = {
          available: false,
          reason:
            "Insufficient data to derive volatility - need >=30 historical closes or an annualizedVol override",
          symbol,
          currentPrice: round2(currentPrice),
          observations: [],
        };
        return { success: true, data: result };
      }

      // Sigma must be derivable and positive for a meaningful diffusion term.
      if (!Number.isFinite(annualizedVol) || annualizedVol <= 0) {
        const result: MonteCarloReturnsResult = {
          available: false,
          reason: "Volatility (sigma) underivable or non-positive",
          symbol,
          currentPrice: round2(currentPrice),
          observations: [],
        };
        return { success: true, data: result };
      }

      // ── Clamp run parameters ──
      const horizonDaysRaw = toFiniteNumber(params.horizonDays);
      const horizonDays = Math.min(
        MAX_HORIZON_DAYS,
        Math.max(
          1,
          Math.round(
            horizonDaysRaw !== null && horizonDaysRaw > 0
              ? horizonDaysRaw
              : DEFAULT_HORIZON_DAYS,
          ),
        ),
      );

      const simulationsRaw = toFiniteNumber(params.simulations);
      const simulations = Math.min(
        MAX_SIMULATIONS,
        Math.max(
          1,
          Math.round(
            simulationsRaw !== null && simulationsRaw > 0
              ? simulationsRaw
              : DEFAULT_SIMULATIONS,
          ),
        ),
      );

      const seedRaw = toFiniteNumber(params.seed);
      const seed =
        seedRaw !== null ? Math.floor(Math.abs(seedRaw)) : DEFAULT_SEED;

      const targetPrice = toFiniteNumber(params.targetPrice);

      // ── GBM simulation ──
      const dt = 1 / TRADING_DAYS_PER_YEAR;
      const drift = (annualizedReturn - (annualizedVol * annualizedVol) / 2) * dt;
      const diffusion = annualizedVol * Math.sqrt(dt);

      const rng = mulberry32(seed);
      const terminals: number[] = new Array(simulations);

      let aboveCurrentCount = 0;
      let lossGt20Count = 0;
      let aboveTargetCount = 0;
      const lossThreshold = currentPrice * 0.8; // 20% drawdown reference

      for (let s = 0; s < simulations; s++) {
        let price = currentPrice;
        for (let d = 0; d < horizonDays; d++) {
          const z = boxMuller(rng);
          price = price * Math.exp(drift + diffusion * z);
        }
        terminals[s] = price;
        if (price > currentPrice) aboveCurrentCount++;
        if (price < lossThreshold) lossGt20Count++;
        if (targetPrice !== null && price >= targetPrice) aboveTargetCount++;
      }

      terminals.sort((a, b) => a - b);

      const p5 = percentile(terminals, 5);
      const p25 = percentile(terminals, 25);
      const p50 = percentile(terminals, 50);
      const p75 = percentile(terminals, 75);
      const p95 = percentile(terminals, 95);
      const expectedTerminalPrice = mean(terminals);
      const expectedReturn =
        (expectedTerminalPrice - currentPrice) / currentPrice;

      const probAboveCurrent = aboveCurrentCount / simulations;
      const probLossGt20 = lossGt20Count / simulations;
      const probAboveTarget =
        targetPrice !== null ? aboveTargetCount / simulations : undefined;

      // ── Neutral observations (no advice language) ──
      const observations: string[] = [];
      observations.push(
        `Across ${simulations.toLocaleString()} simulated paths over ${horizonDays} trading days, the median terminal price is ${round2(p50)} and the mean is ${round2(expectedTerminalPrice)}.`,
      );
      observations.push(
        `Estimated annualized drift ${(annualizedReturn * 100).toFixed(1)}% and volatility ${(annualizedVol * 100).toFixed(1)}% (source: ${estimateSource === "historical_closes" ? "historical closes" : "provided inputs"}).`,
      );
      observations.push(
        `Simulated outcomes finished above the current price in ${(probAboveCurrent * 100).toFixed(1)}% of paths; ${(probLossGt20 * 100).toFixed(1)}% of paths ended more than 20% below the current price.`,
      );
      observations.push(
        `5th-95th percentile terminal range: ${round2(p5)} to ${round2(p95)}.`,
      );
      if (probAboveTarget !== undefined && targetPrice !== null) {
        observations.push(
          `${(probAboveTarget * 100).toFixed(1)}% of paths finished at or above the supplied reference price of ${round2(targetPrice)}.`,
        );
      }
      observations.push(
        "These are statistical projections from a GBM model on historical data, not forecasts; past behaviour does not determine future outcomes.",
      );

      const result: MonteCarloReturnsResult = {
        available: true,
        symbol,
        currentPrice: round2(currentPrice),
        horizonDays,
        simulations,
        seed,
        estimateSource,
        annualizedReturn: round4(annualizedReturn),
        annualizedVol: round4(annualizedVol),
        percentiles: {
          p5: round2(p5),
          p25: round2(p25),
          p50: round2(p50),
          p75: round2(p75),
          p95: round2(p95),
        },
        expectedTerminalPrice: round2(expectedTerminalPrice),
        expectedReturn: round4(expectedReturn),
        p5TerminalPrice: round2(p5),
        probAboveCurrent: round4(probAboveCurrent),
        probLossGt20: round4(probLossGt20),
        ...(probAboveTarget !== undefined
          ? { probAboveTarget: round4(probAboveTarget) }
          : {}),
        ...(targetPrice !== null ? { targetPrice: round2(targetPrice) } : {}),
        observations,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Monte Carlo simulation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
