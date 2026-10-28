"use client";

import "./placeholders.css";

export interface PfTreemapPlaceholderProps {
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
 * PfTreemapPlaceholder — treemap grid skeleton.
 *
 * Four rectangles representing typical treemap proportions (large dominant
 * tile + three smaller tiles). Uses pop-color palette for visual hierarchy.
 * Theme-aware via CSS variables.
 */
export function PfTreemapPlaceholder({
  height = 220,
  label,
  note,
  loading = false,
  className,
}: PfTreemapPlaceholderProps) {
  const displayLabel = label ?? "TREEMAP";

  return (
    <div
      className={["ph-wrap", className].filter(Boolean).join(" ")}
      style={{ height }}
      role="img"
      aria-label={displayLabel}
    >
      <svg
        width="120"
        height="50"
        viewBox="0 0 120 50"
        aria-hidden="true"
        style={{ opacity: 0.55, maxWidth: "100%" }}
      >
        {/* Large dominant cell */}
        <rect
          x="0"
          y="0"
          width="60"
          height="50"
          fill="var(--emerald)"
          stroke="var(--ink)"
          strokeWidth="1.5"
        />
        {/* Medium top-right */}
        <rect
          x="60"
          y="0"
          width="36"
          height="28"
          fill="var(--pop-2)"
          stroke="var(--ink)"
          strokeWidth="1.5"
        />
        {/* Small top-far-right */}
        <rect
          x="96"
          y="0"
          width="24"
          height="28"
          fill="var(--pop-3)"
          stroke="var(--ink)"
          strokeWidth="1.5"
        />
        {/* Bottom-right strip */}
        <rect
          x="60"
          y="28"
          width="60"
          height="22"
          fill="var(--pop-1)"
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
