/**
 * Candle store — MONEY-980 TASK 4.
 *
 * `candle-logic.ts`       pure decisions, zero I/O
 * `candle-cold-store.ts`  the GCS port + its cached, bounded reads
 * `candle-repository.ts`  Prisma + the hot/cold merge, adjustment and listing
 *                         resolution
 *
 * A folder barrel, not a re-export of everything: the `-logic` module is also
 * reachable at its own package subpath so a unit test can import it without
 * pulling Prisma or the cache client into the process.
 */

export {
  CANDLE_COLD_CONTENT_TYPE,
  HOT_WINDOW_YEARS,
  INTRADAY_HOT_WINDOW_DAYS,
  INTRADAY_TIMEFRAMES,
  adjustCandleSeries,
  barsNeedingHotLoadStamp,
  buildCandleColdKey,
  candleKey,
  chunk,
  coldShardContentType,
  coldYearsForRange,
  decodeColdShard,
  encodeColdShard,
  groupColdShards,
  groupWritesBySeries,
  hotWindowFloorYear,
  intradayHotFloorTs,
  isActiveListing,
  isIntradayTimeframe,
  marketForExchange,
  mergeColdBars,
  mergeHotAndCold,
  parseColdShard,
  partitionCandleWrites,
  partitionCandlesByDestination,
  resolveCandleDestination,
  resolveColdShardFormat,
  sanitizeCandleWrites,
  selectSingleListing,
  serializeColdShard,
  sliceRange,
  sniffColdShardFormat,
  sortBarsAscending,
  toColdBar,
} from "./candle-logic";
export type {
  AdjustedCandleBar,
  CandleBar,
  CandleDestination,
  CandleDestinationPartition,
  CandleSanitizeResult,
  CandleSeriesGroup,
  CandleTier,
  CandleWritePartition,
  CandleWriteRow,
  ColdShardFormat,
  ColdShardGroup,
  ColdShardWriteFormat,
  HotCandleRow,
  ListingResolution,
  ListingSelection,
  NormalizedCandleWrite,
} from "./candle-logic";

export {
  getCandleColdStore,
  readColdShard,
  readColdShardUncached,
  setCandleColdStore,
  writeColdShard,
  ColdStoreUnavailableError,
  CANDLE_COLD_CACHE_MODULE,
  CANDLE_COLD_CACHE_STALE_TTL_SECONDS,
  CANDLE_COLD_CACHE_TTL_SECONDS,
  CANDLE_COLD_TIMEOUT_MS,
} from "./candle-cold-store";
export type {
  CandleColdStore,
  CandleColdStoreOptions,
  ColdShardOutcome,
} from "./candle-cold-store";

export {
  CandleRepository,
  candleRepository,
  CANDLE_DIFF_OR_BRANCHES,
  CANDLE_WRITE_CHUNK,
} from "./candle-repository";
export type {
  CandleQuery,
  CandleReadMeta,
  CandleRepositoryOptions,
  CandleSeries,
  CandleWriteResult,
  HotLoadLane,
  HotLoadOutcome,
} from "./candle-repository";
