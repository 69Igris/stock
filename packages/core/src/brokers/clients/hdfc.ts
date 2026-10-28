/**
 * HDFC Securities Client
 *
 * OAuth2 redirect flow. Token expires at midnight IST.
 * Auth header: Authorization: Bearer {access_token}
 *
 * API docs: https://developer.hdfcsec.com/docs
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

export class HdfcClient extends BaseBrokerClient {
  constructor(credentials: BrokerCredentials) {
    super("HDFC", credentials);
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.credentials.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  static getLoginUrl(apiKey: string, redirectUri: string): string {
    const params = new URLSearchParams({
      api_key: apiKey,
      redirect_uri: redirectUri,
      response_type: "code",
    });
    return `https://developer.hdfcsec.com/oapi/v1/authorize?${params.toString()}`;
  }

  static async exchangeToken(
    apiKey: string,
    apiSecret: string,
    requestToken: string,
    redirectUri: string,
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    userId?: string;
    expiresIn: number;
  }> {
    const response = await fetch(
      "https://developer.hdfcsec.com/oapi/v1/session/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: apiKey,
          request_token: requestToken,
          secret_key: apiSecret,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `HDFC token exchange failed: ${response.status} - ${error}`,
      );
    }

    // HDFC /session/token wire shape. Everything is optional because the
    // existing `!data.access_token` guard below is what actually proves the
    // token is present — the guard narrows it to `string` for the return.
    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      user_id?: string;
      client_id?: string;
      message?: string;
    };
    if (!data.access_token) {
      throw new Error(data.message || "No access token returned from HDFC");
    }

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      userId: data.user_id || data.client_id,
      expiresIn: 86400, // 1 day
    };
  }

  async getProfile(): Promise<BrokerProfile> {
    const response = await this.makeRequest<any>("/user/profile");
    const data = response.data || response;
    return {
      userId: data.user_id || data.client_id || "",
      userName: data.name || data.user_name || "",
      email: data.email || "",
      phone: data.phone || "",
      broker: "HDFC",
      exchanges: data.exchanges || ["NSE", "BSE"],
      products: [],
    };
  }

  async getHoldings(): Promise<NormalizedHolding[]> {
    const response = await this.makeRequest<any>("/portfolio/holdings");
    return (response.data || []).map((h: any) => ({
      symbol: h.tradingsymbol || h.symbol || "",
      tradingSymbol: h.tradingsymbol || "",
      isin: h.isin || "",
      exchange: h.exchange || "NSE",
      quantity: h.quantity || 0,
      averagePrice: h.average_price || 0,
      currentPrice: h.last_price || h.ltp || 0,
      investedValue: (h.quantity || 0) * (h.average_price || 0),
      currentValue: (h.quantity || 0) * (h.last_price || h.ltp || 0),
      pnl: h.pnl || 0,
      pnlPercentage: h.pnl_percentage || 0,
      dayChange: h.day_change || 0,
      dayChangePercentage: h.day_change_percentage || 0,
    }));
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const response = await this.makeRequest<any>("/portfolio/positions");
    return (response.data || []).map((p: any) => ({
      symbol: p.tradingsymbol || "",
      tradingSymbol: p.tradingsymbol || "",
      exchange: p.exchange || "NSE",
      segment: p.instrument_type || "EQUITY",
      productType: p.product || "CNC",
      positionType: "DAY" as const,
      quantity: p.quantity || p.net_quantity || 0,
      buyQuantity: p.buy_quantity || 0,
      sellQuantity: p.sell_quantity || 0,
      buyPrice: p.buy_price || p.buy_average || 0,
      sellPrice: p.sell_price || p.sell_average || 0,
      averagePrice: p.average_price || 0,
      lastPrice: p.last_price || p.ltp || 0,
      pnl: p.pnl || p.m2m || 0,
      pnlPercentage: 0,
      multiplier: p.multiplier || 1,
    }));
  }

  async getTrades(): Promise<NormalizedTrade[]> {
    const response = await this.makeRequest<any>("/trades");
    return (response.data || []).map((t: any) => ({
      tradeId: t.trade_id || t.fill_id || "",
      orderId: t.order_id || "",
      symbol: t.tradingsymbol || "",
      tradingSymbol: t.tradingsymbol || "",
      exchange: t.exchange || "NSE",
      segment: t.instrument_type || "EQUITY",
      transactionType: (t.transaction_type || "BUY") as "BUY" | "SELL",
      quantity: t.quantity || t.filled_quantity || 0,
      price: t.price || t.average_price || 0,
      value: (t.quantity || 0) * (t.price || t.average_price || 0),
      tradeTime: t.fill_timestamp ? new Date(t.fill_timestamp) : new Date(),
      productType: t.product || "CNC",
      orderType: t.order_type || "MARKET",
    }));
  }

  async getOrders(): Promise<NormalizedOrder[]> {
    const response = await this.makeRequest<any>("/orders");
    return (response.data || []).map((o: any) => ({
      orderId: o.order_id || "",
      symbol: o.tradingsymbol || "",
      tradingSymbol: o.tradingsymbol || "",
      exchange: o.exchange || "NSE",
      segment: o.instrument_type || "EQUITY",
      transactionType: (o.transaction_type || "BUY") as "BUY" | "SELL",
      quantity: o.quantity || 0,
      filledQuantity: o.filled_quantity || 0,
      pendingQuantity: o.pending_quantity || 0,
      price: o.price || 0,
      averagePrice: o.average_price || 0,
      status: o.status || "PENDING",
      orderType: o.order_type || "MARKET",
      productType: o.product || "CNC",
      orderTime: o.order_timestamp ? new Date(o.order_timestamp) : new Date(),
    }));
  }

  async getMargins(): Promise<NormalizedMargins> {
    try {
      const response = await this.makeRequest<any>("/user/margins");
      const data = response.data || response;
      const available = data.available_cash || data.net || 0;
      const used = data.used_margin || data.utilised || 0;
      return {
        availableCash: available,
        usedMargin: used,
        totalMargin: available + used,
        collateral: data.collateral || 0,
      };
    } catch {
      return { availableCash: 0, usedMargin: 0, totalMargin: 0, collateral: 0 };
    }
  }

  async getMutualFunds(): Promise<NormalizedMutualFund[]> {
    try {
      const response = await this.makeRequest<any>("/portfolio/mf-holdings");
      return (response.data || []).map((mf: any) => ({
        fundName: mf.fund_name || mf.scheme_name || "",
        schemeName: mf.scheme_name || "",
        isin: mf.isin || "",
        folio: mf.folio_no || mf.folio || "",
        units: mf.units || mf.quantity || 0,
        averageNav: mf.average_nav || mf.purchase_price || 0,
        currentNav: mf.current_nav || mf.nav || 0,
        investedValue: (mf.units || 0) * (mf.average_nav || 0),
        currentValue: (mf.units || 0) * (mf.current_nav || mf.nav || 0),
        pnl: mf.pnl || 0,
        pnlPercentage: mf.returns_percentage || 0,
      }));
    } catch {
      return [];
    }
  }
}
