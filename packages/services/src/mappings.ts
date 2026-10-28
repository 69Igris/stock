/**
 * Broker data label mappings (replicated from apps/web/lib/constants/broker-mappings.ts)
 * These are pure data maps with no framework dependencies, safe for shared use.
 */

const SEGMENT_MAP: Record<string, string> = {
  CASH: "Equity",
  FO: "F&O",
  CD: "Currency",
  COM: "Commodity",
  MF: "Mutual Funds",
  NSE: "Equity",
  BSE: "Equity",
  NFO: "F&O",
  BFO: "F&O",
  MCX: "Commodity",
  CDS: "Currency",
  CNC: "Equity",
  MIS: "Equity",
  NRML: "F&O",
  EQUITY: "Equity",
  // MONEY-846: keep SEGMENT_MAP consistent with getSegmentFilterValues' buckets —
  // manual trades store FUTURES/OPTIONS/COMMODITY/CURRENCY segment strings, so the
  // TYPE column (segmentLabel) must resolve them, not echo the raw code.
  FUTURES: "F&O",
  OPTIONS: "F&O",
  COMMODITY: "Commodity",
  NCDEX: "Commodity",
  CURRENCY: "Currency",
};

const PRODUCT_TYPE_MAP: Record<string, string> = {
  CNC: "Cash & Carry",
  MIS: "Intraday",
  NRML: "Normal F&O",
  BO: "Bracket Order",
  CO: "Cover Order",
};

export function getSegmentLabel(code: string): string {
  return SEGMENT_MAP[code] || code;
}

export function getProductTypeLabel(code: string): string {
  return PRODUCT_TYPE_MAP[code] || code;
}

/**
 * Map a segment filter value to all possible database values.
 *
 * Handles old data that might have different segment storage formats AND the
 * Tradebook UI dropdown values. The dropdown emits coarse UI keys ("equity",
 * "options"/"fo", "commodity", "currency") that are uppercased by the caller;
 * those alias to the canonical buckets below so e.g. F&O matches FO/NFO/BFO/NRML
 * (MONEY-847 — previously OPTIONS/COMMODITY keys matched almost nothing because
 * only CASH/FO/CD/COM keys existed). Lookup is case-insensitive.
 */
export function getSegmentFilterValues(segment: string): string[] {
  const segmentMappings: Record<string, string[]> = {
    CASH: ["CASH", "EQUITY", "NSE", "BSE", "CNC", "MIS"],
    FO: ["FO", "NFO", "BFO", "NRML", "FUTURES", "OPTIONS"],
    CD: ["CD", "CDS", "CURRENCY"],
    COM: ["COM", "MCX", "NCDEX", "COMMODITY"],
  };
  // Aliases for the coarse UI dropdown choices → canonical bucket key.
  const aliases: Record<string, string> = {
    EQUITY: "CASH",
    NSE: "CASH",
    BSE: "CASH",
    FO: "FO",
    FNO: "FO",
    FUTURES: "FO",
    OPTIONS: "FO",
    NFO: "FO",
    BFO: "FO",
    CURRENCY: "CD",
    CDS: "CD",
    COMMODITY: "COM",
    MCX: "COM",
  };
  const key = segment.toUpperCase();
  // Direct canonical hit, else alias → canonical; fall back to the raw value
  // (kept as a single-element list so an unknown segment still equality-matches
  // its stored value rather than matching nothing).
  const direct = segmentMappings[key];
  if (direct) return direct;
  const aliased = aliases[key];
  const resolved = aliased ? segmentMappings[aliased] : undefined;
  return resolved ?? [segment];
}
