"use client";

import { TrendingDown, Info } from "lucide-react";
import type { VaRResult } from "@usemoney/research";

interface VaRCardProps {
  data: VaRResult | null;
}

function formatINR(value: number): string {
  return value.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  });
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

// Soft bordered tile (replaces shadcn bg-muted box) — theme-aware.
function Tile({
  label,
  value,
  color,
  className,
}: {
  label: string;
  value: string;
  color?: string;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg p-3 ${className ?? ""}`}
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

export default function VaRCard({ data }: VaRCardProps) {
  if (!data) {
    return (
      <div className="pf-card" style={{ padding: 18 }}>
        <div className="ttl mb-3">VALUE AT RISK (VAR)</div>
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Info className="h-10 w-10 text-[var(--ink-3)] mb-3" />
          <p className="text-[var(--ink-2)]">
            VaR calculation requires at least 20 days of price history.
          </p>
          <p className="text-[var(--ink-3)] text-sm mt-1">
            Keep your portfolio active to build sufficient data.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="pf-card" style={{ padding: 18 }}>
      <div className="flex items-center justify-between mb-3">
        <div className="ttl">VALUE AT RISK (VAR)</div>
        <span className="pf-pill outline">{data.period}</span>
      </div>
      <div className="space-y-5">
        {/* Portfolio Value */}
        <Tile
          label="Portfolio Value"
          value={formatINR(data.portfolioValue)}
          className="text-center"
        />

        {/* Amount at Risk - Prominent Display */}
        <div
          className="rounded-lg p-4 text-center"
          style={{
            background: "var(--rule-softer)",
            border: "1.5px solid var(--pop-1)",
          }}
        >
          <p className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)] mb-1">
            Amount at Risk (95% Confidence)
          </p>
          <p
            className="mono text-[28px] font-bold"
            style={{ color: "var(--pop-1-text)" }}
          >
            {formatINR(data.var95Amount)}
          </p>
          <p className="text-sm text-[var(--ink-3)] mt-1">
            Maximum expected {data.period} loss with 95% probability
          </p>
        </div>

        {/* Historical VaR */}
        <div>
          <div className="ttl mb-3">HISTORICAL VAR</div>
          <div className="grid grid-cols-3 gap-3">
            <Tile
              label="VaR 95%"
              value={formatPercent(data.historical.var95)}
              color="var(--pop-2-text)"
              className="text-center"
            />
            <Tile
              label="VaR 99%"
              value={formatPercent(data.historical.var99)}
              color="var(--pop-1-text)"
              className="text-center"
            />
            <Tile
              label="CVaR 95%"
              value={formatPercent(data.historical.cvar95)}
              color="var(--pop-1-text)"
              className="text-center"
            />
          </div>
        </div>

        {/* Parametric Comparison */}
        <div>
          <div className="ttl mb-3">PARAMETRIC VAR (GAUSSIAN)</div>
          <div className="grid grid-cols-2 gap-3">
            <Tile
              label="VaR 95%"
              value={formatPercent(data.parametric.var95)}
            />
            <Tile
              label="VaR 99%"
              value={formatPercent(data.parametric.var99)}
            />
            <Tile
              label="Daily Mean Return"
              value={formatPercent(data.parametric.mean)}
            />
            <Tile
              label="Daily Std Dev"
              value={formatPercent(data.parametric.stdDev)}
            />
          </div>
        </div>

        {/* Explanation */}
        <p
          className="text-[11px] text-[var(--ink-3)] pt-3"
          style={{ borderTop: "1px dashed var(--rule-soft)" }}
        >
          CVaR (Expected Shortfall) represents the average loss beyond VaR
          threshold, capturing tail risk better than VaR alone.
        </p>
      </div>
    </div>
  );
}
