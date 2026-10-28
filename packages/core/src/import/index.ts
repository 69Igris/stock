/**
 * @usemoney/core/import
 *
 * Shared trade import parsing module.
 * Single source of truth for CSV/XLSX parsing, column mappings,
 * normalization, duplicate hash generation, and file parsing.
 *
 * Used by:
 * - apps/web/lib/actions/trade-import.ts (web app server action)
 * - apps/web/lib/jobs/import-processor.ts (web app background job)
 * - workers/src/processors/import.ts (Cloud Run worker)
 */

// Types
export type {
  BrokerFormat,
  ColumnMapping,
  TradeRow,
  ParsedTradeRow,
  ParsedFileData,
} from "./types";

// Column mappings
export { getColumnMapping } from "./column-mappings";

// Normalizers
export {
  normalizeColumnName,
  normalizeTradeType,
  normalizeExchange,
  normalizeSegment,
  parseNumber,
  splitExchangePrefixedSymbol,
} from "./normalizers";

// Broker-format auto-detection
export {
  detectBrokerFormat,
  resolveEffectiveBrokerFormat,
  brokerFormatLabel,
  normalizeHeaderToken,
  type DetectionResult,
} from "./format-detector";

// Date parsing
export { parseDate, parseDateTime } from "./date-parsers";

// Row parsing
export { parseCSVRow } from "./row-parser";

// Hash generation
export { generateDuplicateHash } from "./hash";

// Sanitization
export { sanitizeFormulaInjection, neutralizeFormulaCell } from "./sanitize";

// CSV parsing
export { detectDelimiter, findHeaderRow, parseCSVContent } from "./csv-parser";

// XLSX parsing
export { parseXLSXContent } from "./xlsx-parser";

// File parsing orchestrator
export { parseFile } from "./file-parser";

// SSRF guard for user-supplied outbound URLs (server-only: uses node:dns/net)
export {
  isSafeFetchTarget,
  safeFetch,
  isBlockedIp,
  SsrfBlockedError,
  type SafeFetchTargetResult,
  type SafeFetchOptions,
  // @internal — exported so the security regression suite exercises the SHIPPED
  // IP classifier instead of an inline copy. Prefer `isBlockedIp` from app code.
  isBlockedIpv4,
  isBlockedIpv6,
  expandIpv6,
  groupsToIpv4,
} from "./ssrf-guard";
