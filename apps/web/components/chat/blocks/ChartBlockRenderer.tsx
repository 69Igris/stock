"use client";

import { lazy, memo, Suspense } from "react";
import type { ChartBlock } from "@usemoney/types";
import { stripRecommendationLanguage } from "@usemoney/utils/sanitize-recommendation";
import {
  PfLinePlaceholder,
  PfBarsPlaceholder,
  PfTradingViewPlaceholder,
  PfPiePlaceholder,
} from "@/components/playful/placeholders";
import "./chat-blocks.css";

const LazyChart = lazy(() => import("./ChartBlockInner"));
// MONEY-650 (B3): the proprietary TradingView Advanced Charts wrapper (~22KB
// + next/script + next-themes + DelayedDataNote + UDF datafeed glue) was
// statically imported, so it sat in the EAGER chat bundle and parsed on every
// chat render even when no chart was shown — holding the page. Lazy-load it
// like the Recharts inner chart so it becomes a separate on-demand chunk
// behind the existing Suspense + PfTradingViewPlaceholder fallback. Both chart
// paths are now code-split.
const LazyTradingViewChart = lazy(() =>
  import("@/components/charts/TradingViewAdvancedChart").then((m) => ({
    default: m.TradingViewAdvancedChart,
  }))
);

interface ChartBlockRendererProps {
  block: ChartBlock;
}

/** Pick a skeleton that matches the chart type while lazy-loading. */
function ChartFallback({
  chartType,
  height,
}: {
  chartType: string;
  height: number;
}) {
  if (chartType === "tradingview") {
    return <PfTradingViewPlaceholder height={height} loading />;
  }
  if (chartType === "bar") {
    return <PfBarsPlaceholder height={height} loading />;
  }
  if (chartType === "pie") {
    return <PfPiePlaceholder height={height} loading />;
  }
  // area / line — default
  return <PfLinePlaceholder height={height} loading />;
}

/**
 * Internal stock chart using TradingViewAdvancedChart.
 * Accepts "NSE:TCS" or "BSE:HDFCBANK" from the AI and splits into props.
 *
 * MONEY-587 (C2): memoized so a re-render of the surrounding chat message (which
 * happens continuously while other turns stream / polls tick) cannot re-run this
 * wrapper and re-mount the underlying widget. Props are primitives (symbol +
 * height), so the shallow memo compare holds across renders.
 */
const StockChartEmbed = memo(function StockChartEmbed({
  symbol,
  height = 400,
}: {
  symbol: string;
  height?: number;
}) {
  const parts = symbol.split(":");
  const exchange = (parts.length > 1 ? parts[0] : "NSE") as "NSE" | "BSE";
  const cleanSymbol = parts.length > 1 ? parts[1]! : parts[0]!;

  return (
    <LazyTradingViewChart
      symbol={cleanSymbol}
      exchange={exchange}
      height={height}
    />
  );
});

export default function ChartBlockRenderer({ block }: ChartBlockRendererProps) {
  const isTradingView = block.chartType === "tradingview" && block.symbol;
  const chartHeight = isTradingView ? 400 : (block.height ?? 200);

  return (
    <div style={{ margin: "6px 0" }}>
      {/* Title / subtitle row */}
      {block.title && (
        <div className="cb-chart-header">
          <span className="cb-chart-title">{block.title}</span>
          {block.subtitle && (
            <span className="cb-chart-sub-badge">
              {stripRecommendationLanguage(block.subtitle)}
            </span>
          )}
        </div>
      )}

      {/* Chart box */}
      <div className="cb-chart-box" style={{ height: chartHeight }}>
        <Suspense
          fallback={
            <ChartFallback
              chartType={block.chartType ?? "line"}
              height={chartHeight}
            />
          }
        >
          {isTradingView ? (
            // MONEY-587 (C2): a STABLE key tied to the symbol keeps this exact
            // chart subtree mounted across chat re-renders, so the proprietary
            // TradingView widget (and its UDF datafeed subscription) is built
            // once instead of being torn down + recreated on every list
            // re-render — the cause of the /api/market/udf/history request
            // flood and the chart never settling on its bars.
            <StockChartEmbed
              key={`tv:${block.symbol!}`}
              symbol={block.symbol!}
              height={chartHeight}
            />
          ) : (
            <LazyChart block={block} />
          )}
        </Suspense>
      </div>
    </div>
  );
}
