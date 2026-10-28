/**
 * Angel One SmartAPI Client
 *
 * TOTP-based auth (not OAuth). Token expires at midnight IST.
 * Requires custom headers on every request (X-UserType, X-SourceID,
 * X-ClientLocalIP, X-ClientPublicIP, X-MACAddress, X-PrivateKey).
 *
 * API docs: https://smartapi.angelone.in/docs
 */

import { BaseBrokerClient, BrokerCredentials } from "./base-client";
import type {
  NormalizedHolding,
  NormalizedPosition,
  NormalizedTrade,
  NormalizedOrder,
  NormalizedMargins,
  BrokerProfile,
} from "@usemoney/types";
import { syncLogger as logger } from "@usemoney/logger";

export class AngelOneClient extends BaseBrokerClient {
  constructor(credentials: BrokerCredentials) {
    super("ANGEL_ONE", credentials);
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.credentials.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": "127.0.0.1",
      "X-MACAddress": "00:00:00:00:00:00",
      "X-PrivateKey": this.credentials.apiKey || "",
    };
  }

  async getProfile(): Promise<BrokerProfile> {
    const response = await this.makeRequest<any>(
      "/rest/secure/angelbroking/user/v1/getProfile",
    );
    const data = response.data || {};
    return {
      userId: data.clientcode || data.userId || "",
      userName: data.name || "",
      email: data.email || "",
      phone: data.mobileno || "",
      broker: "ANGEL_ONE",
      exchanges: data.exchanges || [],
      products: data.producttype || [],
    };
  }

  async getHoldings(): Promise<NormalizedHolding[]> {
    const response = await this.makeRequest<any>(
      "/rest/secure/angelbroking/portfolio/v1/getAllHolding",
    );
    return (response.data || []).map((h: any) => ({
      symbol: h.tradingsymbol,
      tradingSymbol: h.tradingsymbol,
      isin: h.isin || "",
      exchange: h.exchange || "NSE",
      quantity: h.quantity || 0,
      averagePrice: h.averageprice || 0,
      currentPrice: h.ltp || 0,
      investedValue: (h.quantity || 0) * (h.averageprice || 0),
      currentValue: (h.quantity || 0) * (h.ltp || 0),
      pnl: h.profitandloss || 0,
      pnlPercentage: h.pnlpercentage || 0,
      dayChange: 0,
      dayChangePercentage: 0,
    }));
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const response = await this.makeRequest<any>(
      "/rest/secure/angelbroking/order/v1/getPosition",
    );
    return (response.data || []).map((p: any) => ({
      symbol: p.tradingsymbol,
      tradingSymbol: p.tradingsymbol,
      exchange: p.exchange || "NSE",
      segment: p.instrumenttype || "EQUITY",
      productType: p.producttype || "DELIVERY",
      positionType: "DAY" as const,
      quantity: p.netqty || 0,
      buyQuantity: p.buyqty || 0,
      sellQuantity: p.sellqty || 0,
      buyPrice: p.buyavgprice || 0,
      sellPrice: p.sellavgprice || 0,
      averagePrice: p.netprice || 0,
      lastPrice: p.ltp || 0,
      pnl: p.pnl || p.realised || 0,
      pnlPercentage: 0,
      multiplier: p.lotsize || 1,
    }));
  }

  async getTrades(): Promise<NormalizedTrade[]> {
    const response = await this.makeRequest<any>(
      "/rest/secure/angelbroking/order/v1/getTradeBook",
    );
    return (response.data || []).map((t: any) => ({
      tradeId: t.fillid || t.orderid || "",
      orderId: t.orderid || "",
      symbol: t.tradingsymbol,
      tradingSymbol: t.tradingsymbol,
      exchange: t.exchange || "NSE",
      segment: t.instrumenttype || "EQUITY",
      transactionType: (t.transactiontype || "BUY") as "BUY" | "SELL",
      quantity: t.fillshares || t.quantity || 0,
      price: t.fillprice || t.price || 0,
      value: (t.fillshares || t.quantity || 0) * (t.fillprice || t.price || 0),
      tradeTime: t.filltime ? new Date(t.filltime) : new Date(),
      productType: t.producttype || "DELIVERY",
      orderType: t.ordertype || "MARKET",
    }));
  }

  async getOrders(): Promise<NormalizedOrder[]> {
    const response = await this.makeRequest<any>(
      "/rest/secure/angelbroking/order/v1/getOrderBook",
    );
    return (response.data || []).map((o: any) => ({
      orderId: o.orderid || "",
      symbol: o.tradingsymbol,
      tradingSymbol: o.tradingsymbol,
      exchange: o.exchange || "NSE",
      segment: o.instrumenttype || "EQUITY",
      transactionType: (o.transactiontype || "BUY") as "BUY" | "SELL",
      quantity: o.quantity || 0,
      filledQuantity: o.filledshares || 0,
      pendingQuantity: o.unfilledshares || 0,
      price: o.price || 0,
      averagePrice: o.averageprice || 0,
      status: o.status || "PENDING",
      orderType: o.ordertype || "MARKET",
      productType: o.producttype || "DELIVERY",
      orderTime: o.orderupdatetime ? new Date(o.orderupdatetime) : new Date(),
    }));
  }

  async getMargins(): Promise<NormalizedMargins> {
    try {
      const response = await this.makeRequest<any>(
        "/rest/secure/angelbroking/user/v1/getRMS",
      );
      const data = response.data || {};
      const available = parseFloat(data.net || "0");
      const used = parseFloat(data.utiliseddebits || "0");
      return {
        availableCash: available,
        usedMargin: used,
        totalMargin: available + used,
        collateral: parseFloat(data.collateral || "0"),
      };
    } catch {
      return { availableCash: 0, usedMargin: 0, totalMargin: 0, collateral: 0 };
    }
  }

  // No getMutualFunds() override - SmartAPI does not expose a public MF
  // endpoint per the official Python/Node SDKs (verified 2026-04-09).
  // The adapter's speculative getMFHolding endpoint doesn't exist.
  // Base class returns [] by default.

  /**
   * Refresh the JWT token using the generateTokens endpoint.
   * This DOES work per SmartAPI docs - the adapter was incorrectly
   * claiming Angel One "requires daily re-authentication with TOTP."
   * The refresh token from login can generate new JWTs without TOTP.
   */
  async refreshToken(): Promise<BrokerCredentials | null> {
    if (!this.credentials.refreshToken) return null;
    try {
      const response = await this.makeRequest<any>(
        "/rest/auth/angelbroking/jwt/v1/generateTokens",
        {
          method: "POST",
          body: JSON.stringify({
            refreshToken: this.credentials.refreshToken,
          }),
        },
      );
      if (response.data?.jwtToken) {
        return {
          ...this.credentials,
          accessToken: response.data.jwtToken,
          refreshToken:
            response.data.refreshToken || this.credentials.refreshToken,
        };
      }
      return null;
    } catch (error) {
      logger.warn({ error, broker: "ANGEL_ONE" }, "token refresh failed");
      return null;
    }
  }
}
