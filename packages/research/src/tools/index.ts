/**
 * Research Tools - Barrel Exports
 */

export { ResearchToolRegistry } from "./registry";
export type { ResearchToolDef, ToolOutput } from "./types";

// Data tools
export { fetchCompanyProfileTool } from "./fetch-company-profile";
export { fetchIncomeStatementTool } from "./fetch-income-statement";
export { fetchBalanceSheetTool } from "./fetch-balance-sheet";
export { fetchCashFlowTool } from "./fetch-cash-flow";
export { fetchKeyRatiosTool } from "./fetch-key-ratios";
export { fetchEarningsTool } from "./fetch-earnings";
export { fetchAnalystRecommendationsTool } from "./fetch-analyst-recommendations";
export { fetchStockPriceTool } from "./fetch-stock-price";
export { fetchPriceHistoryTool } from "./fetch-price-history";
export { fetchPeerCompaniesTool } from "./fetch-peer-companies";
export { fetchCorporateActionsTool } from "./fetch-corporate-actions";
export { fetchShareholderMeetingsTool } from "./fetch-shareholder-meetings";
export { fetchExchangeAnnouncementsTool } from "./fetch-exchange-announcements";
export { fetchNewsTool } from "./fetch-news";
export { searchStocksTool } from "./search-stocks";
// MONEY-785 (P4) — YouTube transcript ingestion into the research RAG corpus.
export {
  fetchYoutubeTranscriptTool,
  persistYoutubeTranscript,
  MAX_TRANSCRIPT_CHARS,
} from "./fetch-youtube-transcript";
export type { YoutubeTranscriptResult } from "./fetch-youtube-transcript";
// MONEY-802 (discovery half) — YouTube candidate discovery; feeds the transcript
// fetch a candidate url.
export {
  fetchYoutubeCandidatesTool,
  buildCandidateQuery,
  resolveCompanyLabel,
  MAX_YOUTUBE_CANDIDATES,
} from "./fetch-youtube-candidates";
export type {
  YoutubeCandidate,
  YoutubeCandidatesResult,
  YoutubeCandidateKind,
} from "./fetch-youtube-candidates";

// Computation tools
export { computeDcfTool } from "./compute-dcf";
export { computeHealthScoreTool } from "./compute-health-score";
export { computeGrowthMetricsTool } from "./compute-growth-metrics";
export { computeComparativeValuationTool } from "./compute-comparative-valuation";
export {
  computeComparisonScoresTool,
  computeComparisonScores,
  type ComparisonStockMetrics,
  type ComparisonScoresResult,
  type PerStockBreakdown,
} from "./compute-comparison-scores";
export { screenStocksTool } from "./screen-stocks";

// Risk tools
export { computePortfolioConcentrationTool } from "./compute-portfolio-concentration";
export { computeCorrelationMatrixTool } from "./compute-correlation-matrix";
export { computeVarTool } from "./compute-var";
export { computeDrawdownTool } from "./compute-drawdown";
export { computeRiskAdjustedReturnsTool } from "./compute-risk-adjusted-returns";
export { computeBetaTool, type BetaResult } from "./compute-beta";
export { computeRebalancingTool } from "./compute-rebalancing";

// Tax tools
export { computeCapitalGainsTaxTool } from "./compute-capital-gains-tax";
export { computeTaxHarvestingTool } from "./compute-tax-harvesting";
export { computeAdvanceTaxTool } from "./compute-advance-tax";
export { generateItrScheduleTool } from "./generate-itr-schedule";

// Enhanced analysis tools
export { computeCashFlowQualityTool } from "./compute-cash-flow-quality";
export { computeEarningsQualityTool } from "./compute-earnings-quality";
export { computeWaccTool } from "./compute-wacc";
export { computeTechnicalAnalysisTool } from "./compute-technical-analysis";
export { fetchShareholdingPatternTool } from "./fetch-shareholding-pattern";
export { computeDividendAnalysisTool } from "./compute-dividend-analysis";
export { computeScenarioAnalysisTool } from "./compute-scenario-analysis";

// Data source expansion tools
export { fetchQuarterlyResultsTool } from "./fetch-quarterly-results";
export { fetchScreenerRatiosTool } from "./fetch-screener-ratios";

// Chartink & Backtest tools
export { runChartinkScanTool } from "./run-chartink-scan";
export { backtestStrategyTool } from "./backtest-strategy";

// Global fund tools
export { fetchGlobalFundTool } from "./fetch-global-fund";
export { compareGlobalFundsTool } from "./compare-global-funds";

// Candlestick pattern detection
export { detectCandlestickPatternsTool } from "./detect-candlestick-patterns";

// Chart pattern detection
export { detectChartPatternsTool } from "./detect-chart-patterns";

// Phase 9 - Fundamental Deep Dive v2 tools
export { computeRevenueMixTool } from "./compute-revenue-mix";
export { computeRelativeValuationTool } from "./compute-relative-valuation";
export { computeValuationBandsTool } from "./compute-valuation-bands";
export { computeSectorAggregatesTool } from "./compute-sector-aggregates";
export { computeCommodityCorrelationTool } from "./compute-commodity-correlation";
export { computeEarningsEstimatesTool } from "./compute-earnings-estimates";
export { computeDdmTool } from "./compute-ddm";

// Phase 9C - Investment themes
export { evaluateThemeTool } from "./evaluate-theme";

// Phase 10 - Macro economics tools
export { fetchFiiDiiFlowsTool } from "./fetch-fii-dii-flows";
export { fetchMacroDashboardTool } from "./fetch-macro-dashboard";
export { computeMacroImpactTool } from "./compute-macro-impact";

// Phase 11 - Forward scenario & strategy fit tools
export { computeForwardScenariosTool } from "./compute-forward-scenarios";
export { computeStrategyFitTool } from "./compute-strategy-fit";

// Synthesis tools
export { synthesizeReportTool } from "./synthesize-report";
export { generateSummaryTool } from "./generate-summary";
export { compareStocksTool } from "./compare-stocks";

// MONEY-1204 (P14 / 14e.2) - market-structure tools over the data-engine
// tables. Every one returns `{ rows, asOf, provenance }` so the agent can cite
// it, and every one degrades to an empty CITED result rather than throwing.
export { fetchStockFlagsTool } from "./fetch-stock-flags";
export { fetchPositioningTool, POSITIONING_METRICS } from "./fetch-positioning";
export { fetchFundsHoldingTool } from "./fetch-funds-holding";
export { fetchBondQuotesTool } from "./fetch-bond-quotes";
export { fetchVixTool, VIX_NOT_REPORTED } from "./fetch-vix";

// MONEY-979 (T10) - US fundamentals (SEC EDGAR), DB-only. US symbols ONLY.
export {
  fetchUsFinancialsTool,
  buildUsFinancialsOutput,
  normalizeUsStatementType,
  explainUsGap,
  usToolMetadata,
  US_TOOL_SOURCE,
  US_GAP_EXPLANATIONS,
  US_FIELDS_NOT_FILED,
  type UsToolResult,
} from "./fetch-us-financials";
export {
  fetchUsInsiderTradesTool,
  buildUsInsiderOutput,
  US_INSIDER_CODE_LEGEND,
} from "./fetch-us-insider-trades";
export {
  fetchUs13fHoldersTool,
  buildUs13fOutput,
  partitionHolders,
  type UsHolderDeltaLike,
} from "./fetch-us-13f-holders";
export {
  fetchUsFilingsTool,
  buildUsFilingsOutput,
  resolveUsForms,
  US_FORM_PRESETS,
} from "./fetch-us-filings";
// MONEY-1597 (C5b) - the lake's gold layer through allow-listed templates.
export { queryLakeTool, runQueryLake } from "./query-lake";
export {
  LAKE_TEMPLATES,
  UNIVERSE_METRICS,
  type LakeTemplate,
} from "./lake/templates";
