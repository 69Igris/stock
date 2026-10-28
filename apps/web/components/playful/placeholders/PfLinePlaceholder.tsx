"use client";

import "./placeholders.css";

export interface PfLinePlaceholderProps {
  /** Height of the placeholder in pixels. Default: 220. */
  height?: number;
  /** Optional mono caption rendered below the doodle. */
  label?: string;
  /** Optional italic note rendered below the label. */
  note?: string;
  /**
   * Native tooltip on the wrapper — MONEY-1255's demotion target.
   *
   * The empty body is one sentence everywhere now; a coverage window or
   * "why is this empty" caveat that used to render as `note` rides here
   * instead, matching `SectionShell`'s `title=` + `cursor-help` mechanism.
   */
  title?: string;
  /** When true, a shimmer overlay is shown (loading state). Default: false. */
  loading?: boolean;
  /** Extra className forwarded to the outer wrapper. */
  className?: string;
}

/**
 * PfLinePlaceholder — line / area chart skeleton.
 *
 * Renders a smooth SVG line with a faint area fill so pages can be
 * laid out before live data is wired. Theme-aware via CSS variables.
 */
export function PfLinePlaceholder({
  height = 220,
  label,
  note,
  title,
  loading = false,
  className,
}: PfLinePlaceholderProps) {
  const displayLabel = label ?? "LINE / AREA CHART";

  return (
    <div
      className={["ph-wrap", title ? "cursor-help" : null, className]
        .filter(Boolean)
        .join(" ")}
      style={{ height }}
      title={title}
      role="img"
      aria-label={title ? `${displayLabel}. ${title}` : displayLabel}
    >
      {/* Doodle: smooth area chart */}
      <svg
        width="120"
        height="46"
        viewBox="0 0 120 46"
        aria-hidden="true"
        style={{ opacity: 0.5, maxWidth: "100%" }}
      >
        {/* Area fill */}
        <polygon
          points="2,40 18,30 30,34 46,18 62,24 78,12 96,14 118,4 118,40"
          fill="var(--emerald)"
          stroke="none"
          opacity={0.25}
        />
        {/* Line */}
        <polyline
          points="2,40 18,30 30,34 46,18 62,24 78,12 96,14 118,4"
          fill="none"
          stroke="var(--emerald)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>

      <span className="ph-label">⬚ {displayLabel}</span>
      {note && <span className="ph-note">{note}</span>}
      {loading && <div className="ph-shimmer-overlay" />}
    </div>
  );
}
