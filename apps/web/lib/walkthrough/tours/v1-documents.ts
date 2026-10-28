import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-documents - route-triggered tour on /documents (Document Vault).
 * Covers the upload + Generate Report CTAs, category filter pills,
 * search, the document grid/table, and the upload drop zone.
 */
export const v1Documents: TourDefinition = {
  version: "v1-documents",
  trigger: { kind: "route", pathPrefix: "/documents" },
  priority: 50,
  steps: [
    {
      id: "documents-upload",
      target: '[data-walkthrough="documents-upload-cta"]',
      placement: "bottom",
      headline: "One vault for everything",
      body: "Upload annual reports, concall transcripts, CSV exports - or auto-generate Tax / Risk / Portfolio reports as PDFs.",
    },
    {
      id: "documents-filters",
      target: '[data-walkthrough="documents-filters"]',
      placement: "bottom",
      headline: "Filter and search",
      body: "Pin a category, search by file name or content. Each document is indexed so search is semantic, not just text-match.",
    },
    {
      id: "documents-grid",
      target: '[data-walkthrough="documents-grid"]',
      placement: "top",
      headline: "Your documents",
      body: "Click any document to preview, download, or pin it to StockSage for AI Q&A grounded in that file.",
    },
    {
      id: "documents-upload-zone",
      target: '[data-walkthrough="documents-upload-zone"]',
      placement: "top",
      headline: "Drop files here",
      body: "Drag files anywhere on the page, or scroll to the dedicated upload zone for batch imports.",
    },
  ],
};
