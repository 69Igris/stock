"use client";

/**
 * Recharts leaf for the FIRE corpus projection (MONEY-290).
 *
 * This is the ONLY module in the /fire route that imports `recharts`. It is
 * reached exclusively through the `next/dynamic` boundary in
 * `./CorpusChartRecharts.tsx`, which is what keeps the ~400 KB recharts graph
 * out of the FIRE page's initial JS. Import this file directly and that
 * boundary is gone — always go through `CorpusChartRecharts`.
 */

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type OneTimeExpense, type ProjectionData } from "../lib/types";

export interface CorpusChartCanvasProps {
  data: ProjectionData[];
  retireAge: number;
  oneTimes: OneTimeExpense[];
  fireNumberAtRetire: number;
}

// recharts injects this onto custom label / dot renderers.
interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MONO = "var(--font-jetbrains), ui-monospace, monospace";
// Danger colour for the overdrawn (unsustainable) region — repo's destructive
// token, so it adapts to light/dark.
const RED = "hsl(var(--destructive))";

// Graph-local price formatter: no ₹ symbol (e.g. "33.36 Cr"). Axis ticks render
// it via a raw <text> (see YAxisTick) so it never wraps onto two lines.
function formatCr(value: number): string {
  if (value >= 10000000) return `${(value / 10000000).toFixed(2)} Cr`;
  if (value >= 100000) return `${(value / 100000).toFixed(2)} L`;
  return value.toLocaleString("en-IN");
}

export default function CorpusChartCanvas({
  data,
  retireAge,
  oneTimes,
  fireNumberAtRetire,
}: CorpusChartCanvasProps) {
  if (data.length === 0) return null;

  // Same y-domain ceiling the SVG version used: a little headroom above the
  // FIRE line / peak corpus so the curve never kisses the top edge.
  const max = Math.max(
    fireNumberAtRetire * 1.1,
    ...data.map((d) => d.corpus),
    1
  );
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => max * t);

  const firstAge = data[0].age;
  const lastAge = data[data.length - 1].age;
  const midAge = Math.round((retireAge + lastAge) / 2);
  // Dedupe in case retire/mid collide with the endpoints, keep ascending.
  const xTicks = Array.from(
    new Set([firstAge, retireAge, midAge, lastAge])
  ).sort((a, b) => a - b);

  // Two-color line (#1): a single gradient whose hard stop sits at the
  // retirement fraction along the x-axis.
  const retireIdx = data.findIndex((d) => d.age === retireAge);
  const splitOffset =
    retireIdx >= 0 ? (retireIdx / Math.max(1, data.length - 1)) * 100 : 100;

  // Drive the emerald fill so it only paints under the accumulation phase.
  const chartData = data.map((d) => ({
    ...d,
    accumCorpus: d.age <= retireAge ? d.corpus : null,
  }));

  const corpusAtRetire = data.find((d) => d.age === retireAge)?.corpus ?? null;

  // y-value that lands an expense pin's dot 14px below the plot top, matching
  // the old `P.t + 14` placement (inner plot height was 198px → 184/198).
  const pinDotValue = max * (184 / 198);

  // First retirement year where spending outran the withdrawal-rate cap — the
  // chart shades from here to the end to mark the unsustainable zone (and the
  // corpus line turns red from this point on).
  const shortfallAge = data.find((d) => (d.shortfall ?? 0) > 0)?.age ?? null;
  const shortfallIdx =
    shortfallAge != null ? data.findIndex((d) => d.age === shortfallAge) : -1;
  const shortfallOffset =
    shortfallIdx >= 0
      ? (shortfallIdx / Math.max(1, data.length - 1)) * 100
      : 100;

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart
        data={chartData}
        margin={{ top: 14, right: 16, bottom: 0, left: 0 }}
      >
        <defs>
          {/* Emerald → pop-2 at retirement, then a hard flip to red at the
              first overdrawn (unsustainable) year. */}
          <linearGradient id="corpusLineSplit" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--emerald)" />
            <stop offset={`${splitOffset}%`} stopColor="var(--emerald)" />
            <stop offset={`${splitOffset}%`} stopColor="var(--pop-2)" />
            {shortfallAge != null ? (
              <>
                <stop offset={`${shortfallOffset}%`} stopColor="var(--pop-2)" />
                <stop offset={`${shortfallOffset}%`} stopColor={RED} />
                <stop offset="100%" stopColor={RED} />
              </>
            ) : (
              <stop offset="100%" stopColor="var(--pop-2)" />
            )}
          </linearGradient>
          {/* Vertical emerald fade under the accumulation area. */}
          <linearGradient id="corpusAccumFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--emerald)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="var(--emerald)" stopOpacity={0} />
          </linearGradient>
        </defs>

        <CartesianGrid
          vertical={false}
          stroke="var(--rule-soft)"
          strokeDasharray="2 4"
        />

        <XAxis
          type="number"
          dataKey="age"
          domain={["dataMin", "dataMax"]}
          ticks={xTicks}
          interval={0}
          height={28}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v: number) => `age ${v}`}
          tick={{ fontSize: 10, fontFamily: MONO, fill: "var(--ink-3)" }}
        />
        <YAxis
          width={56}
          domain={[0, max]}
          ticks={yTicks}
          axisLine={false}
          tickLine={false}
          tick={<YAxisTick />}
        />

        {/* Unsustainable zone: spending exceeds the withdrawal-rate cap. */}
        {shortfallAge != null && (
          <ReferenceArea
            x1={shortfallAge}
            x2={lastAge}
            fill={RED}
            fillOpacity={0.14}
            stroke="none"
            label={<ShortfallLabel age={shortfallAge} />}
          />
        )}

        {/* Emerald fill under accumulation only (stops at the first null). */}
        <Area
          type="linear"
          dataKey="accumCorpus"
          stroke="none"
          fill="url(#corpusAccumFill)"
          connectNulls={false}
          isAnimationActive={false}
          activeDot={false}
        />
        {/* The two-color corpus line. */}
        <Area
          type="linear"
          dataKey="corpus"
          stroke="url(#corpusLineSplit)"
          strokeWidth={2}
          fill="none"
          isAnimationActive={false}
          dot={false}
          activeDot={(props: {
            cx?: number;
            cy?: number;
            payload?: ProjectionData;
          }) => {
            const { cx, cy, payload } = props;
            if (cx == null || cy == null || !payload) {
              return <g />;
            }
            return (
              <circle
                cx={cx}
                cy={cy}
                r={4.5}
                fill="var(--paper)"
                stroke={
                  (payload.shortfall ?? 0) > 0
                    ? RED
                    : payload.age <= retireAge
                      ? "var(--emerald)"
                      : "var(--pop-2)"
                }
                strokeWidth={2}
              />
            );
          }}
        />

        {/* One-time expense pins. */}
        {oneTimes.map((o) => {
          const target = data[o.yearsAway];
          if (!target) return null;
          return (
            <ReferenceLine
              key={`pin-line-${o.id}`}
              x={target.age}
              stroke="var(--pop-5)"
              strokeWidth={1}
              strokeDasharray="3 3"
              strokeOpacity={0.45}
            />
          );
        })}
        {oneTimes.map((o) => {
          const target = data[o.yearsAway];
          if (!target) return null;
          return (
            <ReferenceDot
              key={`pin-dot-${o.id}`}
              x={target.age}
              y={pinDotValue}
              r={3.5}
              fill="var(--pop-5)"
              stroke="none"
            />
          );
        })}

        {/* FIRE target line + right-aligned label. */}
        <ReferenceLine
          y={fireNumberAtRetire}
          stroke="var(--pop-2)"
          strokeWidth={1}
          strokeDasharray="4 3"
          strokeOpacity={0.8}
          label={<FireLabel value={fireNumberAtRetire} />}
        />

        {/* Retirement marker: vertical guide + label + dot on the curve. */}
        {retireIdx >= 0 && (
          <ReferenceLine
            x={retireAge}
            stroke="var(--rule-soft)"
            strokeDasharray="2 3"
            label={<RetireLabel age={retireAge} />}
          />
        )}
        {corpusAtRetire != null && (
          <ReferenceDot
            x={retireAge}
            y={corpusAtRetire}
            r={5}
            fill="var(--emerald)"
            stroke="var(--paper)"
            strokeWidth={2}
          />
        )}

        <Tooltip
          cursor={{
            stroke: "var(--ink-3)",
            strokeWidth: 1,
            strokeDasharray: "2 3",
            strokeOpacity: 0.55,
          }}
          content={<CorpusTooltip retireAge={retireAge} />}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// Raw <text> tick so the "33.36 Cr" label never wraps (recharts' default tick
// uses a <Text> that breaks on whitespace to fit the axis width).
function YAxisTick(props: {
  x?: number;
  y?: number;
  payload?: { value: number };
}) {
  const { x, y, payload } = props;
  if (x == null || y == null || !payload) return null;
  return (
    <text
      x={x}
      y={y}
      dy={3}
      textAnchor="end"
      fill="var(--ink-3)"
      fontSize={10}
      fontFamily={MONO}
    >
      {formatCr(payload.value)}
    </text>
  );
}

function FireLabel({ value, viewBox }: { value: number; viewBox?: ViewBox }) {
  if (!viewBox) return null;
  return (
    <text
      x={viewBox.x + viewBox.width - 4}
      y={viewBox.y - 4}
      textAnchor="end"
      fill="var(--pop-2)"
      fontSize={10}
      fontWeight={700}
      fontFamily={MONO}
    >
      {`FIRE · ${formatCr(value)}`}
    </text>
  );
}

function ShortfallLabel({ age, viewBox }: { age: number; viewBox?: ViewBox }) {
  if (!viewBox) return null;
  return (
    <text
      x={viewBox.x + 4}
      y={viewBox.y + 11}
      textAnchor="start"
      fill={RED}
      fontSize={9.5}
      fontWeight={700}
      fontFamily={MONO}
    >
      {`OVERDRAW @ ${age}`}
    </text>
  );
}

function RetireLabel({ age, viewBox }: { age: number; viewBox?: ViewBox }) {
  if (!viewBox) return null;
  return (
    <text
      x={viewBox.x}
      y={viewBox.y + 11}
      textAnchor="middle"
      fill="var(--emerald)"
      fontSize={9.5}
      fontWeight={700}
      fontFamily={MONO}
    >
      {`RETIRE @ ${age}`}
    </text>
  );
}

function CorpusTooltip({
  active,
  payload,
  retireAge,
}: {
  active?: boolean;
  payload?: Array<{ payload: ProjectionData }>;
  retireAge: number;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const p = payload[0].payload;
  const accumulating = p.age <= retireAge;
  return (
    <div
      style={{
        background: "var(--paper)",
        border: "1.5px solid var(--rule-soft)",
        borderRadius: 8,
        padding: "8px 10px",
        boxShadow: "0 6px 18px rgba(0,0,0,0.14)",
        fontFamily: MONO,
        fontSize: 11,
        lineHeight: 1.5,
        whiteSpace: "nowrap",
      }}
    >
      <div style={{ fontWeight: 700, color: "var(--ink-1)", marginBottom: 4 }}>
        Age {p.age}
        <span style={{ color: "var(--ink-3)", fontWeight: 500 }}>
          {" · "}
          {accumulating ? "accumulating" : "drawing down"}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "var(--ink-2)",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: accumulating ? "var(--emerald)" : "var(--pop-2)",
          }}
        />
        Corpus
        <span style={{ marginLeft: "auto", fontWeight: 700 }}>
          {formatCr(p.corpus)}
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: "var(--ink-3)",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "transparent",
            border: "1.5px dashed var(--pop-2)",
          }}
        />
        FIRE target
        <span style={{ marginLeft: "auto", fontWeight: 700 }}>
          {formatCr(p.fireNumber)}
        </span>
      </div>
      {(p.shortfall ?? 0) > 0 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 4,
            paddingTop: 4,
            borderTop: "1px solid var(--rule-soft)",
            color: RED,
            fontWeight: 700,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              background: RED,
            }}
          />
          Unfunded
          <span style={{ marginLeft: "auto" }}>
            {formatCr(p.shortfall ?? 0)}
          </span>
        </div>
      )}
    </div>
  );
}
