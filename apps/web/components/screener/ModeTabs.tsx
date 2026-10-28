"use client";

/**
 * Screener tabs.
 *
 * Wire-level tab IDs ("stocks" / "mf" / "etf") are kept for backward
 * compatibility with existing URL state and server actions, but the UI
 * now collapses MF and ETF into a single "Funds & ETFs" tab per the
 * v3.1 design (Image #42). When the user is on that tab the screener
 * client renders a FundCardCompact grid that unions both server actions'
 * results, sorted by match score.
 */

export type ScreenerMode = "stocks" | "mf" | "etf";

/** Display-level tab ID - what the user actually clicks. */
export type ScreenerTabId = "stocks" | "funds-etfs";

export interface ModeTab {
  id: ScreenerMode;
  label: string;
  /** Live count of total instruments in this mode (e.g. "2,100" or "14k"). */
  count?: string | number;
}

interface ModeTabsProps {
  tabs: ModeTab[];
  active: ScreenerMode;
  onChange: (mode: ScreenerMode) => void;
}

/**
 * Top tab switcher for the Screener.
 *
 * v3.1 (Image #42) collapses MF + ETF into a single "Funds & ETFs"
 * tab - the count is the SUM of both, and clicking the tab routes the
 * user into a unified Funds & ETFs view (with an inner Type chip
 * letting them narrow to MF-only or ETF-only).
 *
 * The legacy three-mode `ScreenerMode` ("stocks" / "mf" / "etf") stays
 * the URL/server-action contract; this component just renders two
 * pills and hides the third internal mode. The screener client maps
 * the display tab back to the right internal mode on click.
 */
export function ModeTabs({ tabs, active, onChange }: ModeTabsProps) {
  // Build the display tabs from the wire-level tabs:
  //   stocks → Stocks (count)
  //   mf+etf → Funds & ETFs (mf.count + etf.count)
  const stocksTab = tabs.find((t) => t.id === "stocks");
  const mfTab = tabs.find((t) => t.id === "mf");
  const etfTab = tabs.find((t) => t.id === "etf");

  function parseCount(c: string | number | undefined): number {
    if (c == null) return 0;
    if (typeof c === "number") return c;
    // Reverse the compact formatter: "14k" → 14000, "2,100" → 2100.
    if (c.endsWith("k")) return Math.round(parseFloat(c) * 1000);
    return parseInt(c.replace(/[^\d]/g, ""), 10) || 0;
  }
  function formatCombined(n: number): string {
    if (n >= 10_000) return `${Math.round(n / 1000)}k`;
    return n.toLocaleString("en-IN");
  }

  const fundsCount = parseCount(mfTab?.count) + parseCount(etfTab?.count);

  // Display-level active tab. "stocks" stays "stocks"; "mf" or "etf" both
  // collapse to "funds-etfs" visually.
  const displayActive: ScreenerTabId =
    active === "stocks" ? "stocks" : "funds-etfs";

  const displayTabs: Array<{
    id: ScreenerTabId;
    label: string;
    count: string;
    /** What internal mode to switch to when the user clicks this tab. */
    targetMode: ScreenerMode;
  }> = [
    {
      id: "stocks",
      label: "Stocks",
      count: stocksTab?.count != null ? String(stocksTab.count) : "0",
      targetMode: "stocks",
    },
    {
      id: "funds-etfs",
      label: "Funds & ETFs",
      count: formatCombined(fundsCount),
      // Default to MF when entering the combined tab; the inner Type
      // chip lets the user flip to ETF without leaving the tab.
      targetMode: "mf",
    },
  ];

  return (
    <div
      className="inline-flex items-center gap-[3px] rounded-[10px] p-[3px]"
      style={{
        border: "2px solid var(--ink)",
        background: "var(--paper-2)",
      }}
    >
      {displayTabs.map((tab) => {
        const isActive = tab.id === displayActive;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.targetMode)}
            className="relative px-3.5 py-1.5 flex items-baseline gap-1.5 mono text-[12.5px] rounded-[7px] transition-colors cursor-pointer"
            style={
              isActive
                ? { background: "var(--ink)", color: "var(--paper)" }
                : { background: "transparent", color: "var(--ink-3)" }
            }
          >
            <span className="font-bold">{tab.label}</span>
            <span
              className="text-[10.5px] tabular-nums"
              style={{ opacity: isActive ? 0.75 : 0.6 }}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default ModeTabs;
