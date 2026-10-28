/**
 * @usemoney/api
 *
 * Shared API utilities for the UseMoney platform.
 * Provides consistent response formats, error handling, and types.
 */

// Response utilities
export {
  success,
  error,
  paginated,
  ErrorCodes,
  type ApiResponse,
  type PaginationParams,
  type ErrorCode,
} from "./response";

// Request parsing helpers (safe JSON body + zod validation → 400)
export {
  safeJson,
  zodParse,
  type SafeJsonResult,
  type ZodParseResult,
  type ParseIssue,
  type SafeParseable,
} from "./request";

// Cursor pagination (opaque base64url cursor + envelope)
export {
  encodeCursor,
  decodeCursor,
  paginatedCursor,
  type CursorPage,
} from "./pagination";

// Error classes
export {
  ApiError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  InternalError,
  ServiceUnavailableError,
  BrokerNotConnectedError,
  BrokerAuthExpiredError,
  BrokerSyncFailedError,
  SubscriptionRequiredError,
  FeatureNotAvailableError,
  isApiError,
  toApiError,
} from "./errors";

// Types
export type {
  AuthContext,
  SortOrder,
  ListQueryParams,
  DateRangeFilter,
  BrokerFilter,
  HoldingsQueryParams,
  PositionsQueryParams,
  TradesQueryParams,
  PairedTradesQueryParams,
  MarketQuoteParams,
  MarketHistoricalParams,
  DashboardSummary,
  SyncStatus,
  HealthCheckResponse,
  BrokerConnectionStatus,
} from "./types";
