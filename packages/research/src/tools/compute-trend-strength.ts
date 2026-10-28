/**
 * Trend Strength Analysis
 *
 * Quantifies trend direction & strength from price history:
 *  - Linear regression of log(close) over a lookback → annualized slope% + R²
 *    (R² = trend consistency / how cleanly the trend fits a straight line)
 *  - ADX(14) from highs/lows/closes for strength (>25 trending, >40 strong);
 *    skipped when highs/lows are absent
 *  - SMA alignment: price vs 20/50/200 + the 20>50>200 bullish stack
 *  - distanceFrom200SMA%
 *  - Regime classification + bars since the last regime flip (trendDurationBars)
 *
 * PURE compute tool — reads everything from params (closes/highs/lows fed by the
 * executor from fetch_price_history.prices[]). No network / db / io.
 *
 * SEBI: emits observations / scores / flags only. No buy/sell/hold/target advice.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

export type TrendRegime =
  | "strong uptrend"
  | "uptrend"
  | "sideways"
  | "downtrend"
  | "strong downtrend";

export interface TrendStrengthResult {
  available: boolean;
  reason?: string;
  symbol?: string;
  /** Number of closes used for the regression lookback. */
  lookback: number;
  /** Annualized slope of log(close) regression, in percent (e.g. 18.4 = +18.4%/yr). */
  annualizedSlopePct: number;
  /** R² of the log(close) ~ time regression (0-1). Higher = more consistent trend. */
  r2: number;
  /** ADX(14) value (0-100), or null when highs/lows are unavailable. */
  adx: number | null;
  /** Latest SMAs over the full series (null when series too short for the window). */
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  /** Latest close used as the reference price. */
  currentPrice: number;
  /** Price vs each SMA. */
  priceAboveSma20: boolean | null;
  priceAboveSma50: boolean | null;
  priceAboveSma200: boolean | null;
  /** True when SMA stack is 20 > 50 > 200 (bullish alignment). */
  smaStackBullish: boolean | null;
  /** True when SMA stack is 20 < 50 < 200 (bearish alignment). */
  smaStackBearish: boolean | null;
  /** (price - sma200) / sma200, in percent. null when sma200 unavailable. */
  distanceFrom200SmaPct: number | null;
  /** Classified regime over the lookback window. */
  regime: TrendRegime;
  /** Bars since the most recent regime flip (consistency of current regime). */
  trendDurationBars: number;
  /** Observation flags (no advice). */
  flags: string[];
}

const TRADING_DAYS_PER_YEAR = 252;

/** Simple moving average of the last `period` values; null if not enough data. */
function latestSma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) {
    sum += values[i]!;
  }
  return sum / period;
}

/**
 * Ordinary-least-squares regression of y on x (0..n-1).
 * Returns the per-bar slope and the coefficient of determination R².
 */
function linearRegression(y: number[]): { slopePerBar: number; r2: number } {
  const n = y.length;
  if (n < 2) return { slopePerBar: 0, r2: 0 };

  // x = 0,1,...,n-1 → closed-form means
  const meanX = (n - 1) / 2;
  let meanY = 0;
  for (let i = 0; i < n; i++) meanY += y[i]!;
  meanY /= n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    const dy = y[i]! - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }

  const slopePerBar = sxx !== 0 ? sxy / sxx : 0;
  // R² = (covariance)² / (var_x * var_y)
  const r2 = sxx > 0 && syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;

  return { slopePerBar, r2: Math.max(0, Math.min(1, r2)) };
}

/**
 * Wilder's ADX(14) from highs/lows/closes. Returns the latest ADX (0-100)
 * or null when there is insufficient data for two smoothing windows.
 */
function computeAdx(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14,
): number | null {
  const n = closes.length;
  // Need at least 2*period+1 bars for a stable ADX reading.
  if (n < 2 * period + 1) return null;
  if (highs.length !== n || lows.length !== n) return null;

  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < n; i++) {
    const upMove = highs[i]! - highs[i - 1]!;
    const downMove = lows[i - 1]! - lows[i]!;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const hl = highs[i]! - lows[i]!;
    const hc = Math.abs(highs[i]! - closes[i - 1]!);
    const lc = Math.abs(lows[i]! - closes[i - 1]!);
    tr.push(Math.max(hl, hc, lc));
  }

  // Wilder smoothing (first value = simple sum of the first `period` entries).
  const wilder = (src: number[]): number[] => {
    const out: number[] = [];
    let prev = 0;
    for (let i = 0; i < period; i++) prev += src[i]!;
    out.push(prev);
    for (let i = period; i < src.length; i++) {
      prev = prev - prev / period + src[i]!;
      out.push(prev);
    }
    return out;
  };

  const smTr = wilder(tr);
  const smPlusDM = wilder(plusDM);
  const smMinusDM = wilder(minusDM);

  const dx: number[] = [];
  for (let i = 0; i < smTr.length; i++) {
    const atr = smTr[i]!;
    if (atr === 0) {
      dx.push(0);
      continue;
    }
    const plusDI = (smPlusDM[i]! / atr) * 100;
    const minusDI = (smMinusDM[i]! / atr) * 100;
    const diSum = plusDI + minusDI;
    dx.push(diSum === 0 ? 0 : (Math.abs(plusDI - minusDI) / diSum) * 100);
  }

  if (dx.length < period) return null;

  // ADX = Wilder-smoothed average of DX.
  let adx = 0;
  for (let i = 0; i < period; i++) adx += dx[i]!;
  adx /= period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]!) / period;
  }

  return Math.round(adx * 10) / 10;
}

/**
 * Classify a single bar's regime from its annualized slope% and R².
 * Mirrors the headline `regime` thresholds so duration tracking is consistent.
 */
function classifyRegime(annualizedSlopePct: number, r2: number): TrendRegime {
  // Weak fit / shallow slope → sideways.
  if (Math.abs(annualizedSlopePct) < 8 || r2 < 0.2) return "sideways";
  if (annualizedSlopePct > 0) {
    return annualizedSlopePct >= 25 && r2 >= 0.6 ? "strong uptrend" : "uptrend";
  }
  return annualizedSlopePct <= -25 && r2 >= 0.6
    ? "strong downtrend"
    : "downtrend";
}

/**
 * Bars since the last regime flip: walk a rolling regression window backward
 * from the latest bar and count how many consecutive bars share the latest
 * regime. Bounded by the available history.
 */
function computeTrendDurationBars(
  logCloses: number[],
  window: number,
  currentRegime: TrendRegime,
): number {
  const n = logCloses.length;
  if (n < window) return n;

  let duration = 0;
  // Slide the window's right edge from the latest bar backward.
  for (let end = n; end >= window; end--) {
    const slice = logCloses.slice(end - window, end);
    const { slopePerBar, r2 } = linearRegression(slice);
    const annSlopePct = (Math.exp(slopePerBar * TRADING_DAYS_PER_YEAR) - 1) * 100;
    const regime = classifyRegime(annSlopePct, r2);
    if (regime === currentRegime) {
      duration++;
    } else {
      break;
    }
  }

  return duration;
}

export const computeTrendStrengthTool: ResearchToolDef = {
  name: "compute_trend_strength",
  description:
    "Quantify trend strength & direction - log-price regression slope% + R², ADX(14), SMA alignment, regime classification",
  category: "computation",
  parameters: {
    closes: {
      type: "array",
      description:
        "Array of closing prices sorted chronologically (oldest first). From fetch_price_history.prices[].close",
      required: true,
    },
    highs: {
      type: "array",
      description:
        "Array of high prices (same order/length as closes). Enables ADX(14). From fetch_price_history.prices[].high",
    },
    lows: {
      type: "array",
      description:
        "Array of low prices (same order/length as closes). Enables ADX(14). From fetch_price_history.prices[].low",
    },
    lookback: {
      type: "number",
      description: "Regression lookback window in bars (default 60)",
      default: 60,
    },
    symbol: {
      type: "string",
      description: "Optional symbol for labeling the result",
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const rawCloses = params.closes;
    const rawHighs = params.highs;
    const rawLows = params.lows;
    const symbol =
      typeof params.symbol === "string" ? params.symbol : undefined;

    // Sanitize closes → finite positive numbers (log-price needs >0).
    const closes = Array.isArray(rawCloses)
      ? rawCloses
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v) && v > 0)
      : [];

    if (closes.length < 30) {
      const result: TrendStrengthResult = {
        available: false,
        reason: `Insufficient price history (${closes.length} valid closes, need >= 30)`,
        symbol,
        lookback: 0,
        annualizedSlopePct: 0,
        r2: 0,
        adx: null,
        sma20: null,
        sma50: null,
        sma200: null,
        currentPrice: closes.length > 0 ? closes[closes.length - 1]! : 0,
        priceAboveSma20: null,
        priceAboveSma50: null,
        priceAboveSma200: null,
        smaStackBullish: null,
        smaStackBearish: null,
        distanceFrom200SmaPct: null,
        regime: "sideways",
        trendDurationBars: 0,
        flags: [],
      };
      return { success: true, data: result };
    }

    try {
      const flags: string[] = [];
      const currentPrice = closes[closes.length - 1]!;

      // ─── Regression of log(close) over the lookback window ───
      const requestedLookback =
        typeof params.lookback === "number" && Number.isFinite(params.lookback)
          ? Math.floor(params.lookback)
          : 60;
      const lookback = Math.max(
        2,
        Math.min(requestedLookback > 0 ? requestedLookback : 60, closes.length),
      );

      const window = closes.slice(closes.length - lookback);
      const logWindow = window.map((v) => Math.log(v));
      const { slopePerBar, r2 } = linearRegression(logWindow);

      // Annualize: a per-bar log slope compounds over ~252 trading days.
      const annualizedSlopePct =
        Math.round(
          (Math.exp(slopePerBar * TRADING_DAYS_PER_YEAR) - 1) * 100 * 100,
        ) / 100;
      const r2Rounded = Math.round(r2 * 1000) / 1000;

      // ─── SMA alignment ───
      const sma20Raw = latestSma(closes, 20);
      const sma50Raw = latestSma(closes, 50);
      const sma200Raw = latestSma(closes, 200);

      const round2 = (v: number | null): number | null =>
        v === null ? null : Math.round(v * 100) / 100;
      const sma20 = round2(sma20Raw);
      const sma50 = round2(sma50Raw);
      const sma200 = round2(sma200Raw);

      const priceAboveSma20 = sma20Raw === null ? null : currentPrice > sma20Raw;
      const priceAboveSma50 = sma50Raw === null ? null : currentPrice > sma50Raw;
      const priceAboveSma200 =
        sma200Raw === null ? null : currentPrice > sma200Raw;

      const smaStackBullish =
        sma20Raw !== null && sma50Raw !== null && sma200Raw !== null
          ? sma20Raw > sma50Raw && sma50Raw > sma200Raw
          : null;
      const smaStackBearish =
        sma20Raw !== null && sma50Raw !== null && sma200Raw !== null
          ? sma20Raw < sma50Raw && sma50Raw < sma200Raw
          : null;

      const distanceFrom200SmaPct =
        sma200Raw !== null && sma200Raw !== 0
          ? Math.round(((currentPrice - sma200Raw) / sma200Raw) * 100 * 100) /
            100
          : null;

      // ─── ADX(14) — only when highs & lows present and aligned ───
      const highs = Array.isArray(rawHighs)
        ? rawHighs.map((v) => Number(v))
        : null;
      const lows = Array.isArray(rawLows) ? rawLows.map((v) => Number(v)) : null;

      let adx: number | null = null;
      if (
        highs &&
        lows &&
        highs.length === closes.length &&
        lows.length === closes.length &&
        highs.every((v) => Number.isFinite(v)) &&
        lows.every((v) => Number.isFinite(v))
      ) {
        adx = computeAdx(highs, lows, closes, 14);
      }

      // ─── Regime classification (headline) ───
      const regime = classifyRegime(annualizedSlopePct, r2);

      // ─── Trend duration (bars since last regime flip) ───
      const logCloses = closes.map((v) => Math.log(v));
      const trendDurationBars = computeTrendDurationBars(
        logCloses,
        lookback,
        regime,
      );

      // ─── Observation flags (no advice) ───
      if (adx !== null) {
        if (adx >= 40) {
          flags.push(`Very strong trend - ADX ${adx.toFixed(1)} (>40)`);
        } else if (adx >= 25) {
          flags.push(`Trending - ADX ${adx.toFixed(1)} (>25)`);
        } else if (adx < 20) {
          flags.push(`Weak / non-trending - ADX ${adx.toFixed(1)} (<20)`);
        }
      } else {
        flags.push("ADX skipped - highs/lows unavailable");
      }

      if (r2 >= 0.7) {
        flags.push(
          `Highly consistent trend - R² ${r2Rounded.toFixed(2)} (low noise)`,
        );
      } else if (r2 < 0.2) {
        flags.push(
          `Choppy / inconsistent price action - R² ${r2Rounded.toFixed(2)}`,
        );
      }

      if (smaStackBullish === true) {
        flags.push("Bullish SMA stack - 20 > 50 > 200");
      } else if (smaStackBearish === true) {
        flags.push("Bearish SMA stack - 20 < 50 < 200");
      }

      if (distanceFrom200SmaPct !== null) {
        if (distanceFrom200SmaPct > 20) {
          flags.push(
            `Price extended ${distanceFrom200SmaPct.toFixed(1)}% above 200-SMA`,
          );
        } else if (distanceFrom200SmaPct < -20) {
          flags.push(
            `Price extended ${Math.abs(distanceFrom200SmaPct).toFixed(1)}% below 200-SMA`,
          );
        }
      } else {
        flags.push("200-SMA unavailable - need >= 200 bars for full alignment");
      }

      const result: TrendStrengthResult = {
        available: true,
        symbol,
        lookback,
        annualizedSlopePct,
        r2: r2Rounded,
        adx,
        sma20,
        sma50,
        sma200,
        currentPrice: Math.round(currentPrice * 100) / 100,
        priceAboveSma20,
        priceAboveSma50,
        priceAboveSma200,
        smaStackBullish,
        smaStackBearish,
        distanceFrom200SmaPct,
        regime,
        trendDurationBars,
        flags,
      };

      return { success: true, data: result };
    } catch (error) {
      return {
        success: false,
        error: `Trend strength analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
