import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-screener-etf - action-triggered when the user first switches to
 * ETF mode in the Screener. ETFs blend equity + fund characteristics
 * with their own asset-class and theme filters.
 */
export const v1ScreenerEtf: TourDefinition = {
  version: "v1-screener-etf",
  trigger: { kind: "action", eventName: "walkthrough:screener-mode-etf" },
  priority: 30,
  steps: [
    {
      id: "screener-etf-filters",
      target: '[data-walkthrough="screener-etf-filters"]',
      placement: "right",
      headline: "ETF filters",
      body: "Exchange, asset class (Equity / Gold / Debt), theme keyword, AUM, expense ratio, and returns.",
    },
    {
      id: "screener-etf-results",
      target: '[data-walkthrough="screener-etf-results"]',
      placement: "top",
      headline: "ETFs, ranked",
      body: "Compact cards show NAV, AUM, expense, and 1-year return. Click any row for the full ETF page.",
    },
  ],
};
