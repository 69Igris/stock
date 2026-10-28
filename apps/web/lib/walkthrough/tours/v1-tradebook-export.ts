import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-tradebook-export - route-triggered on /tradebook/export. Picks
 * format, date range, optional broker / segment filters, and exports.
 */
export const v1TradebookExport: TourDefinition = {
  version: "v1-tradebook-export",
  trigger: { kind: "route", pathPrefix: "/tradebook/export", exact: true },
  priority: 40,
  steps: [
    {
      id: "tradebook-export-format",
      target: '[data-walkthrough="tradebook-export-format"]',
      placement: "bottom",
      headline: "Pick a format",
      body: "CSV for spreadsheets and tax filings; JSON for downstream tooling.",
    },
    {
      id: "tradebook-export-filters",
      target: '[data-walkthrough="tradebook-export-filters"]',
      placement: "bottom",
      headline: "Range + broker + segment",
      body: "Scope the export to a specific period, broker, or segment. Leave blank to export everything.",
    },
    {
      id: "tradebook-export-action",
      target: '[data-walkthrough="tradebook-export-action"]',
      placement: "top",
      headline: "Download",
      body: "We generate the file server-side and download it directly - no email step, no waiting.",
    },
  ],
};
