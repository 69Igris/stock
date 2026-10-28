/**
 * Data Sources - Barrel Exports
 */

export { NseClient, getNseClient } from "./nse-client";
export type {
  NsePeerComparisonResponse,
  NseCorporateActionResponse,
  NseQuoteResponse,
} from "./nse-types";
export { fetchNews } from "./news-client";
// MONEY-980 — `resolveSymbolFromDb` was re-exported here and imported nowhere.
// A barrel re-export is not a caller: it is what made a zero-caller function
// look load-bearing. Deleted with the function.
export {
  resolveSymbol,
  toNseSymbol,
  extractSymbolsFromQuery,
} from "./symbol-resolver";

// Tickertape
export {
  resolveTickertapeSid,
  fetchTickertapeFinancials,
  fetchTickertapePeers,
  screenStocksTickertape,
  fetchTickertapeQuote,
  fetchTickertapeStockRatios,
  fetchTickertapeShareholding,
  fetchTickertapeQuarterlyResults,
} from "./tickertape-client";
export type {
  TickertapeFinancials,
  TickertapeFinancialRow,
  TickertapePeer,
  ScreenerFilter,
  ScreenerResult,
  TickertapeQuote,
  TickertapeStockRatios,
  TickertapeShareholding,
  TickertapeQuarterlyResult,
} from "./tickertape-client";

// Screener.in
export {
  // `searchScreener` removed — MONEY-1255, robots.txt `Disallow: /*?q=`.
  fetchScreenerFinancials,
  fetchScreenerQuarterlyResults,
  fetchScreenerShareholding,
  fetchScreenerPeers,
} from "./screener-client";
export type {
  ScreenerFinancialData,
  ScreenerQuarterlyResult,
  ScreenerShareholding,
  ScreenerPeer,
} from "./screener-client";

// Cache
export { cacheGet, cacheSet, cacheWrap } from "./cache";

// Data Source Chain
export {
  fetchFinancialsChain,
  fetchPeersChain,
  screenStocksChain,
  fetchQuoteChain,
  fetchQuarterlyResultsChain,
  fetchShareholdingChain,
  fetchPeersWithScreenerFallback,
} from "./data-source-chain";

// DB-First Data Access Layer
export {
  getOrFetchFinancials,
  getOrFetchRatios,
  getOrFetchPeers,
  getOrFetchNews,
  getOrFetchProfile,
  getOrFetchShareholding,
  trackAnalysis,
} from "./db-store";

// NSE Filings
export {
  fetchNSEAnnouncements,
  fetchNSEFinancialResults,
  fetchNSECorporateActions,
  fetchAnnualReports,
} from "./nse-filings";

// Chartink
export { runChartinkScan, CHARTINK_PREBUILT_SCANS } from "./chartink-client";
export type { ChartinkResult } from "./chartink-client";
export {
  CHARTINK_SCAN_LIBRARY,
  getScanById,
  listScans,
  searchScans,
  listCategories,
} from "./chartink-scans";
export type { ChartinkScanDef, ChartinkScanCategory } from "./chartink-scans";

// Tickertape MF
export {
  resolveTickertapeMfSid,
  fetchTickertapeMfOverview,
  fetchTickertapeMfHoldings,
  fetchTickertapeMfPeers,
} from "./tickertape-mf-client";

// RBI Macro Data
export {
  fetchRepoRate,
  fetchInflationCPI,
  fetchGDPGrowth,
  fetchForexReserves,
  fetchMacroSnapshot,
} from "./rbi-client";
export type {
  MacroSnapshot,
  MacroIndicator,
  MacroIndicatorWithQuarter,
  MacroIndicatorWithUnit,
} from "./rbi-client";

// NSE FII/DII Flows
export { fetchFIIDIIFlows } from "./nse-fii-dii";
export type { FIIDIIFlow, FIIDIISummary } from "./nse-fii-dii";

// YouTube transcript scraper (MONEY-785, P4) — dependency-free caption ingest.
export { parseVideoId, fetchYoutubeTranscript } from "./youtube-transcript";
export type { YoutubeTranscript } from "./youtube-transcript";
