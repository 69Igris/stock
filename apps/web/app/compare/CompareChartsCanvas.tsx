"use client";

/**
 * Recharts leaves for the fund-comparison page (MONEY-290).
 *
 * The only module on /compare that imports `recharts`. Both charts live here
 * so they share one lazy chunk — the page never shows one without the other
 * being a scroll away. Reached exclusively through the `next/dynamic`
 * boundaries in `./client.tsx`; importing this file directly would put
 * recharts back into the /compare entry chunk.
 */

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
} from "recharts";

/** One row of chart data, keyed `fund0`..`fund4` plus its label columns. */
export type CompareChartRow = Record<string, string | number>;

export interface CompareSeries {
  /** Data key on the row, e.g. "fund0". */
  key: string;
  /** Legend / tooltip label. */
  name: string;
  color: string;
}

const TOOLTIP_CONTENT_STYLE = {
  backgroundColor: "var(--paper)",
  border: "2px solid var(--ink)",
  borderRadius: "10px",
  fontSize: "12px",
  color: "var(--ink)",
} as const;

export interface NavOverlayChartProps {
  data: CompareChartRow[];
  series: CompareSeries[];
}

/** NAV performance overlay, normalized to base 100. */
export function NavOverlayChart({ data, series }: NavOverlayChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart
        data={data}
        margin={{ top: 5, right: 10, left: -10, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--rule-soft)" />
        <XAxis
          dataKey="displayDate"
          tick={{ fontSize: 10, fill: "var(--ink-3)" }}
          interval="preserveStartEnd"
          tickMargin={5}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "var(--ink-3)" }}
          domain={["auto", "auto"]}
          width={40}
        />
        <Tooltip
          contentStyle={TOOLTIP_CONTENT_STYLE}
          labelStyle={{ color: "var(--ink-3)" }}
        />
        {series.map((s) => (
          <Line
            key={s.key}
            type="monotone"
            dataKey={s.key}
            name={s.name}
            stroke={s.color}
            strokeWidth={2}
            dot={false}
            connectNulls
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export interface SectorOverlapChartProps {
  data: CompareChartRow[];
  series: CompareSeries[];
}

/** Grouped bar chart of per-fund sector weights. */
export function SectorOverlapChart({ data, series }: SectorOverlapChartProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart
        data={data}
        margin={{ top: 5, right: 10, left: -10, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="var(--rule-soft)" />
        <XAxis
          dataKey="sector"
          tick={{ fontSize: 9, fill: "var(--ink-3)" }}
          angle={-35}
          textAnchor="end"
          height={55}
          interval={0}
        />
        <YAxis tick={{ fontSize: 10, fill: "var(--ink-3)" }} width={35} />
        <Tooltip
          contentStyle={TOOLTIP_CONTENT_STYLE}
          formatter={(value) => `${Number(value).toFixed(1)}%`}
        />
        {series.map((s) => (
          <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
