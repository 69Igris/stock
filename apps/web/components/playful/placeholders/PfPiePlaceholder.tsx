"use client";

import "./placeholders.css";

export interface PfPiePlaceholderProps {
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
 * PfPiePlaceholder — donut / pie chart skeleton.
 *
 * Renders two pie segments with a circular outline.
 * Theme-aware via CSS variables.
 */
export function PfPiePlaceholder({
  height = 220,
  label,
  note,
  loading = false,
  className,
}: PfPiePlaceholderProps) {
  const displayLabel = label ?? "DONUT / PIE";

  return (
    <div
      className={["ph-wrap", className].filter(Boolean).join(" ")}
      style={{ height }}
      role="img"
      aria-label={displayLabel}
    >
      <svg
        width="64"
        height="64"
        viewBox="0 0 64 64"
        aria-hidden="true"
        style={{ opacity: 0.55, maxWidth: "100%" }}
      >
        {/* Outer ring */}
        <circle
          cx="32"
          cy="32"
          r="22"
          fill="none"
          stroke="var(--ink)"
          strokeWidth="2"
        />
        {/* Segment 1 — emerald */}
        <path
          d="M32 32 L32 10 A22 22 0 0 1 53 38 Z"
          fill="var(--emerald)"
          stroke="var(--ink)"
          strokeWidth="1.5"
        />
        {/* Segment 2 — pop-2 / gold */}
        <path
          d="M32 32 L53 38 A22 22 0 0 1 26 53 Z"
          fill="var(--pop-2)"
          stroke="var(--ink)"
          strokeWidth="1.5"
        />
      </svg>

      <span className="ph-label">⬚ {displayLabel}</span>
      {note && <span className="ph-note">{note}</span>}
      {loading && <div className="ph-shimmer-overlay" />}
    </div>
  );
}
