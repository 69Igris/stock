/**
 * Groww Trade API Adapter
 *
 * Auth: API Key + SHA256(api_secret + epoch_seconds) checksum or TOTP.
 * Base URL: https://api.groww.in
 * Token: Expires daily at 6AM IST. No refresh token.
 * Cost: ₹499+tax/month subscription.
 * Launched: October 2025.
 * Segments: CASH, FNO, COMMODITY only. No MF, no US Stocks in API.
 *
 * API docs: https://groww.in/trade-api/docs
 */

import ky from "ky";
import { BaseBrokerAdapter } from "../base-adapter";
import {
  shouldUseMockData,
  generateMockHoldings,
  generateMockPositions,
  generateMockOrders,
  generateMockTrades,
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

const BROKER_INFO: BrokerInfo = {
  id: "GROWW",
  name: "Groww",
  description:
    "Popular investment app with Trade API for stocks, F&O, and commodities",
  color: "#5367FF",
  segments: ["Equity", "F&O", "Commodity"],
  features: ["Holdings", "Positions", "Orders", "Trades"],
  cost: "₹499+/month",
  tokenExpiry: "1 day (6AM IST)",
  autoRefresh: false,
  mfSupport: false, // Trade API covers CASH/FNO/COMMODITY only
  docsUrl: "https://groww.in/trade-api/docs",
};

/* ── Row normalisers ──────────────────────────────────────────────────────
   Extracted as pure functions, matching `normalizeDhanHolding` in the sibling
   adapter, so the field mapping is testable without HTTP.

   This mattered: the only Groww tests were a SHADOW that re-declared
   BROKER_INFO inline and asserted the copy (contradicting the real adapter on
   ~19 values). Deleting it was right, but its replacement covers only
   metadata/auth — so every one of these mappings had zero coverage.
   ────────────────────────────────────────────────────────────────────────── */

/** Groww holding row -> normalised holding. */
export function normalizeGrowwHolding(h: Record<string, unknown>): HoldingData {
  // NOTE this fixes a real, previously-invisible bug. The inline version emitted
  // `quantity`, which is NOT a field of `HoldingData` — the contract wants
  // `totalQuantity`/`freeQuantity`/`tradingSymbol`/`pnl`/`product`. It compiled
  // only because `.json<any>()` made the mapped array `any`, so the declared
  // `Promise<HoldingData[]>` was never actually checked. Every Groww holding was
  // therefore missing the fields consumers read (compare `angel-one.ts:56`,
  // which maps the same source field to `totalQuantity`). Extracting the mapper
  // and typing it is what surfaced it.
  const qty = (h.quantity as number) || 0;
  const avg = (h.average_price as number) || 0;
  return {
    symbol: (h.trading_symbol as string) || (h.isin as string) || "",
    tradingSymbol: (h.trading_symbol as string) || "",
    isin: (h.isin as string) || "",
    exchange: "NSE",
    totalQuantity: qty,
    // Groww reports settled quantity in `quantity`; T+1 is separate.
    freeQuantity: qty,
    t1Quantity: (h.t1_quantity as number) || 0,
    pledgedQuantity: 0,
    averagePrice: avg,
    // Groww's /v1/holdings/user carries no LTP, so pnl cannot be derived here.
    //
    // An earlier version of this comment claimed "the sync fills it separately".
    // That is FALSE — verified: nothing in this repo recomputes a holding's
    // price. There is no `prisma.holding.update` outside the manual-edit paths,
    // intraday-sync reads holdings only to pick instruments to quote, and
    // `holdings-logic.ts` TRUSTS a stored zero when quantity > 0. So a 0 here
    // would be stored and rendered as a real ₹0, not as "unknown".
    //
    // It is survivable only because THIS ADAPTER IS DEAD CODE: `getBrokerAdapter`
    // has no production caller (see factory.ts), and the live sync goes through
    // `createBrokerClient` -> `clients/groww.ts` instead. Every other adapter
    // passes the broker's LTP through or derives it; Groww is the sole outlier,
    // because it has neither. If this layer is ever revived, join a quote source
    // rather than shipping the zero.
    lastPrice: 0,
    pnl: 0,
    pnlPercentage: 0,
    product: "CNC",
  };
}

/** Groww position row -> normalised position. */
export function normalizeGrowwPosition(
  p: Record<string, unknown>,
): PositionData {
  const net = (p.quantity as number) ?? (p.net_quantity as number) ?? 0;
  return {
    symbol: (p.trading_symbol as string) || "",
    tradingSymbol: (p.trading_symbol as string) || "",
    exchange: (p.exchange as string) || "NSE",
    segment: (p.segment as string) || "CASH",
    positionType: "NET",
    productType: (p.product as string) || "CNC",
    buyQuantity: (p.credit_quantity as number) || 0,
    sellQuantity: (p.debit_quantity as number) || 0,
    netQuantity: net,
    buyPrice: (p.credit_price as number) || 0,
    sellPrice: (p.debit_price as number) || 0,
    averagePrice: (p.credit_price as number) || 0,
    // No LTP on Groww's positions response either, so unrealised P&L cannot be
    // derived. Same caveat as `normalizeGrowwHolding`: nothing downstream
    // recomputes it, and this adapter layer is not on the live path.
    lastPrice: 0,
    realizedPnl: (p.realised_pnl as number) || 0,
    unrealizedPnl: 0,
  };
}

/** Groww order row -> normalised order. */
export function normalizeGrowwOrder(o: Record<string, unknown>): OrderData {
  const side = String(o.transaction_type ?? "BUY").toUpperCase();
  return {
    orderId: (o.groww_order_id as string) || "",
    symbol: (o.trading_symbol as string) || "",
    tradingSymbol: (o.trading_symbol as string) || "",
    exchange: (o.exchange as string) || "NSE",
    segment: (o.segment as string) || "CASH",
    orderType: (o.order_type as string) || "MARKET",
    // Narrowed to the union rather than passed through: an unexpected value
    // would otherwise be typed as a valid side.
    transactionType: side === "SELL" ? "SELL" : "BUY",
    productType: (o.product as string) || "CNC",
    variety: (o.variety as string) || "REGULAR",
    quantity: (o.quantity as number) || 0,
    filledQuantity: (o.filled_quantity as number) || 0,
    price: (o.price as number) || 0,
    averagePrice: (o.average_fill_price as number) || 0,
    status: (o.order_status as string) || "PENDING",
    validity: (o.validity as string) || "DAY",
    orderTime: o.created_at ? new Date(o.created_at as string) : new Date(),
  };
}

export class GrowwAdapter extends BaseBrokerAdapter {
  private readonly baseUrl = "https://api.groww.in";

  constructor() {
    super("GROWW", BROKER_INFO);
  }

  getAuthUrl(): string {
    // Groww uses API key + checksum/TOTP, not OAuth redirect
    return "https://groww.in/trade-api/docs";
  }

  async authenticate(
    _authCode: string,
    _redirectUri: string,
    additionalData?: Record<string, unknown>,
  ): Promise<AuthResult> {
    if (shouldUseMockData("GROWW")) {
      return {
        success: true,
        accessToken: "mock_groww_token_" + Date.now(),
        expiresAt: this.addDays(1),
        metadata: {
          userName: (additionalData?.userName as string) || "Demo User",
          broker: "Groww",
        },
      };
    }

    // Real auth is handled by the connect route (POST /api/brokers/groww/connect)
    // which calls the token endpoint directly. This adapter method is not used
    // for Groww's API key + checksum auth flow.
    return {
      success: false,
      error: "Use the Groww connect page (API key + checksum/TOTP auth)",
    };
  }

  async refreshAccessToken(
    _credentials: BrokerCredentials,
  ): Promise<AuthResult> {
    // Groww has no refresh token. New token must be generated daily.
    return {
      success: false,
      error:
        "Groww tokens cannot be refreshed - daily re-authentication required",
    };
  }

  private getHeaders(credentials: BrokerCredentials): Record<string, string> {
    return {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-API-VERSION": "1.0",
    };
  }

  async fetchHoldings(credentials: BrokerCredentials): Promise<HoldingData[]> {
    if (shouldUseMockData("GROWW")) return generateMockHoldings(8);
    try {
      const response = await ky
        .get(`${this.baseUrl}/v1/holdings/user`, {
          headers: this.getHeaders(credentials),
        })
        .json<any>();
      return (response.data || response.holdings || []).map(
        normalizeGrowwHolding,
      );
    } catch (error) {
      console.error("Groww fetchHoldings error:", error);
      return [];
    }
  }

  async fetchPositions(
    credentials: BrokerCredentials,
  ): Promise<PositionData[]> {
    if (shouldUseMockData("GROWW")) return generateMockPositions(4);
    try {
      const response = await ky
        .get(`${this.baseUrl}/v1/positions/user`, {
          headers: this.getHeaders(credentials),
        })
        .json<any>();
      return (response.data || response.positions || []).map(
        normalizeGrowwPosition,
      );
    } catch (error) {
      console.error("Groww fetchPositions error:", error);
      return [];
    }
  }

  async fetchOrders(credentials: BrokerCredentials): Promise<OrderData[]> {
    if (shouldUseMockData("GROWW")) return generateMockOrders(10);
    try {
      const response = await ky
        .get(`${this.baseUrl}/v1/order/list`, {
          searchParams: { segment: "CASH", page: "0", page_size: "100" },
          headers: this.getHeaders(credentials),
        })
        .json<any>();
      return (response.order_list || response.data || []).map(
        normalizeGrowwOrder,
      );
    } catch (error) {
      console.error("Groww fetchOrders error:", error);
      return [];
    }
  }

  async fetchTrades(credentials: BrokerCredentials): Promise<TradeData[]> {
    if (shouldUseMockData("GROWW")) return generateMockTrades(15);
    // Groww has NO standalone tradebook endpoint - trades are fetched per-order.
    // For now, return empty. A future optimization could iterate over today's
    // orders and fetch trades for each.
    return [];
  }

  async fetchMutualFunds(): Promise<MutualFundData[]> {
    // Groww Trade API covers CASH/FNO/COMMODITY only. No MF endpoints.
    return [];
  }

  async validateToken(credentials: BrokerCredentials): Promise<boolean> {
    if (shouldUseMockData("GROWW")) return true;
    try {
      await ky.get(`${this.baseUrl}/v1/holdings/user`, {
        headers: this.getHeaders(credentials),
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  supportsAutoRefresh(): boolean {
    return false;
  }

  getRefreshStrategy(): RefreshStrategy {
    return "NONE";
  }

  getTokenExpiryDuration(): number {
    return 24 * 60 * 60 * 1000; // 1 day
  }
}
