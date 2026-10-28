"use client";

/**
 * Recharts leaf for the risk page's sector-allocation donut (MONEY-290).
 *
 * The only module on /risk that imports `recharts`. It is reached exclusively
 * through the `next/dynamic` boundary in `./ConcentrationCard.tsx` — importing
 * it directly would put recharts back into the /risk entry chunk.
 */

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

/**
 * Declared as a `type`, not an `interface`, on purpose: recharts 3.x types
 * <Pie data> as `ChartDataInput[]` (an index-signature shape), and TypeScript
 * only infers an implicit index signature for type ALIASES. An interface here
 * fails to assign.
 */
export type ConcentrationPieSlice = {
  sector: string;
  weight: number;
  count: number;
  fill: string;
};

interface ConcentrationPieCanvasProps {
  data: ConcentrationPieSlice[];
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{
    name: string;
    value: number;
    payload: { sector: string; weight: number; count: number };
  }>;
}

function CustomSectorTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload || !payload[0]) return null;
  const d = payload[0].payload;
  return (
    <div
      className="rounded-lg px-3 py-2 text-sm"
      style={{
        background: "var(--paper-2)",
        border: "1.5px solid var(--ink)",
        boxShadow: "var(--shadow-soft)",
        color: "var(--ink)",
      }}
    >
      <p className="font-semibold">{d.sector}</p>
      <p className="text-[var(--ink-3)]">
        Weight: {(d.weight * 100).toFixed(1)}%
      </p>
      <p className="text-[var(--ink-3)]">
        {d.count} holding{d.count !== 1 ? "s" : ""}
      </p>
    </div>
  );
}

export default function ConcentrationPieCanvas({
  data,
}: ConcentrationPieCanvasProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={30}
          outerRadius={60}
          dataKey="weight"
          nameKey="sector"
          strokeWidth={2}
          stroke="var(--paper)"
        >
          {data.map((entry, index) => (
            <Cell key={`cell-${index}`} fill={entry.fill} />
          ))}
        </Pie>
        <Tooltip content={<CustomSectorTooltip />} />
      </PieChart>
    </ResponsiveContainer>
  );
}
