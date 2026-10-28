"use client";

/**
 * Risk v2 (MONEY-485) — Stress Lab section.
 *
 * Modes: Scenario library (REAL — historic crashes applied to the user's
 * actual sector mix via PortfolioRiskResult.stressTest), Scenario Studio
 * (custom slider builder — illustrative estimate), Conversational ("what if
 * NIFTY −10%" → seeds chat), Reverse stress (illustrative scenario ladder).
 *
 * The library is the only mode backed by real compute today; Studio's number
 * is a transparent linear estimate the user dials in themselves (not a server
 * metric), and reverse-stress scenarios are illustrative examples — both are
 * clearly labelled. Full backend tracked in MONEY-487.
 */

import { useState } from "react";
import type { PortfolioRiskResult } from "@/lib/actions/risk";
import {
  Grid3x3,
  Sliders,
  Sparkles,
  TrendingDown,
  Play,
  AlertTriangle,
} from "lucide-react";
import StressTestPanel from "../components/StressTestPanel";
import { fmtINRCompact } from "../components/primitives";

interface Props {
  data: PortfolioRiskResult;
  ask: (q: string) => void;
}

type Mode = "library" | "studio" | "conversational" | "reverse";

const MODES: Array<{
  id: Mode;
  label: string;
  icon: typeof Grid3x3;
  badge?: string;
}> = [
  { id: "library", label: "Scenario library", icon: Grid3x3 },
  { id: "studio", label: "Scenario Studio", icon: Sliders, badge: "PRO" },
  { id: "conversational", label: "Ask in words", icon: Sparkles },
  { id: "reverse", label: "Reverse stress", icon: TrendingDown },
];

export default function StressLabSection({ data, ask }: Props) {
  const [mode, setMode] = useState<Mode>("library");
  const portfolioValue = data.stressTest?.portfolioValue ?? null;

  return (
    <div className="flex flex-col gap-4">
      {/* Mode sub-tabs */}
      <div
        className="flex items-center gap-1.5 overflow-x-auto pb-1"
        role="tablist"
      >
        {MODES.map((m) => {
          const Icon = m.icon;
          const isActive = m.id === mode;
          return (
            <button
              key={m.id}
              role="tab"
              aria-selected={isActive}
              onClick={() => setMode(m.id)}
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
              {m.label}
              {m.badge && (
                <span
                  className="pf-pill violet"
                  style={{ fontSize: 8.5, padding: "1px 5px", border: 0 }}
                >
                  {m.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {mode === "library" && <StressTestPanel data={data} />}

      {mode === "studio" && (
        <ScenarioStudio portfolioValue={portfolioValue} ask={ask} />
      )}

      {mode === "conversational" && <ConversationalStress ask={ask} />}

      {mode === "reverse" && (
        <ReverseStress portfolioValue={portfolioValue} ask={ask} />
      )}
    </div>
  );
}

/* ── Scenario Studio (user dials a transparent linear estimate) ──── */

function ScenarioStudio({
  portfolioValue,
  ask,
}: {
  portfolioValue: number | null;
  ask: (q: string) => void;
}) {
  const [params, setParams] = useState({
    nifty: -10,
    banking: -15,
    tech: -8,
    vix: 50,
  });
  const sliders: Array<{
    k: keyof typeof params;
    label: string;
    min: number;
    max: number;
  }> = [
    { k: "nifty", label: "NIFTY", min: -50, max: 20 },
    { k: "banking", label: "Banking sector", min: -50, max: 20 },
    { k: "tech", label: "Tech sector", min: -50, max: 20 },
    { k: "vix", label: "India VIX spike", min: 0, max: 200 },
  ];
  // Transparent linear blend the USER controls — not a server metric.
  const est =
    params.nifty * 0.6 +
    params.banking * 0.15 +
    params.tech * 0.18 -
    params.vix * 0.04;
  const lossAmt = portfolioValue !== null ? (portfolioValue * est) / 100 : null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
      <div className="pf-card" style={{ padding: 18 }}>
        <div className="flex items-center justify-between mb-1">
          <div className="ttl">BUILD YOUR SCENARIO</div>
          <span className="pf-pill violet">PRO</span>
        </div>
        <p className="text-[12px] text-[var(--ink-3)] mb-4">
          Drag a slider, watch the estimate respond.
        </p>
        <div className="flex flex-col gap-3.5">
          {sliders.map((s) => (
            <div key={s.k} className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-[12.5px] text-[var(--ink-2)]">
                  {s.label}
                </span>
                <span
                  className="mono text-[13px] font-bold"
                  style={{
                    color:
                      params[s.k] < 0
                        ? "var(--pop-1-text)"
                        : params[s.k] > 0
                          ? "var(--emerald-text)"
                          : "var(--ink)",
                  }}
                >
                  {params[s.k] > 0 ? "+" : ""}
                  {params[s.k]}%
                </span>
              </div>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={0.5}
                value={params[s.k]}
                onChange={(e) =>
                  setParams({ ...params, [s.k]: parseFloat(e.target.value) })
                }
                style={{ width: "100%", accentColor: "var(--emerald)" }}
                aria-label={s.label}
              />
            </div>
          ))}
        </div>
      </div>

      <div
        className="pf-card tilt-r"
        style={{
          background: est < -10 ? "var(--paper-2)" : "var(--paper)",
          padding: 18,
        }}
      >
        <div className="ttl">ESTIMATED PORTFOLIO IMPACT</div>
        <div
          className="mono"
          style={{
            fontSize: 48,
            fontWeight: 800,
            letterSpacing: -1.5,
            color: est < 0 ? "var(--pop-1-text)" : "var(--emerald-text)",
            lineHeight: 1,
            marginTop: 8,
          }}
        >
          {est > 0 ? "+" : "−"}
          {Math.abs(est).toFixed(1)}%
        </div>
        {lossAmt !== null && (
          <div className="mono text-[14px] text-[var(--ink-2)] mt-2">
            ≈ {fmtINRCompact(lossAmt)} on {fmtINRCompact(portfolioValue)}
          </div>
        )}
        <div
          className="flex items-start gap-2 mt-4 rounded-md px-3 py-2"
          style={{
            background: "var(--rule-softer)",
            border: "1.5px dashed var(--rule-soft)",
          }}
        >
          <span className="pf-pill outline" style={{ fontSize: 9 }}>
            ILLUSTRATIVE
          </span>
          <span className="text-[11.5px] text-[var(--ink-3)] leading-snug">
            A simple linear estimate you control — not a full simulation of your
            holdings. Position-level stress is tracked in MONEY-487.
          </span>
        </div>
        <button
          className="pf-bf sm mt-3"
          onClick={() =>
            ask(
              `What if NIFTY falls ${Math.abs(params.nifty)}%, banking ${Math.abs(params.banking)}% and tech ${Math.abs(params.tech)}%?`
            )
          }
        >
          Run this with StockSage
        </button>
      </div>
    </div>
  );
}

/* ── Conversational stress (seeds the chat) ──────────────────────── */

function ConversationalStress({ ask }: { ask: (q: string) => void }) {
  const examples = [
    "What if NIFTY drops 10% next month?",
    "What if RBI hikes rates 200bps next quarter?",
    "What if my largest holding falls 25% on a guidance miss?",
    "What if FIIs sell ₹1L Cr over 30 days?",
    "Simulate a Covid-style crash on my book",
    "What if banking stocks fall 15% and the rupee drops 4%?",
  ];
  const [text, setText] = useState("");

  return (
    <div className="pf-card" style={{ padding: 18 }}>
      <div className="ttl mb-1">DESCRIBE A SCENARIO</div>
      <p className="text-[12px] text-[var(--ink-3)] mb-3">
        Type it in plain English — Sage parses the parameters and runs it.
      </p>
      <textarea
        className="pf-input"
        placeholder="e.g. 'What if banking stocks fall 15% and the rupee drops 4% over a month?'"
        value={text}
        onChange={(e) => setText(e.target.value)}
        style={{ minHeight: 110, resize: "vertical" }}
      />
      <div className="flex items-center justify-between mt-2.5">
        <span className="mono text-[11px] text-[var(--ink-3)]">
          StockSage will parse + simulate
        </span>
        <button
          className="pf-bs sm"
          disabled={text.trim().length === 0}
          style={{ opacity: text.trim().length === 0 ? 0.5 : 1 }}
          onClick={() => ask(text.trim())}
        >
          <Play className="h-3 w-3" /> Run scenario
        </button>
      </div>
      <div className="mt-5">
        <div className="ttl mb-2.5">TRY ONE OF THESE</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {examples.map((e) => (
            <button
              key={e}
              className="pf-card flat text-left flex items-start gap-2"
              style={{ padding: 10 }}
              onClick={() => ask(e)}
            >
              <Sparkles
                className="h-3.5 w-3.5 mt-0.5 flex-shrink-0"
                style={{ color: "var(--emerald-text)" }}
              />
              <span className="text-[12.5px] text-[var(--ink-2)]">{e}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Reverse stress (illustrative scenario ladder) ───────────────── */

function ReverseStress({
  portfolioValue,
  ask,
}: {
  portfolioValue: number | null;
  ask: (q: string) => void;
}) {
  const [target, setTarget] = useState(-15);
  const lossAmt =
    portfolioValue !== null ? (portfolioValue * target) / 100 : null;
  const scenarios = [
    {
      name: "Banking sector −22%",
      prob: "5–7% / yr",
      date: "Last seen: Mar 2020",
    },
    {
      name: "FII outflow > ₹80,000 Cr",
      prob: "Annual",
      date: "Last: Sep 2022",
    },
    { name: "Tech rotation + IT −20%", prob: "8% / yr", date: "Last: 2022" },
    { name: "RBI emergency hike 100bps", prob: "Rare", date: "2008, 2013" },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5">
      <div className="pf-card" style={{ padding: 18 }}>
        <div className="ttl mb-1">REVERSE STRESS</div>
        <p className="text-[12px] text-[var(--ink-3)] mb-4">
          Start with how much pain you can stomach. We&apos;ll surface scenarios
          that get you there.
        </p>
        <div className="ttl">MAX DRAWDOWN YOU CAN STOMACH</div>
        <div
          className="mono"
          style={{
            fontSize: 38,
            fontWeight: 800,
            color: "var(--pop-1-text)",
            letterSpacing: -1,
            marginTop: 4,
          }}
        >
          {target}%
        </div>
        {lossAmt !== null && (
          <div className="mono text-[14px] text-[var(--ink-2)]">
            = {fmtINRCompact(lossAmt)}
          </div>
        )}
        <input
          type="range"
          min={-50}
          max={-2}
          step={0.5}
          value={target}
          onChange={(e) => setTarget(parseFloat(e.target.value))}
          style={{
            width: "100%",
            accentColor: "var(--emerald)",
            marginTop: 12,
          }}
          aria-label="Max drawdown tolerance"
        />
        <div className="flex justify-between mono text-[11px] text-[var(--ink-3)]">
          <span>−50%</span>
          <span>−2%</span>
        </div>
      </div>

      <div
        className="pf-card tilt-r"
        style={{ background: "var(--paper-2)", padding: 18 }}
      >
        <div className="ttl mb-1">SCENARIOS THAT COULD PRODUCE {target}%</div>
        <p className="text-[12px] text-[var(--ink-3)] mb-3">
          Ranked by likelihood.
        </p>
        <div className="flex flex-col gap-2">
          {scenarios.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between gap-2 rounded-lg"
              style={{
                padding: 12,
                background: "var(--paper)",
                border: "1.5px solid var(--rule-soft)",
              }}
            >
              <div className="min-w-0">
                <div className="text-[13px] font-bold text-[var(--ink)] truncate">
                  {s.name}
                </div>
                <div className="mono text-[11px] text-[var(--ink-3)]">
                  {s.date}
                </div>
              </div>
              <span className="pf-pill gold flex-shrink-0">{s.prob}</span>
            </div>
          ))}
        </div>
        <div
          className="flex items-start gap-2 mt-3 rounded-md px-3 py-2"
          style={{
            background: "var(--rule-softer)",
            border: "1.5px dashed var(--rule-soft)",
          }}
        >
          <AlertTriangle
            className="h-3.5 w-3.5 mt-0.5 flex-shrink-0"
            style={{ color: "var(--pop-1-text)" }}
          />
          <span className="text-[11.5px] text-[var(--ink-3)] leading-snug">
            <span
              className="pf-pill outline"
              style={{ fontSize: 9, marginRight: 4 }}
            >
              ILLUSTRATIVE
            </span>
            Example scenario ladder. Matching them against your real holdings is
            tracked in MONEY-487.
          </span>
        </div>
        <button
          className="pf-bf sm mt-3"
          onClick={() =>
            ask(
              `What scenario would cause a ${Math.abs(target)}% drawdown on my portfolio?`
            )
          }
        >
          Ask StockSage what would do this
        </button>
      </div>
    </div>
  );
}
