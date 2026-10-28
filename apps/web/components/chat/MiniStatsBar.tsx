"use client";

import { useState } from "react";
import { useChatContext } from "@/lib/chat/ChatContext";
import { Button } from "@usemoney/ui/button";
import {
  ChevronDown,
  ChevronUp,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import { formatCurrency, formatPnL } from "@usemoney/utils";

export default function MiniStatsBar() {
  const { dashboardStats } = useChatContext();
  const [expanded, setExpanded] = useState(false);

  if (!dashboardStats) return null;

  const { portfolio, trading } = dashboardStats;
  const isPositive = (portfolio?.totalPnL || 0) >= 0;

  return (
    <div className="border-b border-[var(--border-default)] bg-[var(--bg-card)]/30">
      {/* Collapsed bar */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2 hover:bg-[var(--bg-card)] transition-colors"
      >
        <div className="flex items-center gap-4 text-sm">
          <div>
            <span className="text-[var(--text-muted)]">Total </span>
            <span className="text-[var(--text-primary)] font-medium">
              {formatCurrency(portfolio?.totalValue || 0)}
            </span>
          </div>
          <div className="flex items-center gap-1">
            {isPositive ? (
              <ArrowUpRight className="h-3.5 w-3.5 text-emerald-500" />
            ) : (
              <ArrowDownRight className="h-3.5 w-3.5 text-red-500" />
            )}
            <span
              className={`font-medium ${
                isPositive ? "text-emerald-500" : "text-red-500"
              }`}
            >
              {formatPnL(portfolio?.totalPnL || 0)}
            </span>
            <span className="text-[var(--text-muted)] text-xs">
              ({portfolio?.pnlPercentage || "0.00"}%)
            </span>
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-[var(--text-muted)]" />
        ) : (
          <ChevronDown className="h-4 w-4 text-[var(--text-muted)]" />
        )}
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="px-4 pb-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <div>
            <span className="text-[var(--text-muted)]">Holdings</span>
            <div className="text-[var(--text-primary)] font-medium">
              {formatCurrency(portfolio?.holdingsValue || 0)}
            </div>
            <div
              className={`${(portfolio?.holdingsPnL || 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}
            >
              {formatPnL(portfolio?.holdingsPnL || 0)}
            </div>
          </div>
          <div>
            <span className="text-[var(--text-muted)]">Mutual Funds</span>
            <div className="text-[var(--text-primary)] font-medium">
              {formatCurrency(portfolio?.mfValue || 0)}
            </div>
            <div
              className={`${(portfolio?.mfPnL || 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}
            >
              {formatPnL(portfolio?.mfPnL || 0)}
            </div>
          </div>
          <div>
            <span className="text-[var(--text-muted)]">Positions</span>
            <div className="text-[var(--text-primary)] font-medium">
              {formatCurrency(portfolio?.openPositionsValue || 0)}
            </div>
            <div
              className={`${(portfolio?.openPositionsPnL || 0) >= 0 ? "text-emerald-500" : "text-red-500"}`}
            >
              {formatPnL(portfolio?.openPositionsPnL || 0)}
            </div>
          </div>
          <div>
            <span className="text-[var(--text-muted)]">Realized P&L</span>
            <div
              className={`font-medium ${
                (trading?.totalRealizedPnL || 0) >= 0
                  ? "text-emerald-500"
                  : "text-red-500"
              }`}
            >
              {formatPnL(trading?.totalRealizedPnL || 0)}
            </div>
            <div className="text-[var(--text-muted)]">
              {trading?.totalTrades || 0} trades
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
