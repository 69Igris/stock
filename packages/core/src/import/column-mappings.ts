/**
 * Broker-specific CSV column mappings.
 * Merged superset from all three parsers (trade-import.ts, import-processor.ts, worker import.ts).
 * Each field maps to an array of possible header names for case-insensitive matching.
 *
 * IMPORTANT: `findColumn` matches a header EXACTLY (case-insensitively) — it does
 * NOT substring-match. So the alias list for each field must contain the literal
 * header string a broker's *export file* uses, which is frequently different from
 * that broker's *API* field name. The aliases below were reconciled (MONEY-1074)
 * against the real tradebook/trade-report exports of each Indian broker; the old
 * API-derived aliases (`tradedPrice`, `orderDateTime`, `symbolname`, …) are kept
 * as fallbacks but the export headers come first.
 */

import type { BrokerFormat, ColumnMapping } from "./types";

/**
 * Angel One's Trade History / Sauda Summary export uses spaced Title-Case
 * headers (`Trade Date`, `Buy/Sell`, `Order No`, …). The two historical format
 * keys `angel` and `angelone` previously carried divergent alias sets; they now
 * share ONE mapping so either key parses the same file (MONEY-1074).
 */
const ANGEL_MAPPING: ColumnMapping = {
  symbol: [
    "Symbol",
    "symbol",
    "Trading Symbol",
    "Scrip",
    "Scrip Name",
    "scripname",
    "Symbol Name",
    "symbolname",
  ],
  isin: ["ISIN", "isin"],
  tradeDate: ["Trade Date", "trade_date", "Date", "Trade date"],
  exchange: ["Exchange", "exchange", "exch_seg"],
  segment: ["Segment", "segment"],
  tradeType: [
    "Trade Type",
    "trade_type",
    "Buy/Sell",
    "buy/sell",
    "Transaction Type",
    "transactiontype",
  ],
  quantity: ["Quantity", "quantity", "Qty", "qty"],
  price: ["Price", "price", "Rate", "Avg Price", "Average Price", "avgprice"],
  orderId: ["Order No", "orderno", "Order ID", "order_id"],
  tradeId: ["Trade No", "tradeno", "Trade ID", "trade_id"],
  productType: ["Product Type", "producttype", "Product", "product"],
};

const COLUMN_MAPPINGS: Record<BrokerFormat, ColumnMapping> = {
  zerodha: {
    symbol: ["Symbol", "symbol", "tradingsymbol", "Tradingsymbol"],
    isin: ["ISIN", "isin"],
    tradeDate: ["Trade Date", "trade_date", "Trade date"],
    exchange: ["Exchange", "exchange"],
    segment: ["Segment", "segment"],
    tradeType: ["Trade Type", "trade_type", "Trade type"],
    quantity: ["Quantity", "quantity", "Qty"],
    price: ["Price", "price", "Avg. Price", "Average Price"],
    orderId: ["Order ID", "order_id"],
    tradeId: ["Trade ID", "trade_id"],
    orderExecutionTime: ["Order Execution Time", "order_execution_time"],
    productType: ["Product", "product"],
    series: ["Series", "series"],
    auction: ["Auction", "auction"],
    expiryDate: ["Expiry Date", "expiry_date"],
  },
  upstox: {
    symbol: [
      "Symbol",
      "symbol",
      "Trading Symbol",
      "trading_symbol",
      "Scrip Name",
      "scrip_name",
      "Company",
      "Company Name",
    ],
    isin: ["ISIN", "isin"],
    tradeDate: ["Trade Date", "trade_date", "date", "Date"],
    exchange: ["Exchange", "exchange"],
    segment: ["Segment", "segment"],
    tradeType: [
      "Trade Type",
      "trade_type",
      "transaction_type",
      "side",
      "Transaction Type",
      "Buy/Sell",
      "buy/sell",
    ],
    quantity: ["Quantity", "quantity", "qty", "traded_quantity", "Traded Qty"],
    price: [
      "Price",
      "price",
      "avg_price",
      "average_price",
      "Avg Price",
      "Average Price",
    ],
    orderId: ["Order ID", "order_id"],
    tradeId: ["Trade ID", "trade_id"],
  },
  groww: {
    symbol: [
      "Symbol",
      "symbol",
      "Stock name",
      "Stock Name",
      "Stock Symbol",
      "scrip_name",
      "Stock",
      "Ticker",
    ],
    isin: ["ISIN", "isin"],
    tradeDate: ["Trade Date", "trade_date", "Date", "order_date", "Order Date"],
    exchange: ["Exchange", "exchange"],
    tradeType: [
      "Trade Type",
      "trade_type",
      "Transaction Type",
      "Buy/Sell",
      "buy/sell",
      "action",
      "Type",
    ],
    quantity: ["Quantity", "quantity", "Qty", "quantity_traded", "Traded Qty"],
    price: ["Price", "price", "Avg Price", "avg_price", "Average Price"],
  },
  // `angel` and `angelone` intentionally share ANGEL_MAPPING (MONEY-1074).
  angelone: ANGEL_MAPPING,
  angel: ANGEL_MAPPING,
  dhan: {
    // `customSymbol` is the human-readable name column; `tradingSymbol` is
    // frequently NULL in Dhan exports, so custom comes first.
    symbol: [
      "customSymbol",
      "Custom Symbol",
      "Symbol",
      "Trading Symbol",
      "tradingSymbol",
    ],
    isin: ["ISIN", "isin"],
    tradeDate: [
      "exchangeTime",
      "Exchange Time",
      "Trade Date",
      "orderDate",
      "createTime",
    ],
    exchange: ["Exchange", "exchange", "exchangeSegment"],
    segment: ["Segment", "segment", "exchangeSegment"],
    tradeType: ["Transaction Type", "transactionType", "Buy/Sell", "buy/sell"],
    quantity: ["Quantity", "quantity", "tradedQuantity", "Traded Quantity"],
    price: ["Price", "tradedPrice", "Traded Price", "price"],
    orderId: ["Order ID", "orderId"],
  },
  fyers: {
    // Fyers exports the instrument as `Name` = "NSE:SBIN-EQ"; the row-parser
    // strips the exchange prefix + series suffix via splitExchangePrefixedSymbol.
    symbol: ["Name", "Symbol", "symbol"],
    tradeDate: [
      "Date and time",
      "Date and Time",
      "Trade Date",
      "orderDateTime",
    ],
    exchange: ["Exchange", "exchange"],
    segment: ["Segment", "segment"],
    tradeType: ["Side", "side", "transactionType", "Buy/Sell", "buy/sell"],
    quantity: ["Qty", "Traded Qty", "tradedQty", "quantity", "qty"],
    price: [
      "Traded price",
      "Trade Price",
      "tradePrice",
      "tradedPrice",
      "price",
    ],
    orderId: ["FYERS order ID", "Exchange order ID", "Order ID", "id"],
    productType: ["Product type", "Product Type", "productType"],
  },
  generic: {
    symbol: [
      "Symbol",
      "symbol",
      "Stock",
      "Stock name",
      "Ticker",
      "Name",
      "Script",
      "scrip",
      "scrip_name",
      "customSymbol",
      "instrument",
      "trading symbol",
      "tradingsymbol",
      // Mutual-fund order exports name the instrument by scheme, not ticker.
      "Scheme Name",
      "scheme_name",
      "Scheme",
      "Fund Name",
      "fund_name",
      "Security Name",
      "Company Name",
    ],
    isin: ["ISIN", "isin", "isin code", "isin_code"],
    tradeDate: [
      "Trade Date",
      "trade_date",
      "Date",
      "date",
      "Date and time",
      "Transaction Date",
      "Order Date",
      "order_date",
      "Execution Date",
      "tradedate",
      "exchangeTime",
      "order_execution_time",
    ],
    exchange: ["Exchange", "exchange", "Market", "Exch", "exch", "market"],
    segment: ["Segment", "segment", "Category", "Type", "series"],
    tradeType: [
      "Trade Type",
      "trade_type",
      "Type",
      "Side",
      "Action",
      "Transaction Type",
      "Buy/Sell",
      "B/S",
      "tradetype",
      "type",
      "side",
      "buy/sell",
      "b/s",
      "transaction type",
      "Order Side",
    ],
    quantity: [
      "Quantity",
      "quantity",
      "Qty",
      "Volume",
      "Shares",
      "Units",
      "No. of Units",
      "Units Allotted",
      "qty",
      "traded qty",
      "traded_qty",
      "volume",
    ],
    price: [
      "Price",
      "price",
      "Rate",
      "Avg Price",
      "Average Price",
      "Execution Price",
      "Trade Price",
      "trade price",
      "trade_price",
      "Traded price",
      "avg price",
      "avg_price",
      "rate",
      // Mutual-fund order exports price each unit as NAV.
      "NAV",
      "nav",
      "Purchase NAV",
      "Allotment NAV",
    ],
    productType: ["Product", "product", "Product Type", "producttype"],
    orderType: ["Order Type", "order_type"],
    orderId: ["Order ID", "order_id"],
    tradeId: ["Trade ID", "trade_id"],
  },
};

export function getColumnMapping(format: BrokerFormat): ColumnMapping {
  return COLUMN_MAPPINGS[format] || COLUMN_MAPPINGS.generic;
}
