/**
 * Strategy catalog - shared between the /strategies index and the
 * per-strategy detail / backtest / forward pages.
 *
 * Each entry carries:
 *   - Static identity (name, description, category, tone)
 *   - Headline stats (CAGR / Sharpe / MaxDD / 1Y / WinRate / AvgHold)
 *   - Equity curve sample (~12 points, normalised) for catalog sparkline
 *   - Rule blocks (universe, entry, exit, hold) for the detail page
 *   - Filter conditions (AND/OR tree) for the detail page
 *   - Author ("built-in" or a userId/display name for forked / AI-built)
 *
 * Live worker-computed stats (MONEY-425) arrive from
 * getStrategiesStatsAction at render time and override the static
 * CAGR / Sharpe / etc. - that's the seam between the catalog
 * (compile-time) and the backtest pipeline (worker-time).
 */

export type StrategyTone = "acc" | "blue" | "vio" | "warn";

export type StrategyCategory =
  | "Trend"
  | "Momentum"
  | "Value"
  | "Quality"
  | "Mean-reversion"
  | "Pattern"
  | "Custom";

export type StrategyStatus = "LIVE" | "Backtested" | "CUSTOM";

export interface FilterAtom {
  field: string;
  cmp: string;
  value: string;
}

export interface FilterGroup {
  op: "AND" | "OR";
  items: Array<FilterAtom | FilterGroup>;
}

export interface StrategyRules {
  universe: string;
  entry: string;
  exit: string;
  hold: string;
}

export interface StrategyMeta {
  id: string;
  name: string;
  description: string;
  category: StrategyCategory;
  /** "built-in" for the curated catalog, userId/display for forks. */
  author: string;
  cagr: string;
  sharpe: string;
  maxDD: string;
  return1Y: string;
  winRate: string;
  avgHold: string;
  curve: number[];
  status: StrategyStatus;
  tone: StrategyTone;
  /** Rule blocks rendered on the detail page right column. */
  rules: StrategyRules;
  /** Filter-condition tree rendered on the detail page left column. */
  filters: FilterGroup;
  /** Legacy aliases kept so older callers still type-check. */
  ret?: string;
  bt?: string;
  users?: number;
}

export const STRATEGY_TABS: ReadonlyArray<"All" | StrategyCategory> = [
  "All",
  "Trend",
  "Momentum",
  "Value",
  "Quality",
  "Mean-reversion",
  "Pattern",
  "Custom",
] as const;

const DEFAULT_FILTERS: FilterGroup = {
  op: "AND",
  items: [
    { field: "marketCap", cmp: ">", value: "₹5,000 Cr" },
    { field: "ROIC", cmp: ">", value: "18%" },
    { field: "debt/eq", cmp: "<", value: "0.5" },
    { field: "fcfMargin", cmp: ">", value: "10%" },
  ],
};

export const STRATEGIES: StrategyMeta[] = [
  {
    id: "golden-cross",
    name: "50/200 DMA crossover",
    description:
      "Long when 50-DMA crosses above 200-DMA. Classic trend follower.",
    category: "Trend",
    author: "built-in",
    cagr: "+18.2%",
    sharpe: "1.12",
    maxDD: "-22.4%",
    return1Y: "+24.8%",
    winRate: "58%",
    avgHold: "84d",
    curve: [50, 52, 54, 56, 58, 62, 64, 68, 72, 76, 82, 88],
    status: "Backtested",
    tone: "acc",
    rules: {
      universe: "NIFTY 500",
      entry: "First day of month · equal-weight · top 30",
      exit: "On screen dropout · monthly rebalance",
      hold: "Median 84d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "marketCap", cmp: ">", value: "₹5,000 Cr" },
        { field: "close vs 50-DMA", cmp: ">", value: "0%" },
        { field: "50-DMA crosses 200-DMA", cmp: "=", value: "true" },
      ],
    },
  },
  {
    id: "12m-momentum",
    name: "12-month momentum",
    description:
      "Top decile by trailing 12-month return ex-recent-month, rebalanced monthly.",
    category: "Momentum",
    author: "built-in",
    cagr: "+24.1%",
    sharpe: "1.34",
    maxDD: "-28.1%",
    return1Y: "+31.4%",
    winRate: "54%",
    avgHold: "42d",
    curve: [50, 51, 56, 54, 60, 63, 67, 72, 76, 82, 88, 95],
    status: "LIVE",
    tone: "acc",
    rules: {
      universe: "NIFTY 500",
      entry: "Top decile by 12m-1m return · equal-weight · top 30",
      exit: "Rebalance monthly · sell on dropout",
      hold: "Median 42d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "marketCap", cmp: ">", value: "₹3,000 Cr" },
        { field: "12m-1m return", cmp: ">", value: "top 10%" },
        { field: "avgVolume30d", cmp: ">", value: "₹50 L" },
      ],
    },
  },
  {
    id: "magic-formula",
    name: "Magic Formula",
    description:
      "Joel Greenblatt - rank by earnings yield + ROIC. Hold 30 names, annual rebalance.",
    category: "Value",
    author: "built-in",
    cagr: "+19.8%",
    sharpe: "1.24",
    maxDD: "-24.6%",
    return1Y: "+12.2%",
    winRate: "61%",
    avgHold: "365d",
    curve: [50, 48, 52, 55, 58, 60, 63, 68, 72, 76, 80, 86],
    status: "Backtested",
    tone: "blue",
    rules: {
      universe: "NIFTY 500",
      entry: "Top 30 by (rank_earningsYield + rank_ROIC) · equal-weight",
      exit: "Annual rebalance · sell on dropout",
      hold: "Median 365d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "marketCap", cmp: ">", value: "₹2,000 Cr" },
        { field: "earningsYield", cmp: ">", value: "8%" },
        { field: "ROIC", cmp: ">", value: "20%" },
      ],
    },
  },
  {
    id: "roic-quality",
    name: "ROIC > 18% quality",
    description: "Persistent ROIC > 18%, debt/equity < 0.5, FCF positive 5y.",
    category: "Quality",
    author: "built-in",
    cagr: "+21.0%",
    sharpe: "1.42",
    maxDD: "-16.8%",
    return1Y: "+22.4%",
    winRate: "67%",
    avgHold: "210d",
    curve: [50, 52, 54, 56, 58, 60, 63, 67, 71, 75, 80, 85],
    status: "LIVE",
    tone: "vio",
    rules: {
      universe: "NIFTY 500",
      entry: "Top 30 by ROIC × FCF margin · cap-weighted",
      exit: "Sell when ROIC drops below 15% · quarterly rebalance",
      hold: "Median 210d",
    },
    filters: DEFAULT_FILTERS,
  },
  {
    id: "rsi-mean-rev",
    name: "RSI < 30 mean-reversion",
    description:
      "Enter when 14-period RSI < 30 + above 200-DMA. Exit on RSI > 55 or 5%.",
    category: "Mean-reversion",
    author: "built-in",
    cagr: "+14.6%",
    sharpe: "0.92",
    maxDD: "-18.2%",
    return1Y: "+8.2%",
    winRate: "63%",
    avgHold: "12d",
    curve: [50, 53, 51, 54, 56, 53, 56, 58, 56, 59, 61, 60],
    status: "Backtested",
    tone: "warn",
    rules: {
      universe: "NIFTY 100",
      entry: "RSI(14) < 30 AND close > 200-DMA · equal-weight",
      exit: "RSI(14) > 55 OR +5% gain · stop loss at -3%",
      hold: "Median 12d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "RSI 14", cmp: "<", value: "30" },
        { field: "close vs 200-DMA", cmp: ">", value: "0%" },
        { field: "avgVolume20d", cmp: ">", value: "₹2 Cr" },
      ],
    },
  },
  {
    id: "cup-and-handle",
    name: "Cup-and-handle breakout",
    description:
      "Detect 6-12 week cup pattern + 1-3 week handle. Volume confirmation required.",
    category: "Pattern",
    author: "built-in",
    cagr: "+22.8%",
    sharpe: "1.18",
    maxDD: "-26.4%",
    return1Y: "+18.6%",
    winRate: "44%",
    avgHold: "62d",
    curve: [50, 52, 54, 56, 58, 62, 64, 68, 72, 76, 82, 88],
    status: "Backtested",
    tone: "acc",
    rules: {
      universe: "NIFTY 500",
      entry: "Cup-and-handle pattern detected + volume > 1.5× avg",
      exit: "Stop loss at handle low · target 1.5× cup depth",
      hold: "Median 62d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "marketCap", cmp: ">", value: "₹2,500 Cr" },
        { field: "cupDepth", cmp: ">", value: "10%" },
        { field: "handleVolume", cmp: "<", value: "0.7× avg" },
        { field: "breakoutVolume", cmp: ">", value: "1.5× avg" },
      ],
    },
  },
  {
    id: "defensive-flexicap",
    name: "My defensive flexi-cap",
    description:
      "Quality + low-vol + dividend yield > 1.5%. Excludes PSU banks.",
    category: "Custom",
    author: "built-in",
    cagr: "+16.2%",
    sharpe: "1.38",
    maxDD: "-12.1%",
    return1Y: "+18.4%",
    winRate: "65%",
    avgHold: "180d",
    curve: [50, 51, 52, 54, 55, 57, 58, 60, 62, 64, 66, 68],
    status: "LIVE",
    tone: "vio",
    rules: {
      universe: "NIFTY 500",
      entry: "Low-vol + ROIC > 15% + div yield > 1.5% · cap-weighted",
      exit: "Quarterly rebalance · sell on screen dropout",
      hold: "Median 180d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "marketCap", cmp: ">", value: "₹5,000 Cr" },
        { field: "beta", cmp: "<", value: "0.85" },
        { field: "ROIC", cmp: ">", value: "15%" },
        { field: "dividendYield", cmp: ">", value: "1.5%" },
        { field: "sector", cmp: "≠", value: "PSU Banks" },
      ],
    },
  },
  // ── Expanded catalog (MONEY-298 cycle-5) ────────────────────────────
  {
    id: "low-vol",
    name: "Low-volatility minimum-variance",
    description:
      "Bottom decile of trailing 90-day return volatility, rebalanced quarterly.",
    category: "Quality",
    author: "built-in",
    cagr: "+15.4%",
    sharpe: "1.46",
    maxDD: "-13.2%",
    return1Y: "+14.9%",
    winRate: "69%",
    avgHold: "120d",
    curve: [50, 51, 52, 53, 55, 57, 58, 60, 61, 63, 65, 67],
    status: "LIVE",
    tone: "vio",
    rules: {
      universe: "NIFTY 200",
      entry: "Bottom decile of vol-90d · top 25 names · equal-weight",
      exit: "Quarterly rebalance · sell on dropout",
      hold: "Median 120d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "marketCap", cmp: ">", value: "₹10,000 Cr" },
        { field: "vol-90d", cmp: "<", value: "bottom 10%" },
        { field: "drawdown-1Y", cmp: ">", value: "-15%" },
      ],
    },
  },
  {
    id: "dividend-aristocrats",
    name: "Dividend aristocrats",
    description:
      "Companies with >5 years of consecutive dividend increases. Yield-weighted top 25.",
    category: "Value",
    author: "built-in",
    cagr: "+13.8%",
    sharpe: "1.22",
    maxDD: "-15.6%",
    return1Y: "+11.4%",
    winRate: "71%",
    avgHold: "365d",
    curve: [50, 51, 53, 54, 56, 57, 59, 60, 62, 64, 65, 66],
    status: "Backtested",
    tone: "blue",
    rules: {
      universe: "NIFTY 500",
      entry: "5+ years of dividend growth · yield-weighted top 25",
      exit: "Annual rebalance · sell on dividend cut",
      hold: "Median 365d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "marketCap", cmp: ">", value: "₹5,000 Cr" },
        { field: "dividendGrowthYears", cmp: "≥", value: "5" },
        { field: "dividendYield", cmp: ">", value: "1.5%" },
        { field: "payoutRatio", cmp: "<", value: "70%" },
      ],
    },
  },
  {
    id: "52w-breakout",
    name: "52-week high breakout",
    description:
      "Long when price breaks above its 52-week high on >1.5× average volume.",
    category: "Pattern",
    author: "built-in",
    cagr: "+26.4%",
    sharpe: "1.08",
    maxDD: "-32.5%",
    return1Y: "+28.2%",
    winRate: "41%",
    avgHold: "38d",
    curve: [50, 53, 55, 58, 60, 62, 66, 70, 75, 82, 90, 98],
    status: "Backtested",
    tone: "acc",
    rules: {
      universe: "NIFTY 500",
      entry: "Close ≥ 52-week high · volume > 1.5× avg-30d",
      exit: "Stop at -8% · trail 10% from peak",
      hold: "Median 38d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "marketCap", cmp: ">", value: "₹2,000 Cr" },
        { field: "close vs 52w-high", cmp: "≥", value: "100%" },
        { field: "volume vs avg-30d", cmp: ">", value: "1.5×" },
      ],
    },
  },
  {
    id: "sector-rotation",
    name: "Sector rotation 3-2-1",
    description:
      "Top 3 sectors by 3-month relative strength · 2 stocks each · monthly rotate.",
    category: "Momentum",
    author: "built-in",
    cagr: "+20.4%",
    sharpe: "1.18",
    maxDD: "-22.8%",
    return1Y: "+22.6%",
    winRate: "56%",
    avgHold: "30d",
    curve: [50, 52, 54, 56, 60, 62, 66, 70, 74, 78, 84, 90],
    status: "LIVE",
    tone: "acc",
    rules: {
      universe: "NSE sectors",
      entry: "Top 3 sectors by 3m RS · top 2 stocks per sector by 1m return",
      exit: "Monthly rebalance · sell on sector exit",
      hold: "Median 30d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "sector RS-3m", cmp: ">", value: "top 3" },
        { field: "stock RS-1m", cmp: ">", value: "top 2 in sector" },
      ],
    },
  },
  {
    id: "deep-value",
    name: "Deep value · P/B < 1",
    description:
      "P/B < 1 · positive FCF · debt/equity < 0.4. Hold 20 names, semi-annual rebalance.",
    category: "Value",
    author: "built-in",
    cagr: "+17.2%",
    sharpe: "1.04",
    maxDD: "-21.8%",
    return1Y: "+15.8%",
    winRate: "58%",
    avgHold: "180d",
    curve: [50, 49, 51, 53, 55, 56, 59, 61, 64, 68, 72, 76],
    status: "Backtested",
    tone: "blue",
    rules: {
      universe: "NIFTY 500",
      entry: "P/B < 1 · FCF > 0 · debt/equity < 0.4 · top 20 by P/E",
      exit: "Semi-annual rebalance · sell if P/B > 2 or FCF turns negative",
      hold: "Median 180d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "marketCap", cmp: ">", value: "₹1,500 Cr" },
        { field: "P/B", cmp: "<", value: "1.0" },
        { field: "FCF margin", cmp: ">", value: "0%" },
        { field: "debt/eq", cmp: "<", value: "0.4" },
      ],
    },
  },
  {
    id: "smallcap-momentum",
    name: "Smallcap relative-strength",
    description:
      "NIFTY Smallcap 250: top decile by 6m relative strength, monthly rebalance.",
    category: "Momentum",
    author: "built-in",
    cagr: "+28.6%",
    sharpe: "1.04",
    maxDD: "-36.2%",
    return1Y: "+34.4%",
    winRate: "48%",
    avgHold: "30d",
    curve: [50, 53, 56, 58, 62, 67, 71, 76, 83, 91, 99, 108],
    status: "Backtested",
    tone: "acc",
    rules: {
      universe: "NIFTY Smallcap 250",
      entry: "Top decile by RS-6m · top 20 names · equal-weight",
      exit: "Monthly rebalance · sell on dropout",
      hold: "Median 30d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "marketCap", cmp: "<", value: "₹10,000 Cr" },
        { field: "marketCap", cmp: ">", value: "₹1,000 Cr" },
        { field: "RS-6m", cmp: ">", value: "top 10%" },
        { field: "avgVolume30d", cmp: ">", value: "₹1 Cr" },
      ],
    },
  },
  {
    id: "earnings-surprise",
    name: "Earnings beat + raise",
    description:
      "Buy stocks that beat EPS by >5% and guide higher; hold 60 days post-result.",
    category: "Pattern",
    author: "built-in",
    cagr: "+19.6%",
    sharpe: "1.12",
    maxDD: "-19.4%",
    return1Y: "+21.2%",
    winRate: "52%",
    avgHold: "60d",
    curve: [50, 52, 54, 57, 59, 62, 65, 68, 72, 76, 80, 86],
    status: "Backtested",
    tone: "vio",
    rules: {
      universe: "NIFTY 500",
      entry: "EPS beat > 5% · guidance raised · day +1 close",
      exit: "60 calendar days after result · stop at -8%",
      hold: "Median 60d",
    },
    filters: {
      op: "AND",
      items: [
        { field: "EPS surprise", cmp: ">", value: "5%" },
        { field: "guidance change", cmp: "=", value: "raised" },
        { field: "marketCap", cmp: ">", value: "₹3,000 Cr" },
      ],
    },
  },
];

export function getStrategy(id: string): StrategyMeta | null {
  return STRATEGIES.find((s) => s.id === id) ?? null;
}

export const CATEGORY_PILL: Record<StrategyCategory, string> = {
  Trend: "bg-blue-400/10 border-blue-400/30 text-blue-300",
  Momentum: "bg-emerald-400/10 border-emerald-400/30 text-emerald-300",
  Value: "bg-amber-400/10 border-amber-400/30 text-amber-300",
  Quality: "bg-cyan-400/10 border-cyan-400/30 text-cyan-300",
  "Mean-reversion": "bg-violet-400/10 border-violet-400/30 text-violet-300",
  Pattern: "bg-orange-400/10 border-orange-400/30 text-orange-300",
  Custom: "bg-rose-400/10 border-rose-400/30 text-rose-300",
};

export const STATUS_PILL: Record<StrategyStatus, string> = {
  LIVE: "bg-emerald-400/10 border-emerald-400/30 text-emerald-300",
  Backtested:
    "bg-white/[0.04] border-[var(--border-default)] text-[var(--text-dim)]",
  CUSTOM: "bg-violet-400/10 border-violet-400/30 text-violet-300",
};
