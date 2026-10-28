import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-tradebook-history - route-triggered on /tradebook/import/history.
 * Past CSV import batches, drill-down per row, re-process action.
 */
export const v1TradebookHistory: TourDefinition = {
  version: "v1-tradebook-history",
  trigger: {
    kind: "route",
    pathPrefix: "/tradebook/import/history",
    exact: true,
  },
  priority: 40,
  steps: [
    {
      id: "tradebook-history-list",
      target: '[data-walkthrough="tradebook-history-list"]',
      placement: "top",
      headline: "Every import, logged",
      body: "Each batch shows broker, row count, duplicates skipped, and import status. Click for the per-row log.",
    },
  ],
};
