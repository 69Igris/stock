/**
 * Normalization functions for trade data fields.
 * Ensures consistent values regardless of broker-specific formats.
 */

/**
 * Normalize a CSV column header to a standardized key.
 * Strips whitespace, lowercases, replaces non-alphanumeric chars with underscores.
 */
export function normalizeColumnName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]/g, "_");
}

/**
 * Normalize trade type strings from various broker formats to BUY or SELL.
 * Covers equity tradebooks (BUY/SELL/B/S) AND mutual-fund order exports, whose
 * buy side is expressed as Purchase / Subscription / Allotment / SIP / Invest /
 * Switch-In. Anything not recognised as a buy defaults to SELL (Redeem /
 * Redemption / Switch-Out / Sold all fall through correctly).
 */
export function normalizeTradeType(type: string): "BUY" | "SELL" {
  const normalized = type.toUpperCase().trim();
  if (
    normalized === "B" ||
    normalized === "BUY" ||
    normalized === "BOUGHT" ||
    normalized === "PURCHASE" ||
    normalized === "PURCHASED" ||
    normalized === "1" ||
    normalized.startsWith("SUBSCRI") || // SUBSCRIBE / SUBSCRIPTION
    normalized.startsWith("ALLOT") || // ALLOTMENT / ALLOTTED
    normalized.startsWith("SIP") ||
    normalized.startsWith("INVEST") || // INVEST / INVESTMENT
    normalized.includes("SWITCH IN") ||
    normalized.includes("SWITCH-IN")
  ) {
    return "BUY";
  }
  return "SELL";
}

/**
 * Split an exchange-prefixed / series-suffixed trading symbol into a bare
 * symbol and (optionally) its exchange. Fyers exports the instrument as
 * "NSE:SBIN-EQ"; most other brokers export a bare "SBIN". Symbols without a
 * recognised "EXCH:" prefix pass through unchanged (so Zerodha F&O symbols like
 * "NIFTY2430622000CE" and plain "INFY" are untouched), and only a trailing NSE
 * cash-series marker ("-EQ"/"-BE"/"-BZ"/"-BL") is stripped — never a derivative
 * suffix. Returns `exchange` only when a prefix was actually present so callers
 * can prefer an explicit Exchange column and fall back to this.
 */
export function splitExchangePrefixedSymbol(raw: string): {
  symbol: string;
  exchange?: string;
} {
  let symbol = (raw ?? "").trim();
  let exchange: string | undefined;

  const prefixMatch = symbol.match(/^(NSE|BSE|NFO|BFO|MCX|CDS)\s*:\s*(.+)$/i);
  if (prefixMatch && prefixMatch[1] && prefixMatch[2]) {
    exchange = prefixMatch[1].toUpperCase();
    symbol = prefixMatch[2].trim();
  }

  // Strip only NSE cash-series markers; derivative symbols never carry them.
  symbol = symbol.replace(/-(EQ|BE|BZ|BL)$/i, "");

  return { symbol: symbol.trim(), exchange };
}

/**
 * Normalize exchange strings to canonical form (NSE, BSE, NFO, MCX, etc.).
 */
export function normalizeExchange(exchange: string): string {
  const normalized = exchange.toUpperCase().trim();
  if (normalized.includes("NSE")) return "NSE";
  if (normalized.includes("BSE")) return "BSE";
  if (normalized.includes("NFO")) return "NFO";
  if (normalized.includes("MCX")) return "MCX";
  if (normalized.includes("CDS")) return "CDS";
  if (normalized.includes("BFO")) return "BFO";
  return normalized || "NSE";
}

/**
 * Normalize segment strings with exchange fallback.
 */
export function normalizeSegment(segment: string, exchange: string): string {
  const normalized = segment?.toUpperCase().trim() || "";

  if (normalized.includes("EQ") || normalized === "CASH") return "EQUITY";
  if (
    normalized.includes("FO") ||
    normalized.includes("F&O") ||
    normalized.includes("DERIVATIVE")
  )
    return "FO";
  if (normalized.includes("MF") || normalized.includes("MUTUAL")) return "MF";
  if (normalized.includes("CD") || normalized.includes("CUR"))
    return "CURRENCY";
  if (normalized.includes("COM") || normalized.includes("MCX"))
    return "COMMODITY";

  // Derive from exchange if segment is unclear
  if (exchange === "NFO" || exchange === "BFO") return "FO";
  if (exchange === "MF") return "MF";
  if (exchange === "MCX") return "COMMODITY";
  if (exchange === "CDS") return "CURRENCY";

  return "EQUITY";
}

/**
 * Parse a numeric value, handling currency symbols, commas, and Indian Rupee sign.
 */
export function parseNumber(value: unknown): number {
  if (typeof value === "number") {
    // Guard non-finite numbers (NaN / ±Infinity) so they never leak into
    // downstream qty/price math, dedup hashing, or P&L. Mirrors the
    // "unparseable → 0" contract the string path already enforces.
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string") {
    const cleaned = value.replace(/[₹$,\s]/g, "");
    const num = parseFloat(cleaned);
    // parseFloat("Infinity") === Infinity (and isNaN(Infinity) === false),
    // so check finiteness rather than just NaN.
    return Number.isFinite(num) ? num : 0;
  }
  return 0;
}
