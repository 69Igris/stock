/**
 * Shared Technical Indicator Library
 *
 * Consolidated indicator implementations used by:
 * - compute-technical-analysis.ts
 * - evaluate-strategy.ts
 * - scan-strategy-multi.ts
 * - chart-patterns.ts
 * - candlestick-patterns.ts
 *
 * Total: 24+ indicator families
 */

// ─── Core Indicators (existing) ─────────────────────────────

/** Simple Moving Average - last N-period average */
export function sma(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const slice = prices.slice(-period);
  return slice.reduce((s, p) => s + p, 0) / period;
}

/** Exponential Moving Average - returns full EMA array */
export function ema(prices: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const values: number[] = [prices[0]!];
  for (let i = 1; i < prices.length; i++) {
    values.push(prices[i]! * k + values[i - 1]! * (1 - k));
  }
  return values;
}

/** Last value of EMA array - convenience helper */
export function emaLast(prices: number[], period: number): number {
  const vals = ema(prices, period);
  return vals[vals.length - 1]!;
}

/** RSI - Relative Strength Index using Wilder's smoothing */
export function computeRSI(prices: number[], period: number): number {
  if (prices.length < period + 1) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[i]! - prices[i - 1]!;
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i]! - prices[i - 1]!;
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

/** MACD - returns { macdLine, signalLine, histogram } */
export function computeMACD(
  prices: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { macdLine: number; signalLine: number; histogram: number } {
  // Guard empty input: ema([]) yields [undefined] and the arithmetic below
  // would leak NaN. Return a neutral zero MACD instead.
  if (prices.length === 0) {
    return { macdLine: 0, signalLine: 0, histogram: 0 };
  }
  const emaFast = ema(prices, fastPeriod);
  const emaSlow = ema(prices, slowPeriod);
  const macdLine =
    Math.round(
      (emaFast[emaFast.length - 1]! - emaSlow[emaSlow.length - 1]!) * 100,
    ) / 100;

  const macdValues: number[] = [];
  const minLen = Math.min(emaFast.length, emaSlow.length);
  for (let i = 0; i < minLen; i++) {
    macdValues.push(emaFast[i]! - emaSlow[i]!);
  }
  const signalLineValues = ema(macdValues, signalPeriod);
  const signalLine =
    Math.round(signalLineValues[signalLineValues.length - 1]! * 100) / 100;
  const histogram = Math.round((macdLine - signalLine) * 100) / 100;

  return { macdLine, signalLine, histogram };
}

/** Bollinger Bands - { upper, middle, lower, bandwidth } */
export function computeBollingerBands(
  prices: number[],
  period = 20,
  stddevMultiplier = 2,
): { upper: number; middle: number; lower: number; bandwidth: number } {
  const slice = prices.slice(-period);
  const mean = slice.reduce((s, p) => s + p, 0) / period;
  const stdDev = Math.sqrt(
    slice.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / period,
  );
  const upper = Math.round((mean + stddevMultiplier * stdDev) * 100) / 100;
  const lower = Math.round((mean - stddevMultiplier * stdDev) * 100) / 100;
  const middle = Math.round(mean * 100) / 100;
  const bandwidth =
    mean > 0 ? Math.round(((upper - lower) / mean) * 10000) / 100 : 0;
  return { upper, middle, lower, bandwidth };
}

/** Support/Resistance from percentile analysis */
export function findSupportResistance(prices: number[]): {
  support: number;
  resistance: number;
} {
  // Guard empty input: Math.min()/Math.max() of an empty spread return
  // +Infinity / -Infinity. Return finite zeros instead of leaking Infinity.
  if (prices.length === 0) {
    return { support: 0, resistance: 0 };
  }
  if (prices.length < 20) {
    return {
      support: Math.min(...prices),
      resistance: Math.max(...prices),
    };
  }
  const recent = prices.slice(-60);
  const sorted = [...recent].sort((a, b) => a - b);
  const len = sorted.length;
  return {
    support: Math.round(sorted[Math.floor(len * 0.1)]! * 100) / 100,
    resistance: Math.round(sorted[Math.floor(len * 0.9)]! * 100) / 100,
  };
}

/** Stochastic %K/%D */
export function computeStochastic(
  prices: number[],
  highs: number[],
  lows: number[],
  period = 14,
): { percentK: number; percentD: number } | null {
  if (prices.length < period) return null;
  const recentHighs = highs.slice(-period);
  const recentLows = lows.slice(-period);
  const highestHigh = Math.max(...recentHighs);
  const lowestLow = Math.min(...recentLows);
  const denom = highestHigh - lowestLow;
  const currentPrice = prices[prices.length - 1]!;
  const percentK = denom > 0 ? ((currentPrice - lowestLow) / denom) * 100 : 50;
  // Simplified %D (single value approximation)
  return {
    percentK: Math.round(percentK * 100) / 100,
    percentD: Math.round(percentK * 100) / 100,
  };
}

/** ATR - Average True Range (returns last ATR value) */
export function computeATR(
  prices: number[],
  highs: number[],
  lows: number[],
  period = 14,
): number | null {
  if (prices.length < period + 1) return null;
  const trueRanges = computeTrueRanges(prices, highs, lows);
  if (trueRanges.length < period) return null;
  const atrSlice = trueRanges.slice(-period);
  return Math.round((atrSlice.reduce((s, v) => s + v, 0) / period) * 100) / 100;
}

/** True Range array - building block for ATR, ADX, Supertrend */
export function computeTrueRanges(
  prices: number[],
  highs: number[],
  lows: number[],
): number[] {
  const trueRanges: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const tr = Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - prices[i - 1]!),
      Math.abs(lows[i]! - prices[i - 1]!),
    );
    trueRanges.push(tr);
  }
  return trueRanges;
}

/** ADX - Average Directional Index */
export function computeADX(
  prices: number[],
  highs: number[],
  lows: number[],
  period = 14,
): number | null {
  if (prices.length < period * 2) return null;
  const trueRanges = computeTrueRanges(prices, highs, lows);
  if (trueRanges.length < period) return null;

  const plusDMs: number[] = [];
  const minusDMs: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const upMove = highs[i]! - highs[i - 1]!;
    const downMove = lows[i - 1]! - lows[i]!;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let smoothPlusDM = plusDMs.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothMinusDM = minusDMs.slice(0, period).reduce((s, v) => s + v, 0);
  let smoothTR = trueRanges.slice(0, period).reduce((s, v) => s + v, 0);
  const dxValues: number[] = [];

  for (let i = period; i < plusDMs.length; i++) {
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMs[i]!;
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMs[i]!;
    smoothTR = smoothTR - smoothTR / period + trueRanges[i]!;
    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    dxValues.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
  }

  if (dxValues.length < period) return null;
  const adx = dxValues.slice(-period).reduce((s, v) => s + v, 0) / period;
  return Math.round(adx * 100) / 100;
}

/** Supertrend - { value, direction } */
export function computeSupertrend(
  prices: number[],
  highs: number[],
  lows: number[],
  period = 10,
  multiplier = 3,
): { value: number; direction: "bullish" | "bearish" | "neutral" } | null {
  const trueRanges = computeTrueRanges(prices, highs, lows);
  if (trueRanges.length < period) return null;

  const stAtrSlice = trueRanges.slice(-period);
  const stAtr = stAtrSlice.reduce((s, v) => s + v, 0) / period;
  const lastIdx = prices.length - 1;
  const hl2 = (highs[lastIdx]! + lows[lastIdx]!) / 2;
  const upperBand = hl2 + multiplier * stAtr;
  const lowerBand = hl2 - multiplier * stAtr;
  const currentPrice = prices[lastIdx]!;

  const direction =
    currentPrice > upperBand
      ? "bearish"
      : currentPrice < lowerBand
        ? "bullish"
        : "neutral";
  return {
    value: direction === "bullish" ? lowerBand : upperBand,
    direction,
  };
}

/** Classic Pivot Points - { pivot, r1, r2, s1, s2 } */
export function computePivotPoints(
  close: number,
  high: number,
  low: number,
): { pivot: number; r1: number; r2: number; s1: number; s2: number } {
  const pivot = (high + low + close) / 3;
  return {
    pivot: Math.round(pivot * 100) / 100,
    r1: Math.round((2 * pivot - low) * 100) / 100,
    r2: Math.round((pivot + (high - low)) * 100) / 100,
    s1: Math.round((2 * pivot - high) * 100) / 100,
    s2: Math.round((pivot - (high - low)) * 100) / 100,
  };
}

/** OBV - On-Balance Volume */
export function computeOBV(prices: number[], volumes: number[]): number {
  let obv = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i]! > prices[i - 1]!) obv += volumes[i]!;
    else if (prices[i]! < prices[i - 1]!) obv -= volumes[i]!;
  }
  return obv;
}

/** VWAP - Volume-Weighted Average Price */
export function computeVWAP(
  prices: number[],
  highs: number[],
  lows: number[],
  volumes: number[],
): number {
  let cumVolPrice = 0;
  let cumVol = 0;
  for (let i = 0; i < prices.length; i++) {
    const typical = (highs[i]! + lows[i]! + prices[i]!) / 3;
    cumVolPrice += typical * volumes[i]!;
    cumVol += volumes[i]!;
  }
  return cumVol > 0
    ? Math.round((cumVolPrice / cumVol) * 100) / 100
    : prices[prices.length - 1]!;
}

/** Volume ratio - current vs N-period average */
export function computeVolumeRatio(volumes: number[], period = 20): number {
  if (volumes.length < period + 1) return 1;
  const avgVol =
    volumes.slice(-(period + 1), -1).reduce((s, v) => s + v, 0) / period;
  const currentVol = volumes[volumes.length - 1]!;
  return avgVol > 0 ? currentVol / avgVol : 1;
}

// ─── New Indicators (Phase S1) ─────────────────────────────

/** CCI - Commodity Channel Index */
export function computeCCI(
  prices: number[],
  highs: number[],
  lows: number[],
  period = 20,
): number | null {
  if (prices.length < period) return null;

  // Typical prices
  const typicalPrices: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    typicalPrices.push((highs[i]! + lows[i]! + prices[i]!) / 3);
  }

  const recent = typicalPrices.slice(-period);
  const smaTP = recent.reduce((s, v) => s + v, 0) / period;
  const meanDeviation =
    recent.reduce((s, v) => s + Math.abs(v - smaTP), 0) / period;

  if (meanDeviation === 0) return 0;
  return (
    Math.round(
      ((recent[recent.length - 1]! - smaTP) / (0.015 * meanDeviation)) * 100,
    ) / 100
  );
}

/** MFI - Money Flow Index (volume-weighted RSI) */
export function computeMFI(
  prices: number[],
  highs: number[],
  lows: number[],
  volumes: number[],
  period = 14,
): number | null {
  if (prices.length < period + 1) return null;

  const typicalPrices: number[] = [];
  for (let i = 0; i < prices.length; i++) {
    typicalPrices.push((highs[i]! + lows[i]! + prices[i]!) / 3);
  }

  let positiveFlow = 0;
  let negativeFlow = 0;

  const start = Math.max(1, typicalPrices.length - period);
  for (let i = start; i < typicalPrices.length; i++) {
    const rawMoneyFlow = typicalPrices[i]! * volumes[i]!;
    if (typicalPrices[i]! > typicalPrices[i - 1]!) {
      positiveFlow += rawMoneyFlow;
    } else if (typicalPrices[i]! < typicalPrices[i - 1]!) {
      negativeFlow += rawMoneyFlow;
    }
  }

  if (negativeFlow === 0) return 100;
  const moneyFlowRatio = positiveFlow / negativeFlow;
  return Math.round((100 - 100 / (1 + moneyFlowRatio)) * 100) / 100;
}

/** Williams %R */
export function computeWilliamsR(
  prices: number[],
  highs: number[],
  lows: number[],
  period = 14,
): number | null {
  if (prices.length < period) return null;

  const recentHighs = highs.slice(-period);
  const recentLows = lows.slice(-period);
  const highestHigh = Math.max(...recentHighs);
  const lowestLow = Math.min(...recentLows);
  const currentPrice = prices[prices.length - 1]!;
  const denom = highestHigh - lowestLow;

  if (denom === 0) return -50;
  return Math.round(((highestHigh - currentPrice) / denom) * -100 * 100) / 100;
}

/** ROC - Rate of Change */
export function computeROC(prices: number[], period = 12): number | null {
  if (prices.length < period + 1) return null;
  const currentPrice = prices[prices.length - 1]!;
  const pastPrice = prices[prices.length - 1 - period]!;
  if (pastPrice === 0) return 0;
  return Math.round(((currentPrice - pastPrice) / pastPrice) * 100 * 100) / 100;
}

/** PSAR - Parabolic SAR
 * Returns { value, trend } for the last bar */
export function computePSAR(
  highs: number[],
  lows: number[],
  afStart = 0.02,
  afStep = 0.02,
  afMax = 0.2,
): { value: number; trend: "bullish" | "bearish" } | null {
  if (highs.length < 3) return null;

  let trend: "bullish" | "bearish" =
    highs[1]! > highs[0]! ? "bullish" : "bearish";
  let sar = trend === "bullish" ? lows[0]! : highs[0]!;
  let ep = trend === "bullish" ? highs[0]! : lows[0]!;
  let af = afStart;

  for (let i = 1; i < highs.length; i++) {
    const prevSar = sar;

    // Update SAR
    sar = prevSar + af * (ep - prevSar);

    if (trend === "bullish") {
      // SAR must be at or below the prior two lows
      if (i >= 2) {
        sar = Math.min(sar, lows[i - 1]!, lows[i - 2]!);
      }

      if (lows[i]! < sar) {
        // Reversal to bearish
        trend = "bearish";
        sar = ep;
        ep = lows[i]!;
        af = afStart;
      } else {
        if (highs[i]! > ep) {
          ep = highs[i]!;
          af = Math.min(af + afStep, afMax);
        }
      }
    } else {
      // SAR must be at or above the prior two highs
      if (i >= 2) {
        sar = Math.max(sar, highs[i - 1]!, highs[i - 2]!);
      }

      if (highs[i]! > sar) {
        // Reversal to bullish
        trend = "bullish";
        sar = ep;
        ep = highs[i]!;
        af = afStart;
      } else {
        if (lows[i]! < ep) {
          ep = lows[i]!;
          af = Math.min(af + afStep, afMax);
        }
      }
    }
  }

  return { value: Math.round(sar * 100) / 100, trend };
}

/** Ichimoku Cloud - { tenkan, kijun, senkouA, senkouB, chikou } */
export function computeIchimoku(
  prices: number[],
  highs: number[],
  lows: number[],
  tenkanPeriod = 9,
  kijunPeriod = 26,
  senkouBPeriod = 52,
): {
  tenkan: number;
  kijun: number;
  senkouA: number;
  senkouB: number;
  chikou: number;
  cloudTop: number;
  cloudBottom: number;
  priceVsCloud: "above" | "below" | "inside";
} | null {
  if (prices.length < senkouBPeriod) return null;

  const midpoint = (h: number[], l: number[], period: number): number => {
    const recentH = h.slice(-period);
    const recentL = l.slice(-period);
    return (Math.max(...recentH) + Math.min(...recentL)) / 2;
  };

  const tenkan = Math.round(midpoint(highs, lows, tenkanPeriod) * 100) / 100;
  const kijun = Math.round(midpoint(highs, lows, kijunPeriod) * 100) / 100;
  const senkouA = Math.round(((tenkan + kijun) / 2) * 100) / 100;
  const senkouB = Math.round(midpoint(highs, lows, senkouBPeriod) * 100) / 100;
  const chikou = prices[prices.length - 1]!; // Current price (offset by 26 in charting)

  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);
  const currentPrice = prices[prices.length - 1]!;

  let priceVsCloud: "above" | "below" | "inside" = "inside";
  if (currentPrice > cloudTop) priceVsCloud = "above";
  else if (currentPrice < cloudBottom) priceVsCloud = "below";

  return {
    tenkan,
    kijun,
    senkouA,
    senkouB,
    chikou,
    cloudTop,
    cloudBottom,
    priceVsCloud,
  };
}

/** Beta - Cov(stock, index) / Var(index) */
export function computeBeta(
  stockPrices: number[],
  indexPrices: number[],
  period = 252,
): number | null {
  const len = Math.min(stockPrices.length, indexPrices.length, period + 1);
  if (len < 30) return null;

  // Use last `len` prices
  const stock = stockPrices.slice(-len);
  const index = indexPrices.slice(-len);

  // Compute returns
  const stockReturns: number[] = [];
  const indexReturns: number[] = [];
  for (let i = 1; i < stock.length; i++) {
    stockReturns.push((stock[i]! - stock[i - 1]!) / stock[i - 1]!);
    indexReturns.push((index[i]! - index[i - 1]!) / index[i - 1]!);
  }

  const n = stockReturns.length;
  const meanStock = stockReturns.reduce((s, v) => s + v, 0) / n;
  const meanIndex = indexReturns.reduce((s, v) => s + v, 0) / n;

  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const dStock = stockReturns[i]! - meanStock;
    const dIndex = indexReturns[i]! - meanIndex;
    covariance += dStock * dIndex;
    variance += dIndex * dIndex;
  }

  if (variance === 0) return null;
  return Math.round((covariance / variance) * 100) / 100;
}

/** NR - Narrow Range detection (NR4 and NR7) */
export function detectNarrowRange(
  highs: number[],
  lows: number[],
): { nr4: boolean; nr7: boolean; currentRange: number } | null {
  if (highs.length < 7) return null;

  const ranges: number[] = [];
  for (let i = 0; i < highs.length; i++) {
    ranges.push(highs[i]! - lows[i]!);
  }

  const currentRange = ranges[ranges.length - 1]!;
  const last3 = ranges.slice(-4, -1); // Last 3 days before today
  const last6 = ranges.slice(-7, -1); // Last 6 days before today

  const nr4 = last3.every((r) => currentRange <= r);
  const nr7 = last6.every((r) => currentRange <= r);

  return { nr4, nr7, currentRange: Math.round(currentRange * 100) / 100 };
}

// ─── Weekly Variants ─────────────────────────────────────────

/** Convert daily prices to weekly (by taking every 5th close, or last in each week) */
export function toWeekly(dailyPrices: number[]): number[] {
  const weekly: number[] = [];
  for (let i = 4; i < dailyPrices.length; i += 5) {
    weekly.push(dailyPrices[i]!);
  }
  // Include the last price if not already included
  if (dailyPrices.length % 5 !== 0) {
    weekly.push(dailyPrices[dailyPrices.length - 1]!);
  }
  return weekly;
}

/** Weekly SMA */
export function weeklySMA(dailyPrices: number[], period: number): number {
  return sma(toWeekly(dailyPrices), period);
}

/** Weekly EMA */
export function weeklyEMA(dailyPrices: number[], period: number): number {
  const vals = ema(toWeekly(dailyPrices), period);
  return vals[vals.length - 1]!;
}

/** Weekly RSI */
export function weeklyRSI(dailyPrices: number[], period = 14): number {
  return computeRSI(toWeekly(dailyPrices), period);
}

// ─── Strategy Rule Evaluation ────────────────────────────────

export interface StrategyRule {
  indicator: string;
  condition: string;
  params?: Record<string, number>;
  value?: number;
  value2?: number;
}

export interface StrategyDefinition {
  name: string;
  rules: StrategyRule[];
  timeframe?: string;
}

export interface SignalResult {
  indicator: string;
  value: number;
  condition: string;
  met: boolean;
  detail: string;
}

/** Evaluate a single strategy rule against price data */
export function evaluateRule(
  rule: StrategyRule,
  prices: number[],
  volumes?: number[],
  highs?: number[],
  lows?: number[],
): SignalResult {
  const params = rule.params || {};
  const currentPrice = prices[prices.length - 1]!;

  switch (rule.indicator) {
    case "rsi": {
      const period = params.period || 14;
      const rsi = computeRSI(prices, period);
      const threshold = rule.value ?? 50;
      let met = false;
      let detail = `RSI(${period}) = ${rsi}`;
      if (rule.condition === "above") {
        met = rsi > threshold;
        detail += met ? ` - above ${threshold} ✓` : ` - below ${threshold} ✗`;
      } else if (rule.condition === "below") {
        met = rsi < threshold;
        detail += met ? ` - below ${threshold} ✓` : ` - above ${threshold} ✗`;
      } else if (rule.condition === "between") {
        const lo = rule.value ?? 40;
        const hi = rule.value2 ?? 60;
        met = rsi >= lo && rsi <= hi;
        detail += met
          ? ` - in range [${lo},${hi}] ✓`
          : ` - outside [${lo},${hi}] ✗`;
      }
      return {
        indicator: `RSI(${period})`,
        value: rsi,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "sma_crossover": {
      const fast = params.fast || 50;
      const slow = params.slow || 200;
      const smaFast = sma(prices, fast);
      const smaSlow = sma(prices, slow);
      let met = false;
      let detail = `SMA${fast} = ${smaFast.toFixed(2)}, SMA${slow} = ${smaSlow.toFixed(2)}`;
      if (rule.condition === "crossover" || rule.condition === "above") {
        met = smaFast > smaSlow;
        detail += met ? ` - fast above slow ✓` : ` - fast below slow ✗`;
      } else if (
        rule.condition === "crossunder" ||
        rule.condition === "below"
      ) {
        met = smaFast < smaSlow;
        detail += met ? ` - fast below slow ✓` : ` - fast above slow ✗`;
      }
      return {
        indicator: `SMA(${fast}/${slow})`,
        value: smaFast,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "ema_crossover": {
      const fast = params.fast || 9;
      const slow = params.slow || 21;
      const emaFast = ema(prices, fast);
      const emaSlow = ema(prices, slow);
      const fv = emaFast[emaFast.length - 1]!;
      const sv = emaSlow[emaSlow.length - 1]!;
      let met = false;
      let detail = `EMA${fast} = ${fv.toFixed(2)}, EMA${slow} = ${sv.toFixed(2)}`;
      if (rule.condition === "crossover" || rule.condition === "above") {
        met = fv > sv;
        detail += met ? ` - fast above slow ✓` : ` - fast below slow ✗`;
      } else if (
        rule.condition === "crossunder" ||
        rule.condition === "below"
      ) {
        met = fv < sv;
        detail += met ? ` - fast below slow ✓` : ` - fast above slow ✗`;
      }
      return {
        indicator: `EMA(${fast}/${slow})`,
        value: fv,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "macd": {
      const macd = computeMACD(prices);
      let met = false;
      let detail = `MACD = ${macd.macdLine.toFixed(2)}, Signal = ${macd.signalLine.toFixed(2)}`;
      if (rule.condition === "crossover" || rule.condition === "bullish") {
        met = macd.macdLine > macd.signalLine;
        detail += met ? ` - bullish ✓` : ` - not bullish ✗`;
      } else if (
        rule.condition === "crossunder" ||
        rule.condition === "bearish"
      ) {
        met = macd.macdLine < macd.signalLine;
        detail += met ? ` - bearish ✓` : ` - not bearish ✗`;
      }
      return {
        indicator: "MACD",
        value: macd.macdLine,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "bollinger": {
      const period = params.period || 20;
      const stddev = params.stddev || 2;
      const bb = computeBollingerBands(prices, period, stddev);
      let met = false;
      let detail = `BB: upper=${bb.upper.toFixed(2)}, lower=${bb.lower.toFixed(2)}, width=${bb.bandwidth.toFixed(2)}%`;
      if (rule.condition === "below_lower") {
        met = currentPrice < bb.lower;
        detail += met ? ` - price below lower ✓` : ` - price above lower ✗`;
      } else if (rule.condition === "above_upper") {
        met = currentPrice > bb.upper;
        detail += met ? ` - price above upper ✓` : ` - price below upper ✗`;
      } else if (rule.condition === "squeeze") {
        const threshold = params.threshold || 5;
        met = bb.bandwidth < threshold;
        detail += met
          ? ` - squeeze detected (width < ${threshold}%) ✓`
          : ` - no squeeze ✗`;
      }
      return {
        indicator: "Bollinger Bands",
        value: bb.bandwidth,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "price_vs_sma": {
      const period = params.period || 50;
      const smaVal = sma(prices, period);
      let met = false;
      let detail = `Price = ${currentPrice.toFixed(2)}, SMA${period} = ${smaVal.toFixed(2)}`;
      if (rule.condition === "above") {
        met = currentPrice > smaVal;
        detail += met ? ` - price above SMA ✓` : ` - price below SMA ✗`;
      } else if (rule.condition === "below") {
        met = currentPrice < smaVal;
        detail += met ? ` - price below SMA ✓` : ` - price above SMA ✗`;
      }
      return {
        indicator: `Price vs SMA(${period})`,
        value: currentPrice,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "volume": {
      if (!volumes || volumes.length < 20) {
        return {
          indicator: "Volume",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "Volume data not available",
        };
      }
      const avgVol = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
      const currentVol = volumes[volumes.length - 1]!;
      const multiplier = params.multiplier || 2;
      const ratio = currentVol / avgVol;
      let met = false;
      let detail = `Volume = ${currentVol.toLocaleString()}, Avg = ${Math.round(avgVol).toLocaleString()}, Ratio = ${ratio.toFixed(2)}x`;
      if (rule.condition === "above") {
        met = ratio > multiplier;
        detail += met
          ? ` - above ${multiplier}x avg ✓`
          : ` - below ${multiplier}x avg ✗`;
      }
      return {
        indicator: "Volume",
        value: ratio,
        condition: rule.condition,
        met,
        detail,
      };
    }

    // ─── New indicator rules (Phase S1) ───

    case "cci": {
      if (!highs || !lows) {
        return {
          indicator: "CCI",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "HLC data required",
        };
      }
      const period = params.period || 20;
      const cci = computeCCI(prices, highs, lows, period);
      if (cci === null) {
        return {
          indicator: "CCI",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "Insufficient data",
        };
      }
      const threshold = rule.value ?? 100;
      let met = false;
      let detail = `CCI(${period}) = ${cci}`;
      if (rule.condition === "above") {
        met = cci > threshold;
        detail += met ? ` - above ${threshold} ✓` : ` - below ${threshold} ✗`;
      } else if (rule.condition === "below") {
        met = cci < (rule.value ?? -100);
        detail += met
          ? ` - below ${rule.value ?? -100} ✓`
          : ` - above ${rule.value ?? -100} ✗`;
      }
      return {
        indicator: `CCI(${period})`,
        value: cci,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "mfi": {
      if (!highs || !lows || !volumes) {
        return {
          indicator: "MFI",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "HLC + volume data required",
        };
      }
      const period = params.period || 14;
      const mfi = computeMFI(prices, highs, lows, volumes, period);
      if (mfi === null) {
        return {
          indicator: "MFI",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "Insufficient data",
        };
      }
      const threshold = rule.value ?? 80;
      let met = false;
      let detail = `MFI(${period}) = ${mfi}`;
      if (rule.condition === "above") {
        met = mfi > threshold;
        detail += met ? ` - above ${threshold} ✓` : ` - below ${threshold} ✗`;
      } else if (rule.condition === "below") {
        met = mfi < (rule.value ?? 20);
        detail += met
          ? ` - below ${rule.value ?? 20} ✓`
          : ` - above ${rule.value ?? 20} ✗`;
      }
      return {
        indicator: `MFI(${period})`,
        value: mfi,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "williams_r": {
      if (!highs || !lows) {
        return {
          indicator: "Williams %R",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "HLC data required",
        };
      }
      const period = params.period || 14;
      const wr = computeWilliamsR(prices, highs, lows, period);
      if (wr === null) {
        return {
          indicator: "Williams %R",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "Insufficient data",
        };
      }
      let met = false;
      let detail = `Williams %R(${period}) = ${wr}`;
      if (rule.condition === "oversold") {
        met = wr < -80;
        detail += met ? ` - oversold ✓` : ` - not oversold ✗`;
      } else if (rule.condition === "overbought") {
        met = wr > -20;
        detail += met ? ` - overbought ✓` : ` - not overbought ✗`;
      }
      return {
        indicator: `Williams %R(${period})`,
        value: wr,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "roc": {
      const period = params.period || 12;
      const roc = computeROC(prices, period);
      if (roc === null) {
        return {
          indicator: "ROC",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "Insufficient data",
        };
      }
      const threshold = rule.value ?? 0;
      let met = false;
      let detail = `ROC(${period}) = ${roc}%`;
      if (rule.condition === "above") {
        met = roc > threshold;
        detail += met ? ` - above ${threshold}% ✓` : ` - below ${threshold}% ✗`;
      } else if (rule.condition === "below") {
        met = roc < threshold;
        detail += met ? ` - below ${threshold}% ✓` : ` - above ${threshold}% ✗`;
      }
      return {
        indicator: `ROC(${period})`,
        value: roc,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "psar": {
      if (!highs || !lows) {
        return {
          indicator: "PSAR",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "HLC data required",
        };
      }
      const psar = computePSAR(highs, lows);
      if (!psar) {
        return {
          indicator: "PSAR",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "Insufficient data",
        };
      }
      let met = false;
      let detail = `PSAR = ${psar.value.toFixed(2)}, trend = ${psar.trend}`;
      if (rule.condition === "bullish") {
        met = psar.trend === "bullish";
        detail += met ? ` ✓` : ` ✗`;
      } else if (rule.condition === "bearish") {
        met = psar.trend === "bearish";
        detail += met ? ` ✓` : ` ✗`;
      }
      return {
        indicator: "PSAR",
        value: psar.value,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "ichimoku": {
      if (!highs || !lows) {
        return {
          indicator: "Ichimoku",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "HLC data required",
        };
      }
      const ich = computeIchimoku(prices, highs, lows);
      if (!ich) {
        return {
          indicator: "Ichimoku",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "Need 52+ bars",
        };
      }
      let met = false;
      let detail = `Ichimoku: Tenkan=${ich.tenkan}, Kijun=${ich.kijun}, Cloud=${ich.priceVsCloud}`;
      if (rule.condition === "above_cloud") {
        met = ich.priceVsCloud === "above";
        detail += met ? ` ✓` : ` ✗`;
      } else if (rule.condition === "below_cloud") {
        met = ich.priceVsCloud === "below";
        detail += met ? ` ✓` : ` ✗`;
      } else if (rule.condition === "tk_cross_bullish") {
        met = ich.tenkan > ich.kijun;
        detail += met ? ` - Tenkan > Kijun ✓` : ` - Tenkan ≤ Kijun ✗`;
      }
      return {
        indicator: "Ichimoku",
        value: currentPrice,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "supertrend": {
      if (!highs || !lows) {
        return {
          indicator: "SuperTrend",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "HLC data required",
        };
      }
      const st = computeSupertrend(prices, highs, lows);
      if (!st) {
        return {
          indicator: "SuperTrend",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "Insufficient data",
        };
      }
      let met = false;
      let detail = `SuperTrend = ${st.value.toFixed(2)}, direction = ${st.direction}`;
      if (rule.condition === "bullish") {
        met = st.direction === "bullish";
        detail += met ? ` ✓` : ` ✗`;
      } else if (rule.condition === "bearish") {
        met = st.direction === "bearish";
        detail += met ? ` ✓` : ` ✗`;
      }
      return {
        indicator: "SuperTrend",
        value: st.value,
        condition: rule.condition,
        met,
        detail,
      };
    }

    case "nr": {
      if (!highs || !lows) {
        return {
          indicator: "NR",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "HLC data required",
        };
      }
      const nr = detectNarrowRange(highs, lows);
      if (!nr) {
        return {
          indicator: "NR",
          value: 0,
          condition: rule.condition,
          met: false,
          detail: "Need 7+ bars",
        };
      }
      let met = false;
      let detail = `Range = ${nr.currentRange}, NR4=${nr.nr4}, NR7=${nr.nr7}`;
      if (rule.condition === "nr4") {
        met = nr.nr4;
        detail += met ? ` ✓` : ` ✗`;
      } else if (rule.condition === "nr7") {
        met = nr.nr7;
        detail += met ? ` ✓` : ` ✗`;
      }
      return {
        indicator: "NR",
        value: nr.currentRange,
        condition: rule.condition,
        met,
        detail,
      };
    }

    default: {
      return {
        indicator: rule.indicator,
        value: 0,
        condition: rule.condition,
        met: false,
        detail: `Unknown indicator: ${rule.indicator}`,
      };
    }
  }
}
