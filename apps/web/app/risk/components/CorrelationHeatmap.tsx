"use client";

import { Info } from "lucide-react";
import type { CorrelationMatrixResult } from "@usemoney/research";

interface CorrelationHeatmapProps {
  data: CorrelationMatrixResult | null;
}

// Heatmap cell color via pop tokens with opacity, theme-aware.
function getCellStyle(value: number): React.CSSProperties {
  const absVal = Math.abs(value);
  if (absVal >= 0.7)
    return { background: "var(--pop-1)", color: "var(--paper)" };
  if (absVal >= 0.4) return { background: "var(--pop-2)", color: "#1d1d1b" };
  if (absVal >= 0.2)
    return { background: "rgba(52,211,153,0.45)", color: "var(--ink)" };
  return { background: "rgba(52,211,153,0.22)", color: "var(--ink)" };
}

function getDiversificationBadge(score: number): {
  label: string;
  pill: string;
} {
  if (score >= 70) return { label: "Excellent", pill: "emerald" };
  if (score >= 50) return { label: "Good", pill: "blue" };
  if (score >= 30) return { label: "Moderate", pill: "gold" };
  return { label: "Poor", pill: "coral" };
}

export default function CorrelationHeatmap({ data }: CorrelationHeatmapProps) {
  if (!data) {
    return (
      <div className="pf-card" style={{ padding: 18 }}>
        <div className="ttl mb-3">CORRELATION MATRIX</div>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Info className="h-10 w-10 text-[var(--ink-3)] mb-3" />
          <p className="text-[var(--ink-2)]">
            Correlation data requires at least 2 holdings with price history.
          </p>
          <p className="text-[var(--ink-3)] text-sm mt-1">
            Add more holdings to see how they move together.
          </p>
        </div>
      </div>
    );
  }

  const diversification = getDiversificationBadge(data.diversificationScore);

  return (
    <div className="pf-card" style={{ padding: 18 }}>
      <div className="flex items-center justify-between mb-3">
        <div className="ttl">CORRELATION MATRIX</div>
        <span className={`pf-pill ${diversification.pill}`}>
          Diversification: {diversification.label}
        </span>
      </div>
      <div className="space-y-5">
        {/* Summary Metrics */}
        <div className="grid grid-cols-2 gap-4">
          <div
            className="rounded-lg p-3"
            style={{
              background: "var(--rule-softer)",
              border: "1.5px solid var(--rule-soft)",
            }}
          >
            <p className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)]">
              Diversification Score
            </p>
            <p className="mono text-[22px] font-bold text-[var(--ink)]">
              {data.diversificationScore.toFixed(1)}
            </p>
          </div>
          <div
            className="rounded-lg p-3"
            style={{
              background: "var(--rule-softer)",
              border: "1.5px solid var(--rule-soft)",
            }}
          >
            <p className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)]">
              Avg Correlation
            </p>
            <p className="mono text-[22px] font-bold text-[var(--ink)]">
              {data.avgCorrelation.toFixed(2)}
            </p>
          </div>
        </div>

        {/* Heatmap Grid */}
        <div className="overflow-x-auto">
          <div className="min-w-fit">
            {/* Header row */}
            <div className="flex">
              <div className="w-20 flex-shrink-0" />
              {data.symbols.map((sym) => (
                <div
                  key={`header-${sym}`}
                  className="w-16 flex-shrink-0 text-center"
                >
                  <span className="mono text-[10.5px] font-medium text-[var(--ink-3)] truncate block">
                    {sym.length > 6 ? sym.slice(0, 6) : sym}
                  </span>
                </div>
              ))}
            </div>

            {/* Matrix rows */}
            {data.symbols.map((rowSym, rowIdx) => (
              <div key={`row-${rowSym}`} className="flex">
                <div className="w-20 flex-shrink-0 flex items-center">
                  <span className="mono text-[10.5px] font-medium truncate text-[var(--ink-2)]">
                    {rowSym.length > 8 ? rowSym.slice(0, 8) : rowSym}
                  </span>
                </div>
                {data.matrix[rowIdx]!.map((value, colIdx) => (
                  <div
                    key={`cell-${rowIdx}-${colIdx}`}
                    className="w-16 h-10 flex-shrink-0 flex items-center justify-center rounded-sm m-0.5 mono text-[11px] font-semibold"
                    style={getCellStyle(value)}
                    title={`${rowSym} vs ${data.symbols[colIdx]}: ${value.toFixed(2)}`}
                  >
                    {value.toFixed(2)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* Color Legend */}
        <div className="flex items-center gap-4 mono text-[10.5px] text-[var(--ink-3)] flex-wrap">
          <div className="flex items-center gap-1">
            <div
              className="w-3 h-3 rounded-sm"
              style={{ background: "rgba(52,211,153,0.22)" }}
            />
            <span>Low (&lt;0.2)</span>
          </div>
          <div className="flex items-center gap-1">
            <div
              className="w-3 h-3 rounded-sm"
              style={{ background: "rgba(52,211,153,0.45)" }}
            />
            <span>Moderate (0.2-0.4)</span>
          </div>
          <div className="flex items-center gap-1">
            <div
              className="w-3 h-3 rounded-sm"
              style={{ background: "var(--pop-2)" }}
            />
            <span>High (0.4-0.7)</span>
          </div>
          <div className="flex items-center gap-1">
            <div
              className="w-3 h-3 rounded-sm"
              style={{ background: "var(--pop-1)" }}
            />
            <span>Very High (&gt;0.7)</span>
          </div>
        </div>

        {/* High Correlation Pairs */}
        {data.highCorrelationPairs.length > 0 && (
          <div>
            <div className="ttl mb-2">HIGH CORRELATION PAIRS</div>
            <div className="space-y-1.5">
              {data.highCorrelationPairs.map((pair, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between rounded-md px-3 py-2"
                  style={{
                    background: "var(--rule-softer)",
                    border: "1.5px solid var(--rule-soft)",
                  }}
                >
                  <span className="mono text-[12.5px] text-[var(--ink-2)]">
                    {pair.symbol1} &harr; {pair.symbol2}
                  </span>
                  <span className="pf-pill coral">
                    {pair.correlation.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
