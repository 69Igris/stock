/**
 * /compare URL schema parser
 *
 * Canonical query: `?items=TYPE:ID,TYPE:ID,...`
 *   MF:119551
 *   ETF:NIFTYBEES
 *   INDEX:NIFTY 50
 *
 * Legacy alias `?funds=` is still accepted for back-compat with the original
 * MONEY-243 emit-sites and any externally-shared URLs. Both parameters
 * produce the same shape.
 *
 * MONEY-553: STOCK is now a first-class compare item, including CROSS-ASSET
 * sets (e.g. `STOCK:RELIANCE,MF:119551`). Stocks line up on the common axes
 * (last price, sector, the base-100 price overlay) plus stock-only P/E +
 * market-cap rows. A full AI stock deep-dive still lives on /analysis.
 */

export type CompareItemType = "MF" | "ETF" | "INDEX" | "STOCK";

export interface CompareItem {
  fundType: CompareItemType;
  fundId: string;
}

/** Hard cap on the number of items in a single comparison run. */
export const MAX_COMPARE_ITEMS = 5;

const VALID_TYPES = new Set<CompareItemType>(["MF", "ETF", "INDEX", "STOCK"]);

function parseEntry(raw: string): CompareItem | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const [typePart, ...rest] = trimmed.split(":");
  if (!typePart || rest.length === 0) return null;
  const upperType = typePart.trim().toUpperCase() as CompareItemType;
  if (!VALID_TYPES.has(upperType)) return null;

  // Re-join everything after the type token so IDs that themselves contain
  // colons (e.g. "INDEX:NIFTY 50") survive intact.
  const id = rest.join(":").trim();
  if (!id) return null;
  return { fundType: upperType, fundId: id };
}

export interface ParsedCompareQuery {
  items: CompareItem[];
  /** True when at least one item parsed but caller asked for fewer than 2. */
  needsPicker: boolean;
}

export function parseCompareQuery(
  rawItems: string | undefined,
  rawFunds: string | undefined
): ParsedCompareQuery {
  const source = rawItems ?? rawFunds ?? "";
  if (!source) return { items: [], needsPicker: false };

  const items = source
    .split(",")
    .map(parseEntry)
    .filter((entry): entry is CompareItem => entry !== null);

  if (items.length === 0) return { items: [], needsPicker: false };

  return {
    items: items.slice(0, MAX_COMPARE_ITEMS),
    needsPicker: items.length === 1,
  };
}

/**
 * Build the canonical compare URL from a list of items.
 * Used by /discover, /mf detail "Compare", and the picker.
 */
export function buildCompareUrl(items: CompareItem[]): string {
  const encoded = items.map((it) => `${it.fundType}:${it.fundId}`).join(",");
  return `/compare?items=${encodeURIComponent(encoded)}`;
}
