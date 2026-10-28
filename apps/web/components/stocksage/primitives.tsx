"use client";

/**
 * StockSage v2 design primitives (MONEY-490 / MONEY-671) — ported from the
 * Claude Design handoff (.design-ref/ss-primitives.jsx + ss-shared.jsx).
 *
 * Pure, data-gated, SEBI-safe: colour encodes DATA QUALITY (good/fair/poor) and
 * DIRECTION (up/down) only — never buy/sell. All visuals use the scoped `.ssx`
 * tokens in apps/web/app/stocksage/ssx.css, so every consumer must render inside
 * a `.ssx` container.
 */

import type { CSSProperties, ReactNode } from "react";

/* ── Data-quality colours ─────────────────────────────────────────── */
export type Verdict = "good" | "fair" | "poor";
export const QC: Record<Verdict, string> = {
  good: "var(--good)",
  fair: "var(--fair)",
  poor: "var(--poor)",
};

/* ── Icon set (lucide-style paths, stroke 1.9) ────────────────────── */
export const ICONS: Record<string, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  arrowUp: <path d="M12 19V5M5 12l7-7 7 7" />,
  sparkles: (
    <>
      <path d="M12 3l1.9 5.3L19 10l-5.1 1.7L12 17l-1.9-5.3L5 10l5.1-1.7L12 3z" />
      <path d="M19 3l.5 1.5L21 5l-1.5.5L19 7l-.5-1.5L17 5z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),
  check: <path d="M20 6L9 17l-5-5" />,
  x: <path d="M18 6L6 18M6 6l12 12" />,
  menu: (
    <>
      <path d="M3 6h18" />
      <path d="M3 12h18" />
      <path d="M3 18h18" />
    </>
  ),
  chevron: <path d="M6 9l6 6 6-6" />,
  chevronR: <path d="M9 6l6 6-6 6" />,
  chevronL: <path d="M15 6l-6 6 6 6" />,
  arrowR: <path d="M5 12h14M12 5l7 7-7 7" />,
  loader: (
    <>
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </>
  ),
  trend: (
    <>
      <path d="M23 6l-9.5 9.5-5-5L1 18" />
      <path d="M17 6h6v6" />
    </>
  ),
  trendDown: (
    <>
      <path d="M23 18l-9.5-9.5-5 5L1 6" />
      <path d="M17 18h6v-6" />
    </>
  ),
  briefcase: (
    <>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
    </>
  ),
  flame: (
    <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0" />
    </>
  ),
  wrench: (
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.7 2.7-2-2 2.7-2.7z" />
  ),
  layers: (
    <>
      <path d="M12 2L2 7l10 5 10-5-10-5z" />
      <path d="M2 17l10 5 10-5M2 12l10 5 10-5" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5" />
    </>
  ),
  file: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </>
  ),
  scale: (
    <path d="M12 3v18M3 7h18M7 7l-3 7a3 3 0 0 0 6 0zM17 7l-3 7a3 3 0 0 0 6 0z" />
  ),
  external: (
    <>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14L21 3" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5M12 15V3" />
    </>
  ),
  share: (
    <>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
    </>
  ),
  up: <path d="M12 19V5M5 12l7-7 7 7" />,
  down: <path d="M12 5v14M5 12l7 7 7-7" />,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  moon: <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />,
  sliders: (
    <>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </>
  ),
  dots: (
    <>
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </>
  ),
  zap: <path d="M13 2L3 14h9l-1 8 10-12h-9z" />,
  gauge: (
    <>
      <path d="M12 14l4-4" />
      <path d="M3.3 17a9 9 0 1 1 17.4 0z" />
    </>
  ),
  link: (
    <>
      <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  paperclip: (
    <path d="M21 11.5 12 20a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 22" />
  ),
  pieChart: (
    <>
      <path d="M21.2 15.9A10 10 0 1 1 8 2.8" />
      <path d="M22 12A10 10 0 0 0 12 2v10z" />
    </>
  ),
  newspaper: (
    <>
      <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9h4" />
      <path d="M18 14h-8M15 18h-5M10 6h8v4h-8z" />
    </>
  ),
  candle: (
    <>
      <path d="M9 5v3M9 16v3M15 3v4M15 14v4" />
      <rect x="6" y="8" width="6" height="8" rx="1" />
      <rect x="12" y="7" width="6" height="7" rx="1" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
};

export function Icon({
  name,
  size = 16,
  sw = 1.9,
  style,
}: {
  name: string;
  size?: number;
  sw?: number;
  style?: CSSProperties;
}) {
  const b = ICONS[name];
  if (!b) return null;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block", flexShrink: 0, ...style }}
    >
      {b}
    </svg>
  );
}

/* ── Small atoms ──────────────────────────────────────────────────── */
export function Eyebrow({
  children,
  em,
  style,
}: {
  children: ReactNode;
  em?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div className={"eyebrow" + (em ? " em" : "")} style={style}>
      {children}
    </div>
  );
}

export type PillTone =
  | "gold"
  | "coral"
  | "blue"
  | "pink"
  | "violet"
  | "emerald"
  | "ghost";
export function Pill({
  children,
  tone,
  sm,
  dot,
  style,
}: {
  children: ReactNode;
  tone?: PillTone;
  sm?: boolean;
  dot?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      className={
        "pill" +
        (tone ? " " + tone : "") +
        (sm ? " sm" : "") +
        (dot ? " dot" : "")
      }
      style={style}
    >
      {children}
    </span>
  );
}

export function SectionLabel({
  n,
  children,
  right,
}: {
  n?: number;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginBottom: 14,
        flexWrap: "wrap",
      }}
    >
      {n != null && (
        <span
          className="pill"
          style={{ transform: "rotate(-1.5deg)", fontWeight: 700 }}
        >
          {String(n).padStart(2, "0")}
        </span>
      )}
      <h3
        style={{
          fontSize: 18,
          fontWeight: 700,
          letterSpacing: "-.4px",
          flex: 1,
          minWidth: 0,
        }}
      >
        {children}
      </h3>
      {right}
    </div>
  );
}

/* ── Sparkline ────────────────────────────────────────────────────── */
export function Sparkline({
  data,
  tone = "up",
  w = 64,
  h = 22,
}: {
  data: number[];
  tone?: "up" | "down";
  w?: number;
  h?: number;
}) {
  const max = Math.max(...data),
    min = Math.min(...data),
    r = max - min || 1;
  const pts = data
    .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / r) * h}`)
    .join(" ");
  const c = tone === "down" ? "var(--down)" : "var(--up)";
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: "block" }}
    >
      <polyline
        points={pts}
        fill="none"
        style={{ stroke: c }}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ── ScoreDial (0–100 arc) ────────────────────────────────────────── */
export function ScoreDial({
  value,
  max = 100,
  size = 96,
  label,
  sub,
  tone,
}: {
  value: number;
  max?: number;
  size?: number;
  label?: ReactNode;
  sub?: ReactNode;
  tone?: Verdict;
}) {
  const pct = Math.max(0, Math.min(1, value / max));
  const r = size / 2 - 8,
    c = 2 * Math.PI * r,
    cx = size / 2;
  const col =
    tone === "fair"
      ? "var(--fair)"
      : tone === "poor"
        ? "var(--poor)"
        : "var(--emerald-pure)";
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 6,
      }}
    >
      <div style={{ position: "relative", width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
          <circle
            cx={cx}
            cy={cx}
            r={r}
            fill="none"
            style={{ stroke: "var(--rule-soft)" }}
            strokeWidth="8"
          />
          <circle
            cx={cx}
            cy={cx}
            r={r}
            fill="none"
            style={{ stroke: col }}
            strokeWidth="8"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - pct)}
          />
        </svg>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
          }}
        >
          <div
            className="num"
            style={{
              fontSize: size * 0.3,
              fontWeight: 700,
              lineHeight: 1,
              color: "var(--ink)",
            }}
          >
            {value}
          </div>
          {max !== 100 && (
            <div
              className="num"
              style={{ fontSize: 10, color: "var(--ink-4)" }}
            >
              / {max}
            </div>
          )}
        </div>
      </div>
      {label && (
        <div style={{ fontSize: 12, fontWeight: 700, textAlign: "center" }}>
          {label}
        </div>
      )}
      {sub && (
        <div className="num" style={{ fontSize: 10, color: "var(--ink-4)" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

/* ── VerdictDot ───────────────────────────────────────────────────── */
export function VerdictDot({ v }: { v: Verdict }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 99,
        background: QC[v] || "var(--ink-4)",
        display: "inline-block",
        flexShrink: 0,
      }}
      title={v}
    />
  );
}

/* ── MetricTile / MetricStrip ─────────────────────────────────────── */
export interface MetricItem {
  label: string;
  value: ReactNode;
  verdict?: Verdict;
  sub?: ReactNode;
}
export function MetricTile({ label, value, verdict, sub }: MetricItem) {
  return (
    <div
      style={{
        border: "1.5px solid var(--rule-soft)",
        borderRadius: 11,
        padding: "11px 12px",
        background: "var(--paper-3)",
        minWidth: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 6,
        }}
      >
        {verdict && <VerdictDot v={verdict} />}
        <span
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 9.5,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "var(--ink-4)",
            fontWeight: 600,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {label}
        </span>
      </div>
      <div
        className="num"
        style={{
          fontSize: 17,
          fontWeight: 700,
          color: "var(--ink)",
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          className="num"
          style={{ fontSize: 10, color: "var(--ink-3)", marginTop: 3 }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}
export function MetricStrip({ items }: { items: MetricItem[] }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill,minmax(120px,1fr))",
        gap: 9,
      }}
    >
      {items.map((m, i) => (
        <MetricTile key={i} {...m} />
      ))}
    </div>
  );
}

/* ── TrendArrow ───────────────────────────────────────────────────── */
export function TrendArrow({
  dir,
  children,
}: {
  dir: "up" | "down" | "flat";
  children: ReactNode;
}) {
  const up = dir === "up";
  return (
    <span
      className="num"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        color: up
          ? "var(--up)"
          : dir === "flat"
            ? "var(--ink-3)"
            : "var(--down)",
        fontWeight: 600,
        fontSize: 12,
      }}
    >
      {dir !== "flat" && <Icon name={up ? "up" : "down"} size={12} sw={2.4} />}
      {children}
    </span>
  );
}

/* ── KVTable ──────────────────────────────────────────────────────── */
export interface KVRow {
  k: ReactNode;
  v: ReactNode;
  tone?: Verdict;
  badge?: ReactNode;
}
export function KVTable({ rows }: { rows: KVRow[] }) {
  return (
    <div
      style={{
        border: "1.5px solid var(--rule-soft)",
        borderRadius: 11,
        overflow: "hidden",
      }}
    >
      {rows.map((r, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            padding: "9px 13px",
            borderBottom:
              i < rows.length - 1 ? "1px solid var(--rule-softer)" : "none",
            background: i % 2 ? "var(--rule-softer)" : "transparent",
          }}
        >
          <span style={{ fontSize: 13, color: "var(--ink-3)", minWidth: 0 }}>
            {r.k}
          </span>
          <span
            className="num"
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: r.tone ? QC[r.tone] : "var(--ink)",
              textAlign: "right",
              display: "inline-flex",
              gap: 6,
              alignItems: "center",
            }}
          >
            {r.badge}
            {r.v}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── RangeBar (scenario low/mid/high — a RANGE, not a target) ─────── */
export function RangeBar({
  low,
  mid,
  high,
  current,
  fmt = (x) => String(x),
  lo,
  hi,
}: {
  low: number;
  mid: number;
  high: number;
  current?: number | null;
  fmt?: (x: number) => string;
  lo: number;
  hi: number;
}) {
  const span = hi - lo || 1;
  const pos = (x: number) =>
    `${Math.max(0, Math.min(100, ((x - lo) / span) * 100))}%`;
  return (
    <div style={{ padding: "4px 2px 2px" }}>
      <div style={{ position: "relative", height: 30, marginBottom: 8 }}>
        <div
          style={{
            position: "absolute",
            top: 13,
            left: 0,
            right: 0,
            height: 5,
            borderRadius: 99,
            background: "var(--rule-soft)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 13,
            left: pos(low),
            width: `calc(${pos(high)} - ${pos(low)})`,
            height: 5,
            borderRadius: 99,
            background: "var(--emerald-bg)",
            border: "1px solid var(--emerald)",
          }}
        />
        {(
          [
            ["low", low],
            ["mid", mid],
            ["high", high],
          ] as const
        ).map(([k, x]) => (
          <div
            key={k}
            style={{
              position: "absolute",
              top: 8,
              left: pos(x),
              transform: "translateX(-50%)",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 2,
                height: 15,
                background: "var(--ink-3)",
                margin: "0 auto",
              }}
            />
          </div>
        ))}
        {current != null && (
          <div
            style={{
              position: "absolute",
              top: 2,
              left: pos(current),
              transform: "translateX(-50%)",
              textAlign: "center",
            }}
          >
            <div
              style={{
                width: 3,
                height: 27,
                background: "var(--ink)",
                margin: "0 auto",
                borderRadius: 2,
              }}
            />
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        {(
          [
            ["Bear", low],
            ["Base", mid],
            ["Bull", high],
          ] as const
        ).map(([k, x]) => (
          <div key={k} style={{ textAlign: "center" }}>
            <div
              style={{
                fontFamily: "JetBrains Mono",
                fontSize: 9,
                letterSpacing: 1,
                textTransform: "uppercase",
                color: "var(--ink-4)",
              }}
            >
              {k}
            </div>
            <div className="num" style={{ fontSize: 12.5, fontWeight: 700 }}>
              {fmt(x)}
            </div>
          </div>
        ))}
      </div>
      {current != null && (
        <div
          className="num"
          style={{
            fontSize: 10.5,
            color: "var(--ink-3)",
            textAlign: "center",
            marginTop: 7,
          }}
        >
          ▮ current {fmt(current)} · scenario range, not a price target
        </div>
      )}
    </div>
  );
}

/* ── RadarChart ───────────────────────────────────────────────────── */
export interface RadarSeries {
  name?: string;
  values: number[];
}
export function RadarChart({
  axes,
  series,
  size = 220,
  max = 100,
}: {
  axes: string[];
  series: RadarSeries[];
  size?: number;
  max?: number;
}) {
  const cx = size / 2,
    R = size / 2 - 34,
    N = axes.length;
  const ang = (i: number) => (Math.PI * 2 * i) / N - Math.PI / 2;
  const pt = (i: number, val: number): [number, number] => [
    cx + Math.cos(ang(i)) * R * (val / max),
    cx + Math.sin(ang(i)) * R * (val / max),
  ];
  const cols = ["var(--emerald-pure)", "var(--blue)", "var(--purple)"];
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      style={{
        width: "100%",
        maxWidth: size,
        height: "auto",
        display: "block",
        margin: "0 auto",
        overflow: "visible",
      }}
    >
      {[0.25, 0.5, 0.75, 1].map((g, gi) => (
        <polygon
          key={gi}
          points={axes.map((_, i) => pt(i, max * g).join(",")).join(" ")}
          fill="none"
          style={{ stroke: "var(--rule-soft)" }}
          strokeWidth="1"
        />
      ))}
      {axes.map((_, i) => {
        const [x, y] = pt(i, max);
        return (
          <line
            key={i}
            x1={cx}
            y1={cx}
            x2={x}
            y2={y}
            style={{ stroke: "var(--rule-softer)" }}
            strokeWidth="1"
          />
        );
      })}
      {series.map((s, si) => (
        <polygon
          key={si}
          points={s.values.map((v, i) => pt(i, v).join(",")).join(" ")}
          style={{
            fill: cols[si % cols.length],
            fillOpacity: series.length > 1 ? 0.1 : 0.16,
            stroke: cols[si % cols.length],
          }}
          strokeWidth="2"
          strokeLinejoin="round"
        />
      ))}
      {axes.map((a, i) => {
        const [x, y] = pt(i, max * 1.16);
        return (
          <text
            key={i}
            x={x}
            y={y}
            fontFamily="JetBrains Mono"
            fontSize="8.5"
            fontWeight="600"
            style={{ fill: "var(--ink-3)" }}
            textAnchor={
              Math.abs(x - cx) < 6 ? "middle" : x > cx ? "start" : "end"
            }
            dominantBaseline="middle"
          >
            {a}
          </text>
        );
      })}
    </svg>
  );
}

/* ── StackedBar (factor contribution / breakdown) ─────────────────── */
export interface StackItem {
  label: string;
  value: number;
  unit?: string;
  color?: string;
}
export function StackedBar({
  items,
  total,
}: {
  items: StackItem[];
  total?: number;
}) {
  const sum = total || items.reduce((a, b) => a + b.value, 0);
  const cols = [
    "var(--emerald-pure)",
    "var(--blue)",
    "var(--purple)",
    "var(--gold-fill)",
    "var(--coral)",
    "var(--pink)",
    "var(--ink-3)",
  ];
  return (
    <div>
      <div
        style={{
          display: "flex",
          height: 22,
          borderRadius: 7,
          overflow: "hidden",
          border: "1.5px solid var(--ink)",
        }}
      >
        {items.map((it, i) => (
          <div
            key={i}
            title={`${it.label}: ${it.value}`}
            style={{
              width: `${(it.value / sum) * 100}%`,
              background: it.color || cols[i % cols.length],
            }}
          />
        ))}
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "5px 14px",
          marginTop: 10,
        }}
      >
        {items.map((it, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11.5,
              color: "var(--ink-3)",
            }}
          >
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: 3,
                background: it.color || cols[i % cols.length],
              }}
            />
            {it.label}{" "}
            <span
              className="num"
              style={{ color: "var(--ink)", fontWeight: 600 }}
            >
              {it.value}
              {it.unit || ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── BarRow (shareholding / horizontal) ───────────────────────────── */
export function BarRow({
  label,
  value,
  pct,
  tone,
  max = 100,
  delta,
}: {
  label: ReactNode;
  value: ReactNode;
  pct: number;
  tone?: Verdict;
  max?: number;
  delta?: number;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: 12,
          marginBottom: 4,
        }}
      >
        <span style={{ color: "var(--ink-2)" }}>{label}</span>
        <span className="num" style={{ fontWeight: 600 }}>
          {value}
          {delta != null && (
            <TrendArrow dir={delta > 0 ? "up" : "down"}>
              {Math.abs(delta)}%
            </TrendArrow>
          )}
        </span>
      </div>
      <div
        style={{
          height: 8,
          borderRadius: 99,
          background: "var(--rule-softer)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${(pct / max) * 100}%`,
            height: "100%",
            background: tone ? QC[tone] : "var(--emerald-pure)",
            borderRadius: 99,
          }}
        />
      </div>
    </div>
  );
}

/* ── Heatmap (sensitivity grid) ───────────────────────────────────── */
export function Heatmap({
  rows,
  cols,
  data,
  colLabel,
  fmt = (x) => String(x),
}: {
  rows: string[];
  cols: string[];
  data: number[][];
  rowLabel?: string;
  colLabel?: string;
  fmt?: (x: number) => string;
}) {
  const flat = data.flat(),
    mn = Math.min(...flat),
    mx = Math.max(...flat),
    rg = mx - mn || 1;
  const shade = (v: number) => {
    const t = (v - mn) / rg;
    return `color-mix(in srgb, var(--emerald-pure) ${Math.round(18 + t * 62)}%, var(--paper-3))`;
  };
  return (
    <div style={{ overflowX: "auto" }}>
      {colLabel && (
        <div
          style={{
            fontFamily: "JetBrains Mono",
            fontSize: 9.5,
            color: "var(--ink-4)",
            textAlign: "center",
            marginBottom: 5,
            letterSpacing: 1,
          }}
        >
          {colLabel} →
        </div>
      )}
      <table
        style={{ borderCollapse: "collapse", width: "100%", minWidth: 320 }}
      >
        <thead>
          <tr>
            <th></th>
            {cols.map((c, i) => (
              <th
                key={i}
                className="num"
                style={{
                  fontSize: 10,
                  color: "var(--ink-3)",
                  fontWeight: 600,
                  padding: "3px 5px",
                }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, ri) => (
            <tr key={ri}>
              <td
                className="num"
                style={{
                  fontSize: 10,
                  color: "var(--ink-3)",
                  fontWeight: 600,
                  padding: "3px 7px 3px 0",
                  whiteSpace: "nowrap",
                  textAlign: "right",
                }}
              >
                {r}
              </td>
              {data[ri].map((v, ci) => (
                <td
                  key={ci}
                  className="num"
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    textAlign: "center",
                    padding: "8px 4px",
                    background: shade(v),
                    border: "1px solid var(--paper)",
                    color: "var(--ink)",
                    minWidth: 44,
                  }}
                >
                  {fmt(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── FanChart (Monte-Carlo cone) ──────────────────────────────────── */
export interface FanBands {
  p10: number[];
  p25: number[];
  p50: number[];
  p75: number[];
  p90: number[];
  target?: number | null;
}
export function FanChart({
  bands,
  height = 150,
}: {
  bands: FanBands;
  height?: number;
}) {
  const W = 320,
    H = height,
    n = bands.p50.length;
  const all = [...bands.p90, ...bands.p10],
    mx = Math.max(...all),
    mn = Math.min(...all),
    rg = mx - mn || 1;
  const X = (i: number) => (i / (n - 1)) * W,
    Y = (v: number) => H - ((v - mn) / rg) * (H - 10) - 5;
  const line = (arr: number[]) =>
    arr.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
  const area = (hi: number[], lo: number[]) =>
    `${hi.map((v, i) => `${X(i)},${Y(v)}`).join(" ")} ${lo.map((_, i) => `${X(n - 1 - i)},${Y(lo[n - 1 - i])}`).join(" ")}`;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      <polygon
        points={area(bands.p90, bands.p10)}
        style={{ fill: "var(--emerald-pure)", fillOpacity: 0.1 }}
      />
      <polygon
        points={area(bands.p75, bands.p25)}
        style={{ fill: "var(--emerald-pure)", fillOpacity: 0.18 }}
      />
      <polyline
        points={line(bands.p50)}
        fill="none"
        style={{ stroke: "var(--emerald-pure)" }}
        strokeWidth="2"
      />
      {bands.target != null && (
        <line
          x1="0"
          y1={Y(bands.target)}
          x2={W}
          y2={Y(bands.target)}
          style={{ stroke: "var(--ink-3)" }}
          strokeWidth="1"
          strokeDasharray="4 4"
        />
      )}
    </svg>
  );
}

/* ── Underwater (drawdown) plot ───────────────────────────────────── */
export function Underwater({
  data,
  height = 90,
}: {
  data: number[];
  height?: number;
}) {
  const W = 320,
    H = height,
    n = data.length,
    mn = Math.min(...data);
  const X = (i: number) => (i / (n - 1)) * W,
    Y = (v: number) => (-v / (-mn || 1)) * (H - 6);
  const pts = data.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      <polygon
        points={`0,0 ${pts} ${W},0`}
        style={{ fill: "var(--coral)", fillOpacity: 0.16 }}
      />
      <polyline
        points={pts}
        fill="none"
        style={{ stroke: "var(--coral)" }}
        strokeWidth="1.6"
      />
      <line
        x1="0"
        y1="1"
        x2={W}
        y2="1"
        style={{ stroke: "var(--rule-soft)" }}
        strokeWidth="1"
      />
    </svg>
  );
}

/* ── Candlestick chart + pattern overlay ──────────────────────────── */
export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
}
export interface CandleMarker {
  i: number;
  y: number;
  label: string;
}
export function Candles({
  data,
  height = 180,
  markers = [],
}: {
  data: Candle[];
  height?: number;
  markers?: CandleMarker[];
}) {
  const W = 340,
    H = height,
    n = data.length,
    pad = 8;
  const hi = Math.max(...data.map((d) => d.h)),
    lo = Math.min(...data.map((d) => d.l)),
    rg = hi - lo || 1;
  const cw = (W - pad * 2) / n,
    X = (i: number) => pad + i * cw + cw / 2,
    Y = (v: number) => pad + (1 - (v - lo) / rg) * (H - pad * 2);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      {data.map((d, i) => {
        const up = d.c >= d.o,
          col = up ? "var(--up)" : "var(--down)";
        const top = Y(Math.max(d.o, d.c)),
          bot = Y(Math.min(d.o, d.c));
        return (
          <g key={i}>
            <line
              x1={X(i)}
              y1={Y(d.h)}
              x2={X(i)}
              y2={Y(d.l)}
              style={{ stroke: col }}
              strokeWidth="1"
            />
            <rect
              x={X(i) - cw * 0.3}
              y={top}
              width={cw * 0.6}
              height={Math.max(1, bot - top)}
              style={{ fill: col }}
            />
          </g>
        );
      })}
      {markers.map((m, i) => (
        <g key={i}>
          <circle
            cx={X(m.i)}
            cy={Y(m.y)}
            r="4"
            fill="none"
            style={{ stroke: "var(--purple)" }}
            strokeWidth="1.6"
          />
          <text
            x={X(m.i)}
            y={Y(m.y) - 8}
            fontFamily="JetBrains Mono"
            fontSize="8"
            fontWeight="700"
            textAnchor="middle"
            style={{ fill: "var(--purple)" }}
          >
            {m.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ── Favicon / Sentiment / NewsItemCard ───────────────────────────── */
export function Favicon({
  domain,
  size = 22,
}: {
  domain: string;
  size?: number;
}) {
  const palette: Record<string, string> = {
    "economictimes.indiatimes.com": "var(--coral)",
    "livemint.com": "var(--blue)",
    "moneycontrol.com": "var(--emerald-pure)",
    "screener.in": "var(--purple)",
    "tickertape.in": "var(--pink)",
    "sebi.gov.in": "var(--ink)",
    "pulse.zerodha.com": "var(--blue)",
    "business-standard.com": "var(--gold-fill)",
  };
  const c = palette[domain] || "var(--ink-3)";
  const letter = (domain || "?").replace(/^www\./, "")[0].toUpperCase();
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        background: c,
        color: "#fff",
        display: "grid",
        placeItems: "center",
        fontFamily: "JetBrains Mono",
        fontWeight: 700,
        fontSize: size * 0.5,
        flexShrink: 0,
        border: "1.5px solid var(--ink)",
      }}
    >
      {letter}
    </span>
  );
}

export type SentimentKind = "positive" | "neutral" | "negative";
export function Sentiment({ s }: { s: SentimentKind }) {
  const map: Record<SentimentKind, [string, string]> = {
    positive: ["var(--good)", "▲ positive"],
    neutral: ["var(--ink-3)", "■ neutral"],
    negative: ["var(--poor)", "▼ negative"],
  };
  const [c, t] = map[s] || map.neutral;
  return (
    <span
      className="num"
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        color: c,
        textTransform: "uppercase",
        letterSpacing: 0.5,
      }}
    >
      {t}
    </span>
  );
}

export interface NewsItem {
  url: string;
  domain: string;
  title: string;
  source: string;
  date: string;
  sentiment?: SentimentKind;
}
export function NewsItemCard({
  item,
  idx,
  onHover,
  onLeave,
  hot,
}: {
  item: NewsItem;
  idx?: number | null;
  onHover?: () => void;
  onLeave?: () => void;
  hot?: boolean;
}) {
  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      onMouseEnter={onHover}
      onMouseLeave={onLeave}
      style={{
        display: "flex",
        gap: 11,
        padding: 11,
        borderRadius: 11,
        border: "1.5px solid " + (hot ? "var(--emerald)" : "var(--rule-soft)"),
        background: hot ? "var(--emerald-bg)" : "var(--paper-3)",
        transition: ".15s",
      }}
    >
      <Favicon domain={item.domain} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--ink)",
            lineHeight: 1.35,
            marginBottom: 4,
          }}
        >
          {idx != null && (
            <span className="cite" style={{ marginRight: 5 }}>
              {idx}
            </span>
          )}
          {item.title}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          <span
            className="num"
            style={{ fontSize: 10, color: "var(--ink-3)", fontWeight: 600 }}
          >
            {item.source}
          </span>
          <span className="num" style={{ fontSize: 10, color: "var(--ink-4)" }}>
            · {item.date}
          </span>
          {item.sentiment && <Sentiment s={item.sentiment} />}
        </div>
      </div>
    </a>
  );
}

/* ── FlagChip (governance flags — neutral, not buy/sell) ──────────── */
export function FlagChip({
  tone,
  children,
}: {
  tone: "green" | "amber" | "red";
  children: ReactNode;
}) {
  const map: Record<string, [string, string]> = {
    green: ["var(--good)", "var(--emerald-bg)"],
    amber: ["var(--fair)", "rgba(217,155,0,.12)"],
    red: ["var(--poor)", "rgba(232,98,61,.12)"],
  };
  const [c, bg] = map[tone] || map.amber;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        color: c,
        background: bg,
        border: "1.5px solid " + c,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 99, background: c }} />
      {children}
    </span>
  );
}

/* ── DegradedNote ─────────────────────────────────────────────────── */
export function DegradedNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "10px 12px",
        borderRadius: 10,
        border: "1.5px dashed var(--rule-soft)",
        background: "var(--rule-softer)",
        color: "var(--ink-3)",
        fontSize: 12.5,
      }}
    >
      <span className="num" style={{ fontSize: 16, color: "var(--ink-4)" }}>
        —
      </span>
      <span>{children}</span>
    </div>
  );
}

/* ── ConfidencePill ───────────────────────────────────────────────── */
export type ConfidenceLevel = "High" | "Medium" | "Low";
export function ConfidencePill({ level }: { level: ConfidenceLevel }) {
  const map: Record<ConfidenceLevel, string> = {
    High: "var(--good)",
    Medium: "var(--fair)",
    Low: "var(--poor)",
  };
  return (
    <Pill style={{ borderColor: map[level], color: map[level] }} sm>
      ● {level} confidence
    </Pill>
  );
}

/* ── IndicatorRow (technicals readout) ────────────────────────────── */
export function IndicatorRow({
  name,
  value,
  signal,
}: {
  name: string;
  value: ReactNode;
  signal: "bullish" | "bearish" | "neutral";
}) {
  const map: Record<string, string> = {
    bullish: "var(--up)",
    bearish: "var(--down)",
    neutral: "var(--ink-3)",
  };
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 10,
        padding: "7px 0",
        borderBottom: "1px solid var(--rule-softer)",
      }}
    >
      <span style={{ fontSize: 12, color: "var(--ink-2)" }}>{name}</span>
      <span
        className="num"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 7,
          fontSize: 11.5,
          fontWeight: 600,
        }}
      >
        {value}
        <b
          style={{
            color: map[signal] || "var(--ink-3)",
            fontSize: 9.5,
            textTransform: "uppercase",
            letterSpacing: 0.4,
          }}
        >
          {signal}
        </b>
      </span>
    </div>
  );
}
