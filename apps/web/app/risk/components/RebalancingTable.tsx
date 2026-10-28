"use client";

import { AlertCircle, CheckCircle2 } from "lucide-react";
import type { RebalancingResult } from "@usemoney/research";

interface RebalancingTableProps {
  data: RebalancingResult;
}

function getActionPill(action: "buy" | "sell" | "hold"): {
  label: string;
  pill: string;
} {
  switch (action) {
    case "buy":
      return { label: "BUY", pill: "emerald" };
    case "sell":
      return { label: "SELL", pill: "coral" };
    case "hold":
      return { label: "HOLD", pill: "outline" };
  }
}

function formatPercent(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function formatINR(value: number): string {
  return value.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  });
}

export default function RebalancingTable({ data }: RebalancingTableProps) {
  return (
    <div className="pf-card" style={{ padding: 18 }}>
      <div className="flex items-center justify-between mb-3">
        <div className="ttl">REBALANCING SUGGESTIONS</div>
        {data.needsRebalancing ? (
          <span className="pf-pill gold inline-flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            Rebalancing Needed
          </span>
        ) : (
          <span className="pf-pill emerald inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3" />
            Well Balanced
          </span>
        )}
      </div>
      <div className="space-y-4">
        {/* Total Drift Metric */}
        <div className="flex items-center gap-4">
          <div
            className="flex-1 rounded-lg p-3"
            style={{
              background: "var(--rule-softer)",
              border: "1.5px solid var(--rule-soft)",
            }}
          >
            <p className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)] mb-1">
              Total Drift
            </p>
            <p
              className="mono text-[22px] font-bold"
              style={{
                color:
                  data.totalDrift > 0.1
                    ? "var(--pop-1-text)"
                    : data.totalDrift > 0.05
                      ? "var(--pop-2-text)"
                      : "var(--emerald-text)",
              }}
            >
              {(data.totalDrift * 100).toFixed(1)}%
            </p>
          </div>
          <div
            className="flex-1 rounded-lg p-3"
            style={{
              background: "var(--rule-softer)",
              border: "1.5px solid var(--rule-soft)",
            }}
          >
            <p className="mono text-[10px] uppercase tracking-[1px] text-[var(--ink-3)] mb-1">
              Drift Threshold
            </p>
            <p className="mono text-[22px] font-bold text-[var(--ink)]">
              {(data.driftThreshold * 100).toFixed(0)}%
            </p>
          </div>
        </div>

        {/* Rebalancing Table */}
        <div className="overflow-x-auto">
          <table className="pf-tbl">
            <thead>
              <tr>
                <th>Symbol</th>
                <th style={{ textAlign: "right" }}>Current</th>
                <th style={{ textAlign: "right" }}>Target</th>
                <th style={{ textAlign: "right" }}>Drift</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th style={{ textAlign: "center" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {data.holdings.map((holding) => {
                const actionPill = getActionPill(holding.action);
                const driftColor =
                  Math.abs(holding.drift) > data.driftThreshold
                    ? holding.drift > 0
                      ? "var(--pop-1-text)"
                      : "var(--emerald-text)"
                    : "var(--ink-3)";
                return (
                  <tr key={holding.symbol}>
                    <td className="tk">{holding.symbol}</td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {(holding.currentWeight * 100).toFixed(1)}%
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {(holding.targetWeight * 100).toFixed(1)}%
                    </td>
                    <td
                      className="num"
                      style={{ textAlign: "right", color: driftColor }}
                    >
                      {formatPercent(holding.drift)}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {holding.amount === 0 ? "-" : formatINR(holding.amount)}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <span className={`pf-pill ${actionPill.pill}`}>
                        {actionPill.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Info footer */}
        <p
          className="text-[11px] text-[var(--ink-3)] pt-3"
          style={{ borderTop: "1px dashed var(--rule-soft)" }}
        >
          Target weights are computed using equal-weight allocation. Holdings
          with drift exceeding {(data.driftThreshold * 100).toFixed(0)}% are
          flagged for rebalancing.
        </p>
      </div>
    </div>
  );
}
