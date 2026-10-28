/**
 * Per-row parsing logic for trade CSV/XLSX data.
 * Handles column matching, validation, ISIN detection, and normalization.
 */

import type { ColumnMapping, ParsedTradeRow, TradeRow } from "./types";
import {
  normalizeExchange,
  normalizeSegment,
  normalizeTradeType,
  parseNumber,
  splitExchangePrefixedSymbol,
} from "./normalizers";
import { parseDate, parseDateTime } from "./date-parsers";

/**
 * Find a column value in a row using an array of possible column names.
 * Performs case-insensitive matching.
 */
function findColumn(
  row: Record<string, unknown>,
  possibleNames: string[] | undefined,
): string | undefined {
  if (!possibleNames) return undefined;

  for (const name of possibleNames) {
    if (row[name] !== undefined && row[name] !== "") {
      return String(row[name]);
    }
    const lowerName = name.toLowerCase();
    for (const key of Object.keys(row)) {
      if (
        key.toLowerCase() === lowerName &&
        row[key] !== undefined &&
        row[key] !== ""
      ) {
        return String(row[key]);
      }
    }
  }
  return undefined;
}

/**
 * Detect if a string looks like an Indian ISIN.
 * Indian ISINs: 12 chars, start with "IN", alphanumeric.
 * MF ISINs typically start with "INF".
 */
function looksLikeIsin(str: string): boolean {
  if (!str) return false;
  const upper = str.toUpperCase();
  return (
    upper.length === 12 &&
    upper.startsWith("IN") &&
    /^[A-Z0-9]{12}$/.test(upper)
  );
}

/**
 * Parse a single CSV/XLSX row into a normalized TradeRow.
 * Returns an error string if required fields are missing or invalid.
 */
export function parseCSVRow(
  row: Record<string, unknown>,
  columnMap: ColumnMapping,
  rowNumber: number,
): ParsedTradeRow {
  try {
    const symbolValue = findColumn(row, columnMap.symbol);
    const dateValue = findColumn(row, columnMap.tradeDate);
    const tradeTypeValue = findColumn(row, columnMap.tradeType);
    const quantityValue = findColumn(row, columnMap.quantity);
    const priceValue = findColumn(row, columnMap.price);

    // Validate required fields
    if (!symbolValue) {
      return { data: {} as TradeRow, rowNumber, error: "Missing symbol" };
    }
    if (!dateValue) {
      return { data: {} as TradeRow, rowNumber, error: "Missing trade date" };
    }
    if (!tradeTypeValue) {
      return { data: {} as TradeRow, rowNumber, error: "Missing trade type" };
    }
    if (!quantityValue) {
      return { data: {} as TradeRow, rowNumber, error: "Missing quantity" };
    }
    if (!priceValue) {
      return { data: {} as TradeRow, rowNumber, error: "Missing price" };
    }

    const parsedDate = parseDate(dateValue);
    if (!parsedDate) {
      return {
        data: {} as TradeRow,
        rowNumber,
        error: `Invalid date format: ${dateValue}`,
      };
    }

    const quantity = parseNumber(quantityValue);
    if (quantity <= 0) {
      return {
        data: {} as TradeRow,
        rowNumber,
        error: `Invalid quantity: ${quantityValue}`,
      };
    }

    const price = parseNumber(priceValue);
    if (price < 0) {
      return {
        data: {} as TradeRow,
        rowNumber,
        error: `Invalid price: ${priceValue}`,
      };
    }

    // Split an exchange-prefixed symbol (Fyers "NSE:SBIN-EQ") so the bare
    // symbol matches other brokers' rows and, when no Exchange column exists,
    // the prefix supplies the exchange. Bare symbols pass through untouched.
    const { symbol: strippedSymbol, exchange: symbolExchange } =
      splitExchangePrefixedSymbol(symbolValue);

    // Optional fields
    const exchangeValue =
      findColumn(row, columnMap.exchange) || symbolExchange || "NSE";
    const segmentValue = findColumn(row, columnMap.segment) || "";
    const exchange = normalizeExchange(exchangeValue);
    const segment = normalizeSegment(segmentValue, exchange);

    const seriesValue = findColumn(row, columnMap.series) || undefined;
    const auctionValue = findColumn(row, columnMap.auction);
    const orderTimeValue = findColumn(row, columnMap.orderExecutionTime);
    const expiryDateValue = findColumn(row, columnMap.expiryDate);

    // Parse order execution time
    const tradeTime = orderTimeValue
      ? parseDateTime(orderTimeValue) || undefined
      : undefined;

    // Parse expiry date for F&O
    const expiryDate = expiryDateValue
      ? parseDate(expiryDateValue) || undefined
      : undefined;

    // Determine product type based on segment
    let productType = findColumn(row, columnMap.productType);
    if (!productType) {
      if (segment === "FO") {
        productType = "NRML";
      } else if (segment === "MF") {
        productType = "CNC";
      } else {
        productType = "CNC";
      }
    }

    // Extract ISIN - for MF trades, the symbol might actually be the ISIN
    let isinValue = findColumn(row, columnMap.isin) || undefined;
    let finalSymbol = strippedSymbol.toUpperCase().trim();

    // For MF segment: if no ISIN found but symbol looks like ISIN, use symbol as ISIN
    if (segment === "MF") {
      if (!isinValue && looksLikeIsin(finalSymbol)) {
        isinValue = finalSymbol;
      }
    }

    // Check if ISIN might be in the symbol field for any segment
    if (!isinValue && looksLikeIsin(finalSymbol)) {
      isinValue = finalSymbol;
    }

    const orderId = findColumn(row, columnMap.orderId) || undefined;
    const tradeId = findColumn(row, columnMap.tradeId) || undefined;
    const orderType = findColumn(row, columnMap.orderType) || "MARKET";

    return {
      data: {
        symbol: finalSymbol,
        isin: isinValue,
        tradeDate: parsedDate,
        tradeTime,
        exchange,
        segment,
        series: seriesValue,
        tradeType: normalizeTradeType(tradeTypeValue),
        quantity,
        price,
        tradeId,
        orderId,
        productType,
        orderType,
        auction: auctionValue?.toLowerCase() === "true",
        expiryDate,
      },
      rowNumber,
    };
  } catch (error) {
    return {
      data: {} as TradeRow,
      rowNumber,
      error: `Parse error: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}
