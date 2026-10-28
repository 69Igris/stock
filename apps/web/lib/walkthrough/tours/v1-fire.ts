import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-fire - route-triggered tour on /fire. Walks a new user through the
 * FIRE calculator: scenario naming, life inputs, money assumptions, the
 * projection chart, what-if comparisons, and the save flow.
 */
export const v1Fire: TourDefinition = {
  version: "v1-fire",
  trigger: { kind: "route", pathPrefix: "/fire" },
  priority: 50,
  steps: [
    {
      id: "fire-name",
      target: '[data-walkthrough="fire-scenario-name"]',
      placement: "bottom",
      headline: "Manage scenarios",
      body: 'Each pill here is a saved scenario you can switch between - "Early retirement at 45", "Conservative path". Tap + to start a new one; saved scenarios persist across sessions.',
    },
    {
      id: "fire-life",
      target: '[data-walkthrough="fire-life-inputs"]',
      placement: "left",
      headline: "Your life parameters",
      body: "Current age and target retirement age. The years between drive the entire projection.",
    },
    {
      id: "fire-money",
      target: '[data-walkthrough="fire-money-inputs"]',
      placement: "left",
      headline: "Money assumptions",
      body: "Monthly savings, current corpus, expected return, and inflation. Tweak the sliders to see how each lever moves the outcome.",
    },
    {
      id: "fire-chart",
      target: '[data-walkthrough="fire-projection-chart"]',
      placement: "top",
      headline: "Your corpus, projected",
      body: "Year-by-year corpus growth. The chart re-renders live as you change inputs above.",
    },
    {
      id: "fire-whatif",
      target: '[data-walkthrough="fire-whatif"]',
      placement: "top",
      headline: "Run what-if scenarios",
      body: "Compare alternative paths - extra SIP, delayed retirement, lower returns - without rebuilding the whole scenario. Tap Save scenario in the header to keep it.",
    },
  ],
};
