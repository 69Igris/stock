/**
 * Derivation helpers for ETF AMC (fund house) + category - extracted
 * from `apps/web/app/discover/client.tsx` so the screener filter can
 * apply the same parsing the Discover page uses (image #71/#72).
 *
 * ETFs in `InstrumentMapping` carry only `symbol` and `name`; AMC and
 * category aren't stored. These functions parse them out of the human-
 * readable name (e.g. "ICICI Prudential Nifty 50 ETF" → AMC "ICICI
 * Prudential", category "Large Cap").
 *
 * If `instrumentMapping.amcName` / `category` are added in a future
 * sync, callers can short-circuit through those fields and keep this
 * file as the fallback.
 */

const ETF_FUND_HOUSES = [
  "NIPPON INDIA",
  "SBI",
  "HDFC",
  "ICICI PRUDENTIAL",
  "KOTAK",
  "MOTILAL OSWAL",
  "EDELWEISS",
  "ADITYA BIRLA",
  "UTI",
  "AXIS",
  "MIRAE ASSET",
  "DSP",
  "TATA",
  "INVESCO",
  "BANDHAN",
  "PGIM",
  "QUANTUM",
  "LIC",
  "CPSE",
  "BHARAT",
  "GROWW",
] as const;

/** Display-ready fund-house list for the screener AMC dropdown. */
export const ETF_FUND_HOUSE_OPTIONS: ReadonlyArray<string> =
  ETF_FUND_HOUSES.map((h) =>
    h
      .split(" ")
      .filter(Boolean)
      .map((w) => (w[0] ?? "") + w.slice(1).toLowerCase())
      .join(" ")
  );

/** Canonical category bucket list emitted by `deriveEtfCategory`. */
export const ETF_CATEGORY_OPTIONS: ReadonlyArray<string> = [
  "Large Cap",
  "Mid Cap",
  "Small Cap",
  "Banking",
  "Technology",
  "Healthcare",
  "Infrastructure",
  "Consumption",
  "Energy",
  "Auto",
  "Metal",
  "Real Estate",
  "Commodity",
  "Liquid",
  "Debt",
  "International",
  "Other",
];

const titleCase = (s: string): string =>
  s
    .split(" ")
    .filter(Boolean)
    .map((w) => (w[0] ?? "") + w.slice(1).toLowerCase())
    .join(" ");

/** Best-effort fund-house extraction from an ETF instrument name. */
export function extractEtfFundHouse(name: string): string {
  const cleaned = name.replace(/^["']+|["']+$/g, "").trim();
  const upper = cleaned.toUpperCase();
  for (const h of ETF_FUND_HOUSES) {
    if (upper.startsWith(h)) return titleCase(h);
  }
  // Fallback: everything before the literal " ETF" in the name.
  const idx = upper.indexOf(" ETF");
  if (idx > 0) return titleCase(cleaned.substring(0, idx).trim());
  return "Other";
}

/** Best-effort category derivation from an ETF instrument name. */
export function deriveEtfCategory(name: string): string {
  const n = name.toUpperCase();
  if (n.includes("GOLD") || n.includes("SILVER")) return "Commodity";
  if (n.includes("LIQUID") || n.includes("OVERNIGHT")) return "Liquid";
  if (
    n.includes("GILT") ||
    n.includes("BOND") ||
    n.includes("DEBT") ||
    n.includes("SDL")
  )
    return "Debt";
  if (
    n.includes("NIFTY 50") ||
    n.includes("SENSEX") ||
    n.includes("NIFTY NEXT 50")
  )
    return "Large Cap";
  if (
    n.includes("MIDCAP") ||
    n.includes("MID CAP") ||
    n.includes("NIFTY MIDSMALL")
  )
    return "Mid Cap";
  if (n.includes("SMALLCAP") || n.includes("SMALL CAP")) return "Small Cap";
  if (
    n.includes("BANK") ||
    n.includes("FINANCIAL") ||
    n.includes("PRIVATE BANK") ||
    n.includes("PSU BANK")
  )
    return "Banking";
  if (n.includes(" IT ") || n.match(/\bIT\b/)) return "Technology";
  if (n.includes("PHARMA") || n.includes("HEALTHCARE")) return "Healthcare";
  if (n.includes("INFRA")) return "Infrastructure";
  if (n.includes("CONSUMPTION") || n.includes("FMCG")) return "Consumption";
  if (n.includes("ENERGY") || n.includes("OIL") || n.includes("GAS"))
    return "Energy";
  if (n.includes("AUTO")) return "Auto";
  if (n.includes("METAL")) return "Metal";
  if (n.includes("REALTY") || n.includes("REAL ESTATE")) return "Real Estate";
  if (n.includes("NASDAQ") || n.includes("HANG SENG") || n.includes("S&P 500"))
    return "International";
  return "Other";
}

/**
 * Derive the canonical asset class from an ETF instrument name. The
 * source-of-truth `MutualFundMaster.fundType` join is sparse for ETFs
 * (most ETFs aren't mirrored in MF master), so the screener post-fetch
 * filter falls back to this name-keyword heuristic when the joined
 * value is null. Mirrors the categories the existing UI dropdown
 * surfaces (`equity` / `debt` / `hybrid` / `solution` / `other`).
 */
export function deriveEtfAssetClass(name: string): string {
  const n = name.toUpperCase();
  if (
    n.includes("GILT") ||
    n.includes("BOND") ||
    n.includes(" DEBT") ||
    n.includes("SDL") ||
    n.includes("LIQUID") ||
    n.includes("OVERNIGHT") ||
    n.includes("PSU BOND")
  )
    return "debt";
  if (n.includes("HYBRID") || n.includes("BALANCED ADVANTAGE")) return "hybrid";
  if (n.includes("TARGET MATURITY") || n.includes("RETIREMENT"))
    return "solution";
  if (n.includes("GOLD") || n.includes("SILVER") || n.includes("COMMODITY"))
    return "other";
  // Everything else (Nifty / Sensex / Bank / IT / sector / cap based)
  // is an equity ETF in practice.
  return "equity";
}
