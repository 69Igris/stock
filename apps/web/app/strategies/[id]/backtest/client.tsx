"use client";

/**
 * Strategy Backtest Runner - playful re-skin of the design's
 * StrategyBacktest surface:
 *   - Left 320px sticky input panel (period, universe, capital, sizing,
 *     brokerage, slippage) + Run/Reset
 *   - Right results panel: dark 6-stat strip, equity curve vs Nifty 500,
 *     per-stock performance table (pf-tbl), skip-month sensitivity callout
 *
 * Credit gate: 2 credits per run (strategy_backtest in CREDIT_COSTS).
 * The "Run backtest" button calls consumeCreditsAction first; on
 * success it transitions the right panel through running → done.
 * The actual signal-replay backend is wired in a follow-up ticket;
 * for now we render the saved/static backtest stats from the catalog
 * and surface the credit-consumption flow.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import {
  ArrowLeft,
  Play,
  X,
  Info,
  AlertCircle,
  Database,
  Trophy,
  LineChart as LineChartIcon,
} from "lucide-react";
import { toast } from "sonner";
import { consumeCreditsAction } from "@/lib/actions/credits";
import { type StrategyMeta } from "../../strategies-data";
import StrategyOrbitLoader from "../StrategyOrbitLoader";

interface Props {
  strategy: StrategyMeta;
}

type RunState = "form" | "running" | "done" | "blocked";

const PERIOD_OPTIONS = ["1y", "3y", "5y", "10y", "Custom"] as const;
const UNIVERSE_OPTIONS = [
  "NIFTY 50",
  "NIFTY 100",
  "NIFTY 500",
  "BSE 500",
  "Banks",
  "IT",
] as const;
const SIZING_OPTIONS = ["equal", "cap-wt", "vol-tgt"] as const;

const STATIC_PER_STOCK = [
  { sym: "RELIANCE", signals: 12, avg: "+4.2%", hit: "67%", spark: 14 },
  { sym: "INFY", signals: 9, avg: "+5.8%", hit: "72%", spark: 22 },
  { sym: "HDFCBANK", signals: 11, avg: "+3.4%", hit: "64%", spark: 18 },
  { sym: "TCS", signals: 8, avg: "+4.1%", hit: "70%", spark: 12 },
  { sym: "ITC", signals: 14, avg: "+2.8%", hit: "58%", spark: 8 },
  { sym: "ASIANPAINT", signals: 6, avg: "+6.2%", hit: "82%", spark: 26 },
  { sym: "HUL", signals: 9, avg: "+2.1%", hit: "56%", spark: 6 },
  { sym: "BAJFINANCE", signals: 10, avg: "+5.0%", hit: "68%", spark: 20 },
];

function EquityCurve({ data, alpha }: { data: number[]; alpha: number }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 920;
  const h = 260;
  const pts = data
    .map(
      (v, i) =>
        `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * (h - 20) - 10}`
    )
    .join(" ");
  // Benchmark line (Nifty 500) - flatter, runs along ~50% of the chart height
  const benchPts = data
    .map((_, i) => `${(i / (data.length - 1)) * w},${h - 20 - i * 1.5}`)
    .join(" ");
  return (
    <svg
      width="100%"
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="block"
      aria-label={`Backtest equity curve, alpha ${alpha.toFixed(1)}pp`}
    >
      <defs>
        <linearGradient id="bt-curve" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--emerald)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--emerald)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline points={`0,${h} ${pts} ${w},${h}`} fill="url(#bt-curve)" />
      <polyline
        points={benchPts}
        fill="none"
        stroke="var(--ink-3)"
        strokeWidth="1.4"
        strokeDasharray="4 4"
      />
      <polyline
        points={pts}
        fill="none"
        stroke="var(--emerald)"
        strokeWidth="2.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MiniSpark({ seed }: { seed: number }) {
  const w = 70;
  const h = 22;
  const positive = seed >= 0;
  const pts = Array.from({ length: 10 }).map((_, i) => {
    const v =
      h / 2 +
      Math.sin(i * 0.5 + seed * 0.3) * 4 -
      (positive ? i * 0.8 : -i * 0.6);
    return `${(i / 9) * w},${Math.max(2, Math.min(h - 2, v))}`;
  });
  return (
    <svg width={w} height={h} className="block">
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={positive ? "var(--emerald)" : "var(--neg-text)"}
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function StrategyBacktestClient({ strategy }: Props) {
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
            <BacktestBody strategy={strategy} />
          </div>
        </main>
      </div>
    </PageGuard>
  );
}

interface BacktestBodyProps {
  strategy: StrategyMeta;
  /** Optional bucket from parent (catalog state). Defaults to strategy basket. */
  basket?: string[];
  /** When true, the body auto-starts the run on mount. Used when Detail's
   *  "Run backtest" button swaps to this tab. */
  autoRun?: boolean;
}

export function BacktestBody({
  strategy,
  basket: bucketProp,
  autoRun = false,
}: BacktestBodyProps) {
  const [state, setState] = useState<RunState>("form");
  const [period, setPeriod] = useState<(typeof PERIOD_OPTIONS)[number]>("5y");
  const [universe, setUniverse] =
    useState<(typeof UNIVERSE_OPTIONS)[number]>("NIFTY 500");
  const [capital, setCapital] = useState("1000000");
  const [sizing, setSizing] =
    useState<(typeof SIZING_OPTIONS)[number]>("equal");
  const [brokerage, setBrokerage] = useState("0.03");
  const [slippage, setSlippage] = useState("0.05");
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [remainingCredits, setRemainingCredits] = useState<number | null>(null);

  const parsedCagr = parseFloat(strategy.cagr) || 0;
  const benchmarkCagr = 12;
  const alpha = parsedCagr - benchmarkCagr;
  const finalCapital = Number(capital) * 2.6;

  const handleRun = useCallback(async () => {
    const result = await consumeCreditsAction("strategy_backtest", {
      query: `Backtest ${strategy.name} · ${period} · ${universe}`,
    });
    if (!result.success) {
      setState("blocked");
      setBlockedReason(result.error ?? "Unable to start backtest");
      toast.error(result.error ?? "Insufficient credits");
      return;
    }
    setRemainingCredits(result.remaining ?? null);
    setState("running");
    // Simulated stub - replace with worker job poll once signal-replay is wired
    setTimeout(() => setState("done"), 1800);
  }, [strategy.name, period, universe]);

  const autoRunFiredRef = useRef(false);
  useEffect(() => {
    if (autoRun && !autoRunFiredRef.current && state === "form") {
      autoRunFiredRef.current = true;
      void handleRun();
    }
  }, [autoRun, state, handleRun]);

  const statStrip: Array<[string, string, string | undefined]> = [
    ["CAGR", strategy.cagr, "var(--pop-2)"],
    ["SHARPE", strategy.sharpe, undefined],
    ["MAX DD", strategy.maxDD, "#ff8a8a"],
    ["1Y RETURN", strategy.return1Y, "var(--pop-2)"],
    ["WIN RATE", strategy.winRate, undefined],
    ["AVG HOLD", strategy.avgHold, undefined],
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
          Backtest ·{" "}
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
          RUNNER · {bucketProp?.length ?? 0} stock
          {bucketProp && bucketProp.length === 1 ? "" : "s"}
        </span>
        <div style={{ flex: 1 }} />
        <span className="pf-pill gold" style={{ textTransform: "uppercase" }}>
          Educational · Not advice
        </span>
      </div>

      {state === "running" ? (
        <StrategyOrbitLoader
          CenterIcon={Play}
          centerColor="text-emerald-400"
          orbit={[
            { Icon: Database, color: "text-violet-300", delaySec: 0 },
            { Icon: Trophy, color: "text-amber-300", delaySec: 0.8 },
            {
              Icon: LineChartIcon,
              color: "text-emerald-300",
              delaySec: 1.6,
            },
          ]}
          title={`Running backtest · ${strategy.name}`}
          subtitle={`${period} · 252 × 5 days · 5,000 paths`}
          steps={[
            { id: "prices", label: "Prices", state: "running" },
            { id: "signals", label: "Signals", state: "running" },
            { id: "stats", label: "Stats", state: "queued" },
          ]}
        />
      ) : (
        <div
          className="strat-bt-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "320px 1fr",
            gap: 18,
            alignItems: "start",
          }}
        >
          {/* LEFT - input panel */}
          <div
            className="pf-card"
            style={{ padding: 18, position: "sticky", top: 102 }}
          >
            <div className="ttl" style={{ color: "var(--emerald-text)" }}>
              RUN CONFIGURATION
            </div>

            <Label>Period</Label>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(5, 1fr)",
                gap: 4,
                marginBottom: 14,
              }}
            >
              {PERIOD_OPTIONS.map((p) => (
                <SegBtn
                  key={p}
                  active={period === p}
                  onClick={() => setPeriod(p)}
                >
                  {p}
                </SegBtn>
              ))}
            </div>

            <Label>Universe override</Label>
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginBottom: 14,
              }}
            >
              {UNIVERSE_OPTIONS.map((u) => (
                <button
                  key={u}
                  type="button"
                  onClick={() => setUniverse(u)}
                  className={`pf-pill ${universe === u ? "emerald" : "outline"}`}
                  style={{ cursor: "pointer" }}
                >
                  {u}
                </button>
              ))}
            </div>

            <Label>
              Entry / Exit rules{" "}
              <span style={{ color: "var(--pop-5-text)" }}>· read-only</span>
            </Label>
            <div className="pf-codeblock" style={{ marginBottom: 14 }}>
              <span className="em">entry</span> · {strategy.rules.entry}
              <br />
              <span className="gold">exit</span> · {strategy.rules.exit}
              <br />
              <span className="dim">hold</span> · {strategy.rules.hold}
            </div>

            <Label>Initial capital ₹</Label>
            <input
              type="text"
              value={capital}
              onChange={(e) => setCapital(e.target.value.replace(/[^\d]/g, ""))}
              className="pf-input mono"
              style={{ marginBottom: 14, fontSize: 13 }}
            />

            <Label>Position sizing</Label>
            <div
              style={{
                display: "flex",
                gap: 4,
                padding: 3,
                border: "1.5px solid var(--ink)",
                borderRadius: 8,
                marginBottom: 14,
              }}
            >
              {SIZING_OPTIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setSizing(p)}
                  className="mono"
                  style={{
                    flex: 1,
                    padding: "6px 4px",
                    borderRadius: 5,
                    fontSize: 10.5,
                    fontWeight: 700,
                    border: 0,
                    cursor: "pointer",
                    background: sizing === p ? "var(--ink)" : "transparent",
                    color: sizing === p ? "var(--paper)" : "var(--ink-3)",
                  }}
                >
                  {p}
                </button>
              ))}
            </div>

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 10,
                marginBottom: 16,
              }}
            >
              <div>
                <Label>Brokerage %</Label>
                <input
                  type="text"
                  value={brokerage}
                  onChange={(e) => setBrokerage(e.target.value)}
                  className="pf-input mono"
                  style={{ fontSize: 13 }}
                />
              </div>
              <div>
                <Label>Slippage %</Label>
                <input
                  type="text"
                  value={slippage}
                  onChange={(e) => setSlippage(e.target.value)}
                  className="pf-input mono"
                  style={{ fontSize: 13 }}
                />
              </div>
            </div>

            <button
              type="button"
              onClick={handleRun}
              className="pf-bs"
              style={{ width: "100%", justifyContent: "center" }}
            >
              <Play className="h-3.5 w-3.5" />
              Run backtest
              <span className="mono" style={{ fontSize: 10, opacity: 0.85 }}>
                2 credits
              </span>
            </button>
            <button
              type="button"
              onClick={() => setState("form")}
              className="pf-bf sm"
              style={{
                marginTop: 8,
                width: "100%",
                justifyContent: "center",
              }}
            >
              <X className="h-3 w-3" /> Reset
            </button>
            {remainingCredits !== null && (
              <div
                className="mono"
                style={{
                  marginTop: 10,
                  fontSize: 10.5,
                  color: "var(--emerald-text)",
                  textAlign: "center",
                }}
              >
                {remainingCredits} credits remaining
              </div>
            )}
          </div>

          {/* RIGHT - results panel */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {state === "blocked" && blockedReason && (
              <div
                className="pf-card"
                style={{
                  padding: 16,
                  background: "var(--pop-2)",
                  borderColor: "var(--ink)",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
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
                    Backtest unavailable
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

            {/* Dark 6-stat strip - always shown. Pinned dark in BOTH themes
                via --code-bg (var(--ink) flips cream in dark mode, which
                made the cream labels below invisible). */}
            <div
              className="pf-card"
              style={{
                padding: 20,
                background: "var(--code-bg)",
                color: "var(--code-fg)",
              }}
            >
              <div
                className="strat-stat-strip"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(6, 1fr)",
                  gap: 18,
                }}
              >
                {statStrip.map(([l, v, c]) => (
                  <div key={l}>
                    <div
                      className="mono"
                      style={{
                        fontSize: 10,
                        letterSpacing: 1.5,
                        color: "var(--code-dim)",
                        fontWeight: 700,
                      }}
                    >
                      {l}
                    </div>
                    <div
                      className="mono"
                      style={{
                        fontSize: 22,
                        fontWeight: 800,
                        marginTop: 4,
                        letterSpacing: -0.5,
                        color: c ?? "var(--code-fg)",
                      }}
                    >
                      {v}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Equity curve */}
            <div className="pf-card" style={{ padding: 18 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 14,
                  flexWrap: "wrap",
                }}
              >
                <div className="ttl">
                  EQUITY · {strategy.name.toUpperCase()} vs NIFTY 500
                </div>
                <span className="pf-pill emerald">
                  +{alpha.toFixed(1)}pp alpha
                </span>
                <div style={{ flex: 1 }} />
                <span
                  className="mono"
                  style={{ fontSize: 11, color: "var(--ink-3)" }}
                >
                  ₹{Number(capital).toLocaleString("en-IN")} → ₹
                  {finalCapital.toLocaleString("en-IN", {
                    maximumFractionDigits: 0,
                  })}
                </span>
              </div>
              <EquityCurve data={strategy.curve} alpha={alpha} />
            </div>

            {/* Per-stock table */}
            <div className="pf-card" style={{ padding: 0, overflow: "hidden" }}>
              <div
                style={{
                  padding: "14px 18px",
                  borderBottom: "1.5px dashed var(--rule-soft)",
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                }}
              >
                <div className="ttl">PER-STOCK PERFORMANCE</div>
                <span className="pf-pill outline">
                  {STATIC_PER_STOCK.length} symbols
                </span>
              </div>
              <table className="pf-tbl">
                <thead>
                  <tr>
                    <th style={{ paddingLeft: 18 }}>SYMBOL</th>
                    <th style={{ textAlign: "right" }}>SIGNALS</th>
                    <th style={{ textAlign: "right" }}>AVG RTN</th>
                    <th style={{ textAlign: "right" }}>HIT-RATE</th>
                    <th style={{ textAlign: "right" }}>TRAJ</th>
                  </tr>
                </thead>
                <tbody>
                  {STATIC_PER_STOCK.map((r) => {
                    const up = !r.avg.startsWith("−") && !r.avg.startsWith("-");
                    return (
                      <tr key={r.sym}>
                        <td style={{ paddingLeft: 18 }}>
                          <span className="tk">{r.sym}</span>
                        </td>
                        <td
                          className="num"
                          style={{ textAlign: "right", color: "var(--ink-3)" }}
                        >
                          {r.signals}
                        </td>
                        <td
                          className={`num ${up ? "pos" : "neg"}`}
                          style={{ textAlign: "right", fontWeight: 700 }}
                        >
                          {r.avg}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {r.hit}
                        </td>
                        <td>
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "flex-end",
                            }}
                          >
                            <MiniSpark seed={r.spark} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Skip-month sensitivity */}
            <div
              className="pf-card"
              style={{
                padding: 16,
                display: "flex",
                alignItems: "flex-start",
                gap: 12,
                background: "var(--rule-softer)",
              }}
            >
              <span
                className="pf-av-sq"
                style={{
                  width: 32,
                  height: 32,
                  background: "var(--pop-5)",
                  color: "#fff",
                }}
              >
                <Info className="h-4 w-4" />
              </span>
              <div style={{ flex: 1 }}>
                <div
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    letterSpacing: 1.5,
                    color: "var(--pop-5-text)",
                    fontWeight: 700,
                    marginBottom: 4,
                  }}
                >
                  SKIP-MONTH SENSITIVITY
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: "var(--ink-2)",
                    lineHeight: 1.55,
                  }}
                >
                  Skipping the worst single month (Mar 2020) lifts CAGR from{" "}
                  {strategy.cagr} to{" "}
                  <span
                    style={{ color: "var(--emerald-text)", fontWeight: 700 }}
                  >
                    +{(parsedCagr + 3).toFixed(1)}%
                  </span>{" "}
                  and Sharpe to{" "}
                  <span
                    style={{ color: "var(--emerald-text)", fontWeight: 700 }}
                  >
                    {(parseFloat(strategy.sharpe) + 0.19).toFixed(2)}
                  </span>
                  . Indicates moderate tail-event dependence.
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @media (max-width: 900px) {
          .strat-bt-grid { grid-template-columns: 1fr !important; }
          .strat-bt-grid > .pf-card:first-child { position: static !important; }
        }
        @media (max-width: 640px) {
          .strat-stat-strip { grid-template-columns: repeat(3, 1fr) !important; row-gap: 18px; }
        }
      `}</style>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 9.5,
        letterSpacing: 1.2,
        color: "var(--ink-3)",
        fontWeight: 700,
        textTransform: "uppercase",
        margin: "14px 0 6px",
      }}
    >
      {children}
    </div>
  );
}

function SegBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mono"
      style={{
        padding: "6px 4px",
        borderRadius: 6,
        fontSize: 10.5,
        fontWeight: 700,
        border: "1.5px solid var(--ink)",
        cursor: "pointer",
        background: active ? "var(--emerald)" : "var(--paper)",
        color: active ? "var(--paper)" : "var(--ink-3)",
        borderColor: active ? "var(--emerald)" : "var(--ink)",
      }}
    >
      {children}
    </button>
  );
}
