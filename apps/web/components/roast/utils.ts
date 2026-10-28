import type { StructuredRoastResult } from "@usemoney/types";

/**
 * Build a rich context string from a roast result for the AI chat panel.
 * Used by both the roast list page and the roast detail page.
 */
export function buildRoastContext(result: StructuredRoastResult): string {
  const parts: string[] = [];

  parts.push(
    "You are discussing THIS SPECIFIC Portfolio Roast result (the data below IS the report the user is looking at). Ground EVERY answer in the specific scores, holdings, sectors, and findings listed below — cite the actual numbers, never speak generically. When the user asks about a particular stock or fund, use its entry below (performance, sector verdict, the roast line) to answer; if they want deeper analysis on that symbol than the report contains, offer to run a research analysis on it. ONLY answer questions related to this roast, portfolio improvement, and the instruments mentioned here — politely refuse unrelated topics. Do NOT re-fetch or re-derive anything already given below."
  );

  parts.push(`\nROAST SUMMARY:`);
  parts.push(`- Overall Score: ${result.overallScore}/100`);

  // Score breakdown
  if (result.scoreBreakdown) {
    parts.push("\nSCORE BREAKDOWN:");
    for (const [key, data] of Object.entries(result.scoreBreakdown)) {
      parts.push(
        `- ${key.replace(/([A-Z])/g, " $1").trim()}: ${data.score}/100 - ${data.comment}`
      );
    }
  }

  // Top performers
  if (result.topPerformers?.length) {
    parts.push("\nTOP PERFORMERS:");
    for (const p of result.topPerformers) {
      parts.push(`- ${p.symbol}: +${p.pnlPercent.toFixed(1)}% - ${p.roast}`);
    }
  }

  // Worst performers
  if (result.worstPerformers?.length) {
    parts.push("\nWORST PERFORMERS:");
    for (const p of result.worstPerformers) {
      parts.push(`- ${p.symbol}: ${p.pnlPercent.toFixed(1)}% - ${p.roast}`);
    }
  }

  // Sector analysis
  if (result.sectorAnalysis?.length) {
    parts.push("\nSECTOR ANALYSIS:");
    for (const s of result.sectorAnalysis) {
      parts.push(
        `- ${s.sector}: ${s.percentage}% (${s.verdict})${s.comment ? ` - ${s.comment}` : ""}`
      );
    }
  }

  // Roast highlights
  if (result.roastHighlights?.length) {
    parts.push("\nROAST HIGHLIGHTS:");
    for (const h of result.roastHighlights) {
      parts.push(`- [${h.type}] ${h.title}: ${h.description}`);
    }
  }

  // Constructive advice
  if (result.constructiveAdvice?.length) {
    parts.push("\nCONSTRUCTIVE ADVICE:");
    for (const a of result.constructiveAdvice) {
      parts.push(`- ${a.title}: ${a.description}`);
    }
  }

  return parts.join("\n");
}
