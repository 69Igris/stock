/**
 * ICICI Direct (Breeze API) Client
 *
 * OAuth2 redirect flow. Token expires at midnight IST.
 * Auth headers: X-SessionToken, X-AppKey, X-SecretKey
 *
 * API docs: https://api.icicidirect.com/breezeapi/
 */

import { BaseBrokerClient, BrokerCredentials } from "./base-client";
import type {
  NormalizedHolding,
  NormalizedPosition,
  NormalizedTrade,
  NormalizedOrder,
  NormalizedMutualFund,
  NormalizedMargins,
  BrokerProfile,
} from "@usemoney/types";

export class IciciClient extends BaseBrokerClient {
  constructor(credentials: BrokerCredentials) {
    super("ICICI", credentials);
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      "X-SessionToken": this.credentials.accessToken || "",
      "X-AppKey": this.credentials.apiKey || "",
      "X-SecretKey": this.credentials.apiSecret || "",
      "Content-Type": "application/json",
    };
  }

  static getLoginUrl(apiKey: string, redirectUri: string): string {
    const params = new URLSearchParams({ api_key: apiKey });
    return `https://api.icicidirect.com/apiuser/login?${params.toString()}`;
  }

  static async exchangeToken(
    apiKey: string,
    apiSecret: string,
    sessionToken: string,
  ): Promise<{ accessToken: string; userId?: string }> {
    // Breeze API: the session_token from callback IS the access token
    // Validate it by calling customerdetails
    const response = await fetch(
      "https://api.icicidirect.com/breezeapi/api/v1/customerdetails",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, session_token: sessionToken }),
      },
    );
    // Breeze /customerdetails wire shape. `Success` is the payload envelope on
    // a successful auth; the `!data.Success` guard below is what proves it.
    const data = (await response.json()) as {
      Success?: { client_id?: string; demat_id?: string };
      Error?: string;
    };
    if (!data.Success) {
      throw new Error(data.Error || "ICICI Direct authentication failed");
    }
    return {
      accessToken: sessionToken,
      userId: data.Success?.client_id || data.Success?.demat_id,
    };
  }

  async getProfile(): Promise<BrokerProfile> {
    const response = await this.makeRequest<any>("/customerdetails");
    const data = response.Success || response.data || {};
    return {
      userId: data.client_id || data.demat_id || "",
      userName: data.name || "",
      email: data.email || "",
      phone: data.phone || "",
      broker: "ICICI",
      exchanges: data.exchanges || ["NSE", "BSE"],
      products: [],
    };
  }

  async getHoldings(): Promise<NormalizedHolding[]> {
    const response = await this.makeRequest<any>("/demat/holdings");
    return (response.Success || response.data || []).map((h: any) => ({
      symbol: h.stock_code || h.scrip_code || "",
      tradingSymbol: h.stock_code || "",
      isin: h.stock_ISIN || h.isin || "",
      exchange: h.exchange_code || "NSE",
      quantity: h.quantity || 0,
      averagePrice: h.average_price || h.buy_avg || 0,
      currentPrice: h.current_price || h.ltp || 0,
      investedValue: (h.quantity || 0) * (h.average_price || 0),
      currentValue: (h.quantity || 0) * (h.current_price || h.ltp || 0),
      pnl: h.pnl || 0,
      pnlPercentage: h.pnl_percentage || 0,
      dayChange: 0,
      dayChangePercentage: 0,
    }));
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const response = await this.makeRequest<any>("/positions");
    return (response.Success || response.data || []).map((p: any) => ({
      symbol: p.stock_code || "",
      tradingSymbol: p.stock_code || "",
      exchange: p.exchange_code || "NSE",
      segment: p.segment || "EQUITY",
      productType: p.product_type || "DELIVERY",
      positionType: "DAY" as const,
      quantity: p.quantity || 0,
      buyQuantity: p.buy_quantity || 0,
      sellQuantity: p.sell_quantity || 0,
      buyPrice: p.buy_price || p.buy_average_price || 0,
      sellPrice: p.sell_price || p.sell_average_price || 0,
      averagePrice: p.average_price || 0,
      lastPrice: p.ltp || 0,
      pnl: p.mtm || p.pnl || 0,
      pnlPercentage: 0,
      multiplier: p.lot_size || 1,
    }));
  }

  async getTrades(): Promise<NormalizedTrade[]> {
    const response = await this.makeRequest<any>("/tradebook");
    return (response.Success || response.data || []).map((t: any) => ({
      tradeId: t.trade_id || t.order_id || "",
      orderId: t.order_id || "",
      symbol: t.stock_code || "",
      tradingSymbol: t.stock_code || "",
      exchange: t.exchange_code || "NSE",
      segment: t.segment || "EQUITY",
      transactionType: (t.action || "BUY") as "BUY" | "SELL",
      quantity: t.quantity || 0,
      price: t.trade_price || t.price || 0,
      value: (t.quantity || 0) * (t.trade_price || t.price || 0),
      tradeTime: t.trade_date ? new Date(t.trade_date) : new Date(),
      productType: t.product_type || "DELIVERY",
      orderType: t.order_type || "MARKET",
    }));
  }

  async getOrders(): Promise<NormalizedOrder[]> {
    const response = await this.makeRequest<any>("/orderbook");
    return (response.Success || response.data || []).map((o: any) => ({
      orderId: o.order_id || "",
      symbol: o.stock_code || "",
      tradingSymbol: o.stock_code || "",
      exchange: o.exchange_code || "NSE",
      segment: o.segment || "EQUITY",
      transactionType: (o.action || "BUY") as "BUY" | "SELL",
      quantity: o.quantity || 0,
      filledQuantity: o.filled_quantity || 0,
      pendingQuantity: o.pending_quantity || 0,
      price: o.price || 0,
      averagePrice: o.average_price || 0,
      status: o.status || "PENDING",
      orderType: o.order_type || "MARKET",
      productType: o.product_type || "DELIVERY",
      orderTime: o.order_date ? new Date(o.order_date) : new Date(),
    }));
  }

  async getMargins(): Promise<NormalizedMargins> {
    return { availableCash: 0, usedMargin: 0, totalMargin: 0, collateral: 0 };
  }

  async getMutualFunds(): Promise<NormalizedMutualFund[]> {
    try {
      const response = await this.makeRequest<any>("/mutualfunds/holdings");
      return (response.Success || response.data || []).map((mf: any) => ({
        fundName: mf.scheme_name || mf.fund_name || "",
        schemeName: mf.scheme_name || "",
        isin: mf.isin || "",
        folio: mf.folio_no || "",
        units: mf.units || 0,
        averageNav: mf.avg_nav || mf.purchase_nav || 0,
        currentNav: mf.current_nav || mf.nav || 0,
        investedValue: (mf.units || 0) * (mf.avg_nav || 0),
        currentValue: (mf.units || 0) * (mf.current_nav || mf.nav || 0),
        pnl: mf.pnl || 0,
        pnlPercentage: mf.returns_percentage || 0,
      }));
    } catch (error) {
      // A real MF-feed failure must NOT be masked as "0 MFs / SUCCESS".
      // Rethrow so the sync layer's getMutualFunds catch
      // (broker-connection.ts) logs { error, broker, type: "mutualFunds" }
      // and records the failure (operation: sync_mutual_funds). This
      // low-level client must not depend on the logger / PostHog directly,
      // so logging stays at the sync layer.
      throw error;
    }
  }
}
