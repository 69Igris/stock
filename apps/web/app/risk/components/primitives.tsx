"use client";

/**
 * Risk v2 (MONEY-485) — shared playful primitives.
 *
 * Small building blocks ported from the design bundle (playful-risk.jsx
 * `Bar`, `ColorChip`, `Spark`, `SectionH`) re-expressed with the app's
 * pf-* tokens. Theme-aware: colours come through CSS vars or are passed
 * explicitly by callers.
 */

import type { CSSProperties, ReactNode } from "react";

/* ── INR formatting ──────────────────────────────────────────────── */

/** Compact INR — ₹48.6 L / ₹1.2 Cr / ₹4,820. Never fabricates a value. */
export function fmtINRCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "−" : "";
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  return `${sign}₹${Math.round(abs).toLocaleString("en-IN")}`;
}

/** Full INR — ₹48,62,000. */
export function fmtINR(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  });
}

/** Signed percentage from a fraction (0.42 → +42.0%). */
export function fmtPctFromFraction(
  fraction: number | null | undefined,
  signed = false
): string {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction))
    return "—";
  const pct = fraction * 100;
  const sign = pct < 0 ? "−" : signed ? "+" : "";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/* ── Horizontal labelled bar (drivers, sector tilt) ──────────────── */

export function Bar({
  label,
  pct,
  value,
  color,
}: {
  label: string;
  /** 0–100 width of the fill. */
  pct: number;
  value: string;
  color: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[12.5px] text-[var(--ink-2)] truncate pr-2">
          {label}
        </span>
        <span className="mono text-[12px] font-bold text-[var(--ink)] flex-shrink-0">
          {value}
        </span>
      </div>
      <div
        className="w-full rounded-full h-2 overflow-hidden"
        style={{
          background: "var(--rule-softer)",
          border: "1.5px solid var(--rule-soft)",
        }}
      >
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.min(Math.max(pct, 0), 100)}%`,
            background: color,
          }}
        />
      </div>
    </div>
  );
}

/* ── Color-dot chip row (single-stock list) ──────────────────────── */

export function ColorChip({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className="w-3 h-3 rounded-sm flex-shrink-0"
        style={{ background: color, border: "1.5px solid var(--ink)" }}
      />
      <span className="mono text-[12.5px] font-bold text-[var(--ink)] flex-1 truncate">
        {label}
      </span>
      <span className="mono text-[12.5px] text-[var(--ink-3)]">{value}</span>
    </div>
  );
}

/* ── Sparkline (illustrative trail shapes) ───────────────────────── */

export function Spark({
  data,
  color,
  w = 200,
  h = 48,
  fill = false,
}: {
  data: number[];
  color: string;
  w?: number;
  h?: number;
  fill?: boolean;
}) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 6) - 3;
    return [x, y] as const;
  });
  const d = pts
    .map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`))
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: "100%", height: h }}
      preserveAspectRatio="none"
    >
      {fill && (
        <path d={`${d} L${w},${h} L0,${h} Z`} fill={color} opacity={0.14} />
      )}
      <path d={d} stroke={color} strokeWidth={2} fill="none" />
    </svg>
  );
}

/* ── Section header (pf-sec-h idiom) ─────────────────────────────── */

export function SectionH({
  n,
  title,
  meta,
  actions,
}: {
  n: string;
  title: ReactNode;
  meta?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="pf-sec-h flex-wrap">
      <span className="n">{n}</span>
      <h3>{title}</h3>
      <span className="rule hidden sm:block" />
      {meta && <span className="meta">{meta}</span>}
      {actions}
    </div>
  );
}

/* ── "Coming soon / needs data" honest placeholder ───────────────── */

export function ComingSoon({
  title,
  body,
  icon,
  style,
}: {
  title: string;
  body: string;
  icon?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      className="pf-card flat flex flex-col items-center justify-center text-center gap-2 py-10 px-6"
      style={{ borderStyle: "dashed", ...style }}
    >
      {icon && <div className="text-[var(--ink-3)] mb-1">{icon}</div>}
      <p className="text-[15px] font-bold text-[var(--ink-2)]">{title}</p>
      <p className="text-[13px] text-[var(--ink-3)] max-w-md leading-relaxed">
        {body}
      </p>
      <span className="pf-pill outline mt-1">NEEDS DATA · COMING SOON</span>
    </div>
  );
}
