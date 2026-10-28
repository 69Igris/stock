import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-holdings-positions - action-triggered when the user first opens
 * the Positions tab on /holdings. Open positions (intraday + F&O) work
 * differently from settled holdings: they have MTM, segment, side.
 */
export const v1HoldingsPositions: TourDefinition = {
  version: "v1-holdings-positions",
  trigger: {
    kind: "action",
    eventName: "walkthrough:holdings-positions-opened",
  },
  priority: 40,
  steps: [
    {
      id: "holdings-positions-filter",
      target: '[data-walkthrough="holdings-positions-filter"]',
      placement: "bottom",
      headline: "Intraday vs F&O",
      body: "Filter to intraday equity, F&O, or view all open positions together.",
    },
    {
      id: "holdings-positions-table",
      target: '[data-walkthrough="holdings-positions-table"]',
      placement: "top",
      headline: "Live unrealised P&L",
      body: "Each row shows MTM in real time. Buy/Sell side colour-coded; click to drill into the trade.",
    },
  ],
};
