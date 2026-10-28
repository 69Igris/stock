"use client";

/**
 * Risk v2 (MONEY-485) — Calibrate section.
 *
 * Risk-tolerance questionnaire (RTQ) wizard + a tolerance band that plots the
 * user's stated tolerance against their derived portfolio Risk Number, plus a
 * behavioural-overlay placeholder.
 *
 * The RTQ score is computed live from the user's OWN answers (legitimate — it
 * is their input, not a fabricated portfolio stat). It is held in component
 * state only; persistence + the behavioural overlay (which needs trade-history
 * analytics) are tracked in MONEY-487, so they are shown as honest
 * placeholders / a "not yet saved" note.
 */

import { useState } from "react";
import type { PortfolioRiskResult } from "@/lib/actions/risk";
import { RefreshCw, User } from "lucide-react";
import RiskDialog from "../components/RiskDialog";
import { ComingSoon } from "../components/primitives";

interface Props {
  data: PortfolioRiskResult;
  ask: (q: string) => void;
}

const QUESTIONS: Array<{ q: string; opts: string[] }> = [
  {
    q: "If your portfolio dropped 25% in a month, you would…",
    opts: [
      "Sell most of it — sleep matters",
      "Sell some and wait",
      "Hold and ride it out",
      "Buy more — sale prices",
    ],
  },
  {
    q: "Your typical investment horizon is…",
    opts: ["< 1 year", "1–3 years", "3–7 years", "7+ years"],
  },
  {
    q: "Your monthly investment is what % of income?",
    opts: ["< 10%", "10–25%", "25–50%", "> 50%"],
  },
  {
    q: "An ideal year for your portfolio is…",
    opts: [
      "Steady 7% with no big drops",
      "Up 12% with a 5% mid-year dip",
      "Up 20% with a 15% dip",
      "Up 35% with a 25% dip",
    ],
  },
  {
    q: "'Market falls 8% today.' You…",
    opts: [
      "Check your portfolio compulsively",
      "Glance once and move on",
      "Use the dip to top up SIPs",
      "Don't notice — auto-investing",
    ],
  },
];

/** Derive a portfolio Risk Number (0–10) from real metrics — same blend as Snapshot. */
function portfolioRiskNumber(data: PortfolioRiskResult): number | null {
  const parts: Array<{ score: number; weight: number }> = [];
  const hhi = data.concentration?.hhi;
  if (typeof hhi === "number" && hhi > 0)
    parts.push({ score: Math.min(10, (hhi / 2500) * 10), weight: 0.3 });
  const beta = data.beta?.beta;
  if (typeof beta === "number")
    parts.push({
      score: Math.min(10, Math.max(0, (beta - 0.3) * 6.5)),
      weight: 0.25,
    });
  const vol = data.riskAdjustedReturns?.annualizedVolatility;
  if (typeof vol === "number" && vol > 0)
    parts.push({ score: Math.min(10, (vol / 33) * 10), weight: 0.25 });
  const maxDD = data.drawdown?.maxDrawdown;
  if (typeof maxDD === "number")
    parts.push({
      score: Math.min(10, (Math.abs(maxDD) / 0.4) * 9),
      weight: 0.2,
    });
  if (parts.length === 0) return null;
  const totalW = parts.reduce((s, p) => s + p.weight, 0);
  return (
    Math.round(
      parts.reduce((s, p) => s + p.score * (p.weight / totalW), 0) * 10
    ) / 10
  );
}

export default function CalibrateSection({ data, ask }: Props) {
  const [rtqOpen, setRtqOpen] = useState(false);
  // Tolerance from the user's own RTQ answers (null until taken this session).
  const [tolerance, setTolerance] = useState<number | null>(null);
  const portfolioScore = portfolioRiskNumber(data);

  return (
    <div className="flex flex-col gap-4">
      <div className="pf-sec-h flex-wrap">
        <span className="n">05 · CALIBRATE</span>
        <h3>
          Set your own <span className="ser">tolerance.</span>
        </h3>
        <span className="rule hidden sm:block" />
        <button className="pf-bs sm" onClick={() => setRtqOpen(true)}>
          <RefreshCw className="h-3 w-3" />{" "}
          {tolerance === null ? "Take the RTQ" : "Re-take RTQ"}
        </button>
      </div>

      {/* Three summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
        <div className="pf-card" style={{ padding: 18 }}>
          <div className="ttl">RTQ STATUS</div>
          <div className="mono text-[24px] font-extrabold mt-2 tracking-[-0.5px] text-[var(--ink)]">
            {tolerance === null ? "Not taken" : "Just now"}
          </div>
          <span className="pf-pill coral mt-2">
            {tolerance === null ? "5 questions · 60 sec" : "saved this session"}
          </span>
        </div>

        <div
          className="pf-card tilt-r"
          style={{ background: "var(--paper-2)", padding: 18 }}
        >
          <div className="ttl">YOUR TOLERANCE</div>
          {tolerance === null ? (
            <div className="ser text-[14px] text-[var(--ink-3)] mt-2 leading-snug">
              Take the questionnaire to set this.
            </div>
          ) : (
            <>
              <div
                className="mono"
                style={{
                  fontSize: 44,
                  fontWeight: 800,
                  marginTop: 4,
                  letterSpacing: -1.2,
                  color: "var(--emerald-text)",
                }}
              >
                {tolerance.toFixed(1)}
                <span style={{ fontSize: 18, color: "var(--ink-3)" }}>/10</span>
              </div>
              <div className="ser text-[14px] text-[var(--ink-3)] mt-1.5">
                {tolerance >= 7
                  ? "Aggressive — comfortable with big swings."
                  : tolerance >= 4
                    ? "Balanced — moderate growth, low panic."
                    : "Conservative — steadiness first."}
              </div>
            </>
          )}
        </div>

        <div className="pf-card" style={{ padding: 18 }}>
          <div className="ttl">PORTFOLIO RISK</div>
          {portfolioScore !== null ? (
            <>
              <div
                className="mono"
                style={{
                  fontSize: 28,
                  fontWeight: 800,
                  marginTop: 8,
                  letterSpacing: -0.5,
                  color: "var(--pop-1-text)",
                }}
              >
                {portfolioScore.toFixed(1)}
                <span style={{ fontSize: 16, color: "var(--ink-3)" }}>/10</span>
              </div>
              <div className="ser text-[13.5px] text-[var(--ink-3)] mt-1.5">
                {tolerance !== null
                  ? portfolioScore > tolerance + 1
                    ? "Above your comfort zone."
                    : "In line with your tolerance."
                  : "Take the RTQ to compare."}
              </div>
            </>
          ) : (
            <div className="ser text-[14px] text-[var(--ink-3)] mt-2 leading-snug">
              Needs price history to compute.
            </div>
          )}
        </div>
      </div>

      {/* Tolerance band */}
      {(tolerance !== null || portfolioScore !== null) && (
        <div className="pf-card" style={{ padding: 18 }}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div>
              <div className="ttl">TOLERANCE BAND</div>
              <div className="text-[13.5px] text-[var(--ink-2)] mt-1">
                Where <b>you</b> sit vs where <b>your portfolio</b> sits.
              </div>
            </div>
            <span className="mono text-[11px] text-[var(--ink-3)]">
              1 = conservative · 10 = aggressive
            </span>
          </div>
          <div className="relative mt-5 h-9">
            <div
              className="absolute left-0 right-0"
              style={{
                top: 14,
                height: 14,
                background:
                  "linear-gradient(90deg, var(--emerald), var(--pop-2) 45%, var(--pop-1))",
                border: "1.5px solid var(--ink)",
                borderRadius: 99,
              }}
            />
            {tolerance !== null && (
              <div
                className="absolute"
                style={{
                  left: `${(tolerance / 10) * 100}%`,
                  top: 0,
                  height: "100%",
                  width: 4,
                  background: "var(--ink)",
                  borderRadius: 2,
                }}
              >
                <span
                  className="mono absolute"
                  style={{
                    top: -16,
                    left: "50%",
                    transform: "translateX(-50%)",
                    fontSize: 10,
                    fontWeight: 700,
                    whiteSpace: "nowrap",
                  }}
                >
                  YOU · {tolerance.toFixed(1)}
                </span>
              </div>
            )}
            {portfolioScore !== null && (
              <div
                className="absolute"
                style={{
                  left: `${(portfolioScore / 10) * 100}%`,
                  top: 18,
                  transform: "translateX(-50%)",
                }}
              >
                <div
                  style={{
                    width: 14,
                    height: 14,
                    border: "2px solid var(--ink)",
                    background: "var(--pop-1)",
                    transform: "rotate(45deg)",
                    borderRadius: 2,
                  }}
                />
                <span
                  className="mono absolute"
                  style={{
                    top: 20,
                    left: "50%",
                    transform: "translateX(-50%)",
                    fontSize: 10,
                    fontWeight: 700,
                    color: "var(--pop-1-text)",
                    whiteSpace: "nowrap",
                  }}
                >
                  PORTFOLIO · {portfolioScore.toFixed(1)}
                </span>
              </div>
            )}
          </div>
          <div className="flex justify-between mt-7 mono text-[9.5px] text-[var(--ink-3)]">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <span key={n}>{n}</span>
            ))}
          </div>
        </div>
      )}

      {/* Behavioural overlay placeholder */}
      <ComingSoon
        title="Behavioural overlay"
        body="We adjust your stated tolerance down when your trades say otherwise — e.g. selling into dips. This needs trade-history analytics, tracked in MONEY-487."
        icon={<User className="h-9 w-9" />}
      />

      <p
        className="text-[11px] text-[var(--ink-3)] pt-1"
        style={{ borderTop: "1px dashed var(--rule-soft)", paddingTop: 10 }}
      >
        Your RTQ answers are scored locally for now and aren&apos;t saved
        between visits yet (persistence: MONEY-487).
      </p>

      <RTQDialog
        open={rtqOpen}
        onClose={() => setRtqOpen(false)}
        onComplete={(score) => setTolerance(score)}
        portfolioScore={portfolioScore}
        ask={ask}
      />
    </div>
  );
}

/* ── RTQ wizard dialog ───────────────────────────────────────────── */

function RTQDialog({
  open,
  onClose,
  onComplete,
  portfolioScore,
  ask,
}: {
  open: boolean;
  onClose: () => void;
  onComplete: (score: number) => void;
  portfolioScore: number | null;
  ask: (q: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<number, number>>({});
  const [done, setDone] = useState(false);

  // 0–10 tolerance: average of (option index 0..3 → 1.5..10), from the user's answers.
  const score = (() => {
    const vals = Object.values(answers);
    if (vals.length === 0) return 0;
    const avg = vals.reduce((s, v) => s + (v / 3) * 8.5 + 1.5, 0) / vals.length;
    return Math.round(avg * 10) / 10;
  })();

  const reset = () => {
    setStep(0);
    setAnswers({});
    setDone(false);
  };

  const select = (optIdx: number) => {
    const next = { ...answers, [step]: optIdx };
    setAnswers(next);
    if (step < QUESTIONS.length - 1) {
      setTimeout(() => setStep(step + 1), 180);
    } else {
      setTimeout(() => setDone(true), 180);
    }
  };

  const close = () => {
    onClose();
    setTimeout(reset, 200);
  };

  return (
    <RiskDialog
      open={open}
      onClose={close}
      eyebrow="RISK TOLERANCE QUESTIONNAIRE"
      title={
        done
          ? "Your tolerance score"
          : `Question ${step + 1} of ${QUESTIONS.length}`
      }
    >
      {!done ? (
        <div className="flex flex-col gap-3">
          {/* Progress */}
          <div
            className="w-full rounded-full h-1.5 overflow-hidden"
            style={{ background: "var(--rule-softer)" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${((step + 1) / QUESTIONS.length) * 100}%`,
                background: "var(--emerald)",
              }}
            />
          </div>
          <div className="ser text-[19px] text-[var(--ink)] leading-snug tracking-[-0.3px]">
            {QUESTIONS[step].q}
          </div>
          <div className="flex flex-col gap-2">
            {QUESTIONS[step].opts.map((o, i) => (
              <button
                key={o}
                className="pf-card flat text-left flex items-center gap-2.5"
                style={{ padding: "12px 14px" }}
                onClick={() => select(i)}
              >
                <span
                  className="mono"
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 6,
                    background: "var(--rule-softer)",
                    border: "1.5px solid var(--rule-soft)",
                    display: "grid",
                    placeItems: "center",
                    fontSize: 11,
                    color: "var(--ink-3)",
                    flexShrink: 0,
                  }}
                >
                  {String.fromCharCode(65 + i)}
                </span>
                <span className="text-[13.5px] text-[var(--ink-2)]">{o}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between mt-1">
            <button
              className="pf-bf sm"
              disabled={step === 0}
              style={{ opacity: step === 0 ? 0.5 : 1 }}
              onClick={() => step > 0 && setStep(step - 1)}
            >
              ← Back
            </button>
            <span className="mono text-[11px] text-[var(--ink-3)]">
              ~60 seconds
            </span>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col items-center gap-2">
            <div
              className="mono"
              style={{
                fontSize: 56,
                fontWeight: 800,
                letterSpacing: -2,
                color: "var(--emerald-text)",
              }}
            >
              {score.toFixed(1)}
              <span style={{ fontSize: 22, color: "var(--ink-3)" }}>/10</span>
            </div>
            <span className="mono text-[11px] uppercase tracking-[1.2px] text-[var(--ink-3)]">
              your tolerance ·{" "}
              {score >= 7
                ? "aggressive"
                : score >= 4
                  ? "balanced"
                  : "conservative"}
            </span>
          </div>

          {portfolioScore !== null && portfolioScore > score + 1 && (
            <div
              className="rounded-lg p-3"
              style={{
                background: "var(--rule-softer)",
                border: "1.5px solid var(--pop-2)",
              }}
            >
              <div className="flex items-start gap-2">
                <div className="text-[13px] text-[var(--ink-2)] leading-relaxed">
                  Your portfolio sits at{" "}
                  <b className="mono" style={{ color: "var(--pop-1-text)" }}>
                    {portfolioScore.toFixed(1)}
                  </b>{" "}
                  but your comfort zone is{" "}
                  <b className="mono" style={{ color: "var(--emerald-text)" }}>
                    {score.toFixed(1)}
                  </b>
                  . Decide has three moves to close that gap.
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button className="pf-bf sm" onClick={close}>
              Maybe later
            </button>
            <button
              className="pf-bs sm"
              onClick={() => {
                onComplete(score);
                close();
                ask(
                  "How do I bring my portfolio risk in line with my risk tolerance?"
                );
              }}
            >
              Show me how to close the gap →
            </button>
          </div>
        </div>
      )}
    </RiskDialog>
  );
}
