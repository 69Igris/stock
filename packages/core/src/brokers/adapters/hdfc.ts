/**
 * HDFC Securities Adapter
 * API Key based | Token expires at midnight | No auto-refresh
 * Docs: https://www.hdfcsec.com/
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
  id: "HDFC",
  name: "HDFC Securities",
  description: "Full-service broker with research and advisory services",
  color: "#004C8F",
  segments: ["Equity", "F&O", "MF"],
  features: ["Holdings", "Positions", "Orders", "Trades", "MF"],
  cost: "₹999/year",
  tokenExpiry: "Until midnight (daily)",
  autoRefresh: false,
  mfSupport: true,
  docsUrl: "https://www.hdfcsec.com/",
};

export class HDFCAdapter extends BaseBrokerAdapter {
  private readonly baseUrl = "https://developer.hdfcsec.com/oapi/v1";

  constructor() {
    super("HDFC", BROKER_INFO);
  }

  private getApiKey(): string {
    return process.env.HDFC_API_KEY || "";
  }

  private getSecretKey(): string {
    return process.env.HDFC_SECRET_KEY || "";
  }

  getAuthUrl(redirectUri: string, state?: string): string {
    const params = new URLSearchParams({
      api_key: this.getApiKey(),
      redirect_url: redirectUri,
    });
    if (state) params.set("state", state);
    return `https://developer.hdfcsec.com/oapi/login?${params.toString()}`;
  }

  async authenticate(requestToken: string): Promise<AuthResult> {
    if (shouldUseMockData("HDFC")) {
      return {
        success: true,
        accessToken: "mock_hdfc_token_" + Date.now(),
        expiresAt: this.getEndOfDay(),
        metadata: { userId: "MOCK_USER", broker: "HDFC Securities" },
      };
    }

    try {
      const response = await ky
        .post(`${this.baseUrl}/session/token`, {
          json: {
            api_key: this.getApiKey(),
            request_token: requestToken,
            secret_key: this.getSecretKey(),
          },
        })
        .json<Record<string, unknown>>();

      if (response.access_token) {
        return {
          success: true,
          accessToken: response.access_token as string,
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

  async refreshAccessToken(): Promise<AuthResult> {
    return {
      success: false,
      error: "HDFC Securities requires daily re-authentication",
    };
  }

  private getAuthHeaders(
    credentials: BrokerCredentials,
  ): Record<string, string> {
    return {
      Authorization: `Bearer ${credentials.accessToken}`,
      "X-Api-Key": this.getApiKey(),
      "Content-Type": "application/json",
    };
  }

  async fetchHoldings(credentials: BrokerCredentials): Promise<HoldingData[]> {
    if (shouldUseMockData("HDFC")) return generateMockHoldings(8);

    try {
      const response = await ky
        .get(`${this.baseUrl}/portfolio/holdings`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const holdings = (response.data || []) as Array<Record<string, unknown>>;
      return holdings.map(
        (h) =>
          ({
            symbol: h.tradingsymbol as string,
            tradingSymbol: h.tradingsymbol as string,
            isin: h.isin as string,
            exchange: h.exchange as string,
            totalQuantity: h.quantity as number,
            freeQuantity:
              (h.quantity as number) - ((h.collateral_quantity as number) || 0),
            pledgedQuantity: (h.collateral_quantity as number) || 0,
            averagePrice: h.average_price as number,
            lastPrice: h.last_price as number,
            closePrice: h.close_price as number,
            pnl: h.pnl as number,
            pnlPercentage: h.pnl_percentage as number,
            product: "CNC",
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
    if (shouldUseMockData("HDFC")) return generateMockPositions(4);

    try {
      const response = await ky
        .get(`${this.baseUrl}/portfolio/positions`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const positions = (response.data || []) as Array<Record<string, unknown>>;
      return positions.map(
        (p) =>
          ({
            symbol: p.tradingsymbol as string,
            tradingSymbol: p.tradingsymbol as string,
            exchange: p.exchange as string,
            segment: p.exchange === "NSE" ? "CASH" : "FNO",
            positionType: "NET",
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
          }) as PositionData,
      );
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch positions: ${err.message}`);
    }
  }

  async fetchOrders(credentials: BrokerCredentials): Promise<OrderData[]> {
    if (shouldUseMockData("HDFC")) return generateMockOrders(10);

    try {
      const response = await ky
        .get(`${this.baseUrl}/orders`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const orders = (response.data || []) as Array<Record<string, unknown>>;
      return orders.map(
        (o) =>
          ({
            orderId: o.order_id as string,
            symbol: o.tradingsymbol as string,
            tradingSymbol: o.tradingsymbol as string,
            exchange: o.exchange as string,
            segment: o.exchange === "NSE" ? "CASH" : "FNO",
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
            validity: o.validity as string,
            orderTime: new Date(o.order_timestamp as string),
          }) as OrderData,
      );
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch orders: ${err.message}`);
    }
  }

  async fetchTrades(credentials: BrokerCredentials): Promise<TradeData[]> {
    if (shouldUseMockData("HDFC")) return generateMockTrades(15);

    try {
      const response = await ky
        .get(`${this.baseUrl}/trades`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const trades = (response.data || []) as Array<Record<string, unknown>>;
      return trades.map((t) => {
        const tradeValue = (t.quantity as number) * (t.average_price as number);
        return {
          tradeId: t.trade_id as string,
          orderId: t.order_id as string,
          symbol: t.tradingsymbol as string,
          tradingSymbol: t.tradingsymbol as string,
          exchange: t.exchange as string,
          segment: t.exchange === "NSE" ? "CASH" : "FNO",
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
          tradeTime: new Date(t.fill_timestamp as string),
        } as TradeData;
      });
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch trades: ${err.message}`);
    }
  }

  async fetchMutualFunds(
    _credentials: BrokerCredentials,
  ): Promise<MutualFundData[]> {
    if (shouldUseMockData("HDFC")) return generateMockMutualFunds(5);
    return [];
  }

  async validateToken(credentials: BrokerCredentials): Promise<boolean> {
    if (shouldUseMockData("HDFC")) return true;

    try {
      const response = await ky
        .get(`${this.baseUrl}/user/profile`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();
      return !!response.data;
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
