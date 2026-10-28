/**
 * Base Broker Adapter
 * Abstract class defining the interface for all broker integrations
 * NOTE: This base adapter does NOT contain database operations.
 * Database operations (storeCredentials, getCredentials, etc.) should be
 * handled in the app layer (server actions).
 */

import type {
  BrokerType,
  RefreshStrategy,
  BrokerCredentials,
  AuthResult,
  HoldingData,
  PositionData,
  OrderData,
  TradeData,
  MutualFundData,
  BrokerInfo,
} from "@usemoney/types";

export abstract class BaseBrokerAdapter {
  protected broker: BrokerType;
  protected brokerInfo: BrokerInfo;

  constructor(broker: BrokerType, info: BrokerInfo) {
    this.broker = broker;
    this.brokerInfo = info;
  }

  /**
   * Get broker type
   */
  getBrokerType(): BrokerType {
    return this.broker;
  }

  /**
   * Get broker information
   */
  getInfo(): BrokerInfo {
    return this.brokerInfo;
  }

  /**
   * OAuth URL generation
   */
  abstract getAuthUrl(redirectUri: string, state?: string): string;

  /**
   * Exchange auth code for tokens
   */
  abstract authenticate(
    authCode: string,
    redirectUri: string,
    additionalData?: Record<string, unknown>,
  ): Promise<AuthResult>;

  /**
   * Refresh access token (if supported)
   */
  abstract refreshAccessToken(
    credentials: BrokerCredentials,
  ): Promise<AuthResult>;

  /**
   * Fetch holdings
   */
  abstract fetchHoldings(
    credentials: BrokerCredentials,
  ): Promise<HoldingData[]>;

  /**
   * Fetch positions
   */
  abstract fetchPositions(
    credentials: BrokerCredentials,
  ): Promise<PositionData[]>;

  /**
   * Fetch orders
   */
  abstract fetchOrders(credentials: BrokerCredentials): Promise<OrderData[]>;

  /**
   * Fetch trades
   */
  abstract fetchTrades(credentials: BrokerCredentials): Promise<TradeData[]>;

  /**
   * Fetch mutual funds (if supported)
   */
  abstract fetchMutualFunds(
    credentials: BrokerCredentials,
  ): Promise<MutualFundData[]>;

  /**
   * Validate token
   */
  abstract validateToken(credentials: BrokerCredentials): Promise<boolean>;

  /**
   * Check if broker supports auto-refresh
   */
  abstract supportsAutoRefresh(): boolean;

  /**
   * Get refresh strategy
   */
  abstract getRefreshStrategy(): RefreshStrategy;

  /**
   * Get token expiry duration in milliseconds
   */
  abstract getTokenExpiryDuration(): number;

  /**
   * Helper: Get end of current day (midnight)
   */
  protected getEndOfDay(): Date {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    return end;
  }

  /**
   * Helper: Add days to current date
   */
  protected addDays(days: number): Date {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date;
  }

  /**
   * Helper: Log API call for debugging
   */
  protected logApiCall(
    method: string,
    endpoint: string,
    status: "success" | "error",
    details?: unknown,
  ): void {
    if (process.env.NODE_ENV === "development") {
      console.log(
        `[${this.broker}] ${method} ${endpoint}:`,
        status,
        details || "",
      );
    }
  }
}
