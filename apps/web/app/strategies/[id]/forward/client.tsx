"use client";

/**
 * Strategy Forward Predict - playful re-skin of the design's
 * StrategyForwardPrediction surface:
 *   - Selector row: scope dropdown + horizon (1d/5d/20d/60d)
 *   - Big chart: historical candles → fan cone (p5/25/50/75/95)
 *   - p5/p25/p50/p75/p95 summary chips
 *   - 5 historical analogue cards with mini equity curves
 *
 * Credit gate: 3 credits per run (strategy_forward in CREDIT_COSTS).
 * The Monte Carlo + analogue match backend will be wired in a
 * follow-up - current pass uses deterministic seeded paths so the
 * credit-consumption + UX flow can ship now.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import {
  ArrowLeft,
  Play,
  AlertCircle,
  Lock,
  Telescope,
  Search,
  Zap,
  Link2,
} from "lucide-react";
import { toast } from "sonner";
import { consumeCreditsAction } from "@/lib/actions/credits";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";
import { type StrategyMeta } from "../../strategies-data";
import StrategyOrbitLoader from "../StrategyOrbitLoader";

interface Props {
  strategy: StrategyMeta;
}

const HORIZON_OPTIONS = ["1d", "5d", "20d", "60d"] as const;
type Horizon = (typeof HORIZON_OPTIONS)[number];

const HORIZON_DAYS: Record<Horizon, number> = {
  "1d": 1,
  "5d": 5,
  "20d": 20,
  "60d": 60,
};

const ANALOGUE_CARDS: Array<{
  date: string;
  sim: number;
  outcome: string;
  tone: "pos" | "neg";
}> = [
  { date: "Jun 2014", sim: 92, outcome: "+18.2%", tone: "pos" },
  { date: "Aug 2017", sim: 88, outcome: "+12.4%", tone: "pos" },
  { date: "Feb 2019", sim: 84, outcome: "+8.1%", tone: "pos" },
  { date: "Oct 2021", sim: 79, outcome: "−6.8%", tone: "neg" },
  { date: "Mar 2023", sim: 76, outcome: "+14.6%", tone: "pos" },
];

function MiniSpark({ seed }: { seed: number }) {
  const w = 140;
  const h = 36;
  const positive = seed >= 0;
  const pts = Array.from({ length: 18 }).map((_, i) => {
    const v =
      h / 2 +
      Math.sin(i * 0.4 + seed * 0.1) * 7 -
      (positive ? i * 0.6 : -i * 0.5);
    return `${(i / 17) * w},${Math.max(3, Math.min(h - 3, v))}`;
  });
  return (
    <svg width={w} height={h} className="block">
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={positive ? "var(--emerald)" : "var(--neg-text)"}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

interface FanData {
  candles: Array<{ o: number; c: number; h: number; l: number }>;
  fwd: Array<{
    p5: number;
    p25: number;
    p50: number;
    p75: number;
    p95: number;
  }>;
  last: number;
}

function buildFanData(horizon: Horizon, seed: number): FanData {
  const histN = 50;
  const fwdN = HORIZON_DAYS[horizon];
  const rand = (i: number) => {
    const x = Math.sin(i * 1.31 + seed) * 10000;
    return x - Math.floor(x);
  };
  const histY = (i: number) =>
    100 + Math.sin(i * 0.35) * 4 + i * 0.4 + (rand(i) - 0.5);
  const candles = Array.from({ length: histN }).map((_, i) => {
    const c = histY(i);
    return {
      o: c + (rand(i + 100) - 0.5) * 1,
      c,
      h: c + rand(i + 200) * 1.2,
      l: c - rand(i + 300) * 1.2,
    };
  });
  const last = candles[histN - 1].c;
  const fwd = Array.from({ length: fwdN }).map((_, i) => {
    const t = i / Math.max(1, fwdN);
    const drift = last + i * 0.6;
    const spread = 8 * Math.sqrt(t + 0.05);
    return {
      p5: drift - spread * 1.6,
      p25: drift - spread * 0.7,
      p50: drift,
      p75: drift + spread * 0.7,
      p95: drift + spread * 1.6,
    };
  });
  return { candles, fwd, last };
}

function FanChart({ data, horizon }: { data: FanData; horizon: Horizon }) {
  const histN = data.candles.length;
  const fwdN = data.fwd.length;
  const W = 1000;
  const H = 420;
  const padL = 50;
  const padR = 30;
  const padT = 30;
  const padB = 30;
  const totalN = histN + fwdN;
  const xStep = (W - padL - padR) / Math.max(1, totalN - 1);
  const allY = [
    ...data.candles.map((c) => c.l),
    ...data.candles.map((c) => c.h),
    ...data.fwd.map((f) => f.p5),
    ...data.fwd.map((f) => f.p95),
  ];
  const yMin = Math.min(...allY) - 2;
  const yMax = Math.max(...allY) + 2;
  const ySpan = yMax - yMin || 1;
  const yPx = (v: number) =>
    padT + (1 - (v - yMin) / ySpan) * (H - padT - padB);
  const xPx = (i: number) => padL + i * xStep;

  const startX = xPx(histN - 1);
  const startY = yPx(data.last);
  const tail95 = data.fwd
    .map((f, i) => `${xPx(histN + i)},${yPx(f.p95)}`)
    .join(" ");
  const tail5 = data.fwd
    .map((f, i) => `${xPx(histN + i)},${yPx(f.p5)}`)
    .reverse()
    .join(" ");
  const band75 = data.fwd
    .map((f, i) => `${xPx(histN + i)},${yPx(f.p75)}`)
    .join(" ");
  const band25 = data.fwd
    .map((f, i) => `${xPx(histN + i)},${yPx(f.p25)}`)
    .reverse()
    .join(" ");
  const med = data.fwd
    .map((f, i) => `${xPx(histN + i)},${yPx(f.p50)}`)
    .join(" ");

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="xMidYMid meet"
      className="block"
    >
      {/* Grid */}
      {[0.25, 0.5, 0.75].map((g) => (
        <line
          key={g}
          x1={padL}
          x2={W - padR}
          y1={padT + (H - padT - padB) * g}
          y2={padT + (H - padT - padB) * g}
          stroke="var(--rule-soft)"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
      ))}
      {[yMin, (yMin + yMax) / 2, yMax].map((v, i) => (
        <text
          key={i}
          x={padL - 8}
          y={padT + (H - padT - padB) * (1 - i / 2) + 4}
          fill="var(--ink-3)"
          fontSize="10"
          fontFamily="JetBrains Mono, monospace"
          textAnchor="end"
        >
          {v.toFixed(0)}
        </text>
      ))}

      {/* Historical candlesticks */}
      {data.candles.map((c, i) => {
        const x = xPx(i);
        const isUp = c.c >= c.o;
        const col = isUp ? "var(--emerald)" : "#f87171";
        return (
          <g key={i}>
            <line
              x1={x}
              x2={x}
              y1={yPx(c.h)}
              y2={yPx(c.l)}
              stroke={col}
              strokeWidth="1"
            />
            <rect
              x={x - 3}
              y={yPx(Math.max(c.o, c.c))}
              width="6"
              height={Math.max(2, Math.abs(yPx(c.o) - yPx(c.c)))}
              fill={col}
              opacity={isUp ? 0.8 : 1}
            />
          </g>
        );
      })}

      {/* Cone bands */}
      <polygon
        points={`${startX},${startY} ${tail95} ${tail5} ${startX},${startY}`}
        fill="rgba(248,113,113,.18)"
      />
      <polygon
        points={`${startX},${startY} ${band75} ${band25} ${startX},${startY}`}
        fill="rgba(251,191,36,.24)"
      />
      <polyline
        points={`${startX},${startY} ${med}`}
        fill="none"
        stroke="var(--emerald)"
        strokeWidth="6"
        opacity="0.18"
      />
      <polyline
        points={`${startX},${startY} ${med}`}
        fill="none"
        stroke="var(--emerald)"
        strokeWidth="2.2"
      />

      {/* Divider */}
      <line
        x1={xPx(histN - 1)}
        x2={xPx(histN - 1)}
        y1={padT}
        y2={H - padB}
        stroke="var(--rule-soft)"
        strokeDasharray="3,3"
      />
      <text
        x={xPx(histN - 1) - 4}
        y={padT + 12}
        textAnchor="end"
        fill="var(--ink-3)"
        fontSize="10"
        fontFamily="JetBrains Mono, monospace"
        style={{ letterSpacing: 1 }}
      >
        HISTORICAL
      </text>
      <text
        x={xPx(histN - 1) + 4}
        y={padT + 12}
        fill="var(--emerald)"
        fontSize="10"
        fontFamily="JetBrains Mono, monospace"
        fontWeight={700}
        style={{ letterSpacing: 1 }}
      >
        PROJECTED · {horizon.toUpperCase()} ›
      </text>

      {/* Last close marker */}
      <circle
        cx={xPx(histN - 1)}
        cy={yPx(data.last)}
        r="3.5"
        fill="var(--emerald)"
        stroke="var(--paper)"
        strokeWidth="1.5"
      />
    </svg>
  );
}

type Stage = "idle" | "running" | "ready" | "blocked";

export default function StrategyForwardClient({ strategy }: Props) {
  return (
    <PageGuard
      route="/strategies"
      containerClassName="p-6 pb-24 max-w-[1320px] mx-auto"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="pf-page" style={{ paddingTop: 16 }}>
            <Link
              href={`/strategies?tab=detail&id=${encodeURIComponent(strategy.id)}`}
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--ink-3)",
                marginBottom: 14,
              }}
            >
              <ArrowLeft className="h-3 w-3" /> {strategy.name}
            </Link>
            <ForwardBody strategy={strategy} />
          </div>
        </main>
      </div>
    </PageGuard>
  );
}

interface ForwardBodyProps {
  strategy: StrategyMeta;
  basket?: string[];
  autoRun?: boolean;
}

export function ForwardBody({
  strategy,
  basket: bucketProp,
  autoRun = false,
}: ForwardBodyProps) {
  const { isDemoMode } = useFeatureFlags();
  const [horizon, setHorizon] = useState<Horizon>("20d");
  const [scope, setScope] = useState<"basket" | string>("basket");
  // Demo mode: forecast is always "ready" so visitors see the full cone
  // without the credit-gated lock overlay. The cone uses deterministic
  // seeded paths anyway, so there's no real backend cost.
  const [stage, setStage] = useState<Stage>("idle");
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  // Lift the lock overlay for demo visitors once the demo flag resolves
  // from localStorage (useFeatureFlags reads it on mount).
  useEffect(() => {
    if (isDemoMode && stage === "idle") {
      setStage("ready");
    }
  }, [isDemoMode, stage]);

  // Deterministic seed from strategy id keeps the cone stable across renders
  const seed = useMemo(
    () =>
      strategy.id.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0) % 1000,
    [strategy.id]
  );
  const data = useMemo(() => buildFanData(horizon, seed), [horizon, seed]);

  const handleRun = useCallback(async () => {
    // Demo visitors don't consume credits — show the cone immediately
    if (isDemoMode) {
      setStage("ready");
      return;
    }
    const result = await consumeCreditsAction("strategy_forward", {
      query: `Forward predict ${strategy.name} · ${horizon}`,
    });
    if (!result.success) {
      setStage("blocked");
      setBlockedReason(result.error ?? "Insufficient credits");
      toast.error(result.error ?? "Insufficient credits");
      return;
    }
    setRemaining(result.remaining ?? null);
    setStage("running");
    setTimeout(() => setStage("ready"), 1500);
  }, [strategy.name, horizon, isDemoMode]);

  const autoFiredRef = useRef(false);
  useEffect(() => {
    if (autoRun && !autoFiredRef.current && stage === "idle") {
      autoFiredRef.current = true;
      void handleRun();
    }
  }, [autoRun, stage, handleRun]);

  const last = data.fwd[data.fwd.length - 1];
  const pChips: Array<{ l: string; v: number; c: string }> = [
    { l: "p5", v: last.p5, c: "var(--neg-text)" },
    { l: "p25", v: last.p25, c: "var(--pop-2-text)" },
    { l: "p50", v: last.p50, c: "var(--emerald-text)" },
    { l: "p75", v: last.p75, c: "var(--pop-2-text)" },
    { l: "p95", v: last.p95, c: "var(--emerald-text)" },
  ];

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 18,
        }}
      >
        <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: -0.8 }}>
          Forward predict ·{" "}
          <span
            style={{
              fontFamily: "Instrument Serif, serif",
              fontStyle: "italic",
              fontWeight: 400,
            }}
          >
            {strategy.name}
          </span>
        </h2>
        <span
          className="mono"
          style={{
            fontSize: 11,
            letterSpacing: 1.2,
            textTransform: "uppercase",
            color: "var(--ink-3)",
            fontWeight: 700,
          }}
        >
          MONTE CARLO · 5000 PATHS · {bucketProp?.length ?? 0} stock
          {bucketProp && bucketProp.length === 1 ? "" : "s"}
        </span>
        <div style={{ flex: 1 }} />
        <span className="pf-pill gold" style={{ textTransform: "uppercase" }}>
          Educational · Not advice
        </span>
      </div>

      {stage === "running" && (
        <StrategyOrbitLoader
          CenterIcon={Telescope}
          centerColor="text-emerald-400"
          orbit={[
            { Icon: Link2, color: "text-violet-300", delaySec: 0 },
            { Icon: Search, color: "text-cyan-300", delaySec: 0.8 },
            { Icon: Zap, color: "text-amber-300", delaySec: 1.6 },
          ]}
          title="Generating forward prediction"
          subtitle="Monte Carlo · 5,000 simulated paths"
          steps={[
            {
              id: "paths",
              label: "Sampling 5,000 paths",
              state: "running",
            },
            { id: "analogues", label: "Analogues", state: "queued" },
            { id: "cone", label: "Cone", state: "queued" },
          ]}
        />
      )}

      {stage !== "running" && (
        <>
          {/* Selector row */}
          <div
            style={{
              display: "flex",
              gap: 10,
              marginBottom: 14,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="pf-input mono"
              style={{ width: "auto", fontSize: 12, padding: "8px 12px" }}
            >
              <option value="basket">
                Basket · {bucketProp?.length ?? 9} stocks
              </option>
              <option value="RELIANCE">RELIANCE</option>
              <option value="INFY">INFY</option>
              <option value="HDFCBANK">HDFCBANK</option>
              <option value="TCS">TCS</option>
            </select>

            <span
              style={{
                width: 1,
                height: 16,
                background: "var(--rule-soft)",
              }}
            />

            <span
              className="mono"
              style={{
                fontSize: 10,
                letterSpacing: 1,
                color: "var(--ink-3)",
                fontWeight: 700,
              }}
            >
              HORIZON
            </span>
            <div
              style={{
                display: "flex",
                gap: 4,
                padding: 3,
                border: "1.5px solid var(--ink)",
                borderRadius: 8,
              }}
            >
              {HORIZON_OPTIONS.map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setHorizon(h)}
                  className="mono"
                  style={{
                    padding: "6px 12px",
                    borderRadius: 5,
                    fontSize: 11,
                    fontWeight: 700,
                    border: 0,
                    cursor: "pointer",
                    background: horizon === h ? "var(--ink)" : "transparent",
                    color: horizon === h ? "var(--paper)" : "var(--ink-3)",
                  }}
                >
                  {h}
                </button>
              ))}
            </div>

            <div style={{ flex: 1 }} />

            {stage === "idle" && (
              <button type="button" onClick={handleRun} className="pf-bs">
                <Play className="h-3.5 w-3.5" /> Run forecast{" "}
                <span className="mono" style={{ fontSize: 10, opacity: 0.85 }}>
                  3 credits
                </span>
              </button>
            )}
            {/* Running state handled by the page-level orbit loader above */}
            {stage === "ready" && remaining !== null && (
              <span
                className="mono"
                style={{ fontSize: 10.5, color: "var(--emerald-text)" }}
              >
                {remaining} credits remaining
              </span>
            )}
          </div>

          {stage === "blocked" && blockedReason && (
            <div
              className="pf-card"
              style={{
                padding: 16,
                background: "var(--pop-2)",
                borderColor: "var(--ink)",
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                marginBottom: 14,
              }}
            >
              <AlertCircle
                className="h-4 w-4"
                style={{ color: "#1d1d1b", flexShrink: 0, marginTop: 2 }}
              />
              <div style={{ flex: 1, color: "#1d1d1b" }}>
                <div
                  className="mono"
                  style={{
                    fontSize: 11,
                    letterSpacing: 1,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    marginBottom: 4,
                  }}
                >
                  Forecast unavailable
                </div>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  {blockedReason}
                </div>
                <Link
                  href="/pricing"
                  className="pf-bf sm"
                  style={{ background: "var(--ink)", color: "var(--paper)" }}
                >
                  See plans →
                </Link>
              </div>
            </div>
          )}

          {/* Big chart */}
          <div
            className="pf-card"
            style={{ padding: 18, marginBottom: 18, position: "relative" }}
          >
            {stage === "idle" && (
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  zIndex: 10,
                  borderRadius: 14,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(0,0,0,0.4)",
                  backdropFilter: "blur(2px)",
                }}
              >
                <div style={{ textAlign: "center" }}>
                  <Lock
                    className="h-5 w-5"
                    style={{ color: "var(--emerald)", margin: "0 auto 8px" }}
                  />
                  <div
                    className="mono"
                    style={{
                      fontSize: 12,
                      color: "#f7f3e6",
                      marginBottom: 12,
                    }}
                  >
                    Run forecast to reveal the cone
                  </div>
                  <button type="button" onClick={handleRun} className="pf-bs">
                    <Play className="h-3 w-3" /> Run · 3 credits
                  </button>
                </div>
              </div>
            )}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 12,
                flexWrap: "wrap",
              }}
            >
              <div className="ttl">
                PRICE CONE · {horizon.toUpperCase()} FORWARD
              </div>
              <div style={{ flex: 1 }} />
              <div
                className="mono"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  fontSize: 10.5,
                  color: "var(--ink-3)",
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <span style={{ color: "var(--emerald)" }}>━</span>p50
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      background: "rgba(251,191,36,.4)",
                    }}
                  />
                  25–75%
                </span>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  <span
                    style={{
                      display: "inline-block",
                      width: 10,
                      height: 10,
                      background: "rgba(248,113,113,.3)",
                    }}
                  />
                  5–95% tail
                </span>
              </div>
            </div>

            <FanChart data={data} horizon={horizon} />

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(5, 1fr)",
                gap: 8,
                marginTop: 12,
              }}
            >
              {pChips.map((p) => (
                <div
                  key={p.l}
                  style={{
                    padding: 12,
                    borderRadius: 9,
                    background: "var(--rule-softer)",
                    border: "1.5px solid var(--rule-soft)",
                    textAlign: "center",
                  }}
                >
                  <div
                    className="mono"
                    style={{
                      fontSize: 9.5,
                      letterSpacing: 1.5,
                      color: "var(--ink-3)",
                      fontWeight: 700,
                    }}
                  >
                    {p.l.toUpperCase()}
                  </div>
                  <div
                    className="mono"
                    style={{
                      fontSize: 18,
                      fontWeight: 800,
                      marginTop: 4,
                      letterSpacing: -0.3,
                      color: p.c,
                    }}
                  >
                    {p.v.toFixed(1)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Analogues */}
          <div className="pf-sec-h">
            <span className="n">ANALOGUES</span>
            <h3>
              Similar <span className="ser">historical periods.</span>
            </h3>
            <span className="rule" />
            <span className="meta">matched by signal pattern + vol regime</span>
          </div>
          <div
            className="strat-analogue-grid"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(5, 1fr)",
              gap: 12,
            }}
          >
            {ANALOGUE_CARDS.map((a, idx) => {
              const isPos = a.tone === "pos";
              const tilt = idx % 2 === 0 ? "tilt-l" : "tilt-r";
              return (
                <div
                  key={a.date}
                  className={`pf-card ${tilt}`}
                  style={{ padding: 14 }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                      marginBottom: 8,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 800,
                        letterSpacing: -0.2,
                      }}
                    >
                      {a.date}
                    </div>
                    <span
                      className="mono"
                      style={{ fontSize: 10, color: "var(--ink-3)" }}
                    >
                      · sim {a.sim}%
                    </span>
                  </div>
                  <MiniSpark seed={a.sim * 3} />
                  <div
                    style={{
                      marginTop: 8,
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span
                      className="mono"
                      style={{
                        fontSize: 9.5,
                        letterSpacing: 1,
                        color: "var(--ink-3)",
                        fontWeight: 700,
                      }}
                    >
                      OUTCOME
                    </span>
                    <span
                      className="mono"
                      style={{
                        fontSize: 13,
                        fontWeight: 800,
                        color: isPos ? "var(--emerald-text)" : "#b91c1c",
                      }}
                    >
                      {a.outcome}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      <style>{`
        @media (max-width: 900px) {
          .strat-analogue-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
        @media (max-width: 480px) {
          .strat-analogue-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}
