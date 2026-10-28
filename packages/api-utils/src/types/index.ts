/**
 * Shared API Types
 *
 * Types used across the API layer.
 */

/**
 * Authenticated request context
 */
export interface AuthContext {
  userId: string;
  clerkUserId: string;
}

/**
 * Sort order
 */
export type SortOrder = "asc" | "desc";

/**
 * Common query parameters for list endpoints
 */
export interface ListQueryParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: SortOrder;
  search?: string;
}

/**
 * Date range filter
 */
export interface DateRangeFilter {
  from?: Date | string;
  to?: Date | string;
}

/**
 * Broker filter
 */
export interface BrokerFilter {
  broker?: string;
  brokerUserId?: string;
}

/**
 * Holdings query parameters
 */
export interface HoldingsQueryParams extends ListQueryParams, BrokerFilter {
  segment?: "EQUITY" | "DERIVATIVES" | "MUTUAL_FUND";
  exchange?: string;
}

/**
 * Positions query parameters
 */
export interface PositionsQueryParams extends ListQueryParams, BrokerFilter {
  positionType?: "DAY" | "NET";
  segment?: string;
}

/**
 * Trades query parameters
 */
export interface TradesQueryParams
  extends ListQueryParams, BrokerFilter, DateRangeFilter {
  tradeType?: "BUY" | "SELL";
  segment?: string;
  symbol?: string;
}

/**
 * Paired trades query parameters
 */
export interface PairedTradesQueryParams
  extends ListQueryParams, BrokerFilter, DateRangeFilter {
  status?: "OPEN" | "CLOSED" | "PARTIAL";
  symbol?: string;
}

/**
 * Market data query parameters
 */
export interface MarketQuoteParams {
  symbols: string[];
  exchange?: string;
}

export interface MarketHistoricalParams {
  symbol: string;
  exchange?: string;
  period?: "1d" | "5d" | "1mo" | "3mo" | "6mo" | "1y" | "5y";
  interval?: "1m" | "5m" | "15m" | "1h" | "1d" | "1w";
}

/**
 * Dashboard summary response
 */
export interface DashboardSummary {
  totalInvested: number;
  currentValue: number;
  totalPnL: number;
  totalPnLPercentage: number;
  dayPnL: number;
  dayPnLPercentage: number;
  holdingsCount: number;
  positionsCount: number;
  connectedBrokers: number;
}

/**
 * Sync status
 */
export interface SyncStatus {
  broker: string;
  brokerUserId: string;
  lastSyncAt: Date | null;
  syncInProgress: boolean;
  error?: string;
}

/**
 * Health check response
 */
export interface HealthCheckResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  version?: string;
  environment?: string;
  checks?: Record<string, { status: string; latency?: number }>;
}

/**
 * Broker connection status
 */
export interface BrokerConnectionStatus {
  broker: string;
  connected: boolean;
  brokerUserId?: string;
  connectedAt?: Date;
  expiresAt?: Date;
  isExpired: boolean;
}
