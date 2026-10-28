"use client";

/**
 * Returns bar chart for the Summary tab (MONEY-244 v3.1, design Image #45).
 *
 * Renders 8 vertical bars (1D / 1W / 1M / 3M / 6M / 1Y / 3Y / 5Y),
 * each colored emerald for positive returns, red for negative. Bar
 * height is proportional to |return%| within the row, capped so the
 * tallest bar fills the canvas and shorter ones scale linearly.
 *
 * Data is fetched via `getStockReturnsAction` against `DailyPrice`,
 * which means the action is fast (1 query, indexed) and degrades
 * gracefully for stocks with limited history (older periods just
 * render an em-dash bar).
 */

import { useEffect, useState } from "react";
import { TrendingUp } from "lucide-react";
import {
  getStockReturnsAction,
  type StockReturns,
  type ReturnsPeriod,
} from "@/lib/actions/stock-tabs";

interface StockReturnsBarsProps {
  symbol: string;
  exchange: string;
}

const PERIODS: ReturnsPeriod[] = [
  "1D",
  "1W",
  "1M",
  "3M",
  "6M",
  "1Y",
  "3Y",
  "5Y",
];
const MAX_BAR_HEIGHT = 64;

function fmt(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "-";
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export function StockReturnsBars({ symbol, exchange }: StockReturnsBarsProps) {
  const [returns, setReturns] = useState<StockReturns>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getStockReturnsAction({ symbol, exchange })
      .then((r) => {
        if (cancelled) return;
        if (r.success) setReturns(r.data);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, exchange]);

  // Determine the max |return| across periods so we can scale bar heights
  // proportionally. Always at least 1 to avoid division-by-zero on
  // perfectly flat ranges.
  const maxAbs = Math.max(
    1,
    ...PERIODS.map((p) => {
      const v = returns[p];
      return v != null && Number.isFinite(v) ? Math.abs(v) : 0;
    })
  );

  return (
    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--gradient-card)] p-5">
      <div className="flex items-center gap-2 mb-5">
        <TrendingUp className="h-4 w-4 text-emerald-400" />
        <h3 className="font-display text-[16px] font-bold tracking-[-0.2px]">
          Returns
        </h3>
      </div>

      <div className="grid grid-cols-8 gap-2">
        {PERIODS.map((p) => {
          const v = returns[p];
          const hasValue = v != null && Number.isFinite(v);
          const abs = hasValue ? Math.abs(v as number) : 0;
          const heightPx = hasValue
            ? Math.max(8, Math.round((abs / maxAbs) * MAX_BAR_HEIGHT))
            : 4;
          const pos = hasValue && (v as number) >= 0;
          return (
            <div key={p} className="flex flex-col items-center gap-2">
              {/* Bar */}
              <div
                className="w-9 flex items-end justify-center"
                style={{ height: MAX_BAR_HEIGHT }}
              >
                <div
                  className={`w-full rounded-[4px] transition-[height] duration-300 ${
                    !hasValue
                      ? "bg-white/[0.06]"
                      : pos
                        ? "bg-emerald-400"
                        : "bg-red-400"
                  }`}
                  style={{ height: `${heightPx}px` }}
                  title={hasValue ? fmt(v) : "No data"}
                />
              </div>
              {/* Period label */}
              <div className="font-mono text-[10px] tracking-[0.6px] uppercase font-bold text-[var(--text-muted)]">
                {p}
              </div>
              {/* Value */}
              <div
                className={`font-mono text-[11px] tabular-nums font-bold ${
                  !hasValue
                    ? "text-[var(--text-muted)]"
                    : pos
                      ? "text-emerald-400"
                      : "text-red-400"
                }`}
              >
                {loading && !hasValue ? "…" : fmt(v)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default StockReturnsBars;
