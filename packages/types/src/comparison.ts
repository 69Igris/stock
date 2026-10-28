/**
 * Fund Comparison Types
 *
 * Unified row for the /compare side-by-side: MF, ETF, INDEX, and (MONEY-553)
 * STOCK — including cross-asset sets (e.g. a stock vs a fund). Stocks reuse this
 * shape: `nav` holds the last price, `category` the sector, and the optional
 * `peRatio`/`marketCap` carry the stock-only metrics (null/omitted for funds).
 * Returns are computed from price history on the common axes so heterogeneous
 * items still line up. (A full AI stock deep-dive still lives on /analysis.)
 */

export type ComparableAssetType = "MF" | "ETF" | "INDEX" | "STOCK";

export interface ComparableFund {
  id: string; // schemeCode (MF), symbol (ETF/INDEX/STOCK)
  fundType: ComparableAssetType;
  name: string;
  issuer: string; // AMC name (MF), name (ETF), or sector/exchange (STOCK)
  category: string; // MF/ETF category, or the STOCK's sector
  riskLevel: string | null;
  nav: number; // NAV (MF) or last price (ETF/INDEX/STOCK)
  navDate: Date | null;
  returns1Y: number | null;
  returns3Y: number | null;
  returns5Y: number | null;
  aum: number | null;
  expenseRatio: number | null;
  plan: string | null;
  fundManager: string | null;
  crisilRating: string | null;
  volatility: string | null;
  exchange: string | null;
  changePercent: number | null;
  /** STOCK-only: trailing P/E (null/omitted for funds). */
  peRatio?: number | null;
  /** STOCK-only: market capitalisation in the same unit as AUM (₹ cr). */
  marketCap?: number | null;
}
