/**
 * NSE index constituents - single source of truth for the screener
 * "Index" filter (UniverseSection) + the index-constituent-sync worker.
 *
 * Three resolution strategies, picked per index id:
 *
 *   STATIC     - hardcoded symbol list. Used for sectoral / thematic
 *                indices with small, slow-changing constituent sets
 *                (Bank Nifty, Nifty IT, Nifty Auto, etc.). Edits to the
 *                lists here ship in code review.
 *
 *   MCAP_RANK  - derive constituents at query time from
 *                `StockRatios.marketCap` ordered desc. Cheap (one
 *                indexed read) and dodges the staleness risk of
 *                hardcoding broad-market indices like Nifty 100/500
 *                whose membership churns every quarter.
 *
 *   SECTOR     - match `InstrumentMapping.sector` against the
 *                canonical NSE sector taxonomy
 *                (`NSE_SECTORS` in @usemoney/core). Best for sectoral
 *                indices where every listed company in the sector is
 *                an implicit member.
 *
 * The DB-backed `IndexConstituent` table (populated weekly by
 * `index-constituent-sync` worker) supersedes all three when present.
 */

/* ──────────────────────────────────────────────────────────────────
   STATIC constituents - small, hand-curated lists.
   ────────────────────────────────────────────────────────────────── */

const NIFTY_50: readonly string[] = [
  "RELIANCE",
  "HDFCBANK",
  "ICICIBANK",
  "INFY",
  "TCS",
  "BHARTIARTL",
  "ITC",
  "SBIN",
  "LT",
  "HINDUNILVR",
  "AXISBANK",
  "BAJFINANCE",
  "KOTAKBANK",
  "MARUTI",
  "M&M",
  "ASIANPAINT",
  "TITAN",
  "SUNPHARMA",
  "HCLTECH",
  "ULTRACEMCO",
  "TATAMOTORS",
  "WIPRO",
  "ONGC",
  "POWERGRID",
  "NTPC",
  "TATASTEEL",
  "ADANIPORTS",
  "ADANIENT",
  "JSWSTEEL",
  "COALINDIA",
  "GRASIM",
  "HINDALCO",
  "BAJAJFINSV",
  "TECHM",
  "DRREDDY",
  "CIPLA",
  "INDUSINDBK",
  "BPCL",
  "EICHERMOT",
  "NESTLEIND",
  "HEROMOTOCO",
  "BRITANNIA",
  "DIVISLAB",
  "APOLLOHOSP",
  "SHREECEM",
  "BAJAJ-AUTO",
  "TATACONSUM",
  "SBILIFE",
  "HDFCLIFE",
  "LTIM",
];

const BANK_NIFTY: readonly string[] = [
  "HDFCBANK",
  "ICICIBANK",
  "AXISBANK",
  "SBIN",
  "KOTAKBANK",
  "INDUSINDBK",
  "BANKBARODA",
  "PNB",
  "BANDHANBNK",
  "FEDERALBNK",
  "AUBANK",
  "IDFCFIRSTB",
];

const NIFTY_PSU_BANK: readonly string[] = [
  "SBIN",
  "BANKBARODA",
  "PNB",
  "CANBK",
  "UNIONBANK",
  "INDIANB",
  "BANKINDIA",
  "IOB",
  "CENTRALBK",
  "MAHABANK",
  "PSB",
  "UCOBANK",
];

const NIFTY_PRIVATE_BANK: readonly string[] = [
  "HDFCBANK",
  "ICICIBANK",
  "AXISBANK",
  "KOTAKBANK",
  "INDUSINDBK",
  "BANDHANBNK",
  "FEDERALBNK",
  "AUBANK",
  "IDFCFIRSTB",
  "RBLBANK",
];

const NIFTY_AUTO: readonly string[] = [
  "M&M",
  "MARUTI",
  "TATAMOTORS",
  "BAJAJ-AUTO",
  "EICHERMOT",
  "HEROMOTOCO",
  "TVSMOTOR",
  "BOSCHLTD",
  "MOTHERSON",
  "MRF",
  "ASHOKLEY",
  "BALKRISIND",
  "BHARATFORG",
  "EXIDEIND",
  "TIINDIA",
];

const NIFTY_REALTY: readonly string[] = [
  "DLF",
  "GODREJPROP",
  "OBEROIRLTY",
  "PRESTIGE",
  "PHOENIXLTD",
  "BRIGADE",
  "MAHLIFE",
  "SOBHA",
  "LODHA",
  "SUNTECK",
];

const NIFTY_CONSUMPTION: readonly string[] = [
  "HINDUNILVR",
  "ITC",
  "NESTLEIND",
  "BRITANNIA",
  "TATACONSUM",
  "TITAN",
  "ASIANPAINT",
  "BERGEPAINT",
  "DABUR",
  "MARICO",
  "GODREJCP",
  "COLPAL",
  "VBL",
  "UBL",
  "MCDOWELL-N",
];

const NIFTY_INFRA: readonly string[] = [
  "RELIANCE",
  "BHARTIARTL",
  "LT",
  "POWERGRID",
  "NTPC",
  "ADANIPORTS",
  "ULTRACEMCO",
  "GRASIM",
  "ONGC",
  "BPCL",
  "GAIL",
  "IOC",
  "ADANIPOWER",
  "TATAPOWER",
  "JSWENERGY",
  "ADANIGREEN",
  "PFC",
  "RECLTD",
  "INDIGO",
];

const NIFTY_IT: readonly string[] = [
  "TCS",
  "INFY",
  "WIPRO",
  "HCLTECH",
  "TECHM",
  "LTIM",
  "MPHASIS",
  "PERSISTENT",
  "COFORGE",
  "LTTS",
];

const NIFTY_PHARMA: readonly string[] = [
  "SUNPHARMA",
  "DRREDDY",
  "CIPLA",
  "DIVISLAB",
  "TORNTPHARM",
  "AUROPHARMA",
  "LUPIN",
  "ZYDUSLIFE",
  "ALKEM",
  "BIOCON",
  "GLENMARK",
  "ABBOTINDIA",
  "GLAND",
  "IPCALAB",
  "LAURUSLABS",
];

const NIFTY_FMCG: readonly string[] = [
  "HINDUNILVR",
  "ITC",
  "NESTLEIND",
  "BRITANNIA",
  "TATACONSUM",
  "DABUR",
  "MARICO",
  "GODREJCP",
  "COLPAL",
  "VBL",
  "UBL",
  "MCDOWELL-N",
  "EMAMILTD",
  "JYOTHYLAB",
];

const NIFTY_METAL: readonly string[] = [
  "TATASTEEL",
  "JSWSTEEL",
  "HINDALCO",
  "VEDL",
  "JINDALSTEL",
  "SAIL",
  "NMDC",
  "COALINDIA",
  "HINDZINC",
  "NATIONALUM",
  "APLAPOLLO",
  "JINDALSAW",
  "WELCORP",
  "MOIL",
  "RATNAMANI",
];

const NIFTY_ENERGY: readonly string[] = [
  "RELIANCE",
  "ONGC",
  "POWERGRID",
  "NTPC",
  "BPCL",
  "IOC",
  "GAIL",
  "ADANIPOWER",
  "TATAPOWER",
  "ADANIGREEN",
  "JSWENERGY",
  "HINDPETRO",
  "OIL",
  "GUJGASLTD",
  "PETRONET",
];

const NIFTY_MEDIA: readonly string[] = [
  "ZEEL",
  "SUNTV",
  "PVRINOX",
  "NAZARA",
  "DISHTV",
  "TV18BRDCST",
  "NETWORK18",
  "SAREGAMA",
  "TIPSINDLTD",
];

const NIFTY_OIL_AND_GAS: readonly string[] = [
  "RELIANCE",
  "ONGC",
  "BPCL",
  "IOC",
  "GAIL",
  "HINDPETRO",
  "OIL",
  "PETRONET",
  "MGL",
  "GUJGASLTD",
  "AEGISLOG",
  "CASTROLIND",
  "GSPL",
];

const NIFTY_FIN_SERVICES: readonly string[] = [
  "HDFCBANK",
  "ICICIBANK",
  "AXISBANK",
  "SBIN",
  "KOTAKBANK",
  "BAJFINANCE",
  "BAJAJFINSV",
  "INDUSINDBK",
  "SBILIFE",
  "HDFCLIFE",
  "ICICIPRULI",
  "ICICIGI",
  "CHOLAFIN",
  "MUTHOOTFIN",
  "RECLTD",
  "PFC",
  "SHRIRAMFIN",
  "HDFCAMC",
];

const NIFTY_HEALTHCARE: readonly string[] = [
  "SUNPHARMA",
  "DRREDDY",
  "CIPLA",
  "DIVISLAB",
  "APOLLOHOSP",
  "MAXHEALTH",
  "TORNTPHARM",
  "AUROPHARMA",
  "LUPIN",
  "ZYDUSLIFE",
  "ALKEM",
  "BIOCON",
  "GLENMARK",
  "FORTIS",
  "METROPOLIS",
];

const NIFTY_COMMODITIES: readonly string[] = [
  "RELIANCE",
  "TATASTEEL",
  "JSWSTEEL",
  "HINDALCO",
  "ULTRACEMCO",
  "GRASIM",
  "VEDL",
  "COALINDIA",
  "ONGC",
  "NMDC",
  "ASIANPAINT",
  "BERGEPAINT",
  "PIDILITIND",
  "AMBUJACEM",
  "ACC",
  "SHREECEM",
];

const NIFTY_PSE: readonly string[] = [
  "ONGC",
  "POWERGRID",
  "NTPC",
  "COALINDIA",
  "BPCL",
  "IOC",
  "GAIL",
  "SBIN",
  "BANKBARODA",
  "PNB",
  "PFC",
  "RECLTD",
  "NMDC",
  "SAIL",
  "HINDPETRO",
  "OIL",
  "BHEL",
  "BEL",
  "HAL",
  "CONCOR",
];

const NIFTY_CPSE: readonly string[] = [
  "POWERGRID",
  "NTPC",
  "COALINDIA",
  "ONGC",
  "BPCL",
  "GAIL",
  "PFC",
  "RECLTD",
  "NMDC",
  "OIL",
  "BHEL",
  "NLCINDIA",
];

const NIFTY_MNC: readonly string[] = [
  "HINDUNILVR",
  "NESTLEIND",
  "BOSCHLTD",
  "AMBUJACEM",
  "BRITANNIA",
  "COLPAL",
  "ABBOTINDIA",
  "MARUTI",
  "BAYERCROP",
  "PFIZER",
  "CASTROLIND",
  "PROCTER",
];

const NIFTY_DIVIDEND_OPP_50: readonly string[] = [
  "ONGC",
  "COALINDIA",
  "POWERGRID",
  "NTPC",
  "ITC",
  "BPCL",
  "IOC",
  "GAIL",
  "VEDL",
  "TCS",
  "INFY",
  "HINDUNILVR",
  "SBIN",
  "WIPRO",
  "HEROMOTOCO",
];

const STATIC_INDICES: Record<string, readonly string[]> = {
  nifty50: NIFTY_50,
  banknifty: BANK_NIFTY,
  niftypsubank: NIFTY_PSU_BANK,
  niftyprivatebank: NIFTY_PRIVATE_BANK,
  niftyauto: NIFTY_AUTO,
  niftyit: NIFTY_IT,
  niftypharma: NIFTY_PHARMA,
  niftyfmcg: NIFTY_FMCG,
  niftymetal: NIFTY_METAL,
  niftyenergy: NIFTY_ENERGY,
  niftymedia: NIFTY_MEDIA,
  niftyoilgas: NIFTY_OIL_AND_GAS,
  niftyfinservice: NIFTY_FIN_SERVICES,
  niftyhealthcare: NIFTY_HEALTHCARE,
  niftycommodities: NIFTY_COMMODITIES,
  niftyrealty: NIFTY_REALTY,
  niftyconsumption: NIFTY_CONSUMPTION,
  niftyinfra: NIFTY_INFRA,
  niftypse: NIFTY_PSE,
  niftycpse: NIFTY_CPSE,
  niftymnc: NIFTY_MNC,
  niftydivopp50: NIFTY_DIVIDEND_OPP_50,
};

/* ──────────────────────────────────────────────────────────────────
   SECTOR-based indices - match InstrumentMapping.sector against the
   canonical NSE sector taxonomy. Used as a backstop when the static
   list is incomplete; index-aware lookups still prefer the static
   list when one exists.
   ────────────────────────────────────────────────────────────────── */

const SECTOR_INDEX_MAP: Record<string, string> = {
  niftyit: "Information Technology",
  niftypharma: "Healthcare",
  niftyhealthcare: "Healthcare",
  niftyfmcg: "FMCG",
  niftymetal: "Commodities",
  niftyenergy: "Energy",
  niftyoilgas: "Energy",
  niftymedia: "Telecommunication",
  niftyfinservice: "Financial Services",
  // MONEY-1093 — Nifty Realty maps onto the Real Estate sector, which became
  // canonical on 2026-07-30. Before that there was no sector to point it at.
  niftyrealty: "Real Estate",
};

/* ──────────────────────────────────────────────────────────────────
   MCAP-RANK indices - derived at query time from market cap rank.
   ────────────────────────────────────────────────────────────────── */

export interface McapRankSpec {
  /** Slot number where the index begins (1-based, inclusive). */
  start: number;
  /** Slot number where the index ends (1-based, inclusive). */
  end: number;
}

const MCAP_RANK_SPECS: Record<string, McapRankSpec> = {
  niftynext50: { start: 51, end: 100 },
  nifty100: { start: 1, end: 100 },
  nifty200: { start: 1, end: 200 },
  nifty500: { start: 1, end: 500 },
  niftylargemid250: { start: 1, end: 250 },
  niftymidcap50: { start: 101, end: 150 },
  niftymidcap100: { start: 101, end: 200 },
  niftymidcap150: { start: 101, end: 250 },
  niftysmallcap50: { start: 251, end: 300 },
  niftysmallcap100: { start: 251, end: 350 },
  niftysmallcap250: { start: 251, end: 500 },
  niftymidsmall400: { start: 101, end: 500 },
  niftytotalmarket: { start: 1, end: 750 },
  niftymicrocap250: { start: 501, end: 750 },
};

/* ──────────────────────────────────────────────────────────────────
   Public API
   ────────────────────────────────────────────────────────────────── */

export type IndexFilterKind = "static" | "mcap-rank" | "sector" | "all";

export interface IndexFilterResolution {
  kind: IndexFilterKind;
  /** For `kind === "static"`: literal symbol list. */
  symbols?: readonly string[];
  /** For `kind === "mcap-rank"`: derive constituents from LatestQuote.marketCap. */
  rank?: McapRankSpec;
  /** For `kind === "sector"`: canonical NSE sector name to match. */
  sector?: string;
}

/**
 * Resolve an index id (from UniverseSection) into a constituent
 * resolution strategy. Returns kind="all" for "all" / undefined /
 * unknown ids - caller skips the filter.
 *
 * Static lists win over sector/mcap-rank derivations, so curated
 * constituent sets (e.g. Nifty IT's exact 10 stocks) override the
 * broader sector match (every IT-tagged stock).
 */
export function resolveIndexFilter(
  indexId: string | undefined | null
): IndexFilterResolution {
  if (!indexId || indexId === "all") return { kind: "all" };
  const stat = STATIC_INDICES[indexId];
  if (stat) return { kind: "static", symbols: stat };
  const sector = SECTOR_INDEX_MAP[indexId];
  if (sector) return { kind: "sector", sector };
  const rank = MCAP_RANK_SPECS[indexId];
  if (rank) return { kind: "mcap-rank", rank };
  return { kind: "all" };
}

/* ──────────────────────────────────────────────────────────────────
   Dropdown - single source of truth for the screener UI.
   Grouped headings render as disabled options that span the section.
   ────────────────────────────────────────────────────────────────── */

export interface IndexOption {
  value: string;
  label: string;
  /** Section heading. Renders as a disabled separator above the option. */
  group?: string;
}

export const INDEX_OPTIONS: ReadonlyArray<IndexOption> = [
  { value: "all", label: "All listed" },
  // Broad-market
  { value: "nifty50", label: "Nifty 50", group: "Broad market" },
  { value: "niftynext50", label: "Nifty Next 50" },
  { value: "nifty100", label: "Nifty 100" },
  { value: "nifty200", label: "Nifty 200" },
  { value: "nifty500", label: "Nifty 500" },
  { value: "niftylargemid250", label: "Nifty LargeMidcap 250" },
  { value: "niftytotalmarket", label: "Nifty Total Market" },
  // Mid- / small-cap
  {
    value: "niftymidcap50",
    label: "Nifty Midcap 50",
    group: "Mid / small cap",
  },
  { value: "niftymidcap100", label: "Nifty Midcap 100" },
  { value: "niftymidcap150", label: "Nifty Midcap 150" },
  { value: "niftysmallcap50", label: "Nifty Smallcap 50" },
  { value: "niftysmallcap100", label: "Nifty Smallcap 100" },
  { value: "niftysmallcap250", label: "Nifty Smallcap 250" },
  { value: "niftymidsmall400", label: "Nifty MidSmallcap 400" },
  { value: "niftymicrocap250", label: "Nifty Microcap 250" },
  // Banking
  { value: "banknifty", label: "Bank Nifty", group: "Banking & finance" },
  { value: "niftyprivatebank", label: "Nifty Private Bank" },
  { value: "niftypsubank", label: "Nifty PSU Bank" },
  { value: "niftyfinservice", label: "Nifty Financial Services" },
  // Sectoral
  { value: "niftyit", label: "Nifty IT", group: "Sectoral" },
  { value: "niftypharma", label: "Nifty Pharma" },
  { value: "niftyhealthcare", label: "Nifty Healthcare" },
  { value: "niftyfmcg", label: "Nifty FMCG" },
  { value: "niftyauto", label: "Nifty Auto" },
  { value: "niftymetal", label: "Nifty Metal" },
  { value: "niftyenergy", label: "Nifty Energy" },
  { value: "niftyoilgas", label: "Nifty Oil & Gas" },
  { value: "niftyrealty", label: "Nifty Realty" },
  { value: "niftymedia", label: "Nifty Media" },
  // Thematic
  { value: "niftycommodities", label: "Nifty Commodities", group: "Thematic" },
  { value: "niftyconsumption", label: "Nifty Consumption" },
  { value: "niftyinfra", label: "Nifty Infrastructure" },
  { value: "niftypse", label: "Nifty PSE" },
  { value: "niftycpse", label: "Nifty CPSE" },
  { value: "niftymnc", label: "Nifty MNC" },
  { value: "niftydivopp50", label: "Nifty Dividend Opportunities 50" },
];
