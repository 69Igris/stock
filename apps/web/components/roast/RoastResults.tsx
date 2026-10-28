"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  TrendingUp,
  TrendingDown,
  Flame,
  ThumbsUp,
  AlertTriangle,
  RefreshCw,
} from "lucide-react";
import RoastScoreGauge from "./RoastScoreGauge";
import {
  pickVerdictLine,
  top5SectorConcentration,
  sectorHHI as computeSectorHHI,
  cashAllocation,
} from "./roast-detail-logic";
import type { StructuredRoastResult } from "@usemoney/types";

interface RoastResultsProps {
  result: StructuredRoastResult;
  periodLabel?: string;
  onRoastAgain?: () => void;
}

function isNarrativeDisplayable(text: string): boolean {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[") || t.startsWith("```"))
    return false;
  try {
    JSON.parse(t);
    return false;
  } catch {
    return true;
  }
}

/** Verdict → token color (progress-bar fill). Overweight=coral, underweight=gold, fair=emerald. */
function getVerdictColor(verdict: string): string {
  switch (verdict) {
    case "overweight":
      return "var(--pop-1)";
    case "underweight":
      return "var(--pop-2)";
    case "fair":
      return "var(--emerald)";
    default:
      return "var(--ink-3)";
  }
}

/**
 * Verdict → AA-compliant token color for the verdict TEXT label (darkened
 * `-text` variants in light mode; maps to bright tokens in dark mode).
 */
function getVerdictTextColor(verdict: string): string {
  switch (verdict) {
    case "overweight":
      return "var(--pop-1-text)";
    case "underweight":
      return "var(--pop-2-text)";
    case "fair":
      return "var(--emerald-text)";
    default:
      return "var(--ink-3)";
  }
}

/** Verdict → faint token-tinted card background + matching border. */
function getVerdictBg(verdict: string): {
  background: string;
  borderColor: string;
} {
  switch (verdict) {
    case "overweight":
      return {
        background: "color-mix(in srgb, var(--pop-1) 8%, var(--paper))",
        borderColor: "color-mix(in srgb, var(--pop-1) 35%, transparent)",
      };
    case "underweight":
      return {
        background: "color-mix(in srgb, var(--pop-2) 10%, var(--paper))",
        borderColor: "color-mix(in srgb, var(--pop-2) 40%, transparent)",
      };
    case "fair":
      return {
        background: "color-mix(in srgb, var(--emerald) 8%, var(--paper))",
        borderColor: "color-mix(in srgb, var(--emerald) 35%, transparent)",
      };
    default:
      return {
        background: "var(--paper-3)",
        borderColor: "var(--rule-soft)",
      };
  }
}

export default function RoastResults({
  result,
  periodLabel,
  onRoastAgain,
}: RoastResultsProps) {
  const [showNarrative, setShowNarrative] = useState(false);
  const verdict = pickVerdictLine(result);
  const praises = result.roastHighlights.filter((h) => h.type === "praise");
  const burns = result.roastHighlights.filter((h) => h.type === "burn");

  return (
    <div className="space-y-4">
      {/* ─── Hero - flame sticker + period ──────────────────────── */}
      <div className="text-center pt-2 pb-2">
        <div
          className="w-16 h-16 rounded-[16px] mx-auto mb-4 flex items-center justify-center border-2 border-[var(--ink)]"
          style={{
            background: "var(--pop-1)",
            boxShadow: "var(--shadow-hard)",
            transform: "rotate(-3deg)",
          }}
        >
          <Flame className="h-8 w-8" style={{ color: "#1d1d1b" }} />
        </div>
        <h2
          className="font-extrabold text-3xl text-[var(--ink)]"
          style={{ letterSpacing: "-0.8px" }}
        >
          Portfolio Roast
          {periodLabel && (
            <>
              {" · "}
              <span style={{ color: "var(--pop-1-text)" }}>{periodLabel}</span>
            </>
          )}
        </h2>
        <p className="ser text-[17px] text-[var(--ink-3)] mt-1">
          Brutally honest AI critique. Sugar-free. Skim-safe.
        </p>
      </div>

      {/* ─── THE VERDICT card - coral roast identity ──────────────── */}
      <div
        className="pf-card tilt-l"
        style={{
          background: "color-mix(in srgb, var(--pop-1) 7%, var(--paper))",
          borderColor: "var(--pop-1)",
        }}
      >
        <div
          className="mono font-bold text-[10px] mb-3 uppercase"
          style={{ color: "var(--pop-1-text)", letterSpacing: "2px" }}
        >
          The Verdict
        </div>
        <div
          className="font-extrabold text-2xl leading-snug text-[var(--ink)] mb-3"
          style={{ letterSpacing: "-0.5px" }}
        >
          {verdict.headline}
        </div>
        <p className="text-sm leading-relaxed text-[var(--ink-2)]">
          {verdict.body}
        </p>
      </div>

      {/* ─── DOING RIGHT + FIX THIS two-up ────────────────────────── */}
      {(praises.length > 0 || burns.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {praises.length > 0 && (
            <div
              className="pf-card"
              style={{
                background:
                  "color-mix(in srgb, var(--emerald) 7%, var(--paper))",
                borderColor:
                  "color-mix(in srgb, var(--emerald) 40%, transparent)",
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <ThumbsUp
                  className="h-4 w-4"
                  style={{ color: "var(--emerald-text)" }}
                />
                <div
                  className="mono font-bold text-[10px] uppercase"
                  style={{ color: "var(--emerald-text)", letterSpacing: "2px" }}
                >
                  Doing Right
                </div>
              </div>
              <ul className="space-y-2.5">
                {praises.map((p, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--ink-2)]"
                  >
                    {p.emoji ? (
                      <span className="text-base flex-shrink-0 leading-none mt-0.5">
                        {p.emoji}
                      </span>
                    ) : (
                      <span
                        style={{ color: "var(--emerald-text)" }}
                        className="mt-0.5"
                      >
                        ·
                      </span>
                    )}
                    <span>
                      <span className="font-semibold text-[var(--ink)]">
                        {p.title}.
                      </span>{" "}
                      {p.description}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {burns.length > 0 && (
            <div
              className="pf-card"
              style={{
                background: "color-mix(in srgb, var(--pop-1) 7%, var(--paper))",
                borderColor:
                  "color-mix(in srgb, var(--pop-1) 40%, transparent)",
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle
                  className="h-4 w-4"
                  style={{ color: "var(--pop-1-text)" }}
                />
                <div
                  className="mono font-bold text-[10px] uppercase"
                  style={{ color: "var(--pop-1-text)", letterSpacing: "2px" }}
                >
                  Fix This
                </div>
              </div>
              <ul className="space-y-2.5">
                {burns.map((b, i) => (
                  <li
                    key={i}
                    className="flex items-start gap-2 text-[13px] leading-relaxed text-[var(--ink-2)]"
                  >
                    {b.emoji ? (
                      <span className="text-base flex-shrink-0 leading-none mt-0.5">
                        {b.emoji}
                      </span>
                    ) : (
                      <span
                        style={{ color: "var(--pop-1-text)" }}
                        className="mt-0.5"
                      >
                        ·
                      </span>
                    )}
                    <span>
                      <span className="font-semibold text-[var(--ink)]">
                        {b.title}.
                      </span>{" "}
                      {b.description}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ─── Score gauge + 8-axis breakdown ───────────────────────── */}
      <div className="pf-card">
        <div className="flex flex-col lg:flex-row items-center gap-8">
          <div
            className="flex flex-col items-center flex-shrink-0"
            data-walkthrough="roast-score"
          >
            <RoastScoreGauge score={result.overallScore} size="lg" />
            <p
              className="mt-2 mono text-[10px] font-bold uppercase text-[var(--ink-3)]"
              style={{ letterSpacing: "1.5px" }}
            >
              Overall Score
            </p>
          </div>
          <div className="flex-1 w-full" data-walkthrough="roast-breakdown">
            {/* Header: 8 AXES caption + LIVE/NEEDS BACKEND counters */}
            <div className="flex items-center gap-2.5 mb-4 flex-wrap">
              <div
                className="mono font-bold text-[10px] uppercase text-[var(--ink-3)]"
                style={{ letterSpacing: "2px" }}
              >
                Score Breakdown · 8 Axes
              </div>
              <div className="flex-1 h-[1.5px] min-w-[16px] bg-[var(--rule-soft)]" />
              <span
                className="pf-pill emerald"
                style={{ fontSize: 9.5, padding: "2px 7px" }}
              >
                4 LIVE
              </span>
              <span
                className="pf-pill outline"
                style={{
                  fontSize: 9.5,
                  padding: "2px 7px",
                  color: "var(--pop-2-text)",
                  borderColor: "var(--pop-2)",
                }}
              >
                4 NEEDS BACKEND
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* 4 live axes - sourced from result.scoreBreakdown */}
              {(
                [
                  ["Diversification", result.scoreBreakdown.diversification],
                  ["Risk control", result.scoreBreakdown.riskManagement],
                  ["Stock quality", result.scoreBreakdown.stockPicking],
                  ["Cost discipline", result.scoreBreakdown.timing],
                ] as const
              ).map(([label, data]) => (
                <ScoreAxis
                  key={label}
                  label={label}
                  score={data.score}
                  comment={data.comment}
                />
              ))}
              {/* 4 needs-backend axes - placeholder bars with status dot */}
              {(
                [
                  ["Timing & entry", 60],
                  ["Tax efficiency", 65],
                  ["Behaviour gap", 55],
                  ["Style drift", 60],
                ] as const
              ).map(([label, score]) => (
                <ScoreAxis
                  key={label}
                  label={label}
                  score={score}
                  comment="Needs trade-history ingestion"
                  backend
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ─── Top / Worst performers ──────────────────────────────── */}
      {(result.topPerformers.length > 0 ||
        result.worstPerformers.length > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {result.topPerformers.length > 0 && (
            <div
              className="pf-card"
              style={{
                background:
                  "color-mix(in srgb, var(--emerald) 7%, var(--paper))",
                borderColor:
                  "color-mix(in srgb, var(--emerald) 40%, transparent)",
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <TrendingUp
                  className="h-4 w-4"
                  style={{ color: "var(--emerald-text)" }}
                />
                <div
                  className="mono font-bold text-[10px] uppercase"
                  style={{ color: "var(--emerald-text)", letterSpacing: "2px" }}
                >
                  Top Performers
                </div>
              </div>
              <div className="space-y-2">
                {result.topPerformers.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between py-1.5 border-b border-dashed border-[var(--rule-soft)] last:border-0"
                  >
                    <div className="min-w-0 flex-1 pr-3">
                      <span
                        className="mono font-bold text-sm"
                        style={{ color: "var(--emerald-text)" }}
                      >
                        {p.symbol}
                      </span>
                      <p className="text-xs text-[var(--ink-3)] truncate">
                        {p.roast}
                      </p>
                    </div>
                    <span
                      className="mono text-sm font-bold tabular-nums shrink-0"
                      style={{ color: "var(--emerald-text)" }}
                    >
                      +{p.pnlPercent.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {result.worstPerformers.length > 0 && (
            <div
              className="pf-card"
              style={{
                background: "color-mix(in srgb, var(--pop-1) 7%, var(--paper))",
                borderColor:
                  "color-mix(in srgb, var(--pop-1) 40%, transparent)",
              }}
            >
              <div className="flex items-center gap-2 mb-3">
                <TrendingDown
                  className="h-4 w-4"
                  style={{ color: "var(--pop-1-text)" }}
                />
                <div
                  className="mono font-bold text-[10px] uppercase"
                  style={{ color: "var(--pop-1-text)", letterSpacing: "2px" }}
                >
                  Worst Performers
                </div>
              </div>
              <div className="space-y-2">
                {result.worstPerformers.map((p, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between py-1.5 border-b border-dashed border-[var(--rule-soft)] last:border-0"
                  >
                    <div className="min-w-0 flex-1 pr-3">
                      <span
                        className="mono font-bold text-sm"
                        style={{ color: "var(--pop-1-text)" }}
                      >
                        {p.symbol}
                      </span>
                      <p className="text-xs text-[var(--ink-3)] truncate">
                        {p.roast}
                      </p>
                    </div>
                    <span
                      className="mono text-sm font-bold tabular-nums shrink-0"
                      style={{ color: "var(--pop-1-text)" }}
                    >
                      {p.pnlPercent.toFixed(1)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ─── Sector analysis ──────────────────────────────────────── */}
      {result.sectorAnalysis.length > 0 && (
        <div className="pf-card tilt-r">
          <div
            className="mono font-bold text-[11px] uppercase text-[var(--ink)] mb-3"
            style={{ letterSpacing: "1.2px" }}
          >
            Sector Breakdown
          </div>
          <div className="space-y-2">
            {result.sectorAnalysis.map((s, i) => {
              const vBg = getVerdictBg(s.verdict);
              const vColor = getVerdictColor(s.verdict);
              const vTextColor = getVerdictTextColor(s.verdict);
              return (
                <div
                  key={i}
                  className="flex items-center justify-between p-2.5 rounded-[10px] border"
                  style={vBg}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="font-semibold text-sm text-[var(--ink-2)] w-24 truncate">
                      {s.sector}
                    </span>
                    <div className="w-20 rounded-full h-1.5 overflow-hidden shrink-0 border border-[var(--rule-soft)] bg-[var(--rule-softer)]">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.min(s.percentage, 100)}%`,
                          background: vColor,
                        }}
                      />
                    </div>
                    <span className="text-xs text-[var(--ink-3)] mono tabular-nums shrink-0">
                      {s.percentage}%
                    </span>
                  </div>
                  <span
                    className="text-xs font-bold capitalize shrink-0 ml-2"
                    style={{ color: vTextColor }}
                  >
                    {s.verdict}
                  </span>
                </div>
              );
            })}
          </div>
          {result.sectorAnalysis.some((s) => s.comment) && (
            <div className="mt-3 space-y-1">
              {result.sectorAnalysis.map(
                (s, i) =>
                  s.comment && (
                    <p key={i} className="text-xs text-[var(--ink-3)]">
                      <span className="font-semibold text-[var(--ink-2)]">
                        {s.sector}:
                      </span>{" "}
                      {s.comment}
                    </p>
                  )
              )}
            </div>
          )}
        </div>
      )}

      {/* ─── Deep Diagnostics tiles ───────────────────────────────── */}
      <DeepDiagnostics result={result} />

      {/* ─── Action Items (numbered, prioritized) ─────────────────── */}
      {result.constructiveAdvice.length > 0 && (
        <div
          data-walkthrough="roast-suggestions"
          className="pf-card overflow-hidden"
          style={{ padding: 0 }}
        >
          <div className="px-[22px] py-4 border-b-2 border-[var(--ink)] flex items-center gap-2.5">
            <div
              className="mono font-bold text-[10px] uppercase text-[var(--ink)]"
              style={{ letterSpacing: "2px" }}
            >
              Action Items
            </div>
            <span
              className="pf-pill"
              style={{
                fontSize: 9.5,
                padding: "2px 7px",
                background: "var(--pop-2)",
                color: "#1d1d1b",
              }}
            >
              Prioritized
            </span>
          </div>
          {result.constructiveAdvice.map((a, i, arr) => (
            <div
              key={i}
              className={`flex items-center gap-3.5 px-[22px] py-3.5 ${i === arr.length - 1 ? "" : "border-b border-dashed border-[var(--rule-soft)]"}`}
            >
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center mono text-[11px] font-bold flex-shrink-0 border-[1.5px]"
                style={{
                  background: "var(--pop-1)",
                  borderColor: "var(--ink)",
                  color: "#1d1d1b",
                }}
              >
                {i + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-[13.5px] text-[var(--ink-2)] leading-[1.5] font-semibold">
                  {a.title}
                </div>
                {a.description && (
                  <div className="text-[12.5px] text-[var(--ink-3)] mt-0.5 leading-[1.5]">
                    {a.description}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── Backend Gaps - shows what's not yet wired ────────────── */}
      <BackendGaps />

      {/* ─── Full narrative (collapsible) ─────────────────────────── */}
      {result.roastNarrative &&
        isNarrativeDisplayable(result.roastNarrative) && (
          <div className="pf-card">
            <button
              onClick={() => setShowNarrative(!showNarrative)}
              className="flex items-center justify-between w-full text-sm text-[var(--ink-2)] hover:text-[var(--ink)] transition-colors"
            >
              <span className="font-semibold">Read the full roast</span>
              {showNarrative ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </button>
            {showNarrative && (
              <div className="mt-3 pt-3 border-t border-dashed border-[var(--rule-soft)]">
                <p className="text-sm text-[var(--ink-2)] whitespace-pre-line leading-relaxed">
                  {result.roastNarrative}
                </p>
              </div>
            )}
          </div>
        )}

      {/* ─── Disclaimer ───────────────────────────────────────────── */}
      {result.disclaimer && (
        <p className="ser text-xs text-[var(--ink-3)] text-center px-4">
          {result.disclaimer}
        </p>
      )}

      {/* ─── Roast me again CTA ──────────────────────────────────── */}
      {onRoastAgain && (
        <div className="pt-2">
          <button
            type="button"
            onClick={onRoastAgain}
            className="pf-bs lg w-full justify-center"
            style={{ background: "var(--pop-1)", color: "#1d1d1b" }}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Roast me again
          </button>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/* ScoreAxis - single 0-100 progress bar with backend-pending indicator   */
/* ────────────────────────────────────────────────────────────────────── */

function ScoreAxis({
  label,
  score,
  comment,
  backend = false,
}: {
  label: string;
  score: number;
  comment?: string;
  backend?: boolean;
}) {
  const color =
    score >= 75
      ? "var(--emerald)"
      : score >= 60
        ? "var(--pop-2)"
        : "var(--pop-1)";
  // AA-compliant token for the numeric score TEXT; `color` stays bright for the
  // bar gradient fill.
  const textColor =
    score >= 75
      ? "var(--emerald-text)"
      : score >= 60
        ? "var(--pop-2-text)"
        : "var(--pop-1-text)";
  const faded = `color-mix(in srgb, ${color} 40%, transparent)`;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-1.5 mb-1">
        <span
          className="mono font-bold text-[10px] uppercase text-[var(--ink-3)] tracking-[1.2px] truncate flex items-center gap-1"
          title={label}
        >
          {backend && (
            <span
              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
              style={{ background: "var(--pop-2)" }}
              title="needs backend"
            />
          )}
          {label}
        </span>
        <span
          className="mono text-sm font-bold tabular-nums flex-shrink-0"
          style={{ color: textColor }}
        >
          {score}
          <span className="text-[var(--ink-4)] text-[10px]">/100</span>
        </span>
      </div>
      <div className="h-[6px] rounded-full overflow-hidden border border-[var(--rule-soft)] bg-[var(--rule-softer)]">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{
            width: `${score}%`,
            background: backend
              ? `repeating-linear-gradient(90deg,${color},${color} 4px,${faded} 4px,${faded} 8px)`
              : `linear-gradient(90deg,${color},${faded})`,
          }}
        />
      </div>
      {comment && (
        <p className="text-[10.5px] text-[var(--ink-3)] leading-[1.4]">
          {comment}
        </p>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/* Deep Diagnostics - derived from existing data + clearly-flagged gaps   */
/* ────────────────────────────────────────────────────────────────────── */

interface DeepDiagnosticsProps {
  result: StructuredRoastResult;
}

type Tone = "ok" | "warn" | "neg" | "mute";
type Status = "live" | "backend" | "estimated";

function DiagTile({
  label,
  value,
  sub,
  tone = "mute",
  status = "live",
  backendNote,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
  status?: Status;
  backendNote?: string;
}) {
  // `v` is the big VALUE text → AA-compliant `-text` variants; `glow` is a
  // faint background tint → keep the bright token.
  const tones: Record<Tone, { v: string; glow: string }> = {
    ok: {
      v: "var(--emerald-text)",
      glow: "color-mix(in srgb, var(--emerald) 8%, transparent)",
    },
    warn: {
      v: "var(--pop-2-text)",
      glow: "color-mix(in srgb, var(--pop-2) 8%, transparent)",
    },
    neg: {
      v: "var(--pop-1-text)",
      glow: "color-mix(in srgb, var(--pop-1) 8%, transparent)",
    },
    mute: { v: "var(--ink)", glow: "transparent" },
  };
  const statusStyle: Record<Status, { dot: string; label: string }> = {
    live: { dot: "var(--emerald)", label: "live" },
    backend: { dot: "var(--pop-2)", label: "needs backend" },
    estimated: { dot: "var(--pop-5)", label: "estimated" },
  };
  const t = tones[tone];
  const s = statusStyle[status];
  return (
    <div
      className="rounded-[10px] p-3 relative overflow-hidden border border-[var(--rule-soft)]"
      style={{ background: "var(--paper-3)" }}
      title={backendNote || s.label}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: t.glow }}
      />
      <div className="relative flex items-center justify-between gap-1.5 mb-2">
        <div className="mono text-[10px] uppercase tracking-[0.5px] text-[var(--ink-3)] font-bold truncate min-w-0">
          {label}
        </div>
        <span
          title={s.label}
          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ background: s.dot }}
        />
      </div>
      <div
        className="relative mono font-bold text-xl tabular-nums leading-none mb-1.5"
        style={{ color: t.v, letterSpacing: "-0.5px" }}
      >
        {value}
      </div>
      {sub && (
        <div className="relative text-[11px] text-[var(--ink-3)] leading-[1.4]">
          {sub}
        </div>
      )}
      {backendNote && (
        <div
          className="relative mt-2 pt-2 mono text-[10px] leading-[1.4]"
          style={{
            borderTop:
              "1px dashed color-mix(in srgb, var(--pop-2) 35%, transparent)",
            color: "var(--pop-2-text)",
          }}
        >
          {backendNote}
        </div>
      )}
    </div>
  );
}

function DeepDiagnostics({ result }: DeepDiagnosticsProps) {
  // Derived live tiles from sectorAnalysis (proxy until per-stock
  // concentration / price-history join is ingested). Single source of truth:
  // components/roast/roast-detail-logic.ts (also unit-tested there).
  const top5Pct = top5SectorConcentration(result.sectorAnalysis);
  const sectorHHI = computeSectorHHI(result.sectorAnalysis);
  const cashPct = cashAllocation(result.sectorAnalysis);

  return (
    <div className="pf-card">
      <div className="flex items-center gap-2.5 mb-1">
        <div
          className="mono font-bold text-[10px] uppercase text-[var(--ink)]"
          style={{ letterSpacing: "2px" }}
        >
          Deep Diagnostics
        </div>
        <div className="flex-1 h-[1.5px] bg-[var(--rule-soft)]" />
      </div>
      <div className="text-[12px] text-[var(--ink-3)] mb-3 leading-[1.55]">
        Tiles marked{" "}
        <span style={{ color: "var(--pop-2-text)" }} className="font-semibold">
          ● needs backend
        </span>{" "}
        require new data ingestion. Tiles marked{" "}
        <span style={{ color: "var(--pop-5-text)" }} className="font-semibold">
          ● estimated
        </span>{" "}
        are inferred from current snapshot.
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {/* Live tiles - derived from existing data */}
        <DiagTile
          label="Concentration · top 5"
          value={`${Math.round(top5Pct)}%`}
          sub="benchmark: 38%"
          tone={top5Pct > 60 ? "warn" : "ok"}
          status="live"
        />
        <DiagTile
          label="Sector HHI"
          value={sectorHHI.toFixed(2)}
          sub={
            sectorHHI > 0.18 ? "moderately concentrated" : "well diversified"
          }
          tone={sectorHHI > 0.18 ? "warn" : "ok"}
          status="live"
        />
        <DiagTile
          label="Cash allocation"
          value={cashPct != null ? `${cashPct}%` : "-"}
          sub={
            cashPct != null && cashPct < 5 ? "below 5% threshold" : "healthy"
          }
          tone={cashPct == null || cashPct < 5 ? "warn" : "ok"}
          status="live"
        />
        {/* Backend-required tiles - gracefully flagged */}
        <DiagTile
          label="Beta vs Nifty 50"
          value="-"
          sub="defensive vs aggressive tilt"
          tone="mute"
          status="backend"
          backendNote="needs daily price-history join"
        />
        <DiagTile
          label="Rolling 1Y vol"
          value="-"
          sub="vs Nifty"
          tone="mute"
          status="backend"
          backendNote="needs daily price returns"
        />
        <DiagTile
          label="Max drawdown · 1Y"
          value="-"
          sub="peak-to-trough"
          tone="mute"
          status="backend"
          backendNote="needs portfolio-value time series"
        />
        <DiagTile
          label="Behaviour gap"
          value="-"
          sub="vs buy-and-hold"
          tone="mute"
          status="backend"
          backendNote="needs trade-history ingestion"
        />
        <DiagTile
          label="XIRR · since inception"
          value="-"
          sub="lots-adjusted"
          tone="mute"
          status="backend"
          backendNote="needs CA-adjusted lot tracking"
        />
        <DiagTile
          label="Stop-loss discipline"
          value="-"
          sub="positions w/ SL set"
          tone="mute"
          status="backend"
          backendNote="needs SL field on holdings API"
        />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/* Backend Gaps - what data unlocks deeper roasts                         */
/* ────────────────────────────────────────────────────────────────────── */

function BackendGaps() {
  const gaps: Array<{
    name: string;
    unlocks: string;
    priority: "P0" | "P1" | "P2";
    effort: "S" | "M" | "L";
    source: string;
  }> = [
    {
      name: "Trade-history ingestion",
      unlocks: "Behaviour gap · entry timing · churn rate · realised PnL split",
      priority: "P0",
      effort: "M",
      source: "broker tradebook API",
    },
    {
      name: "Tax-lot / FIFO tracker",
      unlocks: "LTCG headroom · loss-harvest opp · tax-drag estimate",
      priority: "P0",
      effort: "M",
      source: "derived from tradebook",
    },
    {
      name: "Stop-loss state per holding",
      unlocks: "Risk discipline score · auto-alert when SL breached",
      priority: "P1",
      effort: "S",
      source: "broker GTT/SL API",
    },
    {
      name: "CA-adjusted price history",
      unlocks: "True XIRR · split/bonus normalised drawdown",
      priority: "P1",
      effort: "M",
      source: "BSE/NSE corp-action feed",
    },
    {
      name: "Factor-model snapshot",
      unlocks: "Style drift · size/value/momentum/quality tilts",
      priority: "P2",
      effort: "L",
      source: "Fama-French daily factors",
    },
    {
      name: "ITR-83 holding-period join",
      unlocks: "Capital-gains forecast · ahead-of-FY tax planning",
      priority: "P2",
      effort: "S",
      source: "user-uploaded ITR-AIS",
    },
  ];

  // Bright tokens drive the badge BG tint (color-mix) and the card border.
  const priorityColor = (p: "P0" | "P1" | "P2") =>
    p === "P0" ? "var(--pop-1)" : p === "P1" ? "var(--pop-2)" : "var(--pop-5)";

  // AA-compliant `-text` variants drive the badge TEXT color.
  const priorityTextColor = (p: "P0" | "P1" | "P2") =>
    p === "P0"
      ? "var(--pop-1-text)"
      : p === "P1"
        ? "var(--pop-2-text)"
        : "var(--pop-5-text)";

  return (
    <div
      className="pf-card overflow-hidden"
      style={{
        background: "color-mix(in srgb, var(--pop-5) 6%, var(--paper))",
        borderColor: "color-mix(in srgb, var(--pop-5) 45%, transparent)",
      }}
    >
      <div className="flex items-center gap-2.5 mb-1">
        <div
          className="mono font-bold text-[10px] uppercase"
          style={{ color: "var(--pop-5-text)", letterSpacing: "2px" }}
        >
          Backend gaps · unlocks deeper roast
        </div>
      </div>
      <div className="text-[12.5px] text-[var(--ink-3)] mb-4 leading-[1.55]">
        5 data sources would let StockSage roast on behaviour, tax efficiency,
        and execution quality - not just allocation.
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {gaps.map((g) => (
          <div
            key={g.name}
            className="rounded-[10px] p-3 border border-[var(--rule-soft)]"
            style={{ background: "var(--paper-3)" }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span
                className="mono px-1.5 py-0.5 rounded text-[9.5px] font-bold tracking-[0.3px]"
                style={{
                  background: `color-mix(in srgb, ${priorityColor(g.priority)} 14%, transparent)`,
                  color: priorityTextColor(g.priority),
                }}
              >
                {g.priority}
              </span>
              <div className="text-[13px] font-bold text-[var(--ink)] flex-1 min-w-0 truncate">
                {g.name}
              </div>
              <span className="mono text-[9.5px] text-[var(--ink-3)] tracking-[0.3px]">
                {g.effort} effort
              </span>
            </div>
            <div className="text-[11.5px] text-[var(--ink-3)] leading-[1.5] mb-1">
              {g.unlocks}
            </div>
            <div className="mono text-[10.5px] text-[var(--ink-4)]">
              source · {g.source}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
