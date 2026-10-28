"use client";

/**
 * TradingChart Component
 *
 * Full-featured trading chart using TradingView Lightweight Charts.
 * Supports candlestick, volume, technical indicators, and real-time updates.
 */

import React, {
  useEffect,
  useRef,
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  createChart,
  IChartApi,
  ISeriesApi,
  CandlestickData,
  HistogramData,
  LineData,
  Time,
  ColorType,
  CrosshairMode,
  CandlestickSeries,
  HistogramSeries,
} from "lightweight-charts";
import { cn } from "@usemoney/ui";

// ============== TYPES ==============

export type TimeInterval = "1m" | "5m" | "15m" | "1h" | "1d" | "1w";

export interface ChartBar {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface TradingChartProps {
  /** Symbol to display */
  symbol: string;
  /** Exchange (NSE or BSE) */
  exchange?: "NSE" | "BSE";
  /** Time interval */
  interval?: TimeInterval;
  /** Chart data */
  data?: ChartBar[];
  /** Show volume histogram */
  showVolume?: boolean;
  /** Chart height in pixels */
  height?: number;
  /** Enable crosshair */
  showCrosshair?: boolean;
  /** Theme (light or dark) */
  theme?: "light" | "dark";
  /** Callback when price updates */
  onPriceUpdate?: (price: number) => void;
  /** Callback when crosshair moves */
  onCrosshairMove?: (data: ChartBar | null) => void;
  /** Additional CSS classes */
  className?: string;
  /** Loading state */
  isLoading?: boolean;
  /** Error state */
  error?: string | null;
}

export interface TradingChartRef {
  chart: IChartApi | null;
  updateData: (data: ChartBar[]) => void;
  addBar: (bar: ChartBar) => void;
  updateLastBar: (bar: ChartBar) => void;
  fitContent: () => void;
  scrollToRealtime: () => void;
}

// ============== THEME CONFIGURATION ==============

const THEMES = {
  light: {
    background: "#ffffff",
    text: "#333333",
    grid: "#e0e0e0",
    crosshair: "#888888",
    upColor: "#22c55e",
    downColor: "#ef4444",
    volumeUp: "rgba(34, 197, 94, 0.5)",
    volumeDown: "rgba(239, 68, 68, 0.5)",
  },
  dark: {
    background: "#1a1a2e",
    text: "#d1d5db",
    grid: "#2d2d44",
    crosshair: "#6b7280",
    upColor: "#22c55e",
    downColor: "#ef4444",
    volumeUp: "rgba(34, 197, 94, 0.5)",
    volumeDown: "rgba(239, 68, 68, 0.5)",
  },
};

// ============== COMPONENT ==============

export const TradingChart = forwardRef<TradingChartRef, TradingChartProps>(
  (
    {
      symbol,
      exchange = "NSE",
      interval = "1d",
      data = [],
      showVolume = true,
      height = 400,
      showCrosshair = true,
      theme = "dark",
      onPriceUpdate,
      onCrosshairMove,
      className,
      isLoading = false,
      error = null,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candlestickSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
    const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
    const [currentPrice, setCurrentPrice] = useState<number | null>(null);
    const [priceChange, setPriceChange] = useState<{
      value: number;
      percent: number;
    } | null>(null);

    const colors = THEMES[theme];

    // ============== CHART INITIALIZATION ==============

    useEffect(() => {
      if (!containerRef.current) return;

      // Create chart
      const chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: showVolume ? height : height - 50,
        layout: {
          background: { type: ColorType.Solid, color: colors.background },
          textColor: colors.text,
        },
        grid: {
          vertLines: { color: colors.grid },
          horzLines: { color: colors.grid },
        },
        crosshair: {
          mode: showCrosshair ? CrosshairMode.Normal : CrosshairMode.Hidden,
          vertLine: {
            color: colors.crosshair,
            width: 1,
            style: 2,
            labelVisible: true,
          },
          horzLine: {
            color: colors.crosshair,
            width: 1,
            style: 2,
            labelVisible: true,
          },
        },
        rightPriceScale: {
          borderColor: colors.grid,
          scaleMargins: {
            top: 0.1,
            bottom: showVolume ? 0.25 : 0.1,
          },
        },
        timeScale: {
          borderColor: colors.grid,
          timeVisible: true,
          secondsVisible: interval === "1m",
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false,
        },
        handleScale: {
          axisPressedMouseMove: true,
          mouseWheel: true,
          pinch: true,
        },
      });

      chartRef.current = chart;

      // Create candlestick series
      const candlestickSeries = chart.addSeries(CandlestickSeries, {
        upColor: colors.upColor,
        downColor: colors.downColor,
        borderUpColor: colors.upColor,
        borderDownColor: colors.downColor,
        wickUpColor: colors.upColor,
        wickDownColor: colors.downColor,
      });

      candlestickSeriesRef.current = candlestickSeries;

      // Create volume series if enabled
      if (showVolume) {
        const volumeSeries = chart.addSeries(HistogramSeries, {
          color: colors.volumeUp,
          priceFormat: {
            type: "volume",
          },
          priceScaleId: "volume",
        });

        volumeSeries.priceScale().applyOptions({
          scaleMargins: {
            top: 0.8,
            bottom: 0,
          },
        });

        volumeSeriesRef.current = volumeSeries;
      }

      // Crosshair move handler
      chart.subscribeCrosshairMove((param) => {
        if (!param.time || !param.seriesData.size) {
          onCrosshairMove?.(null);
          return;
        }

        const candleData = param.seriesData.get(
          candlestickSeries
        ) as CandlestickData;
        if (candleData) {
          onCrosshairMove?.({
            time: candleData.time,
            open: candleData.open,
            high: candleData.high,
            low: candleData.low,
            close: candleData.close,
          });
        }
      });

      // Handle resize
      const handleResize = () => {
        if (containerRef.current) {
          chart.applyOptions({
            width: containerRef.current.clientWidth,
          });
        }
      };

      window.addEventListener("resize", handleResize);

      return () => {
        window.removeEventListener("resize", handleResize);
        chart.remove();
        chartRef.current = null;
        candlestickSeriesRef.current = null;
        volumeSeriesRef.current = null;
      };
    }, [
      height,
      showVolume,
      showCrosshair,
      theme,
      colors,
      interval,
      onCrosshairMove,
    ]);

    // ============== DATA UPDATES ==============

    useEffect(() => {
      if (!candlestickSeriesRef.current || data.length === 0) return;

      // Format data for candlestick series
      const candlestickData: CandlestickData[] = data.map((bar) => ({
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      }));

      candlestickSeriesRef.current.setData(candlestickData);

      // Format data for volume series
      if (volumeSeriesRef.current && showVolume) {
        const volumeData: HistogramData[] = data.map((bar) => ({
          time: bar.time,
          value: bar.volume || 0,
          color: bar.close >= bar.open ? colors.volumeUp : colors.volumeDown,
        }));

        volumeSeriesRef.current.setData(volumeData);
      }

      // Update current price
      if (data.length > 0) {
        const lastBar = data[data.length - 1];
        setCurrentPrice(lastBar.close);
        onPriceUpdate?.(lastBar.close);

        // Calculate change from first bar
        const firstBar = data[0];
        const change = lastBar.close - firstBar.open;
        const changePercent = (change / firstBar.open) * 100;
        setPriceChange({ value: change, percent: changePercent });
      }

      // Fit content to view
      chartRef.current?.timeScale().fitContent();
    }, [data, showVolume, colors, onPriceUpdate]);

    // ============== IMPERATIVE HANDLE ==============

    useImperativeHandle(ref, () => ({
      chart: chartRef.current,

      updateData: (newData: ChartBar[]) => {
        if (!candlestickSeriesRef.current) return;

        const candlestickData: CandlestickData[] = newData.map((bar) => ({
          time: bar.time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        }));

        candlestickSeriesRef.current.setData(candlestickData);

        if (volumeSeriesRef.current && showVolume) {
          const volumeData: HistogramData[] = newData.map((bar) => ({
            time: bar.time,
            value: bar.volume || 0,
            color: bar.close >= bar.open ? colors.volumeUp : colors.volumeDown,
          }));

          volumeSeriesRef.current.setData(volumeData);
        }
      },

      addBar: (bar: ChartBar) => {
        if (!candlestickSeriesRef.current) return;

        candlestickSeriesRef.current.update({
          time: bar.time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        });

        if (volumeSeriesRef.current && showVolume) {
          volumeSeriesRef.current.update({
            time: bar.time,
            value: bar.volume || 0,
            color: bar.close >= bar.open ? colors.volumeUp : colors.volumeDown,
          });
        }

        setCurrentPrice(bar.close);
        onPriceUpdate?.(bar.close);
      },

      updateLastBar: (bar: ChartBar) => {
        if (!candlestickSeriesRef.current) return;

        candlestickSeriesRef.current.update({
          time: bar.time,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
        });

        if (volumeSeriesRef.current && showVolume) {
          volumeSeriesRef.current.update({
            time: bar.time,
            value: bar.volume || 0,
            color: bar.close >= bar.open ? colors.volumeUp : colors.volumeDown,
          });
        }

        setCurrentPrice(bar.close);
        onPriceUpdate?.(bar.close);
      },

      fitContent: () => {
        chartRef.current?.timeScale().fitContent();
      },

      scrollToRealtime: () => {
        chartRef.current?.timeScale().scrollToRealTime();
      },
    }));

    // ============== RENDER ==============

    return (
      <div className={cn("trading-chart relative", className)}>
        {/* Header */}
        <div
          className={cn(
            "flex items-center justify-between px-4 py-2 border-b",
            theme === "dark"
              ? "bg-[#1a1a2e] border-gray-700"
              : "bg-white border-gray-200"
          )}
        >
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "font-semibold text-lg",
                theme === "dark" ? "text-foreground" : "text-gray-900"
              )}
            >
              {symbol}
            </span>
            <span
              className={cn(
                "text-sm",
                theme === "dark" ? "text-gray-400" : "text-gray-500"
              )}
            >
              {exchange}
            </span>
          </div>

          {currentPrice && (
            <div className="flex items-center gap-3">
              <span
                className={cn(
                  "font-mono text-lg font-semibold",
                  theme === "dark" ? "text-foreground" : "text-gray-900"
                )}
              >
                ₹
                {currentPrice.toLocaleString("en-IN", {
                  minimumFractionDigits: 2,
                })}
              </span>
              {priceChange && (
                <span
                  className={cn(
                    "text-sm font-medium",
                    priceChange.value >= 0 ? "text-green-500" : "text-red-500"
                  )}
                >
                  {priceChange.value >= 0 ? "+" : ""}
                  {priceChange.value.toFixed(2)} (
                  {priceChange.value >= 0 ? "+" : ""}
                  {priceChange.percent.toFixed(2)}%)
                </span>
              )}
            </div>
          )}
        </div>

        {/* Chart Container */}
        <div
          ref={containerRef}
          className="chart-container"
          style={{ height: `${height}px` }}
        />

        {/* Loading Overlay */}
        {isLoading && (
          <div
            className={cn(
              "absolute inset-0 flex items-center justify-center",
              theme === "dark" ? "bg-[#1a1a2e]/80" : "bg-white/80"
            )}
          >
            <div className="flex flex-col items-center gap-2">
              <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span
                className={cn(
                  "text-sm",
                  theme === "dark" ? "text-gray-400" : "text-gray-500"
                )}
              >
                Loading chart data...
              </span>
            </div>
          </div>
        )}

        {/* Error Overlay */}
        {error && (
          <div
            className={cn(
              "absolute inset-0 flex items-center justify-center",
              theme === "dark" ? "bg-[#1a1a2e]/90" : "bg-white/90"
            )}
          >
            <div className="text-center">
              <p className="text-red-500 font-medium mb-2">
                Failed to load chart
              </p>
              <p
                className={cn(
                  "text-sm",
                  theme === "dark" ? "text-gray-400" : "text-gray-500"
                )}
              >
                {error}
              </p>
            </div>
          </div>
        )}
      </div>
    );
  }
);

TradingChart.displayName = "TradingChart";

export default TradingChart;
