/**
 * Interactive Brokers API Client
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

/**
 * Map IBKR exchange codes to normalized exchange names
 */
function mapExchange(exchange: string): string {
  const exchangeMap: Record<string, string> = {
    NASDAQ: "NASDAQ",
    NYSE: "NYSE",
    ARCA: "NYSE",
    AMEX: "NYSE",
    NSE: "NSE",
    BSE: "BSE",
    LSE: "LSE",
    IDEALPRO: "FOREX",
    SMART: "NSE",
  };
  return exchangeMap[exchange] || exchange;
}

/**
 * Map IBKR order status to normalized status
 */
function mapOrderStatus(
  status: string,
): "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED" {
  const mapping: Record<
    string,
    "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED"
  > = {
    submitted: "OPEN",
    filled: "COMPLETE",
    cancelled: "CANCELLED",
    inactive: "REJECTED",
    pendingsubmit: "PENDING",
    pendingcancel: "PENDING",
    presubmitted: "PENDING",
    apipending: "PENDING",
    apicancelled: "CANCELLED",
  };
  return mapping[status.toLowerCase()] || "PENDING";
}

/**
 * Determine segment from IBKR asset class
 */
function mapSegment(assetClass: string): string {
  const segmentMap: Record<string, string> = {
    STK: "CASH",
    OPT: "FNO",
    FUT: "FNO",
    CASH: "CASH",
    BOND: "BOND",
    FOP: "FNO",
    WAR: "CASH",
    FUND: "MF",
  };
  return segmentMap[assetClass] || "CASH";
}

export class InteractiveBrokersClient extends BaseBrokerClient {
  constructor(credentials: BrokerCredentials) {
    super("INTERACTIVE_BROKERS", credentials);
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.credentials.accessToken}`,
      Accept: "application/json",
    };
  }

  /**
   * Fetch the first portfolio account ID for the authenticated user
   */
  private async getAccountId(): Promise<string> {
    const response = await this.makeRequest<any[]>("/portfolio/accounts");
    if (!response || response.length === 0) {
      throw new Error("No IBKR accounts found");
    }
    return response[0].accountId;
  }

  async getProfile(): Promise<BrokerProfile> {
    const accounts = await this.makeRequest<any[]>("/portfolio/accounts");
    const account = accounts?.[0] || {};
    return {
      userId: account.accountId || "",
      userName: account.accountTitle || account.accountId || "",
      email: account.email || "",
      phone: "",
      broker: "INTERACTIVE_BROKERS",
      exchanges: ["NSE", "BSE", "NASDAQ", "NYSE"],
      products: ["CNC", "MIS", "NRML"],
    };
  }

  async getHoldings(): Promise<NormalizedHolding[]> {
    const accountId = await this.getAccountId();
    const response = await this.makeRequest<any[]>(
      `/portfolio/${accountId}/positions/0`,
    );
    const positions = response || [];

    return positions
      .filter((p: any) => p.assetClass === "STK" && p.position > 0)
      .map((h: any) => {
        const position = h.position || 0;
        const avgCost = h.avgCost || 0;
        const mktPrice = h.mktPrice || 0;
        const unrealizedPnl = h.unrealizedPnl || 0;
        const investedValue = position * avgCost;
        const symbol = h.ticker || h.contractDesc || `CONID_${h.conid}`;
        const priorClose = h.priorClose || mktPrice;

        return {
          symbol,
          tradingSymbol: symbol,
          isin: h.isin,
          exchange: mapExchange(h.listingExchange || h.exchange || "SMART"),
          quantity: position,
          averagePrice: avgCost,
          currentPrice: mktPrice,
          investedValue,
          currentValue: position * mktPrice,
          pnl: unrealizedPnl,
          pnlPercentage:
            investedValue !== 0 ? (unrealizedPnl / investedValue) * 100 : 0,
          dayChange: mktPrice - priorClose,
          dayChangePercentage: priorClose
            ? ((mktPrice - priorClose) / priorClose) * 100
            : 0,
        };
      });
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const accountId = await this.getAccountId();
    const response = await this.makeRequest<any[]>(
      `/portfolio/${accountId}/positions/0`,
    );
    const positions = response || [];

    return positions.map((p: any) => {
      const position = p.position || 0;
      const avgCost = p.avgCost || 0;
      const mktPrice = p.mktPrice || 0;
      const unrealizedPnl = p.unrealizedPnl || 0;
      const realizedPnl = p.realizedPnl || 0;
      const symbol = p.ticker || p.contractDesc || `CONID_${p.conid}`;
      const buyQty = position > 0 ? Math.abs(position) : 0;
      const sellQty = position < 0 ? Math.abs(position) : 0;
      const pnl = unrealizedPnl + realizedPnl;

      return {
        symbol,
        tradingSymbol: symbol,
        exchange: mapExchange(p.listingExchange || p.exchange || "SMART"),
        segment: mapSegment(p.assetClass || "STK"),
        productType: p.assetClass === "STK" ? "CNC" : "NRML",
        positionType: "DAY" as const,
        quantity: position,
        buyQuantity: buyQty,
        sellQuantity: sellQty,
        buyPrice: position > 0 ? avgCost : 0,
        sellPrice: position < 0 ? avgCost : 0,
        averagePrice: avgCost,
        lastPrice: mktPrice,
        pnl,
        pnlPercentage: avgCost
          ? (pnl / (Math.abs(position) * avgCost)) * 100
          : 0,
        realizedPnl,
        unrealizedPnl,
        multiplier: p.multiplier,
      };
    });
  }

  async getTrades(fromDate?: Date, toDate?: Date): Promise<NormalizedTrade[]> {
    const response = await this.makeRequest<any[]>("/iserver/account/trades");
    const trades = response || [];

    return trades.map((t: any) => {
      const qty = Math.abs(t.size || t.shares || 0);
      const price = t.price || 0;
      const side = (t.side || "").toUpperCase();
      const symbol = t.ticker || t.symbol || t.contractDesc || "";

      return {
        tradeId: String(
          t.execution_id || t.executionId || t.tradeId || `IBKR_${Date.now()}`,
        ),
        orderId: String(t.orderId || t.order_ref || ""),
        symbol,
        tradingSymbol: symbol,
        exchange: mapExchange(t.listingExchange || t.exchange || "SMART"),
        segment: mapSegment(t.secType || "STK"),
        transactionType:
          side === "BUY" || side === "BOT"
            ? ("BUY" as const)
            : ("SELL" as const),
        quantity: qty,
        price,
        value: qty * price,
        tradeTime: t.tradeTime
          ? new Date(t.tradeTime)
          : t.time
            ? new Date(t.time)
            : new Date(),
        productType: t.secType === "STK" ? "CNC" : "NRML",
        orderType: (t.orderType || "MKT").toUpperCase(),
      };
    });
  }

  async getOrders(): Promise<NormalizedOrder[]> {
    const response = await this.makeRequest<any>("/iserver/account/orders");
    const orders = response?.orders || [];

    return orders.map((o: any) => {
      const side = (o.side || "").toUpperCase();
      const totalQty = o.totalSize || o.totalQuantity || 0;
      const filledQty = o.filledQuantity || o.cumFill || 0;
      const symbol = o.ticker || o.symbol || o.contractDesc || "";

      return {
        orderId: String(o.orderId || o.order_ref || ""),
        symbol,
        tradingSymbol: symbol,
        exchange: mapExchange(o.listingExchange || o.exchange || "SMART"),
        segment: mapSegment(o.secType || "STK"),
        transactionType: side === "BUY" ? ("BUY" as const) : ("SELL" as const),
        orderType: (o.orderType || "MKT").toUpperCase() as
          | "MARKET"
          | "LIMIT"
          | "SL"
          | "SL-M",
        productType: o.secType === "STK" ? "CNC" : "NRML",
        quantity: totalQty,
        price: o.price || o.lastFillPrice || 0,
        triggerPrice: o.auxPrice || 0,
        filledQuantity: filledQty,
        pendingQuantity: totalQty - filledQty,
        status: mapOrderStatus(o.status || ""),
        statusMessage: o.warningText,
        orderTime: o.lastExecutionTime
          ? new Date(o.lastExecutionTime)
          : new Date(),
      };
    });
  }

  async getMargins(): Promise<NormalizedMargins> {
    const accountId = await this.getAccountId();
    const response = await this.makeRequest<any>(
      `/portfolio/${accountId}/summary`,
    );
    const data = response || {};

    // IBKR summary fields use nested objects with value property
    const getValue = (field: any): number => {
      if (typeof field === "number") return field;
      if (field && typeof field === "object" && "amount" in field)
        return field.amount || 0;
      return 0;
    };

    return {
      availableCash:
        getValue(data.availablefunds) || getValue(data.totalcashvalue) || 0,
      usedMargin:
        getValue(data.maintmarginreq) || getValue(data.initmarginreq) || 0,
      totalMargin: getValue(data.netliquidation) || 0,
      collateral: getValue(data.stockmarketvalue) || 0,
    };
  }

  // Static method to generate login URL
  static getLoginUrl(clientId: string, redirectUri: string): string {
    return `https://www.interactivebrokers.com/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=trading`;
  }

  // Static method to exchange authorization code for access token
  static async exchangeToken(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn: number;
  }> {
    const response = await fetch("https://api.ibkr.com/v1/api/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!response.ok) {
      // Message text preserved exactly (see brokerTransportFailure's note).
      const error = await response.text().catch(() => "");
      throw brokerTransportFailure(
        "Interactive Brokers",
        response.status,
        `Failed to exchange token: ${error}`,
        error,
      );
    }

    // IBKR /oauth/token wire shape (OAuth2 token response). MONEY-1158:
    // `access_token` is optional because a 200 does not guarantee it; an OAuth2
    // error envelope (`{ error, error_description }`) is served with 200 by
    // some gateways, and reading through it stored `accessToken: undefined`.
    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    return {
      accessToken: requireAccessToken(
        "Interactive Brokers",
        data.access_token,
        data.error_description || data.error,
      ),
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in || 86400, // Default 24 hours
    };
  }
}
