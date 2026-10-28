// ============== Broker Types ==============

export type BrokerType =
  | "ZERODHA"
  | "UPSTOX"
  | "DHAN"
  | "FYERS"
  | "ANGEL_ONE"
  | "GROWW"
  | "ICICI"
  | "HDFC"
  | "INTERACTIVE_BROKERS"
  // MONEY-837: founder-only paid Kite Connect app (live data). Distinct broker
  // value so its token lives in its own BrokerConnection row, separate from the
  // free Personal app (ZERODHA). Hidden from the public picker; gated to founder.
  | "ZERODHA_CONNECT";

export type RefreshStrategy = "NONE" | "TOKEN_REFRESH" | "EXTENDED" | "MONTHLY";
export type ConnectionStatus =
  | "CONNECTED"
  | "DISCONNECTED"
  | "ERROR"
  | "EXPIRED"
  | "REFRESHING";

export interface BrokerConnection {
  id: string;
  userId: string;
  brokerName: string;
  brokerId?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  apiKey?: string | null;
  apiSecret?: string | null;
  connected: boolean;
  lastSynced?: Date | null;
  accountInfo?: BrokerAccountInfo | null;
  permissions: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface BrokerAccountInfo {
  accountId?: string;
  name?: string;
  email?: string;
  [key: string]: unknown;
}

// ============== Credentials ==============

export interface BrokerCredentials {
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  extendedToken?: string;
  clientId?: string;
  clientCode?: string;
  sessionToken?: string;
  appId?: string;
  pin?: string;
  totp?: string;
  userId?: string;
  tokenExpiry?: Date;
}

// ============== Auth ==============

export interface AuthResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  extendedToken?: string;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
  error?: string;
  errorCode?: string;
  // MONEY-1062: some broker auth flows signal the user must re-authenticate
  // (e.g. expired/invalid refresh token). Optional so existing producers are
  // unaffected. Carried over from the removed apps/web base-adapter AuthResult
  // so core's live adapters can set it.
  requiresReauth?: boolean;
}

// ============== Broker Info ==============

export interface BrokerInfo {
  id: BrokerType;
  name: string;
  description: string;
  color: string;
  logo?: string;
  segments: string[];
  features: string[];
  cost: string;
  tokenExpiry: string;
  autoRefresh: boolean;
  mfSupport: boolean;
  docsUrl?: string;
}

export interface BrokerConfig {
  id: BrokerType;
  name: string;
  displayName: string;
  logo: string;
  authType: "oauth2" | "api_key" | "totp";
  baseUrl: string;
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string[];
  tokenRefreshStrategy: "none" | "daily" | "on_expiry" | "extended";
  tokenValidity: string;
  features: {
    holdings: boolean;
    positions: boolean;
    orders: boolean;
    trades: boolean;
    mutualFunds: boolean;
    margins: boolean;
  };
  envKeys: {
    apiKey: string;
    apiSecret: string;
    redirectUri?: string;
  };
}

// ============== Raw Data from Brokers ==============

export interface HoldingData {
  symbol: string;
  tradingSymbol: string;
  isin?: string;
  exchange: string;
  totalQuantity: number;
  freeQuantity: number;
  t1Quantity?: number;
  pledgedQuantity?: number;
  collateralQty?: number;
  averagePrice: number;
  lastPrice: number;
  closePrice?: number;
  pnl: number;
  pnlPercentage: number;
  product: string;
  dayChange?: number;
  dayChangePerc?: number;
}

export interface PositionData {
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  positionType: "DAY" | "NET";
  productType: string;
  buyQuantity: number;
  sellQuantity: number;
  netQuantity: number;
  buyPrice: number;
  sellPrice: number;
  averagePrice: number;
  lastPrice: number;
  realizedPnl: number;
  unrealizedPnl: number;
  expiryDate?: Date;
  strikePrice?: number;
  optionType?: string;
  lotSize?: number;
  multiplier?: number;
}

export interface OrderData {
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  orderType: string;
  transactionType: "BUY" | "SELL";
  productType: string;
  variety: string;
  quantity: number;
  filledQuantity: number;
  price: number;
  triggerPrice?: number;
  averagePrice: number;
  status: string;
  statusMessage?: string;
  validity: string;
  orderTime: Date;
  updateTime?: Date;
  exchangeTime?: Date;
  tag?: string;
}

export interface TradeData {
  tradeId: string;
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  transactionType: "BUY" | "SELL";
  productType: string;
  quantity: number;
  price: number;
  tradeValue: number;
  brokerage: number;
  exchangeFee: number;
  gst: number;
  sebiCharges: number;
  stampDuty: number;
  transactionTax: number;
  totalCharges: number;
  netAmount: number;
  tradeTime: Date;
  settlementDate?: Date;
}

export interface MutualFundData {
  fundName: string;
  schemeName: string;
  isin: string;
  folio?: string;
  units: number;
  averageNav: number;
  currentNav: number;
  lastNavDate?: Date;
  investedValue: number;
  currentValue: number;
  pnl: number;
  pnlPercentage: number;
  isSIP: boolean;
  sipAmount?: number;
  sipFrequency?: string;
  sipDay?: number;
  nextSIPDate?: Date;
  // MONEY-1062: optional fund metadata mirrored from NormalizedMutualFund so
  // core's live adapters can carry AMC / category through the raw DTO. Optional
  // — no existing reader depends on them. Carried over from the removed apps/web
  // base-adapter MutualFundData.
  category?: string;
  amcName?: string;
}

// ============== Normalized Data ==============

// MTF (Margin Trading Facility) data
export interface MTFData {
  quantity: number;
  usedQuantity: number;
  averagePrice: number;
  value: number;
  initialMargin: number;
}

export interface NormalizedHolding {
  symbol: string;
  tradingSymbol: string;
  name?: string;
  isin?: string;
  exchange: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  closePrice?: number;
  investedValue: number;
  currentValue: number;
  pnl: number;
  pnlPercentage: number;
  dayChange: number;
  dayChangePercentage: number;
  t1Quantity?: number;
  pledgedQuantity?: number;
  collateralQuantity?: number;
  sector?: string;
  instrumentToken?: number; // Broker's instrument token for WebSocket
  mtf?: MTFData | null; // Margin Trading Facility data
}

export interface NormalizedPosition {
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string; // Raw segment code (CASH, FO, etc.)
  productType: string; // Raw product code (CNC, MIS, NRML)
  positionType: "DAY" | "NET";

  // User-friendly labels
  segmentLabel?: string; // "Equity", "Futures & Options"
  productTypeLabel?: string; // "Cash & Carry", "Intraday"
  positionTypeLabel?: string; // "Intraday", "Carry Forward"

  // Quantities
  quantity: number;
  buyQuantity: number;
  sellQuantity: number;
  overnightQuantity?: number; // Overnight positions carried forward

  // Prices
  buyPrice: number;
  sellPrice: number;
  averagePrice: number;
  lastPrice: number;
  closePrice?: number; // Previous day close

  // Day-specific values
  dayBuyQuantity?: number;
  dayBuyPrice?: number;
  dayBuyValue?: number;
  daySellQuantity?: number;
  daySellPrice?: number;
  daySellValue?: number;

  // Values
  buyValue?: number;
  sellValue?: number;
  value?: number;

  // P&L
  pnl: number;
  pnlPercentage: number;
  m2m?: number; // Mark to market
  realizedPnl?: number;
  unrealizedPnl?: number;

  // Instrument details
  instrumentToken?: number;
  multiplier?: number;
}

export interface NormalizedTrade {
  tradeId: string;
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  isin?: string; // ISIN for proper pairing across symbol name changes (e.g., MF fund name changes)
  exchange: string;
  segment: string;
  transactionType: "BUY" | "SELL";
  quantity: number;
  price: number;
  value: number;
  tradeTime: Date;
  productType: string;
  orderType: string;
}

export interface NormalizedOrder {
  orderId: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  transactionType: "BUY" | "SELL";
  orderType: "MARKET" | "LIMIT" | "SL" | "SL-M";
  productType: string;
  quantity: number;
  price: number;
  triggerPrice?: number;
  filledQuantity: number;
  pendingQuantity: number;
  status: "PENDING" | "OPEN" | "COMPLETE" | "CANCELLED" | "REJECTED";
  statusMessage?: string;
  orderTime: Date;
  updateTime?: Date;
}

export interface NormalizedMutualFund {
  schemeName: string;
  schemeCode: string;
  tradingSymbol?: string; // Broker's trading symbol (e.g., INF277K01QO1 for Zerodha)
  isin: string;
  folioNumber: string;
  folio?: string; // Alias for folioNumber
  units: number;
  averageNav: number;
  currentNav: number;
  investedValue: number;
  currentValue: number;
  pnl: number;
  pnlPercentage: number;
  xirr?: number;
  category?: string;
  amcName?: string;
  pledgedQuantity?: number; // Pledged MF units
  lasQuantity?: number; // Loan Against Securities quantity
}

export interface NormalizedMargins {
  availableCash: number;
  usedMargin: number;
  totalMargin: number;
  collateral: number;
}

export interface BrokerProfile {
  userId: string;
  userName: string;
  email?: string;
  phone?: string;
  broker: string;
  exchanges: string[];
  products: string[];
}
