"use client";

/**
 * StockSage v2 ChartPanel (MONEY-490 / MONEY-671) — ported from the Claude
 * Design handoff (.design-ref/ss-charts.jsx). Modular, data-driven price chart
 * with two render sources (Default editorial SVG / TradingView dark terminal)
 * and three states (running / empty / completed). Render inside a `.ssx`
 * container for the scoped design tokens.
 */

import { Icon } from "./primitives";

/* ── Data shapes ──────────────────────────────────────────────────── */
export interface OHLC {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}
export interface ChartOverlay {
  name: string;
  color: string;
  data: number[];
}
export interface ChartPattern {
  i: number;
  label: string;
  tone: "bullish" | "bearish";
}
export interface ChartLegendItem {
  name: string;
  value: string;
  signal: "bullish" | "bearish" | "neutral";
}
export interface PriceData {
  symbol: string;
  exchange: string;
  last: string;
  change?: string;
  up?: boolean;
  ohlc: {
    o: string | number;
    h: string | number;
    l: string | number;
    c: string | number;
  };
  series: OHLC[];
  overlays: ChartOverlay[];
  patterns?: ChartPattern[];
  timeframes: string[];
  timeframe: string;
  legend?: ChartLegendItem[];
}
export type ChartSource = "default" | "tradingview";
export type ChartState = "running" | "empty" | "completed";

/* shared candle geometry */
interface Geo {
  n: number;
  hi: number;
  lo: number;
  rg: number;
  cw: number;
  X: (i: number) => number;
  Y: (v: number) => number;
}
function candleGeo(
  series: OHLC[],
  W: number,
  H: number,
  padT: number,
  padB: number
): Geo {
  const n = series.length;
  const hi = Math.max(...series.map((d) => d.h)),
    lo = Math.min(...series.map((d) => d.l)),
    rg = hi - lo || 1;
  const cw = W / n;
  const X = (i: number) => i * cw + cw / 2;
  const Y = (v: number) => padT + (1 - (v - lo) / rg) * (H - padT - padB);
  return { n, hi, lo, rg, cw, X, Y };
}

export function SourceToggle({
  source,
  onSource,
}: {
  source: ChartSource;
  onSource: (v: ChartSource) => void;
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1.5px solid var(--ink)",
        borderRadius: 8,
        overflow: "hidden",
        flexShrink: 0,
      }}
    >
      {(
        [
          ["Default", "default"],
          ["TradingView", "tradingview"],
        ] as const
      ).map(([lab, v]) => (
        <button
          key={v}
          onClick={() => onSource(v)}
          style={{
            padding: "5px 10px",
            fontFamily: "JetBrains Mono",
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: 0.3,
            background: source === v ? "var(--ink)" : "transparent",
            color: source === v ? "var(--paper)" : "var(--ink-3)",
          }}
        >
          {lab}
        </button>
      ))}
    </div>
  );
}

export function SignalChip({ name, value, signal }: ChartLegendItem) {
  const c =
    signal === "bullish"
      ? "var(--up)"
      : signal === "bearish"
        ? "var(--down)"
        : "var(--ink-3)";
  return (
    <span
      className="num"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 10.5,
        color: "var(--ink-3)",
        whiteSpace: "nowrap",
      }}
    >
      {name} <b style={{ color: c }}>{value}</b>
    </span>
  );
}

/* ── Default (editorial, light) chart ─────────────────────────────── */
function DefaultChart({
  price,
  height = 200,
  showVolume = true,
}: {
  price: PriceData;
  height?: number;
  showVolume?: boolean;
}) {
  const W = 680,
    volH = showVolume ? height * 0.22 : 0,
    mainH = height - volH;
  const g = candleGeo(price.series, W, mainH, 8, 8);
  const maxV = Math.max(...price.series.map((d) => d.v)) || 1;
  const ticks = 4;
  return (
    <div
      style={{
        background: "var(--paper-3)",
        border: "1.5px solid var(--rule-soft)",
        borderRadius: 10,
        padding: "10px 12px",
      }}
    >
      <svg
        viewBox={`0 0 ${W + 44} ${height}`}
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const y = 8 + (i / ticks) * (mainH - 16);
          const val = g.hi - (i / ticks) * g.rg;
          return (
            <g key={i}>
              <line
                x1="0"
                y1={y}
                x2={W}
                y2={y}
                style={{ stroke: "var(--rule-softer)" }}
                strokeWidth="1"
              />
              <text
                x={W + 6}
                y={y + 3}
                fontFamily="JetBrains Mono"
                fontSize="9"
                style={{ fill: "var(--ink-4)" }}
              >
                {Math.round(val)}
              </text>
            </g>
          );
        })}
        {price.overlays.map((ov, oi) => (
          <polyline
            key={oi}
            points={ov.data.map((v, i) => `${g.X(i)},${g.Y(v)}`).join(" ")}
            fill="none"
            style={{ stroke: ov.color, opacity: 0.7 }}
            strokeWidth="1.4"
          />
        ))}
        {price.series.map((d, i) => {
          const up = d.c >= d.o,
            col = up ? "var(--up)" : "var(--down)";
          const top = g.Y(Math.max(d.o, d.c)),
            bot = g.Y(Math.min(d.o, d.c));
          return (
            <g key={i}>
              <line
                x1={g.X(i)}
                y1={g.Y(d.h)}
                x2={g.X(i)}
                y2={g.Y(d.l)}
                style={{ stroke: col }}
                strokeWidth="1"
              />
              <rect
                x={g.X(i) - g.cw * 0.3}
                y={top}
                width={g.cw * 0.6}
                height={Math.max(1, bot - top)}
                style={{ fill: col }}
              />
            </g>
          );
        })}
        {(price.patterns || []).map((m, i) => {
          const d = price.series[m.i];
          if (!d) return null;
          const y = g.Y(d.h) - 10,
            c = m.tone === "bearish" ? "var(--down)" : "var(--purple)";
          return (
            <g key={i}>
              <circle
                cx={g.X(m.i)}
                cy={g.Y(d.h)}
                r="3.5"
                fill="none"
                style={{ stroke: c }}
                strokeWidth="1.6"
              />
              <text
                x={g.X(m.i)}
                y={y}
                fontFamily="JetBrains Mono"
                fontSize="8.5"
                fontWeight="700"
                textAnchor="middle"
                style={{ fill: c }}
              >
                {m.label}
              </text>
            </g>
          );
        })}
        {showVolume &&
          price.series.map((d, i) => {
            const up = d.c >= d.o,
              h = (d.v / maxV) * (volH - 6);
            return (
              <rect
                key={i}
                x={g.X(i) - g.cw * 0.3}
                y={height - h}
                width={g.cw * 0.6}
                height={h}
                style={{
                  fill: up ? "var(--up)" : "var(--down)",
                  opacity: 0.28,
                }}
              />
            );
          })}
      </svg>
    </div>
  );
}

/* ── TradingView-style (dark terminal) chart ──────────────────────── */
function TVChart({
  price,
  height = 240,
  showVolume = true,
}: {
  price: PriceData;
  height?: number;
  showVolume?: boolean;
}) {
  const W = 680,
    axisW = 46,
    volH = showVolume ? height * 0.2 : 0,
    mainH = height - volH - 16;
  const g = candleGeo(price.series, W, mainH, 6, 6);
  const maxV = Math.max(...price.series.map((d) => d.v)) || 1;
  const last = price.series[price.series.length - 1];
  const lastY = g.Y(last.c);
  const ticks = 5;
  const tfLabels = ["", "10:00", "12:00", "14:00", ""];
  return (
    <div
      style={{
        background: "#0d1117",
        border: "2px solid var(--ink)",
        borderRadius: 10,
        overflow: "hidden",
        boxShadow: "var(--shadow-soft)",
      }}
    >
      <svg
        viewBox={`0 0 ${W + axisW} ${height + 18}`}
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        <text
          x={W / 2}
          y={mainH / 2}
          fontFamily="DM Sans"
          fontSize="30"
          fontWeight="700"
          textAnchor="middle"
          fill="#ffffff"
          fillOpacity="0.04"
        >
          {price.symbol} · {price.exchange}
        </text>
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const y = 6 + (i / ticks) * (mainH - 12),
            val = g.hi - (i / ticks) * g.rg;
          return (
            <g key={i}>
              <line
                x1="0"
                y1={y}
                x2={W}
                y2={y}
                stroke="#ffffff"
                strokeOpacity="0.05"
                strokeWidth="1"
              />
              <text
                x={W + 6}
                y={y + 3}
                fontFamily="JetBrains Mono"
                fontSize="9"
                fill="#787b86"
              >
                {Math.round(val)}
              </text>
            </g>
          );
        })}
        {price.overlays.map((ov, oi) => (
          <polyline
            key={oi}
            points={ov.data.map((v, i) => `${g.X(i)},${g.Y(v)}`).join(" ")}
            fill="none"
            stroke={ov.color}
            strokeWidth="1.3"
            strokeOpacity="0.9"
          />
        ))}
        {price.series.map((d, i) => {
          const up = d.c >= d.o,
            col = up ? "#26a69a" : "#ef5350";
          const top = g.Y(Math.max(d.o, d.c)),
            bot = g.Y(Math.min(d.o, d.c));
          return (
            <g key={i}>
              <line
                x1={g.X(i)}
                y1={g.Y(d.h)}
                x2={g.X(i)}
                y2={g.Y(d.l)}
                stroke={col}
                strokeWidth="1"
              />
              <rect
                x={g.X(i) - g.cw * 0.32}
                y={top}
                width={g.cw * 0.64}
                height={Math.max(1, bot - top)}
                fill={col}
              />
            </g>
          );
        })}
        {(price.patterns || []).map((m, i) => {
          const d = price.series[m.i];
          if (!d) return null;
          const c = m.tone === "bearish" ? "#ef5350" : "#a78bfa";
          return (
            <g key={i}>
              <circle
                cx={g.X(m.i)}
                cy={g.Y(d.h)}
                r="3.5"
                fill="none"
                stroke={c}
                strokeWidth="1.5"
              />
              <text
                x={g.X(m.i)}
                y={g.Y(d.h) - 9}
                fontFamily="JetBrains Mono"
                fontSize="8.5"
                fontWeight="700"
                textAnchor="middle"
                fill={c}
              >
                {m.label}
              </text>
            </g>
          );
        })}
        <line
          x1="0"
          y1={lastY}
          x2={W}
          y2={lastY}
          stroke="#26a69a"
          strokeOpacity="0.6"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <rect x={W} y={lastY - 8} width={axisW} height="16" fill="#26a69a" />
        <text
          x={W + axisW / 2}
          y={lastY + 3}
          fontFamily="JetBrains Mono"
          fontSize="9"
          fontWeight="700"
          textAnchor="middle"
          fill="#0d1117"
        >
          {last.c.toFixed(1)}
        </text>
        {showVolume &&
          price.series.map((d, i) => {
            const up = d.c >= d.o,
              h = (d.v / maxV) * (volH - 4);
            return (
              <rect
                key={i}
                x={g.X(i) - g.cw * 0.32}
                y={height - 16 - h}
                width={g.cw * 0.64}
                height={h}
                fill={up ? "#26a69a" : "#ef5350"}
                fillOpacity="0.4"
              />
            );
          })}
        {tfLabels.map((t, i) =>
          t ? (
            <text
              key={i}
              x={(i / (tfLabels.length - 1)) * W}
              y={height + 10}
              fontFamily="JetBrains Mono"
              fontSize="8.5"
              textAnchor="middle"
              fill="#787b86"
            >
              {t}
            </text>
          ) : null
        )}
      </svg>
    </div>
  );
}

/* ── Loading / empty panes ────────────────────────────────────────── */
function ChartRunning({ tv, height = 220 }: { tv: boolean; height?: number }) {
  return (
    <div
      style={{
        background: tv ? "#0d1117" : "var(--paper-3)",
        border: tv ? "2px solid var(--ink)" : "1.5px solid var(--rule-soft)",
        borderRadius: 10,
        padding: 14,
        height,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        justifyContent: "flex-end",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: "auto",
        }}
      >
        <Icon
          name="loader"
          size={13}
          style={{
            color: tv ? "#26a69a" : "var(--emerald)",
            animation: "ss-spin 1s linear infinite",
          }}
        />
        <span
          className="num"
          style={{ fontSize: 11, color: tv ? "#787b86" : "var(--ink-3)" }}
        >
          loading live ticks…
        </span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "flex-end",
          gap: 3,
          height: "62%",
        }}
      >
        {Array.from({ length: 40 }).map((_, i) => (
          <div
            key={i}
            className={tv ? "tv-shimmer" : "ss-shimmer"}
            style={{
              flex: 1,
              height: 28 + Math.abs(Math.sin(i * 0.8)) * 64 + "%",
              borderRadius: 2,
            }}
          />
        ))}
      </div>
    </div>
  );
}
function ChartEmpty({ tv, height = 200 }: { tv: boolean; height?: number }) {
  return (
    <div
      style={{
        background: tv ? "#0d1117" : "var(--paper-3)",
        border: tv ? "2px solid var(--ink)" : "1.5px dashed var(--rule-soft)",
        borderRadius: 10,
        height,
        display: "grid",
        placeItems: "center",
        textAlign: "center",
        padding: 18,
      }}
    >
      <div>
        <Icon
          name="candle"
          size={22}
          style={{
            color: tv ? "#787b86" : "var(--ink-4)",
            margin: "0 auto 8px",
          }}
        />
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: tv ? "#b2b5be" : "var(--ink-2)",
          }}
        >
          No price data available
        </div>
        <div
          className="num"
          style={{
            fontSize: 11,
            color: tv ? "#787b86" : "var(--ink-4)",
            marginTop: 4,
          }}
        >
          this instrument has no live OHLC feed
        </div>
      </div>
    </div>
  );
}

/* ── ChartPanel (the public, modular component) ───────────────────── */
export function ChartPanel({
  price,
  source = "default",
  onSource,
  state = "completed",
  height,
  showVolume = true,
  showLegend = true,
}: {
  price: PriceData;
  source?: ChartSource;
  onSource?: (v: ChartSource) => void;
  state?: ChartState;
  height?: number;
  showVolume?: boolean;
  showLegend?: boolean;
}) {
  const tv = source === "tradingview";
  const h = height || (tv ? 240 : 200);
  const ch = price.change || "",
    up = price.up;
  return (
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
        <div
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}
        >
          <span className="num" style={{ fontWeight: 700, fontSize: 14 }}>
            {price.symbol}
          </span>
          <span className="num" style={{ fontSize: 11, color: "var(--ink-4)" }}>
            {price.exchange}
          </span>
          <span className="num" style={{ fontSize: 12, fontWeight: 600 }}>
            {price.last}
          </span>
          <span
            className="num"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: up ? "var(--up)" : "var(--down)",
            }}
          >
            {ch}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        {onSource && <SourceToggle source={source} onSource={onSource} />}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <span className="num" style={{ fontSize: 10.5, color: "var(--ink-3)" }}>
          O<b style={{ color: "var(--ink)" }}>{price.ohlc.o}</b> H
          <b style={{ color: "var(--ink)" }}>{price.ohlc.h}</b> L
          <b style={{ color: "var(--ink)" }}>{price.ohlc.l}</b> C
          <b style={{ color: "var(--ink)" }}>{price.ohlc.c}</b>
        </span>
        {price.overlays.map((ov, i) => (
          <span
            key={i}
            className="num"
            style={{
              fontSize: 10.5,
              color: "var(--ink-3)",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span
              style={{
                width: 9,
                height: 3,
                borderRadius: 2,
                background: ov.color,
                display: "inline-block",
              }}
            />
            {ov.name}
          </span>
        ))}
        <span style={{ flex: 1 }} />
        <div
          className="cr-scroll-x"
          style={{
            display: "inline-flex",
            gap: 2,
            border: "1.5px solid var(--rule-soft)",
            borderRadius: 8,
            padding: 2,
          }}
        >
          {price.timeframes.map((tf) => (
            <span
              key={tf}
              className="num"
              style={{
                padding: "3px 8px",
                borderRadius: 6,
                fontSize: 10.5,
                fontWeight: 700,
                background:
                  tf === price.timeframe ? "var(--ink)" : "transparent",
                color: tf === price.timeframe ? "var(--paper)" : "var(--ink-4)",
                cursor: "pointer",
              }}
            >
              {tf}
            </span>
          ))}
        </div>
      </div>
      {state === "running" ? (
        <ChartRunning tv={tv} height={h} />
      ) : state === "empty" ? (
        <ChartEmpty tv={tv} height={h * 0.85} />
      ) : tv ? (
        <TVChart price={price} height={h} showVolume={showVolume} />
      ) : (
        <DefaultChart price={price} height={h} showVolume={showVolume} />
      )}
      {showLegend && state === "completed" && price.legend && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "5px 14px",
            marginTop: 9,
          }}
        >
          {price.legend.map((l, i) => (
            <SignalChip key={i} {...l} />
          ))}
        </div>
      )}
    </div>
  );
}
