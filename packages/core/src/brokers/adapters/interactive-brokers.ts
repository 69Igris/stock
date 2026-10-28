/**
 * Interactive Brokers Adapter
 * OAuth 2.0 | Token refresh on expiry | Multi-currency support
 * Docs: https://www.interactivebrokers.com/api/doc.html
 */

import { BaseBrokerAdapter } from "../base-adapter";
import {
  generateMockHoldings,
  generateMockPositions,
  generateMockOrders,
  generateMockTrades,
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
  id: "INTERACTIVE_BROKERS",
  name: "Interactive Brokers",
  description:
    "Global brokerage with access to 150+ markets across 33 countries",
  color: "#D81B3C",
  segments: ["Equity", "F&O", "Currency", "Commodity", "Bonds"],
  features: ["Holdings", "Positions", "Orders", "Trades"],
  cost: "FREE",
  tokenExpiry: "24 hours",
  autoRefresh: true,
  mfSupport: false,
  docsUrl: "https://www.interactivebrokers.com/api/doc.html",
};

/**
 * IBKR's smart-order-router pseudo-venue, as it is spelled on the wire.
 *
 * SMART is NOT A PLACE. It means "IBKR picked the venue", and which venue it
 * picked is not reported back on the position, the order or the execution. A
 * row that names it is a row whose venue is UNRESOLVED.
 */
const IBKR_SMART_ROUTER = "SMART";

/**
 * The venue a SMART-routed order may be attributed to, keyed by SETTLEMENT
 * CURRENCY.
 *
 * A currency earns a row here only when it pins ONE national market AND that
 * market has ONE conventional default venue. INR does: an IBKR India account
 * settles in INR and NSE carries the overwhelming majority of cash volume, so
 * `INR -> NSE` is the pre-existing default RETAINED unchanged.
 *
 * USD deliberately has NO row. The US has two primary venues (NYSE and NASDAQ)
 * with no default between them, so the honest answer for a USD SMART fill is
 * that we do not know — see `mapIBKRExchange`.
 */
const SMART_ROUTER_VENUE_BY_CURRENCY: Record<string, string> = {
  INR: "NSE",
};

/**
 * Map IBKR exchange codes to normalized exchange names.
 *
 * `currency` is the position's/execution's settlement currency (IBKR's
 * `currency` field) and is used ONLY to resolve the SMART router pseudo-venue.
 * It is optional because it is not uniformly present across IBKR's endpoints —
 * and an ABSENT currency resolves to the unresolved sentinel rather than to a
 * guess, because "we were not told" and "it is Indian" are not the same claim.
 *
 * ── WHY `SMART: "NSE"` WAS A MONEY BUG, NOT A COSMETIC ONE ────────────────────
 *
 * This map used to carry `SMART: "NSE"`, commented "SMART routing defaults to
 * primary exchange". It does not: SMART is the router, and the primary exchange
 * is what it declines to tell us. Every SMART-routed holding in EVERY market
 * was therefore stamped as Indian — a US position came out indistinguishable
 * from an NSE one.
 *
 * That is not merely a wrong label, because `exchange` is half of a MATCH KEY.
 * `corpActionAppliesToLot` (packages/core/src/pairing/corp-actions.ts) gates on
 * `action.exchange !== lot.exchange` and then matches on ISIN when BOTH sides
 * carry one, falling back to SYMBOL otherwise. Two facts make the fallback the
 * only live path for this adapter:
 *
 *   - `mapIBKRTrade` sets NO `isin` at all (IBKR's execution payload does not
 *     carry one), so a lot built from IBKR trades has `isin: null` and the ISIN
 *     branch is unreachable by construction.
 *   - There are 214 real India/US ticker collisions.
 *
 * So a US `ACC` lot stamped `exchange: "NSE"` matched ACC Ltd — the Indian
 * cement company — and absorbed its splits and bonuses into a US cost basis.
 * Silently, plausibly, and in the numbers rather than in the labels.
 *
 * ── WHY THE UNRESOLVED ANSWER IS THE STRING `"SMART"` ─────────────────────────
 *
 * Guessing NYSE-or-NASDAQ would be the same defect one market over. Returning
 * the router's own name instead is right on three counts:
 *
 *   1. It cannot collide. `"SMART"` is not any venue, so the exchange gate in
 *      `corpActionAppliesToLot` REFUSES the match. The failure mode flips from
 *      applying ANOTHER COMPANY'S action (wrong money, invisible) to applying
 *      NONE (missing adjustment, and the row says why).
 *   2. It is self-describing. An operator reading `"SMART"` in the exchange
 *      column knows the venue was never resolved; one reading `"NSE"` believes
 *      a fact that was manufactured here.
 *   3. It is already within this function's contract — unmapped codes fall
 *      through as themselves (`exchangeMap[exchange] || exchange`), so IBIS,
 *      SEHK and friends have always come back unchanged.
 *
 * This is the "prefer not-claiming over compensating" rule: a column we cannot
 * fill honestly is left visibly unfilled rather than filled with the most
 * plausible-looking value.
 *
 * NOTE this branch is reached only when the payload gave us nothing better —
 * all four call sites prefer `listingExchange` (IBKR's actual primary-venue
 * field) and fall back to `exchange`/`"SMART"` only when it is absent.
 */
export function mapIBKRExchange(exchange: string, currency?: string): string {
  if (exchange === IBKR_SMART_ROUTER) {
    const byCurrency =
      SMART_ROUTER_VENUE_BY_CURRENCY[(currency ?? "").toUpperCase()];
    // No currency, or a currency with no unambiguous default venue: say SMART.
    return byCurrency ?? IBKR_SMART_ROUTER;
  }

  const exchangeMap: Record<string, string> = {
    NASDAQ: "NASDAQ",
    NYSE: "NYSE",
    // NYSE Arca and NYSE American are both NYSE Group venues, so collapsing
    // them loses precision WITHIN one market — unlike SMART, it cannot move a
    // row to another country.
    ARCA: "NYSE",
    AMEX: "NYSE",
    NSE: "NSE",
    BSE: "BSE",
    LSE: "LSE",
    IDEALPRO: "FOREX",
  };
  return exchangeMap[exchange] || exchange;
}

/**
 * Map IBKR order status to normalized status string
 */
export function mapIBKROrderStatus(status: string): string {
  const statusMap: Record<string, string> = {
    Submitted: "PENDING",
    Filled: "COMPLETE",
    Cancelled: "CANCELLED",
    Inactive: "REJECTED",
    PendingSubmit: "PENDING",
    PendingCancel: "PENDING",
    PreSubmitted: "PENDING",
    ApiPending: "PENDING",
    ApiCancelled: "CANCELLED",
  };
  return statusMap[status] || "PENDING";
}

/**
 * Determine segment from IBKR asset class
 */
export function mapIBKRSegment(assetClass: string): string {
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

/**
 * Normalize a raw IBKR position record into our HoldingData shape.
 * Pure (no I/O); the adapter's `mapHolding` method delegates here so the same
 * code path runs whether driven by a live fetch or a unit test.
 */
export function mapIBKRHolding(h: Record<string, unknown>): HoldingData {
  const position = (h.position as number) || 0;
  const avgCost = (h.avgCost as number) || 0;
  const mktPrice = (h.mktPrice as number) || 0;
  const unrealizedPnl = (h.unrealizedPnl as number) || 0;
  const investedValue = position * avgCost;
  const pnlPercentage =
    investedValue !== 0 ? (unrealizedPnl / investedValue) * 100 : 0;

  const symbol =
    (h.ticker as string) || (h.contractDesc as string) || `CONID_${h.conid}`;

  return {
    symbol,
    tradingSymbol: symbol,
    isin: (h.isin as string) || undefined,
    exchange: mapIBKRExchange(
      (h.listingExchange as string) || (h.exchange as string) || "SMART",
      h.currency as string | undefined,
    ),
    totalQuantity: position,
    freeQuantity: position,
    t1Quantity: 0,
    pledgedQuantity: 0,
    collateralQty: 0,
    averagePrice: avgCost,
    lastPrice: mktPrice,
    closePrice: (h.priorClose as number) || mktPrice,
    pnl: unrealizedPnl,
    pnlPercentage: parseFloat(pnlPercentage.toFixed(2)),
    product: "CNC",
    dayChange: mktPrice - ((h.priorClose as number) || mktPrice),
    dayChangePerc: (h.priorClose as number)
      ? parseFloat(
          (
            ((mktPrice - (h.priorClose as number)) / (h.priorClose as number)) *
            100
          ).toFixed(2),
        )
      : 0,
  };
}

/**
 * Normalize a raw IBKR position record into our PositionData shape. Pure.
 */
export function mapIBKRPosition(p: Record<string, unknown>): PositionData {
  const position = (p.position as number) || 0;
  const avgCost = (p.avgCost as number) || 0;
  const mktPrice = (p.mktPrice as number) || 0;
  const unrealizedPnl = (p.unrealizedPnl as number) || 0;
  const realizedPnl = (p.realizedPnl as number) || 0;
  const assetClass = (p.assetClass as string) || "STK";

  const symbol =
    (p.ticker as string) || (p.contractDesc as string) || `CONID_${p.conid}`;

  const buyQty = position > 0 ? Math.abs(position) : 0;
  const sellQty = position < 0 ? Math.abs(position) : 0;

  return {
    symbol,
    tradingSymbol: symbol,
    exchange: mapIBKRExchange(
      (p.listingExchange as string) || (p.exchange as string) || "SMART",
      p.currency as string | undefined,
    ),
    segment: mapIBKRSegment(assetClass),
    positionType: "DAY",
    productType: assetClass === "STK" ? "CNC" : "NRML",
    buyQuantity: buyQty,
    sellQuantity: sellQty,
    netQuantity: position,
    buyPrice: position > 0 ? avgCost : 0,
    sellPrice: position < 0 ? avgCost : 0,
    averagePrice: avgCost,
    lastPrice: mktPrice,
    realizedPnl,
    unrealizedPnl,
  };
}

/**
 * Normalize a raw IBKR order record into our OrderData shape. Pure.
 */
export function mapIBKROrder(o: Record<string, unknown>): OrderData {
  const side = (o.side as string) || "";
  const totalQty = (o.totalSize as number) || (o.totalQuantity as number) || 0;
  const filledQty = (o.filledQuantity as number) || (o.cumFill as number) || 0;
  const status = mapIBKROrderStatus((o.status as string) || "");
  const price = (o.price as number) || (o.lastFillPrice as number) || 0;
  const avgPrice = (o.avgPrice as number) || (o.lastFillPrice as number) || 0;

  const symbol =
    (o.ticker as string) ||
    (o.symbol as string) ||
    (o.contractDesc as string) ||
    "";

  return {
    orderId: String(o.orderId || o.order_ref || ""),
    symbol,
    tradingSymbol: symbol,
    exchange: mapIBKRExchange(
      (o.listingExchange as string) || (o.exchange as string) || "SMART",
      o.currency as string | undefined,
    ),
    segment: mapIBKRSegment((o.secType as string) || "STK"),
    orderType: ((o.orderType as string) || "MKT").toUpperCase(),
    transactionType: side.toUpperCase() === "BUY" ? "BUY" : "SELL",
    productType: (o.secType as string) === "STK" ? "CNC" : "NRML",
    variety: "regular",
    quantity: totalQty,
    filledQuantity: filledQty,
    price,
    triggerPrice: (o.auxPrice as number) || 0,
    averagePrice: avgPrice,
    status,
    statusMessage: (o.warningText as string) || undefined,
    validity: "DAY",
    orderTime: o.lastExecutionTime
      ? new Date(o.lastExecutionTime as string)
      : new Date(),
  };
}

/**
 * Normalize a raw IBKR execution record into our TradeData shape. Pure.
 */
export function mapIBKRTrade(t: Record<string, unknown>): TradeData {
  const qty = Math.abs((t.size as number) || (t.shares as number) || 0);
  const price = (t.price as number) || 0;
  const tradeValue = qty * price;
  const side = (t.side as string) || "";

  const symbol =
    (t.ticker as string) ||
    (t.symbol as string) ||
    (t.contractDesc as string) ||
    "";

  // IBKR reports commission as a negative number
  const commission = Math.abs((t.commission as number) || 0);

  return {
    tradeId: String(
      t.execution_id || t.executionId || t.tradeId || `IBKR_${Date.now()}`,
    ),
    orderId: String(t.orderId || t.order_ref || ""),
    symbol,
    tradingSymbol: symbol,
    exchange: mapIBKRExchange(
      (t.listingExchange as string) || (t.exchange as string) || "SMART",
      t.currency as string | undefined,
    ),
    segment: mapIBKRSegment((t.secType as string) || "STK"),
    transactionType:
      side.toUpperCase() === "BUY" || side === "BOT" ? "BUY" : "SELL",
    productType: (t.secType as string) === "STK" ? "CNC" : "NRML",
    quantity: qty,
    price,
    tradeValue,
    brokerage: commission,
    exchangeFee: 0,
    gst: 0,
    sebiCharges: 0,
    stampDuty: 0,
    transactionTax: 0,
    totalCharges: commission,
    netAmount: tradeValue,
    tradeTime: t.tradeTime
      ? new Date(t.tradeTime as string)
      : t.time
        ? new Date(t.time as string)
        : new Date(),
  };
}

export class InteractiveBrokersAdapter extends BaseBrokerAdapter {
  private readonly baseUrl = "https://api.ibkr.com/v1/api";
  private readonly authUrl = "https://www.interactivebrokers.com/authorize";

  constructor() {
    super("INTERACTIVE_BROKERS", BROKER_INFO);
  }

  private getClientId(): string {
    return process.env.INTERACTIVE_BROKERS_CLIENT_ID || "";
  }

  private getClientSecret(): string {
    return process.env.INTERACTIVE_BROKERS_CLIENT_SECRET || "";
  }

  getAuthUrl(redirectUri: string, state?: string): string {
    const params = new URLSearchParams({
      client_id: this.getClientId(),
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "trading",
    });
    if (state) params.set("state", state);
    return `${this.authUrl}?${params.toString()}`;
  }

  async authenticate(
    authCode: string,
    redirectUri: string,
  ): Promise<AuthResult> {
    if (shouldUseMockData("INTERACTIVE_BROKERS")) {
      return {
        success: true,
        accessToken: "mock_ibkr_token_" + Date.now(),
        expiresAt: this.addDays(1),
        metadata: {
          userId: "MOCK_IBKR_USER",
          userName: "Demo User",
          broker: "Interactive Brokers",
        },
      };
    }

    try {
      const response = await ky
        .post(`${this.baseUrl}/oauth/token`, {
          json: {
            code: authCode,
            client_id: this.getClientId(),
            client_secret: this.getClientSecret(),
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          },
        })
        .json<Record<string, unknown>>();

      if (response.access_token) {
        return {
          success: true,
          accessToken: response.access_token as string,
          refreshToken: response.refresh_token as string | undefined,
          expiresAt: this.addDays(1),
          metadata: response as Record<string, unknown>,
        };
      }
      return {
        success: false,
        error:
          (response.error_description as string) || "Authentication failed",
      };
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message || "Authentication failed" };
    }
  }

  async refreshAccessToken(
    credentials: BrokerCredentials,
  ): Promise<AuthResult> {
    if (shouldUseMockData("INTERACTIVE_BROKERS")) {
      return { success: true, accessToken: credentials.accessToken };
    }

    if (!credentials.refreshToken) {
      return { success: false, error: "No refresh token available" };
    }

    try {
      const response = await ky
        .post(`${this.baseUrl}/oauth/token`, {
          json: {
            refresh_token: credentials.refreshToken,
            client_id: this.getClientId(),
            client_secret: this.getClientSecret(),
            grant_type: "refresh_token",
          },
        })
        .json<Record<string, unknown>>();

      if (response.access_token) {
        return {
          success: true,
          accessToken: response.access_token as string,
          refreshToken: response.refresh_token as string | undefined,
          expiresAt: this.addDays(1),
        };
      }
      return { success: false, error: "Token refresh failed" };
    } catch (error) {
      const err = error as Error;
      return { success: false, error: err.message || "Token refresh failed" };
    }
  }

  private getAuthHeaders(
    credentials: BrokerCredentials,
  ): Record<string, string> {
    return {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
    };
  }

  /**
   * Fetch the first portfolio account ID for the authenticated user
   */
  private async getAccountId(credentials: BrokerCredentials): Promise<string> {
    const response = await ky
      .get(`${this.baseUrl}/portfolio/accounts`, {
        headers: this.getAuthHeaders(credentials),
      })
      .json<Array<Record<string, unknown>>>();

    if (!response || response.length === 0) {
      throw new Error("No IBKR accounts found");
    }

    return response[0]!.accountId as string;
  }

  async fetchHoldings(credentials: BrokerCredentials): Promise<HoldingData[]> {
    if (shouldUseMockData("INTERACTIVE_BROKERS"))
      return generateMockHoldings(8);

    try {
      const accountId = await this.getAccountId(credentials);
      const response = await ky
        .get(`${this.baseUrl}/portfolio/${accountId}/positions/0`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Array<Record<string, unknown>>>();

      const data = response || [];
      return data
        .filter(
          (p) =>
            (p.assetClass as string) === "STK" && (p.position as number) > 0,
        )
        .map((h) => this.mapHolding(h));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch holdings: ${err.message}`);
    }
  }

  private mapHolding(h: Record<string, unknown>): HoldingData {
    return mapIBKRHolding(h);
  }

  async fetchPositions(
    credentials: BrokerCredentials,
  ): Promise<PositionData[]> {
    if (shouldUseMockData("INTERACTIVE_BROKERS"))
      return generateMockPositions(4);

    try {
      const accountId = await this.getAccountId(credentials);
      const response = await ky
        .get(`${this.baseUrl}/portfolio/${accountId}/positions/0`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Array<Record<string, unknown>>>();

      const data = response || [];
      return data.map((p) => this.mapPosition(p));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch positions: ${err.message}`);
    }
  }

  private mapPosition(p: Record<string, unknown>): PositionData {
    return mapIBKRPosition(p);
  }

  async fetchOrders(credentials: BrokerCredentials): Promise<OrderData[]> {
    if (shouldUseMockData("INTERACTIVE_BROKERS")) return generateMockOrders(10);

    try {
      const response = await ky
        .get(`${this.baseUrl}/iserver/account/orders`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Record<string, unknown>>();

      const orders = (response.orders as Array<Record<string, unknown>>) || [];
      return orders.map((o) => this.mapOrder(o));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch orders: ${err.message}`);
    }
  }

  private mapOrder(o: Record<string, unknown>): OrderData {
    return mapIBKROrder(o);
  }

  async fetchTrades(credentials: BrokerCredentials): Promise<TradeData[]> {
    if (shouldUseMockData("INTERACTIVE_BROKERS")) return generateMockTrades(15);

    try {
      const response = await ky
        .get(`${this.baseUrl}/iserver/account/trades`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Array<Record<string, unknown>>>();

      const data = response || [];
      return data.map((t) => this.mapTrade(t));
    } catch (error) {
      const err = error as Error;
      throw new Error(`Failed to fetch trades: ${err.message}`);
    }
  }

  private mapTrade(t: Record<string, unknown>): TradeData {
    return mapIBKRTrade(t);
  }

  async fetchMutualFunds(
    _credentials: BrokerCredentials,
  ): Promise<MutualFundData[]> {
    // IBKR does not have a dedicated mutual funds endpoint
    return [];
  }

  async validateToken(credentials: BrokerCredentials): Promise<boolean> {
    if (shouldUseMockData("INTERACTIVE_BROKERS")) return true;

    try {
      const response = await ky
        .get(`${this.baseUrl}/portfolio/accounts`, {
          headers: this.getAuthHeaders(credentials),
        })
        .json<Array<Record<string, unknown>>>();
      return Array.isArray(response) && response.length > 0;
    } catch {
      return false;
    }
  }

  supportsAutoRefresh(): boolean {
    return true;
  }

  getRefreshStrategy(): RefreshStrategy {
    return "TOKEN_REFRESH";
  }

  getTokenExpiryDuration(): number {
    return 24 * 60 * 60 * 1000; // 24 hours
  }
}
