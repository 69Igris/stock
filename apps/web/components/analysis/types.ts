/**
 * Shared types and helpers for the analysis/research report UI.
 */

export interface StructuredReport {
  score?: number;
  recommendation?: string;
  confidence?: number;
  summary?: string;
  /**
   * Jargon-free walkthrough of the report for newer investors ("In plain
   * English" panel) — educational framing only, never advice (SEBI).
   */
  plainSummary?: string;
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
    // Synthesizer can emit nulls when the DCF tool didn't produce a
    // valid figure (e.g. no FCF data for the symbol). Renderers must
    // guard each scalar - see app/analysis/[sessionId]/client.tsx
    // and components/analysis/ResearchReport.tsx for the pattern.
    dcf?: {
      intrinsicValue: number | null;
      currentPrice: number | null;
      upside: number | null;
    };
    columns?: string[];
    rows?: string[][];
    items?: Array<Record<string, string>>;
    // Design "exact match" chart payloads (MONEY-490). The synthesizer attaches
    // whichever apply to a section; renderSectionCharts renders them. Every field
    // is optional + guarded so missing data simply renders nothing.
    /** Small badge pill on the section header (e.g. "Piotroski 8/9",
     *  "Gov 86/100 · A", "High-Quality Momentum"). */
    badge?: string;
    /** Key→value rows (Business overview / Macro environment tables). */
    kv?: Array<{ k: string; v: string }>;
    /** Horizontal bars (shareholding pattern): pct 0-100, delta in pp. */
    bars?: Array<{ label: string; value: string; pct: number; delta?: number }>;
    /** Governance flag chips. tone: green | amber | red. */
    flags?: Array<{ tone: string; text: string }>;
    /** Composite 0-100 score dial (quant factor profile). */
    composite?: { score: number; label?: string; sub?: string };
    /** Factor contribution split (stacked bar), values sum to ~100. */
    contribution?: Array<{ label: string; value: number }>;
    radar?: { axes: string[]; values: number[]; max?: number };
    heatmap?: {
      rows: string[];
      cols: string[];
      data: number[][];
      rowLabel?: string;
      colLabel?: string;
    };
    fan?: {
      p10: number[];
      p25: number[];
      p50: number[];
      p75: number[];
      p90: number[];
    };
    underwater?: number[];
    indicators?: Array<{
      name: string;
      value: string;
      signal: string;
      /** Dashboard column (TREND / MOMENTUM / VOLATILITY / VOLUME). */
      group?: string;
    }>;
    patterns?: Array<{ pattern: string; confidence?: string }>;
    range?: { low: number; mid: number; high: number; current?: number };
  }>;
  scoreBreakdown?: Array<{
    criterion: string;
    score: number;
    maxScore: number;
    comment?: string;
  }>;
  comparisonMeta?: {
    stocks: string[];
    winner: string | null;
    verdict?: string;
    sameSector?: boolean;
    stockScores?: Array<{ symbol: string; score: number }>;
    /**
     * MONEY-457: per-stock 7-criterion score breakdown so the comparison
     * renderer can show each stock's breakdown chart with the same visual
     * treatment as the single-stock analysis page. Each entry replicates
     * the shape of the top-level `scoreBreakdown` field but scoped to one
     * stock. Optional — historical comparison reports will not have it; in
     * that case the renderer hides the breakdown section entirely.
     */
    perStockBreakdown?: Array<{
      symbol: string;
      criteria: Array<{
        criterion: string;
        score: number;
        maxScore: number;
        comment?: string;
      }>;
    }>;
  };
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

export interface ResearchHistoryItem {
  sessionId: string;
  query: string;
  status: string;
  symbols: string[];
  qualityScore?: number;
  recommendation?: string;
  createdAt: Date;
  completedAt?: Date;
  errorMessage?: string;
}

/**
 * @deprecated MONEY-457 — SEBI compliance. Colour-coding analysis
 * cards by an embedded BUY/SELL/HOLD token IS an implicit recommendation
 * surface (green = buy, red = sell) even if the verdict text is hidden.
 * UseMoney is not a SEBI-registered Research Analyst. ResearchReport no
 * longer calls this — render with a single neutral border treatment.
 * Kept here only so any external import keeps compiling; returns the
 * same neutral slate for any input.
 */
export function getRecColor(_rec: string): string {
  return "bg-slate-500";
}

/**
 * @deprecated MONEY-457 — SEBI compliance. See getRecColor above. Returns
 * a single neutral slate border for any input.
 */
export function getRecBorder(_rec: string): string {
  return "border-slate-500 bg-slate-500/5";
}

export function extractReportMeta(report: unknown): {
  score?: number;
  recommendation?: string;
} {
  if (!report || typeof report !== "object") return {};
  const r = report as Record<string, unknown>;
  const inner =
    r.content && typeof r.content === "object"
      ? (r.content as Record<string, unknown>)
      : r;
  return {
    score: typeof inner.score === "number" ? inner.score : undefined,
    recommendation:
      typeof inner.recommendation === "string"
        ? inner.recommendation
        : undefined,
  };
}
