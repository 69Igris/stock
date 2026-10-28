"use client";

/**
 * Day-range slider that shows the current price's position between the
 * day's low and high. Visual matches the v3 design - left and right
 * labels (low/high) with a horizontal bar and a glowing emerald dot at
 * the current price's relative position.
 *
 * Read-only by design - this is a status indicator, not a control.
 */

import { dayRangePct, formatInr } from "./day-range-logic";

interface DayRangeBarProps {
  low: number | null | undefined;
  high: number | null | undefined;
  current: number | null | undefined;
  /** Optional label e.g. "Day range" / "52W range" - defaults to "Day range". */
  label?: string;
  className?: string;
}

export function DayRangeBar({
  low,
  high,
  current,
  label = "Day range",
  className,
}: DayRangeBarProps) {
  const lo = Number.isFinite(low ?? NaN) ? (low as number) : null;
  const hi = Number.isFinite(high ?? NaN) ? (high as number) : null;
  const cur = Number.isFinite(current ?? NaN) ? (current as number) : null;

  // Dot position 0..1 — clamps out-of-range ticks to the bar edges.
  // Single source of truth: ./day-range-logic.ts (also unit-tested there).
  const pct = dayRangePct(low, high, current);

  const haveData = lo != null && hi != null;

  return (
    <div className={`flex items-center gap-3 ${className ?? ""}`}>
      <span className="font-mono text-[10px] tracking-[1.2px] uppercase font-bold text-[var(--text-muted)] shrink-0">
        {label}
      </span>
      <span className="font-mono text-[12px] tabular-nums text-[var(--text-secondary)] shrink-0">
        {formatInr(lo)}
      </span>
      <div
        className="relative h-1 flex-1 rounded-full overflow-hidden"
        style={{
          background: haveData
            ? "linear-gradient(90deg, rgba(248,113,113,.35) 0%, rgba(255,255,255,.08) 50%, rgba(52,211,153,.35) 100%)"
            : "rgba(255,255,255,.06)",
        }}
      >
        {haveData && cur != null && (
          <div
            className="absolute top-1/2 -translate-y-1/2 h-3 w-3 rounded-full bg-emerald-400"
            style={{
              left: `calc(${(pct * 100).toFixed(2)}% - 6px)`,
              boxShadow:
                "0 0 0 2px rgba(6,11,24,1), 0 0 8px rgba(52,211,153,.7)",
            }}
            aria-label={`Current price ${formatInr(cur)} between ${formatInr(lo)} and ${formatInr(hi)}`}
          />
        )}
      </div>
      <span className="font-mono text-[12px] tabular-nums text-[var(--text-secondary)] shrink-0">
        {formatInr(hi)}
      </span>
    </div>
  );
}

export default DayRangeBar;
