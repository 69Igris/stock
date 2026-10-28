/**
 * @usemoney/research - StockSage Autonomous Research Agent
 *
 * Barrel exports for the research package.
 */

// Core agent
export { ResearchAgent } from "./agent";

// Components
export { ResearchPlanner } from "./planner";
export { ResearchExecutor } from "./executor";
export { Scratchpad } from "./scratchpad";
export { ResearchValidator } from "./validator";
export { LoopController } from "./loop-controller";

// MONEY-587 / MONEY-619 - resolve a user-chosen model id into a Vertex model
// (safe fallback to the advanced config). Used by the L3/comparison workers
// for the executive-summary / synthesis Gemini call.
export { getResearchModel } from "./model-selection";

// MONEY-222 - preferences plumbing
export {
  applyResearchPreferences,
  augmentPlanWithSkills,
  type ResearchPreferenceHints,
} from "./apply-preferences";
export {
  SKILL_TOOL_ALLOWLIST,
  ALWAYS_KEEP_TOOLS,
  buildAllowedToolSet,
  type ResearchSkillId as ResearchSkillIdLocal,
} from "./skills/skill-tool-map";

// Tools
export { ResearchToolRegistry } from "./tools/registry";

// Skills
export { getSkill, getAllSkills, matchSkill } from "./skills/index";

// Strategies
export {
  BUILTIN_STRATEGIES,
  getStrategyById,
  getStrategiesByCategory,
  searchStrategies,
  getStrategyCategories,
  executeStrategy,
  type BuiltInStrategy,
  type StrategyFilter,
  type StrategyCategory,
  type StrategyExecutionResult,
  type StrategyMatchedStock,
  type CustomStrategyInput,
} from "./strategies/index";

// Investment Themes
export {
  INVESTMENT_THEMES,
  getAllThemes,
  getThemeById,
  searchThemes,
  getThemesByTimeframe,
  type InvestmentTheme,
  type ThemeStock,
} from "./strategies/index";

// Shared indicator library
export {
  sma,
  ema,
  computeRSI,
  computeMACD,
  computeBollingerBands,
  computeStochastic,
  computeATR,
  computeADX,
  computeSupertrend,
  computeCCI,
  computeMFI,
  computeWilliamsR,
  computeROC,
  computePSAR,
  computeIchimoku,
  computeBeta,
  detectNarrowRange,
  evaluateRule,
  type StrategyRule,
  type StrategyDefinition,
  type SignalResult,
} from "./lib/indicators";

// Chart pattern detection
export {
  detectChartPatterns,
  findPeaksAndTroughs,
  type ChartPattern,
} from "./lib/chart-patterns";

// Data sources
export { NseClient } from "./data-sources/nse-client";
export { fetchNews } from "./data-sources/news-client";
// MONEY-610: stock-detail shareholding + corporate actions for the web app
export {
  fetchShareholdingChain,
  // MONEY-1146: the outcome-aware variant, so a caller can tell "no coverage"
  // from "every source threw" instead of rendering one empty panel for both.
  fetchShareholdingChainDetailed,
} from "./data-sources/data-source-chain";
export type { ChainOutcome } from "./data-sources/data-source-chain";
export {
  fetchNSECorporateActions,
  type NSECorporateAction,
} from "./data-sources/nse-filings";
export {
  resolveSymbol,
  extractSymbolsFromQuery,
} from "./data-sources/symbol-resolver";

// Types
export type {
  ResearchTask,
  ResearchPlan,
  ScratchpadEntry,
  ScratchpadEntryType,
  ToolOutput,
  ResearchToolDef,
  ResearchSkill,
  ValidationResult,
  ResearchStatus,
  ResearchSessionState,
  ResearchAgentConfig,
  ResearchJobMessage,
  ResearchMode,
  CompanyProfile,
  FinancialStatement,
  KeyRatios,
  EarningsData,
  AnalystRecommendation,
  DcfResult,
  HealthScore,
  GrowthMetrics,
  ComparativeValuation,
  NewsArticle,
  NsePeerData,
  NseCorporateAction,
  // Risk types
  ConcentrationResult,
  CorrelationMatrixResult,
  VaRResult,
  DrawdownResult,
  RiskAdjustedReturnsResult,
  RebalancingResult,
  // Tax types
  CapitalGainsTaxResult,
  TaxHarvestingResult,
  AdvanceTaxResult,
  ITRScheduleResult,
  // Enhanced analysis types
  CashFlowQualityResult,
  EarningsQualityResult,
  WACCResult,
  TechnicalAnalysisResult,
  ShareholdingResult,
  DividendAnalysisResult,
  ScenarioAnalysisResult,
} from "./types";

export {
  DEFAULT_AGENT_CONFIG,
  FAST_AGENT_CONFIG,
  ADVANCED_AGENT_CONFIG,
  getConfigForMode,
} from "./types";
