/**
 * NSE India API Response Types
 */

export interface NsePeerComparisonResponse {
  data?: Array<{
    symbol: string;
    companyName: string;
    "P/E"?: number;
    "P/B"?: number;
    marketCap?: number;
    sectorPe?: number;
  }>;
}

export interface NseCorporateActionResponse {
  data?: Array<{
    symbol: string;
    company: string;
    exDate: string;
    purpose: string;
    details?: string;
  }>;
}

export interface NseQuoteResponse {
  info?: {
    symbol: string;
    companyName: string;
    industry: string;
    isin: string;
  };
  priceInfo?: {
    lastPrice: number;
    change: number;
    pChange: number;
    open: number;
    close: number;
    previousClose: number;
    intraDayHighLow?: { min: number; max: number };
    weekHighLow?: { min: number; max: number };
  };
}
