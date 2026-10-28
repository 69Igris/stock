/**
 * Market-data types for the Connect service.
 *
 * Copied from the web app's market layer (yahoo-client-logic `QuoteData` +
 * yahoo-client `HistoricalBar`) so the relocated Zerodha client stays decoupled
 * from apps/web. Keep these shapes in sync if the web QuoteData changes.
 */

export interface QuoteData {
  symbol: string;
  exchange: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  timestamp: Date;
  marketCap?: number;
  pe?: number;
  eps?: number;
  week52High?: number;
  week52Low?: number;
}

export interface HistoricalBar {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  adjClose?: number;
}
