"use client";

/**
 * ChatBlock — shared anatomy + primitives for the typed financial chat blocks
 * (MONEY-587). Ported from the StockSage "Playful paper" calm-chat design:
 * accent bar → icon header → body → optional CTA → SEBI disclaimer footer.
 *
 * Color encodes DATA QUALITY (good/fair/poor) + DIRECTION (up/down) only,
 * never buy / sell. Numbers are mono / tabular. Styling lives in
 * app/chat-blocks.css (cb-* classes + bridged tokens).
 */

import type { ComponentType, CSSProperties, ReactNode } from "react";
import {
  Briefcase,
  Layers,
  FileText,
  Shield,
  PieChart,
  Flame,
  CandlestickChart,
  Newspaper,
  TrendingUp,
  TrendingDown,
  Scale,
  Gauge as GaugeIcon,
  Sparkles,
  ExternalLink,
  Download,
  Plus,
  X,
  Loader2,
  Clock,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Search,
  type LucideIcon,
} from "lucide-react";

/* ── icon name → lucide map (keeps the ported renderers readable) ───── */
const ICON_MAP: Record<string, LucideIcon> = {
  briefcase: Briefcase,
  layers: Layers,
  file: FileText,
  shield: Shield,
  pieChart: PieChart,
  flame: Flame,
  candle: CandlestickChart,
  newspaper: Newspaper,
  trend: TrendingUp,
  trendDown: TrendingDown,
  scale: Scale,
  gauge: GaugeIcon,
  sparkles: Sparkles,
  external: ExternalLink,
  download: Download,
  plus: Plus,
  x: X,
  loader: Loader2,
  clock: Clock,
  up: ArrowUp,
  down: ArrowDown,
  alert: AlertTriangle,
  refresh: RefreshCw,
  chevron: ChevronDown,
  chevronR: ChevronRight,
  search: Search,
};

export function BIcon({
  name,
  size = 16,
  style,
  className,
}: {
  name: string;
  size?: number;
  style?: CSSProperties;
  className?: string;
}) {
  const Cmp = ICON_MAP[name] ?? Sparkles;
  return (
    <Cmp
      size={size}
      style={{ display: "block", flexShrink: 0, ...style }}
      className={className}
    />
  );
}

const spin: CSSProperties = { animation: "ss-spin 1s linear infinite" };

/* ── SEBI disclaimer copy ───────────────────────────────────────────── */
export const SEBI =
  "Data & education only — not investment advice. No buy / sell / hold signals or price targets. Investments are subject to market risks.";
export const SEBI_SHORT =
  "Educational data only — not advice. Markets carry risk.";

/* ── Shared anatomy ─────────────────────────────────────────────────── */
export function ChatBlock({
  icon,
  iconBg = "var(--emerald-pure)",
  title,
  sub,
  meta,
  accent = true,
  children,
  cta,
  disclaimer,
  className = "",
}: {
  icon?: string;
  iconBg?: string;
  title?: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  accent?: boolean;
  children?: ReactNode;
  cta?: ReactNode;
  disclaimer?: ReactNode;
  className?: string;
}) {
  return (
    <div className={"cb-card cb-settle " + className}>
      {accent && <div className="cb-accent-bar" />}
      {(title || icon) && (
        <div className="cb-head">
          {icon && (
            <span className="cb-ico" style={{ background: iconBg }}>
              <BIcon name={icon} size={15} />
            </span>
          )}
          <span className="cb-title">
            {title}
            {sub && <span className="sub">{sub}</span>}
          </span>
          {meta && <span className="cb-head-meta">{meta}</span>}
        </div>
      )}
      <div className="cb-body">{children}</div>
      {cta && <div className="cb-foot">{cta}</div>}
      {disclaimer && <div className="cb-disclaimer">{disclaimer}</div>}
    </div>
  );
}

/* ── State primitives ───────────────────────────────────────────────── */
export function NeedsData({ label = "needs data" }: { label?: string }) {
  return (
    <span className="cb-nd-note">
      <BIcon name="alert" size={10} /> {label}
    </span>
  );
}
export function ND() {
  return <span className="cb-nd">—</span>;
}
export function PartialBanner({
  children = "Partial result — some fields are still resolving.",
}: {
  children?: ReactNode;
}) {
  return (
    <div className="cb-partial-banner">
      <BIcon name="loader" size={12} style={spin} />
      {children}
    </div>
  );
}
export function CbError({
  kind = "error",
  title,
  children,
  onRetry,
}: {
  kind?: "error" | "warning" | "info";
  title?: ReactNode;
  children?: ReactNode;
  onRetry?: () => void;
}) {
  const color =
    kind === "error"
      ? "var(--poor)"
      : kind === "warning"
        ? "var(--gold-tx)"
        : "var(--blue)";
  return (
    <div className={"cb-error " + kind}>
      <BIcon name="alert" size={15} style={{ color, marginTop: 1 }} />
      <div style={{ flex: 1 }}>
        {title && (
          <div style={{ fontWeight: 700, marginBottom: 2 }}>{title}</div>
        )}
        <div>{children}</div>
        {onRetry && (
          <button
            className="cb-nav-link"
            style={{ marginTop: 9 }}
            onClick={onRetry}
          >
            <BIcon name="refresh" size={12} /> Retry
          </button>
        )}
      </div>
    </div>
  );
}
export function CbEmpty({
  icon = "search",
  title,
  desc,
  cta,
}: {
  icon?: string;
  title?: ReactNode;
  desc?: ReactNode;
  cta?: ReactNode;
}) {
  return (
    <div className="cb-empty">
      <span className="ico">
        <BIcon name={icon} size={20} />
      </span>
      <div className="t">{title}</div>
      {desc && <div className="d">{desc}</div>}
      {cta && <div style={{ marginTop: 13 }}>{cta}</div>}
    </div>
  );
}

/* ── Skeleton atoms ─────────────────────────────────────────────────── */
export function Sk({
  w = "100%",
  h = 12,
  r,
  style,
}: {
  w?: number | string;
  h?: number | string;
  r?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      className="cb-sk"
      style={{
        display: "block",
        width: w,
        height: h,
        borderRadius: r,
        ...style,
      }}
    />
  );
}
export function SkPulse({ label = "fetching live data…" }: { label?: string }) {
  return (
    <div className="cb-sk-pulse">
      <BIcon name="loader" size={11} style={spin} /> {label}
    </div>
  );
}

/* ── Inline visuals ─────────────────────────────────────────────────── */
export function Donut({
  slices,
  size = 92,
  thick = 16,
}: {
  slices: Array<{ v: number; color: string }>;
  size?: number;
  thick?: number;
}) {
  const r = size / 2 - thick / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{ transform: "rotate(-90deg)", flexShrink: 0 }}
    >
      {slices.map((s, i) => {
        const len = (s.v / 100) * c;
        const seg = (
          <circle
            key={i}
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={s.color}
            strokeWidth={thick}
            strokeDasharray={`${len} ${c - len}`}
            strokeDashoffset={-acc}
          />
        );
        acc += len;
        return seg;
      })}
    </svg>
  );
}

export function Gauge({
  pct,
  size = 110,
  label,
  value,
  tone = "var(--emerald-pure)",
}: {
  pct: number;
  size?: number;
  label?: ReactNode;
  value?: ReactNode;
  tone?: string;
}) {
  const r = size / 2 - 9;
  const circ = Math.PI * r;
  const off = circ * (1 - Math.max(0, Math.min(1, pct)));
  return (
    <div style={{ position: "relative", width: size, height: size / 2 + 14 }}>
      <svg
        width={size}
        height={size / 2 + 14}
        viewBox={`0 0 ${size} ${size / 2 + 14}`}
      >
        <path
          d={`M 9 ${size / 2} A ${r} ${r} 0 0 1 ${size - 9} ${size / 2}`}
          fill="none"
          stroke="var(--rule-soft)"
          strokeWidth="9"
          strokeLinecap="round"
        />
        <path
          d={`M 9 ${size / 2} A ${r} ${r} 0 0 1 ${size - 9} ${size / 2}`}
          fill="none"
          stroke={tone}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={off}
        />
      </svg>
      <div
        style={{
          position: "absolute",
          inset: 0,
          top: 14,
          display: "grid",
          placeItems: "center",
          textAlign: "center",
        }}
      >
        <div>
          <div
            className="num"
            style={{ fontSize: 19, fontWeight: 700, lineHeight: 1 }}
          >
            {value}
          </div>
          {label && (
            <div
              className="num"
              style={{
                fontSize: 9,
                color: "var(--ink-4)",
                textTransform: "uppercase",
                letterSpacing: 0.5,
                marginTop: 2,
              }}
            >
              {label}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function MiniArea({
  data,
  w = 200,
  h = 46,
  tone = "var(--emerald-pure)",
}: {
  data: number[];
  w?: number;
  h?: number;
  tone?: string;
}) {
  if (!data || data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const rg = max - min || 1;
  const pts = data
    .map(
      (v, i) =>
        `${(i / (data.length - 1)) * w},${h - ((v - min) / rg) * (h - 4) - 2}`
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      <polygon
        points={`0,${h} ${pts} ${w},${h}`}
        fill={tone}
        fillOpacity=".12"
      />
      <polyline
        points={pts}
        fill="none"
        stroke={tone}
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

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
  tone?: "good" | "fair" | "poor";
}) {
  const pct = Math.max(0, Math.min(1, value / max));
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
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
        flexShrink: 0,
      }}
    >
      <div style={{ position: "relative", width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
          <circle
            cx={cx}
            cy={cx}
            r={r}
            fill="none"
            stroke="var(--rule-soft)"
            strokeWidth="8"
          />
          <circle
            cx={cx}
            cy={cx}
            r={r}
            fill="none"
            stroke={col}
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
  tone?: "good" | "fair" | "poor";
  max?: number;
  delta?: number;
}) {
  const qc = tone
    ? tone === "good"
      ? "var(--good)"
      : tone === "fair"
        ? "var(--fair)"
        : "var(--poor)"
    : "var(--emerald-pure)";
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
          {delta != null && delta !== 0 && (
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
            background: qc,
            borderRadius: 99,
          }}
        />
      </div>
    </div>
  );
}

export function Underwater({
  data,
  height = 90,
}: {
  data: number[];
  height?: number;
}) {
  const W = 320;
  const H = height;
  const n = data.length;
  const mn = Math.min(...data);
  const X = (i: number) => (i / (n - 1)) * W;
  const Y = (v: number) => (-v / (-mn || 1)) * (H - 6);
  const pts = data.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      <polygon
        points={`0,0 ${pts} ${W},0`}
        fill="var(--coral)"
        fillOpacity={0.16}
      />
      <polyline
        points={pts}
        fill="none"
        stroke="var(--coral)"
        strokeWidth="1.6"
      />
      <line
        x1="0"
        y1="1"
        x2={W}
        y2="1"
        stroke="var(--rule-soft)"
        strokeWidth="1"
      />
    </svg>
  );
}

const FAVICON_PALETTE: Record<string, string> = {
  "economictimes.indiatimes.com": "var(--coral)",
  "livemint.com": "var(--blue)",
  "moneycontrol.com": "var(--emerald-pure)",
  "screener.in": "var(--purple)",
  "tickertape.in": "var(--pink)",
  "sebi.gov.in": "var(--ink)",
  "business-standard.com": "var(--gold-fill)",
};
export function Favicon({
  domain,
  size = 22,
}: {
  domain?: string;
  size?: number;
}) {
  const c = (domain && FAVICON_PALETTE[domain]) || "var(--ink-3)";
  const letter = (domain || "?").replace(/^www\./, "")[0]?.toUpperCase() ?? "?";
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
        fontFamily: "JetBrains Mono, monospace",
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

export function Sentiment({ s }: { s: "positive" | "neutral" | "negative" }) {
  const map: Record<string, [string, string]> = {
    positive: ["var(--good)", "▲ positive"],
    neutral: ["var(--ink-3)", "■ neutral"],
    negative: ["var(--poor)", "▼ negative"],
  };
  const [c, t] = map[s] || map.neutral!;
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

export function FlagChip({
  tone = "amber",
  children,
}: {
  tone?: "green" | "amber" | "red" | "blue";
  children: ReactNode;
}) {
  const map: Record<string, [string, string]> = {
    green: ["var(--good)", "var(--emerald-bg)"],
    amber: ["var(--fair)", "rgba(217,155,0,.12)"],
    red: ["var(--poor)", "rgba(232,98,61,.12)"],
    blue: ["var(--blue)", "rgba(37,99,235,.10)"],
  };
  const [c, bg] = map[tone] || map.amber!;
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

export function ConfidencePill({ level }: { level: string }) {
  const map: Record<string, string> = {
    High: "var(--good)",
    Medium: "var(--fair)",
    Low: "var(--poor)",
  };
  const c = map[level] ?? "var(--ink-3)";
  return (
    <span
      className="cb-chip"
      style={{ borderColor: c, color: c, fontSize: 9.5, padding: "2px 8px" }}
    >
      ● {level} confidence
    </span>
  );
}

/* ── ₹ formatting (Indian grouping) ─────────────────────────────────── */
export const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
export const inrShort = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e7) return "₹" + (n / 1e7).toFixed(2) + "Cr";
  if (a >= 1e5) return "₹" + (n / 1e5).toFixed(2) + "L";
  if (a >= 1e3) return "₹" + (n / 1e3).toFixed(1) + "k";
  return "₹" + Math.round(n);
};
export const signedInr = (n: number) => (n >= 0 ? "+" : "−") + inr(Math.abs(n));

/* ── Data-quality color map (good/fair/poor) ────────────────────────────
 * Color encodes DATA QUALITY only — never buy/sell. Mirrors the StockSage
 * report primitives so MetricTile / KVTable / VerdictDot stay SEBI-safe. */
type Quality = "good" | "fair" | "poor";
export const QC: Record<Quality, string> = {
  good: "var(--good)",
  fair: "var(--fair)",
  poor: "var(--poor)",
};

/* ── Sparkline ──────────────────────────────────────────────────────── */
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
  if (!data || data.length < 2) return null;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const r = max - min || 1;
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
        stroke={c}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/* ── TrendArrow (direction-encoded delta) ───────────────────────────────
 * Declared as a function statement so BarRow (above) can reference it. */
export function TrendArrow({
  dir,
  children,
}: {
  dir: "up" | "down" | "flat";
  children?: ReactNode;
}) {
  const up = dir === "up";
  return (
    <span
      className="num"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        color:
          dir === "flat" ? "var(--ink-3)" : up ? "var(--up)" : "var(--down)",
        fontWeight: 600,
        fontSize: 12,
      }}
    >
      {dir !== "flat" && (
        <BIcon
          name={up ? "up" : "down"}
          size={12}
          style={{ strokeWidth: 2.4 }}
        />
      )}
      {children}
    </span>
  );
}

/* ── VerdictDot ─────────────────────────────────────────────────────── */
export function VerdictDot({ v }: { v: Quality }) {
  return (
    <span
      title={v}
      style={{
        width: 8,
        height: 8,
        borderRadius: 99,
        background: QC[v] || "var(--ink-4)",
        display: "inline-block",
        flexShrink: 0,
      }}
    />
  );
}

/* ── MetricTile / MetricStrip ───────────────────────────────────────── */
export interface MetricTileItem {
  label: ReactNode;
  value: ReactNode;
  verdict?: Quality;
  sub?: ReactNode;
}
export function MetricTile({ label, value, verdict, sub }: MetricTileItem) {
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
            fontFamily: "JetBrains Mono, monospace",
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
export function MetricStrip({ items }: { items: MetricTileItem[] }) {
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

/* ── KVTable ────────────────────────────────────────────────────────── */
export interface KVRow {
  k: ReactNode;
  v: ReactNode;
  tone?: Quality;
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

/* ── RangeBar (scenario low/mid/high — a RANGE, not a target) ───────── */
export function RangeBar({
  low,
  mid,
  high,
  current,
  fmt = (x: number) => String(x),
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
          ] as Array<[string, number]>
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
          ] as Array<[string, number]>
        ).map(([k, x]) => (
          <div key={k} style={{ textAlign: "center" }}>
            <div
              style={{
                fontFamily: "JetBrains Mono, monospace",
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

/* ── RadarChart ─────────────────────────────────────────────────────── */
export function RadarChart({
  axes,
  series,
  size = 220,
  max = 100,
}: {
  axes: string[];
  series: Array<{ values: number[] }>;
  size?: number;
  max?: number;
}) {
  const cx = size / 2;
  const R = size / 2 - 34;
  const N = axes.length;
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
          stroke="var(--rule-soft)"
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
            stroke="var(--rule-softer)"
            strokeWidth="1"
          />
        );
      })}
      {series.map((s, si) => (
        <polygon
          key={si}
          points={s.values.map((v, i) => pt(i, v).join(",")).join(" ")}
          fill={cols[si % cols.length]}
          fillOpacity={series.length > 1 ? 0.1 : 0.16}
          stroke={cols[si % cols.length]}
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
            fontFamily="JetBrains Mono, monospace"
            fontSize="8.5"
            fontWeight="600"
            fill="var(--ink-3)"
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

/* ── StackedBar (factor contribution / breakdown) ───────────────────── */
export interface StackedBarItem {
  label: ReactNode;
  value: number;
  color?: string;
  unit?: string;
}
export function StackedBar({
  items,
  total,
}: {
  items: StackedBarItem[];
  total?: number;
}) {
  const sum = total || items.reduce((a, b) => a + b.value, 0) || 1;
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

/* ── Heatmap (sensitivity grid) ─────────────────────────────────────── */
export function Heatmap({
  rows,
  cols,
  data,
  colLabel,
  fmt = (x: number) => String(x),
}: {
  rows: Array<ReactNode>;
  cols: Array<ReactNode>;
  data: number[][];
  rowLabel?: ReactNode;
  colLabel?: ReactNode;
  fmt?: (x: number) => string;
}) {
  const flat = data.flat();
  const mn = Math.min(...flat);
  const mx = Math.max(...flat);
  const rg = mx - mn || 1;
  const shade = (v: number) => {
    const t = (v - mn) / rg;
    return `color-mix(in srgb, var(--emerald-pure) ${Math.round(
      18 + t * 62
    )}%, var(--paper-3))`;
  };
  return (
    <div style={{ overflowX: "auto" }}>
      {colLabel != null && (
        <div
          style={{
            fontFamily: "JetBrains Mono, monospace",
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

/* ── FanChart (Monte-Carlo cone) ────────────────────────────────────── */
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
  const W = 320;
  const H = height;
  const n = bands.p50.length;
  const all = [...bands.p90, ...bands.p10];
  const mx = Math.max(...all);
  const mn = Math.min(...all);
  const rg = mx - mn || 1;
  const X = (i: number) => (i / (n - 1)) * W;
  const Y = (v: number) => H - ((v - mn) / rg) * (H - 10) - 5;
  const line = (arr: number[]) =>
    arr.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
  const area = (hi: number[], lo: number[]) =>
    `${hi.map((v, i) => `${X(i)},${Y(v)}`).join(" ")} ${lo
      .map((_, i) => `${X(n - 1 - i)},${Y(lo[n - 1 - i])}`)
      .join(" ")}`;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      <polygon
        points={area(bands.p90, bands.p10)}
        fill="var(--emerald-pure)"
        fillOpacity={0.1}
      />
      <polygon
        points={area(bands.p75, bands.p25)}
        fill="var(--emerald-pure)"
        fillOpacity={0.18}
      />
      <polyline
        points={line(bands.p50)}
        fill="none"
        stroke="var(--emerald-pure)"
        strokeWidth="2"
      />
      {bands.target != null && (
        <line
          x1="0"
          y1={Y(bands.target)}
          x2={W}
          y2={Y(bands.target)}
          stroke="var(--ink-3)"
          strokeWidth="1"
          strokeDasharray="4 4"
        />
      )}
    </svg>
  );
}

/* ── Candles (candlestick chart + pattern overlay) ──────────────────── */
export interface Candle {
  o: number;
  h: number;
  l: number;
  c: number;
}
export interface CandleMarker {
  i: number;
  y: number;
  label: ReactNode;
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
  const W = 340;
  const H = height;
  const n = data.length;
  const pad = 8;
  const hi = Math.max(...data.map((d) => d.h));
  const lo = Math.min(...data.map((d) => d.l));
  const rg = hi - lo || 1;
  const cw = (W - pad * 2) / n;
  const X = (i: number) => pad + i * cw + cw / 2;
  const Y = (v: number) => pad + (1 - (v - lo) / rg) * (H - pad * 2);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", height: "auto", display: "block" }}
    >
      {data.map((d, i) => {
        const up = d.c >= d.o;
        const col = up ? "var(--up)" : "var(--down)";
        const top = Y(Math.max(d.o, d.c));
        const bot = Y(Math.min(d.o, d.c));
        return (
          <g key={i}>
            <line
              x1={X(i)}
              y1={Y(d.h)}
              x2={X(i)}
              y2={Y(d.l)}
              stroke={col}
              strokeWidth="1"
            />
            <rect
              x={X(i) - cw * 0.3}
              y={top}
              width={cw * 0.6}
              height={Math.max(1, bot - top)}
              fill={col}
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
            stroke="var(--purple)"
            strokeWidth="1.6"
          />
          <text
            x={X(m.i)}
            y={Y(m.y) - 8}
            fontFamily="JetBrains Mono, monospace"
            fontSize="8"
            fontWeight="700"
            textAnchor="middle"
            fill="var(--purple)"
          >
            {m.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ── DegradedNote ───────────────────────────────────────────────────── */
export function DegradedNote({ children }: { children?: ReactNode }) {
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

/* ── IndicatorRow (technical readout) ───────────────────────────────── */
export function IndicatorRow({
  name,
  value,
  signal,
}: {
  name: ReactNode;
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
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span
          className="num"
          style={{ fontSize: 11.5, color: "var(--ink)", fontWeight: 600 }}
        >
          {value}
        </span>
        <span
          className="num"
          style={{
            fontSize: 9.5,
            fontWeight: 700,
            textTransform: "uppercase",
            color: map[signal],
            minWidth: 52,
            textAlign: "right",
          }}
        >
          {signal}
        </span>
      </span>
    </div>
  );
}

/* ── NewsItemCard (favicon / title / source / date / sentiment) ─────── */
export interface NewsItem {
  url: string;
  domain?: string;
  title: ReactNode;
  source?: ReactNode;
  date?: ReactNode;
  sentiment?: "positive" | "neutral" | "negative";
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
        textDecoration: "none",
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
            <span
              className="cite"
              style={{
                marginRight: 5,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                minWidth: 16,
                height: 16,
                padding: "0 4px",
                borderRadius: 5,
                background: "var(--emerald-bg)",
                color: "var(--emerald)",
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 9.5,
                fontWeight: 700,
                verticalAlign: "middle",
              }}
            >
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
          {item.source && (
            <span
              className="num"
              style={{ fontSize: 10, color: "var(--ink-3)", fontWeight: 600 }}
            >
              {item.source}
            </span>
          )}
          {item.date && (
            <span
              className="num"
              style={{ fontSize: 10, color: "var(--ink-4)" }}
            >
              · {item.date}
            </span>
          )}
          {item.sentiment && <Sentiment s={item.sentiment} />}
        </div>
      </div>
    </a>
  );
}

/* ── Per-type skeletons (composed from Sk / SkPulse atoms) ───────────────
 * One skeleton shape per content layout so the loading state echoes the
 * block it is fetching, instead of a generic shimmer. */
export function SkeletonMetric() {
  return (
    <div>
      <Sk w="42%" h={11} />
      <Sk w="64%" h={30} style={{ marginTop: 10 }} />
      <div className="cb-tiles" style={{ marginTop: 14 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="cb-tile">
            <Sk w="50%" h={9} />
            <Sk w="72%" h={16} style={{ marginTop: 7 }} />
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        <SkPulse />
      </div>
    </div>
  );
}
export function SkeletonTable({
  rows = 4,
  cols = 5,
}: {
  rows?: number;
  cols?: number;
}) {
  return (
    <div>
      <div className="cb-sk-row" style={{ marginBottom: 9 }}>
        {Array.from({ length: cols }).map((_, i) => (
          <Sk key={i} w={i === 0 ? "26%" : "16%"} h={9} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="cb-sk-row" style={{ marginBottom: 9 }}>
          {Array.from({ length: cols }).map((_, i) => (
            <Sk key={i} w={i === 0 ? "26%" : "16%"} h={13} />
          ))}
        </div>
      ))}
      <SkPulse />
    </div>
  );
}
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="cb-sk-row"
          style={{
            padding: "9px 11px",
            border: "1.5px solid var(--rule-soft)",
            borderRadius: 10,
          }}
        >
          <Sk w={32} h={32} r={7} />
          <div style={{ flex: 1 }}>
            <Sk w="40%" h={12} />
            <Sk w="60%" h={9} style={{ marginTop: 6 }} />
          </div>
          <Sk w="18%" h={14} />
        </div>
      ))}
      <SkPulse />
    </div>
  );
}
export function SkeletonChart({ h = 120 }: { h?: number }) {
  return (
    <div>
      <div
        style={{
          height: h,
          borderRadius: 10,
          border: "1.5px solid var(--rule-soft)",
          padding: 10,
          display: "flex",
          alignItems: "flex-end",
          gap: 4,
        }}
      >
        {Array.from({ length: 28 }).map((_, i) => (
          <Sk
            key={i}
            w="100%"
            h={20 + Math.abs(Math.sin(i * 0.8)) * 70 + "%"}
            style={{ flex: 1 }}
          />
        ))}
      </div>
      <div style={{ marginTop: 10 }}>
        <SkPulse />
      </div>
    </div>
  );
}
export function SkeletonCompare() {
  return (
    <div>
      <div className="cb-sk-row" style={{ marginBottom: 10 }}>
        <Sk w="30%" h={11} />
        <Sk w="22%" h={11} />
        <Sk w="22%" h={11} />
      </div>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="cb-sk-row" style={{ marginBottom: 9 }}>
          <Sk w="30%" h={13} />
          <Sk w="22%" h={13} />
          <Sk w="22%" h={13} />
        </div>
      ))}
      <SkPulse />
    </div>
  );
}
export function SkeletonGeneric() {
  return (
    <div>
      <Sk w="90%" />
      <Sk w="76%" style={{ marginTop: 9 }} />
      <Sk w="83%" style={{ marginTop: 9 }} />
      <div style={{ marginTop: 12 }}>
        <SkPulse />
      </div>
    </div>
  );
}

export type SkeletonType =
  | "metric"
  | "table"
  | "list"
  | "chart"
  | "compare"
  | "generic";

export const SKELETONS: Record<SkeletonType, ComponentType> = {
  metric: SkeletonMetric,
  table: SkeletonTable,
  list: SkeletonList,
  chart: SkeletonChart,
  compare: SkeletonCompare,
  generic: SkeletonGeneric,
};

/* ── withStates — block state machine ───────────────────────────────────
 * Renders the right chrome for every non-`normal` block state inside the
 * shared ChatBlock shell:
 *   loading → typed skeleton (per `type`)
 *   empty   → CbEmpty
 *   error   → CbError (+ optional onRetry)
 *   partial → PartialBanner (caller still renders its own body below)
 * Returns `null` for `normal` (and for `partial`, only the banner) so the
 * caller can render its real body. Wire it at the top of a renderer:
 *
 *   const chrome = withStates(state, "metric", { icon, title, ... });
 *   if (chrome) return chrome;            // loading / empty / error
 *   return <ChatBlock …>{withStates(state,"metric",cfg,{bannerOnly:true})}…
 */
export type BlockState = "normal" | "loading" | "empty" | "error" | "partial";

export interface WithStatesConfig {
  icon?: string;
  iconBg?: string;
  title?: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  disclaimer?: ReactNode;
  /** empty-state chrome */
  emptyIcon?: string;
  emptyTitle?: ReactNode;
  emptyDesc?: ReactNode;
  emptyCta?: ReactNode;
  /** error-state chrome */
  errorTitle?: ReactNode;
  errorDesc?: ReactNode;
  onRetry?: () => void;
  /** partial-state banner copy */
  partialNote?: ReactNode;
}

export function withStates(
  state: BlockState,
  type: SkeletonType,
  cfg: WithStatesConfig,
  opts?: { bannerOnly?: boolean }
): JSX.Element | null {
  const head = {
    icon: cfg.icon,
    iconBg: cfg.iconBg,
    title: cfg.title,
    sub: cfg.sub,
    meta: cfg.meta,
  };

  // partial only contributes an inline banner; the body renders normally.
  if (state === "partial") {
    return (
      <PartialBanner>
        {cfg.partialNote ?? "Partial result — some fields are still resolving."}
      </PartialBanner>
    );
  }

  // `bannerOnly` callers want nothing for non-partial states.
  if (opts?.bannerOnly) return null;

  if (state === "loading") {
    const Skel = SKELETONS[type] ?? SkeletonGeneric;
    return (
      <ChatBlock {...head} disclaimer={cfg.disclaimer}>
        <Skel />
      </ChatBlock>
    );
  }
  if (state === "empty") {
    return (
      <ChatBlock {...head}>
        <CbEmpty
          icon={cfg.emptyIcon ?? cfg.icon ?? "search"}
          title={cfg.emptyTitle ?? "Nothing here yet"}
          desc={cfg.emptyDesc}
          cta={cfg.emptyCta}
        />
      </ChatBlock>
    );
  }
  if (state === "error") {
    return (
      <ChatBlock {...head}>
        <CbError
          title={cfg.errorTitle ?? "Couldn't load this"}
          onRetry={cfg.onRetry}
        >
          {cfg.errorDesc ?? "Something went wrong fetching this block."}
        </CbError>
      </ChatBlock>
    );
  }
  return null; // normal → caller renders its body
}
