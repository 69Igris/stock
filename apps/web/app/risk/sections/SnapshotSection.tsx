"use client";

/**
 * Risk v2 (MONEY-485) — Snapshot section.
 *
 * Dark #1d1d1b anchor card with a big yellow Risk Number (0–10) + 4
 * mini-metrics (Beta / Max DD / Drift / tolerance), an "in plain English"
 * summary, and a real-data drivers panel.
 *
 * The Risk Number is a TRANSPARENT composite derived from the metrics the
 * backend actually returns (concentration level, beta, annualized vol, max
 * drawdown). It is labelled as a derived blend with a methodology note — it
 * is NOT a fabricated stat. Where a sub-signal is missing it is dropped from
 * the blend and the weighting renormalises. Risk tolerance comes from the
 * RTQ which the backend does not yet store, so it is shown as "not set".
 */

import type { PortfolioRiskResult } from "@/lib/actions/risk";
import { Sparkles, ArrowRight } from "lucide-react";
import { Bar } from "../components/primitives";

interface Props {
  data: PortfolioRiskResult;
  ask: (q: string) => void;
}

/** 0–10 sub-scores from each real signal (higher = riskier). */
function riskNumberFrom(data: PortfolioRiskResult): {
  score: number | null;
  parts: Array<{ label: string; score: number; weight: number }>;
} {
  const parts: Array<{ label: string; score: number; weight: number }> = [];

  // Concentration: HHI 0–10000. ~1000 ≈ low, 2500+ ≈ high.
  const hhi = data.concentration?.hhi;
  if (typeof hhi === "number" && hhi > 0) {
    parts.push({
      label: "Concentration",
      score: Math.min(10, (hhi / 2500) * 10),
      weight: 0.3,
    });
  }

  // Beta: 1.0 = market. 0.5→2, 1.0→5, 1.5→8.
  const beta = data.beta?.beta;
  if (typeof beta === "number") {
    parts.push({
      label: "Beta",
      score: Math.min(10, Math.max(0, (beta - 0.3) * 6.5)),
      weight: 0.25,
    });
  }

  // Annualized volatility: 10%→3, 20%→6, 30%→9.
  const vol = data.riskAdjustedReturns?.annualizedVolatility;
  if (typeof vol === "number" && vol > 0) {
    parts.push({
      label: "Volatility",
      score: Math.min(10, (vol / 33) * 10),
      weight: 0.25,
    });
  }

  // Max drawdown: −10%→3, −25%→6.5, −40%→9.
  const maxDD = data.drawdown?.maxDrawdown;
  if (typeof maxDD === "number") {
    parts.push({
      label: "Drawdown",
      score: Math.min(10, (Math.abs(maxDD) / 0.4) * 9),
      weight: 0.2,
    });
  }

  if (parts.length === 0) return { score: null, parts };
  const totalW = parts.reduce((s, p) => s + p.weight, 0);
  const score = parts.reduce((s, p) => s + p.score * (p.weight / totalW), 0);
  return { score: Math.round(score * 10) / 10, parts };
}

function band(score: number): { label: string; color: string } {
  if (score >= 7.5) return { label: "Aggressive", color: "var(--pop-1)" };
  if (score >= 5)
    return { label: "Moderately aggressive", color: "var(--pop-2)" };
  if (score >= 3) return { label: "Balanced", color: "var(--emerald)" };
  return { label: "Conservative", color: "var(--emerald)" };
}

export default function SnapshotSection({ data, ask }: Props) {
  const { score, parts } = riskNumberFrom(data);
  const topSector = data.concentration?.sectorWeights?.[0] ?? null;
  const topHolding = data.concentration?.topHoldings?.[0] ?? null;
  const beta = data.beta?.beta ?? null;
  const maxDD = data.drawdown?.maxDrawdown ?? null;
  const drift = data.rebalancing?.totalDrift ?? null;

  const b = score !== null ? band(score) : null;

  const miniMetrics: Array<{ l: string; v: string; d: string }> = [
    {
      l: "BETA · VS NIFTY 50",
      v: beta !== null ? beta.toFixed(2) : "—",
      d:
        beta === null
          ? "needs price history"
          : beta > 1.15
            ? "swings more than market"
            : beta < 0.85
              ? "steadier than market"
              : "tracks the market",
    },
    {
      l: "MAX DRAWDOWN",
      v: maxDD !== null ? `${(maxDD * 100).toFixed(1)}%` : "—",
      d: data.drawdown?.maxDrawdownStart
        ? new Date(data.drawdown.maxDrawdownStart).toLocaleDateString("en-IN", {
            month: "short",
            year: "numeric",
          })
        : "peak-to-trough",
    },
    {
      l: "DRIFT FROM TARGET",
      v: drift !== null ? `${(drift * 100).toFixed(1)}%` : "—",
      d:
        drift === null
          ? "—"
          : data.rebalancing?.needsRebalancing
            ? "rebalance suggested"
            : "within band",
    },
    {
      l: "YOUR TOLERANCE",
      v: "Not set",
      d: "take the RTQ →",
    },
  ];

  return (
    <div className="flex flex-col gap-[22px]">
      {/* ── Dark anchor card ── */}
      {/* Terminal band: --code-bg/--code-fg keep it dark in both themes
          (and stand it off the deep-ink page in dark mode). */}
      <div
        className="pf-card tilt-l"
        style={{
          background: "var(--code-bg)",
          color: "var(--code-fg)",
          padding: 24,
        }}
      >
        <div className="grid lg:grid-cols-2 gap-7 items-center">
          {/* Risk Number */}
          <div>
            {/* Raw --pop-2 on the dark band: the darkened -text variants are
                contrast-tuned for PAPER backgrounds and turn to mud on ink. */}
            <div className="ttl" style={{ color: "var(--pop-2)" }}>
              YOUR RISK NUMBER
            </div>
            {score !== null && b ? (
              <>
                <div
                  className="mono"
                  style={{
                    marginTop: 8,
                    fontSize: 72,
                    fontWeight: 800,
                    letterSpacing: -3,
                    color: "var(--pop-2)",
                    lineHeight: 0.95,
                  }}
                >
                  {score.toFixed(1)}
                  <span
                    style={{
                      fontSize: 28,
                      fontWeight: 600,
                      color: "rgba(247,243,230,0.45)",
                    }}
                  >
                    /10
                  </span>
                </div>
                <div
                  className="ser"
                  style={{
                    marginTop: 10,
                    fontSize: 18,
                    color: "rgba(247,243,230,0.85)",
                  }}
                >
                  {b.label}
                  {topSector ? (
                    <>
                      {" "}
                      — driven by{" "}
                      <span
                        style={{
                          fontFamily: "Inter, sans-serif",
                          fontStyle: "normal",
                          fontWeight: 700,
                          color: "var(--pop-2)",
                        }}
                      >
                        {topSector.sector}
                      </span>{" "}
                      concentration.
                    </>
                  ) : (
                    "."
                  )}
                </div>
                <div className="flex items-center gap-3 mt-3.5 flex-wrap">
                  <button
                    className="pf-bs sm"
                    style={{
                      background: "var(--pop-2)",
                      color: "#1d1d1b",
                      borderColor: "var(--pop-2)",
                    }}
                    onClick={() =>
                      ask("How do I bring my portfolio risk down?")
                    }
                  >
                    Bring it down <ArrowRight className="h-3 w-3" />
                  </button>
                  <span
                    className="pf-pill outline"
                    style={{
                      borderColor: "rgba(247,243,230,0.4)",
                      color: "rgba(247,243,230,0.7)",
                    }}
                  >
                    blended from your real metrics
                  </span>
                </div>
              </>
            ) : (
              <div
                className="ser"
                style={{
                  marginTop: 12,
                  fontSize: 18,
                  color: "rgba(247,243,230,0.7)",
                }}
              >
                Not enough price history yet to compute a risk number. Keep your
                holdings synced — beta, volatility and drawdown need ~20 days of
                data.
              </div>
            )}
          </div>

          {/* 4 mini metrics */}
          <div className="grid grid-cols-2 gap-3">
            {miniMetrics.map((m) => (
              <div
                key={m.l}
                style={{
                  padding: 14,
                  background: "rgba(247,243,230,0.06)",
                  borderRadius: 10,
                  border: "1px solid rgba(247,243,230,0.1)",
                }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 9.5,
                    letterSpacing: 1,
                    color: "rgba(247,243,230,0.65)",
                    fontWeight: 700,
                  }}
                >
                  {m.l}
                </div>
                <div
                  className="mono"
                  style={{
                    marginTop: 5,
                    fontSize: 22,
                    fontWeight: 800,
                    color: "#f7f3e6",
                    letterSpacing: -0.5,
                  }}
                >
                  {m.v}
                </div>
                <div
                  className="mono"
                  style={{
                    marginTop: 2,
                    fontSize: 10.5,
                    color: "rgba(247,243,230,0.55)",
                  }}
                >
                  {m.d}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── Drivers (real composite) ── */}
      {parts.length > 0 && (
        <div className="grid lg:grid-cols-2 gap-3.5">
          <div className="pf-card" style={{ padding: 18 }}>
            <div className="ttl">WHAT MOVES THE NEEDLE</div>
            <p className="text-[11px] text-[var(--ink-3)] mt-1 mb-3">
              Each signal scored 0–10, weighted into your Risk Number.
            </p>
            <div className="flex flex-col gap-3">
              {parts
                .slice()
                .sort((a, b2) => b2.score - a.score)
                .map((p) => (
                  <Bar
                    key={p.label}
                    label={`${p.label} · ${Math.round(p.weight * 100)}% weight`}
                    pct={p.score * 10}
                    value={`${p.score.toFixed(1)}/10`}
                    color={
                      p.score >= 7
                        ? "var(--pop-1)"
                        : p.score >= 5
                          ? "var(--pop-2)"
                          : "var(--emerald)"
                    }
                  />
                ))}
            </div>
          </div>

          {/* In plain English */}
          <div
            className="pf-card tilt-r"
            style={{
              background: "var(--pop-2)",
              border: "2px solid var(--ink)",
              boxShadow: "var(--shadow-hard)",
              padding: 18,
            }}
          >
            <div className="flex items-start gap-4">
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  background: "#1d1d1b",
                  color: "var(--pop-2)",
                  display: "grid",
                  placeItems: "center",
                  border: "2px solid #1d1d1b",
                  transform: "rotate(-4deg)",
                  flexShrink: 0,
                }}
              >
                <Sparkles className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: 1.5,
                    color: "#3a3a35",
                  }}
                >
                  IN PLAIN ENGLISH
                </div>
                <div className="text-[16px] font-extrabold text-[#1d1d1b] tracking-[-0.4px] leading-snug mt-1.5">
                  {beta !== null ? (
                    <>
                      Your book behaves{" "}
                      <span
                        style={{
                          background: "#1d1d1b",
                          color: "var(--pop-2)",
                          padding: "0 6px",
                          borderRadius: 4,
                        }}
                      >
                        {beta > 1
                          ? `${Math.round((beta - 1) * 100)}% more aggressively`
                          : `${Math.round((1 - beta) * 100)}% more defensively`}
                      </span>{" "}
                      than the market.
                    </>
                  ) : (
                    <>Here&apos;s the read on your portfolio risk.</>
                  )}
                </div>
                <div className="ser text-[14.5px] text-[#3a3a35] leading-relaxed mt-1.5">
                  {topHolding ? (
                    <>
                      {topHolding.symbol} alone is{" "}
                      {(topHolding.weight * 100).toFixed(1)}% of your book
                      {topSector ? (
                        <> and {topSector.sector} dominates your sector mix</>
                      ) : null}
                      .{" "}
                    </>
                  ) : null}
                  {data.concentration?.warnings?.[0] ??
                    "Diversification looks reasonable."}
                </div>
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <button
                    className="pf-bf sm"
                    style={{ borderColor: "#1d1d1b", color: "#1d1d1b" }}
                    onClick={() =>
                      ask("What is driving my portfolio risk number?")
                    }
                  >
                    What&apos;s driving this?
                  </button>
                  <button
                    className="pf-bs sm"
                    style={{
                      background: "#1d1d1b",
                      borderColor: "#1d1d1b",
                      color: "var(--pop-2)",
                    }}
                    onClick={() =>
                      ask("How do I bring my portfolio risk down?")
                    }
                  >
                    How do I bring it down? <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Methodology note (honest framing) */}
      <p
        className="text-[11px] text-[var(--ink-3)] pt-1"
        style={{ borderTop: "1px dashed var(--rule-soft)", paddingTop: 10 }}
      >
        <span className="mono">How we compute:</span> the Risk Number is a
        weighted blend of your concentration (HHI), beta, annualized volatility
        and max drawdown — each scored 0–10. Risk tolerance comes from the RTQ
        in Calibrate. Educational, not advice.
      </p>
    </div>
  );
}
