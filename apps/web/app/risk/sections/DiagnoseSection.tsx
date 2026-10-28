"use client";

/**
 * Risk v2 (MONEY-485) — Diagnose section.
 *
 * Lenses (sub-tabs): Concentration (HHI + top holding/sector), Correlation
 * matrix, Volatility/VaR (+ illustrative Monte-Carlo fan & drawdown
 * waterfall), Returns, Style, F&O Greeks.
 *
 * Real data comes from the existing playful cards (Concentration, Correlation,
 * VaR, Drawdown, RiskMetrics). Monte-Carlo paths, drawdown-event
 * decomposition, factor/style exposure and F&O Greeks are not yet computed by
 * the backend (MONEY-487) — those render illustrative shapes (clearly
 * labelled) or honest empty states.
 */

import { useState } from "react";
import type { PortfolioRiskResult } from "@/lib/actions/risk";
import {
  Layers,
  GitMerge,
  Activity,
  TrendingUp,
  Sparkles,
  Zap,
} from "lucide-react";
import ConcentrationCard from "../components/ConcentrationCard";
import CorrelationHeatmap from "../components/CorrelationHeatmap";
import VaRCard from "../components/VaRCard";
import DrawdownChart from "../components/DrawdownChart";
import RiskMetricsCard from "../components/RiskMetricsCard";
import { MonteCarloFan, DrawdownWaterfall } from "../components/charts";
import { ComingSoon } from "../components/primitives";

interface Props {
  data: PortfolioRiskResult;
  ask: (q: string) => void;
}

type Lens =
  | "concentration"
  | "correlation"
  | "volatility"
  | "returns"
  | "style"
  | "fno";

const LENSES: Array<{ id: Lens; label: string; icon: typeof Layers }> = [
  { id: "concentration", label: "Concentration", icon: Layers },
  { id: "correlation", label: "Correlation", icon: GitMerge },
  { id: "volatility", label: "Volatility / VaR", icon: Activity },
  { id: "returns", label: "Returns", icon: TrendingUp },
  { id: "style", label: "Style", icon: Sparkles },
  { id: "fno", label: "F&O Greeks", icon: Zap },
];

/** Illustrative-shape caption used wherever the SVG is not the user's data. */
function IllustrativeNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center gap-2 mt-2.5 rounded-md px-3 py-2"
      style={{
        background: "var(--rule-softer)",
        border: "1.5px dashed var(--rule-soft)",
      }}
    >
      <span className="pf-pill outline" style={{ fontSize: 9 }}>
        ILLUSTRATIVE
      </span>
      <span className="text-[11.5px] text-[var(--ink-3)] leading-snug">
        {children}
      </span>
    </div>
  );
}

export default function DiagnoseSection({ data, ask }: Props) {
  const [lens, setLens] = useState<Lens>("concentration");

  return (
    <div className="flex flex-col gap-4">
      {/* Lens sub-tabs */}
      <div
        className="flex items-center gap-1.5 overflow-x-auto pb-1"
        role="tablist"
      >
        {LENSES.map((l) => {
          const Icon = l.icon;
          const isActive = l.id === lens;
          return (
            <button
              key={l.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setLens(l.id)}
              className="inline-flex items-center gap-1.5 rounded-lg whitespace-nowrap"
              style={{
                padding: "6px 11px",
                fontSize: 12,
                fontWeight: 700,
                border: "1.5px solid var(--ink)",
                background: isActive ? "var(--ink)" : "var(--paper)",
                color: isActive ? "var(--paper)" : "var(--ink)",
                flexShrink: 0,
              }}
            >
              <Icon className="h-[13px] w-[13px]" />
              {l.label}
            </button>
          );
        })}
      </div>

      {lens === "concentration" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
          <ConcentrationCard data={data.concentration} />
          <div
            className="pf-card tilt-r"
            style={{ background: "var(--paper-2)", padding: 18 }}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="ttl">SINGLE-STOCK RISK</div>
              {data.concentration?.topHoldings?.[0] && (
                <span className="pf-pill coral">
                  {(
                    data.concentration.topHoldings
                      .slice(0, 5)
                      .reduce((s, h) => s + h.weight, 0) * 100
                  ).toFixed(0)}
                  % in top 5
                </span>
              )}
            </div>
            {data.concentration?.topHoldings?.length ? (
              <>
                <div className="ser text-[15px] text-[var(--ink-2)] leading-snug mb-3.5">
                  {data.concentration.topHoldings[0].symbol} alone is{" "}
                  <b
                    style={{
                      fontFamily: "Inter, sans-serif",
                      fontStyle: "normal",
                    }}
                  >
                    {(data.concentration.topHoldings[0].weight * 100).toFixed(
                      1
                    )}
                    %
                  </b>{" "}
                  of your book.
                </div>
                <div className="flex flex-col gap-2">
                  {data.concentration.topHoldings.slice(0, 5).map((h, i) => {
                    const colors = [
                      "var(--pop-3)",
                      "var(--emerald)",
                      "var(--pop-2)",
                      "var(--pop-1)",
                      "var(--pop-5)",
                    ];
                    return (
                      <div key={h.symbol} className="flex items-center gap-2.5">
                        <span
                          className="w-3 h-3 rounded-sm flex-shrink-0"
                          style={{
                            background: colors[i],
                            border: "1.5px solid var(--ink)",
                          }}
                        />
                        <span className="mono text-[12.5px] font-bold text-[var(--ink)] flex-1 truncate">
                          {h.symbol}
                        </span>
                        <span className="mono text-[12.5px] text-[var(--ink-3)]">
                          {(h.weight * 100).toFixed(1)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
                <button
                  className="pf-bf sm mt-4"
                  onClick={() =>
                    ask(
                      "Should I trim my largest holding to reduce concentration?"
                    )
                  }
                >
                  Ask StockSage about trimming
                </button>
              </>
            ) : (
              <p className="text-[13px] text-[var(--ink-3)]">
                No holdings to analyse yet.
              </p>
            )}
          </div>
        </div>
      )}

      {lens === "correlation" && <CorrelationHeatmap data={data.correlation} />}

      {lens === "volatility" && (
        <div className="flex flex-col gap-3.5">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
            <VaRCard data={data.var} />
            <DrawdownChart data={data.drawdown} />
          </div>

          {/* Monte Carlo fan (illustrative) */}
          <div className="pf-card" style={{ padding: 18 }}>
            <div className="flex items-center justify-between mb-1">
              <div className="ttl">1-YEAR MONTE CARLO · OUTCOME FAN</div>
              <span className="pf-pill violet">PRO</span>
            </div>
            <p className="text-[12px] text-[var(--ink-3)] mb-2">
              Where your portfolio could land over a year, given its risk
              profile.
            </p>
            <MonteCarloFan />
            <IllustrativeNote>
              Example fan shape. Per-path simulation on your live book is coming
              with the risk compute backend (MONEY-487) — these percentiles are
              not yet your real numbers.
            </IllustrativeNote>
          </div>

          {/* Drawdown waterfall (illustrative) */}
          <div className="pf-card" style={{ padding: 18 }}>
            <div className="ttl mb-1">WHAT CAUSED THE DRAWDOWN</div>
            <p className="text-[12px] text-[var(--ink-3)] mb-2">
              Decomposition of a drawdown by contributing event.
            </p>
            <DrawdownWaterfall />
            <IllustrativeNote>
              Example decomposition. Event-level attribution of your actual
              drawdown is tracked in MONEY-487.
            </IllustrativeNote>
          </div>
        </div>
      )}

      {lens === "returns" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
          <RiskMetricsCard data={data.riskAdjustedReturns} />
          <ComingSoon
            title="Returns attribution"
            body="Brinson-Fachler breakdown of where your returns came from — stock selection vs sector allocation vs timing — needs a benchmarked return series. Tracked in MONEY-487."
            icon={<TrendingUp className="h-9 w-9" />}
          />
        </div>
      )}

      {lens === "style" && (
        <ComingSoon
          title="Style & factor exposure"
          body="Value/Growth/Momentum/Quality/Size tilts vs the broad market need factor loadings per holding. The compute pipeline is tracked in MONEY-487."
          icon={<Sparkles className="h-9 w-9" />}
        />
      )}

      {lens === "fno" && (
        <div className="flex flex-col gap-3.5">
          <div
            className="pf-card tilt-l"
            style={{
              background: "var(--code-bg)",
              color: "var(--code-fg)",
              padding: 18,
            }}
          >
            <div className="flex items-center justify-between mb-3">
              <div className="ttl" style={{ color: "var(--pop-2)" }}>
                F&amp;O GREEKS · NET EXPOSURE
              </div>
              <span className="pf-pill violet">PRO</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {[
                { l: "DELTA", t: "directional bias" },
                { l: "GAMMA", t: "convexity" },
                { l: "VEGA", t: "vol exposure" },
                { l: "THETA", t: "time decay" },
              ].map((g) => (
                <div
                  key={g.l}
                  style={{
                    padding: 14,
                    background: "rgba(247,243,230,0.06)",
                    borderRadius: 9,
                    border: "1px solid rgba(247,243,230,0.1)",
                  }}
                >
                  <div
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      letterSpacing: 1.4,
                      color: "rgba(247,243,230,0.6)",
                      fontWeight: 700,
                    }}
                  >
                    {g.l}
                  </div>
                  <div
                    className="mono"
                    style={{
                      marginTop: 5,
                      fontSize: 24,
                      fontWeight: 800,
                      color: "var(--pop-2)",
                    }}
                  >
                    —
                  </div>
                  <div
                    style={{
                      marginTop: 4,
                      fontSize: 11,
                      color: "rgba(247,243,230,0.55)",
                    }}
                  >
                    {g.t}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <ComingSoon
            title="Options payoff & margin"
            body="Combined payoff at expiry, breakevens and SPAN margin stress need your live F&O positions with greeks. This is tracked in MONEY-487 — connect a broker with open F&O to light it up."
            icon={<Zap className="h-9 w-9" />}
          />
        </div>
      )}
    </div>
  );
}
