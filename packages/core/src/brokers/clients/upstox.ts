/**
 * Upstox API Client
 */

import { BaseBrokerClient, BrokerCredentials } from "./base-client";
import { brokerTransportFailure, requireAccessToken } from "./token-exchange";
import {
  NormalizedHolding,
  NormalizedPosition,
  NormalizedTrade,
  NormalizedOrder,
  NormalizedMargins,
  BrokerProfile,
} from "@usemoney/types";

export class UpstoxClient extends BaseBrokerClient {
  constructor(credentials: BrokerCredentials) {
    super("UPSTOX", credentials);
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.credentials.accessToken}`,
      Accept: "application/json",
    };
  }

  async getProfile(): Promise<BrokerProfile> {
    const response = await this.makeRequest<any>("/user/profile");
    return {
      userId: response.data.user_id,
      userName: response.data.user_name,
      email: response.data.email,
      phone: response.data.phone,
      broker: "UPSTOX",
      exchanges: response.data.exchanges || [],
      products: response.data.products || [],
    };
  }

  async getHoldings(): Promise<NormalizedHolding[]> {
    const response = await this.makeRequest<any>(
      "/portfolio/long-term-holdings",
    );
    return (response.data || []).map((h: any) => ({
      symbol: h.tradingsymbol,
      tradingSymbol: h.tradingsymbol,
      isin: h.isin,
      exchange: h.exchange,
      quantity: h.quantity,
      averagePrice: h.average_price,
      currentPrice: h.last_price,
      investedValue: h.quantity * h.average_price,
      currentValue: h.quantity * h.last_price,
      pnl: h.pnl,
      pnlPercentage: h.pnl ? (h.pnl / (h.quantity * h.average_price)) * 100 : 0,
      dayChange: h.day_change || 0,
      dayChangePercentage: h.day_change_percentage || 0,
    }));
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const response = await this.makeRequest<any>(
      "/portfolio/short-term-positions",
    );
    return (response.data || []).map((p: any) => ({
      symbol: p.tradingsymbol,
      tradingSymbol: p.tradingsymbol,
      exchange: p.exchange,
      segment: p.instrument_type,
      productType: p.product,
      positionType: "DAY" as const,
      quantity: p.quantity,
      buyQuantity: p.day_buy_quantity,
      sellQuantity: p.day_sell_quantity,
      buyPrice: p.day_buy_price,
      sellPrice: p.day_sell_price,
      averagePrice: p.average_price,
      lastPrice: p.last_price,
      pnl: p.pnl,
      pnlPercentage: p.average_price
        ? (p.pnl / (Math.abs(p.quantity) * p.average_price)) * 100
        : 0,
      multiplier: p.multiplier,
    }));
  }

  async getTrades(fromDate?: Date, toDate?: Date): Promise<NormalizedTrade[]> {
    const response = await this.makeRequest<any>(
      "/order/trades/get-trades-for-day",
    );
    return (response.data || []).map((t: any) => ({
      tradeId: t.trade_id,
      orderId: t.order_id,
      symbol: t.tradingsymbol,
      tradingSymbol: t.tradingsymbol,
      exchange: t.exchange,
      segment: t.instrument_type,
      transactionType: t.transaction_type as "BUY" | "SELL",
      quantity: t.quantity,
      price: t.price,
      value: t.quantity * t.price,
      tradeTime: new Date(t.trade_date),
      productType: t.product,
      orderType: t.order_type,
    }));
  }

  async getOrders(): Promise<NormalizedOrder[]> {
    const response = await this.makeRequest<any>("/order/retrieve-all");
    return (response.data || []).map((o: any) => ({
      orderId: o.order_id,
      symbol: o.tradingsymbol,
      tradingSymbol: o.tradingsymbol,
      exchange: o.exchange,
      segment: o.instrument_type,
      transactionType: o.transaction_type as "BUY" | "SELL",
      orderType: o.order_type as "MARKET" | "LIMIT" | "SL" | "SL-M",
      productType: o.product,
      quantity: o.quantity,
      price: o.price,
      triggerPrice: o.trigger_price,
      filledQuantity: o.filled_quantity,
      pendingQuantity: o.quantity - o.filled_quantity,
      status: this.mapOrderStatus(o.status),
      statusMessage: o.status_message,
      orderTime: new Date(o.order_timestamp),
    }));
  }

  async getMargins(): Promise<NormalizedMargins> {
    const response = await this.makeRequest<any>("/user/get-funds-and-margin");
    const data = response.data?.equity || {};
    return {
      availableCash: data.available_margin || 0,
      usedMargin: data.used_margin || 0,
      totalMargin: (data.available_margin || 0) + (data.used_margin || 0),
      collateral: data.collateral || 0,
    };
  }

  private mapOrderStatus(
    status: string,
  ): "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED" {
    const mapping: Record<
      string,
      "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED"
    > = {
      pending: "PENDING",
      open: "OPEN",
      complete: "COMPLETE",
      cancelled: "CANCELLED",
      rejected: "REJECTED",
      "trigger pending": "PENDING",
    };
    return mapping[status.toLowerCase()] || "PENDING";
  }

  // Static method to generate login URL
  static getLoginUrl(apiKey: string, redirectUri: string): string {
    return `https://api.upstox.com/v2/login/authorization/dialog?response_type=code&client_id=${apiKey}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  // Static method to exchange authorization code for access token
  static async exchangeToken(
    apiKey: string,
    apiSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn: number;
  }> {
    const response = await fetch(
      "https://api.upstox.com/v2/login/authorization/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          code,
          client_id: apiKey,
          client_secret: apiSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      },
    );

    if (!response.ok) {
      // Message text preserved exactly — `classifyBrokerError` derives
      // errorClass/recoveryAction by substring, so rewording it here would
      // silently reclassify existing failures.
      const error = await response.text().catch(() => "");
      throw brokerTransportFailure(
        "Upstox",
        response.status,
        `Failed to exchange token: ${error}`,
        error,
      );
    }

    // Upstox /login/authorization/token wire shape (OAuth2 token response).
    // MONEY-1158: `access_token` is OPTIONAL here on purpose. It used to be
    // declared non-optional, which only restated an unchecked assumption — a
    // 200 carrying an error envelope produced `accessToken: undefined`, which
    // was then encrypted and persisted as a working-looking BrokerConnection.
    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    return {
      accessToken: requireAccessToken(
        "Upstox",
        data.access_token,
        data.error_description || data.error,
      ),
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 86400 * 365, // Default 1 year
    };
  }
}
