/**
 * Research Result to ContentBlock Converter
 *
 * Converts the data from getResearchResultAction into
 * renderable ContentBlock[] for the chat UI.
 *
 * For structured JSON reports, renders:
 * 1. Score card with recommendation and confidence
 * 2. Summary text
 * 3. Key metrics table
 * 4. Strengths & risks
 * 5. "View Full Analysis" navigation link
 */

import type { ContentBlock, ScorecardBlock } from "@usemoney/types";
import { stripRecommendationLanguage } from "@usemoney/utils/sanitize-recommendation";

/**
 * MONEY-457: Scrub recommendation language out of any prose string we read
 * out of a stored research report before rendering it into a chat block.
 * Returns the original value untouched when it's not a string (the
 * ContentBlock schema allows numbers, booleans, etc. in `value` slots).
 */
function safeScrub(v: unknown): string {
  if (typeof v !== "string") return String(v ?? "");
  return stripRecommendationLanguage(v);
}

/** Map a 0–100 confidence number to the scorecard's High/Medium/Low pill. */
export function confidenceLabel(
  c?: number
): "High" | "Medium" | "Low" | undefined {
  if (c == null) return undefined;
  if (c >= 70) return "High";
  if (c >= 45) return "Medium";
  return "Low";
}

/** First sentence (≤240 chars) of prose — used for the scorecard verdict. */
export function firstSentence(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^[\s\S]*?[.!?](\s|$)/);
  return (m ? m[0] : trimmed).trim().slice(0, 240);
}

/**
 * Normalise a quality score that may arrive on a 0–1 or 0–100 scale into a
 * whole-number 0–100 percentage. Exported (and called by convertResearchToBlocks)
 * so the dual-scale handling can be asserted directly.
 */
export function normalizeQualityScore(score: number): number {
  return score <= 1 ? Math.round(score * 100) : Math.round(score);
}

/**
 * Build the `scorecard` block's `sections` from a structured report's score,
 * key metrics, and scored dimensions (`scoreBreakdown`). Exported and called by
 * both `convertResearchToBlocks` and `convertFullReportToBlocks`, so the
 * transform (Key-metrics section first, then one section per breakdown criterion
 * with `pct = score/maxScore*100`, all strings scrubbed) is unit-testable.
 */
export function buildScorecardSections(structured: {
  score?: number;
  keyMetrics?: Array<{ label: string; value: string }>;
  scoreBreakdown?: Array<{
    criterion: string;
    score: number;
    maxScore: number;
    comment?: string;
  }>;
}): NonNullable<ScorecardBlock["sections"]> {
  const score = structured.score ?? 0;
  const sections: NonNullable<ScorecardBlock["sections"]> = [];

  if (structured.keyMetrics && structured.keyMetrics.length > 0) {
    sections.push({
      title: "Key metrics",
      score: Math.round(score),
      // MONEY-457: scrub stored label/value strings.
      metrics: structured.keyMetrics
        .slice(0, 8)
        .map(
          (m) => [safeScrub(m.label), safeScrub(m.value)] as [string, string]
        ),
    });
  }
  for (const sb of structured.scoreBreakdown ?? []) {
    const pct = sb.maxScore
      ? Math.round((sb.score / sb.maxScore) * 100)
      : Math.round(sb.score);
    sections.push({
      title: sb.criterion,
      score: pct,
      summary: sb.comment ? safeScrub(sb.comment) : undefined,
      metrics: [],
    });
  }
  return sections;
}

interface ResearchResult {
  report: unknown;
  contentBlocks: unknown[];
  qualityScore?: number;
  tokensUsed: number;
  symbols: string[];
  sessionId?: string;
}

interface StructuredReport {
  score?: number;
  recommendation?: string;
  confidence?: number;
  summary?: string;
  keyMetrics?: Array<{
    label: string;
    value: string;
    verdict?: string;
  }>;
  strengths?: string[];
  risks?: string[];
  priceTarget?: {
    low?: number;
    mid?: number;
    high?: number;
    current?: number;
    method?: string;
  };
  sections?: Array<{
    title: string;
    content?: string;
    type: string;
    metrics?: Array<{
      label: string;
      value: string;
      trend?: string;
      verdict?: string;
    }>;
    dcf?: {
      intrinsicValue: number;
      currentPrice: number;
      upside: number;
    };
    columns?: string[];
    rows?: string[][];
  }>;
  scoreBreakdown?: Array<{
    criterion: string;
    score: number;
    maxScore: number;
    comment?: string;
  }>;
  catalysts?: Array<{
    event: string;
    timeline: string;
    impact: string;
  }>;
  technicals?: {
    trend: string;
    support: number;
    resistance: number;
    rsi?: number;
  };
  disclaimer?: string;
}

/**
 * Type guard: check if an unknown value looks like a valid ContentBlock
 */
export function isValidContentBlock(block: unknown): block is ContentBlock {
  if (!block || typeof block !== "object") return false;
  const b = block as Record<string, unknown>;
  return (
    typeof b.type === "string" &&
    [
      "text",
      "table",
      "card",
      "chart",
      "action",
      "navigation",
      "comparison",
      "stock-list",
      "error",
      "research-prompt",
      "research-stream",
      "roast-summary",
      "refusal",
      // MONEY-587 typed financial blocks
      "portfolio",
      "holdings",
      "tax",
      "risk",
      "mf",
      "fire",
      "sector",
      "technical",
      "news",
      "scorecard",
      "pnl",
      "dividend",
    ].includes(b.type)
  );
}

/**
 * Check if a report is a structured JSON report (has score + recommendation)
 */
export function isStructuredReport(
  report: unknown
): report is StructuredReport {
  if (!report || typeof report !== "object") return false;
  const r = report as Record<string, unknown>;
  return typeof r.score === "number" || typeof r.recommendation === "string";
}

/**
 * Convert structured research result into chat-friendly ContentBlock[]
 */
export function convertResearchToBlocks(
  result: ResearchResult
): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  // Check if report is a structured JSON object (may be nested under .content)
  const report = result.report as Record<string, unknown> | null;
  const structuredReport = report?.content
    ? isStructuredReport(report.content)
      ? (report.content as StructuredReport)
      : isStructuredReport(report)
        ? (report as unknown as StructuredReport)
        : null
    : isStructuredReport(report)
      ? (report as unknown as StructuredReport)
      : null;

  if (structuredReport) {
    return convertStructuredReportToBlocks(structuredReport, result);
  }

  // Fallback: use worker-produced contentBlocks if available
  if (result.contentBlocks && result.contentBlocks.length > 0) {
    for (const block of result.contentBlocks) {
      if (isValidContentBlock(block)) {
        blocks.push(block);
      }
    }
  }

  // Fallback: convert report to text block
  if (blocks.length === 0 && result.report) {
    const reportObj = result.report as Record<string, unknown>;
    const content =
      typeof reportObj.content === "string"
        ? reportObj.content
        : JSON.stringify(reportObj, null, 2);
    blocks.push({ type: "text", content });
  }

  // Add quality score as a `scorecard` block if available (normalize: may be
  // 0-1 or 0-100). MONEY-587: a normal research completion always surfaces the
  // rich scorecard (overall dial + symbol) — not a flat metric card — even on
  // the non-structured fallback path, so the scorecard isn't Load-Full-only.
  if (result.qualityScore) {
    const normalizedScore = normalizeQualityScore(result.qualityScore);
    const symbol =
      result.symbols.length > 1
        ? result.symbols.map((s) => s.replace(/\.(NS|BO)$/, "")).join(" vs ")
        : result.symbols[0]?.replace(/\.(NS|BO)$/, "") || undefined;
    blocks.push({
      type: "scorecard",
      symbol,
      title: symbol ? undefined : "Research quality",
      overall: normalizedScore,
      sessionId: result.sessionId || undefined,
      sections: [],
    });
  }

  // Fallback
  if (blocks.length === 0) {
    blocks.push({
      type: "text",
      content: "Research completed but no results available.",
    });
  }

  return blocks;
}

/**
 * @deprecated MONEY-457 — SEBI compliance. "X Preferred" is a research
 * recommendation under SEBI RA Regulations 2014 and UseMoney is not a
 * registered Research Analyst. Function is no longer called from any
 * render path (MONEY-445 removed the call sites) and kept here only so
 * tests / external imports keep building. Do NOT call this in new code.
 */
export function formatRecForDisplay(rec: string, symbols: string[]): string {
  const cleanSymbols = symbols.map((s) => s.replace(/\.(NS|BO)$/, ""));
  if (rec === "EQUAL") return "Comparison";
  if (rec.endsWith("_PREFERRED")) return "Comparison";
  return rec;
}

/**
 * Check if a recommendation is a comparison code (still used by layout
 * logic to decide whether to render the per-stock score chart — does
 * NOT emit any user-facing label).
 */
export function isComparisonRec(rec: string): boolean {
  return rec === "EQUAL" || rec.endsWith("_PREFERRED");
}

/**
 * Convert a full research result into expanded ContentBlock[] for inline chat rendering.
 *
 * This renders ALL report sections (score breakdown, detailed sections with DCF/tables,
 * catalysts, technicals) - not just the summary. Used when user clicks "Load Full Report".
 */
export function convertFullReportToBlocks(
  result: ResearchResult
): ContentBlock[] {
  const report = result.report as Record<string, unknown> | null;
  const structured = report?.content
    ? isStructuredReport(report.content)
      ? (report.content as StructuredReport)
      : isStructuredReport(report)
        ? (report as unknown as StructuredReport)
        : null
    : isStructuredReport(report)
      ? (report as unknown as StructuredReport)
      : null;

  if (!structured) {
    // Non-structured fallback - just use the summary converter
    return convertResearchToBlocks(result);
  }

  const blocks: ContentBlock[] = [];
  const symbol =
    result.symbols.length > 1
      ? result.symbols.map((s) => s.replace(/\.(NS|BO)$/, "")).join(" vs ")
      : result.symbols[0]?.replace(/\.(NS|BO)$/, "") || "Unknown";

  // ── 1. Score Card ───────────────────────────────────────────────────
  // MONEY-445: BUY/SELL/HOLD recommendation and "X Preferred" labels are
  // intentionally omitted - the platform is informational, not advisory
  // (UseMoney is not a SEBI-registered RA/IA). Underlying data stays in
  // the report so existing reports still render their score + confidence.
  const score = structured.score ?? 0;

  // MONEY-587: render score + confidence + scored dimensions + key metrics as
  // ONE rich `scorecard` block instead of a metric card + two tables (Score
  // Breakdown + Key Metrics). The prose summary and detailed sections still
  // follow below. MONEY-445: no BUY/SELL/HOLD label or price target.
  const scorecardSections = buildScorecardSections(structured);
  blocks.push({
    type: "scorecard",
    symbol,
    overall: Math.round(score),
    confidence: confidenceLabel(structured.confidence),
    verdict: structured.summary
      ? firstSentence(safeScrub(structured.summary))
      : undefined,
    sessionId: result.sessionId || undefined,
    sections: scorecardSections,
  });

  // ── 1b. "Show Summary" collapse link ─────────────────────────────────
  const sessionId2 = result.sessionId || "";
  if (sessionId2) {
    blocks.push({
      type: "navigation",
      links: [
        {
          label: "Show Summary",
          href: `#collapse-report:${encodeURIComponent(sessionId2)}`,
          icon: "minimize",
          description: "Collapse back to the summary view",
        },
      ],
    });
  }

  // ── 2. Summary ──────────────────────────────────────────────────────
  // MONEY-457: scrub recommendation language from stored prose so legacy
  // reports (already in MongoDB) don't surface "leading to a BUY" or
  // "upside of 14.7% from current price" in the chat preview.
  if (structured.summary) {
    blocks.push({ type: "text", content: safeScrub(structured.summary) });
  }

  // MONEY-650 (B10): lead the full report body with the candlestick chart, so
  // the chat "Load Full Report" view opens with the price chart up top (matches
  // the chat result + the /analysis detail page).
  if (result.symbols.length === 1) {
    const raw = result.symbols[0];
    const cleanSym = raw.replace(/\.(NS|BO)$/, "");
    blocks.push({
      type: "chart",
      title: "Chart analysis",
      subtitle: cleanSym,
      chartType: "tradingview",
      symbol: raw.endsWith(".BO") ? `BSE:${cleanSym}` : `NSE:${cleanSym}`,
    } as ContentBlock);
  }

  // ── 3 & 4. Score breakdown + key metrics now render inside the
  // `scorecard` block above (MONEY-587) instead of two separate tables.

  // ── 5. Detailed Sections ────────────────────────────────────────────
  if (structured.sections && structured.sections.length > 0) {
    for (const section of structured.sections) {
      // Section header + content
      // MONEY-457: scrub recommendation prose from stored section content.
      let sectionContent = `**${section.title}**\n\n`;
      if (section.content) {
        sectionContent += safeScrub(section.content);
      }
      blocks.push({ type: "text", content: sectionContent });

      // Section metrics
      if (section.metrics && section.metrics.length > 0) {
        blocks.push({
          type: "table",
          title: section.title,
          columns: [
            { key: "label", label: "Metric", align: "left" as const },
            { key: "value", label: "Value", align: "right" as const },
            { key: "verdict", label: "Verdict", align: "center" as const },
          ],
          rows: section.metrics.map((m) => ({
            label: safeScrub(m.label),
            value: safeScrub(m.value),
            verdict: safeScrub(m.verdict || m.trend || "").toUpperCase(),
          })),
        });
      }

      // DCF valuation box.
      // TODO: SEBI-compliance review — flag at research-blocks.ts ("Upside"
      // item below). The DCF block surfaces intrinsic value + current
      // price (factual) plus a signed "Upside" percentage with green/red
      // P&L colouring (implicit price target). Same issue as the
      // matching DCF block in components/analysis/ResearchReport.tsx —
      // recommended rewrite: relabel "Upside" → "Intrinsic vs. Current"
      // as a neutral ratio without sign, or drop the cell entirely.
      // Keeping the existing rendering for now because the right framing
      // is a product/design call and downstream consumers expect the
      // shape unchanged.
      if (section.dcf) {
        blocks.push({
          type: "card",
          variant: "metric",
          title: "DCF Valuation",
          items: [
            {
              label: "Intrinsic Value",
              value: `₹${section.dcf.intrinsicValue.toLocaleString("en-IN")}`,
            },
            {
              label: "Current Price",
              value: `₹${section.dcf.currentPrice.toLocaleString("en-IN")}`,
            },
            {
              label: "Upside",
              value: `${section.dcf.upside >= 0 ? "+" : ""}${section.dcf.upside.toFixed(1)}%`,
              format: "pnl",
            },
          ],
        });
      }

      // Section table data
      if (section.columns && section.rows && section.rows.length > 0) {
        blocks.push({
          type: "table",
          title: section.title,
          columns: section.columns.map((col: string) => ({
            key: col,
            label: col,
            align: "left" as const,
          })),
          rows: section.rows.map((row: string[]) => {
            const obj: Record<string, unknown> = {};
            section.columns!.forEach((col: string, i: number) => {
              obj[col] = row[i] || "";
            });
            return obj;
          }),
        });
      }
    }
  }

  // ── 6. Strengths & Risks ────────────────────────────────────────────
  if (
    (structured.strengths && structured.strengths.length > 0) ||
    (structured.risks && structured.risks.length > 0)
  ) {
    let content = "";
    if (structured.strengths && structured.strengths.length > 0) {
      content += "**Strengths**\n";
      // MONEY-457: scrub stored strength/risk strings.
      content += structured.strengths
        .map((s) => `- ${safeScrub(s)}`)
        .join("\n");
      content += "\n\n";
    }
    if (structured.risks && structured.risks.length > 0) {
      content += "**Risks**\n";
      content += structured.risks.map((r) => `- ${safeScrub(r)}`).join("\n");
    }
    blocks.push({ type: "text", content: content.trim() });
  }

  // ── 7. Catalysts ────────────────────────────────────────────────────
  if (structured.catalysts && structured.catalysts.length > 0) {
    blocks.push({
      type: "table",
      title: "Catalysts & Events",
      columns: [
        { key: "event", label: "Event", align: "left" as const },
        { key: "timeline", label: "Timeline", align: "center" as const },
        { key: "impact", label: "Impact", align: "center" as const },
      ],
      rows: structured.catalysts.map((c) => ({
        event: c.event,
        timeline: c.timeline,
        impact: c.impact.toUpperCase(),
      })),
    });
  }

  // ── 8. Technicals ───────────────────────────────────────────────────
  if (structured.technicals) {
    blocks.push({
      type: "card",
      variant: "metric",
      title: "Technical Overview",
      items: [
        { label: "Trend", value: structured.technicals.trend.toUpperCase() },
        {
          label: "Support",
          value: `₹${structured.technicals.support.toLocaleString("en-IN")}`,
        },
        {
          label: "Resistance",
          value: `₹${structured.technicals.resistance.toLocaleString("en-IN")}`,
        },
        ...(structured.technicals.rsi != null
          ? [{ label: "RSI (14)", value: String(structured.technicals.rsi) }]
          : []),
      ],
    });
  }

  // ── 9. Disclaimer ───────────────────────────────────────────────────
  if (structured.disclaimer) {
    blocks.push({
      type: "error",
      severity: "info",
      title: "Disclaimer",
      message: structured.disclaimer,
    });
  }

  // ── 10. Navigation link to analysis page ────────────────────────────
  const sessionId = result.sessionId || "";
  if (sessionId) {
    blocks.push({
      type: "navigation",
      links: [
        {
          label: "View Full Analysis",
          href: `/analysis/${encodeURIComponent(sessionId)}`,
          icon: "chart",
          description: `Open the interactive ${symbol} report with charts`,
        },
      ],
    });
  }

  // ── 11. Discussion prompt ───────────────────────────────────────────
  // MONEY-445: dropped the "Why is X rated $REC?" suggestion since
  // recommendation labels (BUY/SELL/HOLD, "X Preferred") are no longer
  // surfaced anywhere.
  blocks.push({
    type: "text",
    content:
      `Ask me about any section above - e.g. *"Explain the DCF valuation"*, ` +
      `*"What are the key risks?"*, or *"Compare this with peers"*.`,
  });

  return blocks;
}

/**
 * Convert a structured JSON report into rich ContentBlock[] for chat display
 */
/**
 * Build the single `structured-report` block (MONEY-676, P6) that renders the
 * full report through <ResearchReport> — the SAME renderer the /analysis page
 * uses — so the chat-inline report and the analysis report no longer diverge.
 * Falls back to the summary blocks when the result isn't a structured report.
 */
export function buildStructuredReportBlocks(
  result: ResearchResult
): ContentBlock[] {
  const report = result.report as Record<string, unknown> | null;
  const structured = report?.content
    ? isStructuredReport(report.content)
      ? (report.content as StructuredReport)
      : isStructuredReport(report)
        ? (report as unknown as StructuredReport)
        : null
    : isStructuredReport(report)
      ? (report as unknown as StructuredReport)
      : null;
  if (!structured) return convertResearchToBlocks(result);
  const symbol =
    result.symbols.length > 1
      ? result.symbols.map((s) => s.replace(/\.(NS|BO)$/, "")).join(" vs ")
      : result.symbols[0]?.replace(/\.(NS|BO)$/, "") || "Unknown";
  return [
    {
      type: "structured-report",
      report: structured,
      symbol,
      sessionId: result.sessionId || undefined,
      // Carry the run's sources so the Sources rail still works after completion
      // (P6 emits only this block; deriveCitations reads these). MONEY-670.
      news: extractReportNews(structured),
      dataSources: extractRunTools(result),
      symbols: result.symbols.map((s) => s.replace(/\.(NS|BO)$/, "")),
    },
  ];
}

/** Lift the report's cited news (newsHighlights / sections[type==="news"].items)
 *  into the Sources-rail WEB shape — only items that carry a REAL url. */
function extractReportNews(structured: StructuredReport): Array<{
  headline: string;
  source?: string;
  domain?: string;
  url?: string;
  at?: string;
  sentiment?: "positive" | "neutral" | "negative";
}> {
  const s = structured as unknown as Record<string, unknown>;
  const raw: Array<Record<string, unknown>> = [];
  if (Array.isArray(s.newsHighlights))
    raw.push(...(s.newsHighlights as Array<Record<string, unknown>>));
  const newsSection = (structured.sections ?? []).find(
    (x) => (x as { type?: string }).type === "news"
  ) as Record<string, unknown> | undefined;
  if (newsSection && Array.isArray(newsSection.items))
    raw.push(...(newsSection.items as Array<Record<string, unknown>>));
  const sv = (v: unknown) => (v == null || v === "" ? undefined : String(v));
  const toSentiment = (
    v: unknown
  ): "positive" | "neutral" | "negative" | undefined => {
    const t = String(v ?? "").toLowerCase();
    if (/pos|bull/.test(t)) return "positive";
    if (/neg|bear/.test(t)) return "negative";
    if (/neu/.test(t)) return "neutral";
    return undefined;
  };
  const out: Array<{
    headline: string;
    source?: string;
    domain?: string;
    url?: string;
    at?: string;
    sentiment?: "positive" | "neutral" | "negative";
  }> = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const url = sv(r.url) ?? sv(r.link) ?? sv(r.sourceUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    let domain: string | undefined;
    try {
      domain = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      domain = undefined;
    }
    out.push({
      headline: sv(r.title) ?? sv(r.headline) ?? "Untitled",
      source: sv(r.source) ?? sv(r.publisher) ?? domain,
      domain,
      url,
      at: sv(r.date) ?? sv(r.pubDate),
      sentiment: toSentiment(r.sentiment),
    });
  }
  return out;
}

/** Completed tools the run executed, for the Sources-rail DATA TOOLS RUN group. */
function extractRunTools(
  result: ResearchResult
): Array<{ tool: string; label: string; status: string }> {
  const report = result.report as Record<string, unknown> | null;
  const plan = (report?.plan ??
    (result as unknown as Record<string, unknown>).plan) as Record<
    string,
    unknown
  > | null;
  const tasks: Array<Record<string, unknown>> = Array.isArray(plan?.tasks)
    ? (plan!.tasks as Array<Record<string, unknown>>)
    : ((plan?.segments as Array<Record<string, unknown>>) || []).flatMap(
        (seg) => (seg?.tasks as Array<Record<string, unknown>>) || []
      );
  const seen = new Set<string>();
  const out: Array<{ tool: string; label: string; status: string }> = [];
  for (const t of tasks) {
    const tool = typeof t.tool === "string" ? t.tool : null;
    if (!tool || seen.has(tool)) continue;
    seen.add(tool);
    out.push({
      tool,
      label: tool
        .replace(/[_-]+/g, " ")
        .trim()
        .replace(/^\w/, (c) => c.toUpperCase()),
      status: typeof t.status === "string" ? t.status : "completed",
    });
  }
  return out;
}

function convertStructuredReportToBlocks(
  report: StructuredReport,
  result: ResearchResult
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const symbol =
    result.symbols.length > 1
      ? result.symbols.map((s) => s.replace(/\.(NS|BO)$/, "")).join(" vs ")
      : result.symbols[0]?.replace(/\.(NS|BO)$/, "") || "Unknown";

  // 1. Scorecard block (MONEY-587)
  // MONEY-445: same advisory-vs-informational treatment as the full
  // report block above - drop the BUY/SELL/HOLD and "X Preferred"
  // surfaces; score + confidence stay. MONEY-587: the summary completion
  // now renders the SAME rich `scorecard` block as the Load-Full-Report
  // path (overall score dial + confidence pill + verdict + scored sections)
  // instead of a flat metric card + a separate Key Metrics table.
  const score = report.score ?? 0;

  const scorecardSections = buildScorecardSections(report);
  blocks.push({
    type: "scorecard",
    symbol,
    overall: Math.round(score),
    confidence: confidenceLabel(report.confidence),
    verdict: report.summary
      ? firstSentence(safeScrub(report.summary))
      : undefined,
    sessionId: result.sessionId || undefined,
    sections: scorecardSections,
  });

  // 2. Summary text — MONEY-457: scrub stored prose.
  if (report.summary) {
    blocks.push({ type: "text", content: safeScrub(report.summary) });
  }

  // MONEY-650 (B10): lead the report body with the candlestick chart (it used
  // to be pushed much lower, after the technicals card).
  if (result.symbols.length === 1) {
    const raw = result.symbols[0];
    const cleanSym = raw.replace(/\.(NS|BO)$/, "");
    blocks.push({
      type: "chart",
      title: "Chart analysis",
      subtitle: cleanSym,
      chartType: "tradingview",
      symbol: raw.endsWith(".BO") ? `BSE:${cleanSym}` : `NSE:${cleanSym}`,
    } as ContentBlock);
  }

  // 3. Key metrics now render inside the `scorecard` block above (MONEY-587)
  // instead of a separate table.

  // 4. Strengths & Risks — MONEY-457: scrub stored strings.
  if (
    (report.strengths && report.strengths.length > 0) ||
    (report.risks && report.risks.length > 0)
  ) {
    let content = "";
    if (report.strengths && report.strengths.length > 0) {
      content += "**Strengths**\n";
      content += report.strengths.map((s) => `- ${safeScrub(s)}`).join("\n");
      content += "\n\n";
    }
    if (report.risks && report.risks.length > 0) {
      content += "**Risks**\n";
      content += report.risks.map((r) => `- ${safeScrub(r)}`).join("\n");
    }
    blocks.push({ type: "text", content: content.trim() });
  }

  // 5. Catalysts (show in summary too - high value)
  if (report.catalysts && report.catalysts.length > 0) {
    blocks.push({
      type: "table",
      title: "Catalysts & Events",
      columns: [
        { key: "event", label: "Event", align: "left" as const },
        { key: "timeline", label: "Timeline", align: "center" as const },
        { key: "impact", label: "Impact", align: "center" as const },
      ],
      rows: report.catalysts.map((c) => ({
        event: c.event,
        timeline: c.timeline,
        impact: c.impact.toUpperCase(),
      })),
    });
  }

  // 6. Technical Overview card (show in summary too)
  if (report.technicals) {
    blocks.push({
      type: "card",
      variant: "metric",
      title: "Technical Overview",
      items: [
        { label: "Trend", value: report.technicals.trend.toUpperCase() },
        {
          label: "Support",
          value: `₹${report.technicals.support.toLocaleString("en-IN")}`,
        },
        {
          label: "Resistance",
          value: `₹${report.technicals.resistance.toLocaleString("en-IN")}`,
        },
        ...(report.technicals.rsi != null
          ? [{ label: "RSI (14)", value: String(report.technicals.rsi) }]
          : []),
      ],
    });
  }

  // 7. (MONEY-650 B10) The candlestick chart now LEADS the report (pushed right
  // after the summary above) instead of sitting here after the technicals card.

  // 8. Data sources reference (MONEY-491/613) — map the tools that ran to their
  // human-readable data providers with links, deduped, instead of raw tool names.
  const sourceProviders = dataSourceProviders(extractDataSources(result, true));
  if (sourceProviders.length > 0) {
    blocks.push({
      type: "text",
      content:
        `**Sources**\n\n` +
        sourceProviders
          .map((s) => (s.url ? `[${s.label}](${s.url})` : s.label))
          .join(" · "),
    });
  }

  // 9. Navigation + "Load Full Report" action
  const sessionId = result.sessionId || "";
  if (sessionId) {
    blocks.push({
      type: "navigation",
      links: [
        {
          label: "View Full Analysis",
          href: `/analysis/${encodeURIComponent(sessionId)}`,
          icon: "chart",
          description: `Open the detailed ${symbol} research report`,
        },
        {
          label: "Load Full Report in Chat",
          href: `#load-report:${encodeURIComponent(sessionId)}`,
          icon: "expand",
          description: `Expand all sections inline - discuss each parameter`,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Map the research tool names that ran to their human-readable data providers
 * with links (deduped). Compute tools + raw symbols don't map to an external
 * provider and are dropped. (MONEY-491/613 — sources surfaced in chat + the
 * /analysis research-detail page.)
 */
export function dataSourceProviders(
  toolNames: string[]
): Array<{ label: string; url?: string }> {
  const PROVIDERS: Array<{ match: RegExp; label: string; url: string }> = [
    {
      match:
        /income_statement|balance_sheet|cash_flow|key_ratios|peer|financials|growth|valuation|dcf|wacc|piotroski/,
      label: "Tickertape / Screener.in",
      url: "https://www.screener.in",
    },
    {
      match: /price|earnings|analyst|technical|chart|candlestick|volume|beta/,
      label: "Yahoo Finance",
      url: "https://finance.yahoo.com",
    },
    {
      match: /news|sentiment/,
      label: "Google News",
      url: "https://news.google.com",
    },
    {
      match: /corporate_action|filing|shareholding|promoter|insider|bulk|block/,
      label: "NSE India",
      url: "https://www.nseindia.com",
    },
    {
      match: /macro|fii_dii|rbi|rate|sector_rotation/,
      label: "RBI / NSE macro",
      url: "https://www.rbi.org.in",
    },
    { match: /chartink|scan/, label: "Chartink", url: "https://chartink.com" },
    { match: /mf_|fund/, label: "AMFI", url: "https://www.amfiindia.com" },
  ];
  const seen = new Map<string, { label: string; url?: string }>();
  for (const tool of toolNames) {
    const p = PROVIDERS.find((x) => x.match.test(tool));
    if (p && !seen.has(p.label))
      seen.set(p.label, { label: p.label, url: p.url });
  }
  return Array.from(seen.values());
}

/**
 * Extract data source tool names from a research result for the references section.
 */
function extractDataSources(
  result: ResearchResult,
  fromPlan = false
): string[] {
  const sources = new Set<string>();

  // If contentBlocks have tool references
  if (result.contentBlocks) {
    for (const block of result.contentBlocks) {
      const b = block as Record<string, unknown>;
      if (b.tool && typeof b.tool === "string") {
        sources.add(b.tool);
      }
    }
  }

  // Extract from the plan if available. MONEY-650 (B6): the chat used to read
  // ONLY `result.report.plan.tasks`, so when the plan is persisted under a
  // different path (`result.plan`) or grouped into segments
  // (`plan.segments[].tasks`) — the layout the /analysis detail page already
  // handles — the chat extracted zero tools and the Sources panel showed only
  // the self-referential "View Full Analysis" link. Read both plan locations
  // and both task layouts.
  if (fromPlan) {
    const report = result.report as Record<string, unknown> | null;
    const plan = (report?.plan ??
      (result as unknown as Record<string, unknown>).plan) as Record<
      string,
      unknown
    > | null;
    const planTasks: Array<Record<string, unknown>> = Array.isArray(plan?.tasks)
      ? (plan!.tasks as Array<Record<string, unknown>>)
      : ((plan?.segments as Array<Record<string, unknown>>) || []).flatMap(
          (seg) => (seg?.tasks as Array<Record<string, unknown>>) || []
        );
    for (const task of planTasks) {
      if (
        task.tool &&
        typeof task.tool === "string" &&
        task.status === "completed"
      ) {
        sources.add(task.tool);
      }
    }
  }

  // Extract from symbols (always add the stock symbols as source references)
  for (const sym of result.symbols) {
    sources.add(sym.replace(/\.(NS|BO)$/, ""));
  }

  return Array.from(sources);
}
