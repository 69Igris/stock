/**
 * Fyers Adapter
 * OAuth 2.0 | Access token expires daily | Refresh token supported
 * Docs: https://myapi.fyers.in/docs/
 */

import { BaseBrokerAdapter } from "../base-adapter";
import {
  generateMockHoldings,
  generateMockPositions,
  generateMockOrders,
  generateMockTrades,
  shouldUseMockData,
} from "../mock-data";
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

const BROKER_INFO: BrokerInfo = {
  id: "FYERS",
  name: "Fyers",
  description: "Feature-rich trading platform with excellent charting tools",
  color: "#00B386",
  segments: ["Equity", "F&O", "Currency", "Commodity"],
  features: ["Holdings", "Positions", "Orders", "Trades"],
  cost: "FREE",
  tokenExpiry: "Daily (refresh supported)",
  autoRefresh: true,
  mfSupport: false, // No MF endpoint in Fyers API v3 as of 2026
  docsUrl: "https://myapi.fyers.in/docs/",
};

export class FyersAdapter extends BaseBrokerAdapter {
  private readonly baseUrl = "https://api-t1.fyers.in/api/v3";
  private readonly authUrl = "https://api-t1.fyers.in/api/v3/generate-authcode";

  constructor() {
    super("FYERS", BROKER_INFO);
  }

  private getAppId(): string {
    return process.env.FYERS_APP_ID || "";
  }

  private getSecretKey(): string {
    return process.env.FYERS_SECRET_KEY || "";
  }

  getAuthUrl(redirectUri: string, state?: string): string {
    const params = new URLSearchParams({
      client_id: this.getAppId(),
      redirect_uri: redirectUri,
      response_type: "code",
      state: state || "",
    });
    return `${this.authUrl}?${params.toString()}`;
  }

  async authenticate(
    authCode: string,
    _redirectUri: string,
  ): Promise<AuthResult> {
    if (shouldUseMockData("FYERS")) {
      return {
        success: true,
        accessToken: "mock_fyers_token_" + Date.now(),
        refreshToken: "mock_fyers_refresh_" + Date.now(),
        expiresAt: this.getEndOfDay(),
        metadata: {
          userId: "MOCK_USER",
          userName: "Demo User",
          broker: "Fyers",
        },
      };
    }

    try {
      const appIdHash = createHash("sha256")
        .update(this.getAppId() + ":" + this.getSecretKey())
        .digest("hex");

      const response = await ky
        .post(`${this.baseUrl}/validate-authcode`, {
          json: {
            grant_type: "authorization_code",
            appIdHash,
            code: authCode,
          },
        })
        .json<Record<string, unknown>>();

      if (response.s === "ok" && response.access_token) {
        return {
          success: true,
          accessToken: response.access_token as string,
          refreshToken: response.refresh_token as string,
          expiresAt: this.getEndOfDay(),
          metadata: response.data as Record<string, unknown>,
        };
      }
      return {
        success: false,
        error: (response.message as string) || "Authentication failed",
      };
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message || "Authentication failed" };
    }
  }

  async refreshAccessToken(
    credentials: BrokerCredentials,
  ): Promise<AuthResult> {
    if (shouldUseMockData("FYERS") || !credentials.refreshToken) {
      return { success: true, accessToken: credentials.accessToken };
    }

    try {
      const appIdHash = createHash("sha256")
        .update(this.getAppId() + ":" + this.getSecretKey())
        .digest("hex");

      const response = await ky
        .post(`${this.baseUrl}/validate-refresh-token`, {
          json: {
            grant_type: "refresh_token",
            appIdHash,
            refresh_token: credentials.refreshToken,
            pin: credentials.pin,
          },
        })
        .json<Record<string, unknown>>();

      if (response.s === "ok" && response.access_token) {
        return {
          success: true,
          accessToken: response.access_token as string,
          expiresAt: this.getEndOfDay(),
        };
      }
      return {
        success: false,
        error: (response.message as string) || "Refresh failed",
      };
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message || "Refresh failed" };
    }
  }

  private getAuthHeaders(
    credentials: BrokerCredentials,
  ): Record<string, string> {
    return { Authorization: `${this.getAppId()}:${credentials.accessToken}` };
  }

  async fetchHoldings(credentials: BrokerCredentials): Promise<HoldingData[]> {
    if (shouldUseMockData("FYERS")) return generateMockHoldings(8);

    try {
      const response = await ky
        .get(`${this.baseUrl}/holdings`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const holdings = (response.holdings || []) as Array<
        Record<string, unknown>
      >;
      return holdings.map(
        (h) =>
          ({
            symbol: h.symbol as string,
            tradingSymbol: h.symbol as string,
            isin: h.isin as string,
            exchange: h.exchange === 10 ? "NSE" : "BSE",
            totalQuantity: h.quantity as number,
            freeQuantity:
              (h.quantity as number) - ((h.pl_quantity as number) || 0),
            pledgedQuantity: (h.pl_quantity as number) || 0,
            averagePrice: h.costPrice as number,
            lastPrice: h.ltp as number,
            closePrice: h.ltp as number,
            pnl: h.pl as number,
            pnlPercentage: h.pl_percent as number,
            product: h.holdingType === "HLD" ? "CNC" : "T1",
          }) as HoldingData,
      );
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch holdings: ${err.message}`);
    }
  }

  async fetchPositions(
    credentials: BrokerCredentials,
  ): Promise<PositionData[]> {
    if (shouldUseMockData("FYERS")) return generateMockPositions(4);

    try {
      const response = await ky
        .get(`${this.baseUrl}/positions`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const positions = (response.netPositions || []) as Array<
        Record<string, unknown>
      >;
      return positions.map(
        (p) =>
          ({
            symbol: p.symbol as string,
            tradingSymbol: p.symbol as string,
            exchange: p.exchange === 10 ? "NSE" : "BSE",
            segment: p.segment as string,
            positionType: "NET",
            productType: p.productType as string,
            buyQuantity: p.buyQty as number,
            sellQuantity: p.sellQty as number,
            netQuantity: p.netQty as number,
            buyPrice: p.buyAvg as number,
            sellPrice: p.sellAvg as number,
            averagePrice: p.netAvg as number,
            lastPrice: p.ltp as number,
            realizedPnl: p.realized_profit as number,
            unrealizedPnl: p.unrealized_profit as number,
          }) as PositionData,
      );
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch positions: ${err.message}`);
    }
  }

  async fetchOrders(credentials: BrokerCredentials): Promise<OrderData[]> {
    if (shouldUseMockData("FYERS")) return generateMockOrders(10);

    try {
      const response = await ky
        .get(`${this.baseUrl}/orders`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const orderTypes = ["MARKET", "LIMIT", "SL", "SL-M"];
      const statuses = ["PENDING", "COMPLETE", "CANCELLED", "REJECTED"];

      const orders = (response.orderBook || []) as Array<
        Record<string, unknown>
      >;
      return orders.map(
        (o) =>
          ({
            orderId: o.id as string,
            symbol: o.symbol as string,
            tradingSymbol: o.symbol as string,
            exchange: o.exchange === 10 ? "NSE" : "BSE",
            segment: o.segment as string,
            orderType: orderTypes[(o.type as number) - 1] || "MARKET",
            transactionType: o.side === 1 ? "BUY" : "SELL",
            productType: o.productType as string,
            variety: "regular",
            quantity: o.qty as number,
            filledQuantity: o.filledQty as number,
            price: o.limitPrice as number,
            triggerPrice: o.stopPrice as number,
            averagePrice: o.tradedPrice as number,
            status: statuses[(o.status as number) - 1] || "PENDING",
            validity: o.validity === 0 ? "DAY" : "IOC",
            orderTime: new Date(o.orderDateTime as string),
          }) as OrderData,
      );
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch orders: ${err.message}`);
    }
  }

  async fetchTrades(credentials: BrokerCredentials): Promise<TradeData[]> {
    if (shouldUseMockData("FYERS")) return generateMockTrades(15);

    try {
      const response = await ky
        .get(`${this.baseUrl}/tradebook`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const trades = (response.tradeBook || []) as Array<
        Record<string, unknown>
      >;
      return trades.map((t) => {
        const tradeValue = (t.tradedQty as number) * (t.tradePrice as number);
        return {
          tradeId: t.id as string,
          orderId: t.orderNumber as string,
          symbol: t.symbol as string,
          tradingSymbol: t.symbol as string,
          exchange: t.exchange === 10 ? "NSE" : "BSE",
          segment: t.segment as string,
          transactionType: t.side === 1 ? "BUY" : "SELL",
          productType: t.productType as string,
          quantity: t.tradedQty as number,
          price: t.tradePrice as number,
          tradeValue,
          brokerage: 20,
          exchangeFee: 0,
          gst: 3.6,
          sebiCharges: 0,
          stampDuty: 0,
          transactionTax: 0,
          totalCharges: 23.6,
          netAmount: tradeValue,
          tradeTime: new Date(t.tradeDateTime as string),
        } as TradeData;
      });
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch trades: ${err.message}`);
    }
  }

  async fetchMutualFunds(): Promise<MutualFundData[]> {
    return [];
  }

  async validateToken(credentials: BrokerCredentials): Promise<boolean> {
    if (shouldUseMockData("FYERS")) return true;

    try {
      const response = await ky
        .get(`${this.baseUrl}/profile`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();
      return response.s === "ok";
    } catch {
      return false;
    }
  }

  supportsAutoRefresh(): boolean {
    return true;
  }

  getRefreshStrategy(): RefreshStrategy {
    return "TOKEN_REFRESH";
  }

  getTokenExpiryDuration(): number {
    const now = new Date();
    const endOfDay = this.getEndOfDay();
    return endOfDay.getTime() - now.getTime();
  }
}
