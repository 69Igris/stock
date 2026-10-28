export interface PaperPosition {
  id: string;
  userId: string;
  portfolioId?: string;
  symbol: string;
  name?: string;
  assetType: string;
  segment: string;
  exchange: string;
  positionType: string;
  side: string;
  quantity: number;
  lotSize?: number;
  averagePrice: number;
  investedValue: number;
  currentPrice: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  dayPnl: number;
  strikePrice?: number;
  optionType?: string;
  expiryDate?: Date;
  schemeName?: string;
  units?: number;
  nav?: number;
  niftyAtEntry?: number;
  benchmarkPnL?: number;
  alpha?: number;
  stopLoss?: number;
  target?: number;
  strategy?: string;
  status: string;
  exitPrice?: number;
  exitDate?: Date;
  realizedPnL?: number;
  notes?: string;
  tags: string[];
  entryDate: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaperPortfolio {
  id: string;
  userId: string;
  initialCapital: number;
  cash: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaperOrder {
  id: string;
  portfolioId: string;
  userId: string;
  symbol: string;
  name: string;
  exchange: string;
  instrumentType: string;
  side: string;
  orderType: string;
  status: string;
  quantity: number;
  price?: number;
  triggerPrice?: number;
  executedPrice?: number;
  executedAt?: Date;
  stopLoss?: number;
  target?: number;
  strategy?: string;
  optionType?: string;
  strikePrice?: number;
  expiry?: Date;
  lotSize?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlaceOrderInput {
  symbol: string;
  name: string;
  exchange?: string;
  instrumentType?: string;
  side: "BUY" | "SELL";
  orderType?: "MARKET" | "LIMIT" | "SL" | "SL_M";
  quantity: number;
  price?: number;
  triggerPrice?: number;
  stopLoss?: number;
  target?: number;
  strategy?: string;
  optionType?: string;
  strikePrice?: number;
  expiry?: Date;
  lotSize?: number;
}

export interface PaperDashboardStats {
  portfolio: PaperPortfolio;
  positions: {
    open: number;
    closed: number;
    totalInvested: number;
    totalCurrentValue: number;
    totalPnl: number;
    totalPnlPercentage: number;
    dayPnl: number;
  };
  performance: {
    winRate: number;
    totalTrades: number;
    winners: number;
    losers: number;
    avgWin: number;
    avgLoss: number;
    bestTrade: number;
    worstTrade: number;
  };
}
