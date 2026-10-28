"use client";

/**
 * Recharts leaf for the fund-detail NAV growth chart (MONEY-290).
 *
 * The only module under components/mf that imports `recharts`. It is reached
 * exclusively through the `next/dynamic` boundary in `./NavGrowthChart.tsx`;
 * importing it directly would put recharts back into the /mf and /etf entry
 * chunks.
 *
 * Everything that is NOT the plotted canvas — header, price, period tabs, AMFI
 * footer — stays in NavGrowthChart so it paints immediately.
 */

import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ReferenceDot,
} from "recharts";
import { navAxisGranularity, formatNavAxisTick } from "./nav-axis-logic";

export interface NavCanvasPoint {
  /** ISO date YYYY-MM-DD. */
  time: string;
  /** Fund NAV on this day. */
  nav: number;
}

export interface NavGrowthChartCanvasProps {
  data: NavCanvasPoint[];
  yMin: number;
  yMax: number;
  /** End-of-line marker (latest point). Omitted when there is no series. */
  marker: { time: string; nav: number } | null;
}

function formatInr(n: number): string {
  if (!Number.isFinite(n)) return "-";
  return `₹${n.toFixed(0)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export default function NavGrowthChartCanvas({
  data,
  yMin,
  yMax,
  marker,
}: NavGrowthChartCanvasProps) {
  // Derived from the plotted SPAN, not the period button: a fund with only six
  // weeks of history still has a six-week span under "1Y", and labelling that
  // by year would print the same string on every tick.
  const granularity = navAxisGranularity(
    data[0]?.time ?? "",
    data[data.length - 1]?.time ?? ""
  );

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 0, bottom: 8, left: 0 }}>
        <defs>
          <linearGradient id="navFundFill" x1="0" y1="0" x2="0" y2="1">
            {/* emerald area fill — opacity matches both themes */}
            <stop offset="0%" stopColor="var(--emerald)" stopOpacity={0.22} />
            <stop offset="100%" stopColor="var(--emerald)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <XAxis
          dataKey="time"
          tickFormatter={(t) => formatNavAxisTick(String(t), granularity)}
          interval="preserveStartEnd"
          axisLine={false}
          tickLine={false}
          tick={{
            fill: "var(--ink-4)",
            fontSize: 11,
            fontFamily: "JetBrains Mono, monospace",
          }}
          minTickGap={48}
        />
        <YAxis
          orientation="right"
          domain={[yMin, yMax]}
          tickFormatter={(v) => formatInr(v)}
          axisLine={false}
          tickLine={false}
          tick={{
            fill: "var(--ink-4)",
            fontSize: 11,
            fontFamily: "JetBrains Mono, monospace",
          }}
          width={56}
        />
        <Tooltip
          contentStyle={{
            background: "var(--paper-2)",
            border: "1.5px solid var(--ink)",
            borderRadius: 8,
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 11.5,
            color: "var(--ink)",
            boxShadow: "3px 3px 0 var(--ink)",
          }}
          labelStyle={{ color: "var(--ink-3)", marginBottom: 4 }}
          labelFormatter={(t) => formatDate(String(t))}
          formatter={(value) => {
            const v = typeof value === "number" ? value : Number(value);
            return [`₹${v.toFixed(2)}`, "Fund"];
          }}
        />
        {/* Fund area */}
        <Area
          type="monotone"
          dataKey="nav"
          stroke="var(--emerald)"
          strokeWidth={2}
          fill="url(#navFundFill)"
          dot={false}
          isAnimationActive={false}
        />
        {/* End-of-line marker — emerald dot at the latest point */}
        {marker && (
          <ReferenceDot
            x={marker.time}
            y={marker.nav}
            r={5}
            fill="var(--emerald)"
            stroke="var(--paper)"
            strokeWidth={2}
            ifOverflow="visible"
            label={{
              value: `₹${marker.nav.toFixed(2)}`,
              position: "right",
              fill: "var(--ink)",
              fontSize: 11,
              fontWeight: 700,
              fontFamily: "JetBrains Mono, monospace",
              offset: 8,
            }}
          />
        )}
      </AreaChart>
    </ResponsiveContainer>
  );
}
