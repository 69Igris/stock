"use client";

import { Info, Calendar, Clock } from "lucide-react";
import type { DrawdownResult } from "@usemoney/research";

interface DrawdownChartProps {
  data: DrawdownResult | null;
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatDate(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function getDrawdownSeverity(value: number): {
  label: string;
  pill: string;
} {
  const absVal = Math.abs(value);
  if (absVal >= 0.2) return { label: "Severe", pill: "coral" };
  if (absVal >= 0.1) return { label: "Significant", pill: "coral" };
  if (absVal >= 0.05) return { label: "Moderate", pill: "gold" };
  return { label: "Mild", pill: "emerald" };
}

export default function DrawdownChart({ data }: DrawdownChartProps) {
  if (!data) {
    return (
      <div className="pf-card" style={{ padding: 18 }}>
        <div className="ttl mb-3">DRAWDOWN ANALYSIS</div>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Info className="h-10 w-10 text-[var(--ink-3)] mb-3" />
          <p className="text-[var(--ink-2)]">
            Drawdown analysis requires sufficient price history data.
          </p>
          <p className="text-[var(--ink-3)] text-sm mt-1">
            Keep your portfolio active to see drawdown metrics.
          </p>
        </div>
      </div>
    );
  }

  const severity = getDrawdownSeverity(data.maxDrawdown);

  return (
    <div className="pf-card" style={{ padding: 18 }}>
      <div className="flex items-center justify-between mb-3">
        <div className="ttl">DRAWDOWN ANALYSIS</div>
        <span className={`pf-pill ${severity.pill}`}>{severity.label}</span>
      </div>
      <div className="space-y-5">
        {/* Max Drawdown - Prominent */}
        <div
          className="rounded-lg p-4 text-center"
          style={{
            background: "var(--rule-softer)",
            border: "1.5px solid var(--pop-1)",
          }}
        >
          <p className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)] mb-1">
            Max Drawdown
          </p>
          <p
            className="mono text-[36px] font-bold"
            style={{ color: "var(--pop-1-text)" }}
          >
            {formatPercent(data.maxDrawdown)}
          </p>
          <div className="flex items-center justify-center gap-4 mt-2 text-[11px] text-[var(--ink-3)]">
            <span className="flex items-center gap-1 mono">
              <Calendar className="h-3 w-3" />
              {formatDate(data.maxDrawdownStart)} &rarr;{" "}
              {formatDate(data.maxDrawdownEnd)}
            </span>
          </div>
        </div>

        {/* Current Drawdown & Recovery */}
        <div className="grid grid-cols-2 gap-4">
          <div
            className="rounded-lg p-3 text-center"
            style={{
              background: "var(--rule-softer)",
              border: "1.5px solid var(--rule-soft)",
            }}
          >
            <p className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)] mb-1">
              Current Drawdown
            </p>
            <p
              className="mono text-[22px] font-bold"
              style={{
                color:
                  data.currentDrawdown < -0.05
                    ? "var(--pop-1-text)"
                    : data.currentDrawdown < 0
                      ? "var(--pop-2-text)"
                      : "var(--emerald-text)",
              }}
            >
              {data.currentDrawdown === 0
                ? "At Peak"
                : formatPercent(data.currentDrawdown)}
            </p>
          </div>
          <div
            className="rounded-lg p-3 text-center"
            style={{
              background: "var(--rule-softer)",
              border: "1.5px solid var(--rule-soft)",
            }}
          >
            <p className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)] mb-1">
              Recovery Days
            </p>
            <p className="mono text-[22px] font-bold flex items-center justify-center gap-1 text-[var(--ink)]">
              <Clock className="h-5 w-5 text-[var(--ink-3)]" />
              {data.recoveryDays !== null ? (
                <span>
                  {data.recoveryDays}{" "}
                  <span className="text-sm font-normal text-[var(--ink-3)]">
                    days
                  </span>
                </span>
              ) : (
                <span
                  className="text-base"
                  style={{ color: "var(--pop-2-text)" }}
                >
                  Not recovered
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Underwater Drawdown Visualization */}
        {data.underwaterPeriods.length > 0 && (
          <div>
            <div className="ttl mb-3">UNDERWATER PERIODS</div>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {data.underwaterPeriods.map((period, i) => {
                const depthPercent = Math.min(
                  Math.abs(period.depth) * 500,
                  100
                );
                return (
                  <div
                    key={i}
                    className="rounded-lg p-3"
                    style={{
                      background: "var(--rule-softer)",
                      border: "1.5px solid var(--rule-soft)",
                    }}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="mono text-[12px] font-semibold text-[var(--ink-2)]">
                        {formatDate(period.start)} &mdash;{" "}
                        {formatDate(period.end)}
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="pf-pill outline">
                          {period.durationDays}d
                        </span>
                        <span
                          className="mono text-[12px] font-bold"
                          style={{ color: "var(--pop-1-text)" }}
                        >
                          {formatPercent(period.depth)}
                        </span>
                      </div>
                    </div>
                    <div
                      className="w-full rounded-full h-1.5 overflow-hidden"
                      style={{ background: "var(--rule-softer)" }}
                    >
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${depthPercent}%`,
                          background: "var(--pop-1)",
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {data.underwaterPeriods.length === 0 && (
          <div className="text-center py-4 text-sm text-[var(--ink-3)]">
            No significant underwater periods detected.
          </div>
        )}
      </div>
    </div>
  );
}
