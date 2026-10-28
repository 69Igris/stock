import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-tradebook-import - route-triggered on /tradebook/import. Walks
 * through broker picker, file drop, duplicate-detection logic, and
 * the import history link.
 */
export const v1TradebookImport: TourDefinition = {
  version: "v1-tradebook-import",
  trigger: { kind: "route", pathPrefix: "/tradebook/import", exact: true },
  priority: 40,
  steps: [
    {
      id: "tradebook-import-broker",
      target: '[data-walkthrough="tradebook-import-broker"]',
      placement: "bottom",
      headline: "Pick your broker format",
      body: "Pick the broker whose CSV you're uploading - Zerodha, Upstox, Dhan, etc. Each has a known column layout so we parse fields correctly.",
    },
    {
      id: "tradebook-import-drop",
      target: '[data-walkthrough="tradebook-import-drop"]',
      placement: "top",
      headline: "Drop or browse",
      body: "Drag the CSV anywhere or click to browse. Up to 50MB per file. We detect duplicates against existing trades.",
    },
    {
      id: "tradebook-import-history",
      target: '[data-walkthrough="tradebook-import-history"]',
      placement: "bottom",
      headline: "Past imports",
      body: "Every import is logged. Tap History to re-process or roll back a previous batch.",
    },
  ],
};
