import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-screener-mf - action-triggered when the user first switches to
 * Mutual Funds mode in the Screener. MF filters are different from
 * stock filters (AUM, expense ratio, returns by horizon).
 */
export const v1ScreenerMf: TourDefinition = {
  version: "v1-screener-mf",
  trigger: { kind: "action", eventName: "walkthrough:screener-mode-mf" },
  priority: 30,
  steps: [
    {
      id: "screener-mf-filters",
      target: '[data-walkthrough="screener-mf-filters"]',
      placement: "right",
      headline: "Mutual fund filters",
      body: "Filter by AMC, category, plan, risk level, AUM, expense ratio, and 1/3/5-year returns.",
    },
    {
      id: "screener-mf-results",
      target: '[data-walkthrough="screener-mf-results"]',
      placement: "top",
      headline: "Funds, ranked by match",
      body: "Results sort by relevance to your filters. Click any fund to open its full page with peers and holdings.",
    },
  ],
};
