/**
 * Metadata Fields
 *
 * Yahoo Finance quoteSummary returns a mix of actual financial data and metadata
 * fields (identifiers, exchange info, formatting hints). This set contains all
 * metadata field keys that should be EXCLUDED when building card/table blocks
 * or checking data quality.
 *
 * Without this filter, sparse-data stocks (e.g., BIHSPONG) show metadata like
 * "priceHint: 2", "quoteType: EQUITY" instead of actual financial metrics.
 */

export const METADATA_FIELDS = new Set([
  // Yahoo internal identifiers
  "priceHint",
  "quoteType",
  "symbol",
  "exchange",
  "market",
  "shortName",
  "longName",
  "exchangeTimezoneName",
  "exchangeTimezoneShortName",
  "gmtOffSetMilliseconds",
  "messageBoardId",
  "financialCurrency",
  "currency",
  "maxAge",
  "uuid",
  // Market state metadata
  "marketState",
  "quoteSourceName",
  "sourceInterval",
  "exchangeDataDelayedBy",
  "tradeable",
  "cryptoTradeable",
  "hasPrePostMarketData",
  "firstTradeDateMilliseconds",
  "regularMarketSource",
  "postMarketSource",
  "preMarketSource",
  // Formatting-only fields
  "regularMarketTime",
  "postMarketTime",
  "preMarketTime",
  "circulatingSupply",
  "lastMarket",
  // Empty wrapper keys
  "underlyingSymbol",
  "fromCurrency",
  "toCurrency",
]);
