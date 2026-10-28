/**
 * Broker Data Mappings
 * User-friendly labels and descriptions for broker-specific field values
 */

// Product Types (order/position types)
export const PRODUCT_TYPE_MAP: Record<
  string,
  { label: string; description: string }
> = {
  CNC: {
    label: "Cash & Carry",
    description: "Delivery trades - stocks held overnight",
  },
  MIS: {
    label: "Intraday",
    description: "Margin intraday - squared off same day",
  },
  NRML: {
    label: "Normal F&O",
    description: "Futures & Options - carried overnight",
  },
  BO: {
    label: "Bracket Order",
    description: "Order with stop-loss and target",
  },
  CO: { label: "Cover Order", description: "Order with mandatory stop-loss" },
};

// Segment filter options (only show these in dropdown)
export const SEGMENT_FILTER_OPTIONS: Record<
  string,
  { label: string; description: string }
> = {
  CASH: { label: "Equity", description: "Cash market stocks (NSE/BSE)" },
  FO: { label: "F&O", description: "Futures & Options (NFO/BFO)" },
  CD: { label: "Currency", description: "Currency derivatives (CDS)" },
  COM: { label: "Commodity", description: "Commodity derivatives (MCX)" },
  MF: { label: "Mutual Funds", description: "Mutual fund transactions" },
};

// Full segment mappings (includes legacy values for getSegmentLabel)
// NSE/BSE → CASH (Equity)
// NFO/BFO → FO (Futures & Options)
// CDS → CD (Currency)
// MCX/NCDEX → COM (Commodity)
export const SEGMENT_MAP: Record<
  string,
  { label: string; description: string }
> = {
  // Standard segments
  CASH: { label: "Equity", description: "Cash market stocks (NSE/BSE)" },
  FO: { label: "F&O", description: "Futures & Options (NFO/BFO)" },
  CD: { label: "Currency", description: "Currency derivatives (CDS)" },
  COM: { label: "Commodity", description: "Commodity derivatives (MCX)" },
  MF: { label: "Mutual Funds", description: "Mutual fund transactions" },
  // Legacy: Exchange names used as segments
  NSE: { label: "Equity", description: "NSE Cash" },
  BSE: { label: "Equity", description: "BSE Cash" },
  NFO: { label: "F&O", description: "NSE F&O" },
  BFO: { label: "F&O", description: "BSE F&O" },
  MCX: { label: "Commodity", description: "MCX" },
  CDS: { label: "Currency", description: "Currency" },
  // Legacy: Product types incorrectly stored as segments
  CNC: { label: "Equity", description: "Cash & Carry (Delivery)" },
  MIS: { label: "Equity", description: "Margin Intraday" },
  NRML: { label: "F&O", description: "Normal F&O" },
  EQUITY: { label: "Equity", description: "Cash market stocks" },
};

// Position Types (DAY/NET from Zerodha - these are position categories, NOT intraday/delivery)
// Note: Intraday vs Delivery is determined by PRODUCT TYPE (MIS/CNC/NRML), not position type
export const POSITION_TYPE_MAP: Record<
  string,
  { label: string; description: string }
> = {
  DAY: { label: "Today", description: "Positions opened today" },
  NET: {
    label: "Net",
    description: "Net positions including positions from previous days",
  },
  // Direction-based position types
  LONG: {
    label: "Long",
    description: "Bought position expecting price to rise",
  },
  SHORT: {
    label: "Short",
    description: "Sold position expecting price to fall",
  },
};

// Exchange Types
export const EXCHANGE_MAP: Record<string, { label: string; fullName: string }> =
  {
    NSE: { label: "NSE", fullName: "National Stock Exchange" },
    BSE: { label: "BSE", fullName: "Bombay Stock Exchange" },
    NFO: { label: "NSE F&O", fullName: "NSE Futures & Options" },
    BFO: { label: "BSE F&O", fullName: "BSE Futures & Options" },
    CDS: { label: "Currency", fullName: "Currency Derivatives" },
    MCX: { label: "MCX", fullName: "Multi Commodity Exchange" },
    NCDEX: {
      label: "NCDEX",
      fullName: "National Commodity & Derivatives Exchange",
    },
  };

// Order Types
export const ORDER_TYPE_MAP: Record<
  string,
  { label: string; description: string }
> = {
  MARKET: { label: "Market", description: "Execute at current market price" },
  LIMIT: {
    label: "Limit",
    description: "Execute at specified price or better",
  },
  SL: { label: "Stop-Loss Limit", description: "Stop-loss with limit price" },
  "SL-M": {
    label: "Stop-Loss Market",
    description: "Stop-loss at market price",
  },
};

// Transaction Types
export const TRANSACTION_TYPE_MAP: Record<
  string,
  { label: string; color: string }
> = {
  BUY: { label: "Buy", color: "green" },
  SELL: { label: "Sell", color: "red" },
};

// Trade Source Types
export const TRADE_SOURCE_MAP: Record<
  string,
  { label: string; description: string; isEditable: boolean }
> = {
  SYNCED: {
    label: "Synced",
    description: "Automatically synced from broker",
    isEditable: false,
  },
  IMPORTED: {
    label: "Imported",
    description: "Imported from CSV/XLS file",
    isEditable: true,
  },
  MANUAL: {
    label: "Manual",
    description: "Manually added by user",
    isEditable: true,
  },
};

// Helper functions
export function getProductTypeLabel(code: string): string {
  return PRODUCT_TYPE_MAP[code]?.label || code;
}

export function getSegmentLabel(code: string): string {
  return SEGMENT_MAP[code]?.label || code;
}

export function getPositionTypeLabel(code: string): string {
  return POSITION_TYPE_MAP[code]?.label || code;
}

export function getExchangeLabel(code: string): string {
  return EXCHANGE_MAP[code]?.label || code;
}

export function getExchangeFullName(code: string): string {
  return EXCHANGE_MAP[code]?.fullName || code;
}

export function getOrderTypeLabel(code: string): string {
  return ORDER_TYPE_MAP[code]?.label || code;
}

export function isTradeEditable(sourceType: string): boolean {
  return TRADE_SOURCE_MAP[sourceType]?.isEditable ?? true;
}
