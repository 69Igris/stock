"use client";

/**
 * Recharts leaf for the fund-composition donuts (MONEY-290).
 *
 * Sector allocation and market-cap breakdown render the identical donut, so
 * they share one leaf. This is the only module reachable from
 * FundCompositionSection that imports `recharts`, and it is reached solely
 * through the `next/dynamic` boundary declared there — the /mf, /etf and
 * /stock detail pages must not pay for recharts before a composition has
 * actually been extracted.
 */

import {
  PieChart as RechartsPie,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from "recharts";

/**
 * Declared as a `type`, not an `interface`, on purpose: recharts 3.x types
 * <Pie data> as `ChartDataInput[]` (an index-signature shape), and TypeScript
 * only infers an implicit index signature for type ALIASES. An interface here
 * fails to assign.
 */
export type CompositionDonutSlice = {
  name: string;
  value: number;
  fill: string;
};

export interface FundCompositionDonutCanvasProps {
  data: CompositionDonutSlice[];
}

export default function FundCompositionDonutCanvas({
  data,
}: FundCompositionDonutCanvasProps) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <RechartsPie>
        <Pie
          data={data}
          cx="50%"
          cy="50%"
          innerRadius={50}
          outerRadius={80}
          paddingAngle={2}
          dataKey="value"
        >
          {data.map((slice, index) => (
            <Cell key={`slice-${index}`} fill={slice.fill} />
          ))}
        </Pie>
        <Tooltip formatter={(value) => `${Number(value).toFixed(1)}%`} />
      </RechartsPie>
    </ResponsiveContainer>
  );
}
