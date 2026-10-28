import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-holdings-funds - action-triggered when the user first opens the
 * Funds tab on /holdings. Filters and breakdowns differ from Stocks
 * (AMC mix, category split), so this gets its own short tour.
 */
export const v1HoldingsFunds: TourDefinition = {
  version: "v1-holdings-funds",
  trigger: { kind: "action", eventName: "walkthrough:holdings-funds-opened" },
  priority: 40,
  steps: [
    {
      id: "holdings-funds-viz",
      target: '[data-walkthrough="holdings-funds-viz"]',
      placement: "bottom",
      headline: "AMC + category mix",
      body: "Two donuts: AMC concentration and category split (Large Cap, Mid Cap, Debt, etc.). Hover for exact amounts.",
    },
    {
      id: "holdings-funds-filters",
      target: '[data-walkthrough="holdings-funds-filters"]',
      placement: "bottom",
      headline: "Filter funds by AMC or category",
      body: "Slice the table to one AMC or a single category - useful when reviewing concentration risk.",
    },
    {
      id: "holdings-funds-table",
      target: '[data-walkthrough="holdings-funds-table"]',
      placement: "top",
      headline: "Every fund, ranked",
      body: "Click any fund to open the deep-dive page with peers, holdings, and AI analysis.",
    },
  ],
};
