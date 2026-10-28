"use client";

import "./placeholders.css";

export interface PfTextPlaceholderProps {
  /** Height of the placeholder in pixels. Default: 160. */
  height?: number;
  /** Number of shimmer text lines to render. Default: 3. */
  lines?: number;
  /**
   * Per-line width as a fraction of the container (0–1).
   * If fewer values are provided than `lines`, the last value repeats.
   * Default: [1, 0.82, 0.6].
   */
  lineWidths?: number[];
  /** Optional mono caption rendered below the lines. */
  label?: string;
  /** When true, a shimmer overlay is shown (loading state). Default: false. */
  loading?: boolean;
  /** Extra className forwarded to the outer wrapper. */
  className?: string;
}

/**
 * PfTextPlaceholder — shimmer text-lines skeleton.
 *
 * Renders a stacked series of rounded "text line" bars.
 * The last line is narrower by default to mimic natural paragraph endings.
 * Theme-aware via CSS variables.
 */
export function PfTextPlaceholder({
  height = 160,
  lines = 3,
  lineWidths = [1, 0.82, 0.6],
  label,
  loading = false,
  className,
}: PfTextPlaceholderProps) {
  const displayLabel = label ?? "TEXT BLOCK";

  const resolvedWidths = Array.from({ length: lines }, (_, i) => {
    const val = lineWidths[i] ?? lineWidths[lineWidths.length - 1] ?? 0.6;
    return Math.min(1, Math.max(0.05, val));
  });

  return (
    <div
      className={["ph-wrap", className].filter(Boolean).join(" ")}
      style={{ height }}
      role="img"
      aria-label={displayLabel}
    >
      <div className="ph-text-lines">
        {resolvedWidths.map((w, i) => (
          <div
            key={i}
            className="ph-text-line"
            style={{ width: `${w * 100}%` }}
          />
        ))}
      </div>

      <span className="ph-label">⬚ {displayLabel}</span>
      {loading && <div className="ph-shimmer-overlay" />}
    </div>
  );
}
