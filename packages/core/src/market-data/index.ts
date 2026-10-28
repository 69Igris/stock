/**
 * Market Data Module
 *
 * Central module for instrument management and price data.
 * Provides:
 * - Instrument sync from broker dumps (Zerodha primary, others via enrichment)
 * - Historical price caching (Yahoo Finance → DailyPrice)
 * - Latest quote caching (Yahoo Finance → LatestQuote)
 */

// Instrument types and interfaces
export type {
  RawInstrument,
  InstrumentProvider,
  InstrumentSyncResult,
  SupportedExchange,
} from "./instruments/types";

export {
  SUPPORTED_EXCHANGES,
  YAHOO_SUFFIX_MAP,
  isUnfetchableYahooSymbol,
} from "./instruments/types";

// Zerodha instrument provider
export {
  ZerodhaInstrumentProvider,
  buildYahooSymbolForInstrument,
} from "./instruments/zerodha-instruments";

// Fund-side instrument types (MONEY-1085 follow-up) — ETF + exchange-traded
// trusts. Query sites must use this rather than hard-coding "ETF".
export {
  FUND_INSTRUMENT_TYPES,
  INDIA_DISCOVER_EXCHANGES,
  TRUST_INSTRUMENT_TYPES,
} from "./instruments/types";
export type { FundInstrumentType } from "./instruments/types";
export {
  classifyTrustInstrument,
  NSE_TRUST_SERIES,
} from "./instruments/zerodha-instruments-logic";

// NSE instrument-master provider (MONEY-1085) — supplies the SME/book-entry
// series and the ISIN column the Zerodha dump omits.
export {
  NseMasterInstrumentProvider,
  NSE_EQUITY_MASTER_URL,
  NSE_SME_MASTER_URL,
} from "./instruments/nse-master-instruments";
export type { NseMasterRow } from "./instruments/nse-master-logic";
export {
  NSE_MASTER_SERIES,
  mergeNseMasterRows,
  normalizeMasterHeader,
  normalizeMasterIsin,
  parseNseMasterCsv,
} from "./instruments/nse-master-logic";

// Raw exchange-feed fetch + archive seam (MONEY-1085)
export type {
  FeedDescriptor,
  FeedArchiveStore,
  FeedArchiveMode,
  FeedArchiveStoreOptions,
  FeedArchiveCounters,
} from "./feed-archive";
export {
  getFeedAsset,
  emptyFeedAssetOutcome,
  type FeedAssetOutcome,
  setFeedArchiveStore,
  getFeedArchiveStore,
  resolveFeedArchiveMode,
  buildFeedArchiveKey,
  feedContentType,
  FEED_ARCHIVE_WRITE_TIMEOUT_MS,
  FEED_ARCHIVE_READ_TIMEOUT_MS,
  readFeedArchiveCounters,
  resetFeedArchiveCounters,
  diffFeedArchiveCounters,
} from "./feed-archive";
// Replay-health verdict (MONEY-1194) — pure. Turns the feed-archive counter
// delta into "did this run actually replay?", so a replay-mode job that scraped
// 100% of its bytes cannot finish silently the way QA's bhavcopy did for weeks.
export {
  judgeReplayHealth,
  type ReplayHealthInput,
  type ReplayHealthVerdict,
  type ReplayHealthReason,
  type ReplayHealthLevel,
} from "./replay-health";
// Series-readiness verdict (MONEY-1196) — pure. Answers "is BSE's `series`
// column sourced well enough to reclassify from?" over a population that a
// retype cannot drain, so the gate can no longer tighten every time the work it
// gates succeeds.
export {
  judgeSeriesReadiness,
  type SeriesReadinessRow,
  type SeriesReadiness,
} from "./series-readiness";
// Per-feed payload sanity checks (MONEY-1157) — pure; the archive refuses to
// persist (and refuses to replay) bytes that fail these.
export type {
  FeedShape,
  FeedPayloadKind,
  FeedPayloadCheck,
} from "./feed-payload";
export {
  feedShapeFor,
  looksLikeHtml,
  validateFeedPayload,
} from "./feed-payload";
export {
  BSE_REFERER,
  NSE_REFERER,
  EXCHANGE_USER_AGENT,
  EXCHANGE_FETCH_TIMEOUT_MS,
  fetchExchangeAsset,
  mergeExchangeHeaders,
  type ExchangeFetchOptions,
} from "./exchange-feed";

// Instrument sync orchestrator
export { syncInstruments, hasRecentSync } from "./instruments/instrument-sync";

// AMFI Mutual Fund provider
export type {
  AmfiMutualFund,
  AmfiSyncResult,
} from "./instruments/amfi-mf-provider";

export {
  fetchAmfiNavFeed,
  syncAmfiMutualFunds,
  resolveIsinToSchemeCode,
} from "./instruments/amfi-mf-provider";

// MF metadata enrichment — provider SEAM only (MONEY-1205). No implementation
// ships here: AMFI registers itself from the worker
// (./instruments/amfi-fund-metadata-provider), and with nothing registered
// `getMfMetadataProvider()` returns null and the job refuses to run.
export type {
  MfMetadataResult,
  MfMetadataFields,
  MfMetadataLookup,
  MfMetadataOutcome,
  MfMetadataProvider,
  MfEnrichReason,
} from "./instruments/mf-metadata-provider";

export {
  enrichMfMetadata,
  // Seam
  getMfMetadataProvider,
  registerMfMetadataProvider,
  setMfMetadataProviderForTests,
  // Field helpers (absence rules + the zero-field guard)
  MF_METADATA_FIELD_KEYS,
  MF_METADATA_ATTEMPT_SOURCE,
  emptyMfMetadata,
  countMfMetadataFields,
  buildMfMetadataUpdate,
  mfTextOrNull,
  mfNumberOrNull,
  mfDateOrNull,
} from "./instruments/mf-metadata-provider";

// Yahoo price service (historical OHLCV)
export type {
  HistoricalBar,
  YahooHistoricalFetcher,
} from "./prices/yahoo-price-service";

export {
  getHistoricalPrices,
  backfillPrices,
} from "./prices/yahoo-price-service";

// Intraday bar service (MONEY-123 Part A - sub-daily OHLCV cache)
export type {
  IntradayInterval,
  IntradayFetcher,
  PublicPriceSource,
} from "./prices/intraday-bar-service";

export {
  INTRADAY_INTERVALS,
  getIntradayBars,
  getCachedIntradayCoverage,
  upsertIntradayBars,
  backfillIntradayBars,
  pruneIntradayBarsOlderThan,
  assertPublicPriceSource,
} from "./prices/intraday-bar-service";

// Quote service (latest quotes with DB cache)
export type {
  QuoteData as LatestQuoteData,
  YahooQuoteData,
  YahooQuoteFetcher,
  YahooBatchQuoteFetcher,
} from "./prices/quote-service";

export {
  getLatestQuote,
  getLatestQuotes,
  refreshAllQuotes,
} from "./prices/quote-service";

// MF NAV history (MFAPI.in with DB caching)
export type {
  NavPoint,
  MfNavCoverage,
  MfNavBackfillPublisher,
  MfNavBackfillRequest,
  MfNavBackfillRequestStatus,
} from "./prices/mf-nav-service";

export {
  getMfNavHistory,
  getMfNavHistoryWithCoverage,
  // MONEY-1205 — the backfill is a JOB now; reads only enqueue. The DB WRITE
  // lives in workers/src/processors/mf-nav-backfill.ts (see the note on
  // selectMissingNavPoints), so core exports only the fetch and the pure diff.
  fetchMfNavPoints,
  selectMissingNavPoints,
  navDateKeys,
  MF_NAV_INSERT_CHUNK,
  requestMfNavBackfill,
  setMfNavBackfillPublisher,
  resetMfNavBackfillRequests,
  MF_NAV_COLD_THRESHOLD,
} from "./prices/mf-nav-service";

// Sector taxonomy (canonical NSE sectors)
export type { SectorDisplayConfig } from "./instruments/sector-taxonomy";

export {
  NSE_SECTORS,
  YAHOO_TO_NSE_MAP,
  normalizeToNseSector,
  // MONEY-1302 — the WRITE-side counterpart of `normalizeToNseSector`, which
  // passes unmapped labels through and must never decide a persisted value.
  // Exported alongside it so a writer reaching for one sees the other.
  toWritableNseSector,
  getSectorDisplayConfig,
  getAllSectorNames,
} from "./instruments/sector-taxonomy";

// Which instrument types may carry a sector (MONEY-1093). Every writer to
// `InstrumentMapping.sector` must spread `sectorWritableWhere()` into its
// `where` — the nightly DEBT sector-clear fires only once per row, so an
// unguarded write puts a bond's sector back permanently.
export type { SectorBearingType } from "./instruments/sector-write-guard";

export {
  SECTOR_BEARING_TYPES,
  sectorWritableWhere,
  isSectorBearing,
} from "./instruments/sector-write-guard";

// Sector enrichment
export type {
  SectorEnrichmentResult,
  SectorEnrichmentOptions,
  SectorData,
  YahooSectorFetcher,
  EnrichBySymbolOptions,
} from "./instruments/sector-enrichment";

export {
  enrichSectors,
  enrichInstrumentsBySymbol,
  defaultYahooSectorFetcher,
  SECTOR_CONFIG,
  getSectorConfig,
  SECTOR_SKIPPED,
} from "./instruments/sector-enrichment";

// Fund composition (AI-extracted holdings)
export type {
  ExtractedHolding,
  CompositionResult,
} from "./instruments/fund-composition-service";

export {
  getOrExtractComposition,
  refreshComposition,
  getCompositionFromDb,
} from "./instruments/fund-composition-service";

// US Instrument Provider
// MONEY-980 — the Yahoo-era US seeder is GONE, and with it two name collisions.
//
// `us-instrument-provider.ts` exported a TYPE called `UsInstrument` whose shape
// was the old seed row (`exchange: "NASDAQ" | "NYSE" | "AMEX"`), so
// `import type { UsInstrument } from "@usemoney/core/market-data"` silently
// yielded that instead of the Prisma model of the same name. Its only consumer,
// `workers/src/processors/us-instrument-sync.ts`, exported a SECOND
// `syncUsInstruments` that upserted 30 hardcoded tickers into
// `instrument_mappings` — precisely the pollution the collection split exists to
// make impossible, sitting one import away from the real one.
//
// It was unreachable (no route, no scheduler entry, no importer) and therefore
// deleted rather than fenced: a dormant writer aimed at the wrong table is a
// loaded gun, and the next person to grep `syncUsInstruments` would have found
// two answers.

// Yahoo Finance REST API client
export {
  fetchQuotes as yahooFetchQuotes,
  fetchChart as yahooFetchChart,
  fetchSearch as yahooFetchSearch,
  fetchQuoteSummary as yahooFetchQuoteSummary,
  withExchangeFallback,
  normalizeTickerInput,
} from "./yahoo-api";

export type {
  YahooRawQuote,
  ChartBar as YahooChartBar,
  SearchQuote as YahooSearchQuote,
  YahooFetchErrorOpts,
} from "./yahoo-api";

// Sparkline service (compact close-price arrays for list views)
export type {
  SparklineWindow,
  SparklineSymbol,
  SparklineResult,
} from "./sparkline";

export {
  fetchSparkline,
  fetchSparklines,
  toYahooSparklineSymbol,
  sparklineCacheKey,
} from "./sparkline";

// NSE holiday calendar + market-hours phase detector
export type { NseHoliday } from "./nse-holidays";
export {
  NSE_HOLIDAYS_BY_FY,
  getFinancialYear,
  toIstDateKey,
  getNseHoliday,
  getNonTradingReason,
} from "./nse-holidays";

export type { MarketPhase, MarketStatus } from "./market-hours";
export { getNseMarketStatus, formatClosedReason } from "./market-hours";

// US (NYSE / Nasdaq) session detector — MONEY-1309. Separate from the NSE
// module above on purpose: different grid, different calendar, and a
// timezone that moves twice a year.
export type { UsMarketSession } from "./us-market-hours";
export {
  US_MARKET_HOLIDAYS,
  US_EARLY_CLOSE_DAYS,
  US_HOLIDAY_TABLE_YEARS,
  US_PRE_OPEN_MINUTES,
  US_RTH_OPEN_MINUTES,
  US_RTH_CLOSE_MINUTES,
  US_EARLY_CLOSE_MINUTES,
  US_POST_CLOSE_MINUTES,
  usEtMinutesFromMidnight,
  usMarketDateKey,
  // MONEY-1373 — the ET SESSION DATE is the day key both candle writers share.
  usMarketDayBoundsUtc,
  isUsTradingDay,
  lastCompletedUsSession,
  getUsMarketHoliday,
  getUsEarlyClose,
  isUsHolidayCalendarCovered,
  usMarketSession,
  isUsMarketOpen,
  nextUsSessionBoundary,
  usSessionLabel,
} from "./us-market-hours";

// Bhavcopy — free EOD price seed from BSE + NSE (MONEY-851)
export type { BhavcopyRow, IndexCloseRow } from "./bhavcopy";
export {
  fetchBseBhavcopy,
  fetchNseBhavcopy,
  fetchNseIndicesClose,
  parseUdiffBhavcopy,
  parseNseIndicesCsv,
  unzipSingleEntry,
  // The ONE archive decoder (MONEY-1206 D2). Exported here so callers reach it
  // by package specifier instead of a relative path into this package's src/.
  // `UnreadableFeedFile` travels WITH it deliberately: a second copy of the
  // class makes `err instanceof UnreadableFeedFile` false across the seam, and
  // the classification would be lost silently — which is the whole mechanism
  // MONEY-1205 relies on to tell a refusal apart from a transient failure.
  decodeFeedText,
  UnreadableFeedFile,
  buildBseBhavcopyUrl,
  buildNseBhavcopyUrl,
  buildNseIndicesUrl,
  toBhavcopyDateToken,
  toIndicesDateToken,
} from "./bhavcopy";

// Cash-instrument classification (MONEY-1093)
export {
  classifyCashInstrument,
  isNonEquityClass,
  BSE_DEBT_GROUPS,
  BSE_EQUITY_GROUPS,
  type CashInstrumentClass,
  type ClassificationResult,
  type ClassifyInput,
} from "./instruments/instrument-classification";

export * from "./instruments/bse-master-instruments";
export * from "./instruments/bse-master-logic";

// Peer selection (MONEY-1145) — pure; backs the derived `stock_peers` sync.
export {
  hasRealSector,
  REAL_SECTOR_WHERE,
  marketCapDistance,
  indexUniverse,
  selectPeers,
  MIN_INDUSTRY_GROUP,
  MAX_PEERS,
} from "./instruments/peer-selection-logic";
export type {
  PeerCandidate,
  SelectedPeer,
} from "./instruments/peer-selection-logic";

// Report registry (MONEY-1097 / Data Engine P2) — the archive-first inventory
// of NSE/BSE report families. Data only: nothing here fetches or parses.
export {
  REPORT_REGISTRY,
  enabledFamilies,
  allFamilies,
  backfillableFamilies,
  isArchiveFetchable,
  familiesForBackfill,
  familyById,
  familiesDue,
  tokYYYYMMDD,
  tokDDMMYYYY,
  tokDDMMYY,
  tokDDMM,
  tokDDMMMYYYY,
  tokDashMonUpper,
  tokDashMonTitle,
  tokSlash,
  tokMonthUpper,
  tokIsoDay,
} from "./report-registry";
export type {
  ReportFamily,
  ReportCadence,
  ReportFormat,
  ReportProvenance,
} from "./report-registry";

// Historical backfill decision logic (MONEY-941 / Data Engine P3) — pure.
export {
  isoDay,
  parseDay,
  isWeekend,
  weekdaysDescending,
  chunkStartsDescending,
  dateFromArchiveKey,
  shouldEndRange,
  advanceRange,
  emptyHostState,
  noteHostOutcome,
  hostIsPaused,
  backfillBackoffMs,
  shouldAbort,
  previousWeekday,
  isPrecedingWeekday,
  emptyErrorRuns,
  advanceErrorRuns,
  type FeedErrorKind,
  type ErrorRuns,
  planFamily,
  planSpecialSessions,
  emptyTally,
  summarizeFamily,
  DEFAULT_K_MISS,
  THROTTLES_BEFORE_PAUSE,
  HOST_PAUSE_MS,
  DEFAULT_TRANSPORT_STOP_LOSS,
  DEFAULT_PAYLOAD_STOP_LOSS,
  shouldTryDoor,
  THROTTLES_BEFORE_DOOR,
  utcMidnightOf,
} from "./feed-backfill-logic";
// MONEY-1613 — the weekend special-session calendar and the date-column check.
export {
  INDIA_SPECIAL_SESSION_WEEKENDS,
  FAMILIES_WITHOUT_DATE_COLUMN,
  specialSessionCandidateDates,
  readFileSessionDates,
  checkSessionDate,
} from "./india-special-sessions";
export type {
  SpecialSessionEvidence,
  SpecialSessionWeekend,
  FileSessionDates,
  SessionDateCheck,
} from "./india-special-sessions";
export type {
  RangeState,
  HostState,
  FamilyPlan,
  FamilyTally,
} from "./feed-backfill-logic";

// Legacy (pre-UDiFF) bhavcopy parsers (MONEY-941 / P3 step 4) — pure.
export {
  parseOldNseCmBhavcopy,
  parseOldNseFoBhavcopy,
  parseLegacyExpiry,
} from "./bhavcopy-legacy";
export type { LegacyParseResult, LegacyDerivativeRow } from "./bhavcopy-legacy";

// Legacy (pre-UDiFF) BSE cash bhavcopies — MONEY-1101 (P7). Pure.
export {
  parseOldBseCmBhavcopy,
  detectBseLegacyVariant,
  parseBseLegacyTradingDate,
} from "./bhavcopy-bse-legacy";
export type {
  BseLegacyCashRow,
  BseLegacyParseResult,
  BseLegacyVariant,
} from "./bhavcopy-bse-legacy";

// Backfill verification (MONEY-941 / P3 step 5) — pure.
export {
  gradeYear,
  coverageByYear,
  compareParity,
  summarizeParity,
  MIN_EXPECTED_TRADING_DAYS,
  MAX_EXPECTED_TRADING_DAYS,
  PARITY_TOLERANCE,
} from "./feed-backfill-verify";
export type { YearCoverage, ParityResult } from "./feed-backfill-verify";

// UDiFF derivatives parser (MONEY-941 / P3 step 4) — pure.
export { parseUdiffFoBhavcopy, parseUdiffExpiry } from "./bhavcopy-derivatives";
export {
  parseSecBhavdataFull,
  parseScbseallGrossDelivery,
  parseDeliveryDate,
  collapseBySeriesPreference,
  type DeliveryRow,
  type DeliveryParseResult,
  type BseDeliveryRow,
  type BseDeliveryParseResult,
} from "./delivery";

// DailyPrice source precedence (MONEY-1175) — pure. Shared by feed-parse and
// bhavcopy-sync so the two writers cannot disagree about who may overwrite whom.
export {
  PRICE_SOURCE_AUTHORITY,
  UNKNOWN_SOURCE_AUTHORITY,
  priceSourceAuthority,
  shouldUpgradePriceSource,
  partitionPriceWrites,
} from "./price-source-authority";

// Point-in-time index membership (MONEY-1189) — pure.
export {
  buildMembershipIntervals,
  membershipAsOf,
  diffSnapshots,
  planMembershipUpdate,
  type MembershipSnapshot,
  type MembershipInterval,
  type OpenInterval,
  type MembershipUpdate,
} from "./index-membership-logic";

// Run-completion sentinel + hard timeout (MONEY-1189) — pure.
export {
  judgeRunCompletion,
  withHardTimeout,
  type RunProgress,
  type RunCompletionVerdict,
} from "./run-completion";

// Official macro series — RBI / MOSPI / OEA (MONEY-1106, P8b) — pure.
// The registry, both NSDP HTML parsers, the label map and the freshness
// judgement. No fetching lives here; the worker owns the I/O.
export {
  MACRO_SOURCES,
  RBI_REFERER,
  macroSourceById,
  selectMacroSources,
  parseMacroSource,
  parseNsdpPeriodTable,
  parseNsdpAsOnTable,
  parseNsdpReleaseDate,
  parseAsOnDate,
  parseMacroNumber,
  normaliseMacroLabel,
  extractNsdpRows,
  expandCells,
  judgeMacroFreshness,
  type MacroSource,
  type MacroSeriesDef,
  type MacroObservation,
  type MacroParseResult,
  type MacroFrequency,
  type MacroUnit,
  type MacroLayout,
  type MacroFreshness,
} from "./macro-series";

// F&O summary coverage detection (MONEY-1189) — pure.
export {
  retainedUnderlyings,
  selectIncompleteDays,
  selectNightlyTargets,
  type UnderlyingKey,
  type EodUnderlying,
  type IncompleteDay,
} from "./fo-summary-coverage";

// Price-derived corporate-action detection (MONEY-1176) — pure.
export {
  snapRatio,
  detectActions,
  reconcileCandidates,
  PLAUSIBLE_RATIOS,
  SNAP_TOLERANCE,
  MIN_JUMP,
  RECONCILE_DAYS,
  type DetectBar,
  type ActionCandidate,
  type KnownAction,
} from "./corporate-action-detect";

// Corporate-action back-adjustment (MONEY-1176) — pure.
export {
  actionFactor,
  dedupeActions,
  buildAdjustmentTimeline,
  factorForDate,
  applyAdjustment,
  QTY_CHANGING_TYPES,
  SAME_EVENT_DAYS,
  // The chart's action scope, one loader for every origin (MONEY-1541/1543).
  adjustingActionsWhere,
  ADJUSTING_ACTION_SELECT,
  loadAdjustingActions,
  refuseForeignIssuers,
  issuerCandidatesWhere,
  ISSUER_CANDIDATE_SELECT,
  isinIssuer,
  type RawBar,
  type AdjustedBar,
  type AdjustingAction,
  type AdjustmentStep,
  type AdjustingActionDb,
  type IssuerCandidate,
  type LoadedAdjustingAction,
} from "./price-adjust";

// Rename detection at deactivation time (MONEY-1177) — pure.
export {
  detectRenames,
  nextPreviousSymbols,
  type StaleInstrument,
  type ActiveInstrument,
  type RenameDetection,
  type RenameSplit,
} from "./instruments/rename-detect-logic";

// Former-symbol alias derivation (MONEY-1177) — pure.
export {
  buildSymbolSpans,
  decideAliases,
  mergeWithSeed,
  matchedAlias,
  withFormerlyHint,
  aliasGroupKey,
  symbolExchangeAliasKey,
  MIN_OBSERVATIONS,
  type SymbolObservation,
  type SymbolSpan,
  type AliasDecision,
} from "./symbol-alias-logic";

// OHLC invariants (MONEY-1175) — pure.
export {
  classifyCandle,
  isDrawableCandle,
  repairCandle,
  widenCandleRange,
  clampCandleOpen,
  type Candle,
  type CandleDefect,
} from "./candle-integrity";

// Per-stock flag parsers (MONEY-1100 / P4.5) — pure.
export {
  parseCm52WeekHighLow,
  parseEqBandChanges,
  parseSecList,
  parseSurveillanceIndicator,
  parseFoSecBan,
  parseSeriesChange,
  parseShortSelling,
  decodeSurveillanceCode,
  // MONEY-1189 — ASM/GSM live JSON reports.
  parseAsmReport,
  parseGsmReport,
  type NseSurveillanceApiRow,
  type NseAsmReport,
  STOCK_FLAG_SOURCES,
  // MONEY-1205 — the ONE kind-shape table (STATE vs POINT, watched-by-default,
  // whole-universe-daily). Moved here from the alert evaluator so core, the
  // workers and the badge builder read one exhaustive Record.
  FLAG_KIND_POLICY,
  ALL_STOCK_FLAG_KINDS,
  isStockFlagKind,
  stockFlagShape,
  type StockFlagShape,
  type StockFlagKindPolicy,
  type StockFlagKind,
  type StockFlagRow,
  type StockFlagParseResult,
  type SurveillanceFramework,
  type SurveillanceDecode,
} from "./stock-flags";

// FII/DII daily institutional flows (MONEY-1108 / P8d) — pure.
export {
  parseFiiDiiReport,
  parseNseFlowDate,
  normalizeFlowCategory,
  parseFlowValue,
  dedupeFlowRows,
  INSTITUTIONAL_FLOW_SOURCES,
  type FlowCategory,
  type FlowSegment,
  type InstitutionalFlowRow,
  type InstitutionalFlowParseResult,
  type RawFlowRow,
} from "./institutional-flows";

// Exchange-published top movers + live index snapshot (MONEY-1198) — pure.
export {
  parseNseMovers,
  parseNseAllIndices,
  parseNseSnapshotTimestamp,
  parseMoverNumber,
  parseIndexRatio,
  istSessionDay,
  shouldWriteSnapshot,
  // MONEY-1200 — the movers polling gate. Without this on the barrel the fix is
  // unreachable from the worker (@usemoney/core has no wildcard subpath).
  shouldPollMovers,
  dedupeMoversByCompany,
  nseMoversPath,
  MARKET_MOVER_SOURCES,
  NSE_MOVER_INDEX_PARAM,
  NSE_MOVER_BUCKETS,
  NSE_ALL_INDICES_PATH,
  type MoverDirection,
  type NseMoverBucket,
  type MarketMoverRow,
  type MoverParseResult,
  type IndexSnapshotRow,
  type IndexSnapshotParseResult,
} from "./market-movers";

// Commodity EOD — MCX + NCDEX (MONEY-1112 / P9 C3) — pure.
//
// The PARSE half only. The FETCH is blocked and is a separate ticket: MCX 403s
// our egress even with a valid page token, and NCDEX presents a JS fingerprint
// challenge. Built against real committed fixtures so the ingest is ready the
// moment egress is answered, rather than being the thing that then delays it.
export {
  parseMcxBhavcopy,
  parseMcxNoDataEnvelope,
  parseMcxDate,
  parseMcxExpiry,
  parseMcxVolumeCell,
  parseNcdexBhavcopy,
  parseNcdexArchive,
  parseUdiffDate,
  ncdexRevisionFromSessionId,
  unzipEntries,
  MCX_COLUMNS,
  MCX_INSTRUMENTS,
  UDIFF_COLUMNS,
  NCDEX_INSTRUMENTS,
  type OptionType,
  type McxBhavcopyRow,
  type McxBhavcopyDay,
  type McxBhavcopyFile,
  type McxDropped,
  type NcdexBhavcopyRow,
  type NcdexBhavcopyDay,
  type NcdexBhavcopyFile,
  type NcdexDropped,
  type NcdexRevision,
  type CommodityNoData,
  type ZipEntry,
} from "./commodity-eod-logic";

// Page-scrape resolvers for AMCs that publish file links in served HTML
// (MONEY-1105 / P8a) — pure. Seven houses, every one proven by fetching the
// exact URL the resolver itself selects, not a hand-typed one.
export {
  findMonthlyPortfolioLinks,
  pickLinkForMonth,
  // MONEY-1198 — the worker CANNOT drive a per-scheme house without this.
  // `pickLinkForMonth(links, month)` with no scheme is null by construction on
  // any house publishing one file per scheme, so leaving this off the barrel is
  // what kept six of twelve houses at NO_UNIQUE_LINK every month.
  schemesForMonth,
  linksForMonth,
  parsePeriodFromFilename,
  amcPageScraper,
  scrapableAmcs,
  AMC_PAGE_SCRAPERS,
  type AmcPageScrapeId,
  type AmcPageScraper,
  type AmcYearRule,
  type AmcPageRequest,
  type AmcBodyKind,
  type AmcDateStyle,
  type ScrapedLink,
} from "./amc-page-scrape";

// AMFI scheme-identity bridge (MONEY-1105 / P8a) — pure.
//
// Resolves a scheme name PRINTED IN A WORKBOOK to its AMFI scheme code, which
// no AMC portfolio file contains. Works by grouping AMFI's NAVAll feed — which
// this repo already ingests — by AMC, narrowing the match from 14,273
// industry-wide schemes to a median of 130. Measured 326/333 (97.9%) on the
// real committed workbooks, with ZERO ambiguity on those names.
//
// `SchemeResolution` is a 4-way union and `matched` is the ONLY variant
// carrying codes: an ambiguous name reports its candidates rather than picking
// one, because a wrong scheme code silently attributes one fund's holdings to
// another.
export {
  parseNavAllGroups,
  parseNavAllDate,
  schemeFamilyKey,
  schemeFamilyTokens,
  buildSchemeIndex,
  resolveSchemeCode,
  reportSchemeCoverage,
  AMFI_NAVALL_URL,
  type NavAllScheme,
  type NavAllGroup,
  type NavAllFile,
  type SchemeFamily,
  type AmcSchemeIndex,
  type SchemeIndex,
  type AmcRef,
  type SchemeResolution,
  type SchemeCoverageEntry,
  type SchemeCoverageReport,
} from "./amfi-scheme-bridge";

// AMFI's own registry of every Indian AMC (MONEY-1105 / P8a) — pure.
//
// Solves discovery of AMCs, NOT of files: 57 AMCs, 52 with a monthly-portfolio
// link, but only ONE of those links is an actual file — the other 51 are landing
// pages. Its real value is elsewhere: `mfId` -> `fundName` joins byte-exactly
// onto the AMC group headers in AMFI's NAVAll feed we ALREADY ingest (52/52,
// zero orphans), which narrows scheme-name matching from 14,273 industry-wide
// schemes to a median of 130 per AMC. That is the bridge P8a's scheme-identity
// problem needed, and it costs no new fetch.
export {
  parseAmfiAmcRegistry,
  classifyMonthlyLink,
  findAmcByMfId,
  findAmcByFundName,
  amcsWithMonthlyDisclosure,
  AMFI_AMC_REGISTRY_URL,
  type AmfiAmcRecord,
  type AmfiAmcRegistry,
  type AmfiMonthlyLinkKind,
} from "./amfi-amc-registry";

// The I/O half (MONEY-1405 D2). The parser above sat with zero runtime callers
// from the day it merged; this is the fetch that makes it a live capability
// rather than a tested one. Throws rather than returning null, so a page AMFI
// restructured can never be read as an industry with no AMCs.
export {
  fetchAmfiAmcRegistry,
  AmfiAmcRegistryError,
} from "./amfi-amc-registry-fetch";

// Where each AMC publishes (MONEY-1105 / P8a) — pure URL construction.
export {
  AMC_SOURCES,
  fetchableSources,
  amcSource,
  resolverCoverage,
  buildHdfcUrl,
  // MONEY-1407 — UTI's URL is not constructible. The endpoint and the PURE
  // picker are exported separately so the pick can be tested against the real
  // response body with no network call.
  buildUtiDisclosureApiUrl,
  pickUtiDisclosureUrl,
  monthEnd,
  monthStart,
  ordinal,
  type AmcId,
  type AmcSource,
  type AmcUrlDiscovery,
  type AmcProvenance,
  type ResolverCoverage,
} from "./amc-portfolio-sources";

// AMC monthly portfolio disclosures (MONEY-1105 / P8a) — pure.
//
// Reads BYTES, not a path: the four top-AMC files come in four packaging shapes
// and two of them lie about which. Nippon's is named `.xls` and served as
// `application/vnd.ms-excel` while actually being OOXML; ABSL ships a zip whose
// INNER file really is OLE2. The extension lies in both directions, so
// `detectWorkbookFormat` sniffs magic bytes and everything downstream branches
// on that.
export {
  parseAmcPortfolioWorkbook,
  detectWorkbookFormat,
  // MONEY-1407 — ONE worksheet holding ~85 UTI schemes end to end, split on
  // the publisher's own `SCHEME CODE<nnn>STARTS` markers. Pure, and `[]` for
  // every sheet that is not one of those.
  splitConsolidatedSheet,
  isPercentHeader,
  classifyIndustryOrRating,
  resolvePercentScale,
  excelSerialToIsoDate,
  parseAsOfDate,
  parseMonthPeriod,
  extractAsOnDate,
  type WorkbookFormat,
  type PercentScale,
  type PercentScaleSource,
  type AmcPortfolioFile,
  type AmcSchemeSheet,
  type AmcHolding,
  type ColumnMap,
  type SchemeIndexEntry,
  type ParseOptions as AmcParseOptions,
  type Grid as AmcGrid,
  type Cell as AmcCell,
} from "./mf-portfolio-logic";

// NSE exchange circulars (MONEY-1187 / P11 item 7) — pure.
export {
  parseCircularsResponse,
  parseCircularDate,
  parseFileSizeLabel,
  classifyCircular,
  countByTopic,
  CIRCULAR_TOPICS,
  type CircularTopic,
  type Circular,
  type CircularAttachment,
  type CircularsFile,
  type CircularsOutcome,
  type RejectedCircular,
  type CircularRejectReason,
  type ClassifiableCircular,
} from "./circulars-logic";

// XBRL -> reader-facing tables + ratios + Tickertape reconciliation
// (MONEY-1115 / P10 F3). Pure. Holds the DECLARED authority order that decides
// which source wins for a (symbol, period) — StockFinancials has no `source` in
// its unique key, so without a declared winner the last writer silently wins,
// which is exactly what MONEY-1175 turned out to be.
export {
  projectFinancials,
  deriveRatios,
  growthPct,
  reconcile,
  chooseAuthority,
  // The boolean form every non-projection writer needs. Exported so the four
  // Tickertape write paths consult the SAME table instead of each carrying a
  // copy of the ordering (MONEY-1204).
  mayOverwriteFinancials,
  judgeSwitchoverReadiness,
  judgeExclusionComparison,
  // MONEY-1255 — the F3 gate's per-field verdict (READY / BLOCKED /
  // UNVERIFIABLE / DECLARED) and the accounting for a SYMBOL exclusion. Both
  // pure and unit-tested; the reconcile script is the I/O harness only, so the
  // ordering between the four verdicts is testable rather than implicit in the
  // order three `if`s happen to be written in.
  judgeFieldGateOutcome,
  tallySymbolExclusions,
  type DeclaredDivergence,
  type FieldGateVerdict,
  type FieldGateOutcome,
  type SymbolExclusionTally,
  // MONEY-1250 — WHICH SIDE of an INCOMPARABLE pair was empty. The ladder folds
  // "we have no value" and "the vendor has no value" into one count, and those
  // are a coverage GAP and a coverage WIN respectively.
  classifyIncomparable,
  splitIncomparable,
  vendorComparablePeriodEnd,
  VENDOR_REPORTING_LAG_DAYS,
  isAdjacentAnnual,
  lenderTopLineShape,
  filerShapeOf,
  EXCLUSION_COMPARISON_MIN_PAIRS,
  // MONEY-1115 — the ratio engine's new entry points. QoQ is a SEPARATE
  // function from the YoY path on purpose: nothing in the data distinguishes
  // "last quarter" from "last year", so one parameter would silently accept
  // the wrong filing.
  deriveGrowthQoQ,
  deriveTtm,
  FINANCIALS_AUTHORITY,
  type FinancialsSource,
  type AuthorityDecision,
  type ProjectedFinancials,
  type FilerShape,
  type ProjectionResult,
  type DerivedRatios,
  type ReconcileVerdict,
  type ReconcileResult,
  type SwitchoverReadiness,
  type IncomparableSide,
  type IncomparableSplit,
  type TtmAggregate,
  type TtmQuarter,
  // The WRITE side of the same seam (MONEY-1115 P10 F3). Pure decisions only —
  // which row a filing belongs in, which of two filings owns that row, and what
  // an overwrite must preserve. The I/O lives in
  // workers/src/processors/xbrl-projection-writer.ts.
  XBRL_SOURCE,
  periodLabel,
  judgeProjectionEligibility,
  selectFilingForPeriod,
  planFinancialsWrite,
  existingDisplacement,
  ownedFields,
  writableFields,
  LENDER_UNWRITABLE_FIELDS,
  isLenderFamily,
  toCroreDenominated,
  INCOME_FIELDS,
  BALANCE_SHEET_FIELDS,
  // MONEY-1255 — the columns the projection deliberately does NOT own, with
  // the evidence. Exported so the F3 reconcile prints the declaration rather
  // than restating it: a second copy of this reasoning is a copy that drifts.
  UNOWNED_VENDOR_COLUMNS,
  type ProjectionRefusal,
  type FilingRowIdentity,
  type EligibilityVerdict,
  type DisplacementRecord,
  type ProjectionRawData,
  type FinancialsWriteAction,
  type FinancialsSkipReason,
  type FinancialsWritePlan,
  type FinancialsField,
  type IncumbentFinancialsRow,
} from "./xbrl-projection";

// Whose accounts a `StockFinancials` figure is — MONEY-1300. Consolidated and
// standalone differ by a MULTIPLE for a holding company (360ONE FY2025
// totalAssets: 19,768 Cr vs 7,332 Cr), the table holds ONE row per period, so
// the number is unreadable without the basis beside it. Provenance for readers,
// never a filter. Prefer the `@usemoney/core/market-data/financials-basis`
// subpath — the client-side Financials tab imports it that way rather than
// pulling this barrel into the browser bundle.
export {
  normalizeStockFinancialsBasis,
  stockFinancialsBasisLabel,
  summariseStockFinancialsBasis,
  summariseStockFinancialsBasisLabel,
  STOCK_FINANCIALS_BASIS_LABEL,
  type StockFinancialsBasis,
  type StockFinancialsBasisSummary,
} from "./financials-basis";

// Is a filing's SCALE consistent with the rest of the company's? — MONEY-1235.
// A vendor-free check, because the vendor overlap covers only 9.3% of winner
// periods and the mis-declared-`roundingLabel` defect it exposed is not
// confined to those. Quarantine only: this module judges, the writer refuses,
// and nothing ever multiplies a figure by an inferred power of ten.
//
// MONEY-1250 (T3.2) adds a SECOND, sibling-free rule to the same entry point:
// a company's CONSOLIDATED and STANDALONE filings for one period must state
// the same `paidUpEquityShareCapital`, because it is the parent's own share
// capital either way. `judgeCrossBasisPaidUpCapital` is exported for tests and
// for anyone who wants the invariant alone; the WIRING is inside
// `judgeFilingScale`, so both callers get it without a new call site.
export {
  judgeFilingScale,
  judgeCrossBasisPaidUpCapital,
  BASIS_CONFLICT_MIN_FACTOR,
  NEIGHBOUR_WINDOW,
  SCALE_FIELDS,
  // MONEY-1255 — ONE reduction from projected statements to scale magnitudes.
  // The writer and the F3 reconcile both had their own copy of the loop, and
  // both broke silently when `ProjectedFinancials.revenue` was renamed.
  SCALE_FIELD_COLUMN,
  scaleValuesOf,
  type ScaleField,
  type ScaleObservation,
  type ScaleJudgement,
} from "./xbrl-scale-detector";

// The StockRatios switchover gate's JUDGEMENT — MONEY-1235. Sibling of
// `judgeSwitchoverReadiness` above. Three verdicts, not two: the old inline
// ladder BLOCKED on vendor-side absence while printing that the absence was
// "not evidence in either direction", which made the ratios arming
// precondition unsatisfiable by construction.
export {
  judgeRatioReadiness,
  judgeRatiosGate,
  RATIO_MIN_COMPARABLE,
  RATIO_VENDOR_FLOOR,
  RATIO_PASS_RATE,
  // MONEY-1401 — the two rungs that need no vendor. The fill rung asks whether
  // arming would REPLACE a populated column with an emptier one (the agreement
  // rungs cannot see it: they only compare rows that exist on both sides); the
  // identity rung asks whether the filing balances at all, which is the only
  // question still answerable once `stock_ratios` has been overwritten.
  FILL_BLOCKING_RATIOS,
  judgeRatioFill,
  checkBalanceIdentity,
  BALANCE_IDENTITY_TOLERANCE,
  BALANCE_IDENTITY_MAX_FAIL_RATE,
  // MONEY-1401 F9 — the identity rung's RATIO_MIN_COMPARABLE analogue. It
  // shipped without one, so `identityChecked: 0` produced `undefined` and
  // passed the run: the rung went quiet in exactly the state it exists to
  // catch.
  BALANCE_IDENTITY_MIN_CHECKED,
  // MONEY-1401 F8 — the same shape for the fill census: two counts over an
  // empty population always agree, so an unreachable writer would make every
  // ratio read OK for ever.
  FILL_MIN_POPULATION,
  type BalanceIdentityVerdict,
  type RatioFill,
  type RatioFillVerdict,
  type RatiosRunContext,
  type RatioGateVerdict,
  type RatioGateInput,
  type RatioGateJudgement,
  type RatioGateThresholds,
  type RatiosGateOutcome,
} from "./xbrl-ratios-gate";

// NSE's results INDEX — which filings exist and where their XBRL lives
// (MONEY-1113 / P10 F1). Pure. Separate from the DOCUMENT parser below: the
// index turned out to carry more traps than the documents do (two endpoints
// split at SEBI's integrated-filing regime, a silent 20-record default cap, and
// four flags that look boolean and are not).
export {
  parseFilingIndexPage,
  detectTruncation,
  eraForDate,
  hasXbrlDocument,
  parseBasis,
  parseAudited,
  parseCumulative,
  parseFilerKind,
  parsePeriodType,
  parseNseIndexDate,
  INTEGRATED_FILING_ERA_START,
  type FilingIndexEra,
  type FilingIndexEntry,
  type FilingIndexPage,
  type FilingBasis,
  type FilerKind,
  type FilingPeriodType,
  type FilingRejectReason,
  type RejectedFilingRecord,
  type TruncationVerdict,
  // MONEY-1114 — the measured `?period=` vocabulary (two values, and the param
  // is REQUIRED), the fact that the legacy index ignores size/page, and the one
  // place that turns a document's own span into (periodType, cumulative).
  LEGACY_PERIOD_PARAMS,
  buildFilingIndexPath,
  indexSupportsPaging,
  classifyFilingPeriod,
  type LegacyPeriodParam,
  type FilingPeriodClass,
  // MONEY-1255 — the exchange seam. `filingExchange` is the single read path
  // for an entry's exchange; `bseInstanceUrlCandidates` carries the workaround
  // for BSE's wrong index directory on integrated-era NBFC filings.
  filingExchange,
  buildResultsIndexPath,
  bseInstanceUrlCandidates,
  RESULTS_INDEX_HOST,
  RESULTS_INSTANCE_HOST,
  type FilingExchange,
  type FilingIndexRequest,
} from "./xbrl-filing-index";

// Company financials from NSE's own XBRL (MONEY-1113 / P10 F1) — pure.
export {
  parseXbrlFinancials,
  parseXbrlDocument,
  resolveConceptTable,
  type XbrlFinancials,
  type XbrlDocumentOutcome,
  type XbrlTaxonomy,
  type XbrlDialect,
  type XbrlFamily,
  type UnmappedStatementShape,
  type XbrlBasis,
  type XbrlConcept,
  type XbrlConceptGroup,
  type XbrlCoverage,
  type XbrlCoverageLevel,
  type XbrlPeriod,
  // MONEY-1346 — the slice of a filing the RATIO engines actually read, so a
  // non-XBRL source (a model's reading of a filed PDF) can reach the same
  // derivations without inventing a taxonomy it never had.
  type RatioInputs,
  type ReportedIncomeLines,
  // MONEY-1114 — the period selector. A Q4 filing carries the full year in the
  // same document under a second contextRef; this is how the ANNUAL row is read
  // out of it without a second download.
  type XbrlParseOptions,
  // MONEY-1205 — the units boundary. `StockFinancials` is denominated in ₹ CRORE
  // (every prod row came from Tickertape, whose feed is crore); XBRL facts are
  // absolute rupees. The projection WRITER converts; the parser never does.
  RUPEES_PER_CRORE,
  rupeesToCrores,
} from "./xbrl-financials-logic";

// Participant-wise F&O positioning (MONEY-1187 / P11) — pure.
//
// The DERIVATIVES counterpart to the CASH flows above, and routinely confused
// with them: `InstitutionalFlow` is money crossing the tape, this is exposure
// standing open. They disagree often, and that disagreement is the signal.
export {
  parseParticipantPositioning,
  parseParticipantTitleDate,
  parseParticipantTitleMeasure,
  parseContractCount,
  netContracts,
  diffPositioning,
  POSITIONING_PARTICIPANTS,
  POSITIONING_BUCKETS,
  type ParticipantType,
  type PositioningBucket,
  type PositioningMeasure,
  type ParticipantPositioningRow,
  type ParticipantPositioningFile,
  type PositioningDiscrepancy,
  type PositioningDiscrepancyCode,
  type PositioningChange,
} from "./market-positioning-logic";

// FII derivatives statistics (MONEY-1204 / P14 P0.1) — pure.
//
// The per-underlying and RUPEE-valued view of the same FII the participant
// files above already cover. It writes to the same table under its OWN `metric`
// and its OWN bucket namespace; see the module header for why reusing either
// would silently overwrite `nse-fao-participant-*`'s FII rows.
export {
  parseFiiStatsXls,
  checkFiiStatsTotals,
  isFiiStatsTotal,
  fiiStatsParentBucket,
  FII_STATS_BUCKETS,
  FII_STATS_METRIC,
  FII_STATS_PARTICIPANT,
  FII_STATS_BREAKDOWN_SEP,
  type FiiStatsBucket,
  type FiiStatsRow,
  type FiiStatsFile,
  type FiiStatsDiscrepancy,
} from "./fii-stats-logic";

// Institutional deals + SLB open positions (MONEY-1100 / P4.6) — pure.
export {
  parseBulkBlockDeals,
  parseSlbOpenPositions,
  exactDealKey,
  type InstitutionalDealType,
  type InstitutionalDealRow,
  type InstitutionalDealParseResult,
  type SlbPositionRow,
  type SlbParseResult,
} from "./deals";

// Real index-constituent lists (MONEY-1100 / P4.3) — pure. Parses the archived
// `ind_*list.csv` copies so the index-constituent-sync worker writes NSE's
// actual membership instead of the mcap-rank guess.
export {
  parseIndexConstituentList,
  pickLatestConstituentKey,
  constituentKeyDate,
  shouldReplaceMembership,
  CONSTITUENT_SLUG_TO_INDEX_ID,
  INDEX_ID_TO_CONSTITUENT_SLUG,
  MIN_CONSTITUENTS,
  type ConstituentListRow,
  type ParsedConstituentList,
} from "./index-constituent-list";

// F&O chain analytics (MONEY-1100 / P4.4) — pure; the math layer the daily
// DerivativeSummary job runs per (underlying, exchange, date).
export {
  computeDerivativeSummary,
  computeMaxPain,
  classifyOiBuildup,
} from "./fo-analytics-logic";
export type {
  OiBuildup,
  DerivativeContractRow,
  DerivativeSummaryInput,
  DerivativeSummaryCalc,
} from "./fo-analytics-logic";

// Debt security master (MONEY-1204 / P14 14b.1) — pure. Two NSE files, one
// `BondMaster` table, joined on ISIN: `wdmlist` is the wholesale-debt universe
// and `Corporate_bond_report` is the CBM master (and the only one of the two
// carrying issuer, face value and credit rating).
export {
  parseWdmList,
  parseCorporateBondReport,
  corporateBondReportAsOf,
  normalizeBondIsin,
  parseCouponPercent,
  resolveLastTraded,
} from "./bond-master-logic";
export type {
  BondMasterRow,
  BondMasterFile,
  BondMasterSource,
} from "./bond-master-logic";

// Debt EOD prices (MONEY-1204 / P14 14b.1) — pure. `cbm_trd` → `BondEOD`, the
// price series the ~12k DEBT instrument rows have never had. Its ISINs carry a
// TRAILING SPACE, so they go through the same `normalizeBondIsin` the master
// parsers use or the join matches nothing.
export {
  parseCbmTrades,
  // MONEY-1210 — the WDM half of BondEOD. `parseWdmTrades` yields ISIN-less
  // rows; `resolveWdmTrades` joins them against BondMaster on (symbol, issue).
  parseWdmTrades,
  resolveWdmTrades,
} from "./bond-eod-logic";
export type {
  BondEodRow,
  BondEodFile,
  WdmTradeRow,
  WdmTradesFile,
  WdmMasterKey,
  WdmResolution,
  BondSegment,
  BondEodSource,
} from "./bond-eod-logic";

// Market-wide F&O open interest (MONEY-1204 / P14 14b.2) — pure.
//
// Parses `combineoi_deleq_{DDMMYYYY}.csv` into `MwplDaily`. The task asked for
// MWPL UTILISATION and only the numerator is obtainable: the denominator's own
// family (`nse-mwpl-cli`) 404s with zero archived objects, and the neighbouring
// `oi_cli_limit` publishes a PER-CLIENT limit, which is a different quantity.
// So `mwpl` / `utilisationPct` are written null — `MwplDailyWrite` types them as
// the literal `null` so a substitute denominator cannot be slipped in — while
// `computeUtilisationPct` holds the tested arithmetic, inert until a real source
// lands. See the module header for why the NUMERATOR column is unsettled too.
export {
  parseCombinedOiDeleq,
  parseMwplDate,
  computeUtilisationPct,
  toMwplDailyWrite,
  MWPL_SOURCE,
  type CombinedOiRow,
  type CombinedOiFile,
  type MwplDailyWrite,
} from "./mwpl-logic";

// Electronic Gold Receipts bhavcopy (MONEY-1204 / P14 14b.4) — pure.
//
// `EG_BC{DDMMYYYY}.DAT`: no header, 17 positional fields, zero-padded numerics.
// NOT UDiFF. Twelve fields are named from proof (OHLC by ordering, qty/value by
// a VWAP that lands inside the day's range); the other five are carried as
// `EgrUnknownCell`s rather than guessed. Recommended target is `DailyPrice`, and
// the blocker is an `InstrumentMapping` for GOLD10G99, not this parser.
export {
  parseEgrBhavcopy,
  parseEgrDate,
  parseEgrNumber,
  EGR_COLUMNS,
  EGR_UNKNOWN_COLUMNS,
  EGR_FIELD_COUNT,
  EGR_SOURCE,
  type EgrBhavcopyRow,
  type EgrBhavcopyFile,
  type EgrUnknownCell,
} from "./egr-logic";

// MF portfolio section (MONEY-1204 / P14 14d.1) — pure.
//
// Chooses between the AMC's OWN monthly disclosure and the Kuvera/AI-derived
// fallback, and does the month-over-month diff. The fallback table has no period
// column at all, which is why `period` is nullable rather than defaulted.
export {
  buildMfPortfolioSection,
  diffMfPortfolio,
  disclosedWeight,
  latestPeriod,
  type MfPortfolioRow,
  type FundHoldingRow,
  type MfHoldingLine,
  type MfPortfolioSection,
  type MfPortfolioDiff,
  schemeCodeWhere,
} from "./mf-portfolio-section-logic";

// Stock-page DOCUMENT sections (MONEY-1204 / P14 14c.7 · 14c.8 · 14c.9) — pure.
//
// Three things the obvious implementation gets wrong, encoded here rather than
// re-derived per caller. (a) `stock_documents` has NO filing-date column — every
// writer stamps `fetchedAt` at ingest — so the timeline is ordered by INGEST
// time and the field is named `indexedAt`; and a document that is not READY is
// still a real filing, so it is shown with `readable:false` rather than hidden.
// (b) `upcoming_events` has no unique constraint and a NULLABLE symbol, so the
// pin dedupes and filters on symbol explicitly — a null-tolerant filter puts an
// RBI policy date on every stock. (c) `xbrl_filings` must be split on BOTH
// `basis` AND `cumulative`: the nine-month cumulative shares Q3's `periodEnd`,
// and consolidated revenue can be a multiple of standalone, so either filter
// alone yields a plausible, wrong series. Plus the INVERSE
// `mf_portfolio_holdings` read (that table has no `symbol` column — the join is
// ISIN-first with an `instrumentId` fallback).
export {
  // 14c.7 — filings & documents timeline
  classifyDocType,
  normalizeProcessingStatus,
  isReadableDocument,
  dedupeUpcomingEvents,
  nextUpcomingEvent,
  toTimelineDocument,
  parseDocumentPeriod,
  documentPeriodSortKey,
  indexedAtSortKey,
  compareTimelineDocuments,
  buildFilingsTimeline,
  DOC_CATEGORY_ORDER,
  DOC_CATEGORY_LABEL,
  type DocCategory,
  type DocumentPeriod,
  type DocProcessingStatus,
  type StockDocumentRow,
  type TimelineDocument,
  type UpcomingEventRow,
  type PinnedEvent,
  type FilingsTimeline,
  // 14c.8 — financials source badge + basis/cumulative toggle
  summarizeFinancialsSource,
  normalizeBasis,
  availableFilingViews,
  selectFilings,
  buildFilingDrilldown,
  FINANCIALS_BASES,
  DEFAULT_FINANCIALS_BASIS,
  SPARSE_COVERAGE_THRESHOLD,
  type FinancialsSourceRow,
  type FinancialsSourceCount,
  type FinancialsDisplacement,
  type FinancialsSourceSummary,
  type FinancialsBasis,
  type XbrlFilingRow,
  type FilingPeriodView,
  type FilingBasisAvailability,
  type FilingDrilldown,
  // 14c.9 — funds holding this stock
  buildFundsHoldingSection,
  STOCK_HOLDING_TYPES,
  type StockFundHoldingRow,
  type FundHolderRow,
  type FundHolderMove,
  type FundsHoldingSection,
} from "./docs-section-logic";

// Stock-page data-engine section helpers (MONEY-1204 / P14 · 14c.1-14c.3) —
// pure. Current-flag-state reduce, index chips, the null-skipping delivery
// mean, the SLB per-series ladder, MWPL banding, BigInt-safe F&O view.
export {
  finiteOrNull,
  textOrNull,
  isoOrNull,
  parseStockFlagValue,
  buildStockFlagBadges,
  isKnownStockFlagKind,
  // MONEY-1205 — shared value decoder + the header-strip selector. See
  // `isHeadlineWorthy` for why the filter is NOT inside `buildStockFlagBadges`.
  formatStockFlagValue,
  isHeadlineWorthy,
  selectHeadlineStockFlagBadges,
  POINT_EVENT_RECENCY_DAYS,
  indexChipLabel,
  buildIndexChips,
  computeDeliveryTrend,
  describeOiBuildup,
  buildSlbLadder,
  mwplBand,
  buildMwplSnapshot,
  buildDerivativeSummaryView,
  isExpiryWeek,
  EXPIRY_WINDOW_DAYS,
} from "./stock-section-logic";
export type {
  StockFlagStateRow,
  StockFlagParsed,
  StockFlagTone,
  StockFlagBadge,
  IndexMembershipRow,
  StockIndexChip,
  DeliveryDayRow,
  DeliveryPoint,
  DeliveryTrend,
  OiBuildupQuadrant,
  SlbPositionRowInput,
  SlbSeriesRung,
  SlbLadder,
  MwplBand,
  MwplSnapshotRow,
  MwplSnapshot,
  DerivativeSummaryRowInput,
  DerivativeSummaryView,
} from "./stock-section-logic";

// Ownership & activity sections (MONEY-1204 / P14 · 14c.4-14c.6) — pure.
// NSE-vs-Tickertape shareholding precedence, insider netting + monthly grouping,
// and bulk/block deal repeat-buyer detection.
export {
  ANNOUNCEMENT_DOC_TYPES,
  EXCHANGE_SHAREHOLDING_SOURCE,
  INSIDER_DOC_MATCH_WINDOW_DAYS,
  INSIDER_NET_WINDOW_DAYS,
  REPEAT_CLIENT_MIN_PRINTS,
  REPEAT_CLIENT_WINDOW_DAYS,
  SHAREHOLDING_FALLBACK_SOURCE,
  SHAREHOLDING_PRIMARY_SOURCE,
  breakdownRowSource,
  buildDealsSection,
  buildInsiderSection,
  buildOwnershipBreakdownSection,
  buildPledgeTrend,
  buildShareholdingSection,
  computeQoqDeltas,
  dealSide,
  dealTextOrNull,
  dedupeShareholdingByQuarter,
  detectRepeatClients,
  groupInsiderEventsByMonth,
  hasOwnershipBreakdownValues,
  insiderActionLabel,
  insiderDirection,
  institutionalTotal,
  isAnnouncementDoc,
  matchLikelyDocument,
  netInsiderActivity,
  normalizeClientName,
  normalizeNseShareholding,
  normalizeTickertapeShareholding,
  quarterEndDate,
  quarterSortRank,
  readOwnershipPct,
  relativeChangePct,
  shareCountString,
  shareholdingQuarterLabel,
  shareholdingRowSource,
  SHAREHOLDING_EXCHANGE_AUTHORITY,
  sortShareholdingNewestFirst,
} from "./ownership-section-logic";
export type {
  DealInput,
  DealSide,
  DealView,
  DealsSection,
  ExchangeScopedQuarter,
  InsiderDirection,
  InsiderEventInput,
  InsiderEventView,
  InsiderMonthGroup,
  InsiderNetSummary,
  InsiderSection,
  LikelyDocumentLink,
  NseShareholdingRow,
  OwnershipBreakdownLeg,
  OwnershipBreakdownLegKey,
  OwnershipBreakdownRow,
  OwnershipBreakdownSection,
  OwnershipBreakdownShares,
  OwnershipBreakdownSource,
  PledgePoint,
  RepeatClient,
  ShareholdingDeltas,
  ShareholdingObservation,
  ShareholdingQuarter,
  ShareholdingSection,
  ShareholdingSource,
  StockDocumentInput,
  TickertapeShareholdingRow,
} from "./ownership-section-logic";

// Discover surfaces (MONEY-1204 / P14 · 14d.2/3/5/6) — pure. FII/DII flow
// series, participant positioning with its TWO incompatible grains, macro strip,
// IPO phase bucketing, the heuristic circular matcher, and index detail.
export {
  CIRCULAR_MATCH_DISCLAIMER,
  CIRCULAR_MATCH_STOPWORDS,
  INDEX_ROUTE_MAP,
  IPO_RECENT_DAYS,
  MACRO_STRIP_SERIES_IDS,
  MACRO_STRIP_SPEC,
  MIN_SUBJECT_MATCH_LENGTH,
  PARTICIPANT_METRICS,
  POSITIONING_PARTICIPANT_ORDER,
  bucketIpos,
  buildCircularFeed,
  buildIndexConstituents,
  buildIndexDetail,
  buildIndexMembership,
  buildInstitutionalFlowSection,
  buildIpoDashboardCard,
  buildMacroStrip,
  buildPositioningSection,
  checkPositioningGrain,
  circularKey,
  classifyIpoPhase,
  computeMacroYoy,
  countCircularDepartments,
  isPositioningBreakdown,
  istDayKey,
  matchCircularsForSymbol,
  normalizeIndexSlug,
  positioningBucketLabel,
  resolveIndexRoute,
  selectPositioningRows,
  shiftDayKey,
  sumPositioningField,
  toIpoView,
  tokenizeCircularText,
} from "./discover-section-logic";
export type {
  CircularMatchBasis,
  CircularSymbolMatch,
  CircularView,
  FlowDayPoint,
  FlowSeries,
  IndexCloseInput,
  IndexClosePoint,
  IndexConstituentInput,
  IndexConstituentSection,
  IndexConstituentView,
  IndexDetailSection,
  IndexMembershipInput,
  IndexMembershipSection,
  IndexValuation,
  InstitutionalFlowInput,
  InstitutionalFlowSection,
  IpoDashboardCard,
  IpoPhase,
  IpoSections,
  IpoView,
  MacroSeriesInput,
  MacroStrip,
  MacroStripItem,
  MacroUnavailable,
  MacroYoy,
  MembershipChange,
  MembershipChangeKind,
  NseCircularInput,
  ParticipantMetric,
  PositioningGrainCheck,
  PositioningLeg,
  PositioningParticipant,
  PositioningRowInput,
  PositioningSection,
  PositioningSum,
  PositioningSumBlock,
  ResolvedIndexRoute,
  UpcomingIpoInput,
} from "./discover-section-logic";

// ── SEBI shareholding-pattern XBRL (MONEY-1207) ─────────────────────────────
// The FII/DII split NSE's SUMMARY endpoint does not carry, read out of the
// filing it links to, plus the reconciliation gate that refuses a document
// belonging to another company or quarter.
//
// Three facts about this taxonomy that the types alone will not tell you:
//   - percentages are FRACTIONS (`unitRef="pure"`): a 63.97% promoter files
//     `0.6397`, so the scale is derived from the grand total and the document
//     is REFUSED when nothing anchors it;
//   - `EncumberedShareUnderPledged…AsPercentageOfTotalNumberOfShares` under the
//     promoter context is a share of the PROMOTER's holding, not the company's;
//   - `diiPct` is the FILED total, never a sum of the legs modelled here — one
//     PSU bank files 18.42% against 16.01% of modelled legs, and the 2.41pp
//     difference is provident/pension and NBFC lines with no column.
//
// NOTE the two aliases. `xbrl-projection.ts` already exports a
// `ReconcileVerdict` and a `RECONCILE_TOLERANCE_PCT` for a DIFFERENT
// reconciliation — XBRL financials against Tickertape's, which gates a
// one-way switchover. This one compares a shareholding FILING against NSE's own
// SUMMARY row. Same word, unrelated decisions; exporting both unqualified is a
// TS2300 and, worse, invites a caller to reach for whichever it happens to get.
export {
  RECONCILE_TOLERANCE_PCT as SHAREHOLDING_RECONCILE_TOLERANCE_PCT,
  SHP_MEMBERS,
  inspectShareholdingXbrl,
  parseShareholdingXbrl,
  reconcileWithSummary,
} from "./shareholding-xbrl";
export type {
  DiiTotalMode,
  FiiMode,
  ReconcileMismatch as ShareholdingReconcileMismatch,
  ReconcileVerdict as ShareholdingReconcileVerdict,
  ScaleSource,
  ShareholdingBreakdownParse,
  ShareholdingCategory,
  ShareholdingScale,
  ShareholdingSummarySnapshot,
  ShareholdingXbrlOutcome,
  ShpMemberRole,
} from "./shareholding-xbrl";

// ── AMFI fund metadata (MONEY-1207) ─────────────────────────────────────────
// Replaces the dead captnemo/Kuvera proxy (404 for 100% of ISINs, including the
// sample in its own docs), which left aum/expenseRatio/fundManager/returns null
// on all 14,223 schemes while stamping a success marker.
//
// Two facts the types will not tell you:
//   - AAUM is denominated in ₹ LAKH, not crore, and NOTHING on the wire says
//     so. Read as crore every fund is 100x too big and nothing throws; the
//     constant is `AAUM_LAKH_PER_CRORE` and it is load-bearing.
//   - AMFI's `fyId`/`periodId` are RELATIVE ordinals that renumber each
//     quarter, so periods resolve by LABEL and the payload's echoed
//     `selectedPeriod` is asserted rather than trusted.
export type {
  AmfiPlan,
  AmfiSchemeMasterRow,
  AmfiSchemeMasterFile,
  AmfiAumRow,
  AmfiAumDisclosure,
  AmfiTerRow,
  AmfiTerDisclosure,
  AmfiMetadataSources,
  AmfiMetadataIndex,
  AmfiMetadataIndexStats,
  AmfiAaumPeriodRef,
} from "./instruments/amfi-fund-metadata-provider";
export {
  amfiFundMetadataProvider,
  AMFI_METADATA_PROVIDER_ID,
  isAmfiFundMetadataEnabled,
  AmfiFeedEmptyError,
  AAUM_LAKH_PER_CRORE,
  parseAmfiSchemeMaster,
  parseAmfiAumDisclosure,
  parseAmfiTerDisclosure,
  buildAmfiFundMetadataIndex,
  classifyAmfiPlan,
  splitJammedIsins,
  amfiFundTypeFromCategory,
  normaliseAmfiName,
  parseAmfiDayMonthYear,
  buildAmfiSchemeMasterUrl,
  buildAmfiTerExcelUrl,
  amfiTerMonthToken,
  buildAmfiAaumFinancialYearsUrl,
  buildAmfiAaumPeriodsUrl,
  buildAmfiAaumDataUrl,
  amfiAaumQuarterLabel,
  amfiAaumFinancialYearLabel,
  fetchAmfiSchemeMasterBytes,
  fetchAmfiTerDisclosureBytes,
  fetchAmfiAumDisclosureBytes,
  resolveAmfiAaumPeriod,
  loadAmfiFundMetadataIndex,
  primeAmfiFundMetadataSnapshot,
  resetAmfiFundMetadataSnapshot,
} from "./instruments/amfi-fund-metadata-provider";

// ── BSE shareholding pattern (MONEY-1207) ───────────────────────────────────
// BSE-only companies had NO shareholding source at all: `ownership-sync` calls
// NSE's endpoint, which serves NSE-listed symbols only, so 8,139 BSE-only names
// had zero rows by construction. 7,802 of them are reachable here.
//
// The trap this provider exists to survive: a bogus scripcode AND a bogus
// quarter id BOTH return HTTP 200 with a complete SEBI category skeleton whose
// every numeric field is `0.00` — no 404, no empty array. A parser reading the
// data table writes "promoter 0%, public 0%, pledge 0%", which is fabricated
// all-clear data indistinguishable from a real filing. The gate is the METADATA
// tables, never the data table.
//
// Also: pledge != encumbrance. One large cap reports `pledgePct: null` with
// `totalEncumberedPct: 99.99` (NDU 5.02 + other 94.98), so mapping pledge alone
// describes a 99.99%-encumbered promoter as clean.
export {
  parseBseShareholding,
  parseBseShpQuarters,
  fetchBseShareholding,
  fetchBseShpQuarters,
  bseShpQuarterIndexUrl,
  bseShpSummaryUrl,
  bseShpPublicUrl,
} from "./instruments/bse-shareholding-provider";
export type {
  BseShareholdingParse,
  BseShareholdingPayload,
  BseShareholdingDeps,
  BseShpQuarter,
} from "./instruments/bse-shareholding-provider";

/**
 * MONEY-1115 — valuation ratios, the leg that leaves the filing.
 *
 * Separate module because these four need a market price, a share count and a
 * dividend history from three different tables, where every other ratio is
 * computed from one document. Note P/B and EV/EBITDA are structurally
 * unavailable from QUARTERLY filings: Indian quarterlies carry a P&L but SEBI
 * mandates the balance sheet only half-yearly and annually (measured: totalEquity
 * on 29 of 2,152 stored filings).
 */
export {
  deriveShareCount,
  deriveValuation,
  ttmDividendPerShare,
} from "./xbrl-valuation";
export type {
  ShareCount,
  ValuationInputs,
  ValuationRatios,
} from "./xbrl-valuation";

/**
 * MONEY-1346 — `document_financial_extracts` → {@link RatioInputs}.
 *
 * Measured on prod 2026-09-05: 1,248 Indian symbols hold EXTRACTED ANNUAL
 * extract rows, have NO XBRL filing, and hold ZERO `stock_ratios` rows — the
 * only producer selects on `xbrlFilings: { some: {} }`, so they are never even
 * considered. This mapper is what lets them reach the SAME derivations.
 *
 * PURE and Prisma-free: the row arrives as a structural type. Note the units
 * boundary it enforces — the extract stores CRORES and `values` is ABSOLUTE
 * RUPEES, except `eps` and `faceValue`, which are rupees per share.
 */
export {
  extractToRatioInputs,
  selectAnnualExtractsByPeriod,
} from "./document-ratio-inputs";
export type { DocumentExtractRow } from "./document-ratio-inputs";

/**
 * MONEY-1115 — the NSE_XBRL `StockRatios` producer's planner.
 *
 * `StockRatios` has ONE row per symbol with no period key, so an XBRL write
 * replaces the symbol's whole ratio set and re-stamps its source. The planner
 * decides which columns a filing may honestly claim; `isPlanWorthWriting` is
 * the floor that stops a thin plan trading a populated Tickertape row for an
 * emptier one wearing a better source.
 */
export {
  planRatiosWrite,
  isPlanWorthWriting,
  XBRL_OWNED_RATIO_COLUMNS,
  XBRL_UNOWNED_RATIO_COLUMNS,
} from "./xbrl-ratios-producer";
export type { RatiosWritePlan, XbrlRatioColumn } from "./xbrl-ratios-producer";

// ── Ratio derivations (MONEY-1220) ─────────────────────────────────────────
// The eight columns that were parked as UNOWNED and are in fact arithmetic
// over data we already hold. See ratio-derivations.ts for why each one was
// missing inputs rather than missing a source.
export {
  currentRatio,
  grossMargin,
  cagr,
  pegRatio,
  beta,
  deriveExtendedRatios,
  EXTENDED_RATIO_COLUMNS,
  BETA_MIN_OBSERVATIONS,
} from "./ratio-derivations";
export type {
  AnnualPoint,
  ClosePoint,
  CurrentRatioInput,
  ExtendedRatioColumn,
  ExtendedRatioInputs,
  ExtendedRatios,
  GrossMarginInput,
  UnfilledReason,
} from "./ratio-derivations";

// ── Results seasons (MONEY-1217) ───────────────────────────────────────────
// The quarterly windows an Indian earnings calendar is actually scoped by. A
// rolling 30-day window is empty for most of the year by construction, which is
// what made the sector deep-dive's calendar render "0 events" for every sector.
export {
  seasons,
  seasonFor,
  seasonFromOrdinal,
  seasonOrdinal,
  currentOrNextSeason,
  seasonContains,
  shiftSeason,
  fiscalYearStart,
  isSeasonOrdinalInRange,
  groupResultsByDay,
  SEASON_ORDINAL_SPAN,
} from "./results-season";
export type {
  FiscalQuarter,
  ResultsSeason,
  ResultsCalendarDay,
  ResultsCalendarEvent,
  ResultsCalendarRow,
} from "./results-season";

// ── Sync-tier populations (MONEY-1211, shared by MONEY-1217) ───────────────
// Which symbols a nightly job covers. Shared so `events-sync` and
// `financial-data-sync` cannot drift into two answers.
export {
  buildSyncTierWhere,
  computeHotTierCutoff,
  loadSyncTierSymbols,
  normalizeTierSymbols,
  tierSymbolSet,
  EMPTY_TIER_SYMBOLS,
  HOT_TIER_WINDOW_DAYS,
} from "./sync-tiers";
export type { SyncTier, SyncTierSymbols } from "./sync-tiers";

// ── Institutional client classification (MONEY-268) ────────────────────────
// `InstitutionalDeal.clientName` is free text and NSE ships no participant
// category with it. An allowlist over WHOLE TOKENS, whose unmatched answer is
// the honest "INSTITUTIONAL" rather than a guessed FII/DII.
export {
  classifyInstitutionalClient,
  institutionalClassLabel,
  tokenizeClientName,
  DII_MARKERS,
  FII_MARKERS,
  INDIAN_FORM_TOKENS,
  RETIRED_MARKERS,
  STRONG_FII_MARKERS,
  WEAK_FII_MARKERS,
} from "./institutional-client-class";
export type { InstitutionalClientClass } from "./institutional-client-class";

// ── US instrument master — Tiingo + EDGAR (MONEY-980) ──────────────────────
//
// `syncUsInstruments` writes `us_instruments`, its OWN collection, and does NOT
// ride `syncInstruments()`. It used to: `TiingoInstrumentProvider` was an
// `InstrumentProvider` writing US rows into `instrument_mappings`, and it had to
// be run with `exchanges: [...TIINGO_SYNC_EXCHANGES]` or
// `deactivateStaleInstruments` — whose scope is
// `exchangeFilter?.length ? {exchange: {in}} : {}` — would sweep the Indian
// universe on one forgotten argument.
//
// That whole hazard is gone by construction rather than by remembering: with
// two collections the India sweep cannot see a US row at all. The other half of
// the reason is the KEY. `instrument_mappings` is `@@unique([yahooSymbol])`, one
// row per ticker, so loading Tiingo's master into it meant DROPPING 2,196
// repeated tickers — including every delisted security whose ticker a live one
// now uses. `us_instruments` is unique on `listingId`, so both occupancy windows
// of `DOW` are rows and the delisted tail this backbone exists to hold survives.
//
// `enrichUsInstrumentsWithCik` is UPDATE-ONLY (the BSE scrip-master shape) and
// never creates a row: EDGAR's ticker spelling is SEC's, and it publishes no
// exchange, so a provider would have to invent half of a unique key.
export { syncUsInstruments } from "./instruments/us-instrument-sync";
export type { UsInstrumentSyncResult } from "./instruments/us-instrument-sync";

// MONEY-980 — company names. NOT in `supported_tickers.zip` (ticker / exchange /
// assetType / currency / dates only), so a separate paced leg reads
// `/tiingo/daily/<ticker>`. Load-bearing rather than cosmetic: delisted listings
// are user-visible in search, and a result reading `LEH` with no company name is
// unfindable by anyone who does not already know the answer.
export { enrichUsInstrumentNames } from "./instruments/us-instrument-names";
export type { UsNameEnrichmentResult } from "./instruments/us-instrument-names";

// MONEY-1263 — permaTicker enrichment. Rides `us-instrument-master-sync`
// because `instrument_mappings` is QA-DIRECT and cannot be synced down, so the
// column has to be written in each environment rather than copied.
export { enrichUsInstrumentsWithPermaTicker } from "./instruments/tiingo-search";
export type { TiingoSearchEnrichmentResult } from "./instruments/tiingo-search";
export {
  resolveSearchMatch,
  parseSearchResponse,
} from "./instruments/tiingo-search-logic";
export type {
  TiingoSearchRow,
  SearchResolution,
} from "./instruments/tiingo-search-logic";
export {
  TIINGO_SYNC_EXCHANGES,
  US_EXCHANGE_PREFERENCE,
  indexListings,
  isoToDate,
  selectPrimaryListings,
  toRawUsInstrument,
  usInstrumentTypeFor,
} from "./instruments/tiingo-instruments-logic";
export type {
  TiingoListing,
  TiingoListingSelection,
  TiingoListingStats,
} from "./instruments/tiingo-instruments-logic";

// MONEY-1264 — Tiingo US NEWS.
//
// `fetchNews` is deliberately the ONLY way to reach `/tiingo/news`, and the pure
// half is exported alongside it because the floor is the whole story: that
// endpoint serves 3 months and answers a PRE-FLOOR request with HTTP 200 and
// rows from the floor date. A caller that builds its own URL would receive
// clamped data believing it got the range it asked for, so `buildTiingoNewsUrl`
// (which REFUSES) and `detectClampedResponse` (which catches it on the way back)
// are exported as first-class API rather than hidden behind the client.
export { fetchNews } from "./tiingo/tiingo-news";
export type { TiingoNewsResult } from "./tiingo/tiingo-news";
export {
  TIINGO_NEWS_HISTORY_DAYS,
  TIINGO_NEWS_MAX_LIMIT,
  TIINGO_NEWS_MAX_OFFSET,
  TIINGO_NEWS_URL,
  TiingoNewsClampedError,
  TiingoNewsFloorError,
  TiingoNewsParseError,
  buildTiingoNewsUrl,
  dedupeTickers,
  detectClampedResponse,
  isBeforeFloor,
  newsFloorDate,
  parseArticleDate,
  parseNewsResponse,
  toStockNewsRows,
} from "./tiingo/tiingo-news-logic";
export type {
  ClampCheck,
  StockNewsRow,
  TiingoNewsArticle,
  TiingoNewsQuery,
} from "./tiingo/tiingo-news-logic";

export {
  EDGAR_COMPANY_TICKERS_URL,
  EDGAR_USER_AGENT,
  enrichUsInstrumentsWithCik,
  fetchEdgarCompanyTickers,
} from "./instruments/edgar-cik";
export type { EdgarCikEnrichmentResult } from "./instruments/edgar-cik";
export {
  buildEdgarCikIndex,
  diagnoseEdgarFeed,
  normaliseUsTicker,
  padCik,
  parseEdgarCompanyTickers,
  planEdgarCikEnrichment,
} from "./instruments/edgar-cik-logic";
export type {
  EdgarCikIndex,
  EdgarCikPlan,
  EdgarTickerRow,
  StoredUsInstrument,
} from "./instruments/edgar-cik-logic";

// The US venue set that makes a Yahoo symbol suffix-free. Exported alongside
// SUPPORTED_EXCHANGES / YAHOO_SUFFIX_MAP above; see the constant's own comment
// for why it is not an empty entry in that map.
export { US_EXCHANGES } from "./instruments/types";

// ── Candle store (MONEY-980 TASK 4) ────────────────────────────────────────
// OHLCV bars for the US price backbone. One door for reads, which merge a Mongo
// hot window with a GCS cold store per symbol-year, adjust at read time from the
// stored `divCash`/`splitFactor`, and return exactly ONE security — a ticker is
// not a security, and `DOW` on NYSE is two companies.
export {
  adjustCandleSeries,
  buildCandleColdKey,
  candleKey,
  coldYearsForRange,
  decodeColdShard,
  encodeColdShard,
  groupWritesBySeries,
  marketForExchange,
  mergeHotAndCold,
  parseColdShard,
  partitionCandleWrites,
  sanitizeCandleWrites,
  selectSingleListing,
  serializeColdShard,
  sliceRange,
  sniffColdShardFormat,
  sortBarsAscending,
  CANDLE_COLD_CONTENT_TYPE,
  getCandleColdStore,
  readColdShard,
  setCandleColdStore,
  writeColdShard,
  ColdStoreUnavailableError,
  CANDLE_COLD_CACHE_MODULE,
  CANDLE_COLD_CACHE_STALE_TTL_SECONDS,
  CANDLE_COLD_CACHE_TTL_SECONDS,
  CANDLE_COLD_TIMEOUT_MS,
  CandleRepository,
  candleRepository,
  CANDLE_DIFF_OR_BRANCHES,
  CANDLE_WRITE_CHUNK,
} from "./candles";
export type {
  AdjustedCandleBar,
  CandleBar,
  CandleColdStore,
  CandleColdStoreOptions,
  CandleQuery,
  CandleReadMeta,
  CandleRepositoryOptions,
  CandleSanitizeResult,
  CandleSeries,
  CandleSeriesGroup,
  CandleWritePartition,
  CandleWriteResult,
  CandleWriteRow,
  ColdShardFormat,
  ColdShardOutcome,
  ListingResolution,
  ListingSelection,
  NormalizedCandleWrite,
} from "./candles";

// ── US corporate actions — Tiingo (MONEY-1263) ─────────────────────────────
//
// Dividends and splits for the US universe, written to `UsCorporateAction` and
// deliberately NOT to `corporate_actions`: that table's readers scope by SYMBOL
// and not by exchange (`udf/marks/route.ts` says so outright, and `pairing.ts`
// feeds FIFO COST BASIS with no exchange term), which is correct for India and
// false the moment US rows share the table — 214 active Indian symbols collide
// with a US ticker.
//
// The client is DAY-major, not symbol-major: the market-wide route takes one
// `exDate` and rejects a range, which makes the walk ~504 requests per year of
// history regardless of universe size and lets it reach delisted names no
// master still lists.
export {
  buildCorpActionsUrl,
  corpActionsDescriptor,
  fetchDistributionsByExDate,
  fetchSplitsByExDate,
} from "./tiingo/tiingo-corp-actions";
export type { CorpActionFetch } from "./tiingo/tiingo-corp-actions";
export {
  corpActionKey,
  dedupeCorpActions,
  enumerateExDates,
  isEmptyCorpActionsBody,
  isoDayToUtcDate,
  parseDistributionsCsv,
  parseSplitsCsv,
  parseTiingoDate,
  resolveListingId,
  toUsCorporateActionRows,
  TIINGO_CORP_ACTION_CURRENCY,
  TIINGO_CORP_ACTION_SOURCE,
} from "./tiingo/tiingo-corp-actions-logic";
export type {
  CorpActionDedupeResult,
  CorpActionListingWindow,
  TiingoDistributionRow,
  TiingoSplitRow,
  UsCorporateActionRow,
  UsCorporateActionType,
} from "./tiingo/tiingo-corp-actions-logic";
