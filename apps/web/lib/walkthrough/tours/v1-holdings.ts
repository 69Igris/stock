import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-holdings - route-triggered tour on /holdings. Covers the portfolio
 * KPI strip, segment tabs, the broker filter and breakdowns, and the
 * holdings table itself.
 */
export const v1Holdings: TourDefinition = {
  version: "v1-holdings",
  trigger: { kind: "route", pathPrefix: "/holdings" },
  priority: 50,
  steps: [
    {
      id: "holdings-kpis",
      target: '[data-walkthrough="holdings-kpis"]',
      placement: "bottom",
      headline: "Your portfolio at a glance",
      body: "Total value, invested capital, total P&L, and the day's MTM change - all brokers combined.",
    },
    {
      id: "holdings-tabs",
      target: '[data-walkthrough="holdings-tabs"]',
      placement: "bottom",
      headline: "Stocks, MFs, and Positions",
      body: "Switch between equity holdings, mutual funds, and open positions (intraday + F&O) - same filters and views in each.",
    },
    {
      id: "holdings-viz",
      target: '[data-walkthrough="holdings-viz"]',
      placement: "bottom",
      headline: "Sector and market-cap mix",
      body: "Two donuts show where your money sits - sector concentration and large/mid/small split. Hover to see exact amounts.",
    },
    {
      id: "holdings-filters",
      target: '[data-walkthrough="holdings-filters"]',
      placement: "bottom",
      headline: "Filter by broker, sector, cap",
      body: "Slice your view to one broker, a single sector, or a market-cap bucket. Filter pills combine.",
    },
    {
      id: "holdings-table",
      target: '[data-walkthrough="holdings-table"]',
      placement: "top",
      headline: "Every holding, ranked",
      body: "Click any row to open the full stock page with research, paired trades, and AI analysis.",
    },
  ],
};
