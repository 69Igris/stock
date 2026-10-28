/**
 * Stock Sector — pure, side-effect-free helpers.
 *
 * Extracted from `getOrEnrichSectorAction`
 * (apps/web/lib/actions/stock-sector.ts) so the Yahoo-symbol construction can
 * be unit-tested without the `"use server"` runtime (Prisma + cache + Yahoo).
 *
 * The action imports `buildYahooSymbol` and calls it directly — no
 * dead/duplicate copy.
 */

/**
 * Build a Yahoo Finance symbol from an instrument symbol + exchange.
 *
 * BSE-listed instruments use the `.BO` suffix; everything else (NSE and any
 * unrecognized exchange) defaults to `.NS`. Exchange matching is
 * case-insensitive.
 */
export function buildYahooSymbol(symbol: string, exchange: string): string {
  const suffix = exchange.toUpperCase() === "BSE" ? ".BO" : ".NS";
  return `${symbol}${suffix}`;
}
