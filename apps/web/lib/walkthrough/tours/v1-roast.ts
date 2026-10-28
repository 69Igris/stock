import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-roast - deeper tour fired after the user's first Roast result renders.
 * The Roast result page dispatches `walkthrough:roast-result-shown` once
 * the result is visible; this tour highlights the score, the categories,
 * and the actionable suggestions.
 */
export const v1Roast: TourDefinition = {
  version: "v1-roast",
  trigger: {
    kind: "action",
    eventName: "walkthrough:roast-result-shown",
  },
  priority: 50,
  steps: [
    {
      id: "roast-score",
      target: '[data-walkthrough="roast-score"]',
      placement: "bottom",
      headline: "Your portfolio score",
      body: "An AI-graded score across diversification, risk, and quality - calibrated to Indian markets.",
    },
    {
      id: "roast-breakdown",
      target: '[data-walkthrough="roast-breakdown"]',
      placement: "top",
      headline: "Category breakdown",
      body: "See exactly where you lose points - concentration, sector skew, or quality issues - and by how much.",
    },
    {
      id: "roast-suggestions",
      target: '[data-walkthrough="roast-suggestions"]',
      placement: "top",
      headline: "Actionable suggestions",
      body: "Concrete moves to lift the score. Each suggestion is reasoned, not generic.",
    },
  ],
};
