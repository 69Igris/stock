/**
 * Zerodha Kite Connect Adapter
 * OAuth 2.0 + TOTP | Token expires at midnight | NO auto-refresh
 * Docs: https://kite.trade/docs/connect/v3/
 */

import { BaseBrokerAdapter } from "../base-adapter";
import {
  generateMockHoldings,
  generateMockPositions,
  generateMockOrders,
  generateMockTrades,
  generateMockMutualFunds,
  shouldUseMockData,
} from "../mock-data";
import {
  normalizeZerodhaHolding,
  normalizeZerodhaPosition,
  normalizeZerodhaOrder,
  normalizeZerodhaTrade,
  normalizeZerodhaMutualFund,
} from "./zerodha-normalize";
import type {
  BrokerCredentials,
  AuthResult,
  HoldingData,
  PositionData,
  OrderData,
  TradeData,
  MutualFundData,
  BrokerInfo,
  RefreshStrategy,
} from "@usemoney/types";
import ky from "ky";
import { createHash } from "crypto";
import { syncLogger as logger } from "@usemoney/logger";

const BROKER_INFO: BrokerInfo = {
  id: "ZERODHA",
  name: "Zerodha",
  description: "India's largest discount broker with Kite Connect API",
  color: "#387ed1",
  segments: ["Equity", "F&O", "Currency", "Commodity"],
  features: ["Holdings", "Positions", "Orders", "Trades", "MF (view only)"],
  cost: "₹500/month or FREE (Personal)",
  tokenExpiry: "Until midnight (daily)",
  autoRefresh: false,
  mfSupport: true,
  docsUrl: "https://kite.trade/docs/connect/v3/",
};

export class ZerodhaAdapter extends BaseBrokerAdapter {
  private readonly baseUrl = "https://api.kite.trade";
  private readonly loginUrl = "https://kite.zerodha.com/connect/login";

  constructor() {
    super("ZERODHA", BROKER_INFO);
  }

  private getApiKey(): string {
    return process.env.ZERODHA_API_KEY || "";
  }

  private getApiSecret(): string {
    return process.env.ZERODHA_API_SECRET || "";
  }

  getAuthUrl(redirectUri: string, state?: string): string {
    const params = new URLSearchParams({
      api_key: this.getApiKey(),
      v: "3",
    });
    if (state) params.set("state", state);
    return `${this.loginUrl}?${params.toString()}`;
  }

  async authenticate(
    requestToken: string,
    _redirectUri: string,
  ): Promise<AuthResult> {
    if (shouldUseMockData("ZERODHA")) {
      return {
        success: true,
        accessToken: "mock_zerodha_token_" + Date.now(),
        expiresAt: this.getEndOfDay(),
        metadata: {
          userId: "MOCK_USER",
          userName: "Demo User",
          email: "demo@example.com",
          broker: "Zerodha",
          exchanges: ["NSE", "BSE", "NFO", "CDS", "MCX"],
        },
      };
    }

    try {
      const apiKey = this.getApiKey();
      const apiSecret = this.getApiSecret();

      // Generate checksum
      const checksum = createHash("sha256")
        .update(apiKey + requestToken + apiSecret)
        .digest("hex");

      const response = await ky
        .post(`${this.baseUrl}/session/token`, {
          json: {
            api_key: apiKey,
            request_token: requestToken,
            checksum,
          },
          headers: { "X-Kite-Version": "3" },
        })
        .json<Record<string, unknown>>();

      if (response.status === "success") {
        const data = response.data as Record<string, unknown>;
        return {
          success: true,
          accessToken: data.access_token as string,
          expiresAt: this.getEndOfDay(),
          metadata: {
            userId: data.user_id,
            userName: data.user_name,
            email: data.email,
            broker: data.broker,
            exchanges: data.exchanges,
            products: data.products,
            orderTypes: data.order_types,
          },
        };
      }

      return {
        success: false,
        error: (response.message as string) || "Authentication failed",
      };
    } catch (error) {
      const err = error as Error;
      this.logApiCall("POST", "/session/token", "error", err.message);
      return { success: false, error: err.message || "Authentication failed" };
    }
  }

  async refreshAccessToken(): Promise<AuthResult> {
    return {
      success: false,
      error: "Zerodha requires daily re-authentication",
    };
  }

  private getAuthHeaders(
    credentials: BrokerCredentials,
  ): Record<string, string> {
    return {
      Authorization: `token ${this.getApiKey()}:${credentials.accessToken}`,
      "X-Kite-Version": "3",
    };
  }

  async fetchHoldings(credentials: BrokerCredentials): Promise<HoldingData[]> {
    if (shouldUseMockData("ZERODHA")) return generateMockHoldings(8);

    try {
      const response = await ky
        .get(`${this.baseUrl}/portfolio/holdings`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      if (response.status !== "success") {
        throw new Error(
          (response.message as string) || "Failed to fetch holdings",
        );
      }

      const data = response.data as Array<Record<string, unknown>>;
      return data.map((h) => normalizeZerodhaHolding(h));
    } catch (error) {
      const err = error as Error;
      this.logApiCall("GET", "/portfolio/holdings", "error", err.message);
      throw new Error(`Failed to fetch holdings: ${err.message}`);
    }
  }

  async fetchPositions(
    credentials: BrokerCredentials,
  ): Promise<PositionData[]> {
    if (shouldUseMockData("ZERODHA")) return generateMockPositions(4);

    try {
      const response = await ky
        .get(`${this.baseUrl}/portfolio/positions`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      if (response.status !== "success") {
        throw new Error(
          (response.message as string) || "Failed to fetch positions",
        );
      }

      const data = response.data as Record<
        string,
        Array<Record<string, unknown>>
      >;
      const positions: PositionData[] = [];

      // Only use NET positions - DAY is a subset view of today's activity
      // and duplicates every position that also appears in NET.
      for (const pos of data.net || []) {
        positions.push(this.mapPosition(pos, "NET"));
      }

      return positions;
    } catch (error) {
      const err = error as Error;
      this.logApiCall("GET", "/portfolio/positions", "error", err.message);
      throw new Error(`Failed to fetch positions: ${err.message}`);
    }
  }

  private mapPosition(
    pos: Record<string, unknown>,
    type: "DAY" | "NET",
  ): PositionData {
    return normalizeZerodhaPosition(pos, type);
  }

  async fetchOrders(credentials: BrokerCredentials): Promise<OrderData[]> {
    if (shouldUseMockData("ZERODHA")) return generateMockOrders(10);

    try {
      const response = await ky
        .get(`${this.baseUrl}/orders`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      if (response.status !== "success") {
        throw new Error(
          (response.message as string) || "Failed to fetch orders",
        );
      }

      const data = response.data as Array<Record<string, unknown>>;
      return data.map((o) => normalizeZerodhaOrder(o));
    } catch (error) {
      const err = error as Error;
      this.logApiCall("GET", "/orders", "error", err.message);
      throw new Error(`Failed to fetch orders: ${err.message}`);
    }
  }

  async fetchTrades(credentials: BrokerCredentials): Promise<TradeData[]> {
    if (shouldUseMockData("ZERODHA")) return generateMockTrades(15);

    try {
      const response = await ky
        .get(`${this.baseUrl}/trades`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      if (response.status !== "success") {
        throw new Error(
          (response.message as string) || "Failed to fetch trades",
        );
      }

      const data = response.data as Array<Record<string, unknown>>;
      return data.map((t) => normalizeZerodhaTrade(t));
    } catch (error) {
      const err = error as Error;
      this.logApiCall("GET", "/trades", "error", err.message);
      throw new Error(`Failed to fetch trades: ${err.message}`);
    }
  }

  async fetchMutualFunds(
    credentials: BrokerCredentials,
  ): Promise<MutualFundData[]> {
    if (shouldUseMockData("ZERODHA")) return generateMockMutualFunds(5);

    try {
      const response = await ky
        .get(`${this.baseUrl}/mf/holdings`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      if (response.status !== "success") {
        return []; // MF is optional
      }

      const data = response.data as Array<Record<string, unknown>>;
      return data.map((mf) => normalizeZerodhaMutualFund(mf));
    } catch (error) {
      // A real MF-feed failure must NOT be swallowed to [] (daily sync would
      // report SUCCESS with 0 MFs). Log + rethrow so the worker sync layer's
      // catch records it.
      logger.warn(
        { error, broker: "ZERODHA", type: "mutualFunds" },
        "MF fetch failed",
      );
      throw error;
    }
  }

  async validateToken(credentials: BrokerCredentials): Promise<boolean> {
    if (shouldUseMockData("ZERODHA")) return true;

    try {
      const response = await ky
        .get(`${this.baseUrl}/user/profile`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();
      return response.status === "success";
    } catch {
      return false;
    }
  }

  supportsAutoRefresh(): boolean {
    return false;
  }

  getRefreshStrategy(): RefreshStrategy {
    return "NONE";
  }

  getTokenExpiryDuration(): number {
    const now = new Date();
    const endOfDay = this.getEndOfDay();
    return endOfDay.getTime() - now.getTime();
  }
}
