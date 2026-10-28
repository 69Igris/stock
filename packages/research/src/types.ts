/**
 * StockSage Research Agent - Core Types
 */

// MONEY-1300 — the ONE basis vocabulary, imported rather than restated. A
// second hand-kept copy of "CONSOLIDATED | STANDALONE | UNKNOWN" is how a
// reader ends up disagreeing with the writer about what an absent column means.
import type { StockFinancialsBasis } from "@usemoney/core/market-data/financials-basis";

// ─── Research Task ──────────────────────────────────────────

export interface ResearchTask {
  id: string;
  type: "data_fetch" | "analysis" | "computation" | "synthesis";
  tool: string;
  params: Record<string, unknown>;
  dependsOn: string[];
  status: "pending" | "running" | "completed" | "failed";
  result?: unknown;
  error?: string;
  /**
   * MONEY-1060 (RC4): the tool's `ToolOutput.metadata`, carried onto the task
   * by the executor on BOTH success and failure so downstream consumers (the
   * synthesizer prompt's failed/unavailable-sources section, staleness
   * labelling) can read `sourceError` / `source` / `stale` — previously the
   * executor kept only `result.data` and this signal was discarded.
   */
  metadata?: Record<string, unknown>;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
}

export interface ResearchPlan {
  query: string;
  skill?: string;
  symbols: string[];
  tasks: ResearchTask[];
  estimatedSteps: number;
  complexity: "simple" | "moderate" | "complex";
  /**
   * MONEY-222 - when the user chose Custom style, the planner trims
   * compute/analysis tasks down to the tools owned by these skill IDs.
   * Data fetches are kept regardless (cheap + useful as synthesizer
   * context).
   */
  customSkills?: string[];
  /**
   * MONEY-222 - free-text "always focus on" preference. The
   * synthesizer-task params inherit this and the prompt prepends it
   * as a directive so reports lean toward the user's recurring lens.
   */
  researchFocus?: string;
  /**
   * MONEY-219/MONEY-779 - the research-type preset the user picked. Stamped
   * by `applyResearchPreferences` and persisted on the session plan; the
   * worker's billing reconciliation reads `planObj.preset` to attribute the
   * run to its template. Does NOT affect task filtering.
   */
  preset?: string;
}

// ─── Scratchpad ─────────────────────────────────────────────

export type ScratchpadEntryType =
  | "plan"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "validation"
  | "error"
  | "refinement";

export interface ScratchpadEntry {
  timestamp: string;
  stepNumber: number;
  type: ScratchpadEntryType;
  taskId?: string;
  data: unknown;
  tokenUsage?: { input: number; output: number };
}

// ─── Research Tool ──────────────────────────────────────────

export interface ToolOutput {
  success: boolean;
  data?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ResearchToolDef {
  name: string;
  description: string;
  category: "data" | "computation" | "synthesis";
  parameters: Record<
    string,
    {
      type: string;
      description: string;
      required?: boolean;
      default?: unknown;
    }
  >;
  execute: (params: Record<string, unknown>) => Promise<ToolOutput>;
  cacheTTL?: number;
}

// ─── Research Skill ─────────────────────────────────────────

export interface ResearchSkill {
  name: string;
  description: string;
  triggers: RegExp[];
  requiredParams: string[];
  optionalParams?: string[];
  buildPlan: (params: Record<string, unknown>) => ResearchPlan;
}

// ─── Validation ─────────────────────────────────────────────

export interface ValidationResult {
  score: number; // 0-1
  passed: boolean;
  gaps: string[];
  suggestions: string[];
}

// ─── Research Session State ─────────────────────────────────

export type ResearchStatus =
  | "PLANNING"
  | "RESEARCHING"
  | "ANALYZING"
  | "VALIDATING"
  | "REFINING"
  | "SYNTHESIZING"
  | "COMPLETED"
  | "FAILED";

export interface ResearchSessionState {
  sessionId: string;
  userId: string;
  query: string;
  skill?: string;
  symbols: string[];
  plan?: ResearchPlan;
  scratchpad: ScratchpadEntry[];
  status: ResearchStatus;
  progress: number;
  currentStep?: string;
  iteration: number;
  qualityScore?: number;
  totalSteps: number;
  tokensUsed: number;
  errorMessage?: string;
  startedAt: Date;
  completedAt?: Date;
}

// ─── Research Mode ──────────────────────────────────────────

export type ResearchMode = "fast" | "advanced";

// ─── Agent Config ───────────────────────────────────────────

export interface ResearchAgentConfig {
  maxSteps: number;
  maxIterations: number;
  qualityThreshold: number;
  stepTimeoutMs: number;
  totalTimeoutMs: number;
  maxConcurrency: number;
  skipValidation?: boolean;
}

export const DEFAULT_AGENT_CONFIG: ResearchAgentConfig = {
  maxSteps: Infinity, // No artificial step limit
  maxIterations: 2,
  qualityThreshold: 0.7,
  stepTimeoutMs: 30_000,
  totalTimeoutMs: 180_000,
  maxConcurrency: 3,
};

export const FAST_AGENT_CONFIG: ResearchAgentConfig = {
  maxSteps: Infinity, // No artificial step limit - fast mode is capped by task count
  maxIterations: 1,
  qualityThreshold: 0.6,
  stepTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
  maxConcurrency: 3,
  skipValidation: true,
};

export const ADVANCED_AGENT_CONFIG: ResearchAgentConfig = {
  maxSteps: Infinity, // No artificial step limit - let the model decide
  maxIterations: 2,
  qualityThreshold: 0.75,
  stepTimeoutMs: 30_000,
  totalTimeoutMs: 480_000, // 480s - leaves 120s buffer within Cloud Run's 600s limit
  maxConcurrency: 3,
};

export function getConfigForMode(mode: ResearchMode): ResearchAgentConfig {
  return mode === "fast" ? FAST_AGENT_CONFIG : ADVANCED_AGENT_CONFIG;
}

// ─── Pub/Sub Message ────────────────────────────────────────

export interface ResearchJobMessage {
  jobId: string;
  userId: string;
  sessionId: string;
  query: string;
  skill?: string;
  symbols?: string[];
  mode?: ResearchMode;
  /**
   * MONEY-222 - when the chat surface resolved the user's "Custom" research
   * style, these are the skill IDs they pre-selected. The planner uses them
   * to override its default per-mode plan.
   */
  customSkills?: string[];
  /**
   * MONEY-222 - free-text "always focus on" preference (e.g. "margin
   * expansion, India-listed names only"). Forwarded into the synthesizer
   * prompt so reports lean toward the user's recurring lens.
   */
  researchFocus?: string;
  /**
   * MONEY-219 - the research-type preset the user picked
   * (`quick-pulse` | `investment-thesis` | …). Threaded into
   * `applyResearchPreferences` so it lands on `plan.preset`, which the
   * worker's billing reconciliation reads off the persisted plan
   * (`workers/src/processors/research.ts` → `planObj.preset`).
   */
  preset?: string;
  /**
   * MONEY-587 (task #36) - the user-chosen Gemini model registry ID
   * (e.g. "gemini-3.1-pro-preview" / "gemini-2.5-pro"). Threaded from the
   * run_research publisher through to the synthesizer + validator so a
   * paid user who picked (and paid the credit premium for) a bigger Pro
   * model actually gets it for synthesis + validation. Omitted / unknown
   * / env-gated 3.x IDs safely fall back to the advanced config
   * (gemini-2.5-pro) inside the tools.
   */
  model?: string;
  /**
   * MONEY-396 (Document Vault) - user-uploaded document ids pinned to this
   * research run. `agent.run` retrieves the embedded chunks of these docs
   * (strictly scoped to this `userId` via `retrieveUserDocumentContext`) and
   * stamps the fenced evidence onto every synthesis task's params as
   * `pinnedEvidence`, so the synthesizer can cite the user's own documents.
   * Treated as UNTRUSTED data (fenced, never executed). Unset → unchanged run.
   */
  pinnedUserDocumentIds?: string[];
  /**
   * MONEY-794 (C1c) - institutional run-parameters. All optional; unset →
   * today's plan/report unchanged. `agent.run` stamps these onto the
   * relevant task params after `applyResearchPreferences`:
   *   - `horizon` → every `fetch_price_history` task's `params.period`
   *     (skills hardcode "1y"; the tool accepts 1m–5y) + a synthesizer
   *     "frame over a {horizon} horizon" directive.
   *   - `benchmark` → mapped to an index symbol (NIFTY50→^NSEI, SENSEX→^BSESN,
   *     NIFTY500→^CRSLDX, or a sector name) and stamped onto benchmark-fetch +
   *     beta-computing task params.
   *   - `assumptions` → compute_dcf / compute_wacc / compute_scenario_analysis
   *     params (wacc / terminalGrowth / growthOverride overrides).
   *   - `reportLength` → synthesizer section-depth/length guidance.
   *   - `varConfig` → compute_var / compute_position_var params
   *     (confidence 95|99, horizonDays 1|10).
   */
  horizon?: "1y" | "3y" | "5y";
  benchmark?: string;
  assumptions?: {
    wacc?: number;
    terminalGrowth?: number;
    growthOverride?: number;
  };
  reportLength?: "brief" | "standard" | "full";
  varConfig?: {
    confidence?: 95 | 99;
    horizonDays?: 1 | 10;
  };
}

// ─── NSE Types ──────────────────────────────────────────────

export interface NsePeerData {
  symbol: string;
  companyName: string;
  pe: number;
  pb: number;
  marketCap: number;
  sectorPe?: number;
}

export interface NseCorporateAction {
  symbol: string;
  exDate: string;
  purpose: string;
  details?: string;
}

// ─── Financial Data ─────────────────────────────────────────

export interface CompanyProfile {
  symbol: string;
  name: string;
  sector: string;
  industry: string;
  description: string;
  website?: string;
  employees?: number;
  marketCap?: number;
}

export interface FinancialStatement {
  period: string;
  endDate: string;
  /**
   * Whose accounts these figures are — MONEY-1300.
   *
   * ALWAYS present on a statement this repo produces, and never inferred: an
   * Indian company files the same period twice (CONSOLIDATED = parent +
   * subsidiaries, STANDALONE = parent alone) and for a holding company the two
   * differ by a MULTIPLE — 360ONE FY2025 `totalAssets` is 19,768 Cr against
   * 7,332 Cr. `StockFinancials` stores ONE row per period, so without this the
   * number is correct but unattributable.
   *
   * `"UNKNOWN"` is a real answer and covers three inputs that a reader must not
   * distinguish: a vendor row stamped UNKNOWN, a row whose `basis` attribute is
   * ABSENT (the ~32,359 pre-projection rows), and a source that does not report
   * one at all — Yahoo's `quoteSummary` and the Screener chain both say nothing
   * about basis, so their rows are UNKNOWN rather than assumed consolidated.
   *
   * Optional on the interface only because rows deserialised from an older
   * cache predate the field; every producer in this repo sets it.
   */
  basis?: StockFinancialsBasis;
  revenue?: number;
  costOfRevenue?: number;
  grossProfit?: number;
  operatingIncome?: number;
  netIncome?: number;
  ebitda?: number;
  totalAssets?: number;
  totalLiabilities?: number;
  totalEquity?: number;
  totalDebt?: number;
  totalCash?: number;
  // Balance-sheet detail (MONEY-613) — Yahoo provides these, but the fetch tool
  // historically dropped them, starving working-capital / Altman / Piotroski.
  currentAssets?: number;
  currentLiabilities?: number;
  inventory?: number;
  receivables?: number;
  payables?: number;
  retainedEarnings?: number;
  propertyPlantEquipment?: number;
  sga?: number; // selling, general & administrative (income statement)
  depreciation?: number; // depreciation & amortization (cash flow)
  operatingCashFlow?: number;
  capitalExpenditure?: number;
  freeCashFlow?: number;
}

export interface KeyRatios {
  pe?: number;
  pb?: number;
  evToEbitda?: number;
  roe?: number;
  roa?: number;
  debtToEquity?: number;
  currentRatio?: number;
  dividendYield?: number;
  beta?: number;
  operatingMargin?: number;
  netMargin?: number;
  revenueGrowth?: number;
  earningsGrowth?: number;
}

export interface EarningsData {
  earningsDate?: string;
  epsEstimate?: number;
  epsActual?: number;
  surprisePercent?: number;
  revenueEstimate?: number;
  revenueActual?: number;
}

export interface AnalystRecommendation {
  period: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

// ─── Computation Results ────────────────────────────────────

export interface DcfResult {
  intrinsicValue: number;
  currentPrice: number;
  marginOfSafety: number;
  upside: number;
  assumptions: {
    fcf: number;
    growthRate: number;
    terminalGrowthRate: number;
    discountRate: number;
    projectionYears: number;
  };
  projections: Array<{
    year: number;
    fcf: number;
    discountedFcf: number;
  }>;
}

export interface HealthScore {
  overall: number; // 0-100
  profitability: number;
  leverage: number;
  liquidity: number;
  efficiency: number;
  growth: number;
  details: Record<
    string,
    { score: number; metric: string; value: number; benchmark: number }
  >;
}

export interface GrowthMetrics {
  revenueCAGR: number;
  profitCAGR: number;
  epsCAGR: number;
  marginTrend: "improving" | "stable" | "declining";
  growthConsistency: number; // 0-1
  details: Array<{
    period: string;
    revenue?: number;
    netIncome?: number;
    eps?: number;
    operatingMargin?: number;
  }>;
}

export interface ComparativeValuation {
  symbol: string;
  currentPrice: number;
  peers: Array<{
    symbol: string;
    name: string;
    pe?: number;
    pb?: number;
    evToEbitda?: number;
    roe?: number;
    marketCap?: number;
  }>;
  relativeValuation: {
    peRelative: number; // vs peer avg
    pbRelative: number;
    evEbitdaRelative: number;
    verdict: "undervalued" | "fairly_valued" | "overvalued";
  };
}

// ─── News ───────────────────────────────────────────────────

export interface NewsArticle {
  title: string;
  link: string;
  pubDate: string;
  source?: string;
  snippet?: string;
}

// ─── Portfolio Risk Results ─────────────────────────────────

export interface ConcentrationResult {
  hhi: number; // Herfindahl-Hirschman Index (0-10000)
  level: "low" | "moderate" | "high"; // <1500 low, 1500-2500 moderate, >2500 high
  topHoldings: Array<{
    symbol: string;
    weight: number; // 0-1
    value: number;
  }>;
  sectorWeights: Array<{
    sector: string;
    weight: number;
    count: number;
  }>;
  warnings: string[]; // e.g., "RELIANCE >20% of portfolio"
}

export interface CorrelationMatrixResult {
  symbols: string[];
  matrix: number[][]; // NxN Pearson correlation
  avgCorrelation: number;
  diversificationScore: number; // 100 × (1 - avg|corr|)
  highCorrelationPairs: Array<{
    symbol1: string;
    symbol2: string;
    correlation: number;
  }>;
}

export interface VaRResult {
  historical: {
    var95: number; // 95% VaR (negative %)
    var99: number; // 99% VaR
    cvar95: number; // Conditional VaR / Expected Shortfall
  };
  parametric: {
    var95: number;
    var99: number;
    mean: number;
    stdDev: number;
  };
  portfolioValue: number;
  var95Amount: number; // INR amount at risk
  period: string; // "1-day" or "10-day"
}

export interface DrawdownResult {
  maxDrawdown: number; // Negative percentage
  maxDrawdownStart: string; // ISO date
  maxDrawdownEnd: string;
  recoveryDays: number | null; // null if not recovered
  currentDrawdown: number;
  underwaterPeriods: Array<{
    start: string;
    end: string;
    depth: number;
    durationDays: number;
  }>;
}

export interface RiskAdjustedReturnsResult {
  annualizedReturn: number;
  annualizedVolatility: number;
  sharpeRatio: number; // (R - Rf) / σ
  sortinoRatio: number; // (R - Rf) / σ_downside
  calmarRatio: number; // R / maxDD
  riskFreeRate: number; // Currently 6.5% RBI repo
  maxDrawdown: number;
  downsideDeviation: number;
  informationRatio?: number;
}

export interface RebalancingResult {
  holdings: Array<{
    symbol: string;
    currentWeight: number;
    targetWeight: number;
    drift: number; // current - target
    action: "buy" | "sell" | "hold";
    amount: number; // INR to buy/sell
  }>;
  totalDrift: number; // Sum of |drift|
  needsRebalancing: boolean; // any |drift| > 5%
  driftThreshold: number;
}

// ─── Tax India Results ──────────────────────────────────────

export interface CapitalGainsTaxResult {
  fy: string; // "2025-26"
  equity: {
    stcg: { gains: number; losses: number; net: number; tax: number }; // s111A @20%
    ltcg: {
      gains: number;
      losses: number;
      net: number;
      exemption: number;
      taxable: number;
      tax: number;
    }; // s112A @12.5% above 1.25L
  };
  fno: {
    profits: number;
    losses: number;
    net: number;
    note: string; // "Business income - consult CA"
  };
  totalTax: number;
  effectiveRate: number;
  trades: Array<{
    symbol: string;
    buyDate: string;
    sellDate: string;
    holdingDays: number;
    buyValue: number;
    sellValue: number;
    gain: number;
    type: "STCG" | "LTCG" | "F&O";
  }>;
}

export interface TaxHarvestingResult {
  opportunities: Array<{
    symbol: string;
    currentValue: number;
    costBasis: number;
    unrealizedLoss: number;
    potentialTaxSaving: number;
    holdingDays: number;
    type: "STCG" | "LTCG";
  }>;
  totalPotentialSaving: number;
  gaarWarning: string;
}

export interface AdvanceTaxResult {
  totalEstimatedTax: number;
  isApplicable: boolean; // true if >10K
  installments: Array<{
    quarter: string; // "Q1 (Jun 15)", "Q2 (Sep 15)", etc.
    dueDate: string;
    cumulativePercent: number; // 15, 45, 75, 100
    amount: number;
    paid?: number;
    shortfall?: number;
  }>;
  interestU234C: number; // Interest on late payment
}

export interface ITRScheduleResult {
  scheduleCG: {
    s111A: { description: string; stcgGains: number; stcgTax: number };
    s112A: {
      description: string;
      ltcgGains: number;
      exemption: number;
      taxable: number;
      ltcgTax: number;
    };
  };
  csvData: string; // Ready-to-download CSV
  summary: string; // Human-readable summary
}

// ─── Enhanced Analysis Results ──────────────────────────────

export interface CashFlowQualityResult {
  cfToNetIncome: number; // Operating CF / Net Income (>1 = quality)
  capexIntensity: number; // CapEx / Revenue
  fcfYield: number; // FCF / Market Cap
  cashConversion: number; // FCF / Operating CF
  operatingCFTrend: "improving" | "stable" | "declining";
  qualityScore: number; // 0-100
  flags: string[]; // e.g., "Earnings outpacing cash flow - possible manipulation"
}

export interface EarningsQualityResult {
  accrualRatio: number; // (Net Income - Operating CF) / Total Assets
  recurringPercent: number; // Recurring income / Total income
  taxRateConsistency: number; // Std dev of effective tax rates
  revenueQuality: "high" | "moderate" | "low";
  qualityScore: number; // 0-100
  flags: string[];
}

export interface WACCResult {
  wacc: number; // Weighted average cost of capital
  costOfEquity: number; // CAPM: Rf + β(Rm - Rf)
  costOfDebt: number; // Interest expense / Total debt × (1-t)
  beta: number;
  riskFreeRate: number; // 10Y G-Sec: 7.2%
  marketReturn: number; // Nifty long-term: 12%
  equityWeight: number;
  debtWeight: number;
  taxRate: number;
}

export interface TechnicalAnalysisResult {
  sma: { sma20: number; sma50: number; sma200: number };
  rsi14: number;
  macd: {
    macdLine: number;
    signalLine: number;
    histogram: number;
    signal: "bullish" | "bearish" | "neutral";
  };
  bollingerBands: { upper: number; middle: number; lower: number };
  support: number;
  resistance: number;
  trend: "bullish" | "bearish" | "sideways";
  signals: string[]; // e.g., "Golden cross - SMA50 above SMA200"
}

export interface ShareholdingResult {
  promoter: { current: number; previous: number; change: number };
  fii: { current: number; previous: number; change: number };
  dii: { current: number; previous: number; change: number };
  public: { current: number; previous: number; change: number };
  pledgedPercent: number;
  quarters: Array<{
    quarter: string;
    promoter: number;
    fii: number;
    dii: number;
    public: number;
  }>;
  signals: string[]; // e.g., "FII increasing stake - institutional conviction"
}

export interface DividendAnalysisResult {
  currentYield: number;
  payoutRatio: number;
  fcfCoverage: number; // FCF / Dividends paid
  dividendCAGR5Y: number;
  sustainabilityScore: number; // 0-100
  history: Array<{
    year: string;
    dividend: number;
    yield: number;
  }>;
  verdict: "safe" | "moderate" | "at_risk";
}

export interface ScenarioAnalysisResult {
  bull: { intrinsicValue: number; upside: number; probability: number };
  base: { intrinsicValue: number; upside: number; probability: number };
  bear: { intrinsicValue: number; upside: number; probability: number };
  currentPrice: number;
  sensitivityMatrix: Array<{
    growthRate: number;
    discountRates: Array<{ rate: number; value: number }>;
  }>;
  expectedValue: number; // Probability-weighted intrinsic value
}
