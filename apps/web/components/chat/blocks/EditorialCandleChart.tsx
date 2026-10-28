"use client";

/**
 * EditorialCandleChart — the light, editorial candlestick render path for the
 * non-TradingView chart block (StockSage design, MONEY-587, task #31).
 *
 * The real proprietary TradingView Advanced Charts widget remains the primary
 * `tradingview` source (rendered in ChartBlockRenderer). This component is the
 * default / fallback SVG render used when the AI emits an inline chart block
 * with Recharts-style data instead of a live TradingView symbol.
 *
 * It draws (matching the design's DefaultChart):
 *   - 4 gridlines + a right-edge mono price axis
 *   - up / down candlesticks coloured via --up / --down
 *   - MA-overlay polylines
 *   - purple (or --down for bearish) pattern markers at { i, y, label }
 *   - a translucent volume pane
 *
 * The block's data is Recharts-shaped (data + xKey + yKeys). We derive an OHLC
 * series from it: when the rows already carry o/h/l/c (or open/high/low/close)
 * fields we use them directly; otherwise we synthesise candles from the primary
 * yKey value series. Extra yKeys become MA overlays.
 */

const OVERLAY_COLORS = ["var(--pop-2)", "var(--pop-3)", "var(--pop-5)"];

export interface Candle {
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

export interface PatternMarker {
  /** index into the candle series */
  i: number;
  label: string;
  tone?: "bullish" | "bearish";
}

interface CandleGeo {
  n: number;
  hi: number;
  lo: number;
  rg: number;
  cw: number;
  X: (i: number) => number;
  Y: (v: number) => number;
}

/** Shared candle geometry (mirrors design's candleGeo). */
function candleGeo(
  series: Candle[],
  W: number,
  H: number,
  padT: number,
  padB: number
): CandleGeo {
  const n = series.length || 1;
  const hi = Math.max(...series.map((d) => d.h));
  const lo = Math.min(...series.map((d) => d.l));
  const rg = hi - lo || 1;
  const cw = W / n;
  const X = (i: number) => i * cw + cw / 2;
  const Y = (v: number) => padT + (1 - (v - lo) / rg) * (H - padT - padB);
  return { n, hi, lo, rg, cw, X, Y };
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Read an OHLC field from a row, accepting short or long key names. */
function readField(
  row: Record<string, unknown>,
  short: string,
  long: string
): number | null {
  return (
    num(row[short]) ??
    num(row[short.toUpperCase()]) ??
    num(row[long]) ??
    num(row[long.charAt(0).toUpperCase() + long.slice(1)])
  );
}

/**
 * Derive an OHLC candle series from a Recharts-style chart block.
 *
 * Returns null when there is no usable numeric data (→ caller renders empty).
 */
export function deriveCandleData(
  data: Record<string, unknown>[] | undefined,
  primaryKey: string | undefined,
  volumeKey?: string
): { series: Candle[]; overlays: ChartOverlay[] } | null {
  if (!data || data.length === 0) return null;

  // 1. Direct OHLC rows.
  const direct: Candle[] = [];
  let everyRowHasOhlc = true;
  for (const row of data) {
    const o = readField(row, "o", "open");
    const h = readField(row, "h", "high");
    const l = readField(row, "l", "low");
    const c = readField(row, "c", "close");
    const v = readField(row, "v", "volume");
    if (o !== null && h !== null && l !== null && c !== null) {
      direct.push({
        o,
        h,
        l,
        c,
        v: v !== null ? v : 0,
      });
    } else {
      everyRowHasOhlc = false;
      break;
    }
  }
  if (everyRowHasOhlc && direct.length > 0) {
    return { series: direct, overlays: [] };
  }

  // 2. Synthesise candles from the primary value series.
  if (!primaryKey) return null;
  const values: number[] = [];
  for (const row of data) {
    const v = num(row[primaryKey]);
    if (v !== null) values.push(v);
  }
  if (values.length === 0) return null;

  const volumes = volumeKey
    ? data.map((row) => num(row[volumeKey]) ?? 0)
    : null;
  const maxAbs = Math.max(...values.map((v) => Math.abs(v)), 1);
  const wick = maxAbs * 0.012;

  const series: Candle[] = values.map((close, i) => {
    const open = i === 0 ? values[0]! : values[i - 1]!;
    const h = Math.max(open, close) + wick;
    const l = Math.min(open, close) - wick;
    const v = volumes ? volumes[i]! : Math.abs(close - open) + maxAbs * 0.15;
    return { o: open, h, l, c: close, v };
  });

  return { series, overlays: [] };
}

/** Simple moving average over a numeric series (nulls before the window). */
function movingAverage(values: number[], window: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= window) sum -= values[i - window]!;
    out.push(i >= window - 1 ? sum / window : values[i]!);
  }
  return out;
}

interface EditorialCandleChartProps {
  series: Candle[];
  overlays?: ChartOverlay[];
  patterns?: PatternMarker[];
  height?: number;
  showVolume?: boolean;
}

/** ── Editorial (light) candlestick SVG ───────────────────────────── */
export default function EditorialCandleChart({
  series,
  overlays = [],
  patterns = [],
  height = 200,
  showVolume = true,
}: EditorialCandleChartProps) {
  const W = 680;
  const volH = showVolume ? height * 0.22 : 0;
  const mainH = height - volH;
  const g = candleGeo(series, W, mainH, 8, 8);
  const maxV = Math.max(...series.map((d) => d.v), 1);
  const ticks = 4;

  return (
    <svg
      viewBox={`0 0 ${W + 44} ${height}`}
      style={{ width: "100%", height: "100%", display: "block" }}
      preserveAspectRatio="none"
      role="img"
      aria-label="Price candlestick chart"
    >
      {/* gridlines + right-edge mono price axis */}
      {Array.from({ length: ticks + 1 }).map((_, i) => {
        const y = 8 + (i / ticks) * (mainH - 16);
        const val = g.hi - (i / ticks) * g.rg;
        return (
          <g key={`grid-${i}`}>
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
              fontFamily="JetBrains Mono, monospace"
              fontSize="9"
              style={{ fill: "var(--ink-4)" }}
            >
              {Math.round(val)}
            </text>
          </g>
        );
      })}

      {/* MA overlays */}
      {overlays.map((ov, oi) => (
        <polyline
          key={`ov-${oi}`}
          points={ov.data.map((v, i) => `${g.X(i)},${g.Y(v)}`).join(" ")}
          fill="none"
          style={{ stroke: ov.color, opacity: 0.7 }}
          strokeWidth="1.4"
        />
      ))}

      {/* candles */}
      {series.map((d, i) => {
        const up = d.c >= d.o;
        const col = up ? "var(--up)" : "var(--down)";
        const top = g.Y(Math.max(d.o, d.c));
        const bot = g.Y(Math.min(d.o, d.c));
        return (
          <g key={`candle-${i}`}>
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

      {/* pattern markers */}
      {patterns.map((m, i) => {
        const d = series[m.i];
        if (!d) return null;
        const y = g.Y(d.h) - 10;
        const c = m.tone === "bearish" ? "var(--down)" : "var(--purple)";
        return (
          <g key={`pat-${i}`}>
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
              fontFamily="JetBrains Mono, monospace"
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

      {/* volume pane */}
      {showVolume &&
        series.map((d, i) => {
          const up = d.c >= d.o;
          const h = (d.v / maxV) * (volH - 6);
          return (
            <rect
              key={`vol-${i}`}
              x={g.X(i) - g.cw * 0.3}
              y={height - h}
              width={g.cw * 0.6}
              height={Math.max(0, h)}
              style={{
                fill: up ? "var(--up)" : "var(--down)",
                opacity: 0.28,
              }}
            />
          );
        })}
    </svg>
  );
}

/** ── Empty pane ──────────────────────────────────────────────────── */
export function ChartEmpty() {
  return (
    <div
      style={{
        background: "var(--paper-3)",
        border: "1.5px dashed var(--rule-soft)",
        borderRadius: 10,
        width: "100%",
        height: "100%",
        display: "grid",
        placeItems: "center",
        textAlign: "center",
        padding: 18,
        boxSizing: "border-box",
      }}
    >
      <div>
        <svg
          width="22"
          height="22"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--ink-4)"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ margin: "0 auto 8px", display: "block" }}
        >
          <line x1="9" y1="3" x2="9" y2="21" />
          <rect x="6" y="8" width="6" height="8" rx="1" />
          <line x1="17" y1="5" x2="17" y2="21" />
          <rect x="14" y="9" width="6" height="7" rx="1" />
        </svg>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink-2)" }}>
          No price data available
        </div>
        <div
          className="mono"
          style={{ fontSize: 11, color: "var(--ink-4)", marginTop: 4 }}
        >
          this instrument has no live OHLC feed
        </div>
      </div>
    </div>
  );
}

/** Build MA overlays from a derived candle series (close-based SMAs). */
export function buildMovingAverages(series: Candle[]): ChartOverlay[] {
  if (series.length < 10) return [];
  const closes = series.map((d) => d.c);
  const windows: Array<{ name: string; window: number }> = [
    { name: "MA20", window: Math.min(20, Math.floor(series.length / 2)) },
    { name: "MA50", window: Math.min(50, series.length - 1) },
  ];
  const overlays: ChartOverlay[] = [];
  windows.forEach((w, idx) => {
    if (w.window < 2) return;
    overlays.push({
      name: w.name,
      color: OVERLAY_COLORS[idx % OVERLAY_COLORS.length]!,
      data: movingAverage(closes, w.window),
    });
  });
  return overlays;
}
