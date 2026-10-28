/**
 * Fyers API Client
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
import crypto from "crypto";

export class FyersClient extends BaseBrokerClient {
  private appId: string;

  constructor(credentials: BrokerCredentials) {
    super("FYERS", credentials);
    this.appId = credentials.apiKey || process.env.FYERS_APP_ID || "";
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `${this.appId}:${this.credentials.accessToken}`,
      "Content-Type": "application/json",
    };
  }

  async getProfile(): Promise<BrokerProfile> {
    const response = await this.makeRequest<any>("/profile");
    return {
      userId: response.data?.fy_id || "",
      userName: response.data?.name || "",
      email: response.data?.email_id || "",
      phone: response.data?.mobile_number || "",
      broker: "FYERS",
      exchanges: ["NSE", "BSE", "NFO", "MCX"],
      products: ["CNC", "INTRADAY", "MARGIN"],
    };
  }

  async getHoldings(): Promise<NormalizedHolding[]> {
    const response = await this.makeRequest<any>("/holdings");
    return (response.holdings || []).map((h: any) => {
      const invested = h.quantity * h.costPrice;
      const current = h.quantity * h.ltp;
      return {
        symbol: h.symbol?.split(":")[1] || h.symbol,
        tradingSymbol: h.symbol,
        isin: h.isin,
        exchange: h.symbol?.split(":")[0] || "NSE",
        quantity: h.quantity,
        averagePrice: h.costPrice,
        currentPrice: h.ltp,
        investedValue: invested,
        currentValue: current,
        pnl: h.pl || current - invested,
        pnlPercentage: invested ? ((current - invested) / invested) * 100 : 0,
        dayChange: 0,
        dayChangePercentage: 0,
      };
    });
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const response = await this.makeRequest<any>("/positions");
    return (response.netPositions || []).map((p: any) => ({
      symbol: p.symbol?.split(":")[1] || p.symbol,
      tradingSymbol: p.symbol,
      exchange: p.symbol?.split(":")[0] || "NSE",
      segment: p.segment,
      productType: p.productType,
      positionType: "NET" as const,
      quantity: p.qty,
      buyQuantity: p.buyQty,
      sellQuantity: p.sellQty,
      buyPrice: p.buyAvg,
      sellPrice: p.sellAvg,
      averagePrice: p.avgPrice,
      lastPrice: p.ltp,
      pnl: p.pl,
      pnlPercentage: p.avgPrice
        ? (p.pl / (Math.abs(p.qty) * p.avgPrice)) * 100
        : 0,
    }));
  }

  async getTrades(fromDate?: Date, toDate?: Date): Promise<NormalizedTrade[]> {
    const response = await this.makeRequest<any>("/tradebook");
    return (response.tradeBook || []).map((t: any) => ({
      tradeId: t.tradeNumber,
      orderId: t.orderNumber,
      symbol: t.symbol?.split(":")[1] || t.symbol,
      tradingSymbol: t.symbol,
      exchange: t.exchange,
      segment: t.segment,
      transactionType: t.side === 1 ? "BUY" : ("SELL" as "BUY" | "SELL"),
      quantity: t.tradedQty,
      price: t.tradePrice,
      value: t.tradedQty * t.tradePrice,
      tradeTime: new Date(t.orderDateTime),
      productType: t.productType,
      orderType: t.orderType,
    }));
  }

  async getOrders(): Promise<NormalizedOrder[]> {
    const response = await this.makeRequest<any>("/orders");
    return (response.orderBook || []).map((o: any) => ({
      orderId: o.id,
      symbol: o.symbol?.split(":")[1] || o.symbol,
      tradingSymbol: o.symbol,
      exchange: o.exchange,
      segment: o.segment,
      transactionType: o.side === 1 ? "BUY" : ("SELL" as "BUY" | "SELL"),
      orderType: this.mapOrderType(o.type),
      productType: o.productType,
      quantity: o.qty,
      price: o.limitPrice,
      triggerPrice: o.stopPrice,
      filledQuantity: o.filledQty,
      pendingQuantity: o.remainingQuantity,
      status: this.mapOrderStatus(o.status),
      statusMessage: o.message,
      orderTime: new Date(o.orderDateTime),
    }));
  }

  async getMargins(): Promise<NormalizedMargins> {
    const response = await this.makeRequest<any>("/funds");
    return {
      availableCash: response.fund_limit?.[0]?.equityAmount || 0,
      usedMargin: response.fund_limit?.[0]?.utilizedAmount || 0,
      totalMargin: response.fund_limit?.[0]?.totalBalance || 0,
      collateral: 0,
    };
  }

  private mapOrderType(type: number): "MARKET" | "LIMIT" | "SL" | "SL-M" {
    const mapping: Record<number, "MARKET" | "LIMIT" | "SL" | "SL-M"> = {
      1: "LIMIT",
      2: "MARKET",
      3: "SL",
      4: "SL-M",
    };
    return mapping[type] || "MARKET";
  }

  private mapOrderStatus(
    status: number,
  ): "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED" {
    const mapping: Record<
      number,
      "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED"
    > = {
      1: "CANCELLED",
      2: "COMPLETE",
      4: "OPEN",
      5: "REJECTED",
      6: "PENDING",
    };
    return mapping[status] || "PENDING";
  }

  // Static method to generate login URL
  static getLoginUrl(
    appId: string,
    redirectUri: string,
    state?: string,
  ): string {
    const params = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: "code",
      state: state || "fyers_auth",
    });
    return `https://api-t1.fyers.in/api/v3/generate-authcode?${params}`;
  }

  // Static method to exchange auth code for access token
  static async exchangeToken(
    appId: string,
    secretKey: string,
    authCode: string,
  ): Promise<{ accessToken: string; refreshToken?: string }> {
    const appIdHash = crypto
      .createHash("sha256")
      .update(`${appId}:${secretKey}`)
      .digest("hex");

    const response = await fetch(
      "https://api-t1.fyers.in/api/v3/validate-authcode",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "authorization_code",
          appIdHash,
          code: authCode,
        }),
      },
    );

    if (!response.ok) {
      // Message text preserved exactly (see brokerTransportFailure's note).
      throw brokerTransportFailure(
        "Fyers",
        response.status,
        "Failed to exchange token",
        await response.text().catch(() => undefined),
      );
    }

    // Fyers /validate-authcode wire shape. MONEY-1158: `access_token` is
    // optional because a 200 does NOT guarantee it — Fyers answers 200 with
    // `{ s: "error", message }` when the app is throttled or the auth code has
    // already been consumed, which used to persist `accessToken: undefined`.
    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      s?: string;
      message?: string;
    };
    return {
      accessToken: requireAccessToken("Fyers", data.access_token, data.message),
      refreshToken: data.refresh_token,
    };
  }
}
