/**
 * Research Tool Registry
 *
 * Central registry of all available research tools.
 */

import type { ResearchToolDef, ToolOutput } from "./types";

// Data tools
import { fetchCompanyProfileTool } from "./fetch-company-profile";
import { fetchIncomeStatementTool } from "./fetch-income-statement";
import { fetchBalanceSheetTool } from "./fetch-balance-sheet";
import { fetchCashFlowTool } from "./fetch-cash-flow";
import { fetchKeyRatiosTool } from "./fetch-key-ratios";
import { fetchEarningsTool } from "./fetch-earnings";
import { fetchAnalystRecommendationsTool } from "./fetch-analyst-recommendations";
import { fetchStockPriceTool } from "./fetch-stock-price";
import { fetchPriceHistoryTool } from "./fetch-price-history";
import { fetchPeerCompaniesTool } from "./fetch-peer-companies";
import { fetchCorporateActionsTool } from "./fetch-corporate-actions";
import { fetchShareholderMeetingsTool } from "./fetch-shareholder-meetings";
import { fetchExchangeAnnouncementsTool } from "./fetch-exchange-announcements";
import { fetchNewsTool } from "./fetch-news";
import { searchStocksTool } from "./search-stocks";
// MONEY-785 (P4) — YouTube transcript ingestion into the research RAG corpus.
import { fetchYoutubeTranscriptTool } from "./fetch-youtube-transcript";
// MONEY-802 (discovery half) — best-effort YouTube video discovery; feeds the
// transcript fetch a candidate url (no API key, brittle, never throws).
import { fetchYoutubeCandidatesTool } from "./fetch-youtube-candidates";

// Computation tools
import { computeDcfTool } from "./compute-dcf";
import { computeHealthScoreTool } from "./compute-health-score";
import { computeGrowthMetricsTool } from "./compute-growth-metrics";
import { computeComparativeValuationTool } from "./compute-comparative-valuation";
import { screenStocksTool } from "./screen-stocks";

// Risk tools
import { computePortfolioConcentrationTool } from "./compute-portfolio-concentration";
import { computeCorrelationMatrixTool } from "./compute-correlation-matrix";
import { computeVarTool } from "./compute-var";
import { computeDrawdownTool } from "./compute-drawdown";
import { computeBetaTool } from "./compute-beta";
import { computeRiskAdjustedReturnsTool } from "./compute-risk-adjusted-returns";
import { computeRebalancingTool } from "./compute-rebalancing";

// Tax tools
import { computeCapitalGainsTaxTool } from "./compute-capital-gains-tax";
import { computeTaxHarvestingTool } from "./compute-tax-harvesting";
import { computeAdvanceTaxTool } from "./compute-advance-tax";
import { generateItrScheduleTool } from "./generate-itr-schedule";

// Enhanced analysis tools
import { computeCashFlowQualityTool } from "./compute-cash-flow-quality";
import { computeEarningsQualityTool } from "./compute-earnings-quality";
import { computeWaccTool } from "./compute-wacc";
import { computeTechnicalAnalysisTool } from "./compute-technical-analysis";
import { fetchShareholdingPatternTool } from "./fetch-shareholding-pattern";
import { computeDividendAnalysisTool } from "./compute-dividend-analysis";
import { computeScenarioAnalysisTool } from "./compute-scenario-analysis";

// L2 analysis tools
import { computeAccountingQualityTool } from "./compute-accounting-quality";
import { computeEarningsSurpriseTool } from "./compute-earnings-surprise";

// Data source tools
import { fetchTickertapeFinancialsTool } from "./fetch-tickertape-financials";
import { screenStocksAdvancedTool } from "./screen-stocks-advanced";
import { fetchQuarterlyResultsTool } from "./fetch-quarterly-results";
import { fetchScreenerRatiosTool } from "./fetch-screener-ratios";

// L3 scoring tools
import { computeInvestmentScoreTool } from "./compute-investment-score";
import { computeComparisonScoresTool } from "./compute-comparison-scores";

// Phase 7 tools
import { fetchEarningsCalendarTool } from "./fetch-earnings-calendar";
import { fetchBulkBlockDealsTool } from "./fetch-bulk-block-deals";
import { fetchPromoterPledgingTool } from "./fetch-promoter-pledging";
import { computePortfolioDeltaTool } from "./compute-portfolio-delta";

// MF tools
import { fetchMfOverviewTool } from "./fetch-mf-overview";
import { fetchMfHoldingsTool } from "./fetch-mf-holdings";
import { fetchMfPeersTool } from "./fetch-mf-peers";
import { computeMfAnalysisTool } from "./compute-mf-analysis";

// Global fund tools
import { fetchGlobalFundTool } from "./fetch-global-fund";
import { compareGlobalFundsTool } from "./compare-global-funds";

// Strategy tools
import { evaluateStrategyTool } from "./evaluate-strategy";
import { scanStrategyMultiTool } from "./scan-strategy-multi";

// Chartink & Backtest tools
import { runChartinkScanTool } from "./run-chartink-scan";
import { backtestStrategyTool } from "./backtest-strategy";

// Custom strategy tool
import { runCustomStrategyTool } from "./run-custom-strategy";

// Candlestick pattern detection
import { detectCandlestickPatternsTool } from "./detect-candlestick-patterns";

// Chart pattern detection
import { detectChartPatternsTool } from "./detect-chart-patterns";

// RAG / Document tools
import { fetchUserDocumentsTool } from "./fetch-user-documents";
import { fetchDocumentContextTool } from "./fetch-document-context";

// Phase 9 - Fundamental Deep Dive v2 tools
import { computeRevenueMixTool } from "./compute-revenue-mix";
import { computeRelativeValuationTool } from "./compute-relative-valuation";
import { computeValuationBandsTool } from "./compute-valuation-bands";
import { computeSectorAggregatesTool } from "./compute-sector-aggregates";
import { computeCommodityCorrelationTool } from "./compute-commodity-correlation";
import { computeEarningsEstimatesTool } from "./compute-earnings-estimates";
import { computeDdmTool } from "./compute-ddm";

// Phase 9C - Investment themes
import { evaluateThemeTool } from "./evaluate-theme";

// Phase 10 - Macro tools
import { fetchFiiDiiFlowsTool } from "./fetch-fii-dii-flows";
import { fetchMacroDashboardTool } from "./fetch-macro-dashboard";
import { computeMacroImpactTool } from "./compute-macro-impact";

// Phase 11 - Forward analysis
import { computeForwardScenariosTool } from "./compute-forward-scenarios";
import { computeStrategyFitTool } from "./compute-strategy-fit";

// Synthesis tools
import { synthesizeReportTool } from "./synthesize-report";
import { generateSummaryTool } from "./generate-summary";
import { compareStocksTool } from "./compare-stocks";

// MONEY-498 - institutional research parameter expansion (26 tools across 4
// clusters). Powers the 16 v2 institutional skills; the skill-tool-map
// allowlists reference these names, so registering them here is what makes a
// "comprehensive" research plan surface 40-50 cited params instead of ~17.
import { computeCapexIntensityTool } from "./compute-capex-intensity";
import { computeFcfYieldTool } from "./compute-fcf-yield";
import { computePiotroskiTool } from "./compute-piotroski";
import { computeAltmanZTool } from "./compute-altman-z";
import { computeBeneishMTool } from "./compute-beneish-m";
import { computeWorkingCapitalDragTool } from "./compute-working-capital-drag";
import { computeGuidanceSensitivityTool } from "./compute-guidance-sensitivity";
import { computeDcfSensitivityTool } from "./compute-dcf-sensitivity";
import { computePayoutCoverageTool } from "./compute-payout-coverage";
import { computeFactorScoresTool } from "./compute-factor-scores";
import { computeFactorZscoreTool } from "./compute-factor-zscore";
import { computeCompositeQuantScoreTool } from "./compute-composite-quant-score";
import { computeVolumeProfileTool } from "./compute-volume-profile";
import { computeTrendStrengthTool } from "./compute-trend-strength";
import { detectBreakoutSetupsTool } from "./detect-breakout-setups";
import { computeVolatilityRegimeTool } from "./compute-volatility-regime";
import { computeDrawdownProfileTool } from "./compute-drawdown-profile";
import { computeBetaDecompositionTool } from "./compute-beta-decomposition";
import { computePositionVarTool } from "./compute-position-var";
import { computeConcentrationDeltaTool } from "./compute-concentration-delta";
import { computePortfolioBetaDriftTool } from "./compute-portfolio-beta-drift";
import { computeMonteCarloReturnsTool } from "./compute-monte-carlo-returns";
import { computeRateSensitivityTool } from "./compute-rate-sensitivity";
import { computeSectorRotationTool } from "./compute-sector-rotation";
import { fetchShortInterestTool } from "./fetch-short-interest";
import { computeGovernanceFlagsTool } from "./compute-governance-flags";
import { fetchPromoterHoldingTool } from "./fetch-promoter-holding";
import { fetchRelatedPartyTool } from "./fetch-related-party";
import { computeNewsSentimentTool } from "./compute-news-sentiment";

// MONEY-550 - comparison v2: cross-fund holdings overlap (common/distinct).
import { computeHoldingsOverlapTool } from "./compute-holdings-overlap";

// MONEY-446 Part C - single-fund constituent parameter analysis.
import { computeConstituentAnalysisTool } from "./compute-constituent-analysis";

// MONEY-1204 (P14 / 14e.2) - market-structure tools over the data-engine
// tables. All five are DB-only reads (no scrape, no egress) with `{ rows, asOf,
// provenance }` payloads so the synthesizer can cite them. The three converted
// tools above (fetch_bulk_block_deals, fetch_fii_dii_flows,
// fetch_macro_dashboard) keep their live path as a FALLBACK.
import { fetchStockFlagsTool } from "./fetch-stock-flags";
import { fetchPositioningTool } from "./fetch-positioning";
import { fetchFundsHoldingTool } from "./fetch-funds-holding";
import { fetchBondQuotesTool } from "./fetch-bond-quotes";
import { fetchVixTool } from "./fetch-vix";

// MONEY-979 (T10) - US fundamentals from SEC EDGAR. DB-only reads over the
// `us_*` tables that `services/us-fundamentals/` writes; no sec.gov egress from
// this package. US symbols only: the three India fetch tools are untouched and
// routing them by venue is a follow-up (see the note at the foot of
// fetch-us-financials.ts).
import { fetchUsFinancialsTool } from "./fetch-us-financials";
import { fetchUsInsiderTradesTool } from "./fetch-us-insider-trades";
import { fetchUs13fHoldersTool } from "./fetch-us-13f-holders";
import { fetchUsFilingsTool } from "./fetch-us-filings";
// MONEY-1597 (C5b) - the lake's gold layer, through four allow-listed
// templates. A worker-only tool: it refuses on Vercel and loads BigQuery lazily.
import { queryLakeTool } from "./query-lake";

export class ResearchToolRegistry {
  private tools: Map<string, ResearchToolDef> = new Map();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    // Data tools
    this.register(fetchCompanyProfileTool);
    this.register(fetchIncomeStatementTool);
    this.register(fetchBalanceSheetTool);
    this.register(fetchCashFlowTool);
    this.register(fetchKeyRatiosTool);
    this.register(fetchEarningsTool);
    this.register(fetchAnalystRecommendationsTool);
    this.register(fetchStockPriceTool);
    this.register(fetchPriceHistoryTool);
    this.register(fetchPeerCompaniesTool);
    this.register(fetchCorporateActionsTool);
    this.register(fetchShareholderMeetingsTool);
    this.register(fetchExchangeAnnouncementsTool);
    this.register(fetchNewsTool);
    this.register(searchStocksTool);
    // MONEY-785 (P4) — YouTube transcript ingestion (category "data").
    this.register(fetchYoutubeTranscriptTool);
    // MONEY-802 — YouTube candidate discovery (category "data"). Chains into
    // fetch_youtube_transcript: discovers a url, that tool transcribes it.
    this.register(fetchYoutubeCandidatesTool);

    // Computation tools
    this.register(computeDcfTool);
    this.register(computeHealthScoreTool);
    this.register(computeGrowthMetricsTool);
    this.register(computeComparativeValuationTool);
    this.register(screenStocksTool);

    // Risk tools
    this.register(computePortfolioConcentrationTool);
    this.register(computeCorrelationMatrixTool);
    this.register(computeVarTool);
    this.register(computeDrawdownTool);
    // MONEY-490: referenced by the risk-var-stress allowlist but was never
    // registered — the skill ran without its beta tool (MONEY-650 class).
    this.register(computeBetaTool);
    this.register(computeRiskAdjustedReturnsTool);
    this.register(computeRebalancingTool);

    // Tax tools
    this.register(computeCapitalGainsTaxTool);
    this.register(computeTaxHarvestingTool);
    this.register(computeAdvanceTaxTool);
    this.register(generateItrScheduleTool);

    // Enhanced analysis tools
    this.register(computeCashFlowQualityTool);
    this.register(computeEarningsQualityTool);
    this.register(computeWaccTool);
    this.register(computeTechnicalAnalysisTool);
    this.register(fetchShareholdingPatternTool);
    this.register(computeDividendAnalysisTool);
    this.register(computeScenarioAnalysisTool);

    // L2 analysis tools
    this.register(computeAccountingQualityTool);
    this.register(computeEarningsSurpriseTool);

    // Data source tools
    this.register(fetchTickertapeFinancialsTool);
    this.register(screenStocksAdvancedTool);
    this.register(fetchQuarterlyResultsTool);
    this.register(fetchScreenerRatiosTool);

    // L3 scoring tools
    this.register(computeInvestmentScoreTool);
    this.register(computeComparisonScoresTool);

    // Phase 7 tools
    this.register(fetchEarningsCalendarTool);
    this.register(fetchBulkBlockDealsTool);
    this.register(fetchPromoterPledgingTool);
    this.register(computePortfolioDeltaTool);

    // MF tools
    this.register(fetchMfOverviewTool);
    this.register(fetchMfHoldingsTool);
    this.register(fetchMfPeersTool);
    this.register(computeMfAnalysisTool);

    // Global fund tools
    this.register(fetchGlobalFundTool);
    this.register(compareGlobalFundsTool);

    // Strategy tools
    this.register(evaluateStrategyTool);
    this.register(scanStrategyMultiTool);

    // Chartink & Backtest tools
    this.register(runChartinkScanTool);
    this.register(backtestStrategyTool);

    // Custom strategy tools
    this.register(runCustomStrategyTool);

    // Candlestick pattern detection
    this.register(detectCandlestickPatternsTool);

    // Chart pattern detection
    this.register(detectChartPatternsTool);

    // RAG / Document tools
    this.register(fetchUserDocumentsTool);
    this.register(fetchDocumentContextTool);

    // Phase 9 - Fundamental Deep Dive v2
    this.register(computeRevenueMixTool);
    this.register(computeRelativeValuationTool);
    this.register(computeValuationBandsTool);
    this.register(computeSectorAggregatesTool);
    this.register(computeCommodityCorrelationTool);
    this.register(computeEarningsEstimatesTool);
    this.register(computeDdmTool);
    this.register(evaluateThemeTool);

    // Phase 10 - Macro
    this.register(fetchFiiDiiFlowsTool);
    this.register(fetchMacroDashboardTool);
    this.register(computeMacroImpactTool);

    // Phase 11 - Forward analysis
    this.register(computeForwardScenariosTool);
    this.register(computeStrategyFitTool);

    // Synthesis tools
    this.register(synthesizeReportTool);
    this.register(generateSummaryTool);
    this.register(compareStocksTool);

    // MONEY-498 - institutional expansion: cash-flow & earnings depth
    this.register(computeCapexIntensityTool);
    this.register(computeFcfYieldTool);
    this.register(computePiotroskiTool);
    this.register(computeAltmanZTool);
    this.register(computeBeneishMTool);
    this.register(computeWorkingCapitalDragTool);
    this.register(computeGuidanceSensitivityTool);
    this.register(computeDcfSensitivityTool);
    this.register(computePayoutCoverageTool);
    // MONEY-498 - quant & technical
    this.register(computeFactorScoresTool);
    this.register(computeFactorZscoreTool);
    this.register(computeCompositeQuantScoreTool);
    this.register(computeVolumeProfileTool);
    this.register(computeTrendStrengthTool);
    this.register(detectBreakoutSetupsTool);
    // MONEY-498 - regime & risk
    this.register(computeVolatilityRegimeTool);
    this.register(computeDrawdownProfileTool);
    this.register(computeBetaDecompositionTool);
    this.register(computePositionVarTool);
    this.register(computeConcentrationDeltaTool);
    this.register(computePortfolioBetaDriftTool);
    this.register(computeMonteCarloReturnsTool);
    // MONEY-498 - macro, flows & governance
    this.register(computeRateSensitivityTool);
    this.register(computeSectorRotationTool);
    this.register(fetchShortInterestTool);
    this.register(computeGovernanceFlagsTool);
    this.register(fetchPromoterHoldingTool);
    this.register(fetchRelatedPartyTool);
    this.register(computeNewsSentimentTool);

    // MONEY-550 - comparison v2
    this.register(computeHoldingsOverlapTool);

    // MONEY-446 Part C - single-fund constituent parameter analysis
    this.register(computeConstituentAnalysisTool);

    // MONEY-1204 (P14 / 14e.2) - market structure
    this.register(fetchStockFlagsTool);
    this.register(fetchPositioningTool);
    this.register(fetchFundsHoldingTool);
    this.register(fetchBondQuotesTool);
    this.register(fetchVixTool);

    // MONEY-979 (T10) - US fundamentals (SEC EDGAR). Also allow-listed in
    // skill-tool-map.ts: a tool registered but not listed there is silently
    // excluded from the custom-skill trim.
    this.register(fetchUsFinancialsTool);
    this.register(fetchUsInsiderTradesTool);
    this.register(fetchUs13fHoldersTool);
    this.register(fetchUsFilingsTool);

    // MONEY-1597 (C5b) - cross-sectional facts from lake_gold (event outcomes,
    // rolling stats, universe rankings). Never free-form SQL.
    this.register(queryLakeTool);
  }

  register(tool: ResearchToolDef): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ResearchToolDef | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(
    name: string,
    params: Record<string, unknown>,
  ): Promise<ToolOutput> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { success: false, error: `Unknown tool: ${name}` };
    }
    return tool.execute(params);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  getToolDescriptions(): string[] {
    return Array.from(this.tools.values()).map(
      (t) => `${t.name}: ${t.description} [${t.category}]`,
    );
  }

  getDataTools(): ResearchToolDef[] {
    return Array.from(this.tools.values()).filter((t) => t.category === "data");
  }

  getComputationTools(): ResearchToolDef[] {
    return Array.from(this.tools.values()).filter(
      (t) => t.category === "computation",
    );
  }

  getSynthesisTools(): ResearchToolDef[] {
    return Array.from(this.tools.values()).filter(
      (t) => t.category === "synthesis",
    );
  }
}
