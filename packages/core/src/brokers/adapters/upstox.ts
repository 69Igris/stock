/**
 * Upstox Adapter
 * OAuth 2.0 | Extended token (1 year) | Auto-refresh supported
 * Docs: https://upstox.com/developer/api/v2/
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

const BROKER_INFO: BrokerInfo = {
  id: "UPSTOX",
  name: "Upstox",
  description:
    "Discount broker backed by Tiger Global with extended token validity",
  color: "#7B2D8E",
  segments: ["Equity", "F&O", "Currency", "Commodity"],
  features: ["Holdings", "Positions", "Orders", "Trades"],
  cost: "FREE",
  tokenExpiry: "1 year (extended)",
  autoRefresh: true,
  mfSupport: false, // Upstox has no dedicated MF API
  docsUrl: "https://upstox.com/developer/api/v2/",
};

export class UpstoxAdapter extends BaseBrokerAdapter {
  private readonly baseUrl = "https://api.upstox.com/v2";
  private readonly authUrl =
    "https://api.upstox.com/v2/login/authorization/dialog";

  constructor() {
    super("UPSTOX", BROKER_INFO);
  }

  private getApiKey(): string {
    return process.env.UPSTOX_API_KEY || "";
  }

  private getApiSecret(): string {
    return process.env.UPSTOX_API_SECRET || "";
  }

  getAuthUrl(redirectUri: string, state?: string): string {
    const params = new URLSearchParams({
      client_id: this.getApiKey(),
      redirect_uri: redirectUri,
      response_type: "code",
    });
    if (state) params.set("state", state);
    return `${this.authUrl}?${params.toString()}`;
  }

  async authenticate(
    authCode: string,
    redirectUri: string,
  ): Promise<AuthResult> {
    if (shouldUseMockData("UPSTOX")) {
      return {
        success: true,
        accessToken: "mock_upstox_token_" + Date.now(),
        expiresAt: this.addDays(365),
        metadata: {
          userId: "MOCK_USER",
          userName: "Demo User",
          broker: "Upstox",
        },
      };
    }

    try {
      // Upstox token endpoint requires application/x-www-form-urlencoded
      // (NOT JSON). Using json: {...} here was a bug that caused 400 errors.
      const response = await ky
        .post(`${this.baseUrl}/login/authorization/token`, {
          body: new URLSearchParams({
            code: authCode,
            client_id: this.getApiKey(),
            client_secret: this.getApiSecret(),
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
        })
        .json<Record<string, unknown>>();

      if (response.access_token) {
        return {
          success: true,
          accessToken: response.access_token as string,
          extendedToken: response.extended_token as string,
          expiresAt: this.addDays(365),
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
    return { success: true, accessToken: credentials.accessToken };
  }

  private getAuthHeaders(
    credentials: BrokerCredentials,
  ): Record<string, string> {
    return {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
    };
  }

  async fetchHoldings(credentials: BrokerCredentials): Promise<HoldingData[]> {
    if (shouldUseMockData("UPSTOX")) return generateMockHoldings(8);

    try {
      const response = await ky
        .get(`${this.baseUrl}/portfolio/long-term-holdings`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const data = (response.data || []) as Array<Record<string, unknown>>;
      return data.map((h) => this.mapHolding(h));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch holdings: ${err.message}`);
    }
  }

  private mapHolding(h: Record<string, unknown>): HoldingData {
    return {
      symbol: h.trading_symbol as string,
      tradingSymbol: h.trading_symbol as string,
      isin: h.isin as string,
      exchange: h.exchange as string,
      totalQuantity: h.quantity as number,
      freeQuantity: h.quantity as number,
      t1Quantity: (h.t1_quantity as number) || 0,
      pledgedQuantity: 0,
      averagePrice: h.average_price as number,
      lastPrice: h.last_price as number,
      closePrice: h.close_price as number,
      pnl: h.pnl as number,
      pnlPercentage: h.pnl_percentage as number,
      product: h.product as string,
      dayChange: (h.day_change as number) || 0,
      dayChangePerc: (h.day_change_percentage as number) || 0,
    };
  }

  async fetchPositions(
    credentials: BrokerCredentials,
  ): Promise<PositionData[]> {
    if (shouldUseMockData("UPSTOX")) return generateMockPositions(4);

    try {
      const response = await ky
        .get(`${this.baseUrl}/portfolio/short-term-positions`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const data = (response.data || []) as Array<Record<string, unknown>>;
      return data.map((p) => this.mapPosition(p));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch positions: ${err.message}`);
    }
  }

  private mapPosition(p: Record<string, unknown>): PositionData {
    return {
      symbol: p.trading_symbol as string,
      tradingSymbol: p.trading_symbol as string,
      exchange: p.exchange as string,
      segment: p.instrument_type === "EQ" ? "CASH" : "FNO",
      positionType: "DAY",
      productType: p.product as string,
      buyQuantity: p.buy_quantity as number,
      sellQuantity: p.sell_quantity as number,
      netQuantity: p.quantity as number,
      buyPrice: p.buy_price as number,
      sellPrice: p.sell_price as number,
      averagePrice: p.average_price as number,
      lastPrice: p.last_price as number,
      realizedPnl: p.realised as number,
      unrealizedPnl: p.unrealised as number,
    };
  }

  async fetchOrders(credentials: BrokerCredentials): Promise<OrderData[]> {
    if (shouldUseMockData("UPSTOX")) return generateMockOrders(10);

    try {
      const response = await ky
        .get(`${this.baseUrl}/order/retrieve-all`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const data = (response.data || []) as Array<Record<string, unknown>>;
      return data.map((o) => this.mapOrder(o));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch orders: ${err.message}`);
    }
  }

  private mapOrder(o: Record<string, unknown>): OrderData {
    return {
      orderId: o.order_id as string,
      symbol: o.trading_symbol as string,
      tradingSymbol: o.trading_symbol as string,
      exchange: o.exchange as string,
      segment: o.instrument_type === "EQ" ? "CASH" : "FNO",
      orderType: o.order_type as string,
      transactionType: o.transaction_type as "BUY" | "SELL",
      productType: o.product as string,
      variety: o.variety as string,
      quantity: o.quantity as number,
      filledQuantity: o.filled_quantity as number,
      price: o.price as number,
      triggerPrice: o.trigger_price as number,
      averagePrice: o.average_price as number,
      status: o.status as string,
      statusMessage: o.status_message as string,
      validity: o.validity as string,
      orderTime: new Date(o.order_timestamp as string),
    };
  }

  async fetchTrades(credentials: BrokerCredentials): Promise<TradeData[]> {
    if (shouldUseMockData("UPSTOX")) return generateMockTrades(15);

    try {
      const response = await ky
        .get(`${this.baseUrl}/order/trades/get-trades-for-day`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const data = (response.data || []) as Array<Record<string, unknown>>;
      return data.map((t) => this.mapTrade(t));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch trades: ${err.message}`);
    }
  }

  private mapTrade(t: Record<string, unknown>): TradeData {
    const tradeValue = (t.quantity as number) * (t.average_price as number);
    return {
      tradeId: t.trade_id as string,
      orderId: t.order_id as string,
      symbol: t.trading_symbol as string,
      tradingSymbol: t.trading_symbol as string,
      exchange: t.exchange as string,
      segment: t.instrument_type === "EQ" ? "CASH" : "FNO",
      transactionType: t.transaction_type as "BUY" | "SELL",
      productType: t.product as string,
      quantity: t.quantity as number,
      price: t.average_price as number,
      tradeValue,
      brokerage: 20,
      exchangeFee: 0,
      gst: 3.6,
      sebiCharges: 0,
      stampDuty: 0,
      transactionTax: 0,
      totalCharges: 23.6,
      netAmount: tradeValue,
      tradeTime: new Date(t.trade_timestamp as string),
    };
  }

  async fetchMutualFunds(
    _credentials: BrokerCredentials,
  ): Promise<MutualFundData[]> {
    if (shouldUseMockData("UPSTOX")) return generateMockMutualFunds(5);
    return [];
  }

  async validateToken(credentials: BrokerCredentials): Promise<boolean> {
    if (shouldUseMockData("UPSTOX")) return true;

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
    return true;
  }

  getRefreshStrategy(): RefreshStrategy {
    return "EXTENDED";
  }

  getTokenExpiryDuration(): number {
    return 365 * 24 * 60 * 60 * 1000; // 1 year
  }
}
