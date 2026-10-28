"use client";

/* =====================================================================
   Tax Report v2 — playful primitives (MONEY-485)
   Small, self-contained building blocks in the playful (pf-*) idiom.
   These wrap the app's design-system tokens; they NEVER hardcode dark
   RGBA outside the design's intentional fixed anchor colors.
   ===================================================================== */

import type { CSSProperties, ReactNode } from "react";

/* ── Formatting ──────────────────────────────────────────────────── */

/** Format a number as INR (₹) with Indian grouping, no decimals by default. */
export function fmtINR(n: number, frac = 0): string {
  return n.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  });
}

/** Signed INR — uses a true minus sign for negatives. */
export function fmtINRSigned(n: number, frac = 0): string {
  return (n >= 0 ? "+" : "−") + fmtINR(Math.abs(n), frac);
}

/** Compact INR in lakh/crore for hero numbers (e.g. ₹1.12 L, ₹2.84 Cr). */
export function fmtLakhs(n: number): { value: string; unit: string } {
  const abs = Math.abs(n);
  if (abs >= 1e7) return { value: (n / 1e7).toFixed(2), unit: "Cr" };
  if (abs >= 1e5) return { value: (n / 1e5).toFixed(2), unit: "L" };
  if (abs >= 1e3) return { value: (n / 1e3).toFixed(1), unit: "k" };
  return { value: String(Math.round(n)), unit: "" };
}

/* ── Tones ───────────────────────────────────────────────────────── */

export type Tone =
  | "emerald"
  | "coral"
  | "gold"
  | "blue"
  | "pink"
  | "violet"
  | "outline"
  | "ink";

/** Map a tone to a CSS var color (used for accent fills, dots, icons). */
export function toneColor(tone: Tone): string {
  switch (tone) {
    case "emerald":
      return "var(--emerald)";
    case "coral":
      return "var(--pop-1)";
    case "gold":
      return "var(--pop-2)";
    case "blue":
      return "var(--pop-3)";
    case "pink":
      return "var(--pop-4)";
    case "violet":
      return "var(--pop-5)";
    case "ink":
      return "var(--ink)";
    default:
      return "var(--ink-3)";
  }
}

/* ── Pill ────────────────────────────────────────────────────────── */

export function Pill({
  children,
  tone,
  className = "",
  style,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  style?: CSSProperties;
}) {
  const toneClass =
    tone && tone !== "ink"
      ? `pf-pill ${tone}`
      : tone === "ink"
        ? "pf-pill"
        : "pf-pill outline";
  return (
    <span className={`${toneClass} ${className}`.trim()} style={style}>
      {children}
    </span>
  );
}

/* ── Card ────────────────────────────────────────────────────────── */

export function Card({
  children,
  tilt,
  flat,
  className = "",
  style,
}: {
  children: ReactNode;
  tilt?: "l" | "r";
  flat?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const tiltClass = tilt === "l" ? " tilt-l" : tilt === "r" ? " tilt-r" : "";
  const flatClass = flat ? " flat" : "";
  return (
    <div
      className={`pf-card${tiltClass}${flatClass} ${className}`.trim()}
      style={style}
    >
      {children}
    </div>
  );
}

/* ── Section header (matches .pf-sec-h) ──────────────────────────── */

export function SectionH({
  n,
  title,
  meta,
  actions,
}: {
  n: string;
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="pf-sec-h" style={{ flexWrap: "wrap" }}>
      <span className="n">{n}</span>
      <h3>{title}</h3>
      <span className="rule" />
      {meta ? <span className="meta">{meta}</span> : null}
      {actions ? (
        <div className="flex items-center gap-2" style={{ flexWrap: "wrap" }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}

/* ── Citation tag (s.111A etc.) ──────────────────────────────────── */

export function Cite({ children }: { children: ReactNode }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 9.5,
        fontWeight: 600,
        color: "var(--ink-3)",
        background: "var(--rule-softer)",
        border: "1px solid var(--rule-soft)",
        padding: "1px 5px",
        borderRadius: 4,
        marginLeft: 4,
        verticalAlign: "middle",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/* ── Sub-tabs (income-type / compliance / reconcile inner tabs) ──── */

export function SubTabs<T extends string>({
  items,
  active,
  onChange,
}: {
  items: Array<{ id: T; label: string; badge?: string; badgeTone?: Tone }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div
      className="flex items-center gap-1.5"
      style={{ flexWrap: "wrap", marginBottom: 4 }}
      role="tablist"
    >
      {items.map((it) => {
        const on = it.id === active;
        return (
          <button
            key={it.id}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(it.id)}
            className="mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 11px",
              borderRadius: 8,
              fontSize: 11.5,
              fontWeight: on ? 700 : 600,
              letterSpacing: 0.3,
              border: "1.5px solid var(--ink)",
              background: on ? "var(--ink)" : "var(--paper)",
              color: on ? "var(--paper)" : "var(--ink-2)",
              cursor: "pointer",
              transition: "transform .12s, box-shadow .12s",
            }}
          >
            {it.label}
            {it.badge ? (
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  padding: "1px 5px",
                  borderRadius: 999,
                  background: toneColor(it.badgeTone ?? "violet"),
                  color: it.badgeTone === "gold" ? "#1d1d1b" : "var(--paper)",
                }}
              >
                {it.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* ── Horizontal bar (labelled, value on the right) ───────────────── */

export function Bar({
  label,
  pct,
  value,
  color = "var(--emerald)",
}: {
  label: ReactNode;
  pct: number;
  value?: ReactNode;
  color?: string;
}) {
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="flex items-center justify-between" style={{ gap: 8 }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>
          {label}
        </span>
        {value != null ? (
          <span className="mono" style={{ fontSize: 11.5, fontWeight: 700 }}>
            {value}
          </span>
        ) : null}
      </div>
      <div
        style={{
          position: "relative",
          height: 8,
          background: "var(--rule-softer)",
          border: "1.5px solid var(--rule-soft)",
          borderRadius: 99,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: `${Math.max(0, Math.min(100, pct))}%`,
            background: color,
          }}
        />
      </div>
    </div>
  );
}

/* ── Empty / coming-soon state (honest, never fabricates data) ───── */

export function EmptyState({
  title,
  body,
  icon,
  ticket = "MONEY-486",
  cta,
}: {
  title: string;
  body: ReactNode;
  icon?: ReactNode;
  ticket?: string;
  cta?: ReactNode;
}) {
  return (
    <Card flat style={{ background: "var(--paper-2)" }}>
      <div
        className="col"
        style={{
          alignItems: "center",
          textAlign: "center",
          gap: 10,
          padding: "26px 18px",
        }}
      >
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: 11,
            background: "var(--paper)",
            border: "1.5px solid var(--ink)",
            display: "grid",
            placeItems: "center",
            color: "var(--ink-3)",
            transform: "rotate(-3deg)",
          }}
        >
          {icon}
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, letterSpacing: -0.3 }}>
          {title}
        </div>
        <div
          className="ser"
          style={{
            fontSize: 14,
            color: "var(--ink-3)",
            maxWidth: 460,
            lineHeight: 1.45,
          }}
        >
          {body}
        </div>
        <Pill tone="gold">needs data · coming soon · {ticket}</Pill>
        {cta}
      </div>
    </Card>
  );
}
