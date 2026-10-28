/**
 * Technical Indicator Calculator
 *
 * Computes technical indicators from DailyPrice OHLCV data.
 * All calculations are done in-memory - no external API needed.
 *
 * Used by the screener engine for technical filtering and
 * combined fundamental + technical screening.
 */

export interface OHLCV {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TechnicalIndicators {
  // Trend
  sma20?: number;
  sma50?: number;
  sma200?: number;
  ema12?: number;
  ema26?: number;

  // MACD
  macd?: number;
  macdSignal?: number;
  macdHistogram?: number;

  // Momentum
  rsi14?: number;
  stochK?: number;
  stochD?: number;
  williamsR?: number;
  cci?: number;
  adx?: number;

  // Volatility
  bollingerUpper?: number;
  bollingerMiddle?: number;
  bollingerLower?: number;
  bollingerBandwidth?: number;
  atr14?: number;

  // Volume
  obv?: number;
  volumeSma20?: number;
  volumeRatio?: number; // Current vol / 20d avg

  // Price context
  price52WeekHigh?: number;
  price52WeekLow?: number;
  distanceFrom52WeekHigh?: number; // % below 52w high
  distanceFrom52WeekLow?: number; // % above 52w low

  // Crossover signals
  goldenCross?: boolean; // SMA50 > SMA200 (bullish)
  deathCross?: boolean; // SMA50 < SMA200 (bearish)
  macdBullishCrossover?: boolean;
  macdBearishCrossover?: boolean;
  priceAboveSma200?: boolean;
}

// ── SMA ──────────────────────────────────────────────────────────────

export function sma(data: number[], period: number): number | undefined {
  if (data.length < period) return undefined;
  const slice = data.slice(-period);
  return slice.reduce((sum, v) => sum + v, 0) / period;
}

// ── EMA ──────────────────────────────────────────────────────────────

export function ema(data: number[], period: number): number | undefined {
  if (data.length < period) return undefined;
  const k = 2 / (period + 1);
  let result = data.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  for (let i = period; i < data.length; i++) {
    result = data[i]! * k + result * (1 - k);
  }
  return result;
}

function emaArray(data: number[], period: number): number[] {
  if (data.length < period) return [];
  const k = 2 / (period + 1);
  const result: number[] = [];
  let val = data.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  result.push(val);
  for (let i = period; i < data.length; i++) {
    val = data[i]! * k + val * (1 - k);
    result.push(val);
  }
  return result;
}

// ── RSI ──────────────────────────────────────────────────────────────

export function rsi(closes: number[], period = 14): number | undefined {
  if (closes.length < period + 1) return undefined;

  let gains = 0;
  let losses = 0;

  // Initial average gain/loss
  for (let i = 1; i <= period; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) gains += change;
    else losses -= change;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Smoothed RSI
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) - change) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ── MACD ─────────────────────────────────────────────────────────────

export function macd(closes: number[]) {
  const ema12Arr = emaArray(closes, 12);
  const ema26Arr = emaArray(closes, 26);

  if (ema12Arr.length === 0 || ema26Arr.length === 0) return undefined;

  // Align arrays (ema26 starts later)
  const offset = ema12Arr.length - ema26Arr.length;
  const macdLine: number[] = [];
  for (let i = 0; i < ema26Arr.length; i++) {
    macdLine.push(ema12Arr[i + offset]! - ema26Arr[i]!);
  }

  const signalArr = emaArray(macdLine, 9);
  if (signalArr.length === 0) return undefined;

  const macdVal = macdLine[macdLine.length - 1]!;
  const signalVal = signalArr[signalArr.length - 1]!;
  const histogram = macdVal - signalVal;

  // Check crossover (compare last 2 values)
  let bullishCrossover = false;
  let bearishCrossover = false;
  if (macdLine.length >= 2 && signalArr.length >= 2) {
    const prevMacd = macdLine[macdLine.length - 2]!;
    const prevSignal = signalArr[signalArr.length - 2]!;
    bullishCrossover = prevMacd <= prevSignal && macdVal > signalVal;
    bearishCrossover = prevMacd >= prevSignal && macdVal < signalVal;
  }

  return {
    macd: macdVal,
    signal: signalVal,
    histogram,
    bullishCrossover,
    bearishCrossover,
  };
}

// ── Bollinger Bands ──────────────────────────────────────────────────

export function bollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2,
) {
  if (closes.length < period) return undefined;

  const slice = closes.slice(-period);
  const middle = slice.reduce((sum, v) => sum + v, 0) / period;
  const variance =
    slice.reduce((sum, v) => sum + (v - middle) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = middle + stdDevMultiplier * stdDev;
  const lower = middle - stdDevMultiplier * stdDev;
  const bandwidth = middle > 0 ? ((upper - lower) / middle) * 100 : 0;

  return { upper, middle, lower, bandwidth };
}

// ── ATR (Average True Range) ─────────────────────────────────────────

export function atr(candles: OHLCV[], period = 14): number | undefined {
  if (candles.length < period + 1) return undefined;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i]!;
    const prevClose = candles[i - 1]!.close;
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - prevClose),
      Math.abs(current.low - prevClose),
    );
    trueRanges.push(tr);
  }

  // Simple average of last `period` true ranges
  const recentTRs = trueRanges.slice(-period);
  return recentTRs.reduce((sum, v) => sum + v, 0) / period;
}

// ── Stochastic Oscillator ────────────────────────────────────────────

export function stochastic(candles: OHLCV[], kPeriod = 14, dPeriod = 3) {
  if (candles.length < kPeriod) return undefined;

  const kValues: number[] = [];
  for (let i = kPeriod - 1; i < candles.length; i++) {
    const slice = candles.slice(i - kPeriod + 1, i + 1);
    const high = Math.max(...slice.map((c) => c.high));
    const low = Math.min(...slice.map((c) => c.low));
    const close = candles[i]!.close;
    const k = high === low ? 50 : ((close - low) / (high - low)) * 100;
    kValues.push(k);
  }

  const stochK = kValues[kValues.length - 1];
  const stochD =
    kValues.length >= dPeriod
      ? kValues.slice(-dPeriod).reduce((sum, v) => sum + v, 0) / dPeriod
      : undefined;

  return { stochK, stochD };
}

// ── Williams %R ──────────────────────────────────────────────────────

export function williamsR(candles: OHLCV[], period = 14): number | undefined {
  if (candles.length < period) return undefined;

  const slice = candles.slice(-period);
  const high = Math.max(...slice.map((c) => c.high));
  const low = Math.min(...slice.map((c) => c.low));
  const close = candles[candles.length - 1]!.close;

  if (high === low) return -50;
  return ((high - close) / (high - low)) * -100;
}

// ── OBV (On-Balance Volume) ──────────────────────────────────────────

export function obv(candles: OHLCV[]): number {
  let result = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i]!.close > candles[i - 1]!.close) {
      result += candles[i]!.volume;
    } else if (candles[i]!.close < candles[i - 1]!.close) {
      result -= candles[i]!.volume;
    }
  }
  return result;
}

// ── Compute All ──────────────────────────────────────────────────────

/**
 * Compute all technical indicators for a stock from its OHLCV data.
 * Expects data sorted oldest-first.
 */
export function computeIndicators(candles: OHLCV[]): TechnicalIndicators {
  if (candles.length < 2) return {};

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const sma50Val = sma(closes, 50);
  const sma200Val = sma(closes, 200);
  const currentPrice = closes[closes.length - 1]!;

  // 52-week high/low (252 trading days)
  const yearCandles = candles.slice(-252);
  const high52w = Math.max(...yearCandles.map((c) => c.high));
  const low52w = Math.min(...yearCandles.map((c) => c.low));

  const macdResult = macd(closes);
  const bb = bollingerBands(closes);
  const stochResult = stochastic(candles);

  const volumeSma20 = sma(volumes, 20);
  const currentVolume = volumes[volumes.length - 1]!;

  return {
    sma20: sma(closes, 20),
    sma50: sma50Val,
    sma200: sma200Val,
    ema12: ema(closes, 12),
    ema26: ema(closes, 26),

    macd: macdResult?.macd,
    macdSignal: macdResult?.signal,
    macdHistogram: macdResult?.histogram,

    rsi14: rsi(closes, 14),
    stochK: stochResult?.stochK,
    stochD: stochResult?.stochD,
    williamsR: williamsR(candles),
    atr14: atr(candles, 14),

    bollingerUpper: bb?.upper,
    bollingerMiddle: bb?.middle,
    bollingerLower: bb?.lower,
    bollingerBandwidth: bb?.bandwidth,

    obv: obv(candles),
    volumeSma20: volumeSma20,
    volumeRatio:
      volumeSma20 && volumeSma20 > 0 ? currentVolume / volumeSma20 : undefined,

    price52WeekHigh: high52w,
    price52WeekLow: low52w,
    distanceFrom52WeekHigh:
      high52w > 0 ? ((high52w - currentPrice) / high52w) * 100 : undefined,
    distanceFrom52WeekLow:
      low52w > 0 ? ((currentPrice - low52w) / low52w) * 100 : undefined,

    goldenCross:
      sma50Val !== undefined && sma200Val !== undefined
        ? sma50Val > sma200Val
        : undefined,
    deathCross:
      sma50Val !== undefined && sma200Val !== undefined
        ? sma50Val < sma200Val
        : undefined,
    macdBullishCrossover: macdResult?.bullishCrossover,
    macdBearishCrossover: macdResult?.bearishCrossover,
    priceAboveSma200:
      sma200Val !== undefined ? currentPrice > sma200Val : undefined,
  };
}
