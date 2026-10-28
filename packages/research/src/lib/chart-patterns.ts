/**
 * Chart Pattern Detection Library
 *
 * Detects classic chart patterns from OHLCV data using peak/trough
 * detection and geometric matching.
 *
 * Supported patterns:
 * - Head & Shoulders / Inverse Head & Shoulders
 * - Double Top / Double Bottom
 * - Ascending / Descending / Symmetrical Triangle
 * - Bull / Bear Flag
 * - Rising / Falling Wedge
 * - Cup & Handle
 * - Rounding Bottom
 * - Channel Up / Channel Down
 */

// ─── Types ──────────────────────────────────────────────────

export interface ChartPattern {
  pattern: string;
  type: "bullish" | "bearish" | "neutral";
  confidence: number; // 0-100
  startIndex: number;
  endIndex: number;
  breakoutTarget?: number;
  support?: number;
  resistance?: number;
  description: string;
}

interface PeakTrough {
  index: number;
  value: number;
  kind: "peak" | "trough";
}

// ─── Utility Helpers ────────────────────────────────────────

/** Round to 2 decimal places */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Check whether two values are within a percentage tolerance of each other */
function withinTolerance(a: number, b: number, tolerancePct: number): boolean {
  if (a === 0 && b === 0) return true;
  const avg = (Math.abs(a) + Math.abs(b)) / 2;
  if (avg === 0) return true;
  return (Math.abs(a - b) / avg) * 100 <= tolerancePct;
}

/** Simple linear regression returning { slope, intercept, r2 } */
function linearRegression(
  xs: number[],
  ys: number[],
): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, intercept: ys[0] ?? 0, r2: 0 };

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += xs[i]!;
    sumY += ys[i]!;
    sumXY += xs[i]! * ys[i]!;
    sumX2 += xs[i]! * xs[i]!;
    sumY2 += ys[i]! * ys[i]!;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return { slope: 0, intercept: sumY / n, r2: 0 };

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // Coefficient of determination
  const ssRes = ys.reduce((s, y, i) => {
    const predicted = slope * xs[i]! + intercept;
    return s + (y - predicted) ** 2;
  }, 0);
  const meanY = sumY / n;
  const ssTot = ys.reduce((s, y) => s + (y - meanY) ** 2, 0);
  const r2Val = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { slope, intercept, r2: r2Val };
}

/** Compute average volume ratio over a range (used for volume confirmation) */
function volumeConfidence(
  volumes: number[] | undefined,
  startIdx: number,
  endIdx: number,
): number {
  if (!volumes || volumes.length === 0) return 0;
  const rangeVols = volumes.slice(startIdx, endIdx + 1);
  if (rangeVols.length === 0) return 0;
  const avgRange = rangeVols.reduce((s, v) => s + v, 0) / rangeVols.length;

  // Compare with volume before the pattern
  const lookback = Math.min(20, startIdx);
  if (lookback === 0) return 0;
  const priorVols = volumes.slice(startIdx - lookback, startIdx);
  if (priorVols.length === 0) return 0;
  const avgPrior = priorVols.reduce((s, v) => s + v, 0) / priorVols.length;

  if (avgPrior === 0) return 0;
  const ratio = avgRange / avgPrior;
  // Higher volume during pattern formation is confirmatory
  return Math.min(Math.round(ratio * 10), 15); // max +15 confidence boost
}

// ─── Peak / Trough Detection ───────────────────────────────

/**
 * Find local maxima and minima using a window approach.
 * A peak at index i means prices[i] >= all prices in [i-sensitivity, i+sensitivity].
 * A trough at index i means prices[i] <= all prices in [i-sensitivity, i+sensitivity].
 */
export function findPeaksAndTroughs(
  prices: number[],
  sensitivity: number = 5,
): PeakTrough[] {
  const results: PeakTrough[] = [];
  if (prices.length < sensitivity * 2 + 1) return results;

  for (let i = sensitivity; i < prices.length - sensitivity; i++) {
    let isPeak = true;
    let isTrough = true;

    for (let j = i - sensitivity; j <= i + sensitivity; j++) {
      if (j === i) continue;
      if (prices[j]! >= prices[i]!) isPeak = false;
      if (prices[j]! <= prices[i]!) isTrough = false;
      if (!isPeak && !isTrough) break;
    }

    if (isPeak) {
      results.push({ index: i, value: prices[i]!, kind: "peak" });
    } else if (isTrough) {
      results.push({ index: i, value: prices[i]!, kind: "trough" });
    }
  }

  return results;
}

// ─── Individual Pattern Detectors ──────────────────────────

/**
 * Head & Shoulders - 3 peaks where the middle (head) is the highest.
 * Neckline connects the two troughs between the peaks.
 */
function detectHeadAndShoulders(
  prices: number[],
  peaks: PeakTrough[],
  troughs: PeakTrough[],
  volumes?: number[],
): ChartPattern[] {
  const patterns: ChartPattern[] = [];
  const tolerance = 3; // percentage

  for (let i = 0; i < peaks.length - 2; i++) {
    const leftShoulder = peaks[i]!;
    const head = peaks[i + 1]!;
    const rightShoulder = peaks[i + 2]!;

    // Head must be higher than both shoulders
    if (head.value <= leftShoulder.value || head.value <= rightShoulder.value) {
      continue;
    }

    // Shoulders should be at roughly similar levels
    if (
      !withinTolerance(leftShoulder.value, rightShoulder.value, tolerance * 2)
    ) {
      continue;
    }

    // Find troughs between left-shoulder/head and head/right-shoulder
    const trough1 = troughs.find(
      (t) => t.index > leftShoulder.index && t.index < head.index,
    );
    const trough2 = troughs.find(
      (t) => t.index > head.index && t.index < rightShoulder.index,
    );

    if (!trough1 || !trough2) continue;

    // Neckline from trough values
    const neckline = (trough1.value + trough2.value) / 2;

    // Pattern height for breakout target
    const patternHeight = head.value - neckline;

    // Confidence scoring
    let confidence = 55;
    // Shoulder symmetry (closer = better)
    const shoulderRatio =
      (Math.abs(leftShoulder.value - rightShoulder.value) /
        ((leftShoulder.value + rightShoulder.value) / 2)) *
      100;
    confidence += Math.max(0, 15 - shoulderRatio * 3);
    // Neckline flatness
    const necklineSlope =
      (Math.abs(trough1.value - trough2.value) /
        ((trough1.value + trough2.value) / 2)) *
      100;
    confidence += Math.max(0, 10 - necklineSlope * 2);
    // Volume confirmation
    confidence += volumeConfidence(
      volumes,
      leftShoulder.index,
      rightShoulder.index,
    );

    confidence = Math.min(95, Math.max(30, Math.round(confidence)));

    patterns.push({
      pattern: "Head & Shoulders",
      type: "bearish",
      confidence,
      startIndex: leftShoulder.index,
      endIndex: rightShoulder.index,
      breakoutTarget: r2(neckline - patternHeight),
      support: r2(neckline),
      resistance: r2(head.value),
      description: `Head & Shoulders with neckline at ${r2(neckline)}, target ${r2(neckline - patternHeight)}`,
    });
  }

  return patterns;
}

/**
 * Inverse Head & Shoulders - 3 troughs where the middle is the lowest.
 */
function detectInverseHeadAndShoulders(
  prices: number[],
  peaks: PeakTrough[],
  troughs: PeakTrough[],
  volumes?: number[],
): ChartPattern[] {
  const patterns: ChartPattern[] = [];
  const tolerance = 3;

  for (let i = 0; i < troughs.length - 2; i++) {
    const leftShoulder = troughs[i]!;
    const head = troughs[i + 1]!;
    const rightShoulder = troughs[i + 2]!;

    // Head must be lower than both shoulders
    if (head.value >= leftShoulder.value || head.value >= rightShoulder.value) {
      continue;
    }

    // Shoulders at similar levels
    if (
      !withinTolerance(leftShoulder.value, rightShoulder.value, tolerance * 2)
    ) {
      continue;
    }

    // Find peaks between the troughs
    const peak1 = peaks.find(
      (p) => p.index > leftShoulder.index && p.index < head.index,
    );
    const peak2 = peaks.find(
      (p) => p.index > head.index && p.index < rightShoulder.index,
    );

    if (!peak1 || !peak2) continue;

    const neckline = (peak1.value + peak2.value) / 2;
    const patternHeight = neckline - head.value;

    let confidence = 55;
    const shoulderRatio =
      (Math.abs(leftShoulder.value - rightShoulder.value) /
        ((leftShoulder.value + rightShoulder.value) / 2)) *
      100;
    confidence += Math.max(0, 15 - shoulderRatio * 3);
    const necklineSlope =
      (Math.abs(peak1.value - peak2.value) /
        ((peak1.value + peak2.value) / 2)) *
      100;
    confidence += Math.max(0, 10 - necklineSlope * 2);
    confidence += volumeConfidence(
      volumes,
      leftShoulder.index,
      rightShoulder.index,
    );

    confidence = Math.min(95, Math.max(30, Math.round(confidence)));

    patterns.push({
      pattern: "Inverse Head & Shoulders",
      type: "bullish",
      confidence,
      startIndex: leftShoulder.index,
      endIndex: rightShoulder.index,
      breakoutTarget: r2(neckline + patternHeight),
      support: r2(head.value),
      resistance: r2(neckline),
      description: `Inverse H&S with neckline at ${r2(neckline)}, target ${r2(neckline + patternHeight)}`,
    });
  }

  return patterns;
}

/**
 * Double Top - 2 peaks at similar level with a trough between them.
 */
function detectDoubleTop(
  prices: number[],
  peaks: PeakTrough[],
  troughs: PeakTrough[],
  volumes?: number[],
): ChartPattern[] {
  const patterns: ChartPattern[] = [];
  const tolerance = 2.5;

  for (let i = 0; i < peaks.length - 1; i++) {
    const peak1 = peaks[i]!;
    const peak2 = peaks[i + 1]!;

    // Peaks must be at similar levels
    if (!withinTolerance(peak1.value, peak2.value, tolerance)) continue;

    // Minimum spacing between peaks (at least 10 bars)
    if (peak2.index - peak1.index < 10) continue;

    // Find the trough between peaks
    const troughBetween = troughs.find(
      (t) => t.index > peak1.index && t.index < peak2.index,
    );
    if (!troughBetween) continue;

    // The trough should be meaningfully lower than the peaks
    const peakAvg = (peak1.value + peak2.value) / 2;
    const pullbackPct = ((peakAvg - troughBetween.value) / peakAvg) * 100;
    if (pullbackPct < 2) continue; // Too shallow

    const patternHeight = peakAvg - troughBetween.value;

    let confidence = 55;
    // Peak similarity (closer = better)
    const peakDiffPct = (Math.abs(peak1.value - peak2.value) / peakAvg) * 100;
    confidence += Math.max(0, 15 - peakDiffPct * 5);
    // Deeper pullback is more significant
    confidence += Math.min(10, pullbackPct);
    // Volume on second peak should ideally be lower
    if (
      volumes &&
      volumes[peak2.index] !== undefined &&
      volumes[peak1.index] !== undefined
    ) {
      if (volumes[peak2.index]! < volumes[peak1.index]!) {
        confidence += 5;
      }
    }
    confidence += volumeConfidence(volumes, peak1.index, peak2.index);

    confidence = Math.min(95, Math.max(30, Math.round(confidence)));

    patterns.push({
      pattern: "Double Top",
      type: "bearish",
      confidence,
      startIndex: peak1.index,
      endIndex: peak2.index,
      breakoutTarget: r2(troughBetween.value - patternHeight),
      support: r2(troughBetween.value),
      resistance: r2(peakAvg),
      description: `Double Top at ${r2(peakAvg)} with support at ${r2(troughBetween.value)}, target ${r2(troughBetween.value - patternHeight)}`,
    });
  }

  return patterns;
}

/**
 * Double Bottom - 2 troughs at similar level with a peak between them.
 */
function detectDoubleBottom(
  prices: number[],
  peaks: PeakTrough[],
  troughs: PeakTrough[],
  volumes?: number[],
): ChartPattern[] {
  const patterns: ChartPattern[] = [];
  const tolerance = 2.5;

  for (let i = 0; i < troughs.length - 1; i++) {
    const trough1 = troughs[i]!;
    const trough2 = troughs[i + 1]!;

    if (!withinTolerance(trough1.value, trough2.value, tolerance)) continue;
    if (trough2.index - trough1.index < 10) continue;

    const peakBetween = peaks.find(
      (p) => p.index > trough1.index && p.index < trough2.index,
    );
    if (!peakBetween) continue;

    const troughAvg = (trough1.value + trough2.value) / 2;
    const pullbackPct = ((peakBetween.value - troughAvg) / troughAvg) * 100;
    if (pullbackPct < 2) continue;

    const patternHeight = peakBetween.value - troughAvg;

    let confidence = 55;
    const troughDiffPct =
      (Math.abs(trough1.value - trough2.value) / troughAvg) * 100;
    confidence += Math.max(0, 15 - troughDiffPct * 5);
    confidence += Math.min(10, pullbackPct);
    if (
      volumes &&
      volumes[trough2.index] !== undefined &&
      volumes[trough1.index] !== undefined
    ) {
      if (volumes[trough2.index]! > volumes[trough1.index]!) {
        confidence += 5; // Rising volume on second bottom is bullish
      }
    }
    confidence += volumeConfidence(volumes, trough1.index, trough2.index);

    confidence = Math.min(95, Math.max(30, Math.round(confidence)));

    patterns.push({
      pattern: "Double Bottom",
      type: "bullish",
      confidence,
      startIndex: trough1.index,
      endIndex: trough2.index,
      breakoutTarget: r2(peakBetween.value + patternHeight),
      support: r2(troughAvg),
      resistance: r2(peakBetween.value),
      description: `Double Bottom at ${r2(troughAvg)} with resistance at ${r2(peakBetween.value)}, target ${r2(peakBetween.value + patternHeight)}`,
    });
  }

  return patterns;
}

/**
 * Ascending Triangle - Flat resistance + rising support (higher lows).
 * Requires at least 2 peaks at similar level and 2+ troughs with ascending values.
 */
function detectAscendingTriangle(
  prices: number[],
  peaks: PeakTrough[],
  troughs: PeakTrough[],
  volumes?: number[],
): ChartPattern[] {
  const patterns: ChartPattern[] = [];
  const tolerance = 2;

  // Need at least 2 peaks and 2 troughs
  if (peaks.length < 2 || troughs.length < 2) return patterns;

  // Scan consecutive peaks for flat resistance
  for (let i = 0; i < peaks.length - 1; i++) {
    const p1 = peaks[i]!;
    const p2 = peaks[i + 1]!;

    // Flat resistance: peaks at similar levels
    if (!withinTolerance(p1.value, p2.value, tolerance)) continue;

    const resistance = (p1.value + p2.value) / 2;

    // Find troughs between (and around) these peaks
    const relevantTroughs = troughs.filter(
      (t) => t.index >= p1.index - 5 && t.index <= p2.index + 5,
    );
    if (relevantTroughs.length < 2) continue;

    // Check for ascending troughs (higher lows)
    let ascending = true;
    for (let j = 1; j < relevantTroughs.length; j++) {
      if (relevantTroughs[j]!.value <= relevantTroughs[j - 1]!.value) {
        ascending = false;
        break;
      }
    }
    if (!ascending) continue;

    const startIdx = Math.min(p1.index, relevantTroughs[0]!.index);
    const endIdx = Math.max(
      p2.index,
      relevantTroughs[relevantTroughs.length - 1]!.index,
    );
    const lowestTrough = relevantTroughs[0]!.value;
    const patternHeight = resistance - lowestTrough;

    let confidence = 50;
    // More touches on resistance = stronger
    confidence += Math.min(
      15,
      (peaks.filter(
        (p) =>
          p.index >= startIdx &&
          p.index <= endIdx &&
          withinTolerance(p.value, resistance, tolerance),
      ).length -
        1) *
        5,
    );
    // More ascending troughs = stronger
    confidence += Math.min(10, (relevantTroughs.length - 1) * 5);
    confidence += volumeConfidence(volumes, startIdx, endIdx);

    confidence = Math.min(95, Math.max(30, Math.round(confidence)));

    patterns.push({
      pattern: "Ascending Triangle",
      type: "bullish",
      confidence,
      startIndex: startIdx,
      endIndex: endIdx,
      breakoutTarget: r2(resistance + patternHeight),
      support: r2(relevantTroughs[relevantTroughs.length - 1]!.value),
      resistance: r2(resistance),
      description: `Ascending Triangle with flat resistance at ${r2(resistance)} and rising support, target ${r2(resistance + patternHeight)}`,
    });
  }

  return patterns;
}

/**
 * Descending Triangle - Flat support + falling resistance (lower highs).
 */
function detectDescendingTriangle(
  prices: number[],
  peaks: PeakTrough[],
  troughs: PeakTrough[],
  volumes?: number[],
): ChartPattern[] {
  const patterns: ChartPattern[] = [];
  const tolerance = 2;

  if (peaks.length < 2 || troughs.length < 2) return patterns;

  for (let i = 0; i < troughs.length - 1; i++) {
    const t1 = troughs[i]!;
    const t2 = troughs[i + 1]!;

    // Flat support
    if (!withinTolerance(t1.value, t2.value, tolerance)) continue;

    const support = (t1.value + t2.value) / 2;

    // Find peaks between these troughs
    const relevantPeaks = peaks.filter(
      (p) => p.index >= t1.index - 5 && p.index <= t2.index + 5,
    );
    if (relevantPeaks.length < 2) continue;

    // Check for descending peaks (lower highs)
    let descending = true;
    for (let j = 1; j < relevantPeaks.length; j++) {
      if (relevantPeaks[j]!.value >= relevantPeaks[j - 1]!.value) {
        descending = false;
        break;
      }
    }
    if (!descending) continue;

    const startIdx = Math.min(t1.index, relevantPeaks[0]!.index);
    const endIdx = Math.max(
      t2.index,
      relevantPeaks[relevantPeaks.length - 1]!.index,
    );
    const highestPeak = relevantPeaks[0]!.value;
    const patternHeight = highestPeak - support;

    let confidence = 50;
    confidence += Math.min(
      15,
      (troughs.filter(
        (t) =>
          t.index >= startIdx &&
          t.index <= endIdx &&
          withinTolerance(t.value, support, tolerance),
      ).length -
        1) *
        5,
    );
    confidence += Math.min(10, (relevantPeaks.length - 1) * 5);
    confidence += volumeConfidence(volumes, startIdx, endIdx);

    confidence = Math.min(95, Math.max(30, Math.round(confidence)));

    patterns.push({
      pattern: "Descending Triangle",
      type: "bearish",
      confidence,
      startIndex: startIdx,
      endIndex: endIdx,
      breakoutTarget: r2(support - patternHeight),
      support: r2(support),
      resistance: r2(relevantPeaks[relevantPeaks.length - 1]!.value),
      description: `Descending Triangle with flat support at ${r2(support)} and falling resistance, target ${r2(support - patternHeight)}`,
    });
  }

  return patterns;
}

/**
 * Symmetrical Triangle - Converging trendlines (lower highs + higher lows).
 */
function detectSymmetricalTriangle(
  prices: number[],
  peaks: PeakTrough[],
  troughs: PeakTrough[],
  volumes?: number[],
): ChartPattern[] {
  const patterns: ChartPattern[] = [];

  if (peaks.length < 2 || troughs.length < 2) return patterns;

  // Look for consecutive lower highs AND higher lows
  for (let pi = 0; pi < peaks.length - 1; pi++) {
    const p1 = peaks[pi]!;
    const p2 = peaks[pi + 1]!;

    // Lower highs
    if (p2.value >= p1.value) continue;

    // Find troughs in the same time range
    const relevantTroughs = troughs.filter(
      (t) => t.index >= p1.index - 5 && t.index <= p2.index + 5,
    );
    if (relevantTroughs.length < 2) continue;

    // Higher lows
    let higherLows = true;
    for (let j = 1; j < relevantTroughs.length; j++) {
      if (relevantTroughs[j]!.value <= relevantTroughs[j - 1]!.value) {
        higherLows = false;
        break;
      }
    }
    if (!higherLows) continue;

    const startIdx = Math.min(p1.index, relevantTroughs[0]!.index);
    const endIdx = Math.max(
      p2.index,
      relevantTroughs[relevantTroughs.length - 1]!.index,
    );

    const highAtStart = p1.value;
    const lowAtStart = relevantTroughs[0]!.value;
    const midpoint = (highAtStart + lowAtStart) / 2;

    let confidence = 50;
    // More points in the converging pattern
    confidence += Math.min(
      10,
      (peaks.filter((p) => p.index >= startIdx && p.index <= endIdx).length -
        1) *
        3,
    );
    confidence += Math.min(10, (relevantTroughs.length - 1) * 3);
    confidence += volumeConfidence(volumes, startIdx, endIdx);

    confidence = Math.min(95, Math.max(30, Math.round(confidence)));

    patterns.push({
      pattern: "Symmetrical Triangle",
      type: "neutral",
      confidence,
      startIndex: startIdx,
      endIndex: endIdx,
      breakoutTarget: r2(midpoint + (highAtStart - lowAtStart)),
      support: r2(relevantTroughs[relevantTroughs.length - 1]!.value),
      resistance: r2(p2.value),
      description: `Symmetrical Triangle with converging trendlines, potential breakout in either direction`,
    });
  }

  return patterns;
}

/**
 * Flag Pattern - Sharp move (pole) followed by small consolidation channel.
 * Bull Flag: sharp up-move followed by a slight downward-sloping channel.
 * Bear Flag: sharp down-move followed by a slight upward-sloping channel.
 */
function detectFlag(
  prices: number[],
  highs: number[],
  lows: number[],
  volumes?: number[],
): ChartPattern[] {
  const patterns: ChartPattern[] = [];
  const minPoleLength = 5;
  const maxFlagLength = 20;
  const minFlagLength = 5;

  for (let i = minPoleLength; i < prices.length - minFlagLength; i++) {
    // Check for a sharp move (pole) ending at index i
    const poleReturn =
      (prices[i]! - prices[i - minPoleLength]!) / prices[i - minPoleLength]!;
    const absPoleReturn = Math.abs(poleReturn);

    // Pole must be at least 5% move
    if (absPoleReturn < 0.05) continue;

    const isBullPole = poleReturn > 0;

    // Look for consolidation channel after the pole
    const flagEnd = Math.min(i + maxFlagLength, prices.length - 1);
    const flagLength = flagEnd - i;
    if (flagLength < minFlagLength) continue;

    // Fit regression line to the flag portion
    const flagPrices = prices.slice(i, flagEnd + 1);
    const flagXs = flagPrices.map((_, idx) => idx);
    const reg = linearRegression(flagXs, flagPrices);

    // Flag should slope gently in the opposite direction of the pole (or be flat)
    const flagSlopeNorm = (reg.slope * flagLength) / prices[i]!;

    // For bull flag: flag should slope slightly down or be flat
    // For bear flag: flag should slope slightly up or be flat
    const slopeValid = isBullPole
      ? flagSlopeNorm < 0.01 && flagSlopeNorm > -0.05
      : flagSlopeNorm > -0.01 && flagSlopeNorm < 0.05;

    if (!slopeValid) continue;

    // Flag should be a tight channel (low variance around regression line)
    const maxDeviation = flagPrices.reduce((max, p, idx) => {
      const predicted = reg.slope * idx + reg.intercept;
      return Math.max(max, Math.abs(p - predicted));
    }, 0);
    const deviationPct = (maxDeviation / prices[i]!) * 100;
    if (deviationPct > 3) continue; // Flag too wide

    const poleHeight = Math.abs(prices[i]! - prices[i - minPoleLength]!);
    const flagType = isBullPole ? "Bull Flag" : "Bear Flag";
    const breakoutTarget = isBullPole
      ? prices[flagEnd]! + poleHeight
      : prices[flagEnd]! - poleHeight;

    let confidence = 55;
    // Tighter channel = higher confidence
    confidence += Math.max(0, Math.round(10 - deviationPct * 3));
    // Good R2 on regression = cleaner channel
    confidence += Math.round(reg.r2 * 10);
    // Stronger pole = more significant
    confidence += Math.min(10, Math.round(absPoleReturn * 50));
    confidence += volumeConfidence(volumes, i - minPoleLength, flagEnd);

    confidence = Math.min(95, Math.max(30, Math.round(confidence)));

    patterns.push({
      pattern: flagType,
      type: isBullPole ? "bullish" : "bearish",
      confidence,
      startIndex: i - minPoleLength,
      endIndex: flagEnd,
      breakoutTarget: r2(breakoutTarget),
      support: r2(Math.min(...lows.slice(i, flagEnd + 1))),
      resistance: r2(Math.max(...highs.slice(i, flagEnd + 1))),
      description: `${flagType}: ${(absPoleReturn * 100).toFixed(1)}% pole followed by ${flagLength}-bar consolidation, target ${r2(breakoutTarget)}`,
    });

    // Skip ahead past the flag to avoid duplicates
    i = flagEnd;
  }

  return patterns;
}

/**
 * Wedge - Converging trendlines both sloping in the same direction.
 * Rising Wedge (bearish): both support and resistance slope upward, converging.
 * Falling Wedge (bullish): both support and resistance slope downward, converging.
 */
function detectWedge(
  prices: number[],
  peaks: PeakTrough[],
  troughs: PeakTrough[],
  volumes?: number[],
): ChartPattern[] {
  const patterns: ChartPattern[] = [];

  if (peaks.length < 2 || troughs.length < 2) return patterns;

  // Need peaks and troughs in the same region
  const startIdx = Math.min(
    peaks[0]?.index ?? prices.length,
    troughs[0]?.index ?? prices.length,
  );
  const endIdx = Math.max(
    peaks[peaks.length - 1]?.index ?? 0,
    troughs[troughs.length - 1]?.index ?? 0,
  );

  if (endIdx - startIdx < 15) return patterns;

  // Fit regression lines to peaks and troughs
  if (peaks.length >= 2) {
    const peakXs = peaks.map((p) => p.index);
    const peakYs = peaks.map((p) => p.value);
    const peakReg = linearRegression(peakXs, peakYs);

    const troughXs = troughs.map((t) => t.index);
    const troughYs = troughs.map((t) => t.value);
    const troughReg = linearRegression(troughXs, troughYs);

    // Both lines must slope in the same direction
    const bothUp = peakReg.slope > 0 && troughReg.slope > 0;
    const bothDown = peakReg.slope < 0 && troughReg.slope < 0;

    if (!bothUp && !bothDown) return patterns;

    // Lines must be converging (not parallel or diverging)
    // For convergence: the line with smaller absolute slope is the constraining line
    const slopeDiff = Math.abs(peakReg.slope) - Math.abs(troughReg.slope);
    // In a rising wedge, support slope > resistance slope (converging upward)
    // In a falling wedge, resistance slope < support slope (converging downward)
    const converging = bothUp
      ? troughReg.slope > peakReg.slope * 0.3 &&
        peakReg.slope > troughReg.slope * 0.3
      : troughReg.slope < peakReg.slope * 0.3 &&
        peakReg.slope < troughReg.slope * 0.3;

    // Simpler convergence check: gap between lines is decreasing
    const gapStart =
      peakReg.slope * startIdx +
      peakReg.intercept -
      (troughReg.slope * startIdx + troughReg.intercept);
    const gapEnd =
      peakReg.slope * endIdx +
      peakReg.intercept -
      (troughReg.slope * endIdx + troughReg.intercept);

    if (gapEnd >= gapStart || gapStart <= 0) return patterns;

    const convergenceRatio = gapEnd / gapStart;
    if (convergenceRatio > 0.9) return patterns; // Not converging enough

    const wedgeType = bothUp ? "Rising Wedge" : "Falling Wedge";
    const signalType = bothUp ? "bearish" : "bullish";
    const lastPrice = prices[endIdx]!;
    const wedgeHeight = gapStart;
    const breakoutTarget = bothUp
      ? lastPrice - wedgeHeight * 0.6
      : lastPrice + wedgeHeight * 0.6;

    let confidence = 50;
    // Better regression fit = cleaner wedge
    confidence += Math.round((peakReg.r2 + troughReg.r2) * 10);
    // More points = more significant
    confidence += Math.min(10, (peaks.length + troughs.length - 3) * 2);
    // Stronger convergence = more significant
    confidence += Math.round((1 - convergenceRatio) * 15);
    confidence += volumeConfidence(volumes, startIdx, endIdx);

    confidence = Math.min(95, Math.max(30, Math.round(confidence)));

    patterns.push({
      pattern: wedgeType,
      type: signalType,
      confidence,
      startIndex: startIdx,
      endIndex: endIdx,
      breakoutTarget: r2(breakoutTarget),
      support: r2(troughReg.slope * endIdx + troughReg.intercept),
      resistance: r2(peakReg.slope * endIdx + peakReg.intercept),
      description: `${wedgeType} (${signalType}): converging trendlines, target ${r2(breakoutTarget)}`,
    });
  }

  return patterns;
}

/**
 * Cup & Handle - U-shaped bottom followed by small consolidation (the handle).
 * The cup is a gradual decline and recovery, the handle is a slight pullback.
 */
function detectCupAndHandle(
  prices: number[],
  peaks: PeakTrough[],
  troughs: PeakTrough[],
  volumes?: number[],
): ChartPattern[] {
  const patterns: ChartPattern[] = [];
  const tolerance = 3;

  if (peaks.length < 2 || troughs.length < 1) return patterns;

  // Look for two peaks at similar levels with a trough between (the cup)
  for (let i = 0; i < peaks.length - 1; i++) {
    const leftRim = peaks[i]!;
    const rightRim = peaks[i + 1]!;

    // Rims at similar levels
    if (!withinTolerance(leftRim.value, rightRim.value, tolerance)) continue;

    // Minimum cup width (at least 20 bars)
    if (rightRim.index - leftRim.index < 20) continue;

    // Find the deepest trough in the cup
    const cupTroughs = troughs.filter(
      (t) => t.index > leftRim.index && t.index < rightRim.index,
    );
    if (cupTroughs.length === 0) continue;

    const cupBottom = cupTroughs.reduce((deepest, t) =>
      t.value < deepest.value ? t : deepest,
    );

    // Cup depth should be meaningful (at least 5% from rim to bottom)
    const rimAvg = (leftRim.value + rightRim.value) / 2;
    const cupDepthPct = ((rimAvg - cupBottom.value) / rimAvg) * 100;
    if (cupDepthPct < 5 || cupDepthPct > 50) continue;

    // Check U-shape: bottom should be roughly in the middle of the cup
    const cupWidth = rightRim.index - leftRim.index;
    const bottomPosition = (cupBottom.index - leftRim.index) / cupWidth;
    if (bottomPosition < 0.25 || bottomPosition > 0.75) continue; // Not U-shaped

    // Check for handle: small pullback after the right rim
    const handleStart = rightRim.index;
    const handleEnd = Math.min(
      handleStart + Math.round(cupWidth * 0.3),
      prices.length - 1,
    );
    if (handleEnd <= handleStart + 3) continue;

    const handlePrices = prices.slice(handleStart, handleEnd + 1);
    const handleMin = Math.min(...handlePrices);
    const handlePullbackPct =
      ((rightRim.value - handleMin) / rightRim.value) * 100;

    // Handle pullback should be small (< 50% of cup depth) and not go below cup midpoint
    const cupMidpoint = (rimAvg + cupBottom.value) / 2;
    if (handlePullbackPct > cupDepthPct * 0.5 || handleMin < cupMidpoint)
      continue;

    const patternHeight = rimAvg - cupBottom.value;
    const breakoutTarget = rimAvg + patternHeight;

    let confidence = 55;
    // Symmetry of the cup (bottom position near center)
    confidence += Math.max(
      0,
      Math.round(15 - Math.abs(bottomPosition - 0.5) * 40),
    );
    // Handle proportionality
    if (handlePullbackPct > 0 && handlePullbackPct < cupDepthPct * 0.3) {
      confidence += 10;
    }
    // Rim similarity
    const rimDiffPct =
      (Math.abs(leftRim.value - rightRim.value) / rimAvg) * 100;
    confidence += Math.max(0, Math.round(10 - rimDiffPct * 3));
    confidence += volumeConfidence(volumes, leftRim.index, handleEnd);

    confidence = Math.min(95, Math.max(30, Math.round(confidence)));

    patterns.push({
      pattern: "Cup & Handle",
      type: "bullish",
      confidence,
      startIndex: leftRim.index,
      endIndex: handleEnd,
      breakoutTarget: r2(breakoutTarget),
      support: r2(cupBottom.value),
      resistance: r2(rimAvg),
      description: `Cup & Handle with ${cupDepthPct.toFixed(1)}% deep cup and handle pullback of ${handlePullbackPct.toFixed(1)}%, target ${r2(breakoutTarget)}`,
    });
  }

  return patterns;
}

/**
 * Rounding Bottom - Gradual U-shape over a longer period.
 * Uses regression on the lower envelope to detect the curve.
 */
function detectRoundingBottom(
  prices: number[],
  lows: number[],
  volumes?: number[],
): ChartPattern[] {
  const patterns: ChartPattern[] = [];
  const minLength = 30;

  if (prices.length < minLength) return patterns;

  // Scan windows of varying length
  const windowSizes = [30, 50, 80, 120].filter((w) => w <= prices.length);

  for (const windowSize of windowSizes) {
    const startIdx = prices.length - windowSize;
    const endIdx = prices.length - 1;
    const windowPrices = lows.slice(startIdx, endIdx + 1);

    // Find the minimum in the window
    let minVal = Infinity;
    let minPos = 0;
    for (let i = 0; i < windowPrices.length; i++) {
      if (windowPrices[i]! < minVal) {
        minVal = windowPrices[i]!;
        minPos = i;
      }
    }

    // Minimum should be roughly in the middle third
    const relativePos = minPos / windowPrices.length;
    if (relativePos < 0.2 || relativePos > 0.8) continue;

    // Left side should be declining, right side should be rising
    const leftPrices = windowPrices.slice(0, minPos + 1);
    const rightPrices = windowPrices.slice(minPos);

    if (leftPrices.length < 5 || rightPrices.length < 5) continue;

    const leftReg = linearRegression(
      leftPrices.map((_, i) => i),
      leftPrices,
    );
    const rightReg = linearRegression(
      rightPrices.map((_, i) => i),
      rightPrices,
    );

    // Left side should slope down, right side should slope up
    if (leftReg.slope >= 0 || rightReg.slope <= 0) continue;

    // Both sides should have reasonable fit
    if (leftReg.r2 < 0.3 || rightReg.r2 < 0.3) continue;

    const startPrice = prices[startIdx]!;
    const endPrice = prices[endIdx]!;
    const bottomPrice = minVal;
    const rimPrice = Math.max(startPrice, endPrice);
    const patternHeight = rimPrice - bottomPrice;

    // Recovery should be meaningful
    const recoveryPct = ((endPrice - bottomPrice) / bottomPrice) * 100;
    if (recoveryPct < 5) continue;

    let confidence = 45;
    confidence += Math.round(leftReg.r2 * 10);
    confidence += Math.round(rightReg.r2 * 10);
    // Symmetry bonus
    confidence += Math.max(
      0,
      Math.round(10 - Math.abs(relativePos - 0.5) * 30),
    );
    // Recovery extent
    confidence += Math.min(10, Math.round(recoveryPct / 3));
    confidence += volumeConfidence(volumes, startIdx, endIdx);

    confidence = Math.min(95, Math.max(30, Math.round(confidence)));

    patterns.push({
      pattern: "Rounding Bottom",
      type: "bullish",
      confidence,
      startIndex: startIdx,
      endIndex: endIdx,
      breakoutTarget: r2(rimPrice + patternHeight * 0.5),
      support: r2(bottomPrice),
      resistance: r2(rimPrice),
      description: `Rounding Bottom over ${windowSize} bars with ${recoveryPct.toFixed(1)}% recovery from low`,
    });
  }

  // Deduplicate: keep highest confidence if overlapping windows found the same pattern
  if (patterns.length > 1) {
    patterns.sort((a, b) => b.confidence - a.confidence);
    return [patterns[0]!];
  }

  return patterns;
}

/**
 * Channel - Parallel trendlines containing price.
 * Channel Up (bullish): both lines slope upward.
 * Channel Down (bearish): both lines slope downward.
 */
function detectChannel(
  prices: number[],
  highs: number[],
  lows: number[],
  peaks: PeakTrough[],
  troughs: PeakTrough[],
  volumes?: number[],
): ChartPattern[] {
  const patterns: ChartPattern[] = [];

  if (peaks.length < 2 || troughs.length < 2) return patterns;

  // Fit regression to peaks (upper trendline) and troughs (lower trendline)
  const peakXs = peaks.map((p) => p.index);
  const peakYs = peaks.map((p) => p.value);
  const peakReg = linearRegression(peakXs, peakYs);

  const troughXs = troughs.map((t) => t.index);
  const troughYs = troughs.map((t) => t.value);
  const troughReg = linearRegression(troughXs, troughYs);

  // Both regression lines must have decent fit
  if (peakReg.r2 < 0.4 || troughReg.r2 < 0.4) return patterns;

  // Lines must slope in the same direction (both up or both down)
  const bothUp = peakReg.slope > 0 && troughReg.slope > 0;
  const bothDown = peakReg.slope < 0 && troughReg.slope < 0;
  if (!bothUp && !bothDown) return patterns;

  // Lines should be roughly parallel (slopes within tolerance)
  const avgSlope = (Math.abs(peakReg.slope) + Math.abs(troughReg.slope)) / 2;
  if (avgSlope === 0) return patterns;
  const slopeDiff = Math.abs(
    Math.abs(peakReg.slope) - Math.abs(troughReg.slope),
  );
  const parallelRatio = slopeDiff / avgSlope;
  if (parallelRatio > 0.6) return patterns; // Not parallel enough

  const startIdx = Math.min(peaks[0]!.index, troughs[0]!.index);
  const endIdx = Math.max(
    peaks[peaks.length - 1]!.index,
    troughs[troughs.length - 1]!.index,
  );

  // Minimum channel length
  if (endIdx - startIdx < 15) return patterns;

  const channelType = bothUp ? "Channel Up" : "Channel Down";
  const signalType = bothUp ? "bullish" : "bearish";

  const upperAtEnd = peakReg.slope * endIdx + peakReg.intercept;
  const lowerAtEnd = troughReg.slope * endIdx + troughReg.intercept;
  const channelWidth = upperAtEnd - lowerAtEnd;

  let confidence = 45;
  // Better regression fit
  confidence += Math.round((peakReg.r2 + troughReg.r2) * 15);
  // More parallel lines
  confidence += Math.round((1 - parallelRatio) * 10);
  // More touch points
  confidence += Math.min(10, (peaks.length + troughs.length - 3) * 2);
  confidence += volumeConfidence(volumes, startIdx, endIdx);

  confidence = Math.min(95, Math.max(30, Math.round(confidence)));

  const breakoutTarget = bothUp
    ? upperAtEnd + channelWidth * 0.5
    : lowerAtEnd - channelWidth * 0.5;

  patterns.push({
    pattern: channelType,
    type: signalType,
    confidence,
    startIndex: startIdx,
    endIndex: endIdx,
    breakoutTarget: r2(breakoutTarget),
    support: r2(lowerAtEnd),
    resistance: r2(upperAtEnd),
    description: `${channelType} with ${endIdx - startIdx}-bar duration, channel width ${r2(channelWidth)}`,
  });

  return patterns;
}

// ─── Main Detection Function ────────────────────────────────

/**
 * Detect all chart patterns in price data.
 *
 * @param prices - Array of closing prices (oldest first)
 * @param highs  - Array of high prices (same length as prices)
 * @param lows   - Array of low prices (same length as prices)
 * @param volumes - Optional array of volumes (same length as prices)
 * @returns Array of detected chart patterns sorted by confidence (highest first)
 */
export function detectChartPatterns(
  prices: number[],
  highs: number[],
  lows: number[],
  volumes?: number[],
): ChartPattern[] {
  if (prices.length < 20) return [];
  if (highs.length !== prices.length || lows.length !== prices.length)
    return [];
  if (volumes && volumes.length !== prices.length) {
    // If volumes length doesn't match, ignore volumes
    volumes = undefined;
  }

  // Run peak/trough detection at multiple sensitivities for different pattern scales
  const ptSensitive = findPeaksAndTroughs(prices, 3); // Short-term
  const ptMedium = findPeaksAndTroughs(prices, 5); // Medium-term
  const ptBroad = findPeaksAndTroughs(prices, 8); // Longer-term

  const peaksSensitive = ptSensitive.filter((p) => p.kind === "peak");
  const troughsSensitive = ptSensitive.filter((p) => p.kind === "trough");
  const peaksMedium = ptMedium.filter((p) => p.kind === "peak");
  const troughsMedium = ptMedium.filter((p) => p.kind === "trough");
  const peaksBroad = ptBroad.filter((p) => p.kind === "peak");
  const troughsBroad = ptBroad.filter((p) => p.kind === "trough");

  const allPatterns: ChartPattern[] = [];

  // Head & Shoulders variants (use medium/broad peaks for cleaner signals)
  allPatterns.push(
    ...detectHeadAndShoulders(prices, peaksMedium, troughsMedium, volumes),
  );
  allPatterns.push(
    ...detectHeadAndShoulders(prices, peaksBroad, troughsBroad, volumes),
  );
  allPatterns.push(
    ...detectInverseHeadAndShoulders(
      prices,
      peaksMedium,
      troughsMedium,
      volumes,
    ),
  );
  allPatterns.push(
    ...detectInverseHeadAndShoulders(prices, peaksBroad, troughsBroad, volumes),
  );

  // Double Top/Bottom (use medium sensitivity)
  allPatterns.push(
    ...detectDoubleTop(prices, peaksMedium, troughsMedium, volumes),
  );
  allPatterns.push(
    ...detectDoubleTop(prices, peaksBroad, troughsBroad, volumes),
  );
  allPatterns.push(
    ...detectDoubleBottom(prices, peaksMedium, troughsMedium, volumes),
  );
  allPatterns.push(
    ...detectDoubleBottom(prices, peaksBroad, troughsBroad, volumes),
  );

  // Triangles (use sensitive/medium for more touch points)
  allPatterns.push(
    ...detectAscendingTriangle(
      prices,
      peaksSensitive,
      troughsSensitive,
      volumes,
    ),
  );
  allPatterns.push(
    ...detectAscendingTriangle(prices, peaksMedium, troughsMedium, volumes),
  );
  allPatterns.push(
    ...detectDescendingTriangle(
      prices,
      peaksSensitive,
      troughsSensitive,
      volumes,
    ),
  );
  allPatterns.push(
    ...detectDescendingTriangle(prices, peaksMedium, troughsMedium, volumes),
  );
  allPatterns.push(
    ...detectSymmetricalTriangle(
      prices,
      peaksSensitive,
      troughsSensitive,
      volumes,
    ),
  );
  allPatterns.push(
    ...detectSymmetricalTriangle(prices, peaksMedium, troughsMedium, volumes),
  );

  // Flags (operate directly on price data)
  allPatterns.push(...detectFlag(prices, highs, lows, volumes));

  // Wedges (use medium peaks/troughs)
  allPatterns.push(...detectWedge(prices, peaksMedium, troughsMedium, volumes));
  allPatterns.push(...detectWedge(prices, peaksBroad, troughsBroad, volumes));

  // Cup & Handle (use broader peaks/troughs for the larger pattern)
  allPatterns.push(
    ...detectCupAndHandle(prices, peaksMedium, troughsMedium, volumes),
  );
  allPatterns.push(
    ...detectCupAndHandle(prices, peaksBroad, troughsBroad, volumes),
  );

  // Rounding Bottom (operates on raw price/low data)
  allPatterns.push(...detectRoundingBottom(prices, lows, volumes));

  // Channel (use medium peaks/troughs)
  allPatterns.push(
    ...detectChannel(prices, highs, lows, peaksMedium, troughsMedium, volumes),
  );
  allPatterns.push(
    ...detectChannel(prices, highs, lows, peaksBroad, troughsBroad, volumes),
  );

  // Deduplicate overlapping patterns of the same type
  const deduplicated = deduplicatePatterns(allPatterns);

  // Sort by confidence descending
  deduplicated.sort((a, b) => b.confidence - a.confidence);

  return deduplicated;
}

/**
 * Remove duplicate patterns that overlap significantly.
 * When two patterns of the same type overlap by more than 50%, keep the one
 * with higher confidence.
 */
function deduplicatePatterns(patterns: ChartPattern[]): ChartPattern[] {
  if (patterns.length <= 1) return patterns;

  // Sort by confidence so we keep the best ones
  const sorted = [...patterns].sort((a, b) => b.confidence - a.confidence);
  const kept: ChartPattern[] = [];

  for (const candidate of sorted) {
    const isDuplicate = kept.some((existing) => {
      if (existing.pattern !== candidate.pattern) return false;

      // Calculate overlap
      const overlapStart = Math.max(existing.startIndex, candidate.startIndex);
      const overlapEnd = Math.min(existing.endIndex, candidate.endIndex);
      const overlapLength = Math.max(0, overlapEnd - overlapStart);

      const candidateLength = candidate.endIndex - candidate.startIndex;
      const existingLength = existing.endIndex - existing.startIndex;
      const minLength = Math.min(candidateLength, existingLength);

      return minLength > 0 && overlapLength / minLength > 0.5;
    });

    if (!isDuplicate) {
      kept.push(candidate);
    }
  }

  return kept;
}
