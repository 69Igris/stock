/**
 * Volatility Regime Classification
 *
 * Pure compute tool. Classifies the current volatility regime from a daily
 * close-price history using realized (close-to-close) and EWMA (RiskMetrics,
 * lambda=0.94) annualized volatility. Compares the latest short-window vol
 * against its own trailing distribution to bucket into low / normal /
 * elevated / crisis, and reports vol-of-vol plus a directional vol trend.
 *
 * SEBI note: emits observations, scores and flags only. No buy/sell/hold
 * or target-price language.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export type VolatilityRegime = "low" | "normal" | "elevated" | "crisis";
export type VolTrend = "rising" | "falling" | "stable";

export interface VolatilityRegimeResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  /** Number of close prices used. */
  sampleSize?: number;
  /** Annualized realized vol over the last 20 trading days (fraction, e.g. 0.24 = 24%). */
  shortVol?: number;
  /** Annualized realized vol over the last 60 trading days (fraction). */
  mediumVol?: number;
  /** Annualized realized vol over the full available window (fraction). */
  longVol?: number;
  /** Annualized EWMA vol (RiskMetrics, lambda=0.94) at the latest point (fraction). */
  ewmaVol?: number;
  /** Stdev of the rolling 20d annualized vol series — volatility of volatility (fraction). */
  volOfVol?: number;
  /** Percentile (0-100) of the current 20d vol vs its trailing ~252d distribution. */
  volPercentile?: number;
  /** Regime bucket derived from volPercentile. */
  regime?: VolatilityRegime;
  /** Direction of the short-vs-medium vol comparison. */
  volTrend?: VolTrend;
  /** Plain-language observations and flags. */
  flags?: string[];
}

const TRADING_DAYS = 252;
const ANNUALIZE = Math.sqrt(TRADING_DAYS);
const SHORT_WINDOW = 20;
const MEDIUM_WINDOW = 60;
const EWMA_LAMBDA = 0.94;
const MIN_CLOSES = 40;

/** Coerce an unknown array element into a finite positive close price, or null. */
function toClose(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Daily log returns from oldest-to-newest close prices. */
function logReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    const curr = closes[i]!;
    if (prev > 0 && curr > 0) {
      returns.push(Math.log(curr / prev));
    }
  }
  return returns;
}

/** Sample standard deviation (n-1). Returns 0 for fewer than 2 points. */
function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) /
    (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

/** Annualized realized vol over the trailing `window` of a returns series. */
function realizedVol(returns: number[], window?: number): number {
  const slice =
    window != null && returns.length > window ? returns.slice(-window) : returns;
  return stdev(slice) * ANNUALIZE;
}

/** Round a fraction to 4 decimals. */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export const computeVolatilityRegimeTool: ResearchToolDef = {
  name: "compute_volatility_regime",
  description:
    "Classify volatility regime (low/normal/elevated/crisis) from daily close history using realized + EWMA annualized vol",
  category: "computation",
  parameters: {
    closes: {
      type: "array",
      description:
        "Daily close prices oldest-to-newest (from fetch_price_history.prices[].close)",
      required: true,
    },
    symbol: {
      type: "string",
      description: "Ticker symbol for labelling the result",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbol =
      typeof params.symbol === "string" ? params.symbol.toUpperCase() : undefined;

    try {
      const rawCloses = Array.isArray(params.closes)
        ? (params.closes as unknown[])
        : [];

      // Support either raw numbers or { close } objects defensively.
      const closes = rawCloses
        .map((item) => {
          if (item != null && typeof item === "object" && "close" in item) {
            return toClose((item as { close: unknown }).close);
          }
          return toClose(item);
        })
        .filter((c): c is number => c != null);

      if (closes.length < MIN_CLOSES) {
        const degraded: VolatilityRegimeResult = {
          available: false,
          reason: `Insufficient price history (${closes.length} valid closes, need >= ${MIN_CLOSES})`,
          symbol,
        };
        return { success: true, data: degraded };
      }

      const returns = logReturns(closes);
      if (returns.length < MIN_CLOSES - 1) {
        const degraded: VolatilityRegimeResult = {
          available: false,
          reason: `Insufficient valid returns after cleaning (${returns.length})`,
          symbol,
        };
        return { success: true, data: degraded };
      }

      // Realized annualized vols over short / medium / full windows.
      const shortVol = realizedVol(returns, SHORT_WINDOW);
      const mediumVol = realizedVol(returns, MEDIUM_WINDOW);
      const longVol = realizedVol(returns);

      // EWMA variance (RiskMetrics): seed with sample variance, then recurse.
      const seedSlice = returns.slice(0, Math.min(SHORT_WINDOW, returns.length));
      const seedMean =
        seedSlice.reduce((a, b) => a + b, 0) / seedSlice.length;
      let ewmaVar =
        seedSlice.reduce(
          (acc, r) => acc + (r - seedMean) * (r - seedMean),
          0,
        ) / Math.max(1, seedSlice.length);
      for (let i = 0; i < returns.length; i++) {
        const r = returns[i]!;
        ewmaVar = EWMA_LAMBDA * ewmaVar + (1 - EWMA_LAMBDA) * r * r;
      }
      const ewmaVol = Math.sqrt(Math.max(0, ewmaVar)) * ANNUALIZE;

      // Rolling 20d annualized vol series for vol-of-vol + percentile bucketing.
      const rollingVols: number[] = [];
      for (let end = SHORT_WINDOW; end <= returns.length; end++) {
        const windowReturns = returns.slice(end - SHORT_WINDOW, end);
        rollingVols.push(stdev(windowReturns) * ANNUALIZE);
      }

      // Vol-of-vol = stdev of the rolling 20d vol series.
      const volOfVol = stdev(rollingVols);

      // Percentile of the current 20d vol vs its trailing ~252d distribution.
      const trailing =
        rollingVols.length > TRADING_DAYS
          ? rollingVols.slice(-TRADING_DAYS)
          : rollingVols;
      const current = rollingVols[rollingVols.length - 1] ?? shortVol;
      const belowOrEqual = trailing.filter((v) => v <= current).length;
      const volPercentile =
        trailing.length > 0
          ? Math.round((belowOrEqual / trailing.length) * 100)
          : 0;

      // Regime bucketing from percentile.
      let regime: VolatilityRegime;
      if (volPercentile < 25) regime = "low";
      else if (volPercentile < 75) regime = "normal";
      else if (volPercentile < 90) regime = "elevated";
      else regime = "crisis";

      // Vol trend: short window vs medium window (>10% gap = directional).
      let volTrend: VolTrend = "stable";
      if (mediumVol > 0) {
        const ratio = shortVol / mediumVol;
        if (ratio > 1.1) volTrend = "rising";
        else if (ratio < 0.9) volTrend = "falling";
      }

      const flags: string[] = [];
      const shortPct = (shortVol * 100).toFixed(1);
      const longPct = (longVol * 100).toFixed(1);

      if (regime === "crisis") {
        flags.push(
          `Crisis-level volatility: current 20d vol (${shortPct}%) sits in the ${volPercentile}th percentile of its trailing year`,
        );
      } else if (regime === "elevated") {
        flags.push(
          `Elevated volatility: current 20d vol (${shortPct}%) in the ${volPercentile}th percentile of its trailing year`,
        );
      } else if (regime === "low") {
        flags.push(
          `Calm regime: current 20d vol (${shortPct}%) in the ${volPercentile}th percentile of its trailing year`,
        );
      }

      if (volTrend === "rising") {
        flags.push(
          `Volatility rising: short-window vol (${shortPct}%) above medium-window vol (${(mediumVol * 100).toFixed(1)}%)`,
        );
      } else if (volTrend === "falling") {
        flags.push(
          `Volatility easing: short-window vol (${shortPct}%) below medium-window vol (${(mediumVol * 100).toFixed(1)}%)`,
        );
      }

      if (longVol > 0 && shortVol > longVol * 1.5) {
        flags.push(
          `Short-term vol (${shortPct}%) is well above the full-period baseline (${longPct}%) - regime shift observed`,
        );
      }

      if (volOfVol > 0 && longVol > 0 && volOfVol / longVol > 0.5) {
        flags.push(
          "High volatility-of-volatility - the vol level itself is unstable",
        );
      }

      const result: VolatilityRegimeResult = {
        available: true,
        symbol,
        sampleSize: closes.length,
        shortVol: round4(shortVol),
        mediumVol: round4(mediumVol),
        longVol: round4(longVol),
        ewmaVol: round4(ewmaVol),
        volOfVol: round4(volOfVol),
        volPercentile,
        regime,
        volTrend,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Volatility regime computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
