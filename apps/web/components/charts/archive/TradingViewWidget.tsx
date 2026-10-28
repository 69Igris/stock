// @ts-nocheck
"use client";

/**
 * TradingView Chart Widget - ARCHIVED
 *
 * Originally embedded TradingView's public chart via the s3.tradingview.com/tv.js
 * iframe loader. Replaced first by `klinecharts` (`AdvancedChart`) and then by
 * the proprietary TradingView Advanced Charts library wrapper
 * (`TradingViewAdvancedChart`) in MONEY-121.
 *
 * Kept here for git-history reference only - has zero live importers and is
 * type-checked off via `@ts-nocheck` to avoid conflicts with the new wrapper's
 * stricter `window.TradingView` global declaration.
 */

import { useEffect, useRef, memo } from "react";

interface TradingViewWidgetProps {
  symbol: string;
  exchange?: string;
  interval?: string;
  theme?: "dark" | "light";
  height?: number;
  autosize?: boolean;
  showToolbar?: boolean;
}

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown;
    };
  }
}

let scriptLoadPromise: Promise<void> | null = null;

function loadTradingViewScript(): Promise<void> {
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise((resolve, reject) => {
    if (window.TradingView) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/tv.js";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load TradingView"));
    document.head.appendChild(script);
  });

  return scriptLoadPromise;
}

function TradingViewWidgetComponent({
  symbol,
  exchange = "NSE",
  interval = "D",
  theme = "dark",
  height = 500,
  autosize = false,
  showToolbar = true,
}: TradingViewWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef(`tv_chart_${symbol}_${Date.now()}`);

  useEffect(() => {
    if (!containerRef.current) return;

    // Generate a unique container id for this widget instance
    const containerId = widgetId.current;
    containerRef.current.id = containerId;
    containerRef.current.innerHTML = "";

    let cancelled = false;

    loadTradingViewScript().then(() => {
      if (cancelled || !window.TradingView || !containerRef.current) return;

      new window.TradingView.widget({
        symbol: `${exchange}:${symbol}`,
        interval,
        timezone: "Asia/Kolkata",
        theme,
        style: "1",
        locale: "in",
        toolbar_bg: theme === "dark" ? "#1e1e2d" : "#f1f3f6",
        enable_publishing: false,
        allow_symbol_change: false,
        hide_top_toolbar: !showToolbar,
        hide_legend: false,
        save_image: true,
        container_id: containerId,
        ...(autosize ? { autosize: true } : { width: "100%", height }),
      });
    });

    return () => {
      cancelled = true;
    };
  }, [symbol, exchange, interval, theme, height, autosize, showToolbar]);

  return (
    <div
      ref={containerRef}
      style={
        autosize
          ? { height: "100%", width: "100%" }
          : { height: `${height}px`, width: "100%" }
      }
    />
  );
}

const TradingViewWidget = memo(TradingViewWidgetComponent);
TradingViewWidget.displayName = "TradingViewWidget";

export default TradingViewWidget;
export { TradingViewWidget };
export type { TradingViewWidgetProps };
