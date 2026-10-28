export interface MutualFund {
  id: string;
  userId: string;
  brokerId?: string | null;
  brokerName?: string | null;
  schemeName: string;
  schemeCode?: string | null;
  amcName?: string | null;
  folioNumber?: string | null;
  category?: string | null;
  units: number;
  averageNav: number;
  currentNav: number;
  investedAmount: number;
  currentValue: number;
  unrealizedGain: number;
  xirr: number;
  sipActive: boolean;
  sipAmount?: number | null;
  sipDate?: number | null;
  sipFrequency?: string | null;
  lastUpdated: Date;
  createdAt: Date;
  updatedAt: Date;
}
