import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-screener - route-triggered tour on /discover/screener. Covers the
 * mode tabs (Stocks / MF / ETF), search, the per-mode filter panel, the
 * results area, and the "Take the tour" CTA for replays.
 */
export const v1Screener: TourDefinition = {
  version: "v1-screener",
  trigger: { kind: "route", pathPrefix: "/discover/screener" },
  priority: 40,
  steps: [
    {
      id: "screener-modes",
      target: '[data-walkthrough="screener-modes"]',
      placement: "bottom",
      headline: "Three universes, one screener",
      body: "Switch between stocks, mutual funds, and ETFs. Filters and saved scans are per-mode - switching modes doesn't drop your state.",
    },
    {
      id: "screener-filters",
      target: '[data-walkthrough="screener-filters"]',
      placement: "bottom",
      headline: "Search and quick filters",
      body: "Search by ticker, name, or theme. The bar combines with the filter panel below for narrower scans.",
    },
    {
      id: "screener-panel",
      target: '[data-walkthrough="screener-panel"]',
      placement: "bottom",
      headline: "Build your scan",
      body: "Open the filter toggle to combine market cap, P/E, RSI, sector, returns, AUM - fundamentals plus technicals plus AI themes.",
    },
    {
      id: "screener-results",
      target: '[data-walkthrough="screener-results"]',
      placement: "top",
      headline: "Live results",
      body: "Results update as you tweak filters. Click any row to open the full instrument page.",
    },
    {
      id: "screener-replay",
      target: '[data-walkthrough="screener-take-tour"]',
      placement: "bottom",
      headline: "Take the tour again",
      body: "Need a refresher later? This button re-runs the screener walkthrough whenever you click it.",
    },
  ],
};
