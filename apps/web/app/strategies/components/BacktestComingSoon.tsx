"use client";

/**
 * BacktestComingSoon - MONEY-203 design surface that previews the
 * on-demand backtest UI while the worker pipeline (MONEY-406) is
 * being built. Renders only when the `terminal-luxe-strategies-v2`
 * flag is on; off → component is null so the existing /strategies
 * page renders verbatim.
 *
 * Once `runBacktestAction` lands, swap this card for a real form
 * that posts to the worker and polls `/api/research/backtest/[runId]`.
 */

import { Sparkles, GitBranch, Target } from "lucide-react";
import { useAppFeatureFlags } from "@/lib/hooks/useAppFeatureFlags";

export default function BacktestComingSoon() {
  const { flags } = useAppFeatureFlags();
  if (!flags["terminal-luxe-strategies-v2"]) return null;

  return (
    <div
      className="rounded-xl p-5 border"
      style={{
        background:
          "linear-gradient(135deg, rgba(52,211,153,0.06), rgba(167,139,250,0.04))",
        borderColor: "rgba(52,211,153,0.25)",
      }}
    >
      <div className="flex items-center gap-2 mb-3">
        <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
        <div className="font-mono text-[10px] tracking-[1.5px] uppercase text-emerald-400 font-bold">
          Backtest · forward prediction · AI strategy creator
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <FeatureTile
          icon={<GitBranch className="h-3.5 w-3.5 text-emerald-400" />}
          title="On-demand backtest"
          body="Pick any built-in strategy, your own universe, and a date range. Get CAGR, Sharpe, max drawdown, and equity curve in under 30s."
        />
        <FeatureTile
          icon={<Target className="h-3.5 w-3.5 text-violet-400" />}
          title="Forward prediction"
          body="Monte-Carlo + pattern-match bands (5/25/50/75/95 percentiles) for the next 1–60 trading days. SEBI-safe - educational only."
        />
        <FeatureTile
          icon={<Sparkles className="h-3.5 w-3.5 text-amber-300" />}
          title="AI strategy creator"
          body="Paste a YouTube URL, blog, or X thread. StockSage extracts the filter tree and validates every indicator against the registry."
        />
      </div>
      <div className="mt-4 font-mono text-[10px] text-[var(--text-muted)] tracking-[0.4px]">
        Compute pipeline ships with MONEY-406
        (workers/src/processors/strategy-*).
      </div>
    </div>
  );
}

function FeatureTile({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg p-3.5 bg-black/20 border border-[var(--border-default)]">
      <div className="flex items-center gap-2 mb-1.5">
        {icon}
        <div className="font-display text-[13px] font-bold text-[var(--text-primary)] tracking-[-0.2px]">
          {title}
        </div>
      </div>
      <div className="text-[12px] text-[var(--text-dim)] leading-snug">
        {body}
      </div>
    </div>
  );
}
