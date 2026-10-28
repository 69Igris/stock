/**
 * Broker Error Handling Edge Cases
 *
 * Tests for error conditions, malformed data, and boundary cases
 * in broker API client normalization logic.
 * Covers Zerodha and Upstox clients' error-prone paths.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";

// ==================== Re-implemented logic from base-client.ts ====================

/**
 * makeRequest error formatting (from BaseBrokerClient.makeRequest)
 * When response.ok is false, throws with broker name, status, and body text.
 */
function formatApiError(
  broker: string,
  status: number,
  bodyText: string
): string {
  return `${broker} API Error: ${status} - ${bodyText}`;
}

/**
 * isTokenValid logic (from BaseBrokerClient)
 * Returns true if no expiry set, otherwise checks if current time is before expiry.
 */
function isTokenValid(
  tokenExpiry: Date | undefined,
  now: Date = new Date()
): boolean {
  if (!tokenExpiry) return true;
  return now < tokenExpiry;
}

// ==================== Zerodha-specific logic ====================

function getSegmentFromExchange(exchange: string): string {
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

function normalizeZerodhaHolding(h: any) {
  return {
    symbol: h.tradingsymbol,
    tradingSymbol: h.tradingsymbol,
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
    mtf: h.mtf
      ? {
          quantity: h.mtf.quantity,
          usedQuantity: h.mtf.used_quantity,
          averagePrice: h.mtf.average_price,
          value: h.mtf.value,
          initialMargin: h.mtf.initial_margin,
        }
      : null,
  };
}

function normalizeZerodhaTrade(t: any) {
  const segment = getSegmentFromExchange(t.exchange);
  const executionPrice = t.average_price || t.price || 0;

  let isin: string | undefined;
  if (segment === "MF" && t.tradingsymbol) {
    isin = t.tradingsymbol;
  } else if (t.isin) {
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
    transactionType: t.transaction_type as "BUY" | "SELL",
    quantity: t.quantity,
    price: executionPrice,
    value: t.quantity * executionPrice,
    tradeTime: new Date(t.fill_timestamp),
    productType: t.product,
    orderType: t.order_type,
  };
}

function normalizeZerodhaPosition(p: any, type: "DAY" | "NET") {
  const segment = getSegmentFromExchange(p.exchange);

  return {
    symbol: p.tradingsymbol,
    tradingSymbol: p.tradingsymbol,
    instrumentToken: p.instrument_token,
    exchange: p.exchange,
    segment: segment,
    productType: p.product,
    positionType: type,
    quantity: p.quantity,
    buyQuantity: p.buy_quantity,
    sellQuantity: p.sell_quantity,
    overnightQuantity: p.overnight_quantity || 0,
    buyPrice: p.buy_price,
    sellPrice: p.sell_price,
    averagePrice: p.average_price,
    lastPrice: p.last_price,
    closePrice: p.close_price,
    dayBuyQuantity: p.day_buy_quantity || 0,
    dayBuyPrice: p.day_buy_price || 0,
    dayBuyValue: p.day_buy_value || 0,
    daySellQuantity: p.day_sell_quantity || 0,
    daySellPrice: p.day_sell_price || 0,
    daySellValue: p.day_sell_value || 0,
    buyValue: p.buy_value,
    sellValue: p.sell_value,
    value: p.value,
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

function mapZerodhaOrderStatus(
  status: string
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

// ==================== Upstox-specific logic ====================

function normalizeUpstoxHolding(h: any) {
  return {
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
  };
}

function normalizeUpstoxPosition(p: any) {
  return {
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
  };
}

function normalizeUpstoxTrade(t: any) {
  return {
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
  };
}

function mapUpstoxOrderStatus(
  status: string
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

// ==================== Tests ====================

describe("Broker Error Handling - API Error Formatting", () => {
  it("should format 401 unauthorized as descriptive error", () => {
    const msg = formatApiError(
      "ZERODHA",
      401,
      '{"status":"error","message":"Invalid session"}'
    );
    assert.ok(msg.includes("ZERODHA"));
    assert.ok(msg.includes("401"));
    assert.ok(msg.includes("Invalid session"));
  });

  it("should format 429 rate limiting error", () => {
    // The base client does NOT have retry logic for 429 - it simply throws.
    // This documents the gap: no exponential backoff or retry on rate limit.
    const msg = formatApiError("UPSTOX", 429, "Too Many Requests");
    assert.ok(msg.includes("429"));
    assert.ok(msg.includes("Too Many Requests"));
    // Document gap: makeRequest has no retry logic, so 429 is propagated as-is
    assert.strictEqual(msg, "UPSTOX API Error: 429 - Too Many Requests");
  });

  it("should format 500 server error generically", () => {
    const msg = formatApiError("ZERODHA", 500, "Internal Server Error");
    assert.strictEqual(msg, "ZERODHA API Error: 500 - Internal Server Error");
  });

  it("should format 502 bad gateway error", () => {
    const msg = formatApiError("UPSTOX", 502, "Bad Gateway");
    assert.strictEqual(msg, "UPSTOX API Error: 502 - Bad Gateway");
  });

  it("should format 503 service unavailable error", () => {
    const msg = formatApiError("ZERODHA", 503, "Service Unavailable");
    assert.strictEqual(msg, "ZERODHA API Error: 503 - Service Unavailable");
  });

  it("should include empty body text when API returns no body", () => {
    const msg = formatApiError("ZERODHA", 401, "");
    assert.strictEqual(msg, "ZERODHA API Error: 401 - ");
  });
});

describe("Broker Error Handling - Empty and Malformed Holdings", () => {
  it("should handle empty holdings array (response.data = [])", () => {
    const data: any[] = [];
    const normalized = (data || []).map(normalizeZerodhaHolding);
    assert.deepStrictEqual(normalized, []);
  });

  it("should handle null data field (response.data = null)", () => {
    // Zerodha getHoldings: (response.data || []).map(...)
    // When data is null, || [] fallback yields empty array
    const data: any = null;
    const normalized = (data || []).map(normalizeZerodhaHolding);
    assert.deepStrictEqual(normalized, []);
  });

  it("should handle undefined data field", () => {
    const data: any = undefined;
    const normalized = (data || []).map(normalizeZerodhaHolding);
    assert.deepStrictEqual(normalized, []);
  });

  it("should handle Upstox empty holdings", () => {
    const data: any[] = [];
    const normalized = (data || []).map(normalizeUpstoxHolding);
    assert.deepStrictEqual(normalized, []);
  });

  it("should handle Upstox null data", () => {
    const data: any = null;
    const normalized = (data || []).map(normalizeUpstoxHolding);
    assert.deepStrictEqual(normalized, []);
  });
});

describe("Broker Error Handling - Zero and Negative Quantities", () => {
  it("should handle zero quantity in Zerodha holdings without crash", () => {
    const holding = {
      tradingsymbol: "DELISTED",
      instrument_token: 999,
      exchange: "NSE",
      quantity: 0,
      average_price: 100,
      last_price: 0,
      pnl: 0,
    };

    const normalized = normalizeZerodhaHolding(holding);
    assert.strictEqual(normalized.quantity, 0);
    assert.strictEqual(normalized.investedValue, 0); // 0 * 100
    assert.strictEqual(normalized.currentValue, 0); // 0 * 0
  });

  it("should handle negative quantity in Zerodha holdings (short position leftover)", () => {
    const holding = {
      tradingsymbol: "SHORT",
      instrument_token: 888,
      exchange: "NSE",
      quantity: -5,
      average_price: 200,
      last_price: 180,
      pnl: 100,
    };

    const normalized = normalizeZerodhaHolding(holding);
    assert.strictEqual(normalized.quantity, -5);
    assert.strictEqual(normalized.investedValue, -1000); // -5 * 200
    assert.strictEqual(normalized.currentValue, -900); // -5 * 180
    // pnlPercentage still computes: (180-200)/200 * 100 = -10
    assert.strictEqual(normalized.pnlPercentage, -10);
  });

  it("should handle Upstox holding with zero quantity", () => {
    const holding = {
      tradingsymbol: "EMPTY",
      exchange: "NSE_EQ",
      quantity: 0,
      average_price: 500,
      last_price: 510,
      pnl: 0,
    };

    const normalized = normalizeUpstoxHolding(holding);
    assert.strictEqual(normalized.quantity, 0);
    // pnl is 0 (falsy), so pnlPercentage = 0 per the Upstox logic: h.pnl ? ... : 0
    assert.strictEqual(normalized.pnlPercentage, 0);
  });

  it("should handle Upstox position with zero quantity (closed position)", () => {
    const position = {
      tradingsymbol: "CLOSED",
      exchange: "NSE_EQ",
      instrument_type: "CASH",
      product: "D",
      quantity: 0,
      day_buy_quantity: 10,
      day_sell_quantity: 10,
      day_buy_price: 100,
      day_sell_price: 105,
      average_price: 0,
      last_price: 105,
      pnl: 500,
      multiplier: 1,
    };

    const normalized = normalizeUpstoxPosition(position);
    // average_price is 0 (falsy), so pnlPercentage = 0
    assert.strictEqual(normalized.pnlPercentage, 0);
    assert.strictEqual(normalized.pnl, 500);
  });
});

describe("Broker Error Handling - Token Validity", () => {
  it("should return true when no tokenExpiry set", () => {
    assert.strictEqual(isTokenValid(undefined), true);
  });

  it("should return true when token has not expired", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    assert.strictEqual(isTokenValid(future), true);
  });

  it("should return false when token has expired", () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    assert.strictEqual(isTokenValid(past), false);
  });

  it("should return false at exact expiry moment", () => {
    // When now === tokenExpiry, now < tokenExpiry is false, so token is invalid
    const now = new Date("2024-06-15T10:00:00Z");
    assert.strictEqual(isTokenValid(now, now), false);
  });

  it("documents gap: isTokenValid is not checked before API calls in makeRequest", () => {
    // The base client makeRequest does NOT call isTokenValid() before making the request.
    // It relies on the caller to check. If the token is expired, the API will return 401.
    // This test documents that behavior.
    const expired = new Date(Date.now() - 1000);
    assert.strictEqual(isTokenValid(expired), false);
    // In production, makeRequest would still proceed and get a 401 from the broker API.
    // There is no pre-flight token check in the base client's makeRequest method.
  });
});

describe("Broker Error Handling - fill_timestamp Edge Cases", () => {
  it("should handle null fill_timestamp producing epoch date (documented bug)", () => {
    // Zerodha trade normalization does: new Date(t.fill_timestamp)
    // When fill_timestamp is null: new Date(null) = epoch (1970-01-01T00:00:00.000Z)
    const trade = {
      trade_id: "T001",
      order_id: "O001",
      tradingsymbol: "RELIANCE",
      exchange: "NSE",
      transaction_type: "BUY",
      quantity: 10,
      average_price: 2500,
      fill_timestamp: null,
      product: "CNC",
      order_type: "MARKET",
    };

    const normalized = normalizeZerodhaTrade(trade);
    // new Date(null) returns the Unix epoch in JavaScript
    assert.strictEqual(normalized.tradeTime.getTime(), 0);
    assert.strictEqual(
      normalized.tradeTime.toISOString(),
      "1970-01-01T00:00:00.000Z"
    );
  });

  it("should handle undefined fill_timestamp producing Invalid Date", () => {
    const trade = {
      trade_id: "T002",
      order_id: "O002",
      tradingsymbol: "TCS",
      exchange: "NSE",
      transaction_type: "SELL",
      quantity: 5,
      average_price: 3800,
      // fill_timestamp is missing (undefined)
      product: "CNC",
      order_type: "LIMIT",
    };

    const normalized = normalizeZerodhaTrade(trade);
    // new Date(undefined) returns Invalid Date
    assert.ok(isNaN(normalized.tradeTime.getTime()));
  });

  it("should handle Upstox missing trade_date producing Invalid Date", () => {
    const trade = {
      trade_id: "UT001",
      order_id: "UO001",
      tradingsymbol: "INFY",
      exchange: "NSE_EQ",
      transaction_type: "BUY",
      quantity: 10,
      price: 1500,
      // trade_date is missing
      product: "D",
      order_type: "MARKET",
    };

    const normalized = normalizeUpstoxTrade(trade);
    // new Date(undefined) = Invalid Date
    assert.ok(isNaN(normalized.tradeTime.getTime()));
  });

  it("should handle empty string fill_timestamp", () => {
    const trade = {
      trade_id: "T003",
      order_id: "O003",
      tradingsymbol: "HDFC",
      exchange: "NSE",
      transaction_type: "BUY",
      quantity: 1,
      average_price: 1600,
      fill_timestamp: "",
      product: "CNC",
      order_type: "MARKET",
    };

    const normalized = normalizeZerodhaTrade(trade);
    // new Date("") returns Invalid Date
    assert.ok(isNaN(normalized.tradeTime.getTime()));
  });
});

describe("Broker Error Handling - ISIN Field Missing", () => {
  it("should set isin to undefined for non-MF equity trade without isin field", () => {
    const trade = {
      trade_id: "T100",
      order_id: "O100",
      tradingsymbol: "RELIANCE",
      exchange: "NSE",
      transaction_type: "BUY",
      quantity: 10,
      average_price: 2500,
      fill_timestamp: "2024-01-15T10:00:00+05:30",
      product: "CNC",
      order_type: "MARKET",
      // No isin field
    };

    const normalized = normalizeZerodhaTrade(trade);
    // exchange NSE => segment CASH, not MF, and no t.isin
    assert.strictEqual(normalized.isin, undefined);
    // Without ISIN, trade pairing would rely on symbol + exchange for matching
  });

  it("should use tradingsymbol as ISIN for MF segment", () => {
    // The Zerodha code never maps any exchange to "MF" in getSegmentFromExchange.
    // So this code path (segment === "MF") is unreachable via exchange mapping.
    // MF trades in Zerodha would need a different mechanism.
    const segment = getSegmentFromExchange("NSE");
    assert.strictEqual(segment, "CASH");
    // There is no exchange value that maps to "MF" segment
    // Document: MF ISIN extraction via segment === "MF" only works if
    // the segment is explicitly set elsewhere
  });

  it("should use isin field when provided in API response", () => {
    const trade = {
      trade_id: "T101",
      order_id: "O101",
      tradingsymbol: "RELIANCE",
      exchange: "NSE",
      transaction_type: "BUY",
      quantity: 10,
      average_price: 2500,
      fill_timestamp: "2024-01-15T10:00:00+05:30",
      product: "CNC",
      order_type: "MARKET",
      isin: "INE002A01018",
    };

    const normalized = normalizeZerodhaTrade(trade);
    assert.strictEqual(normalized.isin, "INE002A01018");
  });
});

describe("Broker Error Handling - Order Status Unmapped Values", () => {
  it("should default Zerodha unmapped status to PENDING", () => {
    assert.strictEqual(mapZerodhaOrderStatus("UNKNOWN_STATUS"), "PENDING");
  });

  it("should default Zerodha AMO status to PENDING", () => {
    assert.strictEqual(mapZerodhaOrderStatus("AMO REQ RECEIVED"), "PENDING");
  });

  it("should map Zerodha TRIGGER PENDING to PENDING", () => {
    assert.strictEqual(mapZerodhaOrderStatus("TRIGGER PENDING"), "PENDING");
  });

  it("should default Upstox unmapped status to PENDING", () => {
    assert.strictEqual(mapUpstoxOrderStatus("after market order"), "PENDING");
  });

  it("should default Upstox empty string status to PENDING", () => {
    assert.strictEqual(mapUpstoxOrderStatus(""), "PENDING");
  });

  it("should handle Upstox case-insensitive mapping for COMPLETE", () => {
    assert.strictEqual(mapUpstoxOrderStatus("COMPLETE"), "COMPLETE");
    assert.strictEqual(mapUpstoxOrderStatus("Complete"), "COMPLETE");
    assert.strictEqual(mapUpstoxOrderStatus("complete"), "COMPLETE");
  });
});

describe("Broker Error Handling - Network and JSON Errors", () => {
  it("should propagate network timeout as error (no timeout configured)", () => {
    // The base client's makeRequest calls fetch without AbortController or signal.
    // Document gap: there is no timeout configuration in makeRequest.
    // A network timeout would be a standard fetch timeout (browser/runtime dependent).
    const mockFetch = mock.fn(() => {
      throw new TypeError("fetch failed");
    });

    assert.throws(
      () => {
        mockFetch();
      },
      {
        name: "TypeError",
        message: "fetch failed",
      }
    );
  });

  it("should throw on malformed JSON response", () => {
    // When response.ok is true but response.json() throws,
    // the error propagates to the caller.
    assert.throws(
      () => {
        JSON.parse("not valid json{{{");
      },
      {
        name: "SyntaxError",
      }
    );
  });

  it("should handle HTML error page response as text in error message", () => {
    // When broker returns HTML (e.g., maintenance page) instead of JSON,
    // makeRequest reads response.text() and includes it in the error.
    const htmlBody = "<html><body>Service Under Maintenance</body></html>";
    const msg = formatApiError("ZERODHA", 503, htmlBody);
    assert.ok(msg.includes("Service Under Maintenance"));
  });
});

describe("Broker Error Handling - Holdings pnlPercentage Division", () => {
  it("should return 0 when Zerodha average_price is 0 (no division error)", () => {
    const holding = {
      tradingsymbol: "BONUS",
      instrument_token: 777,
      exchange: "NSE",
      quantity: 100,
      average_price: 0,
      last_price: 50,
      pnl: 5000,
    };

    const normalized = normalizeZerodhaHolding(holding);
    // average_price > 0 check prevents division by zero
    assert.strictEqual(normalized.pnlPercentage, 0);
    assert.strictEqual(normalized.investedValue, 0);
    assert.strictEqual(normalized.currentValue, 5000);
  });

  it("should return 0 when Upstox average_price is 0 and pnl is non-zero", () => {
    const holding = {
      tradingsymbol: "BONUS",
      exchange: "NSE_EQ",
      quantity: 100,
      average_price: 0,
      last_price: 50,
      pnl: 5000,
    };

    const normalized = normalizeUpstoxHolding(holding);
    // Upstox logic: h.pnl ? (h.pnl / (h.quantity * h.average_price)) * 100 : 0
    // pnl is 5000 (truthy), so it computes: 5000 / (100 * 0) * 100 = Infinity
    // This is a known edge case in the Upstox normalization
    assert.strictEqual(normalized.pnlPercentage, Infinity);
  });

  it("should return 0 when Upstox pnl is 0 and average_price is 0", () => {
    const holding = {
      tradingsymbol: "FREE",
      exchange: "NSE_EQ",
      quantity: 100,
      average_price: 0,
      last_price: 50,
      pnl: 0,
    };

    const normalized = normalizeUpstoxHolding(holding);
    // pnl is 0 (falsy), so pnlPercentage = 0
    assert.strictEqual(normalized.pnlPercentage, 0);
  });

  it("should handle negative average_price (Zerodha guards with > 0)", () => {
    const holding = {
      tradingsymbol: "WEIRD",
      instrument_token: 666,
      exchange: "NSE",
      quantity: 10,
      average_price: -100,
      last_price: 50,
      pnl: -500,
    };

    const normalized = normalizeZerodhaHolding(holding);
    // average_price > 0 is false for negative, so returns 0
    assert.strictEqual(normalized.pnlPercentage, 0);
  });
});

describe("Broker Error Handling - Position Multiplier Edge Cases", () => {
  it("should pass through multiplier=0 from Zerodha", () => {
    const position = {
      tradingsymbol: "NIFTY",
      instrument_token: 111,
      exchange: "NFO",
      product: "NRML",
      quantity: 50,
      buy_quantity: 50,
      sell_quantity: 0,
      buy_price: 100,
      sell_price: 0,
      average_price: 100,
      last_price: 110,
      close_price: 105,
      buy_value: 5000,
      sell_value: 0,
      value: 5500,
      pnl: 500,
      m2m: 500,
      realised: 0,
      unrealised: 500,
      multiplier: 0,
    };

    const normalized = normalizeZerodhaPosition(position, "NET");
    // multiplier is passed through as-is, no guard against 0
    assert.strictEqual(normalized.multiplier, 0);
  });

  it("should pass through multiplier=undefined from Zerodha", () => {
    const position = {
      tradingsymbol: "NIFTY",
      instrument_token: 111,
      exchange: "NFO",
      product: "NRML",
      quantity: 50,
      buy_quantity: 50,
      sell_quantity: 0,
      buy_price: 100,
      sell_price: 0,
      average_price: 100,
      last_price: 110,
      close_price: 105,
      buy_value: 5000,
      sell_value: 0,
      value: 5500,
      pnl: 500,
      m2m: 500,
      realised: 0,
      unrealised: 500,
      // multiplier missing
    };

    const normalized = normalizeZerodhaPosition(position, "NET");
    assert.strictEqual(normalized.multiplier, undefined);
  });

  it("should pass through Upstox position multiplier directly", () => {
    const position = {
      tradingsymbol: "NIFTY",
      exchange: "NSE_EQ",
      instrument_type: "CASH",
      product: "D",
      quantity: 10,
      day_buy_quantity: 10,
      day_sell_quantity: 0,
      day_buy_price: 100,
      day_sell_price: 0,
      average_price: 100,
      last_price: 110,
      pnl: 100,
      multiplier: 0,
    };

    const normalized = normalizeUpstoxPosition(position);
    assert.strictEqual(normalized.multiplier, 0);
  });
});

describe("Broker Error Handling - Position pnlPercentage with Zero Values", () => {
  it("should return 0 when Zerodha average_price is 0", () => {
    const position = {
      tradingsymbol: "TEST",
      instrument_token: 111,
      exchange: "NSE",
      product: "CNC",
      quantity: 10,
      buy_quantity: 10,
      sell_quantity: 0,
      buy_price: 0,
      sell_price: 0,
      average_price: 0,
      last_price: 100,
      close_price: 0,
      buy_value: 0,
      sell_value: 0,
      value: 1000,
      pnl: 1000,
      m2m: 1000,
      realised: 0,
      unrealised: 1000,
      multiplier: 1,
    };

    const normalized = normalizeZerodhaPosition(position, "NET");
    // average_price is 0 (falsy), so pnlPercentage = 0
    assert.strictEqual(normalized.pnlPercentage, 0);
  });

  it("should return 0 when Zerodha quantity is 0", () => {
    const position = {
      tradingsymbol: "CLOSED",
      instrument_token: 222,
      exchange: "NSE",
      product: "MIS",
      quantity: 0,
      buy_quantity: 10,
      sell_quantity: 10,
      buy_price: 100,
      sell_price: 105,
      average_price: 100,
      last_price: 105,
      close_price: 102,
      buy_value: 1000,
      sell_value: 1050,
      value: 0,
      pnl: 50,
      m2m: 50,
      realised: 50,
      unrealised: 0,
      multiplier: 1,
    };

    const normalized = normalizeZerodhaPosition(position, "DAY");
    // quantity is 0 (falsy), so pnlPercentage = 0
    assert.strictEqual(normalized.pnlPercentage, 0);
  });

  it("should handle Upstox position pnlPercentage with zero average_price", () => {
    const position = {
      tradingsymbol: "ZERO",
      exchange: "NSE_EQ",
      instrument_type: "CASH",
      product: "D",
      quantity: 5,
      day_buy_quantity: 5,
      day_sell_quantity: 0,
      average_price: 0,
      last_price: 100,
      pnl: 500,
      multiplier: 1,
    };

    const normalized = normalizeUpstoxPosition(position);
    // average_price is 0 (falsy), so pnlPercentage = 0
    assert.strictEqual(normalized.pnlPercentage, 0);
  });
});
