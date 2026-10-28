"use client";

import "./placeholders.css";

export interface PfTradingViewPlaceholderProps {
  /** Height of the placeholder in pixels. Default: 220. */
  height?: number;
  /** Optional mono caption rendered below the doodle. */
  label?: string;
  /** Optional italic note rendered below the label. */
  note?: string;
  /** When true, a shimmer overlay is shown (loading state). Default: false. */
  loading?: boolean;
  /** Extra className forwarded to the outer wrapper. */
  className?: string;
}

/**
 * PfTradingViewPlaceholder — framed TradingView chart skeleton.
 *
 * Renders a polyline chart doodle with a "TV" monogram + a small
 * TradingView-credit caption. Theme-aware via CSS variables.
 */
export function PfTradingViewPlaceholder({
  height = 220,
  label,
  note,
  loading = false,
  className,
}: PfTradingViewPlaceholderProps) {
  const displayLabel = label ?? "TRADINGVIEW EMBED";

  return (
    <div
      className={["ph-wrap", className].filter(Boolean).join(" ")}
      style={{ height }}
      role="img"
      aria-label={displayLabel}
    >
      <svg
        width="120"
        height="48"
        viewBox="0 0 120 48"
        aria-hidden="true"
        style={{ opacity: 0.5, maxWidth: "100%" }}
      >
        <polyline
          points="2,38 16,30 28,34 44,22 60,28 76,14 92,18 110,8 118,12"
          fill="none"
          stroke="var(--emerald)"
          strokeWidth="2"
        />
        <text
          x="60"
          y="44"
          fontFamily="JetBrains Mono, monospace"
          fontSize="7"
          fontWeight="700"
          fill="var(--ink-3)"
          textAnchor="middle"
        >
          TV
        </text>
      </svg>

      <span className="ph-label">⬚ {displayLabel}</span>
      {note && <span className="ph-note">{note}</span>}

      {/* TradingView attribution caption */}
      <span className="ph-tv-credit">Powered by TradingView</span>

      {loading && <div className="ph-shimmer-overlay" />}
    </div>
  );
}
