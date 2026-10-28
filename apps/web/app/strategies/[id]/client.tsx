"use client";

/**
 * Strategy Detail - playful re-skin of the design's StrategyDetailScreen.
 *
 * Exposes two entry points:
 *   - `StrategyDetailClient` - full standalone page (used by the
 *     `/strategies/[id]` route's PageGuard wrapper for direct deep
 *     links).
 *   - `DetailBody` - the inner JSX with no PageGuard / Sidebar
 *     wrapper. Catalog page imports this so Detail can render
 *     inline as a tab body (no navigation).
 *
 * Run backtest / Forward predict trigger via `onRunBacktest` /
 * `onForwardPredict` callbacks when supplied. When the props are
 * missing (standalone page) those buttons fall back to navigating
 * to the per-id sub-routes.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { PageGuard } from "@/components/PageGuard";
import { useFeatureFlags } from "@/lib/hooks/useFeatureFlags";
import {
  ArrowLeft,
  Play,
  LineChart,
  Bot,
  GitFork,
  Share2,
  X,
  Plus,
} from "lucide-react";
import { useState } from "react";
import {
  type StrategyMeta,
  type FilterAtom,
  type FilterGroup,
} from "../strategies-data";
import {
  getDefaultBasket,
  computeBacktestCredits,
  computeForwardCredits,
} from "../strategy-baskets";

interface Props {
  strategy: StrategyMeta;
}

// Playful pop-accent per strategy category.
const CATEGORY_POP: Record<StrategyMeta["category"], string> = {
  Trend: "blue",
  Momentum: "emerald",
  Value: "gold",
  Quality: "blue",
  "Mean-reversion": "violet",
  Pattern: "coral",
  Custom: "pink",
};

function isGroup(item: FilterAtom | FilterGroup): item is FilterGroup {
  return (item as FilterGroup).items !== undefined;
}

function ConditionNode({
  group,
  depth = 0,
}: {
  group: FilterGroup;
  depth?: number;
}) {
  return (
    <div style={{ paddingLeft: depth * 16 }}>
      <div
        className="mono"
        style={{
          fontSize: 10,
          letterSpacing: 1.4,
          fontWeight: 700,
          marginBottom: 8,
          color: depth % 2 === 0 ? "var(--pop-5-text)" : "var(--pop-3-text)",
        }}
      >
        {group.op}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          marginBottom: 8,
          marginLeft: 12,
        }}
      >
        {group.items.map((it, i) =>
          isGroup(it) ? (
            <div key={i} style={{ width: "100%" }}>
              <ConditionNode group={it} depth={depth + 1} />
            </div>
          ) : (
            <span
              key={i}
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 12px",
                borderRadius: 8,
                border: "1.5px solid var(--rule-soft)",
                background: "var(--rule-softer)",
                fontSize: 12,
              }}
            >
              <span style={{ color: "var(--emerald-text)" }}>{it.field}</span>
              <span style={{ color: "var(--ink-3)" }}>{it.cmp}</span>
              <span style={{ color: "var(--ink)", fontWeight: 700 }}>
                {it.value}
              </span>
            </span>
          )
        )}
      </div>
    </div>
  );
}

export default function StrategyDetailClient({ strategy }: Props) {
  const router = useRouter();
  return (
    <PageGuard
      route="/strategies"
      containerClassName="px-4 lg:px-6 pt-4 lg:pt-6 pb-24 max-w-[1280px] mx-auto"
    >
      <div className="pf-app min-h-screen">
        <Sidebar />
        <main className="lg:ml-[var(--sidebar-w)] min-h-screen pt-[var(--mobile-header-h)] lg:pt-[var(--topbar-h)]">
          <div className="pf-page" style={{ paddingTop: 16 }}>
            <button
              onClick={() => router.push("/strategies")}
              className="mono"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--ink-3)",
                background: "transparent",
                border: 0,
                cursor: "pointer",
                marginBottom: 12,
              }}
            >
              <ArrowLeft className="h-3 w-3" /> All strategies
            </button>
            <DetailBody strategy={strategy} />
          </div>
        </main>
      </div>
    </PageGuard>
  );
}

interface DetailBodyProps {
  strategy: StrategyMeta;
  /** Catalog supplies a controlled basket so the value flows back to
   *  Backtest / Forward tabs. Standalone page lets it be local. */
  basket?: string[];
  onBasketChange?: (next: string[]) => void;
  /** Tab routers - when present, click runs trigger an in-page swap
   *  instead of navigating to /strategies/[id]/*. */
  onRunBacktest?: () => void;
  onForwardPredict?: () => void;
}

const STOCK_POOL: string[] = [
  "RELIANCE",
  "TCS",
  "HDFCBANK",
  "INFY",
  "ITC",
  "LT",
  "BAJFINANCE",
  "ASIANPAINT",
  "MARUTI",
  "ADANIENT",
  "TATAMOTORS",
  "M&M",
  "TITAN",
  "BAJAJ-AUTO",
  "JSWSTEEL",
  "ADANIPORTS",
  "EICHERMOT",
  "POWERGRID",
  "HCLTECH",
  "NMDC",
  "COALINDIA",
  "ONGC",
  "GAIL",
  "NTPC",
  "PIDILITIND",
  "HINDUNILVR",
  "NESTLEIND",
  "BERGEPAINT",
  "PAGEIND",
  "BAJAJHLDNG",
  "PAYTM",
  "ZOMATO",
  "ADANIGREEN",
  "VEDL",
  "SAIL",
  "TATAPOWER",
  "JINDALSTEL",
  "DLF",
  "RECLTD",
  "TATASTEEL",
  "ULTRACEMCO",
  "GRASIM",
  "DRREDDY",
  "CIPLA",
  "TECHM",
  "WIPRO",
  "BHARTIARTL",
  "AXISBANK",
  "BRITANNIA",
  "DABUR",
  "GODREJCP",
  "MARICO",
  "COLPAL",
  "PERSISTENT",
  "MPHASIS",
  "DIVISLAB",
  "TVSMOTOR",
  "ICICIBANK",
];

// Build a normalised SVG line + benchmark path from the catalog curve.
function buildCurvePaths(curve: number[]): {
  area: string;
  line: string;
  bench: string;
} {
  if (curve.length < 2) return { area: "", line: "", bench: "" };
  const w = 600;
  const h = 200;
  const min = Math.min(...curve);
  const max = Math.max(...curve);
  const range = max - min || 1;
  const stepX = w / (curve.length - 1);
  const pts = curve.map((v, i) => {
    const x = Math.round(i * stepX);
    const y = Math.round(180 - ((v - min) / range) * 160);
    return [x, y] as const;
  });
  const line = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`)
    .join(" ");
  const area = `${line} L${w},${h} L0,${h} Z`;
  // Benchmark runs flatter, ~65% of the strategy's gain.
  const benchPts = curve.map((v, i) => {
    const x = Math.round(i * stepX);
    const damped = min + (v - min) * 0.62;
    const y = Math.round(180 - ((damped - min) / range) * 160);
    return [x, y] as const;
  });
  const bench = benchPts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`)
    .join(" ");
  return { area, line, bench };
}

export function DetailBody({
  strategy,
  basket: controlledBasket,
  onBasketChange,
  onRunBacktest,
  onForwardPredict,
}: DetailBodyProps) {
  const { flags } = useFeatureFlags();
  const paperTradingEnabled = flags["/paper-trading"];
  const [localBasket, setLocalBasket] = useState<string[]>(() =>
    getDefaultBasket(strategy.id)
  );
  const basket = controlledBasket ?? localBasket;
  const setBasket = onBasketChange ?? setLocalBasket;

  const [addPickerOpen, setAddPickerOpen] = useState(false);

  const stats: Array<[string, string, string | undefined]> = [
    ["CAGR", strategy.cagr, "var(--pop-2)"],
    ["SHARPE", strategy.sharpe, undefined],
    ["MAX DD", strategy.maxDD, "#ff8a8a"],
    ["1Y", strategy.return1Y, "var(--pop-2)"],
    ["WIN-RATE", strategy.winRate, undefined],
    ["AVG-HOLD", strategy.avgHold, undefined],
  ];

  const backtestCredits = computeBacktestCredits(basket);
  const forwardCredits = computeForwardCredits(basket);
  const curve = buildCurvePaths(strategy.curve);

  const removeStock = (s: string) => setBasket(basket.filter((x) => x !== s));
  const addStock = (s: string) => {
    if (!basket.includes(s)) setBasket([...basket, s]);
    setAddPickerOpen(false);
  };
  const candidatePool = STOCK_POOL.filter((s) => !basket.includes(s));

  const handleBacktest = () => {
    if (onRunBacktest) onRunBacktest();
    else window.location.href = `/strategies/${strategy.id}/backtest`;
  };
  const handleForward = () => {
    if (onForwardPredict) onForwardPredict();
    else window.location.href = `/strategies/${strategy.id}/forward`;
  };

  return (
    <div>
      {/* Header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          gap: 20,
          alignItems: "flex-start",
          paddingBottom: 16,
          borderBottom: "2px solid var(--ink)",
          marginBottom: 22,
        }}
        className="strat-detail-head"
      >
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
              marginBottom: 8,
            }}
          >
            {strategy.status === "LIVE" && (
              <span className="pf-pill emerald">● LIVE ON PAPER</span>
            )}
            <span className={`pf-pill ${CATEGORY_POP[strategy.category]}`}>
              {strategy.category}
            </span>
            <span className="pf-pill outline">
              by {strategy.author === "built-in" ? "UseMoney" : strategy.author}
            </span>
            <span
              className="pf-pill gold"
              style={{ textTransform: "uppercase" }}
            >
              Educational · Not advice
            </span>
          </div>
          <h2
            style={{
              fontSize: 34,
              fontWeight: 800,
              letterSpacing: -1.2,
              lineHeight: 1.02,
            }}
          >
            {strategy.name}
          </h2>
          <div
            style={{
              marginTop: 8,
              fontFamily: "Instrument Serif, serif",
              fontStyle: "italic",
              fontSize: 16,
              color: "var(--ink-3)",
              lineHeight: 1.3,
            }}
          >
            {strategy.description}
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <Link
            href={`/strategies?tab=build&fork=${encodeURIComponent(strategy.id)}`}
            className="pf-bf"
          >
            <GitFork className="h-3.5 w-3.5" /> Fork
          </Link>
          {paperTradingEnabled && (
            <Link
              href={`/paper-trading/terminal?strategy=${encodeURIComponent(strategy.id)}`}
              className="pf-bf"
            >
              <Bot className="h-3.5 w-3.5" /> Paper-trade
            </Link>
          )}
          <button
            type="button"
            onClick={handleBacktest}
            disabled={basket.length === 0}
            className="pf-bs"
            style={
              basket.length === 0
                ? { opacity: 0.5, cursor: "not-allowed" }
                : undefined
            }
          >
            <Play className="h-3.5 w-3.5" /> Run backtest
          </button>
        </div>
      </div>

      {/* Backtest summary - dark stat strip (pinned dark in BOTH themes via
          --code-bg; `var(--ink)` would flip to cream in dark mode and the
          cream labels / gold accents below would disappear). */}
      <div
        className="pf-card tilt-l"
        style={{
          padding: 24,
          background: "var(--code-bg)",
          color: "var(--code-fg)",
          marginBottom: 22,
        }}
      >
        <div
          className="strat-stat-strip"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(6, 1fr)",
            gap: 24,
          }}
        >
          {stats.map(([l, v, color]) => (
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
                  marginTop: 4,
                  fontSize: 24,
                  fontWeight: 800,
                  letterSpacing: -0.5,
                  color: color ?? "var(--code-fg)",
                }}
              >
                {v}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Equity curve + DSL */}
      <div
        className="strat-two-col"
        style={{
          display: "grid",
          gridTemplateColumns: "1.5fr 1fr",
          gap: 18,
          marginBottom: 22,
        }}
      >
        <div className="pf-card" style={{ padding: 18 }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <div className="ttl">EQUITY CURVE vs NIFTY</div>
            <div
              className="mono"
              style={{ display: "flex", gap: 14, fontSize: 11 }}
            >
              <span>
                <span style={{ color: "var(--emerald)" }}>●</span> Strategy{" "}
                {strategy.return1Y}
              </span>
              <span>
                <span style={{ color: "var(--ink-3)" }}>─ ─</span> NIFTY
              </span>
            </div>
          </div>
          <svg
            viewBox="0 0 600 200"
            width="100%"
            preserveAspectRatio="none"
            style={{ height: 220, display: "block" }}
          >
            <defs>
              <linearGradient id="sdv" x1="0" x2="0" y1="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="var(--emerald)"
                  stopOpacity="0.3"
                />
                <stop
                  offset="100%"
                  stopColor="var(--emerald)"
                  stopOpacity="0"
                />
              </linearGradient>
            </defs>
            {[40, 80, 120, 160].map((y) => (
              <line
                key={y}
                x1="0"
                y1={y}
                x2="600"
                y2={y}
                stroke="var(--rule-soft)"
                strokeWidth="1"
                strokeDasharray="3 4"
              />
            ))}
            <path d={curve.area} fill="url(#sdv)" />
            <path
              d={curve.line}
              fill="none"
              stroke="var(--emerald)"
              strokeWidth="2.2"
            />
            <path
              d={curve.bench}
              fill="none"
              stroke="var(--ink-3)"
              strokeWidth="1.6"
              strokeDasharray="4 4"
            />
          </svg>
        </div>
        <div className="pf-card" style={{ padding: 18 }}>
          <div className="ttl">STRATEGY DSL</div>
          <div className="pf-codeblock" style={{ marginTop: 10 }}>
            <span className="em">universe</span> · {strategy.rules.universe}
            <br />
            <span className="em">entry</span> · {strategy.rules.entry}
            <br />
            <span className="gold">exit</span> · {strategy.rules.exit}
            <br />
            <span className="dim">hold</span> · {strategy.rules.hold}
          </div>
          <button
            type="button"
            onClick={handleBacktest}
            disabled={basket.length === 0}
            className="pf-bf sm"
            style={{
              marginTop: 12,
              width: "100%",
              justifyContent: "center",
              ...(basket.length === 0
                ? { opacity: 0.5, cursor: "not-allowed" }
                : {}),
            }}
          >
            <Play className="h-3 w-3" /> Run backtest · {backtestCredits} credit
            {backtestCredits === 1 ? "" : "s"}
          </button>
        </div>
      </div>

      {/* Filter conditions */}
      <div className="pf-sec-h">
        <span className="n">FILTERS</span>
        <h3>
          What the screen <span className="ser">looks for.</span>
        </h3>
        <span className="rule" />
      </div>
      <div className="pf-card" style={{ padding: 18, marginBottom: 22 }}>
        <ConditionNode group={strategy.filters} />
      </div>

      {/* Stock bucket selector - user picks which stocks the run executes on. */}
      <div className="pf-sec-h">
        <span className="n">BUCKET</span>
        <h3>
          Stocks to <span className="ser">run on.</span>
        </h3>
        <span className="rule" />
        <span className="meta">backtest 1× · forward 3× per stock</span>
      </div>
      <div className="pf-card" style={{ padding: 18, marginBottom: 22 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            marginBottom: 12,
          }}
        >
          <span className="pf-pill emerald">
            {basket.length} stock{basket.length === 1 ? "" : "s"}
          </span>
        </div>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: addPickerOpen ? 10 : 0,
          }}
        >
          {basket.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => removeStock(s)}
              className="pf-pill emerald"
              style={{ cursor: "pointer" }}
              title={`Remove ${s}`}
            >
              {s}
              <X className="h-2.5 w-2.5" style={{ opacity: 0.7 }} />
            </button>
          ))}
          <button
            type="button"
            onClick={() => setAddPickerOpen((o) => !o)}
            className="pf-pill outline"
            style={{ cursor: "pointer", borderStyle: "dashed" }}
          >
            <Plus className="h-2.5 w-2.5" /> Add stock
          </button>
        </div>
        {addPickerOpen && candidatePool.length > 0 && (
          <div
            style={{
              marginTop: 4,
              padding: 12,
              borderRadius: 8,
              background: "var(--rule-softer)",
              border: "1.5px solid var(--rule-soft)",
              maxHeight: 180,
              overflowY: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
              }}
            >
              {candidatePool.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => addStock(s)}
                  className="pf-pill outline"
                  style={{ cursor: "pointer" }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Action footer - Run backtest / Forward predict with INLINE credits */}
      <div
        className="pf-card"
        style={{
          padding: 16,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <button
          type="button"
          onClick={handleBacktest}
          disabled={basket.length === 0}
          className="pf-bs"
          style={
            basket.length === 0
              ? { opacity: 0.5, cursor: "not-allowed" }
              : undefined
          }
        >
          <Play className="h-3.5 w-3.5" /> Run backtest
          <span className="mono" style={{ fontSize: 10, opacity: 0.85 }}>
            {backtestCredits} credit{backtestCredits === 1 ? "" : "s"}
          </span>
        </button>
        <button
          type="button"
          onClick={handleForward}
          disabled={basket.length === 0}
          className="pf-bf"
          style={
            basket.length === 0
              ? { opacity: 0.5, cursor: "not-allowed" }
              : undefined
          }
        >
          <LineChart className="h-3.5 w-3.5" /> Forward predict
          <span className="mono" style={{ fontSize: 10, opacity: 0.85 }}>
            {forwardCredits} credit{forwardCredits === 1 ? "" : "s"}
          </span>
        </button>
        <Link
          href={`/strategies?tab=build&fork=${encodeURIComponent(strategy.id)}`}
          className="pf-bf"
        >
          <GitFork className="h-3.5 w-3.5" /> Fork to custom builder
        </Link>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => {
            if (typeof navigator !== "undefined" && navigator.share) {
              navigator
                .share({
                  title: strategy.name,
                  url: window.location.href,
                })
                .catch(() => {});
            } else if (typeof navigator !== "undefined") {
              navigator.clipboard?.writeText(window.location.href);
            }
          }}
          className="pf-bf"
        >
          <Share2 className="h-3.5 w-3.5" /> Share
        </button>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .strat-detail-head { grid-template-columns: 1fr !important; }
          .strat-two-col { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 640px) {
          .strat-stat-strip { grid-template-columns: repeat(3, 1fr) !important; row-gap: 18px; }
        }
      `}</style>
    </div>
  );
}
