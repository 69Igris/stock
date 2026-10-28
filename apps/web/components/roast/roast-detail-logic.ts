/**
 * Pure logic powering the /roast/[id] detail UI.
 *
 * These helpers live in a `.ts` sibling (no JSX / "use client") so they can be
 * unit-tested under node:test without rendering React. `RoastResults.tsx` (the
 * verdict hero + Deep Diagnostics tiles) and `app/roast/[id]/client.tsx` (the
 * period label) import and call these — there is exactly one implementation of
 * each, exercised by both production and the tests.
 */

import type { StructuredRoastResult } from "@usemoney/types";

/** A single sector row from a roast result. */
export type RoastSectorAnalysis =
  StructuredRoastResult["sectorAnalysis"][number];

/**
 * Pull the first burn highlight as a punchy verdict headline for "THE VERDICT"
 * hero. Falls back to the first praise, then to synthetic copy + a narrative
 * excerpt so the hero always renders something.
 *
 * Typed against the minimal structural slice it reads so both the full
 * `StructuredRoastResult` (component) and lightweight fixtures (tests) satisfy it.
 */
export function pickVerdictLine(
  result: Pick<StructuredRoastResult, "roastHighlights"> & {
    roastNarrative?: string;
  }
): { headline: string; body: string } {
  const firstBurn = result.roastHighlights.find((h) => h.type === "burn");
  if (firstBurn) {
    return { headline: firstBurn.title, body: firstBurn.description };
  }
  const firstPraise = result.roastHighlights[0];
  if (firstPraise) {
    return { headline: firstPraise.title, body: firstPraise.description };
  }
  return {
    headline: "Your portfolio · the unfiltered take",
    body:
      result.roastNarrative?.slice(0, 280) ||
      "AI critique below. Skim-safe, sugar-free.",
  };
}

/**
 * Sum of the top-5 sectors by percentage — the "Concentration · top 5" tile.
 * Proxy for per-stock concentration until that data is ingested.
 */
export function top5SectorConcentration(
  sectors: readonly RoastSectorAnalysis[]
): number {
  return [...sectors]
    .sort((a, b) => b.percentage - a.percentage)
    .slice(0, 5)
    .reduce((s, x) => s + x.percentage, 0);
}

/**
 * Herfindahl-Hirschman Index over sector shares — the "Sector HHI" tile.
 * Sum of squared fractional shares (percentage / 100).
 */
export function sectorHHI(sectors: readonly RoastSectorAnalysis[]): number {
  return sectors.reduce((s, x) => s + Math.pow(x.percentage / 100, 2), 0);
}

/**
 * Cash-sector percentage (case-insensitive match on "cash"), or null when the
 * result carries no cash row — the "Cash allocation" tile.
 */
export function cashAllocation(
  sectors: readonly RoastSectorAnalysis[]
): number | null {
  // `s.sector?.` — this data is LLM output, not a validated shape.
  // `sectorAnalysis` comes from `parseLLMJson<Partial<RoastContentResult>>`
  // with no per-element validation, so a model emitting `{"sector": null, …}`
  // (or omitting the key) made this throw a TypeError inside the render tree
  // and blanked the whole /roast/[sessionId] page. The two sibling helpers here
  // only read `percentage`, which is why they never hit it.
  const cash = sectors.find((s) => s?.sector?.toLowerCase() === "cash");
  return cash ? cash.percentage : null;
}

/**
 * Indian financial-year period label (Apr–Mar) for a roast's createdAt.
 * Q1 = Apr–Jun, Q2 = Jul–Sep, Q3 = Oct–Dec, Q4 = Jan–Mar. FY rolls in April.
 */
export function formatRoastPeriod(date: Date): string {
  const d = new Date(date);
  const m = d.getMonth();
  const fy = m >= 3 ? d.getFullYear() + 1 : d.getFullYear();
  const fyShort = String(fy).slice(-2);
  const quarter = m >= 3 && m <= 5 ? 1 : m >= 6 && m <= 8 ? 2 : m >= 9 ? 3 : 4;
  return `Q${quarter} FY${fyShort}`;
}
