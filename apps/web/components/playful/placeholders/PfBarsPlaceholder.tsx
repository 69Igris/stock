"use client";

import "./placeholders.css";

export interface PfBarsPlaceholderProps {
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

const BAR_HEIGHTS = [18, 32, 24, 40, 28, 44, 36] as const;

/**
 * PfBarsPlaceholder — vertical bar chart skeleton.
 *
 * Seven bars of varying heights with emerald fill and ink stroke.
 * Theme-aware via CSS variables.
 */
export function PfBarsPlaceholder({
  height = 220,
  label,
  note,
  loading = false,
  className,
}: PfBarsPlaceholderProps) {
  const displayLabel = label ?? "BAR CHART";

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
        {BAR_HEIGHTS.map((h, i) => (
          <rect
            key={i}
            x={i * 16 + 4}
            y={48 - h}
            width="10"
            height={h}
            fill="var(--emerald)"
            stroke="var(--ink)"
            strokeWidth="1.2"
            rx="2"
          />
        ))}
      </svg>

      <span className="ph-label">⬚ {displayLabel}</span>
      {note && <span className="ph-note">{note}</span>}
      {loading && <div className="ph-shimmer-overlay" />}
    </div>
  );
}
