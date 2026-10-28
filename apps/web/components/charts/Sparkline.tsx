"use client";

/**
 * Sparkline - tiny SVG trend chart for list views.
 *
 * Intentionally minimal: one polyline + one gradient fill, no axes, no
 * tooltips. Designed to render cheaply when 50+ sparklines appear on a
 * single page (watchlist, markets overview, screener).
 *
 * Ports the reference design from design-system/ui_kits/app/primitives.jsx:44
 * with one extra affordance: a fade-in placeholder when data is empty so
 * the layout doesn't jump between render passes.
 */

import { useId } from "react";

import { sparklinePointsAttr } from "./sparkline-logic";

export type SparklineTone = "pos" | "neg" | "accent" | "muted";

export interface SparklineProps {
  /** Close-price array. Must have ≥ 2 points to render a line. */
  data: number[];
  /** Visual tone - defaults to "pos" (emerald). "accent" is brand emerald; "muted" is neutral. */
  tone?: SparklineTone;
  /** Width in CSS pixels. Default 80. */
  width?: number;
  /** Height in CSS pixels. Default 24. */
  height?: number;
  /** Optional accessible label. */
  ariaLabel?: string;
  /** Optional className for container. */
  className?: string;
}

const TONE_COLORS: Record<SparklineTone, string> = {
  pos: "#4ade80",
  neg: "#f87171",
  accent: "#34d399",
  muted: "rgba(255,255,255,0.35)",
};

/**
 * Derive tone automatically from an array: positive slope → "pos", negative → "neg".
 * Useful for list views where the row's change% isn't readily available.
 */
export function autoTone(data: number[]): SparklineTone {
  if (data.length < 2) return "muted";
  const first = data[0]!;
  const last = data[data.length - 1]!;
  if (last > first) return "pos";
  if (last < first) return "neg";
  return "muted";
}

export function Sparkline({
  data,
  tone = "pos",
  width = 80,
  height = 24,
  ariaLabel,
  className,
}: SparklineProps) {
  const gradId = useId();
  const color = TONE_COLORS[tone];

  // Guarded scaling (./sparkline-logic.ts → packages/services/src/sparkline-logic.ts):
  // drops non-finite bars before computing min/max (a single NaN/Infinity used to
  // poison Math.min/Math.max and blank the entire line), centres a flat series
  // instead of pinning it to the bottom, and returns "" for any series that can't
  // render (<2 finite points / empty / all-non-finite) so we draw the placeholder.
  const points = sparklinePointsAttr(data, { width, height });

  if (points === "") {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-label={ariaLabel ?? "Sparkline unavailable"}
        className={className}
        style={{ display: "block" }}
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke={TONE_COLORS.muted}
          strokeWidth={1}
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={
        ariaLabel ?? `Sparkline with ${points.split(" ").length} data points`
      }
      className={className}
      style={{ display: "block" }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polyline
        points={`0,${height} ${points} ${width},${height}`}
        fill={`url(#${gradId})`}
        stroke="none"
      />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default Sparkline;
