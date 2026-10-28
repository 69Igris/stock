/**
 * Groww Trade API Client
 *
 * Auth: API Key + SHA256(api_secret + epoch_seconds) checksum, OR
 *       API Key + TOTP. NOT OAuth2.
 * Token: Expires daily at 6AM IST. No refresh token.
 * Cost: ₹499+tax/month subscription required.
 *
 * Token endpoint: POST /v1/token/api/access
 *   Header: Authorization: Bearer {API_KEY}
 *   Body:   { key_type: "approval", checksum: SHA256(secret+timestamp), timestamp }
 *        or { key_type: "totp", totp: "123456" }
 *
 * Launched October 2025. Covers CASH, FNO, COMMODITY segments.
 * No MF or US Stocks endpoints despite Groww being known for them.
 *
 * API docs: https://groww.in/trade-api/docs
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

export class GrowwClient extends BaseBrokerClient {
  constructor(credentials: BrokerCredentials) {
    super("GROWW", credentials);
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.credentials.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-API-VERSION": "1.0",
    };
  }

  async getProfile(): Promise<BrokerProfile> {
    const response = await this.makeRequest<any>("/v1/user/profile");
    const data = response.data || response;
    return {
      userId: data.user_id || data.client_id || "",
      userName: data.name || data.user_name || "",
      email: data.email || "",
      phone: data.phone || data.mobile || "",
      broker: "GROWW",
      exchanges: data.exchanges || ["NSE", "BSE"],
      products: data.products || [],
    };
  }

  async getHoldings(): Promise<NormalizedHolding[]> {
    const response = await this.makeRequest<any>("/v1/holdings/user");
    return (response.data || response.holdings || []).map((h: any) => ({
      symbol: h.trading_symbol || h.symbol,
      tradingSymbol: h.trading_symbol || h.symbol,
      isin: h.isin || "",
      exchange: h.exchange || "NSE",
      quantity: h.quantity || 0,
      averagePrice: h.average_price || h.avg_price || 0,
      // Fall back to COST, not zero, when Groww omits a live price.
      //
      // Groww's /v1/holdings/user is not documented to carry an LTP, and a
      // literal 0 is not "unknown" anywhere downstream: `Holding.currentPrice`
      // is a required Float so null is not storable, nothing in this repo
      // recomputes a stored price (there is no prisma.holding.update outside
      // the manual-edit paths, and intraday-sync only reads holdings to pick
      // instruments to quote), and `holdings-logic.ts` deliberately TRUSTS the
      // stored currentValue when quantity > 0. Worse,
      // `dashboard-logic.ts` does `if (h.currentPrice)`, so a 0 is DROPPED from
      // the price map rather than treated as missing.
      //
      // Net effect of the old `|| 0`: a live Groww user's holdings rendered at
      // ₹0 and their portfolio total silently deflated. Cost basis is stale but
      // plausible; zero asserts the position is worthless. pnl stays 0, which
      // is the honest answer when there is no market price to compare against.
      currentPrice:
        h.ltp || h.last_price || h.average_price || h.avg_price || 0,
      investedValue: (h.quantity || 0) * (h.average_price || h.avg_price || 0),
      currentValue:
        (h.quantity || 0) *
        (h.ltp || h.last_price || h.average_price || h.avg_price || 0),
      pnl: h.pnl || h.profit_loss || 0,
      pnlPercentage: h.pnl_percentage || 0,
      dayChange: h.day_change || 0,
      dayChangePercentage: h.day_change_percentage || 0,
    }));
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const response = await this.makeRequest<any>("/v1/positions/user");
    return (response.data || response.positions || []).map((p: any) => ({
      symbol: p.trading_symbol || p.symbol,
      tradingSymbol: p.trading_symbol || p.symbol,
      exchange: p.exchange || "NSE",
      segment: p.segment || "EQUITY",
      productType: p.product_type || p.product || "CNC",
      positionType: "DAY" as const,
      quantity: p.net_quantity || p.quantity || 0,
      buyQuantity: p.buy_quantity || 0,
      sellQuantity: p.sell_quantity || 0,
      buyPrice: p.buy_price || p.buy_avg || 0,
      sellPrice: p.sell_price || p.sell_avg || 0,
      averagePrice: p.average_price || 0,
      lastPrice: p.ltp || p.last_price || 0,
      pnl: p.pnl || p.realised_pnl || 0,
      pnlPercentage: 0,
      multiplier: p.lot_size || 1,
    }));
  }

  async getTrades(): Promise<NormalizedTrade[]> {
    const response = await this.makeRequest<any>("/v1/order/trades");
    return (response.data || response.trades || []).map((t: any) => ({
      tradeId: t.trade_id || t.fill_id || "",
      orderId: t.order_id || "",
      symbol: t.trading_symbol || t.symbol,
      tradingSymbol: t.trading_symbol || t.symbol,
      exchange: t.exchange || "NSE",
      segment: t.segment || "EQUITY",
      transactionType: (t.transaction_type || t.side || "BUY") as
        | "BUY"
        | "SELL",
      quantity: t.filled_quantity || t.quantity || 0,
      price: t.trade_price || t.price || 0,
      value:
        (t.filled_quantity || t.quantity || 0) *
        (t.trade_price || t.price || 0),
      tradeTime: t.trade_time
        ? new Date(t.trade_time)
        : t.fill_time
          ? new Date(t.fill_time)
          : new Date(),
      productType: t.product_type || t.product || "CNC",
      orderType: t.order_type || "MARKET",
    }));
  }

  async getOrders(): Promise<NormalizedOrder[]> {
    const response = await this.makeRequest<any>("/v1/order/list");
    return (response.data || response.orders || []).map((o: any) => ({
      orderId: o.order_id || "",
      symbol: o.trading_symbol || o.symbol,
      tradingSymbol: o.trading_symbol || o.symbol,
      exchange: o.exchange || "NSE",
      segment: o.segment || "EQUITY",
      transactionType: (o.transaction_type || o.side || "BUY") as
        | "BUY"
        | "SELL",
      quantity: o.quantity || 0,
      filledQuantity: o.filled_quantity || 0,
      pendingQuantity: o.pending_quantity || 0,
      price: o.price || 0,
      averagePrice: o.average_price || 0,
      status: o.status || "PENDING",
      orderType: o.order_type || "MARKET",
      productType: o.product_type || o.product || "CNC",
      orderTime: o.order_time ? new Date(o.order_time) : new Date(),
    }));
  }

  async getMargins(): Promise<NormalizedMargins> {
    try {
      const response = await this.makeRequest<any>("/v1/user/margins");
      const data = response.data || response;
      const available = data.available_margin || data.net || 0;
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

  // No getMutualFunds() override - Groww Trade API covers CASH/FNO/COMMODITY
  // segments only, no MF endpoints. The base class returns [] by default.
}
