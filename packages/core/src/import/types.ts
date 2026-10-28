/**
 * Shared types for trade import parsing.
 * Used by web app, background worker, and import-processor job.
 */

export type BrokerFormat =
  | "zerodha"
  | "upstox"
  | "groww"
  | "angel"
  | "angelone"
  | "dhan"
  | "fyers"
  | "generic";

/**
 * Column mapping for a broker CSV format.
 * Each field maps to an array of possible column names (case-insensitive matching).
 */
export interface ColumnMapping {
  symbol: string[];
  isin?: string[];
  tradeDate: string[];
  exchange: string[];
  segment?: string[];
  tradeType: string[];
  quantity: string[];
  price: string[];
  orderId?: string[];
  tradeId?: string[];
  orderExecutionTime?: string[];
  productType?: string[];
  orderType?: string[];
  series?: string[];
  auction?: string[];
  expiryDate?: string[];
}

/**
 * A parsed trade row with all fields extracted and normalized.
 */
export interface TradeRow {
  symbol: string;
  isin?: string;
  tradeDate: Date;
  tradeTime?: Date;
  exchange: string;
  segment: string;
  series?: string;
  tradeType: "BUY" | "SELL";
  quantity: number;
  price: number;
  tradeId?: string;
  orderId?: string;
  productType?: string;
  orderType?: string;
  auction?: boolean;
  expiryDate?: Date;
}

/**
 * Result of parsing a single CSV/XLSX row.
 */
export interface ParsedTradeRow {
  data: TradeRow;
  rowNumber: number;
  error?: string;
}

/**
 * Result of parsing an entire CSV or XLSX file.
 */
export interface ParsedFileData {
  rows: Record<string, unknown>[];
  columns: string[];
  errors: string[];
}
