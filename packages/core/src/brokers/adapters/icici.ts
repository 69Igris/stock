/**
 * ICICI Direct Breeze Adapter
 * OAuth + Session token | Token expires at midnight | No auto-refresh
 * Docs: https://breezeapi.icicidirect.com/
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
  id: "ICICI",
  name: "ICICI Direct",
  description: "Breeze API from ICICI Securities with comprehensive features",
  color: "#F15A22",
  segments: ["Equity", "F&O", "Currency", "MF"],
  features: ["Holdings", "Positions", "Orders", "Trades", "MF"],
  cost: "₹1000/year",
  tokenExpiry: "Until midnight (daily)",
  autoRefresh: false,
  mfSupport: true,
  docsUrl: "https://breezeapi.icicidirect.com/",
};

export class ICICIAdapter extends BaseBrokerAdapter {
  private readonly baseUrl = "https://api.icicidirect.com/breezeapi/api/v1";

  constructor() {
    super("ICICI", BROKER_INFO);
  }

  private getApiKey(): string {
    return process.env.ICICI_API_KEY || "";
  }

  private getSecretKey(): string {
    return process.env.ICICI_SECRET_KEY || "";
  }

  getAuthUrl(redirectUri: string, state?: string): string {
    const params = new URLSearchParams({
      api_key: this.getApiKey(),
      redirect_uri: redirectUri,
    });
    if (state) params.set("state", state);
    return `https://api.icicidirect.com/apiuser/login?${params.toString()}`;
  }

  async authenticate(sessionToken: string): Promise<AuthResult> {
    if (shouldUseMockData("ICICI")) {
      return {
        success: true,
        accessToken: "mock_icici_token_" + Date.now(),
        expiresAt: this.getEndOfDay(),
        metadata: { userId: "MOCK_USER", broker: "ICICI Direct" },
      };
    }

    try {
      const response = await ky
        .post(`${this.baseUrl}/customerdetails`, {
          json: { api_key: this.getApiKey(), session_token: sessionToken },
          headers: { "Content-Type": "application/json" },
        })
        .json<Record<string, unknown>>();

      if (response.Success) {
        return {
          success: true,
          accessToken: sessionToken,
          expiresAt: this.getEndOfDay(),
          metadata: response.Success as Record<string, unknown>,
        };
      }
      return {
        success: false,
        error: (response.Error as string) || "Authentication failed",
      };
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message || "Authentication failed" };
    }
  }

  async refreshAccessToken(): Promise<AuthResult> {
    return {
      success: false,
      error: "ICICI Direct requires daily re-authentication",
    };
  }

  private getAuthHeaders(
    credentials: BrokerCredentials,
  ): Record<string, string> {
    return {
      "X-SessionToken": credentials.accessToken || "",
      "X-AppKey": this.getApiKey(),
      "X-SecretKey": this.getSecretKey(),
      "Content-Type": "application/json",
    };
  }

  async fetchHoldings(credentials: BrokerCredentials): Promise<HoldingData[]> {
    if (shouldUseMockData("ICICI")) return generateMockHoldings(8);

    try {
      const response = await ky
        .get(`${this.baseUrl}/demat/holdings`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const holdings = (response.Success || []) as Array<
        Record<string, unknown>
      >;
      return holdings.map(
        (h) =>
          ({
            symbol: h.stock_code as string,
            tradingSymbol: h.stock_code as string,
            isin: h.stock_ISIN as string,
            exchange: h.exchange_code as string,
            totalQuantity: h.quantity as number,
            freeQuantity: h.quantity as number,
            pledgedQuantity: 0,
            averagePrice: h.average_price as number,
            lastPrice: h.current_price as number,
            closePrice: h.previous_close as number,
            pnl:
              ((h.current_price as number) - (h.average_price as number)) *
              (h.quantity as number),
            pnlPercentage:
              (((h.current_price as number) - (h.average_price as number)) /
                (h.average_price as number)) *
              100,
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
    if (shouldUseMockData("ICICI")) return generateMockPositions(4);

    try {
      const response = await ky
        .get(`${this.baseUrl}/positions`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const positions = (response.Success || []) as Array<
        Record<string, unknown>
      >;
      return positions.map(
        (p) =>
          ({
            symbol: p.stock_code as string,
            tradingSymbol: p.stock_code as string,
            exchange: p.exchange_code as string,
            segment: p.segment as string,
            positionType: "NET",
            productType: p.product_type as string,
            buyQuantity: p.buy_quantity as number,
            sellQuantity: p.sell_quantity as number,
            netQuantity: p.quantity as number,
            buyPrice: p.buy_average_price as number,
            sellPrice: p.sell_average_price as number,
            averagePrice: p.average_price as number,
            lastPrice: p.ltp as number,
            realizedPnl: p.realized_pnl as number,
            unrealizedPnl: p.unrealized_pnl as number,
          }) as PositionData,
      );
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch positions: ${err.message}`);
    }
  }

  async fetchOrders(credentials: BrokerCredentials): Promise<OrderData[]> {
    if (shouldUseMockData("ICICI")) return generateMockOrders(10);

    try {
      const response = await ky
        .get(`${this.baseUrl}/orderbook`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const orders = (response.Success || []) as Array<Record<string, unknown>>;
      return orders.map(
        (o) =>
          ({
            orderId: o.order_id as string,
            symbol: o.stock_code as string,
            tradingSymbol: o.stock_code as string,
            exchange: o.exchange_code as string,
            segment: o.segment as string,
            orderType: o.order_type as string,
            transactionType: o.action as "BUY" | "SELL",
            productType: o.product as string,
            variety: "regular",
            quantity: o.quantity as number,
            filledQuantity: o.filled_quantity as number,
            price: o.price as number,
            triggerPrice: o.stoploss_price as number,
            averagePrice: o.average_price as number,
            status: o.status as string,
            validity: o.validity as string,
            orderTime: new Date(o.order_datetime as string),
          }) as OrderData,
      );
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch orders: ${err.message}`);
    }
  }

  async fetchTrades(credentials: BrokerCredentials): Promise<TradeData[]> {
    if (shouldUseMockData("ICICI")) return generateMockTrades(15);

    try {
      const response = await ky
        .get(`${this.baseUrl}/tradebook`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const trades = (response.Success || []) as Array<Record<string, unknown>>;
      return trades.map((t) => {
        const tradeValue = (t.quantity as number) * (t.trade_price as number);
        return {
          tradeId: t.trade_id as string,
          orderId: t.order_id as string,
          symbol: t.stock_code as string,
          tradingSymbol: t.stock_code as string,
          exchange: t.exchange_code as string,
          segment: t.segment as string,
          transactionType: t.action as "BUY" | "SELL",
          productType: t.product as string,
          quantity: t.quantity as number,
          price: t.trade_price as number,
          tradeValue,
          brokerage: 20,
          exchangeFee: 0,
          gst: 3.6,
          sebiCharges: 0,
          stampDuty: 0,
          transactionTax: 0,
          totalCharges: 23.6,
          netAmount: tradeValue,
          tradeTime: new Date(t.trade_datetime as string),
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
    if (shouldUseMockData("ICICI")) return generateMockMutualFunds(5);
    return [];
  }

  async validateToken(credentials: BrokerCredentials): Promise<boolean> {
    if (shouldUseMockData("ICICI")) return true;

    try {
      const response = await ky
        .get(`${this.baseUrl}/customerdetails`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();
      return !!response.Success;
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
