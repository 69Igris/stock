/**
 * Dhan API Client
 * Dhan uses API key authentication (no OAuth)
 */

import { BaseBrokerClient, BrokerCredentials } from "./base-client";
import {
  NormalizedHolding,
  NormalizedPosition,
  NormalizedTrade,
  NormalizedOrder,
  NormalizedMargins,
  BrokerProfile,
} from "@usemoney/types";

export class DhanClient extends BaseBrokerClient {
  private clientId: string;

  constructor(credentials: BrokerCredentials) {
    super("DHAN", credentials);
    this.clientId = credentials.userId || "";
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      "access-token": this.credentials.accessToken,
      "client-id": this.clientId,
      "Content-Type": "application/json",
    };
  }

  async getProfile(): Promise<BrokerProfile> {
    // Dhan doesn't have a profile endpoint, return basic info
    return {
      userId: this.clientId,
      userName: this.clientId,
      broker: "DHAN",
      exchanges: ["NSE", "BSE", "NFO", "MCX"],
      products: ["CNC", "INTRADAY", "MARGIN"],
    };
  }

  async getHoldings(): Promise<NormalizedHolding[]> {
    const response = await this.makeRequest<any>("/holdings");
    return (response.data || []).map((h: any) => ({
      symbol: h.tradingSymbol,
      tradingSymbol: h.tradingSymbol,
      isin: h.isin,
      exchange: h.exchange,
      quantity: h.totalQty,
      averagePrice: h.avgCostPrice,
      currentPrice: h.lastTradedPrice,
      investedValue: h.totalQty * h.avgCostPrice,
      currentValue: h.totalQty * h.lastTradedPrice,
      pnl: h.unrealizedProfit,
      pnlPercentage: h.avgCostPrice
        ? (h.unrealizedProfit / (h.totalQty * h.avgCostPrice)) * 100
        : 0,
      dayChange: h.dayChangeValue || 0,
      dayChangePercentage: h.dayChangePercentage || 0,
    }));
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const response = await this.makeRequest<any>("/positions");
    return (response.data || []).map((p: any) => ({
      symbol: p.tradingSymbol,
      tradingSymbol: p.tradingSymbol,
      exchange: p.exchangeSegment,
      segment: p.productType,
      productType: p.productType,
      positionType:
        p.positionType === "LONG" ? ("NET" as const) : ("DAY" as const),
      quantity: p.netQty,
      buyQuantity: p.buyQty,
      sellQuantity: p.sellQty,
      buyPrice: p.buyAvg,
      sellPrice: p.sellAvg,
      averagePrice: p.costPrice,
      lastPrice: p.lastTradedPrice,
      pnl: p.realizedProfit + p.unrealizedProfit,
      pnlPercentage: p.costPrice
        ? ((p.realizedProfit + p.unrealizedProfit) /
            (Math.abs(p.netQty) * p.costPrice)) *
          100
        : 0,
      multiplier: p.multiplier || 1,
    }));
  }

  async getTrades(fromDate?: Date, toDate?: Date): Promise<NormalizedTrade[]> {
    const response = await this.makeRequest<any>("/tradeHistory");
    return (response.data || []).map((t: any) => ({
      tradeId: t.tradeNumber,
      orderId: t.orderId,
      symbol: t.tradingSymbol,
      tradingSymbol: t.tradingSymbol,
      exchange: t.exchangeSegment,
      segment: t.productType,
      transactionType: t.transactionType as "BUY" | "SELL",
      quantity: t.tradedQty,
      price: t.tradedPrice,
      value: t.tradedQty * t.tradedPrice,
      tradeTime: new Date(t.exchangeTime),
      productType: t.productType,
      orderType: t.orderType,
    }));
  }

  async getOrders(): Promise<NormalizedOrder[]> {
    const response = await this.makeRequest<any>("/orders");
    return (response.data || []).map((o: any) => ({
      orderId: o.orderId,
      symbol: o.tradingSymbol,
      tradingSymbol: o.tradingSymbol,
      exchange: o.exchangeSegment,
      segment: o.productType,
      transactionType: o.transactionType as "BUY" | "SELL",
      orderType: o.orderType as "MARKET" | "LIMIT" | "SL" | "SL-M",
      productType: o.productType,
      quantity: o.quantity,
      price: o.price,
      triggerPrice: o.triggerPrice,
      filledQuantity: o.filledQty,
      pendingQuantity: o.remainingQuantity,
      status: this.mapOrderStatus(o.orderStatus),
      statusMessage: o.rejectReason,
      orderTime: new Date(o.createTime),
      updateTime: o.updateTime ? new Date(o.updateTime) : undefined,
    }));
  }

  async getMargins(): Promise<NormalizedMargins> {
    const response = await this.makeRequest<any>("/fundlimit");
    return {
      availableCash: response.data?.availabelBalance || 0,
      usedMargin: response.data?.utilizedAmount || 0,
      totalMargin: response.data?.sodLimit || 0,
      collateral: response.data?.collateralAmount || 0,
    };
  }

  private mapOrderStatus(
    status: string,
  ): "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED" {
    const mapping: Record<
      string,
      "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED"
    > = {
      PENDING: "PENDING",
      TRANSIT: "OPEN",
      TRADED: "COMPLETE",
      CANCELLED: "CANCELLED",
      REJECTED: "REJECTED",
    };
    return mapping[status] || "PENDING";
  }

  // Dhan uses direct API key, no OAuth flow needed
  static validateCredentials(clientId: string, accessToken: string): boolean {
    return clientId.length > 0 && accessToken.length > 0;
  }
}
