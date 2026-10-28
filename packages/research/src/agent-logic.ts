/**
 * StockSage Research Agent — pure logic (side-effect-free)
 *
 * These helpers were inlined inside `agent.ts` (some as module-private
 * functions, some as private methods of `ResearchAgent`). They were extracted
 * here so the agent's pure decision logic — query cleaning, error
 * sanitisation, query-type routing, content-block rendering, the final
 * quality-score derivation, and the valid-report gate — can be unit-tested by
 * importing the REAL symbol instead of a shadow copy. `agent.ts` imports and
 * calls every function below; there are no dead exports.
 *
 * Nothing here touches Prisma, Gemini, the network, or any class state, so the
 * tests run without booting the agent's dependencies.
 */

import type { ResearchPlan, ResearchTask } from "./types";

/**
 * Strip the `[Mentioned: @SYM ("Name", Exchange), ...]` prefix that the chat
 * composer prepends when stocks are @-mentioned, and collapse the
 * parenthesised descriptions left in the body. Without this the LLM planner
 * treats description words ("INDUSTRIES", "INDIAN", "CORP") as stock symbols.
 *
 * Falls back to the trimmed raw query if stripping leaves nothing.
 */
export function cleanQueryForPlanner(raw: string): string {
  // Remove [Mentioned: ...] prefix entirely
  let cleaned = raw.replace(
    /^\[Mentioned:\s*(?:@\w+\s*\([^)]*\),?\s*)+\]\s*/i,
    "",
  );
  // Also strip [Analyze: ...] prefix if present
  cleaned = cleaned.replace(/^Analyze:\s*(?:@\w+\s*\([^)]*\),?\s*)+$/i, "");
  // Remove the parenthesized descriptions after @SYMBOL mentions in remaining
  // text, e.g. '@RELIANCE ("RELIANCE INDUSTRIES", NSE)' → '@RELIANCE'
  cleaned = cleaned.replace(
    /(@[A-Z][A-Z0-9&_]+)\s*\("[^"]*",\s*[^)]*\)/gi,
    "$1",
  );
  return cleaned.trim() || raw.trim();
}

/**
 * Sanitize error messages before storing in the DB / surfacing to users.
 * Keeps known-safe messages (e.g. invalid-symbol), maps technical internals
 * (Prisma/Mongo/network/auth/quota/AI/timeout/OOM) to generic copy, and lets
 * short non-technical strings through.
 */
export function sanitizeResearchError(raw: string): string {
  if (!raw) return "An error occurred during research. Please try again.";
  // Known safe user-facing messages - pass through
  if (raw.includes("not listed on")) return raw;
  if (raw.includes("only supports")) return raw;
  // Technical patterns → generic
  if (/prisma|mongodb|database|connection|ECONN|getaddrinfo/i.test(raw))
    return "A temporary service error occurred. Please try again.";
  if (/api.*key|unauthorized|forbidden|401|403/i.test(raw))
    return "A service configuration error occurred. Please try again later.";
  if (/rate.?limit|429|too many requests|quota/i.test(raw))
    return "Service is temporarily busy. Please try again in a few minutes.";
  if (/gemini|vertex|google.*ai|model.*error/i.test(raw))
    return "AI analysis service encountered an error. Please try again.";
  if (/timeout|ETIMEDOUT|deadline/i.test(raw))
    return "Research took too long to complete. Please try again.";
  if (/ENOMEM|heap|stack overflow|internal server/i.test(raw))
    return "A temporary error occurred. Please try again.";
  // Short non-technical messages are likely safe
  if (raw.length < 150 && !/error|exception|stack|trace|at\s/i.test(raw))
    return raw;
  return "Something went wrong during the analysis. Please try again.";
}

export type ResearchQueryType =
  | "strategy"
  | "stock-analysis"
  | "comparison"
  | "sector"
  | "portfolio"
  | "valuation"
  // Fund-shaped runs — select the fund-specific synthesizer prompt
  // (getSynthesizerPrompt switches on these). Previously the synthesizer
  // accepted "mf"/"etf" as bare strings but the type omitted them, so a typo
  // couldn't be caught and detectQueryType could not return them (MONEY-1073).
  | "mf"
  | "etf"
  | undefined;

/**
 * Route a query to the synthesizer prompt variant. Returns `undefined` for the
 * default single-stock analysis (handled by the mode-based prompt).
 */
export function detectQueryType(query: string): ResearchQueryType {
  const q = query.toLowerCase();

  // Fund-shaped runs carry an explicit prefix (see isFundShapedQuery). MUST be
  // checked FIRST: a fund's NAME routinely contains routing keywords — e.g.
  // "... Banking and PSU Debt Fund" or "HDFC Sectoral/Valuation Fund" — which
  // the checks below would otherwise mis-classify as sector/valuation and pick
  // the wrong (stock) synthesizer prompt (MONEY-1073).
  if (query.startsWith("[MUTUAL_FUND]")) return "mf";
  if (query.startsWith("[ETF]")) return "etf";

  // Strategy / scanning queries
  if (
    /\b(strateg|screen|scan|filter)\b.*\b(stock|share|nifty|market)\b/.test(
      q,
    ) ||
    /\b(golden\s*cross|death\s*cross|rsi|macd|bollinger|momentum|trend\s*follow|mean\s*reversion|swing)\b/.test(
      q,
    ) ||
    /\bwhich\s+(stocks?|shares?)\s+(match|meet|fit|satisfy)\b/.test(q) ||
    /\b(apply|run|test|check|evaluate)\s+(indicator|strategy|strateg)\b/.test(q)
  ) {
    return "strategy";
  }

  if (/\bcompar(e|ison)\b/.test(q)) return "comparison";
  if (/\bsector\b/.test(q)) return "sector";
  if (/\bportfolio\b/.test(q)) return "portfolio";
  if (/\b(dcf|fair\s*value|valuation|intrinsic)\b/.test(q)) return "valuation";

  return undefined; // Default stock-analysis handled by mode-based prompt
}

/**
 * A report is "valid" (no emergency synthesis needed) when it is a non-empty
 * string, or an object whose `score` is not exactly 0. A score of 0 is the
 * synthesizer's "failed" sentinel and triggers the emergency fallback.
 */
export function hasValidReport(
  report: Record<string, unknown> | string | null | undefined,
): boolean {
  return !!(
    report &&
    ((typeof report === "string" && report.trim()) ||
      (typeof report === "object" &&
        (report as Record<string, unknown>).score !== 0))
  );
}

/**
 * Derive the persisted `qualityScore` exactly as the agent does on COMPLETED:
 *   1. Prefer the validator score (advanced mode). Fast mode skips validation
 *      so `lastValidationScore` is 0 there.
 *   2. Fall back to `report.score` when the validator score is falsy.
 *   3. Normalise: a validator score in (0, 1] is 0-1 scale → ×100 and round.
 *      A report score (already 0-100) is left as-is.
 *   4. `finalScore || (skipValidation ? undefined : 0)` — a falsy 0 becomes
 *      `undefined` in fast mode (don't persist a misleading 0) and `0` in
 *      advanced mode.
 *
 * NOTE: `score === 0` is intentionally treated as falsy here (mirrors prod).
 */
export function computeQualityScore(
  report: Record<string, unknown> | string,
  lastValidationScore: number,
  skipValidation: boolean,
): number | undefined {
  let finalScore = lastValidationScore;
  if (!finalScore && report && typeof report === "object") {
    const reportObj = report as Record<string, unknown>;
    if (typeof reportObj.score === "number") {
      finalScore = reportObj.score;
    }
  }

  // Normalize: validator returns 0-1, report returns 0-100.
  if (finalScore && finalScore > 0 && finalScore <= 1) {
    finalScore = Math.round(finalScore * 100);
  }

  return finalScore || (skipValidation ? undefined : 0);
}

/**
 * Build chat-friendly content blocks from the structured report.
 *
 * MONEY-457: the score card subtitle shows ONLY confidence — the
 * `recommendation` field is kept in the JSON for compatibility but never
 * surfaces in the chat card, and the card is emitted whenever `score` is a
 * number (independent of whether a recommendation exists). A string report
 * becomes a single text block; an object with no renderable fields falls back
 * to a pretty-printed JSON text block.
 */
export function buildContentBlocks(
  report: Record<string, unknown> | string,
  symbols: string[],
): Record<string, unknown>[] {
  if (typeof report === "string") {
    return [{ type: "text", content: report }];
  }

  const blocks: Record<string, unknown>[] = [];

  // Score card — MONEY-457: confidence-only subtitle, no recommendation.
  if (typeof report.score === "number") {
    blocks.push({
      type: "card",
      variant: "metric",
      title: "Research Score",
      value: `${report.score}/100`,
      subtitle: `Confidence: ${report.confidence || "N/A"}%`,
      items: [
        {
          label: "Symbol",
          value: symbols.map((s) => s.replace(/\.(NS|BO)$/, "")).join(", "),
        },
      ],
    });
  }

  // Summary text
  if (typeof report.summary === "string") {
    blocks.push({ type: "text", content: report.summary });
  }

  // Key metrics as cards
  if (Array.isArray(report.keyMetrics) && report.keyMetrics.length > 0) {
    blocks.push({
      type: "card",
      variant: "info",
      title: "Key Metrics",
      items: (report.keyMetrics as Array<Record<string, unknown>>).map((m) => ({
        label: String(m.label || ""),
        value: `${m.value || ""} (${m.verdict || ""})`,
      })),
    });
  }

  // If no blocks were generated, fall back to text
  if (blocks.length === 0) {
    blocks.push({
      type: "text",
      content: JSON.stringify(report, null, 2),
    });
  }

  return blocks;
}

// ─── MONEY-794 (C1c): institutional run-parameter stamping ──────────────────

/**
 * Institutional run-parameters that tune HOW a plan is parameterised without
 * changing the skill set. Mirrors the fields on `ResearchJobMessage`; every
 * field is optional and an empty object reproduces today's plan exactly.
 */
export interface RunParameters {
  /** Analysis horizon → `fetch_price_history.period` + synthesizer framing. */
  horizon?: "1y" | "3y" | "5y";
  /** Benchmark id (NIFTY50/SENSEX/NIFTY500) or sector name → index symbol on
   *  the benchmark fetch (the single source of truth; beta reads that series). */
  benchmark?: string;
  /** DCF assumption overrides (compute_dcf reads the mapped param names). */
  assumptions?: {
    wacc?: number;
    terminalGrowth?: number;
    growthOverride?: number;
  };
  /** Synthesizer section-depth / length guidance. */
  reportLength?: "brief" | "standard" | "full";
  /** Value-at-Risk confidence / holding-horizon overrides. */
  varConfig?: {
    confidence?: 95 | 99;
    horizonDays?: 1 | 10;
  };
}

/** Known benchmark id → Yahoo index symbol. Kept inline (no `@usemoney/services`
 *  dependency in the research package's pure logic). `^NSEI` is today's default. */
const BENCHMARK_SYMBOL_MAP: Record<string, string> = {
  NIFTY50: "^NSEI",
  SENSEX: "^BSESN",
  NIFTY500: "^CRSLDX",
};

/**
 * Map a benchmark choice to its index symbol. A known id resolves to its
 * `^…` ticker; a free-text sector name is returned untouched (a downstream
 * sector-index resolver handles it). Empty → `^NSEI` (today's hardcoded
 * default — `isBenchmarkSymbol` already tolerates `^BSESN`/`NIFTY` too).
 */
export function resolveBenchmarkSymbol(benchmark?: string): string {
  if (!benchmark || !benchmark.trim()) return "^NSEI";
  return BENCHMARK_SYMBOL_MAP[benchmark] ?? benchmark.trim();
}

/**
 * Tools whose `params.symbol` is a benchmark index (not the subject stock).
 *
 * Anchored to match ONLY the exact index tickers a planner emits for the
 * benchmark fetch (`^NSEI` / `^BSESN` / `^CRSLDX`, with the `^` optional and a
 * trailing exchange suffix like `.NS` tolerated). A loose substring match
 * (e.g. `/NIFTY/`) would also catch a real ETF the user is researching — e.g.
 * `NIFTYBEES` — and overwrite that SUBJECT's own OHLCV fetch symbol with the
 * benchmark index. Narrowed so only the benchmark fetch task is ever rewritten
 * (MONEY-779).
 */
const BENCHMARK_FETCH_RE = /^\^?(NSEI|BSESN|CRSLDX)(\.[A-Z]+)?$/i;

/** VaR `period` token from a horizonDays value (compute_var reads "1-day"/"10-day"). */
function varPeriodLabel(horizonDays?: number): string | undefined {
  if (horizonDays === 10) return "10-day";
  if (horizonDays === 1) return "1-day";
  return undefined;
}

/**
 * MONEY-794 (C1c) — stamp institutional run-parameters onto a plan's task
 * params. Pure + additive: returns a NEW plan with cloned tasks; an empty
 * `runParams` returns a structurally-identical plan (only the tasks array is
 * re-created). Mirrors the `researchFocus`/`memoryContext` synthesis-param
 * stamping already used by the agent, so no new mechanism is invented.
 *
 * Stamping rules (each only fires when its field is set):
 *   - `horizon`     → every `fetch_price_history` task's `params.period`
 *                     (skills hardcode "1y"/"2y"; the tool accepts 1m–5y) and
 *                     `runParams.horizon` onto synthesis tasks (the prompt
 *                     builder reads it for a framing directive).
 *   - `benchmark`   → mapped to an index symbol and stamped ONLY onto the
 *                     benchmark `fetch_price_history` task (whose existing symbol
 *                     is an index). That fetch rewrite is the SINGLE SOURCE OF
 *                     TRUTH for the benchmark: compute_beta_decomposition reads
 *                     the rewritten benchmark fetch SERIES, so stamping a
 *                     separate `params.benchmark` on it was inert (MONEY-807).
 *   - `assumptions` → onto compute_dcf only (wacc / terminalGrowthRate /
 *                     growthRate — the tool param names compute_dcf reads
 *                     DIRECTLY). The raw `assumptions` object is no longer
 *                     stamped onto compute_wacc / compute_scenario_analysis: no
 *                     tool ever read it there, so it was an inert stamp
 *                     (MONEY-807).
 *   - `reportLength`→ onto synthesis tasks (prompt builder reads it).
 *   - `varConfig`   → onto compute_var (`period` from horizonDays) +
 *                     compute_position_var; raw `varConfig` carried on both.
 */
export function applyRunParameters(
  plan: ResearchPlan,
  runParams: RunParameters,
): ResearchPlan {
  const hasHorizon = !!runParams.horizon;
  const benchSymbol = runParams.benchmark
    ? resolveBenchmarkSymbol(runParams.benchmark)
    : undefined;
  const assumptions = runParams.assumptions;
  const hasAssumptions =
    !!assumptions &&
    (assumptions.wacc !== undefined ||
      assumptions.terminalGrowth !== undefined ||
      assumptions.growthOverride !== undefined);
  const varCfg = runParams.varConfig;
  const hasVarConfig =
    !!varCfg &&
    (varCfg.confidence !== undefined || varCfg.horizonDays !== undefined);
  const synthExtras = !!runParams.horizon || !!runParams.reportLength;

  const tasks: ResearchTask[] = plan.tasks.map((t) => {
    const params: Record<string, unknown> = { ...t.params };
    let changed = false;

    // horizon → fetch_price_history.period (subject + benchmark fetches alike).
    if (hasHorizon && t.tool === "fetch_price_history") {
      params.period = runParams.horizon;
      changed = true;
    }

    // benchmark → the index symbol on the benchmark fetch ONLY. This rewrite is
    // the single source of truth for the benchmark: compute_beta_decomposition
    // reads the rewritten benchmark fetch SERIES (not a param), and compute_beta
    // consumes pre-computed return arrays from the portfolio layer. Stamping
    // `params.benchmark` on either was inert, so it's dropped (MONEY-807).
    if (benchSymbol) {
      if (
        t.tool === "fetch_price_history" &&
        typeof params.symbol === "string" &&
        BENCHMARK_FETCH_RE.test(params.symbol)
      ) {
        params.symbol = benchSymbol;
        changed = true;
      }
    }

    // assumptions → compute_dcf only. compute_dcf reads the mapped tool param
    // names (wacc / terminalGrowthRate / growthRate) DIRECTLY; the raw
    // `assumptions` object is carried alongside for forward-compat. The stamp
    // was dropped from compute_wacc / compute_scenario_analysis: neither tool
    // ever read it, so it was inert (MONEY-807).
    if (hasAssumptions && t.tool === "compute_dcf") {
      if (assumptions!.wacc !== undefined) params.wacc = assumptions!.wacc;
      if (assumptions!.terminalGrowth !== undefined)
        params.terminalGrowthRate = assumptions!.terminalGrowth;
      if (assumptions!.growthOverride !== undefined)
        params.growthRate = assumptions!.growthOverride;
      params.assumptions = { ...assumptions };
      changed = true;
    }

    // varConfig → VaR task params.
    if (hasVarConfig) {
      if (t.tool === "compute_var") {
        const periodLabel = varPeriodLabel(varCfg!.horizonDays);
        if (periodLabel) params.period = periodLabel;
        params.varConfig = { ...varCfg };
        changed = true;
      } else if (t.tool === "compute_position_var") {
        params.varConfig = { ...varCfg };
        changed = true;
      }
    }

    // horizon + reportLength → synthesis tasks (prompt builder reads these).
    if (synthExtras && t.type === "synthesis") {
      if (runParams.horizon) params.horizon = runParams.horizon;
      if (runParams.reportLength) params.reportLength = runParams.reportLength;
      changed = true;
    }

    return changed ? { ...t, params } : { ...t };
  });

  return { ...plan, tasks };
}
