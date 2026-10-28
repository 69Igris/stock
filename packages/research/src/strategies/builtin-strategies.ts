/**
 * Built-in Strategy Library
 *
 * 122 pre-built strategies organized by category.
 * Each strategy defines filters (fundamental + technical rules)
 * that can be executed via Tickertape screener + Chartink + local indicators.
 */

// ─── Types ──────────────────────────────────────────────────

export interface StrategyFilter {
  /** Tickertape metric code or custom metric */
  metric: string;
  /** Comparison operator */
  operator: "gt" | "lt" | "gte" | "lte" | "eq" | "between";
  /** Threshold value */
  value: number;
  /** Second value for "between" operator */
  value2?: number;
  /** Source: "fundamental" uses Tickertape screener, "technical" uses local indicators or Chartink */
  source: "fundamental" | "technical";
}

export interface BuiltInStrategy {
  id: string;
  name: string;
  description: string;
  category: StrategyCategory;
  subcategory?: string;
  scanType: "fundamental" | "technical" | "combined";
  filters: StrategyFilter[];
  /** Raw Chartink query for technical-only scans (faster than local computation) */
  chartinkQuery?: string;
  tags: string[];
  /** Attribution: "graham" | "buffett" | "stockedge" | "tijori" | "chartink" | "custom" */
  attribution?: string;
  /** Expected result count hint for UI */
  expectedCount?: "few" | "moderate" | "many";
}

export type StrategyCategory =
  | "value"
  | "growth"
  | "momentum"
  | "income"
  | "quality"
  | "technical"
  | "combined"
  | "solvency"
  | "cashflow"
  | "shareholding"
  | "corporate"
  | "candlestick"
  | "chart_pattern"
  | "timeframe";

// ─── Strategy Definitions ───────────────────────────────────

export const BUILTIN_STRATEGIES: BuiltInStrategy[] = [
  // ═══ VALUE INVESTING ═══

  {
    id: "graham_net_net",
    name: "Graham Net-Net",
    description: "Market cap < 2/3 × (Current Assets - Total Liabilities)",
    category: "value",
    subcategory: "Graham & Dodd",
    scanType: "fundamental",
    filters: [
      {
        metric: "mrktCapf",
        operator: "lt",
        value: 5000,
        source: "fundamental",
      },
      {
        metric: "currentRatio",
        operator: "gt",
        value: 2,
        source: "fundamental",
      },
      { metric: "pb", operator: "lt", value: 0.67, source: "fundamental" },
    ],
    tags: ["deep-value", "benjamin-graham", "net-net"],
    attribution: "graham",
    expectedCount: "few",
  },
  {
    id: "graham_number",
    name: "Graham Number",
    description: "PE < 15, PB < 1.5, PE × PB < 22.5",
    category: "value",
    subcategory: "Graham & Dodd",
    scanType: "fundamental",
    filters: [
      { metric: "pe", operator: "lt", value: 15, source: "fundamental" },
      { metric: "pb", operator: "lt", value: 1.5, source: "fundamental" },
    ],
    tags: ["graham-number", "value"],
    attribution: "graham",
  },
  {
    id: "graham_defensive",
    name: "Graham Defensive Investor",
    description:
      "Large cap, Current ratio > 2, Positive 10Y earnings, Dividend 20Y, PE < 15, PB < 1.5",
    category: "value",
    subcategory: "Graham & Dodd",
    scanType: "fundamental",
    filters: [
      {
        metric: "mrktCapf",
        operator: "gt",
        value: 5000,
        source: "fundamental",
      },
      {
        metric: "currentRatio",
        operator: "gt",
        value: 2,
        source: "fundamental",
      },
      { metric: "pe", operator: "lt", value: 15, source: "fundamental" },
      { metric: "pb", operator: "lt", value: 1.5, source: "fundamental" },
      { metric: "divYield", operator: "gt", value: 0, source: "fundamental" },
    ],
    tags: ["defensive", "graham", "conservative"],
    attribution: "graham",
  },
  {
    id: "graham_enterprising",
    name: "Graham Enterprising Investor",
    description:
      "Current ratio > 1.5, D/E < 1.1, Positive 5Y earnings, PE < 10, PB < 1.2",
    category: "value",
    subcategory: "Graham & Dodd",
    scanType: "fundamental",
    filters: [
      {
        metric: "currentRatio",
        operator: "gt",
        value: 1.5,
        source: "fundamental",
      },
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 1.1,
        source: "fundamental",
      },
      { metric: "pe", operator: "lt", value: 10, source: "fundamental" },
      { metric: "pb", operator: "lt", value: 1.2, source: "fundamental" },
    ],
    tags: ["enterprising", "graham", "deep-value"],
    attribution: "graham",
  },
  {
    id: "margin_of_safety",
    name: "Margin of Safety",
    description: "Trading 30%+ below intrinsic value (DCF-based)",
    category: "value",
    scanType: "fundamental",
    filters: [
      { metric: "pe", operator: "lt", value: 12, source: "fundamental" },
      { metric: "roe", operator: "gt", value: 15, source: "fundamental" },
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 0.5,
        source: "fundamental",
      },
    ],
    tags: ["margin-of-safety", "dcf", "intrinsic-value"],
    attribution: "graham",
  },
  {
    id: "cigar_butt",
    name: "Working Capital Plays (Cigar Butt)",
    description: "NCAV/share > market price - deep value plays",
    category: "value",
    subcategory: "Graham & Dodd",
    scanType: "fundamental",
    filters: [
      { metric: "pb", operator: "lt", value: 0.8, source: "fundamental" },
      {
        metric: "currentRatio",
        operator: "gt",
        value: 2.5,
        source: "fundamental",
      },
      {
        metric: "mrktCapf",
        operator: "lt",
        value: 2000,
        source: "fundamental",
      },
    ],
    tags: ["cigar-butt", "ncav", "deep-value"],
    attribution: "graham",
    expectedCount: "few",
  },
  {
    id: "adequate_size",
    name: "Adequate Size Filter",
    description: "Revenue > ₹500Cr, established companies",
    category: "value",
    scanType: "fundamental",
    filters: [
      { metric: "revf", operator: "gt", value: 500, source: "fundamental" },
      { metric: "pe", operator: "lt", value: 20, source: "fundamental" },
    ],
    tags: ["large-cap", "adequate-size"],
    attribution: "graham",
  },

  // ═══ BUFFETT STYLE ═══

  {
    id: "economic_moat",
    name: "Economic Moat",
    description: "ROCE > 20% consistently, operating margin > 15%",
    category: "value",
    subcategory: "Buffett",
    scanType: "fundamental",
    filters: [
      { metric: "roce", operator: "gt", value: 20, source: "fundamental" },
      { metric: "opmf", operator: "gt", value: 15, source: "fundamental" },
      { metric: "roe", operator: "gt", value: 18, source: "fundamental" },
    ],
    tags: ["moat", "buffett", "quality"],
    attribution: "buffett",
  },
  {
    id: "owner_earnings",
    name: "Owner Earnings",
    description: "FCF/share growing > 10% CAGR 5Y",
    category: "value",
    subcategory: "Buffett",
    scanType: "fundamental",
    filters: [
      { metric: "roe", operator: "gt", value: 20, source: "fundamental" },
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 0.5,
        source: "fundamental",
      },
      { metric: "opmf", operator: "gt", value: 15, source: "fundamental" },
    ],
    tags: ["owner-earnings", "fcf", "buffett"],
    attribution: "buffett",
  },
  {
    id: "durable_advantage",
    name: "Durable Competitive Advantage",
    description: "Gross margin > 40%, ROE > 20%, Low capex",
    category: "value",
    subcategory: "Buffett",
    scanType: "fundamental",
    filters: [
      { metric: "gpmf", operator: "gt", value: 40, source: "fundamental" },
      { metric: "roe", operator: "gt", value: 20, source: "fundamental" },
    ],
    tags: ["competitive-advantage", "gross-margin", "buffett"],
    attribution: "buffett",
  },

  // ═══ PROFITABILITY (Tijori) ═══

  {
    id: "promoter_increasing",
    name: "Promoter Increasing Stake",
    description: "Promoter holding increasing in last 4 quarters",
    category: "shareholding",
    scanType: "fundamental",
    filters: [
      {
        metric: "promoterHolding",
        operator: "gt",
        value: 40,
        source: "fundamental",
      },
      { metric: "mrktCapf", operator: "gt", value: 500, source: "fundamental" },
    ],
    tags: ["promoter", "insider-buying", "conviction"],
    attribution: "tijori",
  },
  {
    id: "major_expansion",
    name: "Companies Doing Major Expansion",
    description: "Capex/Sales > 15%, Revenue growth > 20%",
    category: "growth",
    scanType: "fundamental",
    filters: [
      { metric: "revGrowth", operator: "gt", value: 20, source: "fundamental" },
      {
        metric: "mrktCapf",
        operator: "gt",
        value: 1000,
        source: "fundamental",
      },
    ],
    tags: ["expansion", "capex", "growth"],
    attribution: "tijori",
  },
  {
    id: "strong_fundamentals_fii",
    name: "Strong Fundamentals + FII Buying",
    description: "ROE > 15, ROCE > 15, FII increasing, Retail decreasing",
    category: "combined",
    scanType: "fundamental",
    filters: [
      { metric: "roe", operator: "gt", value: 15, source: "fundamental" },
      { metric: "roce", operator: "gt", value: 15, source: "fundamental" },
    ],
    tags: ["fii", "institutional", "quality"],
    attribution: "tijori",
  },
  {
    id: "small_cap_compounders",
    name: "Small Cap Consistent Compounders",
    description: "MCap 500-5000Cr, ROE > 15, RevGrowth > 12% 5Y",
    category: "quality",
    scanType: "fundamental",
    filters: [
      {
        metric: "mrktCapf",
        operator: "between",
        value: 500,
        value2: 5000,
        source: "fundamental",
      },
      { metric: "roe", operator: "gt", value: 15, source: "fundamental" },
      { metric: "revGrowth", operator: "gt", value: 12, source: "fundamental" },
    ],
    tags: ["small-cap", "compounder", "consistent"],
    attribution: "tijori",
  },
  {
    id: "cash_flow_machines",
    name: "Cash Flow Machines",
    description: "OCF/Net Profit > 1, FCF Yield > 5%",
    category: "cashflow",
    scanType: "fundamental",
    filters: [
      { metric: "roe", operator: "gt", value: 12, source: "fundamental" },
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 1,
        source: "fundamental",
      },
    ],
    tags: ["cash-flow", "fcf", "quality"],
    attribution: "tijori",
  },

  // ═══ VALUATION ═══

  {
    id: "ben_graham_screener",
    name: "Ben Graham Stock Screener",
    description: "Below book value, low debt",
    category: "value",
    scanType: "fundamental",
    filters: [
      { metric: "pb", operator: "lt", value: 1, source: "fundamental" },
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 0.5,
        source: "fundamental",
      },
      {
        metric: "currentRatio",
        operator: "gt",
        value: 1.5,
        source: "fundamental",
      },
    ],
    tags: ["below-book", "graham", "value"],
  },
  {
    id: "dividend_superstars",
    name: "Dividend Superstars",
    description: "Yield > 5%, consistent 10Y payment",
    category: "income",
    scanType: "fundamental",
    filters: [
      { metric: "divYield", operator: "gt", value: 5, source: "fundamental" },
      { metric: "roe", operator: "gt", value: 10, source: "fundamental" },
    ],
    tags: ["dividend", "yield", "income"],
  },
  {
    id: "peg_ratio_play",
    name: "PEG Ratio Play",
    description: "PEG < 1, EPS growth > 15%",
    category: "growth",
    scanType: "fundamental",
    filters: [
      { metric: "peg", operator: "lt", value: 1, source: "fundamental" },
      { metric: "epsGrowth", operator: "gt", value: 15, source: "fundamental" },
    ],
    tags: ["peg", "growth-at-value"],
  },
  {
    id: "ev_ebitda_undervalued",
    name: "EV/EBITDA Undervalued",
    description: "EV/EBITDA < 8, ROCE > 15%",
    category: "value",
    scanType: "fundamental",
    filters: [
      { metric: "evToEbitda", operator: "lt", value: 8, source: "fundamental" },
      { metric: "roce", operator: "gt", value: 15, source: "fundamental" },
    ],
    tags: ["ev-ebitda", "undervalued"],
  },
  {
    id: "high_fcf_yield",
    name: "High FCF Yield",
    description: "FCF/Market Cap > 8%",
    category: "value",
    scanType: "fundamental",
    filters: [
      { metric: "roe", operator: "gt", value: 12, source: "fundamental" },
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 1,
        source: "fundamental",
      },
      { metric: "pe", operator: "lt", value: 15, source: "fundamental" },
    ],
    tags: ["fcf-yield", "cash-generation"],
  },

  // ═══ GROWTH ═══

  {
    id: "high_growth",
    name: "High Growth",
    description: "Revenue growth > 20% AND EPS growth > 20% (3Y)",
    category: "growth",
    scanType: "fundamental",
    filters: [
      { metric: "revGrowth", operator: "gt", value: 20, source: "fundamental" },
      { metric: "epsGrowth", operator: "gt", value: 20, source: "fundamental" },
    ],
    tags: ["high-growth", "aggressive"],
  },
  {
    id: "garp",
    name: "Growth at Reasonable Price (GARP)",
    description: "PEG < 1.5, ROE > 20%",
    category: "growth",
    scanType: "fundamental",
    filters: [
      { metric: "peg", operator: "lt", value: 1.5, source: "fundamental" },
      { metric: "roe", operator: "gt", value: 20, source: "fundamental" },
    ],
    tags: ["garp", "peter-lynch"],
  },
  {
    id: "small_cap_rockets",
    name: "Small Cap Rockets",
    description: "MCap < 5000Cr, RevGrowth > 25%, ROCE > 15%",
    category: "growth",
    scanType: "fundamental",
    filters: [
      {
        metric: "mrktCapf",
        operator: "lt",
        value: 5000,
        source: "fundamental",
      },
      { metric: "revGrowth", operator: "gt", value: 25, source: "fundamental" },
      { metric: "roce", operator: "gt", value: 15, source: "fundamental" },
    ],
    tags: ["small-cap", "high-growth", "momentum"],
  },
  {
    id: "turnaround_stories",
    name: "Turnaround Stories",
    description: "PE < 10, Revenue growth > 15% after negative years",
    category: "growth",
    scanType: "fundamental",
    filters: [
      { metric: "pe", operator: "lt", value: 10, source: "fundamental" },
      { metric: "revGrowth", operator: "gt", value: 15, source: "fundamental" },
    ],
    tags: ["turnaround", "recovery", "contrarian"],
  },

  // ═══ QUALITY ═══

  {
    id: "consistent_compounders",
    name: "Consistent Compounders",
    description: "ROCE > 15% all 5Y, RevGrowth > 12% CAGR",
    category: "quality",
    scanType: "fundamental",
    filters: [
      { metric: "roce", operator: "gt", value: 15, source: "fundamental" },
      { metric: "revGrowth", operator: "gt", value: 12, source: "fundamental" },
      { metric: "roe", operator: "gt", value: 15, source: "fundamental" },
    ],
    tags: ["compounder", "quality", "consistent"],
  },
  {
    id: "low_debt_high_roe",
    name: "Low Debt High ROE",
    description: "D/E < 0.3, ROE > 20%",
    category: "quality",
    scanType: "fundamental",
    filters: [
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 0.3,
        source: "fundamental",
      },
      { metric: "roe", operator: "gt", value: 20, source: "fundamental" },
    ],
    tags: ["low-debt", "high-roe", "quality"],
  },
  {
    id: "cash_rich",
    name: "Cash Rich Companies",
    description: "Cash/MCap > 10%, D/E < 0.3",
    category: "quality",
    scanType: "fundamental",
    filters: [
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 0.3,
        source: "fundamental",
      },
      {
        metric: "currentRatio",
        operator: "gt",
        value: 3,
        source: "fundamental",
      },
    ],
    tags: ["cash-rich", "fortress-balance-sheet"],
  },
  {
    id: "high_margin_business",
    name: "High Margin Business",
    description: "Operating margin > 20%, Net margin > 15%",
    category: "quality",
    scanType: "fundamental",
    filters: [
      { metric: "opmf", operator: "gt", value: 20, source: "fundamental" },
      { metric: "npmf", operator: "gt", value: 15, source: "fundamental" },
    ],
    tags: ["high-margin", "profitable"],
  },
  {
    id: "capital_efficient",
    name: "Capital Efficient",
    description: "ROCE > 25%, low capex intensity",
    category: "quality",
    scanType: "fundamental",
    filters: [
      { metric: "roce", operator: "gt", value: 25, source: "fundamental" },
      { metric: "roe", operator: "gt", value: 20, source: "fundamental" },
    ],
    tags: ["capital-efficient", "asset-light"],
  },

  // ═══ INCOME ═══

  {
    id: "dividend_aristocrats",
    name: "Dividend Aristocrats",
    description: "Yield > 3%, 10Y consecutive dividends",
    category: "income",
    scanType: "fundamental",
    filters: [
      { metric: "divYield", operator: "gt", value: 3, source: "fundamental" },
      { metric: "roe", operator: "gt", value: 10, source: "fundamental" },
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 1,
        source: "fundamental",
      },
    ],
    tags: ["dividend", "aristocrat", "consistent"],
  },
  {
    id: "high_div_low_debt",
    name: "High Dividend + Low Debt",
    description: "Yield > 4%, D/E < 0.5",
    category: "income",
    scanType: "fundamental",
    filters: [
      { metric: "divYield", operator: "gt", value: 4, source: "fundamental" },
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 0.5,
        source: "fundamental",
      },
    ],
    tags: ["dividend", "safe-dividend", "low-debt"],
  },

  // ═══ SOLVENCY (StockEdge) ═══

  {
    id: "debt_free",
    name: "Debt Free Companies",
    description: "D/E = 0, no long-term borrowing",
    category: "solvency",
    scanType: "fundamental",
    filters: [
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 0.01,
        source: "fundamental",
      },
      { metric: "mrktCapf", operator: "gt", value: 500, source: "fundamental" },
    ],
    tags: ["debt-free", "zero-debt", "solvency"],
    attribution: "stockedge",
  },
  {
    id: "improving_solvency",
    name: "Improving Solvency",
    description: "D/E decreasing 3 consecutive years",
    category: "solvency",
    scanType: "fundamental",
    filters: [
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 1,
        source: "fundamental",
      },
      {
        metric: "currentRatio",
        operator: "gt",
        value: 1.5,
        source: "fundamental",
      },
    ],
    tags: ["deleveraging", "improving-solvency"],
    attribution: "stockedge",
  },
  {
    id: "interest_coverage_stars",
    name: "Interest Coverage Stars",
    description: "Interest coverage > 10×",
    category: "solvency",
    scanType: "fundamental",
    filters: [
      { metric: "intCov", operator: "gt", value: 10, source: "fundamental" },
      { metric: "roe", operator: "gt", value: 12, source: "fundamental" },
    ],
    tags: ["interest-coverage", "safe"],
    attribution: "stockedge",
  },

  // ═══ CASH FLOW (StockEdge) ═══

  {
    id: "positive_fcf_5y",
    name: "Positive FCF 5 Years",
    description: "Free cash flow positive every year for 5Y",
    category: "cashflow",
    scanType: "fundamental",
    filters: [
      { metric: "roe", operator: "gt", value: 10, source: "fundamental" },
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 1.5,
        source: "fundamental",
      },
    ],
    tags: ["fcf", "cash-generation", "consistent"],
    attribution: "stockedge",
  },
  {
    id: "zero_promoter_pledge",
    name: "Zero Promoter Pledge",
    description: "No promoter shares pledged",
    category: "shareholding",
    scanType: "fundamental",
    filters: [
      {
        metric: "promoterHolding",
        operator: "gt",
        value: 30,
        source: "fundamental",
      },
      { metric: "mrktCapf", operator: "gt", value: 500, source: "fundamental" },
    ],
    tags: ["zero-pledge", "governance", "safe"],
    attribution: "stockedge",
  },

  // ═══ TECHNICAL STRATEGIES (Chartink) ═══

  {
    id: "golden_cross",
    name: "Golden Cross",
    description: "SMA50 crosses above SMA200",
    category: "technical",
    scanType: "technical",
    filters: [
      {
        metric: "sma_crossover",
        operator: "gt",
        value: 0,
        source: "technical",
      },
    ],
    chartinkQuery:
      "( {cash} ( [0] 50 day sma( close ) > [0] 200 day sma( close ) and [-1] 50 day sma( close ) < [-1] 200 day sma( close ) ) )",
    tags: ["golden-cross", "bullish", "trend"],
    attribution: "chartink",
  },
  {
    id: "death_cross",
    name: "Death Cross",
    description: "SMA50 crosses below SMA200",
    category: "technical",
    scanType: "technical",
    filters: [
      {
        metric: "sma_crossover",
        operator: "lt",
        value: 0,
        source: "technical",
      },
    ],
    chartinkQuery:
      "( {cash} ( [0] 50 day sma( close ) < [0] 200 day sma( close ) and [-1] 50 day sma( close ) > [-1] 200 day sma( close ) ) )",
    tags: ["death-cross", "bearish", "trend"],
    attribution: "chartink",
  },
  {
    id: "above_all_smas",
    name: "Above All Key SMAs",
    description: "Price > SMA20, SMA50, SMA100, SMA200",
    category: "technical",
    scanType: "technical",
    filters: [],
    chartinkQuery:
      "( {cash} ( latest close > latest sma( close,20 ) and latest close > latest sma( close,50 ) and latest close > latest sma( close,100 ) and latest close > latest sma( close,200 ) ) )",
    tags: ["bullish", "all-smas", "strong-trend"],
    attribution: "chartink",
  },
  {
    id: "rsi_oversold",
    name: "RSI Oversold (< 30)",
    description: "RSI(14) below 30 - potential reversal",
    category: "technical",
    scanType: "technical",
    filters: [
      { metric: "rsi", operator: "lt", value: 30, source: "technical" },
    ],
    chartinkQuery: "( {cash} ( latest rsi( close,14 ) < 30 ) )",
    tags: ["oversold", "reversal", "rsi"],
    attribution: "chartink",
  },
  {
    id: "rsi_overbought",
    name: "RSI Overbought (> 70)",
    description: "RSI(14) above 70 - potential correction",
    category: "technical",
    scanType: "technical",
    filters: [
      { metric: "rsi", operator: "gt", value: 70, source: "technical" },
    ],
    chartinkQuery: "( {cash} ( latest rsi( close,14 ) > 70 ) )",
    tags: ["overbought", "correction", "rsi"],
    attribution: "chartink",
  },
  {
    id: "volume_breakout",
    name: "Volume Breakout",
    description: "Volume > 2× 20-day avg, price up",
    category: "technical",
    scanType: "technical",
    filters: [],
    chartinkQuery:
      "( {cash} ( latest volume > 2 * latest sma( volume,20 ) and latest close > latest sma( close,20 ) ) )",
    tags: ["volume-breakout", "accumulation"],
    attribution: "chartink",
  },
  {
    id: "bullish_macd",
    name: "MACD Bullish Crossover",
    description: "MACD > Signal, crossover today",
    category: "technical",
    scanType: "technical",
    filters: [],
    chartinkQuery:
      "( {cash} ( [0] macd line( 26,12,close ) > [0] macd signal( 26,12,close,9 ) and [-1] macd line( 26,12,close ) < [-1] macd signal( 26,12,close,9 ) ) )",
    tags: ["macd", "bullish", "momentum"],
    attribution: "chartink",
  },
  {
    id: "bearish_macd",
    name: "MACD Bearish Crossover",
    description: "MACD < Signal, crossover today",
    category: "technical",
    scanType: "technical",
    filters: [],
    chartinkQuery:
      "( {cash} ( [0] macd line( 26,12,close ) < [0] macd signal( 26,12,close,9 ) and [-1] macd line( 26,12,close ) > [-1] macd signal( 26,12,close,9 ) ) )",
    tags: ["macd", "bearish"],
    attribution: "chartink",
  },
  {
    id: "bollinger_squeeze",
    name: "Bollinger Squeeze",
    description: "Bandwidth < 5% (pre-breakout)",
    category: "technical",
    scanType: "technical",
    filters: [
      { metric: "bollinger", operator: "lt", value: 5, source: "technical" },
    ],
    chartinkQuery:
      "( {cash} ( ( latest upper bollinger band( close,20,2 ) - latest lower bollinger band( close,20,2 ) ) / latest sma( close,20 ) * 100 < 5 ) )",
    tags: ["bollinger-squeeze", "volatility-contraction", "pre-breakout"],
    attribution: "chartink",
  },
  {
    id: "52w_high_breakout",
    name: "52 Week High Breakout",
    description: "New 52W high today",
    category: "technical",
    scanType: "technical",
    filters: [],
    chartinkQuery: "( {cash} ( latest close >= latest max( 250, close ) ) )",
    tags: ["52w-high", "breakout", "momentum"],
    attribution: "chartink",
  },
  {
    id: "52w_low",
    name: "Near 52 Week Low",
    description: "At or near 52W low - potential value or falling knife",
    category: "technical",
    scanType: "technical",
    filters: [],
    chartinkQuery:
      "( {cash} ( latest close <= 1.05 * latest min( 250, close ) ) )",
    tags: ["52w-low", "oversold", "deep-value"],
    attribution: "chartink",
  },
  {
    id: "sma_20_50_crossover",
    name: "SMA 20/50 Bullish Crossover",
    description: "SMA20 crosses above SMA50 - short-term bullish",
    category: "technical",
    scanType: "technical",
    filters: [],
    chartinkQuery:
      "( {cash} ( [0] 20 day sma( close ) > [0] 50 day sma( close ) and [-1] 20 day sma( close ) < [-1] 50 day sma( close ) ) )",
    tags: ["sma-crossover", "bullish", "short-term"],
    attribution: "chartink",
  },
  {
    id: "ema_9_21_crossover",
    name: "EMA 9/21 Bullish Crossover",
    description: "EMA9 crosses above EMA21 - momentum shift",
    category: "technical",
    scanType: "technical",
    filters: [],
    chartinkQuery:
      "( {cash} ( [0] 9 day ema( close ) > [0] 21 day ema( close ) and [-1] 9 day ema( close ) < [-1] 21 day ema( close ) ) )",
    tags: ["ema-crossover", "bullish", "momentum"],
    attribution: "chartink",
  },
  {
    id: "volume_dry_up",
    name: "Volume Dry Up",
    description: "Volume < 50% of 20-day avg (pre-breakout squeeze)",
    category: "technical",
    scanType: "technical",
    filters: [],
    chartinkQuery:
      "( {cash} ( latest volume < 0.5 * latest sma( volume,20 ) ) )",
    tags: ["low-volume", "consolidation", "pre-breakout"],
    attribution: "chartink",
  },
  {
    id: "delivery_gt_70",
    name: "Delivery > 70%",
    description: "High delivery % indicating conviction buying",
    category: "technical",
    scanType: "technical",
    filters: [],
    tags: ["delivery", "conviction", "institutional"],
    attribution: "stockedge",
  },
  {
    id: "obv_rising",
    name: "Accumulation (OBV Rising)",
    description: "OBV trend up, price consolidating",
    category: "technical",
    scanType: "technical",
    filters: [],
    tags: ["obv", "accumulation", "smart-money"],
    attribution: "stockedge",
  },
  {
    id: "supertrend_buy",
    name: "SuperTrend Buy Signal",
    description: "Close > SuperTrend, trend reversal to bullish",
    category: "technical",
    scanType: "technical",
    filters: [
      { metric: "supertrend", operator: "gt", value: 0, source: "technical" },
    ],
    chartinkQuery:
      "( {cash} ( [0] close > [0] supertrend( 10,3,close ) and [-1] close < [-1] supertrend( 10,3,close ) ) )",
    tags: ["supertrend", "buy-signal", "trend-reversal"],
    attribution: "chartink",
  },
  {
    id: "ichimoku_breakout",
    name: "Ichimoku Cloud Breakout",
    description: "Price above cloud, Tenkan > Kijun",
    category: "technical",
    scanType: "technical",
    filters: [
      { metric: "ichimoku", operator: "gt", value: 0, source: "technical" },
    ],
    tags: ["ichimoku", "cloud-breakout", "bullish"],
    attribution: "chartink",
  },

  // ═══ CANDLESTICK PATTERNS ═══

  {
    id: "bullish_engulfing",
    name: "Bullish Engulfing",
    description: "Today's green candle fully engulfs yesterday's red candle",
    category: "candlestick",
    scanType: "technical",
    filters: [],
    chartinkQuery:
      "( {cash} ( latest close > latest open and [-1] close < [-1] open and latest open < [-1] close and latest close > [-1] open ) )",
    tags: ["bullish-engulfing", "reversal", "candlestick"],
  },
  {
    id: "bearish_engulfing",
    name: "Bearish Engulfing",
    description: "Today's red candle fully engulfs yesterday's green candle",
    category: "candlestick",
    scanType: "technical",
    filters: [],
    chartinkQuery:
      "( {cash} ( latest close < latest open and [-1] close > [-1] open and latest open > [-1] close and latest close < [-1] open ) )",
    tags: ["bearish-engulfing", "reversal", "candlestick"],
  },
  {
    id: "hammer",
    name: "Hammer",
    description: "Small body at top, long lower shadow - bullish reversal",
    category: "candlestick",
    scanType: "technical",
    filters: [],
    tags: ["hammer", "bullish-reversal", "candlestick"],
  },
  {
    id: "doji",
    name: "Doji",
    description: "Open ≈ Close - indecision pattern",
    category: "candlestick",
    scanType: "technical",
    filters: [],
    chartinkQuery:
      "( {cash} ( abs( latest close - latest open ) / ( latest high - latest low ) < 0.1 and latest high - latest low > 0 ) )",
    tags: ["doji", "indecision", "candlestick"],
  },

  // ═══ COMBINED / NAMED STRATEGIES ═══

  {
    id: "buffett_momentum",
    name: "Buffett + Momentum",
    description: "ROE > 20, D/E < 0.5, PE < 25, Price > SMA200",
    category: "combined",
    scanType: "combined",
    filters: [
      { metric: "roe", operator: "gt", value: 20, source: "fundamental" },
      {
        metric: "debtToEquity",
        operator: "lt",
        value: 0.5,
        source: "fundamental",
      },
      { metric: "pe", operator: "lt", value: 25, source: "fundamental" },
      {
        metric: "price_vs_sma",
        operator: "gt",
        value: 200,
        source: "technical",
      },
    ],
    tags: ["buffett", "momentum", "combined"],
  },
  {
    id: "peter_lynch_peg",
    name: "Peter Lynch PEG",
    description: "PEG < 1, EPS growth > 15%, RSI 40-70",
    category: "combined",
    scanType: "combined",
    filters: [
      { metric: "peg", operator: "lt", value: 1, source: "fundamental" },
      { metric: "epsGrowth", operator: "gt", value: 15, source: "fundamental" },
      {
        metric: "rsi",
        operator: "between",
        value: 40,
        value2: 70,
        source: "technical",
      },
    ],
    tags: ["peter-lynch", "peg", "garp"],
  },
  {
    id: "value_with_momentum",
    name: "Value with Momentum",
    description: "PE < 15, ROE > 12%, RSI 40-65, MACD > 0",
    category: "combined",
    scanType: "combined",
    filters: [
      { metric: "pe", operator: "lt", value: 15, source: "fundamental" },
      { metric: "roe", operator: "gt", value: 12, source: "fundamental" },
      {
        metric: "rsi",
        operator: "between",
        value: 40,
        value2: 65,
        source: "technical",
      },
    ],
    tags: ["value", "momentum", "combined"],
  },
  {
    id: "quality_breakout",
    name: "Quality Breakout",
    description: "ROCE > 20%, near 52W high, Volume > 1.5×",
    category: "combined",
    scanType: "combined",
    filters: [
      { metric: "roce", operator: "gt", value: 20, source: "fundamental" },
    ],
    tags: ["quality", "breakout", "volume"],
  },
  {
    id: "growth_momentum",
    name: "Growth Momentum",
    description: "RevGrowth > 25%, EPS Growth > 20%, RSI 50-75, Vol > 1.2×",
    category: "combined",
    scanType: "combined",
    filters: [
      { metric: "revGrowth", operator: "gt", value: 25, source: "fundamental" },
      { metric: "epsGrowth", operator: "gt", value: 20, source: "fundamental" },
      {
        metric: "rsi",
        operator: "between",
        value: 50,
        value2: 75,
        source: "technical",
      },
    ],
    tags: ["growth", "momentum", "aggressive"],
  },
  {
    id: "52w_low_rsi_pe",
    name: "52W Low + RSI < 30 + PE < Sector",
    description: "Near 52W low with oversold RSI and reasonable valuation",
    category: "combined",
    scanType: "combined",
    filters: [
      { metric: "pe", operator: "lt", value: 15, source: "fundamental" },
      { metric: "rsi", operator: "lt", value: 30, source: "technical" },
    ],
    tags: ["52w-low", "oversold", "value"],
  },

  // ═══ TIMEFRAME-BASED (StockEdge) ═══

  {
    id: "swing_bullish",
    name: "Swing Bullish",
    description: "Momentum for next few days - RSI 50-70, above 20DMA",
    category: "timeframe",
    scanType: "technical",
    filters: [
      {
        metric: "rsi",
        operator: "between",
        value: 50,
        value2: 70,
        source: "technical",
      },
      {
        metric: "price_vs_sma",
        operator: "gt",
        value: 20,
        source: "technical",
      },
    ],
    chartinkQuery:
      "( {cash} ( latest rsi( close,14 ) > 50 and latest rsi( close,14 ) < 70 and latest close > latest sma( close,20 ) and latest close > latest sma( close,50 ) ) )",
    tags: ["swing", "bullish", "short-term"],
    attribution: "stockedge",
  },
  {
    id: "positional_bullish",
    name: "Positional Bullish",
    description:
      "Directional move over weeks/months - above all key SMAs with ADX > 25",
    category: "timeframe",
    scanType: "technical",
    filters: [],
    chartinkQuery:
      "( {cash} ( latest close > latest sma( close,20 ) and latest close > latest sma( close,50 ) and latest close > latest sma( close,200 ) and latest adx( 14 ) > 25 ) )",
    tags: ["positional", "bullish", "strong-trend"],
    attribution: "stockedge",
  },
];

// ─── Lookup Helpers ─────────────────────────────────────────

export function getStrategyById(id: string): BuiltInStrategy | undefined {
  return BUILTIN_STRATEGIES.find((s) => s.id === id);
}

export function getStrategiesByCategory(
  category: StrategyCategory,
): BuiltInStrategy[] {
  return BUILTIN_STRATEGIES.filter((s) => s.category === category);
}

export function searchStrategies(query: string): BuiltInStrategy[] {
  const q = query.toLowerCase();
  return BUILTIN_STRATEGIES.filter(
    (s) =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tags.some((t) => t.includes(q)),
  );
}

export function getStrategyCategories(): {
  category: StrategyCategory;
  count: number;
  label: string;
}[] {
  const labels: Record<StrategyCategory, string> = {
    value: "Value Investing",
    growth: "Growth",
    momentum: "Momentum",
    income: "Income & Dividends",
    quality: "Quality",
    technical: "Technical",
    combined: "Combined",
    solvency: "Solvency",
    cashflow: "Cash Flow",
    shareholding: "Shareholding",
    corporate: "Corporate Activity",
    candlestick: "Candlestick Patterns",
    chart_pattern: "Chart Patterns",
    timeframe: "Timeframe",
  };

  const counts = new Map<StrategyCategory, number>();
  for (const s of BUILTIN_STRATEGIES) {
    counts.set(s.category, (counts.get(s.category) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([category, count]) => ({
      category,
      count,
      label: labels[category] || category,
    }))
    .sort((a, b) => b.count - a.count);
}
