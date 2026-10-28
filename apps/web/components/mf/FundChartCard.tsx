"use client";

/**
 * Fund chart card with a Native ↔ TradingView toggle (MONEY-245).
 *
 * Default = Native NAV growth chart matching the v3.1 design (emerald
 * area-fill vs benchmark dotted line). Toggle flips to the existing
 * TradingView Advanced Chart so power users can keep their drawing
 * tools and indicators.
 *
 * The toggle state persists per-scheme in localStorage so a user who
 * always wants TradingView only flips it once.
 */

import { useEffect, useState } from "react";
import { LineChart, CandlestickChart } from "lucide-react";
import { TradingViewAdvancedChart } from "@/components/charts";
import { NavGrowthChart, type NavPeriod } from "@/components/mf/NavGrowthChart";

type ChartKind = "native" | "tradingview";

interface FundChartCardProps {
  schemeCode: string;
  /** Used as the symbol the TradingView chart resolves against. */
  schemeName: string;
  /** Display name of the benchmark for the native chart legend. */
  benchmarkName?: string;
  /** Initial period for the native chart. */
  initialPeriod?: NavPeriod;
  /** TradingView chart canvas height. Native chart uses its own default. */
  tvHeight?: number;
}

function storageKey(schemeCode: string): string {
  return `fund.chart.${schemeCode}`;
}

export function FundChartCard({
  schemeCode,
  schemeName,
  benchmarkName,
  initialPeriod = "3Y",
  tvHeight = 480,
}: FundChartCardProps) {
  // Hydration-safe: render `native` on the server (matches the design
  // default) and read storage in a useEffect so the first paint isn't
  // mismatched between server and client.
  const [kind, setKind] = useState<ChartKind>("native");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem(storageKey(schemeCode));
    if (stored === "tradingview" || stored === "native") setKind(stored);
  }, [schemeCode]);

  function update(next: ChartKind) {
    setKind(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey(schemeCode), next);
    }
  }

  return (
    <div>
      {/* Toggle row sits ABOVE the chart card (not floating on top of it)
          so it can't overlap the legend pills inside the chart header.
          Right-aligned so the visual centre of gravity stays on the
          chart itself. */}
      <div className="flex items-center mb-2.5">
        <div
          className="ml-auto inline-flex items-center gap-[2px] rounded-[7px] p-[2px]"
          style={{
            border: "1.5px solid var(--ink)",
            background: "var(--paper-2)",
          }}
        >
          <ToggleButton
            active={kind === "native"}
            onClick={() => update("native")}
            icon={LineChart}
            label="Native"
          />
          <ToggleButton
            active={kind === "tradingview"}
            onClick={() => update("tradingview")}
            icon={CandlestickChart}
            label="TradingView"
          />
        </div>
      </div>

      {kind === "native" ? (
        <NavGrowthChart
          schemeCode={schemeCode}
          benchmarkName={benchmarkName}
          initialPeriod={initialPeriod}
        />
      ) : (
        <div
          className="rounded-xl overflow-hidden pf-card"
          style={{ padding: 0 }}
        >
          <TradingViewAdvancedChart
            symbol={schemeCode}
            exchange="NSE"
            height={tvHeight}
            showDelayedDataNote={false}
          />
        </div>
      )}
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-[5px] text-[11px] font-mono font-semibold cursor-pointer transition-colors"
      style={
        active
          ? { background: "var(--ink)", color: "var(--paper)" }
          : { background: "transparent", color: "var(--ink-3)" }
      }
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}

export default FundChartCard;
