/**
 * Single-Position Value at Risk
 *
 * Computes VaR/CVaR for ONE instrument from its own return distribution.
 * Historical VaR: percentile of daily log returns.
 * Parametric VaR: z×σ (mean ~ 0 assumption for daily horizon).
 * CVaR95 (Expected Shortfall): mean of returns in the left tail beyond VaR95.
 * Scales to INR-at-risk when positionValue is supplied, and to 1-day / 10-day
 * horizons via the square-root-of-time rule.
 *
 * PURE compute: reads everything from params (closes[] OR returns[]).
 * SEBI: outputs observations/scores/flags only — no advice language.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

// Standard normal z-scores (one-tailed)
const Z_95 = 1.645;
const Z_99 = 2.326;
const TRADING_DAYS = 252;
// MONEY-806: default multi-day scaling horizon (10 days) when the user hasn't
// selected one. The 10-day VaR fields below keep their historical names for
// back-compat, but the scale is now driven by varConfig.horizonDays.
const DEFAULT_HORIZON_DAYS = 10;
const MIN_OBSERVATIONS = 40;

/**
 * MONEY-806: read the user-selected VaR confidence (95 | 99) and horizon (days)
 * from params.varConfig. Both inert before this — compute_position_var always
 * scaled by sqrt(10) and never promoted a chosen percentile. Defaults preserve
 * today's behaviour: confidence 95, horizon 10 days.
 */
function readVarConfig(params: Record<string, unknown>): {
  confidence: 95 | 99;
  horizonDays: number;
} {
  const cfg = params.varConfig as
    | { confidence?: unknown; horizonDays?: unknown }
    | undefined;
  const confidence = cfg?.confidence === 99 ? 99 : 95;
  const rawHorizon =
    typeof cfg?.horizonDays === "number"
      ? cfg.horizonDays
      : Number(cfg?.horizonDays);
  const horizonDays =
    Number.isFinite(rawHorizon) && rawHorizon >= 1
      ? rawHorizon
      : DEFAULT_HORIZON_DAYS;
  return { confidence, horizonDays };
}

export interface PositionVarResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  /** Number of daily return observations used. */
  observations?: number;
  /** Returns expressed as % loss (negative = loss), 1-day horizon. */
  historicalVaR95?: number; // % (negative)
  historicalVaR99?: number; // %
  parametricVaR95?: number; // %
  parametricVaR99?: number; // %
  cvar95?: number; // % expected shortfall (negative)
  /** Daily mean & sigma of returns (decimals). */
  meanReturn?: number;
  dailySigma?: number;
  annualizedVol?: number; // % annualized volatility
  /** Multi-day scaled VaR (% loss) via sqrt-of-time. Field names kept for
   * back-compat; the actual horizon used is `horizonDays` (default 10). */
  historicalVaR95_10d?: number; // %
  parametricVaR95_10d?: number; // %
  /** INR amounts at risk (present only when positionValue supplied). */
  positionValue?: number;
  var95Amount1d?: number; // INR
  var99Amount1d?: number; // INR
  cvar95Amount1d?: number; // INR
  var95Amount10d?: number; // INR (scaled to `horizonDays`)
  /** MONEY-806: the confidence (95 | 99) the user selected via varConfig. */
  selectedConfidence?: 95 | 99;
  /** MONEY-806: the multi-day horizon (days) used for sqrt-of-time scaling. */
  horizonDays?: number;
  /** MONEY-806: historical 1-day VaR (% loss) at the selected confidence. */
  selectedVaR1d?: number; // %
  /** MONEY-806: historical horizon-scaled VaR (% loss) at the selected confidence. */
  selectedVaRHorizon?: number; // %
  /** MONEY-806: INR 1-day VaR at the selected confidence (when positionValue supplied). */
  selectedVarAmount1d?: number; // INR
  /** MONEY-806: INR horizon-scaled VaR at the selected confidence. */
  selectedVarAmountHorizon?: number; // INR
  flags?: string[];
}

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const v of value) {
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Daily log returns from a close series (oldest → newest). */
function logReturnsFromCloses(closes: number[]): number[] {
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

/** Lower-tail percentile (p in [0,1]) of an ascending-sorted array. */
function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const idx = Math.floor(n * p);
  const bounded = Math.max(0, Math.min(n - 1, idx));
  return sortedAsc[bounded] ?? 0;
}

const round4 = (x: number): number => Math.round(x * 10000) / 10000;
const pct2 = (x: number): number => Math.round(x * 100 * 100) / 100; // decimal → % w/ 2dp

export const computePositionVarTool: ResearchToolDef = {
  name: "compute_position_var",
  description:
    "Single-position Value at Risk (historical & parametric VaR95/99, CVaR95, annualized vol) from an instrument's own return distribution",
  category: "computation",
  parameters: {
    closes: {
      type: "array",
      description:
        "Daily closing prices, oldest to newest (from fetch_price_history.prices[].close). Used if returns not supplied.",
    },
    returns: {
      type: "array",
      description:
        "Daily returns (decimals) as an alternative to closes. Takes precedence over closes when provided.",
    },
    positionValue: {
      type: "number",
      description:
        "Current INR value of the position. Optional — when present, VaR is also expressed as INR at risk.",
    },
    symbol: {
      type: "string",
      description: "Instrument symbol (for labeling)",
    },
    varConfig: {
      type: "object",
      description:
        "MONEY-806 (C1c) - user-selected VaR config { confidence: 95|99, horizonDays: 1|10 }. confidence promotes the chosen percentile as the primary VaR; horizonDays drives the multi-day sqrt-of-time scaling (was hardcoded to 10). Absent → confidence 95, horizon 10 days (today's behaviour).",
      required: false,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const symbolRaw = params.symbol;
    const symbol =
      typeof symbolRaw === "string" && symbolRaw.trim()
        ? symbolRaw.trim().toUpperCase()
        : undefined;

    try {
      // MONEY-806: read the user-selected confidence + horizon. Defaults
      // (95, 10 days) reproduce today's output exactly when varConfig is absent.
      const { confidence, horizonDays } = readVarConfig(params);
      const horizonScale = Math.sqrt(horizonDays);

      const closes = toNumberArray(params.closes);
      const providedReturns = toNumberArray(params.returns);

      // Returns take precedence; otherwise derive log returns from closes.
      const returns =
        providedReturns.length > 0
          ? providedReturns
          : logReturnsFromCloses(closes);

      const n = returns.length;
      if (n < MIN_OBSERVATIONS) {
        const result: PositionVarResult = {
          available: false,
          reason: `Insufficient price history: ${n} daily returns available, need at least ${MIN_OBSERVATIONS}`,
          symbol,
        };
        return { success: true, data: result };
      }

      const positionValueRaw = params.positionValue;
      const positionValue =
        typeof positionValueRaw === "number" &&
        Number.isFinite(positionValueRaw)
          ? positionValueRaw
          : Number(positionValueRaw);
      const hasPositionValue =
        Number.isFinite(positionValue) && positionValue > 0;

      // --- Distribution stats ---
      const mean = returns.reduce((s, r) => s + r, 0) / n;
      const variance =
        returns.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (n - 1);
      const sigma = Math.sqrt(variance);
      const annualizedVol = sigma * Math.sqrt(TRADING_DAYS);

      // --- Historical VaR (left-tail percentiles → loss is positive %) ---
      const sortedAsc = [...returns].sort((a, b) => a - b);
      const p5 = percentile(sortedAsc, 0.05); // typically negative
      const p1 = percentile(sortedAsc, 0.01);
      // VaR reported as the loss return (negative number = expected loss).
      const histVaR95 = p5;
      const histVaR99 = p1;

      // --- CVaR95 / Expected Shortfall: mean of returns at/below the 5% cut ---
      const cutIdx = Math.max(0, Math.floor(n * 0.05));
      const tail = sortedAsc.slice(0, cutIdx + 1);
      const cvar95 =
        tail.length > 0
          ? tail.reduce((s, r) => s + r, 0) / tail.length
          : histVaR95;

      // --- Parametric VaR (mean ~ 0 for daily horizon, but keep mean term) ---
      const paramVaR95 = mean - Z_95 * sigma;
      const paramVaR99 = mean - Z_99 * sigma;

      // --- Multi-day scaling (sqrt of time) to the selected horizon ---
      const histVaR95_10d = histVaR95 * horizonScale;
      const paramVaR95_10d = paramVaR95 * horizonScale;

      // MONEY-806: promote the percentile the user selected (95 | 99) as the
      // primary VaR — 1-day and horizon-scaled, in % and (when available) INR.
      const selectedHistVaR1d = confidence === 99 ? histVaR99 : histVaR95;
      const selectedHistVaRHorizon = selectedHistVaR1d * horizonScale;

      const flags: string[] = [];
      if (annualizedVol > 0.6) {
        flags.push(
          `Very high annualized volatility (${pct2(annualizedVol).toFixed(1)}%) — large daily swings`,
        );
      } else if (annualizedVol > 0.4) {
        flags.push(
          `Elevated annualized volatility (${pct2(annualizedVol).toFixed(1)}%)`,
        );
      }
      if (histVaR95 < -0.05) {
        flags.push(
          `1-in-20 daily loss historically near ${pct2(Math.abs(histVaR95)).toFixed(1)}% of position value`,
        );
      }
      // Fat left tail: CVaR materially worse than VaR.
      if (histVaR95 < 0 && cvar95 < histVaR95 * 1.5) {
        flags.push(
          "Fat left tail — losses beyond VaR95 are markedly worse than the VaR threshold",
        );
      }
      if (n < TRADING_DAYS) {
        flags.push(
          `Limited sample (${n} observations) — estimates less reliable than a full year of data`,
        );
      }

      const result: PositionVarResult = {
        available: true,
        symbol,
        observations: n,
        historicalVaR95: pct2(histVaR95),
        historicalVaR99: pct2(histVaR99),
        parametricVaR95: pct2(paramVaR95),
        parametricVaR99: pct2(paramVaR99),
        cvar95: pct2(cvar95),
        meanReturn: round4(mean),
        dailySigma: round4(sigma),
        annualizedVol: pct2(annualizedVol),
        historicalVaR95_10d: pct2(histVaR95_10d),
        parametricVaR95_10d: pct2(paramVaR95_10d),
        // MONEY-806: selected-confidence + horizon surfaced as primary VaR.
        selectedConfidence: confidence,
        horizonDays,
        selectedVaR1d: pct2(selectedHistVaR1d),
        selectedVaRHorizon: pct2(selectedHistVaRHorizon),
        flags,
      };

      if (hasPositionValue) {
        result.positionValue = Math.round(positionValue);
        result.var95Amount1d = Math.round(Math.abs(histVaR95) * positionValue);
        result.var99Amount1d = Math.round(Math.abs(histVaR99) * positionValue);
        result.cvar95Amount1d = Math.round(Math.abs(cvar95) * positionValue);
        result.var95Amount10d = Math.round(
          Math.abs(histVaR95_10d) * positionValue,
        );
        result.selectedVarAmount1d = Math.round(
          Math.abs(selectedHistVaR1d) * positionValue,
        );
        result.selectedVarAmountHorizon = Math.round(
          Math.abs(selectedHistVaRHorizon) * positionValue,
        );
      }

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Position VaR computation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
