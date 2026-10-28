"use client";

import type { AssetClass } from "../lib/types";

interface AllocationDonutProps {
  classes: AssetClass[];
  weightedReturn: number;
}

export function AllocationDonut({
  classes,
  weightedReturn,
}: AllocationDonutProps) {
  const sum = classes.reduce((s, c) => s + c.allocation, 0) || 1;
  const R = 50,
    r = 32,
    cx = 60,
    cy = 60;
  let acc = 0;
  return (
    <svg viewBox="0 0 120 120" style={{ width: 120, height: 120 }}>
      {classes.map((c) => {
        const frac = c.allocation / sum;
        if (frac < 0.001) return null;
        const a0 = acc * Math.PI * 2 - Math.PI / 2;
        const a1 = (acc + frac) * Math.PI * 2 - Math.PI / 2;
        acc += frac;
        const large = frac > 0.5 ? 1 : 0;
        const x0 = cx + R * Math.cos(a0),
          y0 = cy + R * Math.sin(a0);
        const x1 = cx + R * Math.cos(a1),
          y1 = cy + R * Math.sin(a1);
        const xi0 = cx + r * Math.cos(a0),
          yi0 = cy + r * Math.sin(a0);
        const xi1 = cx + r * Math.cos(a1),
          yi1 = cy + r * Math.sin(a1);
        return (
          <path
            key={c.id}
            d={`M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${xi1},${yi1} A${r},${r} 0 ${large} 0 ${xi0},${yi0} Z`}
            fill={c.color}
            opacity={0.9}
            stroke="var(--paper)"
            strokeWidth={1}
          />
        );
      })}
      <text
        x={60}
        y={56}
        textAnchor="middle"
        fill="var(--ink-3)"
        fontSize="8"
        fontFamily="JetBrains Mono, monospace"
        fontWeight={700}
      >
        WEIGHTED
      </text>
      <text
        x={60}
        y={70}
        textAnchor="middle"
        fill="var(--emerald)"
        fontSize="14"
        fontFamily="JetBrains Mono, monospace"
        fontWeight={700}
      >
        {weightedReturn.toFixed(1)}%
      </text>
    </svg>
  );
}
