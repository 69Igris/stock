"use client";

import dynamic from "next/dynamic";
import { AlertTriangle } from "lucide-react";
import type { ConcentrationResult } from "@usemoney/research";
import type { ConcentrationPieSlice } from "./ConcentrationPieCanvas";

/**
 * MONEY-290 — recharts is loaded only when this card actually paints a donut.
 * Everything above the donut (HHI gauge, top-holdings bars, warnings) is plain
 * DOM and must not wait on a ~400 KB chart library, so the lazy boundary is
 * around the donut alone rather than the whole card. `ssr: false` because
 * <ResponsiveContainer> measures the DOM and renders nothing server-side.
 * The fallback is the exact 160x160 of the slot, so nothing shifts.
 */
const ConcentrationPieCanvas = dynamic<{ data: ConcentrationPieSlice[] }>(
  () => import("./ConcentrationPieCanvas"),
  {
    ssr: false,
    loading: () => (
      <div
        aria-hidden="true"
        className="w-full h-full rounded-full"
        style={{
          border: "18px solid var(--rule-softer)",
          opacity: 0.7,
        }}
      />
    ),
  }
);

interface ConcentrationCardProps {
  data: ConcentrationResult;
}

const SECTOR_COLORS = [
  "#3b82f6", // blue
  "#ef4444", // red
  "#22c55e", // green
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
  "#14b8a6", // teal
  "#6366f1", // indigo
];

function getHHIColor(level: ConcentrationResult["level"]): string {
  switch (level) {
    case "low":
      return "var(--emerald)";
    case "moderate":
      return "var(--pop-2)";
    case "high":
      return "var(--pop-1)";
  }
}

/** Text-contrast sibling of getHHIColor (AA on cream in light mode). */
function getHHITextColor(level: ConcentrationResult["level"]): string {
  switch (level) {
    case "low":
      return "var(--emerald-text)";
    case "moderate":
      return "var(--pop-2-text)";
    case "high":
      return "var(--pop-1-text)";
  }
}

function getHHIPillClass(level: ConcentrationResult["level"]): string {
  switch (level) {
    case "low":
      return "emerald";
    case "moderate":
      return "gold";
    case "high":
      return "coral";
  }
}

function getHHILabel(level: ConcentrationResult["level"]): string {
  switch (level) {
    case "low":
      return "Well Diversified";
    case "moderate":
      return "Moderately Concentrated";
    case "high":
      return "Highly Concentrated";
  }
}

export default function ConcentrationCard({ data }: ConcentrationCardProps) {
  const sectorData = data.sectorWeights.map((s, i) => ({
    ...s,
    fill: SECTOR_COLORS[i % SECTOR_COLORS.length],
  }));

  return (
    <div className="pf-card" style={{ padding: 18 }}>
      <div className="flex items-center justify-between mb-3">
        <div className="ttl">CONCENTRATION · BY SECTOR</div>
        <span className={`pf-pill ${getHHIPillClass(data.level)}`}>
          {getHHILabel(data.level)}
        </span>
      </div>

      {/* HHI Gauge */}
      <div className="mb-5">
        <div className="flex items-baseline gap-2 mb-1.5">
          <span
            className="mono text-[28px] font-bold"
            style={{ color: getHHITextColor(data.level), letterSpacing: -0.5 }}
          >
            {data.hhi.toLocaleString("en-IN")}
          </span>
          <span className="text-sm text-[var(--ink-3)]">HHI</span>
        </div>
        <div
          className="w-full rounded-full h-2.5 overflow-hidden"
          style={{
            background: "var(--rule-softer)",
            border: "1.5px solid var(--ink)",
          }}
        >
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${Math.min((data.hhi / 10000) * 100, 100)}%`,
              background: getHHIColor(data.level),
            }}
          />
        </div>
        <div className="flex justify-between mono text-[10.5px] text-[var(--ink-3)] mt-1">
          <span>0</span>
          <span>1,500</span>
          <span>2,500</span>
          <span>10,000</span>
        </div>
      </div>

      {/* Top Holdings */}
      <div className="mb-5">
        <div className="ttl mb-2">TOP HOLDINGS</div>
        <div className="space-y-2">
          {data.topHoldings.slice(0, 5).map((holding) => (
            <div key={holding.symbol} className="flex items-center gap-3">
              <span className="mono text-[12.5px] font-bold w-24 truncate text-[var(--ink)]">
                {holding.symbol}
              </span>
              <div
                className="flex-1 rounded-full h-2 overflow-hidden"
                style={{
                  background: "var(--rule-softer)",
                  border: "1.5px solid var(--ink)",
                }}
              >
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${holding.weight * 100}%`,
                    background: "var(--pop-3)",
                  }}
                />
              </div>
              <span className="mono text-[12px] text-[var(--ink-3)] w-14 text-right">
                {(holding.weight * 100).toFixed(1)}%
              </span>
              <span className="mono text-[12px] text-[var(--ink-3)] w-24 text-right">
                {holding.value.toLocaleString("en-IN", {
                  style: "currency",
                  currency: "INR",
                  maximumFractionDigits: 0,
                })}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Sector Pie Chart */}
      <div>
        <div className="ttl mb-2">SECTOR ALLOCATION</div>
        <div className="flex items-center gap-4">
          <div className="w-40 h-40">
            <ConcentrationPieCanvas data={sectorData} />
          </div>
          <div className="flex-1 space-y-1">
            {sectorData.map((sector, i) => (
              <div
                key={sector.sector}
                className="flex items-center gap-2 text-[12.5px]"
              >
                <div
                  className="w-3 h-3 rounded-sm flex-shrink-0"
                  style={{
                    backgroundColor: SECTOR_COLORS[i % SECTOR_COLORS.length],
                  }}
                />
                <span className="truncate flex-1 text-[var(--ink-2)]">
                  {sector.sector}
                </span>
                <span className="mono text-[var(--ink-3)]">
                  {(sector.weight * 100).toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Warnings */}
      {data.warnings.length > 0 && (
        <div className="space-y-1.5 mt-4">
          {data.warnings.map((warning, i) => (
            <div
              key={i}
              className="flex items-start gap-2 text-[12.5px] rounded-md px-3 py-2"
              style={{
                color: "var(--pop-2-text)",
                background: "var(--rule-softer)",
                border: "1.5px solid var(--rule-soft)",
              }}
            >
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{warning}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
