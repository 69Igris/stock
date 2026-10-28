/**
 * Dhan Adapter
 * Direct API token | 30-day validity | No OAuth flow
 * Docs: https://dhanhq.co/docs/v1/
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

const BROKER_INFO: BrokerInfo = {
  id: "DHAN",
  name: "Dhan",
  description: "Fast trading platform with super-fast order execution",
  color: "#00D09C",
  segments: ["Equity", "F&O", "Currency", "Commodity"],
  features: ["Holdings", "Positions", "Orders", "Trades"],
  cost: "FREE",
  tokenExpiry: "30 days",
  autoRefresh: false,
  mfSupport: false,
  docsUrl: "https://dhanhq.co/docs/v1/",
};

/**
 * Normalize a raw Dhan holding record into our HoldingData shape.
 * Pure (no I/O); `fetchHoldings` maps each raw row through this so the same
 * code path runs whether driven by a live API response or a unit test.
 */
export function normalizeDhanHolding(h: Record<string, unknown>): HoldingData {
  return {
    symbol: h.tradingSymbol as string,
    tradingSymbol: h.tradingSymbol as string,
    isin: h.isin as string,
    exchange: h.exchange as string,
    totalQuantity: h.totalQty as number,
    freeQuantity: h.availableQty as number,
    t1Quantity: (h.t1Qty as number) || 0,
    pledgedQuantity: 0,
    averagePrice: h.avgCostPrice as number,
    lastPrice: h.lastTradedPrice as number,
    closePrice: h.lastTradedPrice as number,
    pnl: h.unrealizedProfit as number,
    pnlPercentage:
      (h.avgCostPrice as number) > 0
        ? (((h.lastTradedPrice as number) - (h.avgCostPrice as number)) /
            (h.avgCostPrice as number)) *
          100
        : 0,
    product: "CNC",
  } as HoldingData;
}

/**
 * Normalize a raw Dhan position record into our PositionData shape. Pure.
 */
export function normalizeDhanPosition(
  p: Record<string, unknown>,
): PositionData {
  return {
    symbol: p.tradingSymbol as string,
    tradingSymbol: p.tradingSymbol as string,
    exchange: p.exchangeSegment as string,
    segment: p.exchangeSegment === "NSE_EQ" ? "CASH" : "FNO",
    positionType: p.positionType === "LONG" ? "NET" : "DAY",
    productType: p.productType as string,
    buyQuantity: p.buyQty as number,
    sellQuantity: p.sellQty as number,
    netQuantity: p.netQty as number,
    buyPrice: p.buyAvg as number,
    sellPrice: p.sellAvg as number,
    averagePrice: p.costPrice as number,
    lastPrice: p.lastTradedPrice as number,
    realizedPnl: p.realizedProfit as number,
    unrealizedPnl: p.unrealizedProfit as number,
  } as PositionData;
}

/**
 * Normalize a raw Dhan order record into our OrderData shape. Pure.
 */
export function normalizeDhanOrder(o: Record<string, unknown>): OrderData {
  return {
    orderId: o.orderId as string,
    symbol: o.tradingSymbol as string,
    tradingSymbol: o.tradingSymbol as string,
    exchange: o.exchangeSegment as string,
    segment: o.exchangeSegment === "NSE_EQ" ? "CASH" : "FNO",
    orderType: o.orderType as string,
    transactionType: o.transactionType as "BUY" | "SELL",
    productType: o.productType as string,
    variety: "regular",
    quantity: o.quantity as number,
    filledQuantity: o.filledQty as number,
    price: o.price as number,
    triggerPrice: o.triggerPrice as number,
    averagePrice: o.avgTradedPrice as number,
    status: o.orderStatus as string,
    validity: o.validity as string,
    orderTime: new Date(o.orderTimestamp as string),
  } as OrderData;
}

/**
 * Normalize a raw Dhan trade record into our TradeData shape. Pure.
 * Charges are the broker's fixed equity-delivery estimate.
 */
export function normalizeDhanTrade(t: Record<string, unknown>): TradeData {
  const tradeValue = (t.tradedQty as number) * (t.tradedPrice as number);
  return {
    tradeId: t.tradeId as string,
    orderId: t.orderId as string,
    symbol: t.tradingSymbol as string,
    tradingSymbol: t.tradingSymbol as string,
    exchange: t.exchangeSegment as string,
    segment: t.exchangeSegment === "NSE_EQ" ? "CASH" : "FNO",
    transactionType: t.transactionType as "BUY" | "SELL",
    productType: t.productType as string,
    quantity: t.tradedQty as number,
    price: t.tradedPrice as number,
    tradeValue,
    brokerage: 20,
    exchangeFee: 0,
    gst: 3.6,
    sebiCharges: 0,
    stampDuty: 0,
    transactionTax: 0,
    totalCharges: 23.6,
    netAmount: tradeValue,
    tradeTime: new Date(t.tradeTimestamp as string),
  } as TradeData;
}

export class DhanAdapter extends BaseBrokerAdapter {
  private readonly baseUrl = "https://api.dhan.co/v2";

  constructor() {
    super("DHAN", BROKER_INFO);
  }

  private getClientId(): string {
    return process.env.DHAN_CLIENT_ID || "";
  }

  getAuthUrl(): string {
    return "https://dhanhq.co/tradingview";
  }

  async authenticate(
    apiToken: string,
    _redirectUri: string,
    additionalData?: Record<string, unknown>,
  ): Promise<AuthResult> {
    if (shouldUseMockData("DHAN")) {
      return {
        success: true,
        accessToken: "mock_dhan_token_" + Date.now(),
        expiresAt: this.addDays(30),
        metadata: {
          clientId: (additionalData?.clientId as string) || "MOCK_USER",
          broker: "Dhan",
        },
      };
    }

    try {
      const response = await ky
        .get(`${this.baseUrl}/profile`, {
          headers: {
            "access-token": apiToken,
            "client-id":
              (additionalData?.clientId as string) || this.getClientId(),
          },
        })
        .json<Record<string, unknown>>();

      if (response.dhanClientId) {
        return {
          success: true,
          accessToken: apiToken,
          expiresAt: this.addDays(30),
          metadata: { clientId: response.dhanClientId, name: response.name },
        };
      }
      return { success: false, error: "Invalid credentials" };
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message || "Authentication failed" };
    }
  }

  async refreshAccessToken(): Promise<AuthResult> {
    return {
      success: false,
      error: "Dhan requires manual token renewal every 30 days",
    };
  }

  private getAuthHeaders(
    credentials: BrokerCredentials,
  ): Record<string, string> {
    return {
      "access-token": credentials.accessToken || "",
      "client-id": credentials.clientId || this.getClientId(),
    };
  }

  async fetchHoldings(credentials: BrokerCredentials): Promise<HoldingData[]> {
    if (shouldUseMockData("DHAN")) return generateMockHoldings(8);

    try {
      const response = await ky
        .get(`${this.baseUrl}/holdings`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Array<Record<string, unknown>>>();

      return (response || []).map((h) => normalizeDhanHolding(h));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch holdings: ${err.message}`);
    }
  }

  async fetchPositions(
    credentials: BrokerCredentials,
  ): Promise<PositionData[]> {
    if (shouldUseMockData("DHAN")) return generateMockPositions(4);

    try {
      const response = await ky
        .get(`${this.baseUrl}/positions`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Array<Record<string, unknown>>>();

      return (response || []).map((p) => normalizeDhanPosition(p));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch positions: ${err.message}`);
    }
  }

  async fetchOrders(credentials: BrokerCredentials): Promise<OrderData[]> {
    if (shouldUseMockData("DHAN")) return generateMockOrders(10);

    try {
      const response = await ky
        .get(`${this.baseUrl}/orders`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Array<Record<string, unknown>>>();

      return (response || []).map((o) => normalizeDhanOrder(o));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch orders: ${err.message}`);
    }
  }

  async fetchTrades(credentials: BrokerCredentials): Promise<TradeData[]> {
    if (shouldUseMockData("DHAN")) return generateMockTrades(15);

    try {
      const response = await ky
        .get(`${this.baseUrl}/trades`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Array<Record<string, unknown>>>();

      return (response || []).map((t) => normalizeDhanTrade(t));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch trades: ${err.message}`);
    }
  }

  async fetchMutualFunds(): Promise<MutualFundData[]> {
    return [];
  }

  async validateToken(credentials: BrokerCredentials): Promise<boolean> {
    if (shouldUseMockData("DHAN")) return true;

    try {
      const response = await ky
        .get(`${this.baseUrl}/profile`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();
      return !!response.dhanClientId;
    } catch {
      return false;
    }
  }

  supportsAutoRefresh(): boolean {
    return false;
  }

  getRefreshStrategy(): RefreshStrategy {
    return "MONTHLY";
  }

  getTokenExpiryDuration(): number {
    return 30 * 24 * 60 * 60 * 1000; // 30 days
  }
}
