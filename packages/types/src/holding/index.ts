export interface Holding {
  id: string;
  userId: string;
  brokerId?: string | null;
  brokerName?: string | null;
  symbol: string;
  name?: string | null;
  sector?: string | null;
  exchange: string;
  isin?: string | null;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  investedValue: number;
  currentValue: number;
  unrealizedPnL: number;
  pnlPercentage: number;
  holdingType: string;
  lastUpdated: Date;
  createdAt: Date;
  updatedAt: Date;
}
