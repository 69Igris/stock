/**
 * Deterministic hash generation for trade duplicate detection.
 * Canonical 7-field algorithm: symbol|date|tradeType|qty|price|exchange|segment.
 */

import crypto from "crypto";

/**
 * Generate a content-based SHA-256 hash (first 16 hex chars) for duplicate detection.
 * Uses 7 normalized fields to produce a deterministic fingerprint.
 *
 * Fields: symbol (uppercase) | date (YYYY-MM-DD) | tradeType (uppercase) |
 *         quantity (string) | price (2 decimals) | exchange (uppercase, default NSE) |
 *         segment (uppercase, default EQUITY)
 */
export function generateDuplicateHash(trade: {
  symbol: string;
  tradeDate: Date;
  tradeType: string;
  quantity: number;
  price: number;
  exchange?: string;
  segment?: string;
}): string {
  // Guard an invalid Date: `.toISOString()` throws "Invalid time value" on a
  // NaN-time Date, which would crash the entire import/dedup batch on a single
  // malformed-date row. Fall back to a stable sentinel so the row still gets a
  // deterministic hash instead of taking the whole batch down.
  const dateKey = Number.isNaN(trade.tradeDate.getTime())
    ? "INVALID_DATE"
    : trade.tradeDate.toISOString().split("T")[0]; // YYYY-MM-DD

  const normalized = [
    trade.symbol.toUpperCase(),
    dateKey,
    trade.tradeType.toUpperCase(),
    trade.quantity.toString(),
    trade.price.toFixed(2),
    (trade.exchange || "NSE").toUpperCase(),
    (trade.segment || "EQUITY").toUpperCase(),
  ].join("|");

  return crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .substring(0, 16);
}
