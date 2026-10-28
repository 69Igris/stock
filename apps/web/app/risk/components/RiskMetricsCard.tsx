"use client";

import { Info } from "lucide-react";
import type { RiskAdjustedReturnsResult } from "@usemoney/research";

interface RiskMetricsCardProps {
  data: RiskAdjustedReturnsResult | null;
}

function getRatioColor(
  value: number,
  type: "sharpe" | "sortino" | "calmar"
): string {
  if (type === "sharpe") {
    if (value >= 1.5) return "var(--emerald-text)";
    if (value >= 1.0) return "var(--pop-3-text)";
    if (value >= 0.5) return "var(--pop-2-text)";
    return "var(--pop-1-text)";
  }
  if (type === "sortino") {
    if (value >= 2.0) return "var(--emerald-text)";
    if (value >= 1.0) return "var(--pop-3-text)";
    if (value >= 0.5) return "var(--pop-2-text)";
    return "var(--pop-1-text)";
  }
  // calmar
  if (value >= 1.0) return "var(--emerald-text)";
  if (value >= 0.5) return "var(--pop-3-text)";
  if (value >= 0.2) return "var(--pop-2-text)";
  return "var(--pop-1-text)";
}

function getRatioBadge(
  value: number,
  type: "sharpe" | "sortino" | "calmar"
): { label: string; pill: string } {
  let threshold: number;
  if (type === "sharpe") threshold = 1.0;
  else if (type === "sortino") threshold = 1.5;
  else threshold = 0.5;

  if (value >= threshold * 1.5) return { label: "Excellent", pill: "emerald" };
  if (value >= threshold) return { label: "Good", pill: "blue" };
  if (value >= threshold * 0.5) return { label: "Fair", pill: "gold" };
  return { label: "Poor", pill: "coral" };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

// Bordered ratio tile.
function RatioTile({
  label,
  value,
  color,
  pill,
  pillLabel,
}: {
  label: string;
  value: string;
  color: string;
  pill: string;
  pillLabel: string;
}) {
  return (
    <div
      className="rounded-lg p-3 text-center"
      style={{
        background: "var(--rule-softer)",
        border: "1.5px solid var(--rule-soft)",
      }}
    >
      <p className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)] mb-1">
        {label}
      </p>
      <p className="mono text-[22px] font-bold" style={{ color }}>
        {value}
      </p>
      <span className={`pf-pill ${pill} mt-1`} style={{ fontSize: 9.5 }}>
        {pillLabel}
      </span>
    </div>
  );
}

function MetricTile({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div
      className="rounded-lg p-3"
      style={{
        background: "var(--rule-softer)",
        border: "1.5px solid var(--rule-soft)",
      }}
    >
      <p className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)] mb-1">
        {label}
      </p>
      <p
        className="mono text-[18px] font-bold"
        style={{ color: color ?? "var(--ink)" }}
      >
        {value}
      </p>
    </div>
  );
}

export default function RiskMetricsCard({ data }: RiskMetricsCardProps) {
  if (!data) {
    return (
      <div className="pf-card" style={{ padding: 18 }}>
        <div className="ttl mb-3">RISK-ADJUSTED RETURNS</div>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Info className="h-10 w-10 text-[var(--ink-3)] mb-3" />
          <p className="text-[var(--ink-2)]">
            Risk-adjusted returns require at least 20 days of data.
          </p>
          <p className="text-[var(--ink-3)] text-sm mt-1">
            Continue trading to build sufficient history.
          </p>
        </div>
      </div>
    );
  }

  const sharpeBadge = getRatioBadge(data.sharpeRatio, "sharpe");
  const sortinoBadge = getRatioBadge(data.sortinoRatio, "sortino");
  const calmarBadge = getRatioBadge(data.calmarRatio, "calmar");

  return (
    <div className="pf-card" style={{ padding: 18 }}>
      <div className="ttl mb-3">RISK-ADJUSTED RETURNS</div>
      <div className="space-y-5">
        {/* Three Ratio Cards */}
        <div className="grid grid-cols-3 gap-3">
          <RatioTile
            label="Sharpe Ratio"
            value={data.sharpeRatio.toFixed(2)}
            color={getRatioColor(data.sharpeRatio, "sharpe")}
            pill={sharpeBadge.pill}
            pillLabel={sharpeBadge.label}
          />
          <RatioTile
            label="Sortino Ratio"
            value={data.sortinoRatio.toFixed(2)}
            color={getRatioColor(data.sortinoRatio, "sortino")}
            pill={sortinoBadge.pill}
            pillLabel={sortinoBadge.label}
          />
          <RatioTile
            label="Calmar Ratio"
            value={data.calmarRatio.toFixed(2)}
            color={getRatioColor(data.calmarRatio, "calmar")}
            pill={calmarBadge.pill}
            pillLabel={calmarBadge.label}
          />
        </div>

        {/* Return & Volatility */}
        <div className="grid grid-cols-2 gap-4">
          <MetricTile
            label="Annualized Return"
            value={formatPercent(data.annualizedReturn)}
            color={
              data.annualizedReturn >= 0
                ? "var(--emerald-text)"
                : "var(--pop-1-text)"
            }
          />
          <MetricTile
            label="Annualized Volatility"
            value={formatPercent(data.annualizedVolatility)}
          />
        </div>

        {/* Additional Metrics */}
        <div className="grid grid-cols-3 gap-3">
          <MetricTile
            label="Risk-Free Rate"
            value={formatPercent(data.riskFreeRate)}
          />
          <MetricTile
            label="Max Drawdown"
            value={formatPercent(data.maxDrawdown)}
            color="var(--pop-1-text)"
          />
          <MetricTile
            label="Downside Dev"
            value={formatPercent(data.downsideDeviation)}
          />
        </div>

        {/* Explanations */}
        <div
          className="pt-3 space-y-1.5 text-[11px] text-[var(--ink-3)]"
          style={{ borderTop: "1px dashed var(--rule-soft)" }}
        >
          <p>
            <strong className="text-[var(--ink-2)]">Sharpe:</strong> Excess
            return per unit of total risk. &gt;1.0 is good.
          </p>
          <p>
            <strong className="text-[var(--ink-2)]">Sortino:</strong> Like
            Sharpe but penalizes downside volatility only. &gt;1.5 is good.
          </p>
          <p>
            <strong className="text-[var(--ink-2)]">Calmar:</strong> Annualized
            return divided by max drawdown. &gt;0.5 is good.
          </p>
        </div>
      </div>
    </div>
  );
}
