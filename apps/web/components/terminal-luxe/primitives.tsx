"use client";

import {
  ReactNode,
  CSSProperties,
  useEffect,
  useRef,
  useState,
  forwardRef,
} from "react";
import { createPortal } from "react-dom";
import Image from "next/image";
import { LucideIcon } from "lucide-react";
import { usePopoverAnchor } from "@/lib/hooks/usePopoverAnchor";

/* =====================================================================
   Number formatting helpers - centralised so every page formats the
   same way. INR-aware (lakhs / crores), tabular-friendly, sign-prefixed.
   ===================================================================== */

export const fmtINR = (n: number, frac = 0): string =>
  "₹" +
  Math.abs(n).toLocaleString("en-IN", {
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  });

export const fmtINRSigned = (n: number, frac = 0): string =>
  (n >= 0 ? "+" : "−") + fmtINR(n, frac);

export const fmtLakhs = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 10_000_000) return "₹" + (n / 10_000_000).toFixed(2) + " Cr";
  if (a >= 100_000) return "₹" + (n / 100_000).toFixed(2) + " L";
  if (a >= 1_000) return "₹" + (n / 1_000).toFixed(1) + "K";
  return "₹" + n.toFixed(0);
};

/* =====================================================================
   Pill - coloured rounded badge, used for BUY/SELL, status, etc.
   ===================================================================== */

export type PillTone =
  | "pos"
  | "neg"
  | "acc"
  | "blue"
  | "vio"
  | "warn"
  | "orange"
  | "mute";

const PILL_TONES: Record<PillTone, { bg: string; bd: string; c: string }> = {
  pos: { bg: "rgba(74,222,128,.1)", bd: "rgba(74,222,128,.25)", c: "#4ade80" },
  neg: { bg: "rgba(248,113,113,.1)", bd: "rgba(248,113,113,.3)", c: "#f87171" },
  acc: { bg: "rgba(52,211,153,.1)", bd: "rgba(52,211,153,.25)", c: "#34d399" },
  blue: { bg: "rgba(59,130,246,.1)", bd: "rgba(59,130,246,.25)", c: "#60a5fa" },
  vio: {
    bg: "rgba(167,139,250,.12)",
    bd: "rgba(167,139,250,.28)",
    c: "#a78bfa",
  },
  warn: { bg: "rgba(251,191,36,.1)", bd: "rgba(251,191,36,.25)", c: "#fbbf24" },
  orange: {
    bg: "rgba(251,146,60,.12)",
    bd: "rgba(251,146,60,.28)",
    c: "#fb923c",
  },
  mute: {
    bg: "var(--rule-softer)",
    bd: "var(--border-default)",
    c: "var(--text-dim)",
  },
};

export function Pill({
  tone = "mute",
  children,
  size = "md",
  style,
}: {
  tone?: PillTone;
  children: ReactNode;
  size?: "sm" | "md";
  style?: CSSProperties;
}) {
  const t = PILL_TONES[tone];
  const sz =
    size === "sm" ? { p: "2px 7px", fs: 10 } : { p: "3px 9px", fs: 11 };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: sz.p,
        borderRadius: 9999,
        background: t.bg,
        border: `1px solid ${t.bd}`,
        color: t.c,
        fontSize: sz.fs,
        fontWeight: 700,
        fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
        letterSpacing: 0.3,
        whiteSpace: "nowrap",
        lineHeight: 1.4,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/* =====================================================================
   StatCard - header KPI cards (Total portfolio, Day's change, etc.)
   ===================================================================== */

export function StatCard({
  label,
  value,
  delta,
  deltaTone = "pos",
  sub,
  accent = false,
  icon: Icon,
  mono = true,
}: {
  label: string;
  value: ReactNode;
  delta?: ReactNode;
  deltaTone?: PillTone;
  sub?: ReactNode;
  accent?: boolean;
  icon?: LucideIcon;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        background: accent ? "rgba(52,211,153,.08)" : "var(--paper-3)",
        border: accent
          ? "1.5px solid var(--emerald)"
          : "1.5px solid var(--ink)",
        borderRadius: 14,
        padding: 16,
        position: "relative",
        overflow: "hidden",
        boxShadow: "var(--shadow-soft)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 8,
        }}
      >
        {Icon && (
          <Icon
            style={{
              width: 11,
              height: 11,
              color: accent ? "#34d399" : "var(--text-muted)",
            }}
          />
        )}
        <div
          style={{
            fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
            fontSize: 9.5,
            letterSpacing: 1.4,
            textTransform: "uppercase",
            color: accent ? "#34d399" : "var(--text-muted)",
            fontWeight: 700,
          }}
        >
          {label}
        </div>
      </div>
      <div
        style={{
          fontFamily: mono
            ? "var(--font-jetbrains), ui-monospace, monospace"
            : "inherit",
          fontWeight: 700,
          fontSize: 22,
          letterSpacing: "-.5px",
          color: "var(--text-primary)",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {(delta || sub) && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginTop: 6,
            flexWrap: "wrap",
          }}
        >
          {delta && (
            <Pill tone={deltaTone} size="sm">
              {delta}
            </Pill>
          )}
          {sub && (
            <span
              style={{
                color: "var(--text-muted)",
                fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
                fontSize: 10.5,
              }}
            >
              {sub}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/* =====================================================================
   BrokerLogo + BrokerChip - broker brand visuals
   ===================================================================== */

export const BROKER_SLUGS: Record<string, string> = {
  ZERODHA: "zerodha",
  // MONEY-837: the founder-only Connect connector reuses the Zerodha logo.
  ZERODHA_CONNECT: "zerodha",
  UPSTOX: "upstox",
  DHAN: "dhan",
  FYERS: "fyers",
  ANGEL_ONE: "angel",
  GROWW: "groww",
  HDFC: "hdfc",
  ICICI: "icici",
};

/** Convert a BrokerType enum to the asset slug used in /public/brokers/ */
export const toBrokerSlug = (broker: string | null | undefined): string => {
  if (!broker) return "manual";
  return BROKER_SLUGS[broker.toUpperCase()] || broker.toLowerCase();
};

/** Brand color per broker slug — used for the avatar background in the playful chip. */
const BROKER_BRAND_COLORS: Record<string, string> = {
  zerodha: "#387ed1",
  groww: "#5eb66e",
  upstox: "#7b2ff7",
  angel: "#e85454",
  dhan: "#f59e42",
  fyers: "#2196f3",
  hdfc: "#004c8f",
  icici: "#f47920",
  manual: "#a78bfa",
};

/** Two-letter initials to show inside the broker avatar square. */
function brokerInitials(slug: string): string {
  if (slug === "manual") return "MN";
  if (slug === "zerodha") return "ZE";
  if (slug === "upstox") return "UP";
  if (slug === "groww") return "GR";
  if (slug === "angel") return "AN";
  if (slug === "dhan") return "DH";
  if (slug === "fyers") return "FY";
  if (slug === "hdfc") return "HD";
  if (slug === "icici") return "IC";
  return slug.slice(0, 2).toUpperCase();
}

export function BrokerLogo({
  slug,
  size = 22,
}: {
  slug: string;
  size?: number;
}) {
  // Edge case: when slug is "manual" we have no asset - render a placeholder square
  if (slug === "manual") {
    return (
      <span
        style={{
          width: size,
          height: size,
          borderRadius: 5,
          flexShrink: 0,
          background: "rgba(167,139,250,.15)",
          border: "1px solid rgba(167,139,250,.3)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: Math.max(8, size - 12),
          color: "#a78bfa",
        }}
      >
        ✎
      </span>
    );
  }
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 5,
        flexShrink: 0,
        // White tile for the broker logo PNG — intentional in BOTH themes
        // (matches BrokerChip); broker marks are drawn for a light ground.
        background: "#fff",
        border: "1px solid var(--border-default)",
        display: "inline-block",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <Image
        src={`/brokers/${slug}.png`}
        alt={slug}
        width={size}
        height={size}
        style={{ objectFit: "contain" }}
      />
    </span>
  );
}

/**
 * Playful broker chip — square colored avatar (2-letter initials) +
 * "BROKER – ID" label text. Uses .br-chip + .pf-av-sq from playful-app.css.
 * Replaces the old Terminal-Luxe image-logo chip.
 */
export function BrokerChip({
  slug,
  name,
  compact = false,
}: {
  slug: string;
  name: string;
  compact?: boolean;
}) {
  const brandColor = BROKER_BRAND_COLORS[slug] ?? "var(--ink-3)";
  const initials = brokerInitials(slug);
  const avatarSize = compact ? 20 : 22;
  const label = slug === "manual" ? "Manual" : name.toUpperCase();
  return (
    <span
      className="br-chip"
      style={{
        padding: compact ? "3px 8px 3px 3px" : "4px 10px 4px 4px",
        gap: 6,
        fontFamily: '"JetBrains Mono", ui-monospace, monospace',
        fontSize: compact ? 10.5 : 11,
        fontWeight: 700,
        letterSpacing: 0.3,
        whiteSpace: "nowrap",
        color: "var(--ink)",
      }}
    >
      <span
        className="pf-av-sq"
        style={{
          width: avatarSize,
          height: avatarSize,
          // Manual entries have no logo asset → keep the coloured initials
          // square. Real brokers render their actual logo (tiny PNG already
          // bundled in /public/brokers — negligible bandwidth) on a white
          // tile so the coloured mark stays legible in light AND dark.
          background: slug === "manual" ? brandColor : "#fff",
          color: "#fff",
          fontSize: compact ? 8 : 9,
          borderRadius: 5,
          transform: "rotate(-2deg)",
          flexShrink: 0,
          overflow: "hidden",
          border: slug === "manual" ? undefined : "1px solid var(--ink)",
        }}
      >
        {slug === "manual" ? (
          initials
        ) : (
          <Image
            src={`/brokers/${slug}.png`}
            alt={name}
            width={avatarSize}
            height={avatarSize}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "contain",
              padding: 1.5,
            }}
          />
        )}
      </span>
      {label}
    </span>
  );
}

/* =====================================================================
   Sparkline - tiny inline trend line
   ===================================================================== */

export function Sparkline({
  data,
  tone = "pos",
  width = 80,
  height = 28,
}: {
  data: number[];
  tone?: "pos" | "neg";
  width?: number;
  height?: number;
}) {
  if (data.length === 0) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const pts = data
    .map(
      (v, i) =>
        `${(i / Math.max(1, data.length - 1)) * width},${
          height - ((v - min) / range) * height
        }`
    )
    .join(" ");
  const color = tone === "neg" ? "#f87171" : "#34d399";
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: "block" }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* =====================================================================
   Dropdown - custom select (not native) with click-outside, label+desc
   ===================================================================== */

export interface DropdownOption {
  value: string;
  label: string;
  desc?: string;
}

export function Dropdown({
  label,
  value,
  options,
  onChange,
  width = "100%",
  compact = false,
  placeholder,
}: {
  label?: string;
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  width?: string | number;
  compact?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Anchor the portaled menu to the trigger so it overlays OUTSIDE any
  // scrollable/overflow:hidden ancestor (e.g. the manual-entry modal body)
  // instead of being clipped.
  const anchor = usePopoverAnchor(buttonRef, open);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      const t = e.target as Node;
      // The menu is portaled to <body>, outside `ref` — exclude it explicitly
      // so clicking an option doesn't close the menu before its onClick fires.
      const inTrigger = ref.current?.contains(t);
      const inMenu = menuRef.current?.contains(t);
      if (!inTrigger && !inMenu) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const selected = options.find((o) => o.value === value);
  const displayLabel = selected ? selected.label : placeholder || value;

  return (
    <div ref={ref} style={{ position: "relative", width }}>
      {label && (
        <label
          style={{
            fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
            fontSize: 10,
            letterSpacing: 1,
            color: "var(--ink-3)",
            fontWeight: 700,
            display: "block",
            marginBottom: 5,
          }}
        >
          {label}
        </label>
      )}
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{
          width: "100%",
          padding: compact ? "7px 11px" : "9px 12px",
          background: "var(--paper)",
          border: "1.5px solid",
          borderColor: open ? "var(--emerald)" : "var(--ink)",
          borderRadius: 8,
          color: "var(--ink)",
          fontFamily: "var(--font-jetbrains), ui-monospace, monospace",
          fontSize: compact ? 11.5 : 13,
          fontWeight: 600,
          textAlign: "left",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          transition: "border-color .15s",
          boxShadow: open ? "0 0 0 3px var(--emerald-bg)" : "none",
        }}
      >
        <span
          style={{
            flex: 1,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {displayLabel}
        </span>
        <span
          style={{
            transform: open ? "rotate(180deg)" : "none",
            transition: "transform .15s",
            color: "var(--ink-3)",
            fontSize: 10,
          }}
        >
          ▾
        </span>
      </button>
      {open &&
        anchor &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={menuRef}
            style={{
              position: "fixed",
              top: anchor.top + 5,
              left: anchor.left,
              width: anchor.width,
              zIndex: 1000,
              background: "var(--paper)",
              border: "1.5px solid var(--ink)",
              borderRadius: 10,
              boxShadow: "4px 4px 0 var(--ink)",
              overflow: "hidden",
              maxHeight: 320,
              overflowY: "auto",
            }}
          >
            {options.map((o) => {
              const isSelected = o.value === value;
              return (
                <div
                  key={o.value}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  style={{
                    padding: compact ? "8px 11px" : "10px 12px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: isSelected
                      ? "var(--emerald-bg)"
                      : "transparent",
                    color: isSelected ? "var(--emerald-text)" : "var(--ink-2)",
                    borderBottom: "1px solid var(--rule-softer)",
                    fontFamily:
                      "var(--font-jetbrains), ui-monospace, monospace",
                    fontSize: compact ? 11.5 : 12.5,
                    fontWeight: 600,
                    transition: "background .1s",
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected)
                      e.currentTarget.style.background = "var(--rule-softer)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected)
                      e.currentTarget.style.background = "transparent";
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {o.label}
                    </div>
                    {o.desc && (
                      <div
                        style={{
                          fontSize: 10.5,
                          color: "var(--ink-3)",
                          fontWeight: 500,
                          marginTop: 2,
                        }}
                      >
                        {o.desc}
                      </div>
                    )}
                  </div>
                  {isSelected && <span style={{ fontSize: 12 }}>✓</span>}
                </div>
              );
            })}
          </div>,
          document.body
        )}
    </div>
  );
}

/* =====================================================================
   Donut + SplitDonut - simple SVG donut charts (no external lib)
   ===================================================================== */

export interface DonutSlice {
  k: string;
  value: number;
  color: string;
}

/** Standard ring donut, used for asset allocation / segment exposure. */
export function Donut({
  segments,
  size = 130,
  thickness = 16,
  center,
}: {
  segments: { value: number; color: string }[];
  size?: number;
  thickness?: number;
  center?: ReactNode;
}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg
        width={size}
        height={size}
        style={{ display: "block", transform: "rotate(-90deg)" }}
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--rule-soft)"
          strokeWidth={thickness}
        />
        {segments.map((seg, i) => {
          const len = (seg.value / total) * c;
          const el = (
            <circle
              key={i}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth={thickness}
              strokeDasharray={`${len} ${c}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      {center && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            textAlign: "center",
            padding: 12,
          }}
        >
          {center}
        </div>
      )}
    </div>
  );
}

/** SplitDonut: pie chart + sorted legend (Holdings sector mix, etc.). */
export function SplitDonut({
  slices,
  label,
}: {
  slices: DonutSlice[];
  label: string;
}) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  const R = 42,
    r = 28,
    cx = 50,
    cy = 50;
  let acc = 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        minWidth: 0,
      }}
    >
      <svg
        viewBox="0 0 100 100"
        style={{ width: 100, height: 100, flexShrink: 0 }}
      >
        {slices.map((s) => {
          const frac = s.value / total;
          if (frac < 0.001) return null;
          const a0 = acc * Math.PI * 2 - Math.PI / 2;
          const a1 = (acc + frac) * Math.PI * 2 - Math.PI / 2;
          acc += frac;
          const large = frac > 0.5 ? 1 : 0;
          const x0 = cx + R * Math.cos(a0),
            y0 = cy + R * Math.sin(a0);
          const x1 = cx + R * Math.cos(a1),
            y1 = cy + R * Math.sin(a1);
          const xi0 = cx + r * Math.cos(a0),
            yi0 = cy + r * Math.sin(a0);
          const xi1 = cx + r * Math.cos(a1),
            yi1 = cy + r * Math.sin(a1);
          return (
            <path
              key={s.k}
              d={`M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${xi1},${yi1} A${r},${r} 0 ${large} 0 ${xi0},${yi0} Z`}
              fill={s.color}
              opacity="0.92"
            />
          );
        })}
        <text
          x={50}
          y={47}
          textAnchor="middle"
          fill="var(--text-muted)"
          fontSize="7"
          fontFamily="JetBrains Mono"
          fontWeight="700"
          letterSpacing="1"
        >
          {label}
        </text>
        <text
          x={50}
          y={59}
          textAnchor="middle"
          fill="var(--text-primary)"
          fontSize="9"
          fontFamily="JetBrains Mono"
          fontWeight="700"
        >
          {slices.length}
        </text>
      </svg>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 5,
          flex: 1,
          minWidth: 0,
        }}
      >
        {slices
          .slice()
          .sort((a, b) => b.value - a.value)
          .slice(0, 5)
          .map((s) => {
            const pct = (s.value / total) * 100;
            return (
              <div
                key={s.k}
                style={{
                  display: "grid",
                  gridTemplateColumns: "10px minmax(0,1fr) 50px",
                  gap: 8,
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: s.color,
                  }}
                />
                <span
                  style={{
                    fontSize: 11.5,
                    color: "var(--text-secondary)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {s.k}
                </span>
                <span
                  style={{
                    fontFamily:
                      "var(--font-jetbrains), ui-monospace, monospace",
                    fontSize: 11,
                    fontWeight: 700,
                    color: s.color,
                    textAlign: "right",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {pct.toFixed(1)}%
                </span>
              </div>
            );
          })}
      </div>
    </div>
  );
}

/* =====================================================================
   TerminalInput - labeled input matching Terminal Luxe style
   (separate from shadcn Input which we keep for forms outside design.)
   ===================================================================== */

interface TerminalInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "size"
> {
  label?: string;
  mono?: boolean;
}

export const TerminalInput = forwardRef<HTMLInputElement, TerminalInputProps>(
  function TerminalInput({ label, mono = false, style, ...rest }, ref) {
    return (
      <label
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 5,
          minWidth: 0,
          flex: 1,
        }}
      >
        {label && (
          <span
            className="um-section-label"
            style={{ fontSize: 9.5, letterSpacing: 1.5 }}
          >
            {label}
          </span>
        )}
        <input
          ref={ref}
          {...rest}
          className={["tl-input", rest.className].filter(Boolean).join(" ")}
          style={{
            padding: "9px 11px",
            // Playful (cream/ink) theme — was rgba(0,0,0,.3), a dark-Terminal
            // leftover that rendered as a muted olive well on --paper.
            background: "var(--paper)",
            border: "1.5px solid var(--ink)",
            borderRadius: 8,
            color: "var(--ink)",
            fontFamily: mono
              ? "var(--font-jetbrains), ui-monospace, monospace"
              : "inherit",
            fontVariantNumeric: mono ? "tabular-nums" : "normal",
            fontSize: 13,
            outline: "none",
            transition: "border-color .15s, box-shadow .15s",
            width: "100%",
            boxSizing: "border-box",
            ...style,
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = "var(--emerald)";
            e.currentTarget.style.boxShadow = "0 0 0 3px var(--emerald-bg)";
            rest.onFocus?.(e);
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = "var(--ink)";
            e.currentTarget.style.boxShadow = "none";
            rest.onBlur?.(e);
          }}
        />
      </label>
    );
  }
);

/* =====================================================================
   PageHeader - consistent in-content section header
   ===================================================================== */

export function PageHeader({
  label,
  title,
  sub,
  right,
}: {
  label?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-end",
        gap: 12,
        marginBottom: 16,
        flexWrap: "wrap",
      }}
    >
      <div style={{ flex: 1, minWidth: 200 }}>
        {label && (
          <div
            className="um-section-label"
            style={{ color: "#34d399", marginBottom: 8 }}
          >
            {label}
          </div>
        )}
        <h2
          style={{
            fontWeight: 800,
            fontSize: 30,
            letterSpacing: "-1px",
            margin: 0,
            lineHeight: 1.05,
          }}
        >
          {title}
        </h2>
        {sub && (
          <div
            style={{
              marginTop: 6,
              color: "var(--text-dim)",
              fontSize: 13,
            }}
          >
            {sub}
          </div>
        )}
      </div>
      {right && (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          {right}
        </div>
      )}
    </div>
  );
}
