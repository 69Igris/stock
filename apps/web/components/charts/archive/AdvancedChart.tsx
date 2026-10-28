"use client";

/**
 * AdvancedChart Component
 *
 * Full-featured financial chart using KLineChart (klinecharts v9).
 * Supports candlestick/area, 80+ indicators, drawing tools, and multi-timeframe.
 * No external auth or API keys required - fully open source (Apache 2.0).
 *
 * Features a TradingView-style toolbar with integrated period selector,
 * indicators dropdown, drawing tools, and chart type toggle.
 */

import { useEffect, useRef, useCallback, useState, memo } from "react";
import { init, dispose, type Chart, type KLineData } from "klinecharts";
import { Button } from "@usemoney/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@usemoney/ui/dropdown-menu";
import { Activity, Pencil, Trash2 } from "lucide-react";

// ============== TYPES ==============

export interface PeriodOption {
  label: string;
  period: string;
  interval: string;
}

export interface AdvancedChartProps {
  /** Symbol name for display */
  symbol: string;
  /** Exchange for display */
  exchange?: string;
  /** OHLCV data array */
  data: ChartBarInput[];
  /** Chart height in pixels */
  height?: number;
  /** Theme */
  theme?: "dark" | "light";
  /** Loading state */
  isLoading?: boolean;
  /** Error state */
  error?: string | null;
  /** Period options for the toolbar selector */
  periods?: PeriodOption[];
  /** Currently selected period label */
  selectedPeriodLabel?: string;
  /** Callback when user selects a different period */
  onPeriodChange?: (period: PeriodOption) => void;
  /** Current data interval (e.g., "5m", "1d") - used for auto chart type */
  interval?: string;
}

export interface ChartBarInput {
  /** Time as YYYY-MM-DD string, unix timestamp, or BusinessDay object */
  time: string | number | { year: number; month: number; day: number };
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

// ============== INDICATOR CONFIG ==============

const INDICATOR_GROUPS = [
  {
    label: "Trend",
    indicators: [
      { name: "MA", label: "Moving Average" },
      { name: "EMA", label: "Exponential MA" },
      { name: "SMA", label: "Simple MA" },
      { name: "BBI", label: "Bull & Bear Index" },
      { name: "SAR", label: "Parabolic SAR" },
    ],
  },
  {
    label: "Momentum",
    indicators: [
      { name: "MACD", label: "MACD" },
      { name: "RSI", label: "RSI" },
      { name: "KDJ", label: "KDJ" },
      { name: "WR", label: "Williams %R" },
      { name: "ROC", label: "Rate of Change" },
      { name: "MTM", label: "Momentum" },
      { name: "CCI", label: "CCI" },
    ],
  },
  {
    label: "Volume",
    indicators: [
      { name: "VOL", label: "Volume" },
      { name: "OBV", label: "On Balance Volume" },
      { name: "VR", label: "Volume Ratio" },
    ],
  },
  {
    label: "Volatility",
    indicators: [
      { name: "BOLL", label: "Bollinger Bands" },
      { name: "ATR", label: "ATR" },
      { name: "DMI", label: "DMI" },
    ],
  },
];

// Main pane indicators (overlayed on candlestick)
const MAIN_INDICATORS = new Set(["MA", "EMA", "SMA", "BBI", "SAR", "BOLL"]);

const OVERLAY_TOOLS = [
  { name: "horizontalStraightLine", label: "Horizontal Line" },
  { name: "verticalStraightLine", label: "Vertical Line" },
  { name: "straightLine", label: "Trend Line" },
  { name: "rayLine", label: "Ray Line" },
  { name: "parallelStraightLine", label: "Parallel Lines" },
  { name: "fibonacciLine", label: "Fibonacci" },
  { name: "simpleAnnotation", label: "Annotation" },
];

// ============== DARK THEME STYLES ==============

const DARK_STYLES = {
  grid: {
    horizontal: {
      show: true,
      color: "#2d2d44",
    },
    vertical: {
      show: true,
      color: "#2d2d44",
    },
  },
  candle: {
    bar: {
      upColor: "#22c55e",
      downColor: "#ef4444",
      noChangeColor: "#888888",
      upBorderColor: "#22c55e",
      downBorderColor: "#ef4444",
      noChangeBorderColor: "#888888",
      upWickColor: "#22c55e",
      downWickColor: "#ef4444",
      noChangeWickColor: "#888888",
    },
    priceMark: {
      high: {
        color: "#d1d5db",
      },
      low: {
        color: "#d1d5db",
      },
      last: {
        upColor: "#22c55e",
        downColor: "#ef4444",
        noChangeColor: "#888888",
        line: {
          show: true,
          style: "dashed" as const,
          dashedValue: [4, 4],
          size: 1,
        },
        text: {
          show: true,
          color: "#ffffff",
          size: 12,
        },
      },
    },
    tooltip: {
      text: {
        color: "#d1d5db",
        size: 12,
        marginLeft: 8,
        marginTop: 6,
        marginRight: 8,
        marginBottom: 0,
      },
    },
  },
  indicator: {
    tooltip: {
      text: {
        color: "#d1d5db",
        size: 12,
        marginLeft: 8,
        marginTop: 6,
        marginRight: 8,
        marginBottom: 0,
      },
    },
  },
  xAxis: {
    axisLine: {
      color: "#2d2d44",
    },
    tickLine: {
      color: "#2d2d44",
    },
    tickText: {
      color: "#9ca3af",
      size: 11,
    },
  },
  yAxis: {
    axisLine: {
      color: "#2d2d44",
    },
    tickLine: {
      color: "#2d2d44",
    },
    tickText: {
      color: "#9ca3af",
      size: 11,
    },
  },
  separator: {
    color: "#2d2d44",
  },
  crosshair: {
    horizontal: {
      line: {
        color: "#6b7280",
        style: "dashed" as const,
        dashedValue: [4, 4],
        size: 1,
      },
      text: {
        color: "#ffffff",
        backgroundColor: "#374151",
        borderColor: "#4b5563",
        size: 12,
      },
    },
    vertical: {
      line: {
        color: "#6b7280",
        style: "dashed" as const,
        dashedValue: [4, 4],
        size: 1,
      },
      text: {
        color: "#ffffff",
        backgroundColor: "#374151",
        borderColor: "#4b5563",
        size: 12,
      },
    },
  },
};

const LIGHT_STYLES = {
  grid: {
    horizontal: { show: true, color: "#e5e7eb" },
    vertical: { show: true, color: "#e5e7eb" },
  },
  candle: {
    bar: {
      upColor: "#22c55e",
      downColor: "#ef4444",
      noChangeColor: "#888888",
      upBorderColor: "#22c55e",
      downBorderColor: "#ef4444",
      noChangeBorderColor: "#888888",
      upWickColor: "#22c55e",
      downWickColor: "#ef4444",
      noChangeWickColor: "#888888",
    },
  },
  xAxis: {
    axisLine: { color: "#e5e7eb" },
    tickLine: { color: "#e5e7eb" },
    tickText: { color: "#6b7280", size: 11 },
  },
  yAxis: {
    axisLine: { color: "#e5e7eb" },
    tickLine: { color: "#e5e7eb" },
    tickText: { color: "#6b7280", size: 11 },
  },
  separator: { color: "#e5e7eb" },
  crosshair: {
    horizontal: { text: { color: "#ffffff", backgroundColor: "#374151" } },
    vertical: { text: { color: "#ffffff", backgroundColor: "#374151" } },
  },
};

// ============== HELPERS ==============

function toKLineData(bars: ChartBarInput[]): KLineData[] {
  return bars.map((bar) => {
    let timestamp: number;
    if (typeof bar.time === "number") {
      // Already a unix timestamp (seconds) - convert to ms
      timestamp = bar.time < 1e12 ? bar.time * 1000 : bar.time;
    } else if (typeof bar.time === "string") {
      // YYYY-MM-DD string
      timestamp = new Date(bar.time).getTime();
    } else {
      // BusinessDay object { year, month, day }
      timestamp = new Date(
        bar.time.year,
        bar.time.month - 1,
        bar.time.day
      ).getTime();
    }
    return {
      timestamp,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      volume: bar.volume ?? 0,
    };
  });
}

// Pane ID tracking for sub-pane indicators
const PANE_PREFIX = "pane_";

// ============== COMPONENT ==============

function AdvancedChartComponent({
  symbol,
  exchange = "NSE",
  data,
  height = 500,
  theme = "dark",
  isLoading = false,
  error = null,
  periods,
  selectedPeriodLabel,
  onPeriodChange,
  interval,
}: AdvancedChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const [activeIndicators, setActiveIndicators] = useState<string[]>(["VOL"]);
  // Track pane IDs for sub-pane indicators so we can remove them
  const paneIdMap = useRef<Record<string, string>>({});

  // Initialize chart
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = init(container, {
      locale: "en",
      timezone: "Asia/Kolkata",
      styles: theme === "dark" ? DARK_STYLES : LIGHT_STYLES,
    });

    if (chart) {
      chartRef.current = chart;
      chart.setPriceVolumePrecision(2, 0);

      // Add default volume indicator in its own pane
      const volPaneId = chart.createIndicator("VOL", false, {
        id: `${PANE_PREFIX}vol`,
      });
      if (volPaneId) {
        paneIdMap.current["VOL"] = volPaneId;
      }
    }

    return () => {
      dispose(container);
      chartRef.current = null;
      paneIdMap.current = {};
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  // Update data when it changes
  useEffect(() => {
    if (!chartRef.current) return;
    // Clear existing data first to avoid stale rendering
    chartRef.current.clearData();
    if (data.length === 0) return;
    const klineData = toKLineData(data);
    chartRef.current.applyNewData(klineData);
    // Scroll to show latest data
    chartRef.current.scrollToRealTime();
  }, [data]);

  // Handle resize
  useEffect(() => {
    const handleResize = () => {
      chartRef.current?.resize();
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Add/remove indicator
  const toggleIndicator = useCallback((name: string) => {
    if (!chartRef.current) return;

    setActiveIndicators((prev) => {
      if (prev.includes(name)) {
        // Remove indicator
        if (MAIN_INDICATORS.has(name)) {
          // Main pane indicator - remove by pane "candle_pane" + name
          chartRef.current!.removeIndicator("candle_pane", name);
        } else {
          // Sub-pane indicator - remove entire pane
          const paneId = paneIdMap.current[name];
          if (paneId) {
            chartRef.current!.removeIndicator(paneId, name);
            delete paneIdMap.current[name];
          }
        }
        return prev.filter((i) => i !== name);
      }

      // Add indicator
      if (MAIN_INDICATORS.has(name)) {
        chartRef.current!.createIndicator(name, true);
      } else {
        const paneId = chartRef.current!.createIndicator(name, false, {
          id: `${PANE_PREFIX}${name.toLowerCase()}`,
        });
        if (paneId) {
          paneIdMap.current[name] = paneId;
        }
      }
      return [...prev, name];
    });
  }, []);

  // Add drawing overlay
  const addOverlay = useCallback((name: string) => {
    if (!chartRef.current) return;
    chartRef.current.createOverlay(name);
  }, []);

  // Clear all overlays
  const clearOverlays = useCallback(() => {
    if (!chartRef.current) return;
    chartRef.current.removeOverlay();
  }, []);

  const isDark = theme === "dark";

  return (
    <div className="relative">
      {/* Toolbar */}
      <div
        className={`flex items-center gap-1 px-3 py-2 border-b ${
          isDark ? "bg-[#1a1a2e] border-[#2d2d44]" : "bg-white border-gray-200"
        }`}
      >
        {/* Symbol badge */}
        <span
          className={`font-semibold text-sm mr-2 ${
            isDark ? "text-foreground" : "text-gray-900"
          }`}
        >
          {symbol}
          <span
            className={`ml-1 text-xs ${
              isDark ? "text-gray-400" : "text-gray-500"
            }`}
          >
            {exchange}
          </span>
        </span>

        {/* Separator */}
        {periods && periods.length > 0 && (
          <div
            className={`w-px h-5 mx-1 ${
              isDark ? "bg-[#2d2d44]" : "bg-gray-200"
            }`}
          />
        )}

        {/* Period selector (TradingView-style) */}
        {periods &&
          periods.map((p) => (
            <button
              key={p.label}
              onClick={() => onPeriodChange?.(p)}
              className={`px-2 py-0.5 text-xs font-medium rounded transition-colors ${
                selectedPeriodLabel === p.label
                  ? isDark
                    ? "bg-blue-500/20 text-blue-400"
                    : "bg-blue-50 text-blue-600"
                  : isDark
                    ? "text-gray-400 hover:text-gray-200 hover:bg-accent/50"
                    : "text-gray-500 hover:text-gray-800 hover:bg-gray-100"
              }`}
            >
              {p.label}
            </button>
          ))}

        {/* Separator */}
        {periods && periods.length > 0 && (
          <div
            className={`w-px h-5 mx-1 ${
              isDark ? "bg-[#2d2d44]" : "bg-gray-200"
            }`}
          />
        )}

        {/* Indicators dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={`h-7 text-xs ${
                isDark
                  ? "text-gray-300 hover:bg-accent"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              <Activity className="h-3.5 w-3.5 mr-1" />
              Indicators
              {activeIndicators.length > 1 && (
                <span className="ml-1 text-[10px] bg-blue-500/20 text-blue-400 px-1 rounded">
                  {activeIndicators.length}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className={
              isDark ? "bg-card border-border" : "bg-white border-gray-200"
            }
          >
            {INDICATOR_GROUPS.map((group) => (
              <DropdownMenuSub key={group.label}>
                <DropdownMenuSubTrigger
                  className={
                    isDark ? "text-gray-300 focus:bg-muted" : "text-gray-700"
                  }
                >
                  {group.label}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent
                  className={
                    isDark
                      ? "bg-card border-border"
                      : "bg-white border-gray-200"
                  }
                >
                  {group.indicators.map((ind) => (
                    <DropdownMenuItem
                      key={ind.name}
                      onClick={() => toggleIndicator(ind.name)}
                      className={`${
                        isDark
                          ? "text-gray-300 focus:bg-muted"
                          : "text-gray-700"
                      } ${
                        activeIndicators.includes(ind.name)
                          ? "text-blue-400"
                          : ""
                      }`}
                    >
                      {activeIndicators.includes(ind.name) ? "✓ " : ""}
                      {ind.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Drawing tools dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className={`h-7 text-xs ${
                isDark
                  ? "text-gray-300 hover:bg-accent"
                  : "text-gray-600 hover:bg-gray-100"
              }`}
            >
              <Pencil className="h-3.5 w-3.5 mr-1" />
              Draw
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className={
              isDark ? "bg-card border-border" : "bg-white border-gray-200"
            }
          >
            {OVERLAY_TOOLS.map((tool) => (
              <DropdownMenuItem
                key={tool.name}
                onClick={() => addOverlay(tool.name)}
                className={
                  isDark ? "text-gray-300 focus:bg-muted" : "text-gray-700"
                }
              >
                {tool.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Clear drawings */}
        <Button
          variant="ghost"
          size="sm"
          onClick={clearOverlays}
          className={`h-7 text-xs ${
            isDark
              ? "text-gray-300 hover:bg-accent"
              : "text-gray-600 hover:bg-gray-100"
          }`}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" />
          Clear
        </Button>
      </div>

      {/* Chart container */}
      <div
        ref={containerRef}
        style={{
          height: `${height}px`,
          backgroundColor: isDark ? "#1a1a2e" : "#ffffff",
        }}
      />

      {/* Loading overlay */}
      {isLoading && (
        <div
          className={`absolute inset-0 flex items-center justify-center ${
            isDark ? "bg-[#1a1a2e]/80" : "bg-white/80"
          }`}
        >
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
            <span
              className={`text-sm ${
                isDark ? "text-gray-400" : "text-gray-500"
              }`}
            >
              Loading chart data...
            </span>
            <span
              className={`text-xs ${
                isDark ? "text-gray-500" : "text-gray-400"
              }`}
            >
              Fetching historical prices
            </span>
          </div>
        </div>
      )}

      {/* Error overlay */}
      {error && (
        <div
          className={`absolute inset-0 flex items-center justify-center ${
            isDark ? "bg-[#1a1a2e]/90" : "bg-white/90"
          }`}
        >
          <div className="text-center">
            <p className="text-red-500 font-medium mb-2">
              Failed to load chart
            </p>
            <p
              className={`text-sm ${
                isDark ? "text-gray-400" : "text-gray-500"
              }`}
            >
              {error}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

const AdvancedChart = memo(AdvancedChartComponent);
AdvancedChart.displayName = "AdvancedChart";

export default AdvancedChart;
export { AdvancedChart };
