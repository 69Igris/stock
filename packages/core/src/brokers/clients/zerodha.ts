/**
 * Zerodha (Kite Connect) API Client
 */

import { BaseBrokerClient, BrokerCredentials } from "./base-client";
import {
  brokerTransportFailure,
  requireAccessToken,
  requireTokenField,
} from "./token-exchange";
import {
  NormalizedHolding,
  NormalizedPosition,
  NormalizedTrade,
  NormalizedOrder,
  NormalizedMutualFund,
  NormalizedMargins,
  BrokerProfile,
} from "@usemoney/types";
import {
  getProductTypeLabel,
  getSegmentLabel,
  getPositionTypeLabel,
} from "./broker-mappings";
import crypto from "crypto";
import { validateZerodhaHoldingShape } from "./zerodha-holdings-schema";
import { parseKiteTimestamp } from "./kite-time";
import { toFiniteNumber, normalizeSide } from "./kite-normalize";

// MONEY-837: Kite Console/backoffice historical-tradebook polling tunables.
// The API is async (PENDING→SUCCESS) + paginated + per-segment, and slow by
// design (volume-dependent) — so this is a WORKER-side backfill, never a
// synchronous web request.
const BACKOFFICE_POLL_INTERVAL_MS = 2000;
const BACKOFFICE_MAX_POLLS = 60; // ~2 min/page ceiling
const BACKOFFICE_MAX_FAILURES = 3;
const BACKOFFICE_SEGMENTS = ["EQ", "FO", "CD", "COM"];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * MONEY-848: classify a per-segment backoffice failure as BENIGN.
 *
 * The Console/backoffice tradebook 400s for a segment the account never trades
 * (the QA logs show `segment=CD FAILED … 400 Bad Request` on EVERY window — a
 * Personal-tier account with no currency-derivatives book). That is an expected
 * "no data for this segment" condition, NOT an outage: makeRequest surfaces it as
 * a deterministic `... API Error: 400 - Bad Request` (4xx is non-retryable). We
 * still record it as a failed segment (so the all-segments-failed throw is
 * preserved), but downgrade its log from a per-window WARN to a single INFO note
 * so a routine empty CD/COM book stops spamming the worker logs ~10× per connect
 * (the year-by-year backfill calls getHistoricalTrades once per window, each
 * looping all 4 segments). Genuine failures (timeouts, 5xx, repeated FAILURE)
 * are NOT 400s and stay at WARN.
 */
function isBenignSegmentError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return msg.includes("400") || msg.includes("Bad Request");
}

/** YYYY-MM-DD in IST (the timezone Kite's date filters expect). */
const toIstDateString = (d: Date): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

export class ZerodhaClient extends BaseBrokerClient {
  private apiKey: string;

  /**
   * MONEY-500: timing + schema-drift metadata from the most recent
   * getHoldings() call, read by the sync layer (broker-connection.ts) for
   * latency telemetry + drift alerting. Side-channel because this low-level
   * client must not depend on the logger / PostHog.
   */
  public lastHoldingsMeta?: {
    durationMs: number;
    rowCount: number;
    driftKeys: string[];
    missingRequired: string[];
  };

  constructor(credentials: BrokerCredentials) {
    super("ZERODHA", credentials);
    this.apiKey = credentials.apiKey || process.env.ZERODHA_API_KEY || "";
  }

  protected getAuthHeaders(): Record<string, string> {
    return {
      "X-Kite-Version": "3",
      Authorization: `token ${this.apiKey}:${this.credentials.accessToken}`,
    };
  }

  async getProfile(): Promise<BrokerProfile> {
    const response = await this.makeRequest<any>("/user/profile");
    return {
      userId: response.data.user_id,
      userName: response.data.user_name,
      email: response.data.email,
      broker: "ZERODHA",
      exchanges: response.data.exchanges || [],
      products: response.data.products || [],
    };
  }

  async getHoldings(): Promise<NormalizedHolding[]> {
    const startedAt = Date.now();
    const response = await this.makeRequest<any>("/portfolio/holdings");
    const raw = (response.data || []) as unknown[];
    const drift = validateZerodhaHoldingShape(raw);
    const normalized = raw.map((h: any) => ({
      symbol: h.tradingsymbol,
      tradingSymbol: h.tradingsymbol,
      // Use tradingsymbol as name (better than instrument_token)
      // Full company name would require instrument master lookup
      name: h.tradingsymbol,
      instrumentToken: h.instrument_token,
      isin: h.isin,
      exchange: h.exchange,
      quantity: h.quantity,
      averagePrice: h.average_price,
      currentPrice: h.last_price,
      closePrice: h.close_price,
      investedValue: h.quantity * h.average_price,
      currentValue: h.quantity * h.last_price,
      pnl: h.pnl,
      pnlPercentage:
        h.average_price > 0
          ? ((h.last_price - h.average_price) / h.average_price) * 100
          : 0,
      dayChange: h.day_change,
      dayChangePercentage: h.day_change_percentage,
      t1Quantity: h.t1_quantity,
      pledgedQuantity: h.pledged_quantity || 0,
      collateralQuantity: h.collateral_quantity || 0,
      // MTF (Margin Trading Facility) data
      mtf: h.mtf
        ? {
            quantity: h.mtf.quantity,
            usedQuantity: h.mtf.used_quantity,
            averagePrice: h.mtf.average_price,
            value: h.mtf.value,
            initialMargin: h.mtf.initial_margin,
          }
        : null,
    }));
    this.lastHoldingsMeta = {
      durationMs: Date.now() - startedAt,
      rowCount: normalized.length,
      driftKeys: drift.driftKeys,
      missingRequired: drift.missingRequired,
    };
    return normalized;
  }

  async getPositions(): Promise<NormalizedPosition[]> {
    const response = await this.makeRequest<any>("/portfolio/positions");
    const positions: NormalizedPosition[] = [];

    // Only use NET positions - DAY is a subset view of today's activity
    // and duplicates every position that also appears in NET.
    for (const p of response.data?.net || []) {
      positions.push(this.normalizePosition(p, "NET"));
    }

    return positions;
  }

  private normalizePosition(p: any, type: "DAY" | "NET"): NormalizedPosition {
    // Derive segment from exchange (NSE = equity, NFO = F&O, etc.)
    const segment = this.getSegmentFromExchange(p.exchange);

    return {
      symbol: p.tradingsymbol,
      tradingSymbol: p.tradingsymbol,
      instrumentToken: p.instrument_token,
      exchange: p.exchange,

      // Raw codes
      segment: segment,
      productType: p.product,
      positionType: type,

      // User-friendly labels
      segmentLabel: getSegmentLabel(segment),
      productTypeLabel: getProductTypeLabel(p.product),
      positionTypeLabel: getPositionTypeLabel(type),

      // Quantities
      quantity: p.quantity,
      buyQuantity: p.buy_quantity,
      sellQuantity: p.sell_quantity,
      overnightQuantity: p.overnight_quantity || 0,

      // Prices
      buyPrice: p.buy_price,
      sellPrice: p.sell_price,
      averagePrice: p.average_price,
      lastPrice: p.last_price,
      closePrice: p.close_price,

      // Day-specific values
      dayBuyQuantity: p.day_buy_quantity || 0,
      dayBuyPrice: p.day_buy_price || 0,
      dayBuyValue: p.day_buy_value || 0,
      daySellQuantity: p.day_sell_quantity || 0,
      daySellPrice: p.day_sell_price || 0,
      daySellValue: p.day_sell_value || 0,

      // Values
      buyValue: p.buy_value,
      sellValue: p.sell_value,
      value: p.value,

      // P&L
      pnl: p.pnl,
      m2m: p.m2m,
      realizedPnl: p.realised,
      unrealizedPnl: p.unrealised,
      pnlPercentage:
        p.average_price && p.quantity
          ? (p.pnl / Math.abs(p.quantity * p.average_price)) * 100
          : 0,

      multiplier: p.multiplier,
    };
  }

  async getTrades(fromDate?: Date, toDate?: Date): Promise<NormalizedTrade[]> {
    const response = await this.makeRequest<any>("/trades");
    const normalized = (response.data || [])
      .map((t: any) => {
        // Derive segment from exchange, not product
        // NSE/BSE = Equity (CASH), NFO/BFO = F&O, CDS = Currency, MCX = Commodity
        const segment = this.getSegmentFromExchange(t.exchange);
        // MONEY-582e: normalize the side. The old `as "BUY"|"SELL"` cast did no
        // validation; FIFO pairing filters BUY and SELL separately, so a
        // mis-cased/unexpected value would land in neither and the trade would
        // be silently dropped from pairing. normalizeSide returns null for an
        // unrecognized side; we filter those out below rather than mis-pair.
        const transactionType = normalizeSide(t.transaction_type);
        // Zerodha returns average_price as the execution price (not "price").
        // MONEY-582e: coerce to a finite number so a string/null can't poison
        // value = qty * price into NaN.
        const executionPrice =
          toFiniteNumber(t.average_price) || toFiniteNumber(t.price);
        const quantity = toFiniteNumber(t.quantity);

        // Extract ISIN for proper pairing across symbol name changes
        // For MF segment: tradingsymbol IS the ISIN (e.g., INF277K01QO1)
        // For equity: use isin field if available from API
        // For F&O and other segments: tradingsymbol is used as identifier
        let isin: string | undefined;
        if (segment === "MF" && t.tradingsymbol) {
          // For mutual funds, the tradingsymbol IS the ISIN
          isin = t.tradingsymbol;
        } else if (t.isin) {
          // Use ISIN from API if available
          isin = t.isin;
        }

        return {
          tradeId: t.trade_id,
          orderId: t.order_id,
          symbol: t.tradingsymbol,
          tradingSymbol: t.tradingsymbol,
          isin: isin,
          exchange: t.exchange,
          segment: segment,
          transactionType,
          quantity,
          price: executionPrice,
          value: quantity * executionPrice,
          // MONEY-582b: Kite sends fill_timestamp as IST wall-clock with no
          // offset ("2024-06-13 09:18:18"); new Date() parses it as host-UTC
          // and stores it 5.5h early, corrupting FIFO pairing. Parse as +05:30
          // with a fallback chain; last-resort `now` keeps a non-null Date.
          tradeTime:
            parseKiteTimestamp(
              t.fill_timestamp,
              t.exchange_timestamp,
              t.order_timestamp,
            ) ?? new Date(),
          productType: t.product,
          orderType: t.order_type,
        };
      })
      // MONEY-582e: drop rows with an unrecognized side (can't be paired); this
      // narrows transactionType from "BUY"|"SELL"|null back to "BUY"|"SELL".
      .filter(
        (t: { transactionType: "BUY" | "SELL" | null }): t is NormalizedTrade =>
          t.transactionType !== null,
      );
    return normalized;
  }

  async getOrders(): Promise<NormalizedOrder[]> {
    const response = await this.makeRequest<any>("/orders");
    return (response.data || []).map((o: any) => ({
      orderId: o.order_id,
      symbol: o.tradingsymbol,
      tradingSymbol: o.tradingsymbol,
      exchange: o.exchange,
      segment: this.getSegmentFromExchange(o.exchange),
      transactionType: o.transaction_type as "BUY" | "SELL",
      orderType: this.mapOrderType(o.order_type),
      productType: o.product,
      quantity: o.quantity,
      price: o.price,
      triggerPrice: o.trigger_price,
      filledQuantity: o.filled_quantity,
      pendingQuantity: o.pending_quantity,
      status: this.mapOrderStatus(o.status),
      statusMessage: o.status_message,
      // MONEY-582b: parse Kite IST timestamps as +05:30, not host-UTC.
      orderTime: parseKiteTimestamp(o.order_timestamp) ?? new Date(),
      updateTime: parseKiteTimestamp(o.exchange_update_timestamp) ?? undefined,
    }));
  }

  async getMargins(): Promise<NormalizedMargins> {
    const response = await this.makeRequest<any>("/user/margins");
    const equity = response.data?.equity || {};
    return {
      availableCash: equity.available?.cash || 0,
      usedMargin: equity.utilised?.debits || 0,
      totalMargin: equity.net || 0,
      collateral: equity.available?.collateral || 0,
    };
  }

  /**
   * MONEY-837: Historical (multi-day) tradebook via the Kite Console/backoffice
   * API. Unlike /trades (day-only), GET /backoffice/tradebook returns history
   * across a date range — but it is ASYNC (poll state PENDING→SUCCESS),
   * PAGINATED, and fetched PER SEGMENT. Slow by design, so this is a worker-side
   * backfill, NOT a synchronous web request.
   */
  async getHistoricalTrades(
    fromDate: Date,
    toDate: Date,
    segments: string[] = BACKOFFICE_SEGMENTS,
  ): Promise<NormalizedTrade[]> {
    const from = toIstDateString(fromDate);
    const to = toIstDateString(toDate);
    const all: NormalizedTrade[] = [];

    // MONEY-839: isolate per-segment failures. The account may have no CD/COM
    // (currency/commodity) history → the backoffice 400s for that segment. A
    // throw there must NOT discard the segments already fetched (EQ/FO), so each
    // segment is independent; only a TOTAL outage (every segment failed) is
    // surfaced as a throw.
    let failedSegments = 0;
    let lastSegmentError: unknown;
    for (const segment of segments) {
      try {
        let page = 1;
        let totalPages = 1;
        let rawRows = 0;
        let parsedRows = 0;
        let synthesizedIds = 0;
        let sampleKeys: string[] | null = null;
        do {
          const { result, pagination } =
            await this.fetchBackofficeTradebookPage(segment, from, to, page);
          rawRows += result.length;
          if (result.length && !sampleKeys) {
            sampleKeys = Object.keys(result[0] ?? {});
          }
          for (const row of result) {
            const t = this.normalizeBackofficeTrade(row);
            if (t) {
              all.push(t);
              parsedRows += 1;
              if (t.tradeId.startsWith("bo:")) synthesizedIds += 1;
            }
          }
          totalPages = pagination?.total_pages ?? 1;
          page += 1;
        } while (page <= totalPages);

        // Surface the CORRECT issue rather than a silent "0 trades". Counts +
        // field KEYS only (never trade values) — per the sanitization rule.
        // raw>0 but parsed=0 == a field-name/schema mismatch (the row keys tell
        // us which fields to map); raw=0 == genuinely no settled history.
        if (rawRows > 0 && parsedRows === 0) {
          console.warn(
            `[zerodha-backoffice] segment=${segment}: API returned ${rawRows} row(s) but PARSED 0 — field/schema mismatch in normalizeBackofficeTrade. row keys=[${sampleKeys?.join(",") ?? "?"}]`,
          );
        } else {
          console.log(
            `[zerodha-backoffice] segment=${segment}: ${rawRows} row(s) -> ${parsedRows} trade(s)${synthesizedIds > 0 ? ` [${synthesizedIds} SYNTHESIZED id — backoffice exposed no trade_id]` : ""} (range ${from}..${to})`,
          );
        }
      } catch (err) {
        failedSegments += 1;
        lastSegmentError = err;
        // MONEY-848: a 400 on a segment = no data / segment not enabled for this
        // account (e.g. CD/COM on a cash-only book) — an expected, benign skip,
        // so a single INFO note, not a per-window WARN. Anything else (timeout,
        // 5xx, repeated backoffice FAILURE) is a real problem → WARN.
        if (isBenignSegmentError(err)) {
          console.info(
            `[zerodha-backoffice] segment=${segment}: no data for this account (skipped, range ${from}..${to})`,
          );
        } else {
          console.warn(
            `[zerodha-backoffice] segment=${segment} FAILED — skipping (kept ${all.length} trade(s) so far): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    // Every segment failed → surface it (don't return a misleading empty []).
    // (A 400 on a SINGLE segment is benign — handled above; only a TOTAL outage,
    // where no segment yielded data AND every one errored, throws. The worker's
    // year-by-year loop tolerates an empty older window, so an all-benign run on
    // an old range still makes progress on the ranges that DO have data.)
    if (segments.length > 0 && failedSegments === segments.length) {
      throw lastSegmentError instanceof Error
        ? lastSegmentError
        : new Error(String(lastSegmentError));
    }

    return all;
  }

  /**
   * Poll ONE page of the async backoffice tradebook until it resolves. The first
   * request triggers the job (state PENDING); re-poll the SAME URL until SUCCESS
   * (data ready) or FAILURE. Bounded by poll + failure ceilings so a stuck job
   * can't loop forever.
   */
  private async fetchBackofficeTradebookPage(
    segment: string,
    fromDate: string,
    toDate: string,
    page: number,
  ): Promise<{
    result: Array<Record<string, unknown>>;
    pagination: { total_pages?: number } | null;
  }> {
    const path =
      `/backoffice/tradebook?segment=${encodeURIComponent(segment)}` +
      `&from_date=${fromDate}&to_date=${toDate}&page=${page}` +
      `&sort_by=order_execution_time&sort_desc=false`;

    let failures = 0;
    for (let attempt = 0; attempt < BACKOFFICE_MAX_POLLS; attempt++) {
      const response = await this.makeRequest<any>(path);
      const data = response?.data;
      const state = data?.state;
      if (state === "SUCCESS") {
        return {
          result: Array.isArray(data.result) ? data.result : [],
          pagination: data.pagination ?? null,
        };
      }
      if (state === "FAILURE") {
        failures += 1;
        if (failures >= BACKOFFICE_MAX_FAILURES) {
          throw new Error(
            `ZERODHA backoffice tradebook FAILED (segment=${segment}, page=${page})`,
          );
        }
      }
      // PENDING / transient FAILURE / unknown → wait, then re-poll (re-triggers).
      // Interval is env-tunable (ZERODHA_BACKOFFICE_POLL_MS) for ops + tests.
      await sleep(
        Number(process.env.ZERODHA_BACKOFFICE_POLL_MS) ||
          BACKOFFICE_POLL_INTERVAL_MS,
      );
    }
    throw new Error(
      `ZERODHA backoffice tradebook timed out (segment=${segment}, page=${page})`,
    );
  }

  /** Map a Console/backoffice tradebook row → NormalizedTrade (null if unpairable). */
  private normalizeBackofficeTrade(
    t: Record<string, any>,
  ): NormalizedTrade | null {
    // MONEY-839: tolerate field-name variants across the Console/backoffice
    // schema (snake_case / camelCase / alt keys). A single wrong key silently
    // dropped EVERY row to null → a misleading "0 trades"; the diagnostic in
    // getHistoricalTrades surfaces (raw>0, parsed=0) with the real row keys if
    // any field still doesn't match here.
    const transactionType = normalizeSide(
      t.trade_type ?? t.transaction_type ?? t.type,
    );
    if (!transactionType) return null;
    const exchange = t.exchange ?? t.exchange_name ?? "";
    const segment = this.getSegmentFromExchange(exchange);
    const quantity = toFiniteNumber(t.quantity ?? t.qty ?? t.filled_quantity);
    const price = toFiniteNumber(t.price ?? t.trade_price ?? t.average_price);
    const tradingsymbol = t.tradingsymbol ?? t.symbol ?? t.tradingSymbol;
    const executionTime =
      t.order_execution_time ?? t.trade_time ?? t.executed_at;
    const tradeDate = t.trade_date ?? t.date;

    let isin: string | undefined;
    if (segment === "MF" && tradingsymbol) isin = tradingsymbol;
    else if (t.isin) isin = t.isin;

    // MONEY-839: brokerTradeId is the persist upsert key (@@unique([userId,
    // broker, brokerUserId, brokerTradeId])). The Console/backoffice schema uses
    // non-standard field names (5f304542 had to remap side/symbol/qty/price/time)
    // and may not expose a per-trade id under trade_id/tradeId AT ALL. If it's
    // undefined, persistTrades upserts every row onto `brokerTradeId: undefined`
    // — Prisma REJECTS undefined in a compound-unique where → the whole 730-day
    // backfill THROWS and persists nothing (the 33-of-8553 bug). So read more id
    // variants and, when none is present, SYNTHESIZE a stable deterministic id
    // from the row's identifying fields: each fill gets a distinct key and a
    // re-run upserts the same rows (idempotent) instead of duplicating/colliding.
    const rawTradeId =
      t.trade_id ?? t.tradeId ?? t.trade_no ?? t.tradeNumber ?? t.id;
    const tradeId =
      rawTradeId != null && String(rawTradeId).length > 0
        ? String(rawTradeId)
        : `bo:${segment}:${tradingsymbol ?? ""}:${transactionType}:${quantity}:${price}:${executionTime ?? tradeDate ?? ""}:${t.order_id ?? t.orderId ?? ""}`;

    return {
      tradeId,
      orderId: t.order_id ?? t.orderId,
      symbol: tradingsymbol,
      tradingSymbol: tradingsymbol,
      isin,
      exchange,
      segment,
      transactionType,
      quantity,
      price,
      value: quantity * price,
      // order_execution_time is IST wall-clock, no offset ("2022-03-21T09:27:42")
      // → parse as +05:30; fall back to trade_date midnight IST, then now.
      tradeTime:
        parseKiteTimestamp(executionTime) ??
        (tradeDate ? new Date(`${tradeDate}T00:00:00+05:30`) : new Date()),
      // The backoffice rows carry no product/order type — use safe defaults.
      productType: "",
      orderType: "MARKET",
    };
  }

  async getMutualFunds(): Promise<NormalizedMutualFund[]> {
    try {
      const response = await this.makeRequest<any>("/mf/holdings");
      const normalized = (response.data || []).map((mf: any) => ({
        schemeName: mf.fund,
        // Use tradingsymbol as schemeCode (e.g., INF277K01QO1)
        schemeCode: mf.tradingsymbol,
        tradingSymbol: mf.tradingsymbol, // Store the ISIN-like code
        isin: mf.tradingsymbol || mf.isin || "", // Zerodha uses tradingsymbol as ISIN
        folioNumber: mf.folio,
        folio: mf.folio,
        units: mf.quantity,
        averageNav: mf.average_price,
        currentNav: mf.last_price,
        investedValue: mf.quantity * mf.average_price,
        currentValue: mf.quantity * mf.last_price,
        pnl: mf.pnl,
        pnlPercentage:
          mf.pnl_pct ||
          (mf.average_price > 0
            ? ((mf.last_price - mf.average_price) / mf.average_price) * 100
            : 0),
        xirr: mf.xirr,
        pledgedQuantity: mf.pledged_quantity || 0,
        lasQuantity: mf.las_quantity || 0, // Loan against securities
      }));
      return normalized;
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

  private mapOrderType(type: string): "MARKET" | "LIMIT" | "SL" | "SL-M" {
    const mapping: Record<string, "MARKET" | "LIMIT" | "SL" | "SL-M"> = {
      MARKET: "MARKET",
      LIMIT: "LIMIT",
      SL: "SL",
      "SL-M": "SL-M",
    };
    return mapping[type] || "MARKET";
  }

  private mapOrderStatus(
    status: string,
  ): "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED" {
    const mapping: Record<
      string,
      "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED"
    > = {
      PENDING: "PENDING",
      OPEN: "OPEN",
      COMPLETE: "COMPLETE",
      CANCELLED: "CANCELLED",
      REJECTED: "REJECTED",
      "TRIGGER PENDING": "PENDING",
    };
    return mapping[status] || "PENDING";
  }

  /**
   * Get segment from exchange code
   * NSE/BSE = Equity (CASH)
   * NFO/BFO = Futures & Options (FO)
   * CDS = Currency Derivatives (CD)
   * MCX/NCDEX = Commodity (COM)
   */
  private getSegmentFromExchange(exchange: string): string {
    const exchangeToSegment: Record<string, string> = {
      NSE: "CASH",
      BSE: "CASH",
      NFO: "FO",
      BFO: "FO",
      CDS: "CD",
      MCX: "COM",
      NCDEX: "COM",
    };
    return exchangeToSegment[exchange] || "CASH";
  }

  // Static method to generate login URL
  static getLoginUrl(apiKey: string, redirectUri: string): string {
    return `https://kite.zerodha.com/connect/login?v=3&api_key=${apiKey}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }

  /**
   * Kite Connect session checksum: SHA-256 of (apiKey + requestToken + apiSecret).
   * Exposed so the exact hashing used by {@link exchangeToken} is unit-testable
   * without performing the network token exchange.
   * @see https://kite.trade/docs/connect/v3/user/#authentication
   */
  static generateChecksum(
    apiKey: string,
    requestToken: string,
    apiSecret: string,
  ): string {
    return crypto
      .createHash("sha256")
      .update(apiKey + requestToken + apiSecret)
      .digest("hex");
  }

  // Static method to exchange request token for access token
  static async exchangeToken(
    apiKey: string,
    apiSecret: string,
    requestToken: string,
  ): Promise<{ accessToken: string; userId: string }> {
    const checksum = ZerodhaClient.generateChecksum(
      apiKey,
      requestToken,
      apiSecret,
    );

    const response = await fetch("https://api.kite.trade/session/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Kite-Version": "3",
      },
      body: new URLSearchParams({
        api_key: apiKey,
        request_token: requestToken,
        checksum,
      }),
    });

    if (!response.ok) {
      const errBody = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      const upstream = errBody?.message;
      // Message text preserved EXACTLY — `mapKnownBrokerError` matches
      // "zerodha: the user is not enabled" to render the multi-user-access
      // support card. Only the typed classification is new.
      throw brokerTransportFailure(
        "Zerodha",
        response.status,
        upstream ? `Zerodha: ${upstream}` : "Failed to exchange token",
        upstream,
      );
    }

    // Kite Connect /session/token success envelope: `{ status, data: {...} }`.
    // MONEY-1158: the envelope itself is optional. This used to read
    // `data.data.access_token` unconditionally, so a 200 whose body was an
    // error envelope (no `data` key) threw a bare TypeError — loud, but
    // untriageable, and indistinguishable from a genuine bug in our code.
    const body = (await response.json()) as {
      data?: { access_token?: string; user_id?: string };
      message?: string;
    };
    return {
      accessToken: requireAccessToken(
        "Zerodha",
        body.data?.access_token,
        body.message,
      ),
      userId: requireTokenField("Zerodha", "user_id", body.data?.user_id),
    };
  }
}
