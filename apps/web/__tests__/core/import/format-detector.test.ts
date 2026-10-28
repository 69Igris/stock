/**
 * Broker-format auto-detection + real-export-header parsing (MONEY-1074).
 *
 * Imports the REAL exported symbols from `@usemoney/core/import` (no shadow),
 * so a regression in the shipped detector/mappings fails here. Covers:
 *   - detectBrokerFormat over each broker's distinctive header signature
 *   - splitExchangePrefixedSymbol (Fyers "NSE:SBIN-EQ")
 *   - normalizeTradeType mutual-fund buy verbs
 *   - brokerFormatLabel
 *   - end-to-end parseCSVRow with the ACTUAL export header rows that used to
 *     fail for every broker except Zerodha (Fyers, Dhan customSymbol, MF export)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectBrokerFormat,
  resolveEffectiveBrokerFormat,
  brokerFormatLabel,
  normalizeHeaderToken,
  splitExchangePrefixedSymbol,
  normalizeTradeType,
  parseCSVRow,
  getColumnMapping,
  type BrokerFormat,
} from "@usemoney/core/import";

describe("detectBrokerFormat (MONEY-1074)", () => {
  it("detects Zerodha from auction + order_execution_time", () => {
    const headers = [
      "symbol",
      "isin",
      "trade_date",
      "exchange",
      "segment",
      "series",
      "trade_type",
      "auction",
      "quantity",
      "price",
      "trade_id",
      "order_id",
      "order_execution_time",
    ];
    const r = detectBrokerFormat(headers);
    assert.equal(r.format, "zerodha");
    assert.equal(r.confidence, "high"); // 2 strong tokens
  });

  it("detects Fyers from FYERS order ID / Exchange order ID", () => {
    const headers = [
      "Name",
      "Date and time",
      "Side",
      "Product type",
      "Qty",
      "Traded price",
      "Total value",
      "Segment",
      "Exchange order ID",
      "FYERS order ID",
    ];
    assert.equal(detectBrokerFormat(headers).format, "fyers");
  });

  it("detects Dhan from customSymbol", () => {
    const headers = [
      "orderId",
      "transactionType",
      "exchangeSegment",
      "tradingSymbol",
      "customSymbol",
      "tradedQuantity",
      "tradedPrice",
      "isin",
      "exchangeTime",
    ];
    assert.equal(detectBrokerFormat(headers).format, "dhan");
  });

  it("detects Upstox from scrip_name / instrument_token (not Zerodha)", () => {
    const headers = [
      "exchange",
      "segment",
      "trade_id",
      "trade_date",
      "transaction_type",
      "quantity",
      "price",
      "scrip_name",
      "isin",
      "instrument_token",
      "amount",
    ];
    // Shares trade_id/trade_date with Zerodha but has no auction/order_exec_time.
    assert.equal(detectBrokerFormat(headers).format, "upstox");
  });

  it("detects Angel from Trade No + Order No + Buy/Sell", () => {
    const headers = [
      "Trade Date",
      "Scrip",
      "ISIN",
      "Buy/Sell",
      "Quantity",
      "Rate",
      "Order No",
      "Trade No",
    ];
    assert.equal(detectBrokerFormat(headers).format, "angel");
  });

  it("detects Groww from Stock name", () => {
    const headers = [
      "Stock name",
      "ISIN",
      "Exchange",
      "Buy/Sell",
      "Quantity",
      "Price",
    ];
    assert.equal(detectBrokerFormat(headers).format, "groww");
  });

  it("falls back to generic (low) for the standard template header", () => {
    const headers = [
      "trade_date",
      "symbol",
      "trade_type",
      "quantity",
      "trade_price",
      "exchange",
      "product",
    ];
    const r = detectBrokerFormat(headers);
    assert.equal(r.format, "generic");
    assert.equal(r.confidence, "low");
  });

  it("falls back to generic for unknown headers and empty input", () => {
    assert.equal(detectBrokerFormat(["foo", "bar", "baz"]).format, "generic");
    assert.equal(detectBrokerFormat([]).format, "generic");
  });

  it("is case- and whitespace-insensitive on header tokens", () => {
    assert.equal(
      normalizeHeaderToken("  FYERS   order   ID "),
      "fyers order id"
    );
    const headers = [
      "name",
      "date and time",
      "side",
      "qty",
      "  FYERS Order ID ",
    ];
    assert.equal(detectBrokerFormat(headers).format, "fyers");
  });
});

describe("splitExchangePrefixedSymbol (MONEY-1074)", () => {
  it("splits Fyers NSE:SBIN-EQ into symbol + exchange", () => {
    assert.deepEqual(splitExchangePrefixedSymbol("NSE:SBIN-EQ"), {
      symbol: "SBIN",
      exchange: "NSE",
    });
  });

  it("splits BSE prefix and strips -BE series", () => {
    assert.deepEqual(splitExchangePrefixedSymbol("BSE:TATASTEEL-BE"), {
      symbol: "TATASTEEL",
      exchange: "BSE",
    });
  });

  it("leaves a bare equity symbol untouched (no exchange)", () => {
    assert.deepEqual(splitExchangePrefixedSymbol("INFY"), {
      symbol: "INFY",
      exchange: undefined,
    });
  });

  it("does NOT mangle a derivative symbol (no colon, no -EQ suffix)", () => {
    assert.deepEqual(splitExchangePrefixedSymbol("NIFTY2430622000CE"), {
      symbol: "NIFTY2430622000CE",
      exchange: undefined,
    });
  });

  it("keeps the exchange from an F&O prefix while leaving the option intact", () => {
    assert.deepEqual(splitExchangePrefixedSymbol("NFO:NIFTY24JAN22000CE"), {
      symbol: "NIFTY24JAN22000CE",
      exchange: "NFO",
    });
  });

  it("handles empty / whitespace input safely", () => {
    assert.deepEqual(splitExchangePrefixedSymbol("   "), {
      symbol: "",
      exchange: undefined,
    });
  });
});

describe("normalizeTradeType mutual-fund verbs (MONEY-1074)", () => {
  it("maps MF buy-side verbs to BUY", () => {
    for (const v of [
      "Purchase",
      "PURCHASED",
      "Subscription",
      "Subscribe",
      "Allotment",
      "Allotted",
      "SIP",
      "Invest",
      "Investment",
      "Switch In",
      "Switch-In",
    ]) {
      assert.equal(normalizeTradeType(v), "BUY", `${v} should be BUY`);
    }
  });

  it("maps MF sell-side verbs (and everything unrecognised) to SELL", () => {
    for (const v of ["Redeem", "Redemption", "Switch Out", "Sold", "Sale"]) {
      assert.equal(normalizeTradeType(v), "SELL", `${v} should be SELL`);
    }
  });

  it("preserves the equity BUY/SELL contract", () => {
    assert.equal(normalizeTradeType("BUY"), "BUY");
    assert.equal(normalizeTradeType("B"), "BUY");
    assert.equal(normalizeTradeType("SELL"), "SELL");
    assert.equal(normalizeTradeType("UNKNOWN"), "SELL");
  });
});

describe("resolveEffectiveBrokerFormat (MONEY-1074)", () => {
  // The single source of truth shared by previewFileAction + the import worker.
  const FYERS_HEADERS = [
    "Name",
    "Date and time",
    "Side",
    "Qty",
    "Traded price",
    "FYERS order ID",
  ];
  const TEMPLATE_HEADERS = [
    "trade_date",
    "symbol",
    "trade_type",
    "quantity",
    "trade_price",
  ];

  it("auto-detects the broker when the requested format is generic", () => {
    assert.equal(
      resolveEffectiveBrokerFormat("generic", FYERS_HEADERS),
      "fyers"
    );
  });

  it("falls back to generic when nothing matches", () => {
    assert.equal(
      resolveEffectiveBrokerFormat("generic", TEMPLATE_HEADERS),
      "generic"
    );
  });

  it("respects an explicit broker choice (no override)", () => {
    // Explicit zerodha on a Fyers-header file stays zerodha (the user's call).
    assert.equal(
      resolveEffectiveBrokerFormat("zerodha", FYERS_HEADERS),
      "zerodha"
    );
  });

  it("treats a missing/empty format as auto-detect (worker safety)", () => {
    assert.equal(
      resolveEffectiveBrokerFormat("" as BrokerFormat, FYERS_HEADERS),
      "fyers"
    );
  });
});

describe("brokerFormatLabel (MONEY-1074)", () => {
  it("labels each format for the UI badge", () => {
    assert.equal(brokerFormatLabel("zerodha"), "Zerodha");
    assert.equal(brokerFormatLabel("fyers"), "Fyers");
    assert.equal(brokerFormatLabel("angel"), "Angel One");
    assert.equal(brokerFormatLabel("angelone"), "Angel One");
    assert.equal(brokerFormatLabel("generic"), "Standard format");
  });
});

describe("real broker export headers now parse (MONEY-1074)", () => {
  // Each fixture is one row keyed by the broker's ACTUAL export headers.
  const parseOne = (format: BrokerFormat, row: Record<string, unknown>) =>
    parseCSVRow(row, getColumnMapping(format), 2);

  it("Fyers row (Name/Date and time/Side/Qty/Traded price) parses", () => {
    const parsed = parseOne("fyers", {
      Name: "NSE:SBIN-EQ",
      "Date and time": "2026-01-15 10:30:00",
      Side: "Buy",
      "Product type": "CNC",
      Qty: "10",
      "Traded price": "620.50",
      "Total value": "6205.00",
      Segment: "Capital Market",
      "Exchange order ID": "111",
      "FYERS order ID": "222",
    });
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.data.symbol, "SBIN"); // prefix + -EQ stripped
    assert.equal(parsed.data.exchange, "NSE"); // from the Name prefix
    assert.equal(parsed.data.tradeType, "BUY");
    assert.equal(parsed.data.quantity, 10);
    assert.equal(parsed.data.price, 620.5);
  });

  it("Dhan row falls back to customSymbol when tradingSymbol is empty", () => {
    const parsed = parseOne("dhan", {
      tradingSymbol: "",
      customSymbol: "RELIANCE",
      "Transaction Type": "SELL",
      exchangeSegment: "NSE_EQ",
      tradedQuantity: "5",
      tradedPrice: "2800",
      exchangeTime: "2026-01-15 11:00:00",
      isin: "INE002A01018",
    });
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.data.symbol, "RELIANCE");
    assert.equal(parsed.data.tradeType, "SELL");
    assert.equal(parsed.data.quantity, 5);
    assert.equal(parsed.data.price, 2800);
  });

  it("Angel row (Scrip/Buy-Sell/Rate/Order No) parses via shared mapping", () => {
    for (const format of ["angel", "angelone"] as BrokerFormat[]) {
      const parsed = parseOne(format, {
        "Trade Date": "2026-01-15",
        Scrip: "TCS",
        ISIN: "INE467B01029",
        "Buy/Sell": "Buy",
        Quantity: "3",
        Rate: "3900",
        "Order No": "A1",
        "Trade No": "T1",
      });
      assert.equal(parsed.error, undefined, `${format} should parse`);
      assert.equal(parsed.data.symbol, "TCS");
      assert.equal(parsed.data.tradeType, "BUY");
      assert.equal(parsed.data.price, 3900);
    }
  });

  it("generic mutual-fund order row (Scheme Name/NAV/Units) parses", () => {
    const parsed = parseOne("generic", {
      "Scheme Name": "Parag Parikh Flexi Cap Fund",
      "Order date": "2026-01-15",
      "Transaction Type": "Purchase",
      Units: "100.5",
      NAV: "65.20",
    });
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.data.symbol, "PARAG PARIKH FLEXI CAP FUND");
    assert.equal(parsed.data.tradeType, "BUY");
    assert.equal(parsed.data.quantity, 100.5);
    assert.equal(parsed.data.price, 65.2);
  });
});
