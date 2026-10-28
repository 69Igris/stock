"use client";

import "./placeholders.css";

export interface PfSparkPlaceholderProps {
  /** Height of the spark placeholder in pixels. Default: 32. */
  height?: number;
  /** Optional mono caption — if omitted the label is suppressed (inline use). */
  label?: string;
  /** When true, a shimmer overlay is shown (loading state). Default: false. */
  loading?: boolean;
  /** Extra className forwarded to the outer wrapper. */
  className?: string;
  /**
   * When true the component renders inline (no label, minimal height).
   * Ideal for table cells. Default: false.
   */
  inline?: boolean;
}

/**
 * PfSparkPlaceholder — tiny inline sparkline skeleton.
 *
 * Lightweight enough to drop into table cells or stat cards.
 * Fills 100% of container width; never causes horizontal scroll.
 * Theme-aware via CSS variables.
 */
export function PfSparkPlaceholder({
  height = 32,
  label,
  loading = false,
  className,
  inline = false,
}: PfSparkPlaceholderProps) {
  const displayLabel = label ?? (inline ? undefined : "SPARKLINE");

  if (inline) {
    /* Minimal inline variant — just the SVG, no border/bg wrapper */
    return (
      <span
        className={["ph-spark-wrap", className].filter(Boolean).join(" ")}
        style={{ height }}
      >
        <svg
          width="100"
          height={height}
          viewBox={`0 0 100 ${height}`}
          aria-hidden="true"
          preserveAspectRatio="none"
          style={{ opacity: 0.55, width: "100%", maxWidth: 100 }}
        >
          <polyline
            points={`2,${height * 0.7} 18,${height * 0.5} 32,${height * 0.63} 50,${height * 0.25} 66,${height * 0.38} 82,${height * 0.13} 98,${height * 0.25}`}
            fill="none"
            stroke="var(--emerald)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
        {loading && (
          <div className="ph-shimmer-overlay" style={{ borderRadius: 4 }} />
        )}
      </span>
    );
  }

  return (
    <div
      className={["ph-wrap", className].filter(Boolean).join(" ")}
      style={{ height: height < 60 ? 60 : height }}
      role="img"
      aria-label={displayLabel ?? "SPARKLINE"}
    >
      <svg
        width="100"
        height="32"
        viewBox="0 0 100 32"
        aria-hidden="true"
        style={{ opacity: 0.55, maxWidth: "100%" }}
      >
        <polyline
          points="2,22 18,16 32,20 50,8 66,12 82,4 98,8"
          fill="none"
          stroke="var(--emerald)"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      </svg>

      {displayLabel && <span className="ph-label">⬚ {displayLabel}</span>}
      {loading && <div className="ph-shimmer-overlay" />}
    </div>
  );
}
