/**
 * MONEY-498 — Declarative dependency → param bindings for the institutional
 * expansion tools.
 *
 * The executor's `injectComputationParams` hand-wires the ORIGINAL ~17 compute
 * tools with a large per-tool switch (kept untouched to avoid regressions).
 * The 26 new institutional tools are instead bound DATA-DRIVEN here: for each
 * new compute tool we declare which dependency-tool result fields feed which
 * params. `applyDeclarativeBindings(task, dep, params)` is called once per
 * (computation task, completed dependency) pair, appended at the end of
 * `injectComputationParams`.
 *
 * Design:
 *  - Pure, no io. Mutates `params` in place, only filling a param when it is
 *    still null/undefined (static skill params + the legacy switch win).
 *  - Every extraction is wrapped — a bad/odd dependency shape can never throw
 *    into the executor; the binding is simply skipped and the tool degrades to
 *    `available: false` (the product-mandated graceful path).
 *  - Data tools (fetch_*) take no bindings — they do their own io.
 *  - compute_concentration_delta / compute_portfolio_beta_drift intentionally
 *    have NO bindings: their portfolio inputs arrive from the server-action
 *    layer; in single-stock research they correctly degrade.
 */

import type { ResearchTask } from "../types";

type ExtractKind =
  | "annualLast" // dep.result.annual[last][field]            -> number
  | "annualArray" // dep.result.annual[].field (finite nums)   -> number[]
  | "annualRaw" // dep.result.annual (array of row objects)   -> object[]
  | "priceFirstKey" // dep.result[firstSymbol][field]          -> number
  | "field" // dep.result[field] (supports a.b dotted path)    -> unknown
  | "whole" // dep.result                                       -> unknown
  | "newsArticles" // dep.result as article[]                   -> object[]
  | "ohlcv"; // dep.result (bars[] | {prices}) -> series        -> number[]/string[]

interface InputBinding {
  param: string; // target param on the computation task
  fromTool: string; // dependency tool name
  kind: ExtractKind;
  field?: string; // source field (annualLast/annualArray/priceFirstKey/field/ohlcv-series)
  /**
   * For tools that depend on TWO fetch_price_history tasks (subject + a Nifty
   * benchmark), restrict the binding to the matching dependency by symbol.
   */
  symbolMatch?: "subject" | "benchmark";
}

const OHLCV_FIELD: Record<string, string> = {
  closes: "close",
  highs: "high",
  lows: "low",
  volumes: "volume",
  dates: "date",
  stockCloses: "close",
  benchmarkCloses: "close",
};

/** Nifty / broad-market benchmark tickers used for beta decomposition. */
function isBenchmarkSymbol(sym: unknown): boolean {
  // Anchored to EXACT index tickers (MONEY-779 scan fix) — the prior loose
  // substring match classified ETFs like NIFTYBEES / SENSEXBEES as benchmarks.
  return (
    typeof sym === "string" && /^\^?(NSEI|BSESN|CRSLDX)(\.[A-Z]+)?$/i.test(sym)
  );
}

export const TOOL_INPUT_BINDINGS: Record<string, InputBinding[]> = {
  // ── Cluster 1: cash-flow & earnings depth ──────────────────────────
  compute_capex_intensity: [
    {
      param: "capitalExpenditure",
      fromTool: "fetch_cash_flow",
      kind: "annualLast",
      field: "capitalExpenditure",
    },
    {
      param: "operatingCashFlow",
      fromTool: "fetch_cash_flow",
      kind: "annualLast",
      field: "operatingCashFlow",
    },
    {
      param: "revenue",
      fromTool: "fetch_income_statement",
      kind: "annualLast",
      field: "revenue",
    },
    {
      param: "historicalCapex",
      fromTool: "fetch_cash_flow",
      kind: "annualArray",
      field: "capitalExpenditure",
    },
    {
      param: "historicalRevenue",
      fromTool: "fetch_income_statement",
      kind: "annualArray",
      field: "revenue",
    },
  ],
  compute_fcf_yield: [
    {
      param: "freeCashFlow",
      fromTool: "fetch_cash_flow",
      kind: "annualLast",
      field: "freeCashFlow",
    },
    {
      param: "operatingCashFlow",
      fromTool: "fetch_cash_flow",
      kind: "annualLast",
      field: "operatingCashFlow",
    },
    {
      param: "capitalExpenditure",
      fromTool: "fetch_cash_flow",
      kind: "annualLast",
      field: "capitalExpenditure",
    },
    {
      param: "revenue",
      fromTool: "fetch_income_statement",
      kind: "annualLast",
      field: "revenue",
    },
    {
      param: "marketCap",
      fromTool: "fetch_stock_price",
      kind: "priceFirstKey",
      field: "marketCap",
    },
    {
      param: "totalDebt",
      fromTool: "fetch_balance_sheet",
      kind: "annualLast",
      field: "totalDebt",
    },
    {
      param: "totalCash",
      fromTool: "fetch_balance_sheet",
      kind: "annualLast",
      field: "totalCash",
    },
    { param: "historicalFcf", fromTool: "fetch_cash_flow", kind: "annualRaw" },
  ],
  compute_working_capital_drag: [
    {
      param: "revenue",
      fromTool: "fetch_income_statement",
      kind: "annualLast",
      field: "revenue",
    },
    {
      param: "costOfRevenue",
      fromTool: "fetch_income_statement",
      kind: "annualLast",
      field: "costOfRevenue",
    },
    {
      param: "receivables",
      fromTool: "fetch_balance_sheet",
      kind: "annualLast",
      field: "receivables",
    },
    {
      param: "inventory",
      fromTool: "fetch_balance_sheet",
      kind: "annualLast",
      field: "inventory",
    },
    {
      param: "payables",
      fromTool: "fetch_balance_sheet",
      kind: "annualLast",
      field: "payables",
    },
    {
      param: "historicalRevenue",
      fromTool: "fetch_income_statement",
      kind: "annualArray",
      field: "revenue",
    },
    {
      param: "historicalCostOfRevenue",
      fromTool: "fetch_income_statement",
      kind: "annualArray",
      field: "costOfRevenue",
    },
  ],
  compute_guidance_sensitivity: [
    {
      param: "revenue",
      fromTool: "fetch_income_statement",
      kind: "annualLast",
      field: "revenue",
    },
    {
      param: "operatingIncome",
      fromTool: "fetch_income_statement",
      kind: "annualLast",
      field: "operatingIncome",
    },
    {
      param: "operatingMargin",
      fromTool: "fetch_key_ratios",
      kind: "field",
      field: "operatingMargin",
    },
    {
      param: "revenueGrowth",
      fromTool: "fetch_key_ratios",
      kind: "field",
      field: "revenueGrowth",
    },
    { param: "pe", fromTool: "fetch_key_ratios", kind: "field", field: "pe" },
    {
      param: "currentPrice",
      fromTool: "fetch_stock_price",
      kind: "priceFirstKey",
      field: "price",
    },
    {
      param: "marketCap",
      fromTool: "fetch_stock_price",
      kind: "priceFirstKey",
      field: "marketCap",
    },
  ],
  compute_dcf_sensitivity: [
    {
      param: "dcfAssumptions",
      fromTool: "compute_dcf",
      kind: "field",
      field: "assumptions",
    },
    {
      param: "intrinsicValue",
      fromTool: "compute_dcf",
      kind: "field",
      field: "intrinsicValue",
    },
    { param: "wacc", fromTool: "compute_wacc", kind: "field", field: "wacc" },
    {
      param: "currentPrice",
      fromTool: "fetch_stock_price",
      kind: "priceFirstKey",
      field: "price",
    },
    {
      param: "marketCap",
      fromTool: "fetch_stock_price",
      kind: "priceFirstKey",
      field: "marketCap",
    },
  ],
  compute_payout_coverage: [
    {
      param: "dividendsPaid",
      fromTool: "fetch_cash_flow",
      kind: "annualLast",
      field: "dividendsPaid",
    },
    {
      param: "freeCashFlow",
      fromTool: "fetch_cash_flow",
      kind: "annualLast",
      field: "freeCashFlow",
    },
    {
      param: "netIncome",
      fromTool: "fetch_income_statement",
      kind: "annualLast",
      field: "netIncome",
    },
    {
      param: "marketCap",
      fromTool: "fetch_stock_price",
      kind: "priceFirstKey",
      field: "marketCap",
    },
    {
      param: "currentPrice",
      fromTool: "fetch_stock_price",
      kind: "priceFirstKey",
      field: "price",
    },
  ],
  // MONEY-612/498: Piotroski F-Score — two-year statement series. Fields that
  // aren't in the balance-sheet result (currentAssets/Liabilities, shares) bind
  // empty and the tool marks those criteria unavailable (graceful).
  compute_piotroski: [
    {
      param: "historicalNetIncome",
      fromTool: "fetch_income_statement",
      kind: "annualArray",
      field: "netIncome",
    },
    {
      param: "historicalRevenue",
      fromTool: "fetch_income_statement",
      kind: "annualArray",
      field: "revenue",
    },
    {
      param: "historicalGrossProfit",
      fromTool: "fetch_income_statement",
      kind: "annualArray",
      field: "grossProfit",
    },
    {
      param: "historicalTotalAssets",
      fromTool: "fetch_balance_sheet",
      kind: "annualArray",
      field: "totalAssets",
    },
    {
      param: "historicalTotalDebt",
      fromTool: "fetch_balance_sheet",
      kind: "annualArray",
      field: "totalDebt",
    },
    {
      param: "historicalCurrentAssets",
      fromTool: "fetch_balance_sheet",
      kind: "annualArray",
      field: "currentAssets",
    },
    {
      param: "historicalCurrentLiabilities",
      fromTool: "fetch_balance_sheet",
      kind: "annualArray",
      field: "currentLiabilities",
    },
    {
      param: "historicalSharesOutstanding",
      fromTool: "fetch_balance_sheet",
      kind: "annualArray",
      field: "sharesOutstanding",
    },
    {
      param: "historicalOperatingCashFlow",
      fromTool: "fetch_cash_flow",
      kind: "annualArray",
      field: "operatingCashFlow",
    },
  ],

  // Altman Z″ (emerging markets) — latest-year balance sheet + EBIT.
  compute_altman_z: [
    {
      param: "currentAssets",
      fromTool: "fetch_balance_sheet",
      kind: "annualLast",
      field: "currentAssets",
    },
    {
      param: "currentLiabilities",
      fromTool: "fetch_balance_sheet",
      kind: "annualLast",
      field: "currentLiabilities",
    },
    {
      param: "totalAssets",
      fromTool: "fetch_balance_sheet",
      kind: "annualLast",
      field: "totalAssets",
    },
    {
      param: "retainedEarnings",
      fromTool: "fetch_balance_sheet",
      kind: "annualLast",
      field: "retainedEarnings",
    },
    {
      param: "ebit",
      fromTool: "fetch_income_statement",
      kind: "annualLast",
      field: "operatingIncome",
    },
    {
      param: "totalEquity",
      fromTool: "fetch_balance_sheet",
      kind: "annualLast",
      field: "totalEquity",
    },
    {
      param: "totalLiabilities",
      fromTool: "fetch_balance_sheet",
      kind: "annualLast",
      field: "totalLiabilities",
    },
  ],

  // Beneish M-Score — two years of statements across income/balance/cash flow.
  compute_beneish_m: [
    {
      param: "historicalReceivables",
      fromTool: "fetch_balance_sheet",
      kind: "annualArray",
      field: "receivables",
    },
    {
      param: "historicalRevenue",
      fromTool: "fetch_income_statement",
      kind: "annualArray",
      field: "revenue",
    },
    {
      param: "historicalGrossProfit",
      fromTool: "fetch_income_statement",
      kind: "annualArray",
      field: "grossProfit",
    },
    {
      param: "historicalCurrentAssets",
      fromTool: "fetch_balance_sheet",
      kind: "annualArray",
      field: "currentAssets",
    },
    {
      param: "historicalPPE",
      fromTool: "fetch_balance_sheet",
      kind: "annualArray",
      field: "propertyPlantEquipment",
    },
    {
      param: "historicalTotalAssets",
      fromTool: "fetch_balance_sheet",
      kind: "annualArray",
      field: "totalAssets",
    },
    {
      param: "historicalDepreciation",
      fromTool: "fetch_cash_flow",
      kind: "annualArray",
      field: "depreciation",
    },
    {
      param: "historicalSGA",
      fromTool: "fetch_income_statement",
      kind: "annualArray",
      field: "sga",
    },
    {
      param: "historicalTotalLiabilities",
      fromTool: "fetch_balance_sheet",
      kind: "annualArray",
      field: "totalLiabilities",
    },
    {
      param: "historicalNetIncome",
      fromTool: "fetch_income_statement",
      kind: "annualArray",
      field: "netIncome",
    },
    {
      param: "historicalOperatingCashFlow",
      fromTool: "fetch_cash_flow",
      kind: "annualArray",
      field: "operatingCashFlow",
    },
  ],

  // Earnings beat/miss history — fetch_earnings returns { history: [...] }.
  compute_earnings_surprise: [
    {
      param: "earningsHistory",
      fromTool: "fetch_earnings",
      kind: "field",
      field: "history",
    },
  ],

  // ── Cluster 2: quant & technical ───────────────────────────────────
  compute_factor_scores: [
    { param: "pe", fromTool: "fetch_key_ratios", kind: "field", field: "pe" },
    { param: "pb", fromTool: "fetch_key_ratios", kind: "field", field: "pb" },
    {
      param: "evToEbitda",
      fromTool: "fetch_key_ratios",
      kind: "field",
      field: "evToEbitda",
    },
    { param: "roe", fromTool: "fetch_key_ratios", kind: "field", field: "roe" },
    { param: "roa", fromTool: "fetch_key_ratios", kind: "field", field: "roa" },
    {
      param: "netMargin",
      fromTool: "fetch_key_ratios",
      kind: "field",
      field: "netMargin",
    },
    {
      param: "operatingMargin",
      fromTool: "fetch_key_ratios",
      kind: "field",
      field: "operatingMargin",
    },
    {
      param: "debtToEquity",
      fromTool: "fetch_key_ratios",
      kind: "field",
      field: "debtToEquity",
    },
    {
      param: "currentRatio",
      fromTool: "fetch_key_ratios",
      kind: "field",
      field: "currentRatio",
    },
    {
      param: "dividendYield",
      fromTool: "fetch_key_ratios",
      kind: "field",
      field: "dividendYield",
    },
    {
      param: "revenueGrowth",
      fromTool: "fetch_key_ratios",
      kind: "field",
      field: "revenueGrowth",
    },
    {
      param: "earningsGrowth",
      fromTool: "fetch_key_ratios",
      kind: "field",
      field: "earningsGrowth",
    },
    {
      param: "beta",
      fromTool: "fetch_key_ratios",
      kind: "field",
      field: "beta",
    },
    {
      param: "closes",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "closes",
    },
  ],
  compute_factor_zscore: [
    {
      param: "subjectFactors",
      fromTool: "compute_factor_scores",
      kind: "whole",
    },
    { param: "peers", fromTool: "fetch_peer_companies", kind: "whole" },
  ],
  compute_composite_quant_score: [
    { param: "factorScores", fromTool: "compute_factor_scores", kind: "whole" },
    {
      param: "factorZscores",
      fromTool: "compute_factor_zscore",
      kind: "whole",
    },
  ],
  compute_volume_profile: [
    {
      param: "closes",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "closes",
    },
    {
      param: "highs",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "highs",
    },
    {
      param: "lows",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "lows",
    },
    {
      param: "volumes",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "volumes",
    },
  ],
  compute_trend_strength: [
    {
      param: "closes",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "closes",
    },
    {
      param: "highs",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "highs",
    },
    {
      param: "lows",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "lows",
    },
  ],
  detect_breakout_setups: [
    {
      param: "closes",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "closes",
    },
    {
      param: "highs",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "highs",
    },
    {
      param: "lows",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "lows",
    },
    {
      param: "volumes",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "volumes",
    },
  ],

  // ── Cluster 3: regime & risk ───────────────────────────────────────
  compute_volatility_regime: [
    {
      param: "closes",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "closes",
    },
  ],
  compute_drawdown_profile: [
    {
      param: "closes",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "closes",
    },
    {
      param: "dates",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "dates",
    },
  ],
  compute_beta_decomposition: [
    {
      param: "stockCloses",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "stockCloses",
      symbolMatch: "subject",
    },
    {
      param: "benchmarkCloses",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "benchmarkCloses",
      symbolMatch: "benchmark",
    },
  ],
  compute_position_var: [
    {
      param: "closes",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "closes",
    },
  ],
  compute_monte_carlo_returns: [
    {
      param: "currentPrice",
      fromTool: "fetch_stock_price",
      kind: "priceFirstKey",
      field: "price",
    },
    {
      param: "closes",
      fromTool: "fetch_price_history",
      kind: "ohlcv",
      field: "closes",
    },
  ],

  // ── Cluster 4: macro, flows & governance ───────────────────────────
  compute_rate_sensitivity: [
    {
      param: "sector",
      fromTool: "fetch_company_profile",
      kind: "field",
      field: "sector",
    },
    {
      param: "repoRate",
      fromTool: "fetch_macro_dashboard",
      kind: "field",
      field: "repoRate.value",
    },
    {
      param: "repoRateHistory",
      fromTool: "fetch_macro_dashboard",
      kind: "field",
      field: "repoRateHistory",
    },
  ],
  compute_sector_rotation: [
    {
      param: "sector",
      fromTool: "fetch_company_profile",
      kind: "field",
      field: "sector",
    },
    {
      param: "sectorPerformances",
      fromTool: "fetch_macro_dashboard",
      kind: "field",
      field: "sectorPerformances",
    },
    { param: "fiiDiiFlows", fromTool: "fetch_fii_dii_flows", kind: "whole" },
  ],
  compute_governance_flags: [
    {
      param: "shareholding",
      fromTool: "fetch_shareholding_pattern",
      kind: "whole",
    },
    {
      param: "promoterPledging",
      fromTool: "fetch_promoter_pledging",
      kind: "whole",
    },
    {
      param: "promoterHolding",
      fromTool: "fetch_promoter_holding",
      kind: "whole",
    },
    {
      param: "corporateActions",
      fromTool: "fetch_corporate_actions",
      kind: "whole",
    },
    { param: "relatedParty", fromTool: "fetch_related_party", kind: "whole" },
  ],
  compute_news_sentiment: [
    { param: "articles", fromTool: "fetch_news", kind: "newsArticles" },
  ],

  // ── MONEY-446 Part C: single-fund constituent analysis ─────────────
  // Inject the fund's holdings (MfHolding[]) straight from fetch_mf_holdings.
  // `whole` hands the array through as-is; the tool normalises it defensively
  // and degrades to available:false when holdings are absent.
  compute_constituent_analysis: [
    { param: "holdings", fromTool: "fetch_mf_holdings", kind: "whole" },
  ],
};

// ── extraction helpers ───────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    const rec = asRecord(cur);
    if (!rec) return undefined;
    cur = rec[key];
  }
  return cur;
}

/** Numeric sort key for an annual statement row: prefer the raw endDate
 *  (Yahoo unix ts), else a parsed `period` date; missing → 0 (sorts oldest). */
function annualDateKey(r: Record<string, unknown>): number {
  const e = Number(r.endDate);
  if (Number.isFinite(e) && e > 0) return e;
  const p = Date.parse(String(r.period ?? ""));
  return Number.isFinite(p) ? p : 0;
}

function annualRows(result: unknown): Array<Record<string, unknown>> {
  const rec = asRecord(result);
  const annual = rec?.annual ?? (Array.isArray(result) ? result : undefined);
  if (!Array.isArray(annual)) return [];
  const rows = annual.filter((r) => asRecord(r) !== null) as Array<
    Record<string, unknown>
  >;
  // MONEY-613: normalize to OLDEST→NEWEST. Sources like Yahoo return statements
  // newest-first, but the annualArray/annualLast contract is oldest→newest — so
  // annualLast (rows[last]) and lastTwo() must read the LATEST year. Without this
  // every annual forensic/fundamental tool (Piotroski / Altman / Beneish /
  // working-capital / capex) computed on the OLDEST year. Sort is idempotent for
  // already-ascending sources.
  return rows.slice().sort((a, b) => annualDateKey(a) - annualDateKey(b));
}

function bars(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result))
    return result.filter((b) => asRecord(b) !== null) as Array<
      Record<string, unknown>
    >;
  const rec = asRecord(result);
  const prices = rec?.prices ?? rec?.history ?? rec?.bars;
  return Array.isArray(prices)
    ? (prices.filter((b) => asRecord(b) !== null) as Array<
        Record<string, unknown>
      >)
    : [];
}

function finiteNum(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function extract(binding: InputBinding, depResult: unknown): unknown {
  switch (binding.kind) {
    case "whole":
      return depResult;
    case "field":
      return getByPath(depResult, binding.field ?? "");
    case "annualLast": {
      const rows = annualRows(depResult);
      const last = rows[rows.length - 1];
      return last ? last[binding.field ?? ""] : undefined;
    }
    case "annualArray": {
      const f = binding.field ?? "";
      return annualRows(depResult)
        .map((r) => finiteNum(r[f]))
        .filter((n): n is number => n !== null);
    }
    case "annualRaw":
      return annualRows(depResult);
    case "priceFirstKey": {
      const rec = asRecord(depResult);
      if (!rec) return undefined;
      const firstKey = Object.keys(rec)[0];
      const entry = firstKey ? asRecord(rec[firstKey]) : null;
      return entry ? entry[binding.field ?? ""] : undefined;
    }
    case "newsArticles": {
      if (Array.isArray(depResult)) return depResult;
      const rec = asRecord(depResult);
      const arr = rec?.articles ?? rec?.news ?? rec?.items;
      return Array.isArray(arr) ? arr : [];
    }
    case "ohlcv": {
      const series = OHLCV_FIELD[binding.field ?? ""] ?? "close";
      const rows = bars(depResult);
      const vals = rows.map((b) => b[series]);
      // dates stay strings; everything else is numeric + finite-filtered.
      if (series === "date") return vals.filter((v) => typeof v === "string");
      const nums = vals.map(finiteNum).filter((n): n is number => n !== null);
      return nums.length ? nums : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Apply the declarative bindings for `task.tool`, pulling from a single
 * completed dependency `dep`. Mutates `params` (fills only empty params).
 * Never throws.
 */
export function applyDeclarativeBindings(
  task: ResearchTask,
  dep: ResearchTask,
  params: Record<string, unknown>,
): void {
  const bindings = TOOL_INPUT_BINDINGS[task.tool];
  if (!bindings || dep.status !== "completed" || dep.result == null) return;

  const depSymbol = (dep.params as Record<string, unknown> | undefined)?.symbol;

  for (const binding of bindings) {
    if (binding.fromTool !== dep.tool) continue;

    // Disambiguate the two fetch_price_history deps (subject vs Nifty benchmark).
    if (binding.symbolMatch === "benchmark" && !isBenchmarkSymbol(depSymbol))
      continue;
    if (binding.symbolMatch === "subject" && isBenchmarkSymbol(depSymbol))
      continue;

    if (params[binding.param] != null) continue; // static/legacy params win

    try {
      const value = extract(binding, dep.result);
      if (value != null && !(Array.isArray(value) && value.length === 0)) {
        params[binding.param] = value;
      }
    } catch {
      // Bad/odd dependency shape — skip; the tool degrades to available:false.
    }
  }
}
