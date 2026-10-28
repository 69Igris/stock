import type { TourDefinition } from "@/components/walkthrough/types";

/**
 * v1-tradebook - route-triggered tour on /tradebook. Covers the trade
 * KPI strip, the sub-nav (Trades / Import / History / Export), date and
 * side filters, the trade table itself, and the Add-trade action.
 */
export const v1Tradebook: TourDefinition = {
  version: "v1-tradebook",
  // Exact match - /tradebook/import, /tradebook/export, etc. are
  // separate sub-routes whose anchors don't live on this tour.
  trigger: { kind: "route", pathPrefix: "/tradebook", exact: true },
  priority: 50,
  steps: [
    {
      id: "tradebook-kpis",
      target: '[data-walkthrough="tradebook-kpis"]',
      placement: "bottom",
      headline: "Trade activity, summarised",
      body: "Trade count, turnover, realised P&L, and win rate - across the period you've selected.",
    },
    {
      id: "tradebook-tabs",
      target: '[data-walkthrough="tradebook-tabs"]',
      placement: "bottom",
      headline: "Trades, Import, History, Export",
      body: "Switch between viewing trades, importing CSVs from brokers, reviewing past imports, or exporting your data.",
    },
    {
      id: "tradebook-range",
      target: '[data-walkthrough="tradebook-range"]',
      placement: "bottom",
      headline: "Time-range filter",
      body: "Last 7 days, 30 days, 3 months, current FY, or all-time. The KPIs and table re-scope to whatever you pick.",
    },
    {
      id: "tradebook-side",
      target: '[data-walkthrough="tradebook-side"]',
      placement: "bottom",
      headline: "Filter by side and segment",
      body: "Buy / Sell / Intraday / Delivery - combine with broker and segment filters to drill into a slice of trades.",
    },
    {
      id: "tradebook-table",
      target: '[data-walkthrough="tradebook-table"]',
      placement: "top",
      headline: "Every trade, paired",
      body: "Sells are paired with their matching buys via FIFO so you see actual P&L per trade, not just averages.",
    },
    {
      id: "tradebook-add",
      target: '[data-walkthrough="tradebook-add"]',
      placement: "left",
      headline: "Add a manual trade",
      body: "Recording a trade your broker missed? Add it manually here - it joins the FIFO pair-matching like the rest.",
    },
  ],
};
