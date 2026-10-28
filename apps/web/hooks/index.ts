/**
 * Hooks
 *
 * Custom React hooks for the application.
 */

export { useMarketData, useQuote } from "./useMarketData";
export type {
  QuoteData,
  UseMarketDataOptions,
  UseMarketDataResult,
} from "./useMarketData";

export {
  useHistoricalData,
  useMultipleHistoricalData,
} from "./useHistoricalData";
export type {
  HistoricalBar,
  ChartBar,
  Period,
  Interval,
  UseHistoricalDataOptions,
  UseHistoricalDataResult,
} from "./useHistoricalData";

export { useStockSearch } from "./useStockSearch";
export type {
  StockSearchResult,
  StockWithPrice,
  UseStockSearchOptions,
  UseStockSearchResult,
} from "./useStockSearch";

export { useLivePositions } from "./useLivePositions";
export type {
  Position,
  LivePosition,
  UseLivePositionsOptions,
  UseLivePositionsResult,
} from "./useLivePositions";

export { useIDBCache } from "./useIDBCache";
export type { IDBCacheOptions, IDBCacheResult } from "@/lib/idb-cache";
