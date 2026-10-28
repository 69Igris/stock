"use client";

import "./placeholders.css";

export interface PfCandlePlaceholderProps {
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

interface CandleData {
  x: number;
  y: number;
  h: number;
  up: boolean;
}

const CANDLES: CandleData[] = [
  { x: 8, y: 12, h: 28, up: true },
  { x: 28, y: 8, h: 22, up: false },
  { x: 48, y: 16, h: 24, up: true },
  { x: 68, y: 6, h: 18, up: true },
  { x: 88, y: 14, h: 30, up: false },
  { x: 108, y: 4, h: 26, up: true },
  { x: 128, y: 18, h: 22, up: true },
];

/**
 * PfCandlePlaceholder — candlestick chart skeleton.
 *
 * Seven candles with wicks, alternating up (emerald) / down (pop-1 / coral).
 * Theme-aware via CSS variables.
 */
export function PfCandlePlaceholder({
  height = 220,
  label,
  note,
  loading = false,
  className,
}: PfCandlePlaceholderProps) {
  const displayLabel = label ?? "CANDLE CHART";

  return (
    <div
      className={["ph-wrap", className].filter(Boolean).join(" ")}
      style={{ height }}
      role="img"
      aria-label={displayLabel}
    >
      <svg
        width="140"
        height="50"
        viewBox="0 0 140 50"
        aria-hidden="true"
        style={{ opacity: 0.55, maxWidth: "100%" }}
      >
        {CANDLES.map((d, i) => (
          <g key={i}>
            {/* Wick */}
            <line
              x1={d.x + 5}
              x2={d.x + 5}
              y1={d.y - 4}
              y2={d.y + d.h + 4}
              stroke="var(--ink)"
              strokeWidth="1.4"
            />
            {/* Body */}
            <rect
              x={d.x}
              y={d.y}
              width="10"
              height={d.h}
              fill={d.up ? "var(--emerald)" : "var(--pop-1)"}
              stroke="var(--ink)"
              strokeWidth="1.4"
              rx="1"
            />
          </g>
        ))}
      </svg>

      <span className="ph-label">⬚ {displayLabel}</span>
      {note && <span className="ph-note">{note}</span>}
      {loading && <div className="ph-shimmer-overlay" />}
    </div>
  );
}
