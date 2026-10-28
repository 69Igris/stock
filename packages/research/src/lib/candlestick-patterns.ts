/**
 * Candlestick Pattern Detection Library
 *
 * Detects 25 classic candlestick patterns from OHLCV data:
 * - 9 single-candle (1-bar) patterns
 * - 8 two-candle (2-bar) patterns
 * - 8 three-candle (3-bar) patterns
 *
 * Used by: detect-candlestick-patterns tool, chart-patterns tool
 */

// ─── Types ──────────────────────────────────────────────────

export interface CandlestickPattern {
  pattern: string;
  type: "bullish" | "bearish" | "neutral";
  confidence: number; // 0-100
  barIndex: number; // index of the pattern's last candle
  barsUsed: number; // how many candles form the pattern (1, 2, or 3)
  description: string;
}

// ─── Helpers ────────────────────────────────────────────────

function bodySize(open: number, close: number): number {
  return Math.abs(close - open);
}

function upperShadow(high: number, open: number, close: number): number {
  return high - Math.max(open, close);
}

function lowerShadow(low: number, open: number, close: number): number {
  return Math.min(open, close) - low;
}

function range(high: number, low: number): number {
  return high - low;
}

function isBullish(open: number, close: number): boolean {
  return close > open;
}

function isBearish(open: number, close: number): boolean {
  return close < open;
}

/** Check if two price levels are approximately equal (within tolerance) */
function nearEqual(a: number, b: number, tolerancePct = 0.005): boolean {
  const ref = Math.max(Math.abs(a), Math.abs(b), 0.01);
  return Math.abs(a - b) / ref <= tolerancePct;
}

/**
 * Determine recent trend direction from closes.
 * Returns positive for uptrend, negative for downtrend, 0 for sideways.
 * Looks at the N bars before the given index.
 */
function trendDirection(
  closes: number[],
  endIndex: number,
  lookbackBars = 5,
): number {
  const start = Math.max(0, endIndex - lookbackBars);
  if (start >= endIndex) return 0;
  const change = closes[endIndex]! - closes[start]!;
  const ref = closes[start]!;
  if (ref === 0) return 0;
  const pctChange = change / ref;
  if (pctChange > 0.02) return 1; // uptrend
  if (pctChange < -0.02) return -1; // downtrend
  return 0;
}

// ─── Single-Candle Detectors ────────────────────────────────

function detectHammer(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
  trend: number,
): CandlestickPattern | null {
  const body = bodySize(o, c);
  const r = range(h, l);
  const lower = lowerShadow(l, o, c);
  const upper = upperShadow(h, o, c);

  if (r === 0) return null;

  // Hammer: small body near top, long lower shadow >= 2x body, small upper shadow
  const bodyRatio = body / r;
  if (bodyRatio > 0.35) return null; // body must be small relative to range
  if (lower < body * 2) return null; // lower shadow must be >= 2x body
  if (upper > body * 0.5) return null; // minimal upper shadow

  // Better confidence if at bottom of downtrend
  let confidence = 55 + (lower / r) * 25;
  if (trend < 0) confidence += 15; // stronger signal after downtrend

  return {
    pattern: "Hammer",
    type: "bullish",
    confidence: Math.min(Math.round(confidence), 95),
    barIndex: i,
    barsUsed: 1,
    description:
      "Small body at top with long lower shadow, signaling potential bullish reversal",
  };
}

function detectInvertedHammer(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
  trend: number,
): CandlestickPattern | null {
  const body = bodySize(o, c);
  const r = range(h, l);
  const lower = lowerShadow(l, o, c);
  const upper = upperShadow(h, o, c);

  if (r === 0) return null;

  const bodyRatio = body / r;
  if (bodyRatio > 0.35) return null;
  if (upper < body * 2) return null;
  if (lower > body * 0.5) return null;

  let confidence = 50 + (upper / r) * 25;
  if (trend < 0) confidence += 15;

  return {
    pattern: "Inverted Hammer",
    type: "bullish",
    confidence: Math.min(Math.round(confidence), 90),
    barIndex: i,
    barsUsed: 1,
    description:
      "Small body at bottom with long upper shadow after downtrend, potential reversal",
  };
}

function detectShootingStar(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
  trend: number,
): CandlestickPattern | null {
  const body = bodySize(o, c);
  const r = range(h, l);
  const lower = lowerShadow(l, o, c);
  const upper = upperShadow(h, o, c);

  if (r === 0) return null;

  const bodyRatio = body / r;
  if (bodyRatio > 0.35) return null;
  if (upper < body * 2) return null;
  if (lower > body * 0.5) return null;

  // Shooting star requires uptrend context
  if (trend <= 0) return null;

  let confidence = 55 + (upper / r) * 25;
  if (trend > 0) confidence += 10;

  return {
    pattern: "Shooting Star",
    type: "bearish",
    confidence: Math.min(Math.round(confidence), 95),
    barIndex: i,
    barsUsed: 1,
    description:
      "Small body at bottom of range with long upper shadow after uptrend, bearish reversal signal",
  };
}

function detectDoji(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
): CandlestickPattern | null {
  const body = bodySize(o, c);
  const r = range(h, l);

  if (r === 0) return null;

  // Doji: body < 10% of range
  if (body / r >= 0.1) return null;

  const upper = upperShadow(h, o, c);
  const lower = lowerShadow(l, o, c);

  // Check for specialized doji types
  const hasUpperShadow = upper > r * 0.1;
  const hasLowerShadow = lower > r * 0.1;

  // Dragonfly Doji: long lower shadow, no meaningful upper shadow
  if (hasLowerShadow && !hasUpperShadow && lower > r * 0.6) {
    return {
      pattern: "Dragonfly Doji",
      type: "bullish",
      confidence: Math.min(Math.round(60 + (lower / r) * 25), 90),
      barIndex: i,
      barsUsed: 1,
      description:
        "Doji with long lower shadow and no upper shadow, bullish reversal signal",
    };
  }

  // Gravestone Doji: long upper shadow, no meaningful lower shadow
  if (hasUpperShadow && !hasLowerShadow && upper > r * 0.6) {
    return {
      pattern: "Gravestone Doji",
      type: "bearish",
      confidence: Math.min(Math.round(60 + (upper / r) * 25), 90),
      barIndex: i,
      barsUsed: 1,
      description:
        "Doji with long upper shadow and no lower shadow, bearish reversal signal",
    };
  }

  // Standard Doji
  return {
    pattern: "Doji",
    type: "neutral",
    confidence: Math.min(Math.round(50 + (1 - body / r) * 30), 85),
    barIndex: i,
    barsUsed: 1,
    description: "Open and close nearly equal, indicating market indecision",
  };
}

function detectSpinningTop(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
): CandlestickPattern | null {
  const body = bodySize(o, c);
  const r = range(h, l);
  const upper = upperShadow(h, o, c);
  const lower = lowerShadow(l, o, c);

  if (r === 0) return null;

  // Spinning Top: small body, both shadows longer than body
  const bodyRatio = body / r;
  if (bodyRatio < 0.1 || bodyRatio > 0.35) return null; // not doji, not large body
  if (upper <= body) return null;
  if (lower <= body) return null;

  return {
    pattern: "Spinning Top",
    type: "neutral",
    confidence: Math.round(45 + (1 - bodyRatio) * 30),
    barIndex: i,
    barsUsed: 1,
    description:
      "Small body with shadows longer than the body on both sides, market indecision",
  };
}

function detectBullishMarubozu(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
): CandlestickPattern | null {
  if (!isBullish(o, c)) return null;

  const body = bodySize(o, c);
  const r = range(h, l);
  const upper = upperShadow(h, o, c);
  const lower = lowerShadow(l, o, c);

  if (r === 0) return null;

  // Marubozu: body >= 90% of range (no/tiny shadows)
  if (body / r < 0.9) return null;
  // Shadows each must be <= 5% of range
  if (upper / r > 0.05 || lower / r > 0.05) return null;

  return {
    pattern: "Bullish Marubozu",
    type: "bullish",
    confidence: Math.min(Math.round(70 + (body / r) * 25), 95),
    barIndex: i,
    barsUsed: 1,
    description:
      "Strong bullish candle with no shadows, indicating strong buying pressure",
  };
}

function detectBearishMarubozu(
  i: number,
  o: number,
  h: number,
  l: number,
  c: number,
): CandlestickPattern | null {
  if (!isBearish(o, c)) return null;

  const body = bodySize(o, c);
  const r = range(h, l);
  const upper = upperShadow(h, o, c);
  const lower = lowerShadow(l, o, c);

  if (r === 0) return null;

  if (body / r < 0.9) return null;
  if (upper / r > 0.05 || lower / r > 0.05) return null;

  return {
    pattern: "Bearish Marubozu",
    type: "bearish",
    confidence: Math.min(Math.round(70 + (body / r) * 25), 95),
    barIndex: i,
    barsUsed: 1,
    description:
      "Strong bearish candle with no shadows, indicating strong selling pressure",
  };
}

// ─── Two-Candle Detectors ───────────────────────────────────

function detectBullishEngulfing(
  i: number,
  o1: number,
  _h1: number,
  _l1: number,
  c1: number,
  o2: number,
  _h2: number,
  _l2: number,
  c2: number,
  trend: number,
): CandlestickPattern | null {
  // First candle red, second candle green
  if (!isBearish(o1, c1) || !isBullish(o2, c2)) return null;

  // Second body fully engulfs first body
  const body1Top = Math.max(o1, c1);
  const body1Bottom = Math.min(o1, c1);
  const body2Top = Math.max(o2, c2);
  const body2Bottom = Math.min(o2, c2);

  if (body2Top <= body1Top || body2Bottom >= body1Bottom) return null;

  // Second body should be meaningfully larger
  const body1 = bodySize(o1, c1);
  const body2 = bodySize(o2, c2);
  if (body2 < body1 * 1.1) return null;

  let confidence = 60 + Math.min((body2 / body1) * 10, 25);
  if (trend < 0) confidence += 10; // stronger after downtrend

  return {
    pattern: "Bullish Engulfing",
    type: "bullish",
    confidence: Math.min(Math.round(confidence), 95),
    barIndex: i,
    barsUsed: 2,
    description:
      "Green candle fully engulfs previous red candle, strong bullish reversal signal",
  };
}

function detectBearishEngulfing(
  i: number,
  o1: number,
  _h1: number,
  _l1: number,
  c1: number,
  o2: number,
  _h2: number,
  _l2: number,
  c2: number,
  trend: number,
): CandlestickPattern | null {
  // First candle green, second candle red
  if (!isBullish(o1, c1) || !isBearish(o2, c2)) return null;

  const body1Top = Math.max(o1, c1);
  const body1Bottom = Math.min(o1, c1);
  const body2Top = Math.max(o2, c2);
  const body2Bottom = Math.min(o2, c2);

  if (body2Top <= body1Top || body2Bottom >= body1Bottom) return null;

  const body1 = bodySize(o1, c1);
  const body2 = bodySize(o2, c2);
  if (body2 < body1 * 1.1) return null;

  let confidence = 60 + Math.min((body2 / body1) * 10, 25);
  if (trend > 0) confidence += 10;

  return {
    pattern: "Bearish Engulfing",
    type: "bearish",
    confidence: Math.min(Math.round(confidence), 95),
    barIndex: i,
    barsUsed: 2,
    description:
      "Red candle fully engulfs previous green candle, strong bearish reversal signal",
  };
}

function detectBullishHarami(
  i: number,
  o1: number,
  _h1: number,
  _l1: number,
  c1: number,
  o2: number,
  _h2: number,
  _l2: number,
  c2: number,
  trend: number,
): CandlestickPattern | null {
  // Large red candle followed by small green candle inside it
  if (!isBearish(o1, c1) || !isBullish(o2, c2)) return null;

  const body1Top = Math.max(o1, c1);
  const body1Bottom = Math.min(o1, c1);
  const body2Top = Math.max(o2, c2);
  const body2Bottom = Math.min(o2, c2);

  // Second body must be contained within first body
  if (body2Top >= body1Top || body2Bottom <= body1Bottom) return null;

  const body1 = bodySize(o1, c1);
  const body2 = bodySize(o2, c2);
  // First body should be meaningfully larger
  if (body1 < body2 * 1.5) return null;

  let confidence = 50 + Math.min((body1 / body2) * 5, 25);
  if (trend < 0) confidence += 10;

  return {
    pattern: "Bullish Harami",
    type: "bullish",
    confidence: Math.min(Math.round(confidence), 85),
    barIndex: i,
    barsUsed: 2,
    description:
      "Small green candle contained within previous large red candle, potential bullish reversal",
  };
}

function detectBearishHarami(
  i: number,
  o1: number,
  _h1: number,
  _l1: number,
  c1: number,
  o2: number,
  _h2: number,
  _l2: number,
  c2: number,
  trend: number,
): CandlestickPattern | null {
  // Large green candle followed by small red candle inside it
  if (!isBullish(o1, c1) || !isBearish(o2, c2)) return null;

  const body1Top = Math.max(o1, c1);
  const body1Bottom = Math.min(o1, c1);
  const body2Top = Math.max(o2, c2);
  const body2Bottom = Math.min(o2, c2);

  if (body2Top >= body1Top || body2Bottom <= body1Bottom) return null;

  const body1 = bodySize(o1, c1);
  const body2 = bodySize(o2, c2);
  if (body1 < body2 * 1.5) return null;

  let confidence = 50 + Math.min((body1 / body2) * 5, 25);
  if (trend > 0) confidence += 10;

  return {
    pattern: "Bearish Harami",
    type: "bearish",
    confidence: Math.min(Math.round(confidence), 85),
    barIndex: i,
    barsUsed: 2,
    description:
      "Small red candle contained within previous large green candle, potential bearish reversal",
  };
}

function detectPiercingLine(
  i: number,
  o1: number,
  _h1: number,
  l1: number,
  c1: number,
  o2: number,
  _h2: number,
  _l2: number,
  c2: number,
  trend: number,
): CandlestickPattern | null {
  // First candle red, second candle green
  if (!isBearish(o1, c1) || !isBullish(o2, c2)) return null;

  // Second opens below first low
  if (o2 >= l1) return null;

  // Second closes above midpoint of first body
  const midpoint = (o1 + c1) / 2;
  if (c2 <= midpoint) return null;

  // Second should not close above first open (otherwise it's engulfing)
  if (c2 >= o1) return null;

  const body1 = bodySize(o1, c1);
  const penetration = (c2 - c1) / body1; // how far into first body

  let confidence = 55 + penetration * 20;
  if (trend < 0) confidence += 10;

  return {
    pattern: "Piercing Line",
    type: "bullish",
    confidence: Math.min(Math.round(confidence), 90),
    barIndex: i,
    barsUsed: 2,
    description:
      "Green candle opens below prior low and closes above midpoint of prior red body, bullish reversal",
  };
}

function detectDarkCloudCover(
  i: number,
  o1: number,
  h1: number,
  _l1: number,
  c1: number,
  o2: number,
  _h2: number,
  _l2: number,
  c2: number,
  trend: number,
): CandlestickPattern | null {
  // First candle green, second candle red
  if (!isBullish(o1, c1) || !isBearish(o2, c2)) return null;

  // Second opens above first high
  if (o2 <= h1) return null;

  // Second closes below midpoint of first body
  const midpoint = (o1 + c1) / 2;
  if (c2 >= midpoint) return null;

  // Second should not close below first open (otherwise it's engulfing)
  if (c2 <= o1) return null;

  const body1 = bodySize(o1, c1);
  const penetration = (c1 - c2) / body1;

  let confidence = 55 + penetration * 20;
  if (trend > 0) confidence += 10;

  return {
    pattern: "Dark Cloud Cover",
    type: "bearish",
    confidence: Math.min(Math.round(confidence), 90),
    barIndex: i,
    barsUsed: 2,
    description:
      "Red candle opens above prior high and closes below midpoint of prior green body, bearish reversal",
  };
}

function detectTweezerTop(
  i: number,
  _o1: number,
  h1: number,
  _l1: number,
  _c1: number,
  _o2: number,
  h2: number,
  _l2: number,
  _c2: number,
  trend: number,
): CandlestickPattern | null {
  // Two candles with nearly equal highs at top of uptrend
  if (trend <= 0) return null;
  if (!nearEqual(h1, h2)) return null;

  return {
    pattern: "Tweezer Top",
    type: "bearish",
    confidence: 60 + (trend > 0 ? 10 : 0),
    barIndex: i,
    barsUsed: 2,
    description:
      "Two candles with nearly equal highs at top of uptrend, bearish reversal signal",
  };
}

function detectTweezerBottom(
  i: number,
  _o1: number,
  _h1: number,
  l1: number,
  _c1: number,
  _o2: number,
  _h2: number,
  l2: number,
  _c2: number,
  trend: number,
): CandlestickPattern | null {
  // Two candles with nearly equal lows at bottom of downtrend
  if (trend >= 0) return null;
  if (!nearEqual(l1, l2)) return null;

  return {
    pattern: "Tweezer Bottom",
    type: "bullish",
    confidence: 60 + (trend < 0 ? 10 : 0),
    barIndex: i,
    barsUsed: 2,
    description:
      "Two candles with nearly equal lows at bottom of downtrend, bullish reversal signal",
  };
}

// ─── Three-Candle Detectors ─────────────────────────────────

function detectMorningStar(
  i: number,
  o1: number,
  _h1: number,
  _l1: number,
  c1: number,
  o2: number,
  h2: number,
  l2: number,
  c2: number,
  o3: number,
  _h3: number,
  _l3: number,
  c3: number,
  trend: number,
): CandlestickPattern | null {
  // Red candle, small body (gap down), green candle closing >50% into first
  if (!isBearish(o1, c1)) return null;
  if (!isBullish(o3, c3)) return null;

  const body1 = bodySize(o1, c1);
  const body2 = bodySize(o2, c2);
  const range2 = range(h2, l2);

  // Second candle must have small body
  if (body1 === 0) return null;
  if (body2 > body1 * 0.5) return null;

  // Gap down between first and second (second's high < first's close, or body is lower)
  const body2Mid = (o2 + c2) / 2;
  if (body2Mid >= c1) return null;

  // Third candle must close above midpoint of first body
  const midpoint1 = (o1 + c1) / 2;
  if (c3 < midpoint1) return null;

  let confidence = 65;
  if (range2 > 0 && body2 / range2 < 0.3) confidence += 10; // smaller second body = stronger
  if (c3 > o1) confidence += 5; // closes above first open = very strong
  if (trend < 0) confidence += 10;

  return {
    pattern: "Morning Star",
    type: "bullish",
    confidence: Math.min(Math.round(confidence), 95),
    barIndex: i,
    barsUsed: 3,
    description:
      "Red candle, small-bodied candle gap down, green candle closing into first body - strong bullish reversal",
  };
}

function detectEveningStar(
  i: number,
  o1: number,
  _h1: number,
  _l1: number,
  c1: number,
  o2: number,
  h2: number,
  l2: number,
  c2: number,
  o3: number,
  _h3: number,
  _l3: number,
  c3: number,
  trend: number,
): CandlestickPattern | null {
  // Green candle, small body (gap up), red candle closing >50% into first
  if (!isBullish(o1, c1)) return null;
  if (!isBearish(o3, c3)) return null;

  const body1 = bodySize(o1, c1);
  const body2 = bodySize(o2, c2);
  const range2 = range(h2, l2);

  if (body1 === 0) return null;
  if (body2 > body1 * 0.5) return null;

  // Gap up between first and second
  const body2Mid = (o2 + c2) / 2;
  if (body2Mid <= c1) return null;

  // Third candle must close below midpoint of first body
  const midpoint1 = (o1 + c1) / 2;
  if (c3 > midpoint1) return null;

  let confidence = 65;
  if (range2 > 0 && body2 / range2 < 0.3) confidence += 10;
  if (c3 < o1) confidence += 5;
  if (trend > 0) confidence += 10;

  return {
    pattern: "Evening Star",
    type: "bearish",
    confidence: Math.min(Math.round(confidence), 95),
    barIndex: i,
    barsUsed: 3,
    description:
      "Green candle, small-bodied candle gap up, red candle closing into first body - strong bearish reversal",
  };
}

function detectThreeWhiteSoldiers(
  i: number,
  o1: number,
  h1: number,
  _l1: number,
  c1: number,
  o2: number,
  h2: number,
  _l2: number,
  c2: number,
  o3: number,
  h3: number,
  _l3: number,
  c3: number,
): CandlestickPattern | null {
  // Three consecutive green candles
  if (!isBullish(o1, c1) || !isBullish(o2, c2) || !isBullish(o3, c3))
    return null;

  // Each opens within previous body
  if (o2 < o1 || o2 > c1) return null;
  if (o3 < o2 || o3 > c2) return null;

  // Each closes near its high (upper shadow < 30% of body)
  const body1 = bodySize(o1, c1);
  const body2 = bodySize(o2, c2);
  const body3 = bodySize(o3, c3);

  if (body1 === 0 || body2 === 0 || body3 === 0) return null;

  const upper1 = upperShadow(h1, o1, c1);
  const upper2 = upperShadow(h2, o2, c2);
  const upper3 = upperShadow(h3, o3, c3);

  if (upper1 > body1 * 0.3) return null;
  if (upper2 > body2 * 0.3) return null;
  if (upper3 > body3 * 0.3) return null;

  // Progressive higher closes
  if (c2 <= c1 || c3 <= c2) return null;

  const avgBody = (body1 + body2 + body3) / 3;
  const minBody = Math.min(body1, body2, body3);
  // Bodies should be reasonably similar in size
  const uniformity = minBody / avgBody;

  return {
    pattern: "Three White Soldiers",
    type: "bullish",
    confidence: Math.min(Math.round(70 + uniformity * 20), 95),
    barIndex: i,
    barsUsed: 3,
    description:
      "Three consecutive green candles opening within prior body, closing near highs - strong bullish continuation",
  };
}

function detectThreeBlackCrows(
  i: number,
  o1: number,
  _h1: number,
  l1: number,
  c1: number,
  o2: number,
  _h2: number,
  l2: number,
  c2: number,
  o3: number,
  _h3: number,
  l3: number,
  c3: number,
): CandlestickPattern | null {
  // Three consecutive red candles
  if (!isBearish(o1, c1) || !isBearish(o2, c2) || !isBearish(o3, c3))
    return null;

  // Each opens within previous body
  if (o2 > o1 || o2 < c1) return null;
  if (o3 > o2 || o3 < c2) return null;

  // Each closes near its low (lower shadow < 30% of body)
  const body1 = bodySize(o1, c1);
  const body2 = bodySize(o2, c2);
  const body3 = bodySize(o3, c3);

  if (body1 === 0 || body2 === 0 || body3 === 0) return null;

  const lower1 = lowerShadow(l1, o1, c1);
  const lower2 = lowerShadow(l2, o2, c2);
  const lower3 = lowerShadow(l3, o3, c3);

  if (lower1 > body1 * 0.3) return null;
  if (lower2 > body2 * 0.3) return null;
  if (lower3 > body3 * 0.3) return null;

  // Progressive lower closes
  if (c2 >= c1 || c3 >= c2) return null;

  const avgBody = (body1 + body2 + body3) / 3;
  const minBody = Math.min(body1, body2, body3);
  const uniformity = minBody / avgBody;

  return {
    pattern: "Three Black Crows",
    type: "bearish",
    confidence: Math.min(Math.round(70 + uniformity * 20), 95),
    barIndex: i,
    barsUsed: 3,
    description:
      "Three consecutive red candles opening within prior body, closing near lows - strong bearish continuation",
  };
}

function detectThreeInsideUp(
  i: number,
  o1: number,
  _h1: number,
  _l1: number,
  c1: number,
  o2: number,
  _h2: number,
  _l2: number,
  c2: number,
  _o3: number,
  _h3: number,
  _l3: number,
  c3: number,
  trend: number,
): CandlestickPattern | null {
  // First candle: bearish
  if (!isBearish(o1, c1)) return null;
  // Second candle: bullish harami (inside first body)
  if (!isBullish(o2, c2)) return null;

  const body1Top = Math.max(o1, c1);
  const body1Bottom = Math.min(o1, c1);
  const body2Top = Math.max(o2, c2);
  const body2Bottom = Math.min(o2, c2);

  if (body2Top >= body1Top || body2Bottom <= body1Bottom) return null;

  // Third candle: confirms by closing above first candle's open (high of body)
  if (c3 <= body1Top) return null;

  let confidence = 70;
  if (trend < 0) confidence += 10;

  return {
    pattern: "Three Inside Up",
    type: "bullish",
    confidence: Math.min(Math.round(confidence), 90),
    barIndex: i,
    barsUsed: 3,
    description:
      "Bearish candle, bullish harami inside it, then confirmation close above - bullish reversal",
  };
}

function detectThreeInsideDown(
  i: number,
  o1: number,
  _h1: number,
  _l1: number,
  c1: number,
  o2: number,
  _h2: number,
  _l2: number,
  c2: number,
  _o3: number,
  _h3: number,
  _l3: number,
  c3: number,
  trend: number,
): CandlestickPattern | null {
  // First candle: bullish
  if (!isBullish(o1, c1)) return null;
  // Second candle: bearish harami (inside first body)
  if (!isBearish(o2, c2)) return null;

  const body1Top = Math.max(o1, c1);
  const body1Bottom = Math.min(o1, c1);
  const body2Top = Math.max(o2, c2);
  const body2Bottom = Math.min(o2, c2);

  if (body2Top >= body1Top || body2Bottom <= body1Bottom) return null;

  // Third candle: confirms by closing below first candle's open (low of body)
  if (c3 >= body1Bottom) return null;

  let confidence = 70;
  if (trend > 0) confidence += 10;

  return {
    pattern: "Three Inside Down",
    type: "bearish",
    confidence: Math.min(Math.round(confidence), 90),
    barIndex: i,
    barsUsed: 3,
    description:
      "Bullish candle, bearish harami inside it, then confirmation close below - bearish reversal",
  };
}

function detectAbandonedBabyBull(
  i: number,
  o1: number,
  _h1: number,
  l1: number,
  c1: number,
  o2: number,
  h2: number,
  l2: number,
  c2: number,
  o3: number,
  h3: number,
  _l3: number,
  c3: number,
): CandlestickPattern | null {
  // Red candle, doji gap down, green candle gap up
  if (!isBearish(o1, c1)) return null;
  if (!isBullish(o3, c3)) return null;

  // Second candle is doji
  const body2 = bodySize(o2, c2);
  const range2 = range(h2, l2);
  if (range2 === 0 || body2 / range2 >= 0.1) return null;

  // Gap down: second high < first low
  if (h2 >= l1) return null;

  // Gap up: third low > second high
  const low3 = Math.min(o3, c3);
  if (low3 <= h2 && o3 <= h2) return null;

  return {
    pattern: "Abandoned Baby (Bullish)",
    type: "bullish",
    confidence: 85,
    barIndex: i,
    barsUsed: 3,
    description:
      "Red candle, doji gapping down, green candle gapping up - rare and strong bullish reversal",
  };
}

function detectAbandonedBabyBear(
  i: number,
  o1: number,
  _h1: number,
  _l1: number,
  c1: number,
  o2: number,
  h2: number,
  l2: number,
  c2: number,
  o3: number,
  _h3: number,
  l3: number,
  c3: number,
): CandlestickPattern | null {
  // Green candle, doji gap up, red candle gap down
  if (!isBullish(o1, c1)) return null;
  if (!isBearish(o3, c3)) return null;

  // Second candle is doji
  const body2 = bodySize(o2, c2);
  const range2 = range(h2, l2);
  if (range2 === 0 || body2 / range2 >= 0.1) return null;

  // Gap up: second low > first high
  const high1 = Math.max(o1, c1);
  if (l2 <= high1 && l2 <= c1) return null;

  // Gap down: third high < second low
  const high3 = Math.max(o3, c3);
  if (high3 >= l2 && o3 >= l2) return null;

  return {
    pattern: "Abandoned Baby (Bearish)",
    type: "bearish",
    confidence: 85,
    barIndex: i,
    barsUsed: 3,
    description:
      "Green candle, doji gapping up, red candle gapping down - rare and strong bearish reversal",
  };
}

// ─── Main Detection Function ────────────────────────────────

/**
 * Detect candlestick patterns in the last N bars of OHLCV data.
 *
 * @param opens  Array of opening prices (chronological, oldest first)
 * @param highs  Array of high prices
 * @param lows   Array of low prices
 * @param closes Array of closing prices
 * @param lookback How many recent bars to scan (default 10)
 * @returns Array of detected patterns sorted by barIndex descending, confidence descending
 */
export function detectCandlestickPatterns(
  opens: number[],
  highs: number[],
  lows: number[],
  closes: number[],
  lookback = 10,
): CandlestickPattern[] {
  const len = opens.length;
  if (len < 1) return [];

  // Validate arrays have equal length
  if (highs.length !== len || lows.length !== len || closes.length !== len) {
    return [];
  }

  const patterns: CandlestickPattern[] = [];
  const startIdx = Math.max(0, len - lookback);

  // ─── Single-Candle Patterns ─────────────────────────────
  for (let i = startIdx; i < len; i++) {
    const o = opens[i]!;
    const h = highs[i]!;
    const l = lows[i]!;
    const c = closes[i]!;
    const trend = trendDirection(closes, i);

    // Doji family (check first since they're exclusive with others)
    const doji = detectDoji(i, o, h, l, c);
    if (doji) {
      patterns.push(doji);
    } else {
      // Spinning Top (not doji, not large body)
      const spinningTop = detectSpinningTop(i, o, h, l, c);
      if (spinningTop) patterns.push(spinningTop);
    }

    // Hammer & Inverted Hammer (bullish context)
    const hammer = detectHammer(i, o, h, l, c, trend);
    if (hammer) patterns.push(hammer);

    const invertedHammer = detectInvertedHammer(i, o, h, l, c, trend);
    if (invertedHammer) patterns.push(invertedHammer);

    // Shooting Star (bearish, needs uptrend)
    const shootingStar = detectShootingStar(i, o, h, l, c, trend);
    if (shootingStar) patterns.push(shootingStar);

    // Marubozu
    const bullMarubozu = detectBullishMarubozu(i, o, h, l, c);
    if (bullMarubozu) patterns.push(bullMarubozu);

    const bearMarubozu = detectBearishMarubozu(i, o, h, l, c);
    if (bearMarubozu) patterns.push(bearMarubozu);
  }

  // ─── Two-Candle Patterns ──────────────────────────────────
  const twoStart = Math.max(1, startIdx);
  for (let i = twoStart; i < len; i++) {
    const o1 = opens[i - 1]!;
    const h1 = highs[i - 1]!;
    const l1 = lows[i - 1]!;
    const c1 = closes[i - 1]!;
    const o2 = opens[i]!;
    const h2 = highs[i]!;
    const l2 = lows[i]!;
    const c2 = closes[i]!;
    const trend = trendDirection(closes, i - 1);

    const bullEngulf = detectBullishEngulfing(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      trend,
    );
    if (bullEngulf) patterns.push(bullEngulf);

    const bearEngulf = detectBearishEngulfing(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      trend,
    );
    if (bearEngulf) patterns.push(bearEngulf);

    const bullHarami = detectBullishHarami(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      trend,
    );
    if (bullHarami) patterns.push(bullHarami);

    const bearHarami = detectBearishHarami(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      trend,
    );
    if (bearHarami) patterns.push(bearHarami);

    const piercing = detectPiercingLine(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      trend,
    );
    if (piercing) patterns.push(piercing);

    const darkCloud = detectDarkCloudCover(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      trend,
    );
    if (darkCloud) patterns.push(darkCloud);

    const tweezerTop = detectTweezerTop(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      trend,
    );
    if (tweezerTop) patterns.push(tweezerTop);

    const tweezerBottom = detectTweezerBottom(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      trend,
    );
    if (tweezerBottom) patterns.push(tweezerBottom);
  }

  // ─── Three-Candle Patterns ────────────────────────────────
  const threeStart = Math.max(2, startIdx);
  for (let i = threeStart; i < len; i++) {
    const o1 = opens[i - 2]!;
    const h1 = highs[i - 2]!;
    const l1 = lows[i - 2]!;
    const c1 = closes[i - 2]!;
    const o2 = opens[i - 1]!;
    const h2 = highs[i - 1]!;
    const l2 = lows[i - 1]!;
    const c2 = closes[i - 1]!;
    const o3 = opens[i]!;
    const h3 = highs[i]!;
    const l3 = lows[i]!;
    const c3 = closes[i]!;
    const trend = trendDirection(closes, i - 2);

    const morning = detectMorningStar(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      o3,
      h3,
      l3,
      c3,
      trend,
    );
    if (morning) patterns.push(morning);

    const evening = detectEveningStar(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      o3,
      h3,
      l3,
      c3,
      trend,
    );
    if (evening) patterns.push(evening);

    const soldiers = detectThreeWhiteSoldiers(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      o3,
      h3,
      l3,
      c3,
    );
    if (soldiers) patterns.push(soldiers);

    const crows = detectThreeBlackCrows(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      o3,
      h3,
      l3,
      c3,
    );
    if (crows) patterns.push(crows);

    const insideUp = detectThreeInsideUp(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      o3,
      h3,
      l3,
      c3,
      trend,
    );
    if (insideUp) patterns.push(insideUp);

    const insideDown = detectThreeInsideDown(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      o3,
      h3,
      l3,
      c3,
      trend,
    );
    if (insideDown) patterns.push(insideDown);

    const abandonedBull = detectAbandonedBabyBull(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      o3,
      h3,
      l3,
      c3,
    );
    if (abandonedBull) patterns.push(abandonedBull);

    const abandonedBear = detectAbandonedBabyBear(
      i,
      o1,
      h1,
      l1,
      c1,
      o2,
      h2,
      l2,
      c2,
      o3,
      h3,
      l3,
      c3,
    );
    if (abandonedBear) patterns.push(abandonedBear);
  }

  // Sort: most recent bar first, then by confidence descending
  patterns.sort((a, b) => {
    if (b.barIndex !== a.barIndex) return b.barIndex - a.barIndex;
    return b.confidence - a.confidence;
  });

  return patterns;
}
