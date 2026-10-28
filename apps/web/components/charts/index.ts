/**
 * Chart Components
 *
 * The chart wrapper used everywhere on stock/MF/ETF/paper-trading/chat-embed
 * surfaces is `TradingViewAdvancedChart` - a thin wrapper around the
 * TradingView Advanced Charts library v31.0.0 (proprietary, licensed per
 * project). Backed by the /api/market/udf/* UDF backend.
 *
 * The legacy `TradingChart` (lightweight-charts) and `AdvancedChart`
 * (klinecharts) components live under `./archive/` after MONEY-121 - they
 * are NOT exported from the barrel and have NO live consumers. The
 * `klinecharts` and `lightweight-charts` deps are kept in package.json for
 * one release cycle so a fast revert is trivial; they will be removed in
 * a follow-up PR after the soak period.
 */

export { TradingViewAdvancedChart } from "./TradingViewAdvancedChart";
export type {
  TradingViewAdvancedChartProps,
  TVChartType,
} from "./TradingViewAdvancedChart";

// Sparkline - 30-line SVG for list-view trend indicators (MONEY-199)
export { Sparkline, autoTone } from "./Sparkline";
export type { SparklineProps, SparklineTone } from "./Sparkline";
