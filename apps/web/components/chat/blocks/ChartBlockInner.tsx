"use client";

import type React from "react";
import type { ChartBlock } from "@usemoney/types";
import {
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { formatChatCurrency, formatChatNumber } from "@/lib/chat/format-utils";
import EditorialCandleChart, {
  ChartEmpty,
  deriveCandleData,
  buildMovingAverages,
} from "./EditorialCandleChart";
import "./chat-blocks.css";

/** Recharts chart types that render via the recharts pipeline below. */
const RECHARTS_TYPES = new Set(["area", "line", "bar", "pie"]);

/** True when every row carries open/high/low/close fields (OHLC candles). */
function isOhlcData(data: Record<string, unknown>[]): boolean {
  const has = (row: Record<string, unknown>, short: string, long: string) =>
    short in row ||
    short.toUpperCase() in row ||
    long in row ||
    long.charAt(0).toUpperCase() + long.slice(1) in row;
  return data.every(
    (row) =>
      has(row, "o", "open") &&
      has(row, "h", "high") &&
      has(row, "l", "low") &&
      has(row, "c", "close")
  );
}

/* Playful palette — emerald first, then pop-* accents */
const DEFAULT_COLORS = [
  "var(--emerald)",
  "var(--pop-3)", // blue
  "var(--pop-2)", // gold
  "var(--pop-1)", // coral
  "var(--pop-5)", // violet
  "var(--pop-4)", // pink
];

/* Fallback hex values used where recharts needs a non-CSS-var string at
   serialisation time (gradient stopColor). These mirror the dark-mode
   values so charts look acceptable on both themes at first render. */
const FALLBACK_HEX = [
  "#34d399",
  "#60a5fa",
  "#fcd34d",
  "#ff8a5b",
  "#c4b5fd",
  "#f9a8d4",
];

interface ChartBlockInnerProps {
  block: ChartBlock;
}

function formatTickValue(value: number, format?: string): string {
  switch (format) {
    case "currency":
      if (value >= 10000000) return `₹${(value / 10000000).toFixed(1)}Cr`;
      if (value >= 100000) return `₹${(value / 100000).toFixed(1)}L`;
      if (value >= 1000) return `₹${(value / 1000).toFixed(0)}K`;
      return `₹${value}`;
    case "percentage":
      return `${value}%`;
    default:
      return formatChatNumber(value);
  }
}

export default function ChartBlockInner({ block }: ChartBlockInnerProps) {
  const data = block.data;

  // No usable data → editorial "No price data available" pane. This is the
  // non-TradingView empty state (TradingView empties are handled upstream by
  // the proprietary widget in ChartBlockRenderer).
  if (!data || data.length === 0) {
    return <ChartEmpty />;
  }

  // ── Editorial candlestick (light) render path ──────────────────────────
  // This is the default, non-TradingView price chart from the StockSage
  // design. It is used when the data is OHLC-shaped (candles), or when the
  // chartType is a non-recharts value. The real TradingView Advanced Charts
  // widget remains the primary `tradingview` source (rendered separately in
  // ChartBlockRenderer).
  const wantsEditorial =
    (block.chartType && !RECHARTS_TYPES.has(block.chartType)) ||
    isOhlcData(data);
  if (wantsEditorial) {
    const primaryKey = block.yKeys?.[0]?.key;
    const volumeKey = block.yKeys?.find((k) => /vol/i.test(k.key))?.key;
    const derived = deriveCandleData(data, primaryKey, volumeKey);
    if (!derived) {
      return <ChartEmpty />;
    }

    // Explicit MA overlays from the data win; otherwise synthesise SMAs.
    const overlayKeys = (block.yKeys ?? []).filter(
      (k, i) => i > 0 && !/vol/i.test(k.key)
    );
    const overlays =
      overlayKeys.length > 0
        ? overlayKeys.map((k, i) => ({
            name: k.label,
            color: k.color || DEFAULT_COLORS[(i + 1) % DEFAULT_COLORS.length]!,
            data: data.map((row) => {
              const v = row[k.key];
              return typeof v === "number" ? v : Number(v) || 0;
            }),
          }))
        : buildMovingAverages(derived.series);

    const height = block.height ?? 200;
    return (
      <EditorialCandleChart
        series={derived.series}
        overlays={overlays}
        height={height}
      />
    );
  }

  if (!block.yKeys || !block.xKey) {
    return null;
  }

  const primaryFormat = block.yKeys[0]?.format;

  const tooltipFormatter: (
    value: string | number | undefined,
    name: string | undefined,
    item: unknown,
    index: number
  ) => [React.ReactNode, string] = (value, name) => {
    const numValue = typeof value === "number" ? value : Number(value) || 0;
    const label = name ?? "";
    const yKey = block.yKeys?.find((k) => k.key === label || k.label === label);
    switch (yKey?.format) {
      case "currency":
        return [formatChatCurrency(numValue), yKey.label];
      case "pnl":
        return [
          `${numValue >= 0 ? "+" : ""}${formatChatCurrency(numValue)}`,
          yKey.label,
        ];
      case "percentage":
        return [`${numValue.toFixed(2)}%`, yKey.label];
      default:
        return [formatChatNumber(numValue), yKey?.label || label];
    }
  };

  const commonProps = {
    data,
    margin: { top: 5, right: 10, left: 0, bottom: 5 },
  };

  const axisProps = {
    xAxis: (
      <XAxis
        dataKey={block.xKey}
        stroke="var(--ink-4)"
        tick={{ fontSize: 10, fill: "var(--ink-3)" }}
        tickLine={false}
        axisLine={false}
      />
    ),
    yAxis: (
      <YAxis
        stroke="var(--ink-4)"
        tick={{ fontSize: 10, fill: "var(--ink-3)" }}
        tickLine={false}
        axisLine={false}
        tickFormatter={(v) => formatTickValue(v, primaryFormat)}
        width={55}
      />
    ),
    grid: <CartesianGrid strokeDasharray="3 3" stroke="var(--rule-soft)" />,
    tooltip: (
      <Tooltip
        contentStyle={{
          backgroundColor: "var(--paper-2)",
          border: "1.5px solid var(--ink)",
          borderRadius: "8px",
          color: "var(--ink)",
          fontSize: "12px",
          fontFamily: "JetBrains Mono, monospace",
          boxShadow: "2px 2px 0 var(--ink)",
        }}
        formatter={tooltipFormatter}
      />
    ),
  };

  if (block.chartType === "area") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart {...commonProps}>
          <defs>
            {block.yKeys.map((yKey, i) => (
              <linearGradient
                key={yKey.key}
                id={`cb-gradient-${yKey.key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="5%"
                  stopColor={
                    yKey.color || FALLBACK_HEX[i % FALLBACK_HEX.length]
                  }
                  stopOpacity={0.25}
                />
                <stop
                  offset="95%"
                  stopColor={
                    yKey.color || FALLBACK_HEX[i % FALLBACK_HEX.length]
                  }
                  stopOpacity={0}
                />
              </linearGradient>
            ))}
          </defs>
          {axisProps.grid}
          {axisProps.xAxis}
          {axisProps.yAxis}
          {axisProps.tooltip}
          {block.yKeys.map((yKey, i) => (
            <Area
              key={yKey.key}
              type="monotone"
              dataKey={yKey.key}
              stroke={yKey.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              fill={`url(#cb-gradient-${yKey.key})`}
              strokeWidth={2}
              name={yKey.label}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  if (block.chartType === "line") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <LineChart {...commonProps}>
          {axisProps.grid}
          {axisProps.xAxis}
          {axisProps.yAxis}
          {axisProps.tooltip}
          {block.yKeys.map((yKey, i) => (
            <Line
              key={yKey.key}
              type="monotone"
              dataKey={yKey.key}
              stroke={yKey.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              strokeWidth={2}
              dot={false}
              name={yKey.label}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (block.chartType === "bar") {
    return (
      <ResponsiveContainer width="100%" height="100%">
        <BarChart {...commonProps}>
          {axisProps.grid}
          {axisProps.xAxis}
          {axisProps.yAxis}
          {axisProps.tooltip}
          {block.yKeys.map((yKey, i) => (
            <Bar
              key={yKey.key}
              dataKey={yKey.key}
              fill={yKey.color || DEFAULT_COLORS[i % DEFAULT_COLORS.length]}
              radius={[4, 4, 0, 0]}
              name={yKey.label}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (block.chartType === "pie") {
    const dataKey = block.yKeys[0]?.key || "value";
    return (
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            outerRadius={70}
            innerRadius={40}
            dataKey={dataKey}
            nameKey={block.xKey}
            label={
              ((props: { name?: string | number; percent?: number }) => {
                const pName = String(props.name ?? "");
                const pPercent = props.percent ?? 0;
                return `${pName} ${(pPercent * 100).toFixed(0)}%`;
              }) as unknown as import("recharts").PieLabel
            }
            labelLine={false}
          >
            {data.map((_, i) => (
              <Cell key={i} fill={FALLBACK_HEX[i % FALLBACK_HEX.length]} />
            ))}
          </Pie>
          {axisProps.tooltip}
          <Legend
            wrapperStyle={{
              fontSize: "11px",
              color: "var(--ink-3)",
              fontFamily: "JetBrains Mono, monospace",
            }}
          />
        </PieChart>
      </ResponsiveContainer>
    );
  }

  return null;
}
