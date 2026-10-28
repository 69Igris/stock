"use client";

interface MatchScoreBarProps {
  /** 0–100. Out-of-range values are clamped. */
  score: number;
  /** Width in CSS pixels. Defaults to 40. */
  width?: number;
}

/**
 * MATCH score progress bar + score % shown side-by-side. Compact enough
 * to fit in a results-table cell.
 *
 * Playful re-skin (MONEY-485): emerald / gold / coral via design tokens
 * so the bar tracks light + dark themes. Track uses the soft-rule token.
 */
export function MatchScoreBar({ score, width = 40 }: MatchScoreBarProps) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  // Bright token drives the bar fill (large graphic). The AA-safe -text
  // sibling drives the numeric label so it passes contrast (MONEY-498).
  const fillColor =
    clamped >= 80
      ? "var(--emerald)"
      : clamped >= 50
        ? "var(--pop-2)" // gold
        : "var(--pop-1)"; // coral
  const textColor =
    clamped >= 80
      ? "var(--emerald-text)"
      : clamped >= 50
        ? "var(--pop-2-text)"
        : "var(--pop-1-text)";

  return (
    <div className="inline-flex items-center gap-1.5">
      <div
        className="h-[5px] rounded-full overflow-hidden"
        style={{ width, background: "var(--rule-softer)" }}
      >
        <div
          className="h-full"
          style={{ width: `${clamped}%`, background: fillColor }}
        />
      </div>
      <span
        className="mono text-[11px] font-bold tabular-nums"
        style={{ color: textColor }}
      >
        {clamped}
      </span>
    </div>
  );
}

export default MatchScoreBar;
