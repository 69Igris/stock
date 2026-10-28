/**
 * Angel One (Angel Broking) Adapter
 * API Key + TOTP | Token expires at midnight | No auto-refresh
 * Docs: https://smartapi.angelone.in/docs
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
  id: "ANGEL_ONE",
  name: "Angel One",
  description: "Full-service broker with trading, advisory, and research",
  color: "#ED1C24",
  segments: ["Equity", "F&O", "Currency", "Commodity", "MF"],
  features: ["Holdings", "Positions", "Orders", "Trades", "MF"],
  cost: "FREE",
  tokenExpiry: "Until midnight (daily)",
  autoRefresh: false,
  mfSupport: true,
  docsUrl: "https://smartapi.angelone.in/docs",
};

/**
 * Normalize a raw Angel One holding record into our HoldingData shape.
 * Pure (no I/O); `fetchHoldings` maps each raw row through this so the same
 * code path runs whether driven by a live API response or a unit test.
 */
export function normalizeAngelOneHolding(
  h: Record<string, unknown>,
): HoldingData {
  return {
    symbol: h.tradingsymbol as string,
    tradingSymbol: h.tradingsymbol as string,
    isin: h.isin as string,
    exchange: h.exchange as string,
    totalQuantity: h.quantity as number,
    freeQuantity: (h.quantity as number) - ((h.t1quantity as number) || 0),
    t1Quantity: (h.t1quantity as number) || 0,
    pledgedQuantity: (h.collateralquantity as number) || 0,
    averagePrice: h.averageprice as number,
    lastPrice: h.ltp as number,
    closePrice: h.close as number,
    pnl: h.profitandloss as number,
    pnlPercentage: h.pnlpercentage as number,
    product: h.product as string,
  } as HoldingData;
}

/**
 * Normalize a raw Angel One position record into our PositionData shape. Pure.
 */
export function normalizeAngelOnePosition(
  p: Record<string, unknown>,
): PositionData {
  return {
    symbol: p.tradingsymbol as string,
    tradingSymbol: p.tradingsymbol as string,
    exchange: p.exchange as string,
    segment: (p.symboltoken as string)?.startsWith("NSE") ? "CASH" : "FNO",
    positionType: "NET",
    productType: p.producttype as string,
    buyQuantity: p.buyqty as number,
    sellQuantity: p.sellqty as number,
    netQuantity: p.netqty as number,
    buyPrice: p.buyavgprice as number,
    sellPrice: p.sellavgprice as number,
    averagePrice: p.avgnetprice as number,
    lastPrice: p.ltp as number,
    realizedPnl: p.realised as number,
    unrealizedPnl: p.unrealised as number,
  } as PositionData;
}

/**
 * Normalize a raw Angel One order record into our OrderData shape. Pure.
 */
export function normalizeAngelOneOrder(o: Record<string, unknown>): OrderData {
  return {
    orderId: o.orderid as string,
    symbol: o.tradingsymbol as string,
    tradingSymbol: o.tradingsymbol as string,
    exchange: o.exchange as string,
    segment: (o.symboltoken as string)?.startsWith("NSE") ? "CASH" : "FNO",
    orderType: o.ordertype as string,
    transactionType: o.transactiontype as "BUY" | "SELL",
    productType: o.producttype as string,
    variety: o.variety as string,
    quantity: o.quantity as number,
    filledQuantity: o.filledshares as number,
    price: o.price as number,
    triggerPrice: o.triggerprice as number,
    averagePrice: o.averageprice as number,
    status: o.status as string,
    statusMessage: o.text as string,
    validity: o.validity as string,
    orderTime: new Date((o.ordertime as string) || (o.updatetime as string)),
  } as OrderData;
}

/**
 * Normalize a raw Angel One trade record into our TradeData shape. Pure.
 * Charges are the broker's fixed equity-delivery estimate.
 */
export function normalizeAngelOneTrade(t: Record<string, unknown>): TradeData {
  const tradeValue = (t.fillshares as number) * (t.fillprice as number);
  return {
    tradeId: t.tradeid as string,
    orderId: t.orderid as string,
    symbol: t.tradingsymbol as string,
    tradingSymbol: t.tradingsymbol as string,
    exchange: t.exchange as string,
    segment: (t.symboltoken as string)?.startsWith("NSE") ? "CASH" : "FNO",
    transactionType: t.transactiontype as "BUY" | "SELL",
    productType: t.producttype as string,
    quantity: t.fillshares as number,
    price: t.fillprice as number,
    tradeValue,
    brokerage: 20,
    exchangeFee: 0,
    gst: 3.6,
    sebiCharges: 0,
    stampDuty: 0,
    transactionTax: 0,
    totalCharges: 23.6,
    netAmount: tradeValue,
    tradeTime: new Date(
      (t.filltime as string) || (t.exchangeorderupdatetime as string),
    ),
  } as TradeData;
}

export class AngelOneAdapter extends BaseBrokerAdapter {
  private readonly baseUrl = "https://apiconnect.angelone.in";

  constructor() {
    super("ANGEL_ONE", BROKER_INFO);
  }

  private getApiKey(): string {
    return process.env.ANGEL_API_KEY || "";
  }

  getAuthUrl(): string {
    return "https://smartapi.angelone.in/";
  }

  async authenticate(
    clientCode: string,
    _redirectUri: string,
    additionalData?: Record<string, unknown>,
  ): Promise<AuthResult> {
    if (shouldUseMockData("ANGEL_ONE")) {
      return {
        success: true,
        accessToken: "mock_angel_token_" + Date.now(),
        refreshToken: "mock_angel_refresh_" + Date.now(),
        expiresAt: this.getEndOfDay(),
        metadata: { clientCode, userName: "Demo User", broker: "Angel One" },
      };
    }

    try {
      const response = await ky
        .post(
          `${this.baseUrl}/rest/auth/angelbroking/user/v1/loginByPassword`,
          {
            json: {
              clientcode: clientCode,
              password: additionalData?.password,
              totp: additionalData?.totp,
            },
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "X-UserType": "USER",
              "X-SourceID": "WEB",
              "X-ClientLocalIP": "127.0.0.1",
              "X-ClientPublicIP": "127.0.0.1",
              "X-MACAddress": "00:00:00:00:00:00",
              "X-PrivateKey": this.getApiKey(),
            },
          },
        )
        .json<Record<string, unknown>>();

      if (response.status && response.data) {
        const data = response.data as Record<string, unknown>;
        return {
          success: true,
          accessToken: data.jwtToken as string,
          refreshToken: data.refreshToken as string,
          expiresAt: this.getEndOfDay(),
          metadata: {
            clientCode: data.clientcode,
            name: data.name,
            email: data.email,
            exchanges: data.exchanges,
          },
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
    // SmartAPI DOES support refresh via /rest/auth/angelbroking/jwt/v1/generateTokens
    // (verified 2026-04-09 against official Python/Node SDKs). The refresh
    // token from login can generate new JWTs without TOTP.
    const refreshToken = credentials.refreshToken;
    if (!refreshToken) {
      return {
        success: false,
        error: "No refresh token available - TOTP re-authentication required",
      };
    }

    try {
      const response = await ky
        .post(`${this.baseUrl}/rest/auth/angelbroking/jwt/v1/generateTokens`, {
          json: { refreshToken },
          headers: this.getAuthHeaders(credentials),
        })
        .json<{
          status: boolean;
          data?: { jwtToken?: string; refreshToken?: string };
        }>();

      if (response.status && response.data?.jwtToken) {
        return {
          success: true,
          accessToken: response.data.jwtToken,
          refreshToken: response.data.refreshToken || refreshToken,
          expiresAt: this.getEndOfDay(),
        };
      }
      return {
        success: false,
        error: "generateTokens returned no jwtToken",
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || "Token refresh failed",
      };
    }
  }

  private getAuthHeaders(
    credentials: BrokerCredentials,
  ): Record<string, string> {
    return {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": "127.0.0.1",
      "X-MACAddress": "00:00:00:00:00:00",
      "X-PrivateKey": this.getApiKey(),
    };
  }

  async fetchHoldings(credentials: BrokerCredentials): Promise<HoldingData[]> {
    if (shouldUseMockData("ANGEL_ONE")) return generateMockHoldings(8);

    try {
      const response = await ky
        .get(
          `${this.baseUrl}/rest/secure/angelbroking/portfolio/v1/getAllHolding`,
          {
            headers: this.getAuthHeaders(credentials),
          },
        )
        .json<Record<string, unknown>>();

      const data = response.data as Record<string, unknown>;
      const holdings = (data?.holdings || []) as Array<Record<string, unknown>>;
      return holdings.map((h) => normalizeAngelOneHolding(h));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch holdings: ${err.message}`);
    }
  }

  async fetchPositions(
    credentials: BrokerCredentials,
  ): Promise<PositionData[]> {
    if (shouldUseMockData("ANGEL_ONE")) return generateMockPositions(4);

    try {
      const response = await ky
        .get(`${this.baseUrl}/rest/secure/angelbroking/order/v1/getPosition`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const positions = (response.data || []) as Array<Record<string, unknown>>;
      return positions.map((p) => normalizeAngelOnePosition(p));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch positions: ${err.message}`);
    }
  }

  async fetchOrders(credentials: BrokerCredentials): Promise<OrderData[]> {
    if (shouldUseMockData("ANGEL_ONE")) return generateMockOrders(10);

    try {
      const response = await ky
        .get(`${this.baseUrl}/rest/secure/angelbroking/order/v1/getOrderBook`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const orders = (response.data || []) as Array<Record<string, unknown>>;
      return orders.map((o) => normalizeAngelOneOrder(o));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch orders: ${err.message}`);
    }
  }

  async fetchTrades(credentials: BrokerCredentials): Promise<TradeData[]> {
    if (shouldUseMockData("ANGEL_ONE")) return generateMockTrades(15);

    try {
      const response = await ky
        .get(`${this.baseUrl}/rest/secure/angelbroking/order/v1/getTradeBook`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const trades = (response.data || []) as Array<Record<string, unknown>>;
      return trades.map((t) => normalizeAngelOneTrade(t));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch trades: ${err.message}`);
    }
  }

  async fetchMutualFunds(
    _credentials: BrokerCredentials,
  ): Promise<MutualFundData[]> {
    if (shouldUseMockData("ANGEL_ONE")) return generateMockMutualFunds(5);
    return [];
  }

  async validateToken(credentials: BrokerCredentials): Promise<boolean> {
    if (shouldUseMockData("ANGEL_ONE")) return true;

    try {
      const response = await ky
        .get(`${this.baseUrl}/rest/secure/angelbroking/user/v1/getProfile`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();
      return response.status === true;
    } catch {
      return false;
    }
  }

  supportsAutoRefresh(): boolean {
    return true; // generateTokens API refreshes without TOTP
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
