"use client";

/**
 * Lazy boundary for the FIRE corpus projection chart (MONEY-290).
 *
 * The chart itself lives in `./CorpusChartCanvas`, which is the only module on
 * this route that imports `recharts`. Loading it through `next/dynamic` keeps
 * recharts out of the /fire entry chunk — it is fetched the first time a
 * projection actually renders.
 *
 * `ssr: false` because recharts' <ResponsiveContainer> measures the DOM: it
 * renders nothing on the server anyway, so server-rendering it only costs
 * payload. The loading fallback fills its parent (which is a fixed-height box
 * in ProjectionChartCard), so the swap-in is CLS-free.
 *
 * The public shape of this module is unchanged — callers keep importing
 * `{ CorpusChartRecharts }` from here.
 */

import dynamic from "next/dynamic";
import type { OneTimeExpense, ProjectionData } from "../lib/types";

interface CorpusChartRechartsProps {
  data: ProjectionData[];
  retireAge: number;
  oneTimes: OneTimeExpense[];
  fireNumberAtRetire: number;
}

function CorpusChartFallback() {
  return (
    <div
      aria-hidden="true"
      style={{
        width: "100%",
        height: "100%",
        borderRadius: 8,
        background:
          "linear-gradient(180deg, var(--rule-softer) 0%, transparent 100%)",
        opacity: 0.6,
      }}
    />
  );
}

export const CorpusChartRecharts = dynamic<CorpusChartRechartsProps>(
  () => import("./CorpusChartCanvas"),
  { ssr: false, loading: CorpusChartFallback }
);
