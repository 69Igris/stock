/**
 * Compare Stocks - Side-by-side comparison of 2+ stocks
 *
 * Returns structured JSON (same shape as synthesize_report) so the
 * existing ResearchReport UI can render comparison results.
 */

import { generateWithTimeout } from "@usemoney/core/gemini";
import type { ResearchToolDef, ToolOutput } from "./types";
import type { ResearchTask } from "../types";
import { buildSynthesizerUserPrompt } from "../prompts";
import { getResearchModel } from "../model-selection";
import {
  computeComparisonScores,
  type ComparisonStockMetrics,
} from "./compute-comparison-scores";

/**
 * MONEY-457: Pull the distinct set of stock symbols out of the task array,
 * cleaned of .NS / .BO suffixes. Used as a fallback when the LLM's
 * comparisonMeta.stocks is missing or malformed.
 */
function symbolsFromTasks(tasks?: ResearchTask[]): string[] {
  if (!tasks) return [];
  const set = new Set<string>();
  for (const t of tasks) {
    const sym = (t.result as Record<string, unknown> | undefined)?.symbol as
      | string
      | undefined;
    const fromParams = t.params?.symbol as string | undefined;
    const raw = sym || fromParams;
    if (!raw) continue;
    set.add(
      raw
        .toUpperCase()
        .replace(/\.(NS|BO)$/, "")
        .trim(),
    );
  }
  return Array.from(set);
}

/**
 * MONEY-457: Extract per-stock metrics from the research task results
 * (or raw stockData) so the deterministic scoring function can be run.
 * Returns `null` if we can't get at least 2 stocks worth of metrics — in
 * which case the LLM-emitted scores are kept as a graceful degradation.
 *
 * The extractor is intentionally forgiving: it pulls whatever fields are
 * present from `fetch_key_ratios`, `compute_health_score`,
 * `compute_growth_metrics`, `compute_technical_analysis`,
 * `fetch_shareholding_pattern`, etc., and lets the scoring function
 * default missing fields to mid-range.
 */
function extractStockMetrics(
  symbols: string[],
  tasks?: ResearchTask[],
  stockData?: Record<string, unknown>[],
): ComparisonStockMetrics[] | null {
  if (symbols.length < 2) return null;
  const cleanSymbol = (s: string): string =>
    s
      .toUpperCase()
      .replace(/\.(NS|BO)$/, "")
      .trim();
  const wanted = Array.from(new Set(symbols.map(cleanSymbol)));
  const acc = new Map<string, ComparisonStockMetrics>();
  for (const s of wanted) acc.set(s, { symbol: s });

  /** Merge a partial-metric object into the per-symbol bucket. */
  const merge = (sym: string, m: Partial<ComparisonStockMetrics>): void => {
    const key = cleanSymbol(sym);
    if (!acc.has(key)) return;
    Object.assign(acc.get(key)!, m);
  };

  /** Coerce a value to a finite number or undefined. */
  const num = (v: unknown): number | undefined => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const parsed = parseFloat(v.replace(/[,%]/g, ""));
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  };

  // ─── Mine the tasks array ───
  for (const t of tasks ?? []) {
    if (t.status !== "completed") continue;
    const r = t.result as Record<string, unknown> | undefined;
    if (!r || typeof r !== "object") continue;
    const sym = (r.symbol as string) || (t.params?.symbol as string);
    if (!sym) continue;
    if (t.tool === "fetch_key_ratios") {
      merge(sym, {
        pe: num(r.pe),
        pb: num(r.pb),
        roe: num(r.roe),
        roce: num(r.roce),
        netMargin: num(r.netProfitMargin ?? r.netMargin),
        operatingMargin: num(r.operatingMargin),
        debtEquity: num(r.debtToEquity ?? r.debtEquity),
        currentRatio: num(r.currentRatio),
        interestCoverage: num(r.interestCoverage),
      });
    } else if (t.tool === "compute_growth_metrics") {
      merge(sym, {
        revenueCagr3y: num(r.revenueCagr3y ?? r.revenue3yCagr),
        revenueGrowthYoY: num(r.revenueGrowthYoY ?? r.revenueGrowth),
        epsGrowth: num(r.epsGrowth ?? r.epsGrowthYoY),
      });
    } else if (t.tool === "compute_cash_flow_quality") {
      merge(sym, {
        cfNiRatio: num(r.cfToNiRatio ?? r.cfNiRatio),
        accrualRatio: num(r.accrualRatio),
      });
    } else if (t.tool === "compute_earnings_quality") {
      merge(sym, {
        accrualRatio: num(r.accrualRatio),
      });
    } else if (t.tool === "compute_technical_analysis") {
      const sma = r.sma200Position as string | undefined;
      merge(sym, {
        rsi: num(r.rsi),
        adx: num(r.adx),
        sma200Position:
          sma === "above" || sma === "below" || sma === "near"
            ? sma
            : undefined,
      });
    } else if (t.tool === "fetch_shareholding_pattern") {
      merge(sym, {
        promoterHolding: num(r.promoterHolding),
        promoterHoldingChange: num(r.promoterHoldingQoqChange),
      });
    } else if (t.tool === "fetch_promoter_pledging") {
      merge(sym, { promoterPledge: num(r.pledgePercent ?? r.pledge) });
    } else if (t.tool === "compute_health_score") {
      // Sometimes the only place we get a current-ratio variant
      merge(sym, { currentRatio: num(r.currentRatio) });
    }
  }

  // ─── Mine the stockData input (used when caller provides raw arrays) ───
  for (const sd of stockData ?? []) {
    const sym = sd.symbol as string | undefined;
    if (!sym) continue;
    merge(sym, {
      pe: num(sd.pe),
      pb: num(sd.pb),
      roe: num(sd.roe),
      netMargin: num(sd.netMargin),
      revenueGrowthYoY: num(sd.revenueGrowthYoY ?? sd.revenueGrowth),
      epsGrowth: num(sd.epsGrowth),
      debtEquity: num(sd.debtEquity ?? sd.debtToEquity),
      currentRatio: num(sd.currentRatio),
      cfNiRatio: num(sd.cfNiRatio),
      accrualRatio: num(sd.accrualRatio),
      rsi: num(sd.rsi),
      adx: num(sd.adx),
      promoterHolding: num(sd.promoterHolding),
      promoterPledge: num(sd.promoterPledge),
    });
  }

  // Require at least one informative metric per stock — otherwise scoring
  // would produce all-default mid-range numbers that are no better than
  // the LLM gestalt.
  const hasInformativeMetric = (m: ComparisonStockMetrics): boolean =>
    m.pe !== undefined ||
    m.roe !== undefined ||
    m.netMargin !== undefined ||
    m.debtEquity !== undefined ||
    m.revenueCagr3y !== undefined ||
    m.revenueGrowthYoY !== undefined;
  const out = Array.from(acc.values());
  if (out.filter(hasInformativeMetric).length < 2) return null;
  return out;
}

/**
 * Parse JSON from an LLM response, stripping markdown fences if present.
 */
function parseJsonResponse(response: string): Record<string, unknown> | null {
  let jsonStr = response.trim();

  // Strip markdown code blocks (handles both closed and unclosed fences)
  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1]!.trim();
  } else {
    const unclosedFence = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*)/);
    if (unclosedFence) {
      jsonStr = unclosedFence[1]!.trim();
    }
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Continue to truncated recovery
      }
    }
  }

  // Truncated JSON recovery - extract key fields via regex
  if (jsonStr.includes('"score"') || jsonStr.includes('"recommendation"')) {
    const result: Record<string, unknown> = {};
    for (const field of ["score", "confidence"]) {
      const m = jsonStr.match(
        new RegExp(`"${field}"\\s*:\\s*(\\d+(?:\\.\\d+)?)`),
      );
      if (m) result[field] = Number(m[1]);
    }
    for (const field of ["recommendation", "disclaimer"]) {
      const m = jsonStr.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`));
      if (m) result[field] = m[1];
    }
    const summaryMatch = jsonStr.match(
      /"summary"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/,
    );
    if (summaryMatch) {
      result.summary = summaryMatch[1]!
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"');
    }
    if (result.score !== undefined || result.recommendation !== undefined) {
      console.log(
        "[compare-stocks] Recovered from truncated JSON:",
        Object.keys(result).join(","),
      );
      return result;
    }
  }

  return null;
}

/**
 * MONEY-806: section-depth directive for the compare system prompt. Mirrors
 * the single-stock synthesizer's `reportLengthDirective` (prompts.ts) so
 * compare reports honour the user's chosen length. "standard"/unset → "" (the
 * prompt is byte-identical to today). Inlined because the prompts.ts helper is
 * module-private and prompts.ts is owned by another surface.
 */
export function compareReportLengthDirective(reportLength?: string): string {
  if (reportLength === "brief") {
    return `

REPORT LENGTH — BRIEF:
Keep every section tight. Lead with the numbers, drop hedging prose, and cap
each section's narrative at ~2-3 sentences. Still emit ALL required sections
(do not drop any) — just state each more concisely. keyMetrics and tables stay
complete.`;
  }
  if (reportLength === "full") {
    return `

REPORT LENGTH — FULL:
Provide the deepest treatment the data supports. Expand each section's
narrative with the reasoning behind the numbers, cite the specific figures
from the gathered data, and add nuance where the data warrants it. Do NOT
invent data to pad length — depth comes from the evidence already gathered.`;
  }
  return ""; // "standard" / unset → no change
}

/**
 * MONEY-806: the C1c/B5/MONEY-222 framing directives for the compare prompt
 * when the data section is built from raw `stockData` (the `tasks` path gets
 * these via `buildSynthesizerUserPrompt`). All optional; unset → "" so the
 * stockData prompt is unchanged. Same wording/ordering as the synthesizer's
 * user-prompt builder, observation-only (SEBI).
 */
export function compareFramingDirectives(opts: {
  horizon?: string;
  memoryContext?: string;
  researchFocus?: string;
}): string {
  let out = "";
  if (opts.horizon?.trim()) {
    out += `Analysis horizon (frame trends, returns, and volatility over this window): ${opts.horizon.trim()}\n\n`;
  }
  if (opts.memoryContext?.trim()) {
    out += `## Investor profile (personalize the framing; never advise)\n${opts.memoryContext.trim()}\n\n`;
  }
  if (opts.researchFocus?.trim()) {
    out += `User focus preference (apply throughout): ${opts.researchFocus.trim()}\n\n`;
  }
  return out;
}

export const compareStocksTool: ResearchToolDef = {
  name: "compare_stocks",
  description: "Generate a side-by-side comparison of 2 or more stocks",
  category: "synthesis",
  parameters: {
    stockData: {
      type: "object[]",
      description: "Array of stock data objects with financial info",
      required: false,
    },
    query: {
      type: "string",
      description: "Original comparison query",
      required: true,
    },
    tasks: {
      type: "object[]",
      description: "Completed research tasks with results",
      required: false,
    },
    mode: {
      type: "string",
      description: "Research mode: fast or advanced",
      required: false,
      default: "advanced",
    },
    model: {
      type: "string",
      description:
        "Gemini registry model id to compare with (e.g. gemini-3.1-pro-preview). Falls back to the advanced config when omitted/unknown/gated.",
      required: false,
    },
    researchFocus: {
      type: "string",
      description:
        "MONEY-222 - recurring 'always focus on…' user preference. Prepended to the compare synthesis prompt as a framing directive. Omitted = no directive.",
      required: false,
    },
    memoryContext: {
      type: "string",
      description:
        "MONEY-790 (B5) - the user's durable InvestorProfile memory. Personalizes the comparison FRAMING (DESCRIBES the user, never advises). Omitted = no directive.",
      required: false,
    },
    horizon: {
      type: "string",
      description:
        "MONEY-794 (C1c) - analysis horizon (1y/3y/5y) used to frame trends/returns in the compare prompt. Omitted = no framing directive.",
      required: false,
    },
    reportLength: {
      type: "string",
      description:
        "MONEY-794 (C1c) - section-depth guidance (brief/standard/full) for the compare report. Omitted/standard = today's prompt depth unchanged.",
      required: false,
    },
  },
  execute: async (params): Promise<ToolOutput> => {
    const stockData = params.stockData as Record<string, unknown>[] | undefined;
    const tasks = params.tasks as ResearchTask[] | undefined;
    const query = params.query as string;
    // MONEY-587 (task #36) - honor the user-chosen (premium-billed) model
    // for comparison synthesis too; advanced default otherwise.
    const modelId =
      typeof params.model === "string" && params.model.trim()
        ? params.model.trim()
        : undefined;

    // MONEY-806: thread the C1c run-params + B5 memory + MONEY-222 focus into
    // the compare synthesis the same way single-stock synthesis does — they
    // were silently dropped before, so compare reports ignored the user's
    // chosen horizon, report length, focus, and investor profile.
    const researchFocus =
      typeof params.researchFocus === "string" && params.researchFocus.trim()
        ? params.researchFocus.trim()
        : undefined;
    const memoryContext =
      typeof params.memoryContext === "string" && params.memoryContext.trim()
        ? params.memoryContext.trim()
        : undefined;
    const horizon =
      typeof params.horizon === "string" && params.horizon.trim()
        ? params.horizon.trim()
        : undefined;
    const reportLength =
      typeof params.reportLength === "string" && params.reportLength.trim()
        ? params.reportLength.trim()
        : undefined;

    // Build data section from either tasks (preferred) or stockData
    let dataSection: string;
    if (tasks?.length) {
      dataSection = buildSynthesizerUserPrompt(
        query,
        tasks,
        researchFocus,
        memoryContext,
        horizon,
      );
    } else if (stockData?.length && stockData.length >= 2) {
      dataSection =
        compareFramingDirectives({ horizon, memoryContext, researchFocus }) +
        `Research query: "${query}"\n\nStock Data:\n${JSON.stringify(stockData, null, 2)}`;
    } else {
      return {
        success: false,
        error: "At least 2 stocks required for comparison",
      };
    }

    try {
      const model = getResearchModel(modelId);

      const systemPrompt = `You are a senior institutional equity research analyst at a top investment bank.
You are creating a COMPREHENSIVE peer comparison report for Indian markets (NSE/BSE).

OUTPUT FORMAT - Return ONLY valid JSON matching this EXACT structure:
{
  "score": 72,
  "recommendation": "N/A",
  "confidence": 75,
  "summary": "Executive comparison summary describing each stock's data — observations only, no preferred / winner / better-pick framing",
  "comparisonMeta": {
    "stocks": ["SYMBOL1", "SYMBOL2"],
    "winner": null,
    "verdict": "One-line neutral observation describing each stock's profile (e.g. 'STOCK1 reports higher ROE; STOCK2 reports faster revenue growth')",
    "sameSector": true,
    "stockScores": [
      {"symbol": "SYMBOL1", "score": 78},
      {"symbol": "SYMBOL2", "score": 65}
    ],
    "perStockBreakdown": [
      {
        "symbol": "SYMBOL1",
        "criteria": [
          {"criterion": "Valuation", "score": 14, "maxScore": 20, "comment": "Trades at 18.5x PE vs sector 22x — discount of ~16%"},
          {"criterion": "Profitability", "score": 17, "maxScore": 20, "comment": "ROE 22%, net margin 12%"},
          {"criterion": "Growth", "score": 11, "maxScore": 15, "comment": "Revenue CAGR 15%, margins expanding"},
          {"criterion": "Balance Sheet", "score": 13, "maxScore": 15, "comment": "D/E 0.3x, current ratio 1.8"},
          {"criterion": "Earnings Quality", "score": 8, "maxScore": 10, "comment": "CF/NI 1.2, accrual ratio 0.03"},
          {"criterion": "Momentum & Technicals", "score": 7, "maxScore": 10, "comment": "Price above SMA200, RSI 58"},
          {"criterion": "Ownership & Governance", "score": 8, "maxScore": 10, "comment": "Promoter holding stable, no pledge"}
        ]
      },
      {
        "symbol": "SYMBOL2",
        "criteria": [
          {"criterion": "Valuation", "score": 9, "maxScore": 20, "comment": "PE 24.3x, slight premium to sector"},
          {"criterion": "Profitability", "score": 13, "maxScore": 20, "comment": "ROE 18%, net margin 10%"},
          {"criterion": "Growth", "score": 13, "maxScore": 15, "comment": "Revenue CAGR 22%, fastest in peer set"},
          {"criterion": "Balance Sheet", "score": 8, "maxScore": 15, "comment": "D/E 0.8x, interest coverage 5x"},
          {"criterion": "Earnings Quality", "score": 8, "maxScore": 10, "comment": "CF/NI 1.05, slightly elevated accruals"},
          {"criterion": "Momentum & Technicals", "score": 5, "maxScore": 10, "comment": "Consolidating below SMA50"},
          {"criterion": "Ownership & Governance", "score": 7, "maxScore": 10, "comment": "FII increasing, mild pledge"}
        ]
      }
    ]
  },
  "keyMetrics": [
    {"label": "PE Ratio", "value": "STOCK1: 18.5x vs STOCK2: 24.3x", "verdict": "STOCK1 trades at a lower multiple"},
    {"label": "ROE", "value": "STOCK1: 22% vs STOCK2: 18%", "verdict": "STOCK1 higher ROE"},
    {"label": "Revenue Growth", "value": "STOCK1: 15% vs STOCK2: 22%", "verdict": "STOCK2 faster revenue growth"},
    {"label": "Debt/Equity", "value": "STOCK1: 0.3x vs STOCK2: 0.8x", "verdict": "STOCK1 lower leverage"},
    {"label": "Market Cap", "value": "STOCK1: ₹1.2L Cr vs STOCK2: ₹85K Cr", "verdict": "comparable"},
    {"label": "Dividend Yield", "value": "STOCK1: 1.2% vs STOCK2: 0.8%", "verdict": "STOCK1 higher payout yield"}
  ],
  "sections": [
    {
      "title": "Executive Comparison",
      "content": "Detailed comparison narrative...",
      "type": "text"
    },
    {
      "title": "Valuation Matrix",
      "type": "table",
      "columns": ["Metric", "STOCK1", "STOCK2", "Sector Avg", "Edge"],
      "rows": [
        ["PE Ratio", "18.5x", "24.3x", "20.1x", "STOCK1"],
        ["PB Ratio", "3.2x", "4.1x", "3.5x", "STOCK1"],
        ["EV/EBITDA", "12.1x", "15.8x", "13.5x", "STOCK1"],
        ["P/FCF", "15x", "22x", "18x", "STOCK1"]
      ]
    },
    {
      "title": "Growth & Profitability",
      "type": "table",
      "columns": ["Metric", "STOCK1", "STOCK2", "Edge"],
      "rows": [
        ["Revenue Growth", "15%", "22%", "STOCK2"],
        ["Net Margin", "12%", "10%", "STOCK1"],
        ["ROE", "22%", "18%", "STOCK1"],
        ["ROCE", "18%", "15%", "STOCK1"]
      ]
    },
    {
      "title": "Balance Sheet Strength",
      "type": "table",
      "columns": ["Metric", "STOCK1", "STOCK2", "Edge"],
      "rows": [
        ["Debt/Equity", "0.3x", "0.8x", "STOCK1"],
        ["Current Ratio", "1.5", "1.2", "STOCK1"],
        ["Interest Coverage", "8x", "5x", "STOCK1"]
      ]
    },
    {
      "title": "Sector & Peer Context",
      "content": "How each stock compares to sector averages and peers...",
      "type": "text"
    },
    {
      "title": "Peer Universe",
      "type": "table",
      "columns": ["Company", "PE", "Market Cap", "Sector"],
      "rows": [["PEER1", "20x", "₹50K Cr", "Sector"]]
    },
    {
      "title": "Risk Comparison",
      "content": "Beta, volatility, concentration risk comparison...",
      "type": "text"
    },
    {
      "title": "Investment Style Profile",
      "content": "Describe each stock's value / growth / income profile from the data. Do NOT name 'which suits' any investor type. Pure observation.",
      "type": "text"
    }
  ],
  "strengths": ["STOCK1: Lower PE alongside higher ROE", "STOCK2: Faster revenue growth"],
  "risks": ["STOCK2: Higher debt may limit flexibility in downturn", "STOCK1: Slower growth may lag in bull markets"],
  "disclaimer": "AI-generated comparison for informational purposes only. Not financial advice. Consult a SEBI-registered advisor."
}

INDIVIDUAL STOCK SCORES: Rate each stock 0-100 individually based on fundamentals, valuation, growth, and quality. Include in comparisonMeta.stockScores array.

PER-STOCK SCORE BREAKDOWN (REQUIRED): comparisonMeta.perStockBreakdown MUST contain ONE entry per stock under comparison, in the same order as comparisonMeta.stocks. Each entry has:
- symbol (string, clean ticker — no .NS/.BO suffix)
- criteria (array of 7 items, fixed order):
    Valuation /20, Profitability /20, Growth /15, Balance Sheet /15,
    Earnings Quality /10, Momentum & Technicals /10, Ownership & Governance /10
Each criterion item: { criterion, score, maxScore, comment }
- score is that stock's individual score for that criterion (NOT a comparison comment, NOT a shared verdict).
- comment is one short factual observation about THIS stock on THIS criterion (e.g. "ROE 22%, net margin 12%", "PE 18.5x vs sector 22x"). Do NOT compare stocks in the comment — that's what the top-level "Peer Comparison" / "Risk Comparison" sections are for.
- The sum of one stock's criteria scores SHOULD equal that stock's comparisonMeta.stockScores entry. If a tool didn't produce data for a criterion, score it conservatively (mid-range with a comment noting the data gap).

LEGACY scoreBreakdown FIELD: omit the top-level scoreBreakdown array entirely. Per-stock breakdowns replace it for comparisons.

WALL STREET ANALYSIS FRAMEWORK:
1. **Relative Valuation Matrix** - PE, PB, EV/EBITDA, P/S, P/FCF for each stock vs sector median
2. **Quality Metrics** - ROE, ROCE, Operating Margin, Net Margin, FCF conversion ratio
3. **Growth Profile** - Revenue CAGR (3Y/5Y), EPS growth, margin expansion/contraction
4. **Balance Sheet Strength** - D/E, Interest Coverage, Current Ratio, Cash position
5. **Shareholder Returns** - Dividend Yield, Buyback history, Total payout ratio
6. **Sector Context** - Each stock vs its own sector PE/PB average (use sectorPe from peer data)
7. **Ownership Signals** - FII/DII trend changes, promoter pledge status
8. **Earnings Quality** - Accrual ratio, operating CF / net income, non-recurring items %

RECOMMENDATION FIELD:
- The top-level "recommendation" field MUST be the literal string "N/A".
- Do NOT emit "STOCK_A_PREFERRED" / "STOCK_B_PREFERRED" / "EQUAL" / "<X>_PREFERRED" — those phrases are research recommendations per SEBI RA Regulations 2014.
- comparisonMeta.winner MUST be null. Do NOT name a "winner" or "preferred" stock.

SCORE: 0-100 representing comparison report quality (not a recommendation, not a stock score).

RULES:
- Use ACTUAL numbers from data - NEVER invent
- Indian context (₹, lakhs, crores, NSE/BSE)
- Be balanced - describe ALL stocks neutrally; do NOT declare a "better" or "preferred" stock
- Include sector PE from peer data when available
- SEBI disclaimer required
- Replace STOCK1/STOCK2 with actual symbol names in ALL fields
- NEVER use .NS or .BO suffixes in any user-facing text (keyMetrics values, verdicts, section content, comparisonMeta, strengths, risks). Use clean symbol names like "AMBER", "RELIANCE", "TCS" - not "AMBER.NS" or "RELIANCE.BO". The .NS/.BO suffix is for data fetching only, not for display.

CRITICAL SEBI COMPLIANCE — UseMoney is NOT a SEBI-registered Research Analyst:
- FORBIDDEN VOCABULARY: BUY, SELL, HOLD, STRONG_BUY, STRONG_SELL, AVOID, NEUTRAL,
  INVEST, SWITCH, PREFERRED, "target price", "price target", "stop loss", "buy zone".
- FORBIDDEN PHRASES: "strong investment case", "attractive opportunity",
  "value pick", "classic value pick", "growth play", "momentum play",
  "good entry point", "potential upside of X%", "X is the better pick",
  "X Preferred", "looks promising", "worth considering".
- Use neutral observational language only. State each stock's data; do NOT
  declare a winner or recommend either one.
- For DCF / intrinsic value comparisons: state both stocks' model values
  alongside current prices. Do NOT compute or label an "upside %".`;

      // MONEY-806: honour the user's chosen report length (brief/full). The
      // inline compare prompt previously had NO length directive; "standard"/
      // unset appends nothing so the prompt is unchanged.
      const fullSystemPrompt =
        systemPrompt + compareReportLengthDirective(reportLength);

      const fullPrompt = `${fullSystemPrompt}\n\n${dataSection}`;

      const report = await generateWithTimeout(model, fullPrompt, 120_000, 3);

      console.log(
        "[compare-stocks] Got response, length:",
        report.length,
        "First 200 chars:",
        report.slice(0, 200),
      );

      // Parse JSON response
      const parsed = parseJsonResponse(report);

      if (parsed) {
        // Ensure required fields exist
        if (typeof parsed.score !== "number") parsed.score = 50;
        if (typeof parsed.recommendation !== "string")
          parsed.recommendation = "N/A";
        if (
          parsed.comparisonMeta &&
          typeof parsed.comparisonMeta === "object"
        ) {
          (parsed.comparisonMeta as Record<string, unknown>).winner = null;
        }
        if (typeof parsed.summary !== "string")
          parsed.summary = report.slice(0, 500);
        if (!parsed.disclaimer)
          parsed.disclaimer =
            "AI-generated comparison for informational purposes only. Not financial advice. Consult a SEBI-registered advisor.";

        // MONEY-457 (option C): override LLM-emitted scores with the
        // deterministic per-stock computation. The LLM is unreliable for
        // numeric ranking across runs — same input, different output. The
        // formula in compute_comparison_scores is invariant for a given
        // input. We keep the LLM's prose verdicts but replace its numeric
        // breakdown with the formula's.
        const symbolsForScoring =
          (parsed.comparisonMeta as Record<string, unknown>)?.stocks &&
          Array.isArray(
            (parsed.comparisonMeta as Record<string, unknown>).stocks,
          )
            ? ((parsed.comparisonMeta as Record<string, unknown>)
                .stocks as string[])
            : symbolsFromTasks(tasks);
        const metrics = extractStockMetrics(
          symbolsForScoring,
          tasks,
          stockData,
        );
        if (metrics) {
          try {
            const computed = computeComparisonScores(metrics);
            // Diff against LLM output (option C validator) — log a warning
            // when the LLM's per-stock total deviates substantially so we
            // can monitor model drift over time.
            const llmScores =
              ((parsed.comparisonMeta as Record<string, unknown>)
                ?.stockScores as Array<{ symbol: string; score: number }>) ??
              [];
            for (const computedScore of computed.stockScores) {
              const llm = llmScores.find(
                (s) => s.symbol === computedScore.symbol,
              );
              if (llm && Math.abs(llm.score - computedScore.score) >= 15) {
                console.warn(
                  "[compare-stocks] LLM score drift > 15 pts vs formula:",
                  {
                    symbol: computedScore.symbol,
                    llm: llm.score,
                    formula: computedScore.score,
                  },
                );
              }
            }
            // Apply the override.
            if (!parsed.comparisonMeta) parsed.comparisonMeta = {};
            (parsed.comparisonMeta as Record<string, unknown>).stockScores =
              computed.stockScores;
            (
              parsed.comparisonMeta as Record<string, unknown>
            ).perStockBreakdown = computed.perStockBreakdown;
          } catch (err) {
            console.warn(
              "[compare-stocks] compute_comparison_scores failed:",
              err instanceof Error ? err.message : err,
            );
          }
        }

        console.log(
          "[compare-stocks] Valid structured report. Score:",
          parsed.score,
          "Rec:",
          parsed.recommendation,
        );

        return { success: true, data: { report: parsed } };
      }

      // Fallback: wrap raw text in structured format
      console.warn("[compare-stocks] JSON parse failed, wrapping raw text");

      // Clean raw text for display
      const cleanReport = report
        .replace(/```(?:json)?\s*\n?/g, "")
        .replace(/```/g, "")
        .trim();
      const summaryExtract = cleanReport.match(
        /"summary"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/,
      );
      const displaySummary = summaryExtract
        ? summaryExtract[1]!.replace(/\\n/g, "\n").replace(/\\"/g, '"')
        : cleanReport.startsWith("{")
          ? "Comparison completed but the report format was unexpected. Please try again."
          : cleanReport.slice(0, 500);

      return {
        success: true,
        data: {
          report: {
            score: 50,
            recommendation: "N/A",
            confidence: 50,
            summary: displaySummary,
            comparisonMeta: {
              stocks: [],
              winner: null,
              verdict: "Could not parse structured comparison",
            },
            keyMetrics: [],
            sections: [
              {
                title: "Comparison Analysis",
                content: cleanReport,
                type: "text",
              },
            ],
            strengths: [],
            risks: [],
            rawText: report,
            disclaimer:
              "AI-generated comparison for informational purposes only. Not financial advice.",
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: `Comparison failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};
