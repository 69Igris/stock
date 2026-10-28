export interface Trade {
  id: string;
  userId: string;
  brokerId?: string | null;
  brokerName?: string | null;
  symbol: string;
  exchange: string;
  segment: TradeSegment;
  tradeType: TradeType;
  positionType: PositionType;
  orderType: OrderType;
  productType: ProductType;
  quantity: number;
  price: number;
  exitPrice?: number | null;
  tradeValue?: number | null;
  brokerage: number;
  taxes: number;
  realizedPnL?: number | null;
  status: TradeStatus;
  tradeDate: Date;
  exitDate?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  tags: string[];
  notes?: string | null;
  aiInsight?: AIInsight | null;
  comments: TradeComment[];
}

export type TradeSegment =
  | "EQUITY"
  | "FUTURES"
  | "OPTIONS"
  | "COMMODITY"
  | "CURRENCY";
export type TradeType = "BUY" | "SELL";
export type PositionType = "LONG" | "SHORT";
export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL-M";
export type ProductType = "CNC" | "MIS" | "NRML";
export type TradeStatus = "OPEN" | "CLOSED";

export interface AIInsight {
  generated: boolean;
  content: string;
  sentiment: string;
  generatedAt?: Date;
}

export interface TradeComment {
  text: string;
  addedAt: Date;
}
