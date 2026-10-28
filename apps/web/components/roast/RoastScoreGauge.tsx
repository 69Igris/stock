"use client";

interface RoastScoreGaugeProps {
  score: number;
  size?: "sm" | "md" | "lg";
}

/**
 * Playful palette anchored on tokens: emerald for healthy scores, gold for the
 * middling band, coral (roast identity) for the danger zone. Returns a CSS var
 * reference so the gauge stays theme-aware in both light and dark.
 */
function getScoreColor(score: number): string {
  if (score < 40) return "var(--pop-1)"; // coral
  if (score < 60) return "var(--pop-1)"; // coral
  if (score < 75) return "var(--pop-2)"; // gold
  return "var(--emerald)";
}

/**
 * AA-compliant `-text` variant of {@link getScoreColor} for the numeric score
 * TEXT. The bright token still drives the SVG arc stroke (a large graphic, so
 * contrast rules don't apply there).
 */
function getScoreTextColor(score: number): string {
  if (score < 40) return "var(--pop-1-text)"; // coral
  if (score < 60) return "var(--pop-1-text)"; // coral
  if (score < 75) return "var(--pop-2-text)"; // gold
  return "var(--emerald-text)";
}

function getScoreLabel(score: number): string {
  if (score < 30) return "Disaster";
  if (score < 40) return "Yikes";
  if (score < 50) return "Rough";
  if (score < 60) return "Meh";
  if (score < 70) return "Decent";
  if (score < 80) return "Solid";
  if (score < 90) return "Great";
  return "Legend";
}

const SIZES = {
  sm: { outer: 80, stroke: 7, fontSize: "text-lg", labelSize: "text-[10px]" },
  md: { outer: 120, stroke: 9, fontSize: "text-3xl", labelSize: "text-xs" },
  lg: { outer: 160, stroke: 11, fontSize: "text-4xl", labelSize: "text-sm" },
};

export default function RoastScoreGauge({
  score,
  size = "md",
}: RoastScoreGaugeProps) {
  const { outer, stroke, fontSize, labelSize } = SIZES[size];
  const radius = (outer - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(100, score));
  const offset = circumference - (progress / 100) * circumference;
  const color = getScoreColor(score);
  const textColor = getScoreTextColor(score);
  const label = getScoreLabel(score);

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg
        width={outer}
        height={outer}
        className="-rotate-90"
        viewBox={`0 0 ${outer} ${outer}`}
      >
        {/* Track - faint ink rule */}
        <circle
          cx={outer / 2}
          cy={outer / 2}
          r={radius}
          fill="none"
          stroke="var(--rule-softer)"
          strokeWidth={stroke}
        />
        {/* Progress arc */}
        <circle
          cx={outer / 2}
          cy={outer / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-1000 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={`${fontSize} font-extrabold mono`}
          style={{ color: textColor }}
        >
          {score}
        </span>
        <span
          className={`${labelSize} mono font-bold uppercase tracking-[1px] text-[var(--ink-3)]`}
        >
          {label}
        </span>
      </div>
    </div>
  );
}
