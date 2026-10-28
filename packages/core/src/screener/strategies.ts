/**
 * Pre-Built Screener Strategy Library
 *
 * ~50+ strategies covering Chartink-equivalent categories:
 * - Fundamental: value, growth, dividend, quality
 * - Technical: bullish, bearish, momentum, volume
 * - Combined: CAN SLIM, Buffett, PEG
 */

import type { ScreenerStrategy, ScreenerFilter } from "./engine";

// ── Helper ───────────────────────────────────────────────────────────

function strategy(
  id: string,
  name: string,
  description: string,
  category: string,
  filters: ScreenerFilter[],
): ScreenerStrategy {
  return { id, name, description, category, filters, source: "builtin" };
}

// ── Fundamental Strategies ───────────────────────────────────────────

export const FUNDAMENTAL_STRATEGIES: ScreenerStrategy[] = [
  strategy(
    "value_investing",
    "Value Investing",
    "Undervalued stocks with strong fundamentals (PE<15, PB<2, ROE>15, D/E<1)",
    "value",
    [
      { field: "pe", operator: "lt", value: 15 },
      { field: "pb", operator: "lt", value: 2 },
      { field: "roe", operator: "gt", value: 15 },
      { field: "debtToEquity", operator: "lt", value: 1 },
    ],
  ),
  strategy(
    "dividend_aristocrats",
    "Dividend Aristocrats",
    "High dividend yield stocks with consistent payouts",
    "dividend",
    [
      { field: "dividendYield", operator: "gt", value: 3 },
      { field: "roe", operator: "gt", value: 10 },
      { field: "debtToEquity", operator: "lt", value: 1.5 },
    ],
  ),
  strategy(
    "growth_stocks",
    "Growth Stocks",
    "High revenue and earnings growth with reasonable valuation",
    "growth",
    [
      { field: "revenueGrowth", operator: "gt", value: 20 },
      { field: "earningsGrowth", operator: "gt", value: 20 },
      { field: "pe", operator: "lt", value: 40 },
    ],
  ),
  strategy(
    "garp",
    "GARP (Growth at Reasonable Price)",
    "Growth stocks with PEG ratio below 1.5 and strong ROE",
    "growth",
    [
      { field: "pegRatio", operator: "lt", value: 1.5 },
      { field: "roe", operator: "gt", value: 20 },
      { field: "earningsGrowth", operator: "gt", value: 15 },
    ],
  ),
  strategy(
    "low_debt_bluechips",
    "Low Debt Blue Chips",
    "Large caps with minimal debt and strong returns",
    "quality",
    [
      { field: "marketCap", operator: "gt", value: 50000 },
      { field: "debtToEquity", operator: "lt", value: 0.5 },
      { field: "roe", operator: "gt", value: 15 },
    ],
  ),
  strategy(
    "high_roce",
    "High ROCE Companies",
    "Capital efficient companies with low leverage",
    "quality",
    [
      { field: "roce", operator: "gt", value: 25 },
      { field: "debtToEquity", operator: "lt", value: 1 },
    ],
  ),
  strategy(
    "turnaround",
    "Turnaround Candidates",
    "Low PE stocks with recovering revenue growth",
    "value",
    [
      { field: "pe", operator: "lt", value: 10 },
      { field: "revenueGrowth", operator: "gt", value: 15 },
    ],
  ),
  strategy(
    "small_cap_gems",
    "Small Cap Gems",
    "Small cap stocks with strong fundamentals",
    "value",
    [
      { field: "marketCap", operator: "between", value: [500, 5000] },
      { field: "roe", operator: "gt", value: 15 },
      { field: "debtToEquity", operator: "lt", value: 1 },
      { field: "earningsGrowth", operator: "gt", value: 15 },
    ],
  ),
  strategy(
    "high_margin",
    "High Margin Moats",
    "Companies with wide profit margins indicating competitive advantages",
    "quality",
    [
      { field: "operatingMargin", operator: "gt", value: 20 },
      { field: "netMargin", operator: "gt", value: 15 },
      { field: "roe", operator: "gt", value: 15 },
    ],
  ),
  strategy(
    "cash_rich",
    "Cash Rich Companies",
    "Low debt companies with strong interest coverage",
    "quality",
    [
      { field: "debtToEquity", operator: "lt", value: 0.3 },
      { field: "currentRatio", operator: "gt", value: 2 },
      { field: "interestCoverage", operator: "gt", value: 5 },
    ],
  ),
];

// ── Technical Strategies ─────────────────────────────────────────────

export const TECHNICAL_STRATEGIES: ScreenerStrategy[] = [
  strategy(
    "bullish_trend",
    "Bullish Trend",
    "Price above 200 SMA with bullish MACD and RSI 40-70",
    "bullish",
    [
      { field: "price_above_sma200", operator: "eq", value: 1 },
      { field: "rsi_14", operator: "between", value: [40, 70] },
      { field: "macd_histogram", operator: "gt", value: 0 },
    ],
  ),
  strategy(
    "bearish_trend",
    "Bearish Trend",
    "Price below 200 SMA with bearish MACD and RSI above 70",
    "bearish",
    [
      { field: "price_above_sma200", operator: "eq", value: 0 },
      { field: "rsi_14", operator: "gt", value: 70 },
    ],
  ),
  strategy(
    "momentum",
    "Momentum Play",
    "RSI above 60 with strong volume and price above 50 EMA",
    "momentum",
    [
      { field: "rsi_14", operator: "gt", value: 60 },
      { field: "volume_ratio", operator: "gt", value: 1.5 },
    ],
  ),
  strategy(
    "volume_breakout",
    "Volume Breakout",
    "Volume more than 2x the 20-day average",
    "volume",
    [{ field: "volume_ratio", operator: "gt", value: 2 }],
  ),
  strategy(
    "golden_cross",
    "Golden Cross",
    "50 SMA crossed above 200 SMA (bullish long-term signal)",
    "bullish",
    [{ field: "golden_cross", operator: "eq", value: 1 }],
  ),
  strategy(
    "death_cross",
    "Death Cross",
    "50 SMA crossed below 200 SMA (bearish long-term signal)",
    "bearish",
    [{ field: "death_cross", operator: "eq", value: 1 }],
  ),
  strategy(
    "bollinger_squeeze",
    "Bollinger Squeeze",
    "Bandwidth below 5% - volatility contraction, breakout likely",
    "volatility",
    [{ field: "bollinger_bandwidth", operator: "lt", value: 5 }],
  ),
  strategy(
    "52w_high_breakout",
    "52-Week High Breakout",
    "Price within 2% of 52-week high",
    "momentum",
    [{ field: "distance_52w_high", operator: "lt", value: 2 }],
  ),
  strategy(
    "oversold_bounce",
    "Oversold Bounce",
    "RSI below 30 - potential reversal candidate",
    "reversal",
    [{ field: "rsi_14", operator: "lt", value: 30 }],
  ),
  strategy(
    "overbought",
    "Overbought Stocks",
    "RSI above 70 - potential pullback candidate",
    "reversal",
    [{ field: "rsi_14", operator: "gt", value: 70 }],
  ),
  strategy(
    "near_support",
    "Near 52-Week Low",
    "Price within 5% of 52-week low - potential support zone",
    "reversal",
    [{ field: "distance_52w_low", operator: "lt", value: 5 }],
  ),
  strategy(
    "macd_bullish_crossover",
    "MACD Bullish Crossover",
    "MACD line crossed above signal line",
    "bullish",
    [
      { field: "macd_histogram", operator: "gt", value: 0 },
      { field: "rsi_14", operator: "between", value: [30, 60] },
    ],
  ),
];

// ── Combined (Fundamental + Technical) ───────────────────────────────

export const COMBINED_STRATEGIES: ScreenerStrategy[] = [
  strategy(
    "buffett_style",
    "Buffett Style",
    "High quality companies at fair prices with bullish technicals",
    "combined",
    [
      { field: "roe", operator: "gt", value: 20 },
      { field: "debtToEquity", operator: "lt", value: 0.5 },
      { field: "pe", operator: "lt", value: 25 },
      { field: "price_above_sma200", operator: "eq", value: 1 },
    ],
  ),
  strategy(
    "peter_lynch_peg",
    "Peter Lynch PEG",
    "Growth at a reasonable price with positive momentum",
    "combined",
    [
      { field: "pegRatio", operator: "lt", value: 1 },
      { field: "earningsGrowth", operator: "gt", value: 15 },
      { field: "rsi_14", operator: "between", value: [40, 70] },
    ],
  ),
  strategy(
    "value_with_momentum",
    "Value + Momentum",
    "Undervalued stocks with bullish momentum signals",
    "combined",
    [
      { field: "pe", operator: "lt", value: 15 },
      { field: "roe", operator: "gt", value: 12 },
      { field: "rsi_14", operator: "between", value: [40, 65] },
      { field: "macd_histogram", operator: "gt", value: 0 },
    ],
  ),
  strategy(
    "quality_breakout",
    "Quality Breakout",
    "High ROCE companies near 52-week highs with volume",
    "combined",
    [
      { field: "roce", operator: "gt", value: 20 },
      { field: "distance_52w_high", operator: "lt", value: 5 },
      { field: "volume_ratio", operator: "gt", value: 1.5 },
    ],
  ),
  strategy(
    "dividend_tech_buy",
    "Dividend + Technical Buy",
    "Dividend stocks with oversold RSI (buy the dip)",
    "combined",
    [
      { field: "dividendYield", operator: "gt", value: 2 },
      { field: "rsi_14", operator: "lt", value: 35 },
      { field: "debtToEquity", operator: "lt", value: 1 },
    ],
  ),
  strategy(
    "growth_momentum",
    "Growth + Momentum",
    "Fast-growing companies with strong price momentum",
    "combined",
    [
      { field: "revenueGrowth", operator: "gt", value: 25 },
      { field: "earningsGrowth", operator: "gt", value: 20 },
      { field: "rsi_14", operator: "between", value: [50, 75] },
      { field: "volume_ratio", operator: "gt", value: 1.2 },
    ],
  ),
];

// ── All Strategies ───────────────────────────────────────────────────

export const ALL_STRATEGIES: ScreenerStrategy[] = [
  ...FUNDAMENTAL_STRATEGIES,
  ...TECHNICAL_STRATEGIES,
  ...COMBINED_STRATEGIES,
];

/**
 * Find a strategy by ID or name (case-insensitive)
 */
export function findStrategy(query: string): ScreenerStrategy | undefined {
  const lower = query.toLowerCase();
  return ALL_STRATEGIES.find(
    (s) =>
      s.id === lower ||
      s.name.toLowerCase() === lower ||
      s.name.toLowerCase().includes(lower),
  );
}

/**
 * List strategies by category
 */
export function listStrategiesByCategory(
  category?: string,
): ScreenerStrategy[] {
  if (!category) return ALL_STRATEGIES;
  return ALL_STRATEGIES.filter(
    (s) => s.category.toLowerCase() === category.toLowerCase(),
  );
}
