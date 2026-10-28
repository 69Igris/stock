/**
 * Zerodha Instrument Provider — Pure Logic
 *
 * Pure, side-effect-free helpers used by `zerodha-instruments.ts` to parse and
 * classify the Zerodha instrument master dump. Extracted so the exact same code
 * that production runs can be unit-tested directly (no network, no Prisma).
 *
 * The provider in `zerodha-instruments.ts` imports and calls these functions —
 * there are no dead/parallel copies.
 */

import { YAHOO_SUFFIX_MAP, SUPPORTED_EXCHANGES } from "./types";
import { splitCsvLine } from "../csv-line";

/**
 * Maps Zerodha instrument_type to our canonical types.
 */
export const INSTRUMENT_TYPE_MAP: Record<string, string> = {
  EQ: "EQUITY",
  BE: "EQUITY",
  BL: "EQUITY",
  SM: "EQUITY",
  ST: "EQUITY",
  FUT: "FUTURES",
  CE: "OPTIONS",
  PE: "OPTIONS",
  IF: "INDEX",
  // ETFs are typically listed as EQ on exchanges
};

/**
 * Exchanges we care about from the Zerodha dump.
 */
export const RELEVANT_EXCHANGES = new Set<string>(SUPPORTED_EXCHANGES);

/**
 * Series we want to include for equity instruments.
 */
export const EQUITY_SERIES = new Set(["EQ", "BE", "BL", "SM", "ST"]);

// ============== ETF DETECTION ==============

/**
 * Known ETF suffixes in Indian markets.
 * Most Indian ETFs end with "BEES", "ETF", or are well-known names.
 */
export const ETF_SUFFIX_PATTERNS = [
  /BEES$/, // NIFTYBEES, GOLDBEES, BANKBEES, SILVERBEES
  /ETF$/, // NIFTYETF, ABORTETF, MOMETF
  /ETFN?50$/, // NIFTETF50
];

/**
 * Explicit ETF trading symbols that don't match suffix patterns.
 * Curated from NSE's ETF directory.
 */
export const KNOWN_ETF_SYMBOLS = new Set([
  // Nifty / Index ETFs
  "NIFTYBEES",
  "JUNIORBEES",
  "BANKBEES",
  "SETFNIF50",
  "SETFNN50",
  "UTINIFTETF",
  "LICNETFN50",
  "HABORETF",
  "MOVALUE",
  "MOMOMENTUM",
  "MOM100",
  "EQUAL50",
  // Sector ETFs
  "ITBEES",
  "PSUBNKBEES",
  "INFRABEES",
  "PHARMABEES",
  "CONSUMBEES",
  "TNIDETF",
  "DIVOPPBEES",
  "COMMOETF",
  // Gold / Silver / Commodity
  "GOLDBEES",
  "GOLDSHARE",
  "GOLDETF",
  "GOLD1",
  "BSLGOLDETF",
  "SILVERBEES",
  "SILVERETF",
  "SILVRETF",
  // Debt / Liquid / Gilt
  "LIQUIDBEES",
  "LIQUIDETF",
  "LIQUIDCASE",
  "LIQUIDADD",
  "NIFTYQLITY",
  "ICICIB22",
  "EBBETF0425",
  "EBBETF0430",
  "EBBETF0431",
  "CPSEETF",
  "BHARAT22",
  "NETFLTGILT",
  "LONGTERMETF",
  // International
  "N100",
  "MAFANG",
  "NASDAQ50",
  "HNGSNGBEES",
  // Mid/Small Cap
  "MIDCAPBEES",
  "MID150BEES",
  "MIDSELIETF",
]);

/**
 * Detect if a trading symbol is an ETF based on naming heuristics.
 */
export function isETF(tradingSymbol: string, name: string): boolean {
  const upper = tradingSymbol.toUpperCase();

  // Check explicit known ETFs
  if (KNOWN_ETF_SYMBOLS.has(upper)) return true;

  // Check suffix patterns
  for (const pattern of ETF_SUFFIX_PATTERNS) {
    if (pattern.test(upper)) return true;
  }

  // Check if the name contains "ETF" or "Exchange Traded Fund"
  const upperName = name.toUpperCase();
  if (
    upperName.includes(" ETF") ||
    upperName.includes("EXCHANGE TRADED FUND") ||
    upperName.includes("EXCHANGE TRADED")
  ) {
    return true;
  }

  return false;
}

/**
 * Detect a REIT or InvIT from the instrument name — MONEY-1085 follow-up.
 *
 * These are TRUSTS, not equities: a REIT owns rent-yielding real estate, an
 * InvIT owns operating infrastructure, and both distribute nearly all cash flow
 * to unit-holders. Zerodha's dump types them `EQ` like everything else in the
 * cash segment, so without this they land as `EQUITY` and get compared against
 * operating companies on P/E and earnings growth — metrics that mean something
 * different for a trust.
 *
 * Name-based, exactly like {@link isETF}, because it is the only reliable
 * signal: the trading symbols give nothing away (`NXST`, `BIRET`, `KRT`), while
 * every issuer puts REIT/InvIT in the registered name.
 *
 * Word-boundary matched so a company whose name merely contains the letters
 * (e.g. "…REITERATED…") can't be misclassified.
 */
export function classifyTrustInstrument(
  _tradingSymbol: string,
  name: string,
): "REIT" | "INVIT" | null {
  const upper = String(name ?? "").toUpperCase();

  // InvIT first: several are named "<X> INFRA TRUST (INVIT)", and an InvIT is
  // never also a REIT, so an early return is safe and keeps the intent clear.
  if (
    /\bINVIT\b/.test(upper) ||
    /\bINV\s?IT\b/.test(upper) ||
    upper.includes("INFRASTRUCTURE INVESTMENT TRUST")
  ) {
    return "INVIT";
  }

  if (
    /\bREIT\b/.test(upper) ||
    upper.includes("REAL ESTATE INVESTMENT TRUST")
  ) {
    return "REIT";
  }

  return null;
}

/**
 * NSE cash series → trust type, for rows sourced from the bhavcopy rather than
 * from a broker dump. NSE assigns REITs series `RR` and InvITs series `IV`,
 * which is a stronger signal than the name when we have it.
 */
export const NSE_TRUST_SERIES: Record<string, "REIT" | "INVIT"> = {
  RR: "REIT",
  IV: "INVIT",
};

export interface ZerodhaCSVRow {
  instrument_token: string;
  exchange_token: string;
  tradingsymbol: string;
  name: string;
  last_price: string;
  expiry: string;
  strike: string;
  tick_size: string;
  lot_size: string;
  instrument_type: string;
  segment: string;
  exchange: string;
}

/**
 * Outcome of parsing the Kite instrument dump.
 *
 * `reasons` exists so a dropped row is COUNTED rather than vanishing. See
 * {@link parseInstrumentCsv} for why that matters here specifically.
 */
export interface ZerodhaCsvParseResult {
  /** Rows that parsed cleanly. */
  rows: ZerodhaCSVRow[];
  /**
   * Non-empty data lines that produced NO row, keyed by why. Empty object when
   * nothing was dropped — an empty `reasons` is the healthy state, and callers
   * log only when it is non-empty.
   */
  reasons: Record<string, number>;
  /**
   * Non-empty data lines seen (excludes the header and blank lines).
   *
   * INVARIANT, asserted by the tests: `rows.length + Σreasons === dataLines`.
   * Nothing may leave this function unaccounted for.
   */
  dataLines: number;
}

/**
 * Parse the Zerodha/Kite `/instruments` CSV into rows, accounting for every
 * line it does not keep.
 *
 * ## The bug this replaces — MONEY-1205
 *
 * This function used to split on `line.split(",")`. **Kite quotes its `name`
 * column** — verified against the live endpoint on 2026-08-18: 106,262 of
 * 114,427 lines carry quotes, e.g.
 *
 *   `1847809,7218,SBIETFQLTY,"SBI NIFTY 200 QUALITY 30 ETF",0,,0,0.01,1,EQ,NSE,NSE`
 *
 * A naive split keeps the quote characters as part of the value, so
 * `mapCSVRowToRaw`'s `name: row.name || baseSymbol` carried them all the way
 * into `InstrumentMapping.name`. Measured on prod: **13,287 of 26,669 names
 * (49.8%) were stored wrapped in literal double quotes** — NSE 6,620/11,529,
 * BSE 6,667/15,140, including 540 of 541 active ETFs.
 *
 * It was not self-healing and it was not static. `ZerodhaInstrumentProvider.
 * mapToUpdate` strips only `series` and `instrumentType`; `name` stays in the
 * spread and is rewritten on EVERY update, so the nightly 22:00 IST
 * instrument-sync re-stamped the corruption. Any repair run before this parser
 * was fixed would have been reverted within 24 hours — the MONEY-1093 class.
 *
 * The NSE/BSE asymmetry was not a second bug: `nse-master-logic.ts` has always
 * had a correct splitter, so the NSE rows EQUITY_L/SME_EQUITY_L cover were
 * healed by that provider. The 6,620 quoted NSE rows are exactly what it does
 * not cover — ETFs, SGBs, bonds, delisted.
 *
 * ## Why the drop is counted
 *
 * The old `if (values.length !== headers.length) continue;` was a SILENT drop,
 * and a quoted `name` containing a comma is precisely what it would have eaten:
 * one free-text comma shifts every column to its right and the whole
 * instrument disappears from the universe with no log line. Zero such rows
 * exist today (all 114,426 data lines split into exactly 12 naive fields on
 * 2026-08-18), so this was latent, not active — but "latent" is how it stays
 * only if a future occurrence is visible. The RFC-4180 splitter fixes the
 * quoted case outright; the counter covers everything else (a genuinely
 * malformed line, an unbalanced quote, a column added upstream).
 */
export function parseInstrumentCsv(csvText: string): ZerodhaCsvParseResult {
  const reasons: Record<string, number> = {};
  const bump = (k: string): void => {
    reasons[k] = (reasons[k] ?? 0) + 1;
  };

  const lines = csvText.trim().split("\n");
  if (lines.length < 2) return { rows: [], reasons, dataLines: 0 };

  const headerLine = lines[0];
  if (!headerLine) return { rows: [], reasons, dataLines: 0 };
  // The header is split the same way as the body. Kite does not quote it today,
  // but a parser whose header and rows disagree about quoting is a field-count
  // mismatch on every line — the loudest possible failure, but only if the two
  // halves use one splitter.
  const headers = splitCsvLine(headerLine).map((h) => h.trim());
  const rows: ZerodhaCSVRow[] = [];
  let dataLines = 0;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Blank lines are not data and are not rejections — a trailing newline is
    // normal. They are excluded from `dataLines` so the invariant holds.
    if (!line || !line.trim()) continue;
    dataLines++;

    const values = splitCsvLine(line);
    if (values.length !== headers.length) {
      // COUNTED, never silent. The caller logs this; see the provider.
      bump("field-count");
      continue;
    }

    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      const header = headers[j];
      if (!header) continue;
      // Trimmed AFTER the split, which is deliberate and is the long-standing
      // behaviour (there are tests for it). The splitter has already removed a
      // quoted cell's delimiters, so this only ever strips padding around the
      // value — `"SBI NIFTY 200 QUALITY 30 ETF"` is untouched. Kite pads
      // nothing, but the dump is generated upstream and the trim is free.
      row[header] = values[j]?.trim() ?? "";
    }
    rows.push(row as unknown as ZerodhaCSVRow);
  }

  return { rows, reasons, dataLines };
}

/**
 * Rows-only view of {@link parseInstrumentCsv}, kept because it is the
 * long-standing exported shape and is imported by tests in two workspaces.
 *
 * Prefer `parseInstrumentCsv` in production code: callers that discard
 * `reasons` cannot report what they dropped, which is the habit that let the
 * silent `continue` survive.
 */
export function parseCSV(csvText: string): ZerodhaCSVRow[] {
  return parseInstrumentCsv(csvText).rows;
}

/**
 * Detect synthetic/non-tradeable instruments like INAV (Indicative NAV) trackers.
 * These instruments have previousClose=0 and produce bogus changePercent values.
 *
 * Known patterns:
 * - Symbol ends with "INAV" (e.g., NIFTYBEESINAV, GOLDBEESINAV)
 * - Symbol contains "-INAV" (e.g., NIFTYBEES-INAV)
 * - Symbol ends with "NAV" after a known ETF name
 * - Name contains "iNAV", "Indicative NAV", or "Indicative Net Asset"
 */
export function isSyntheticInstrument(
  tradingSymbol: string,
  name: string,
): boolean {
  const upperSymbol = tradingSymbol.toUpperCase();
  const upperName = name.toUpperCase();

  // Symbol-based checks
  if (upperSymbol.endsWith("INAV")) return true;
  if (upperSymbol.includes("-INAV")) return true;
  if (upperSymbol.includes("_INAV")) return true;

  // Name-based checks - catches instruments regardless of symbol naming
  if (upperName.includes("INAV")) return true;
  if (upperName.includes("INDICATIVE NAV")) return true;
  if (upperName.includes("INDICATIVE NET ASSET")) return true;

  return false;
}

/**
 * Determine if an instrument row should be included in our database.
 * Filters out:
 * - Exchanges we don't support
 * - Illiquid or obscure instruments
 * - Test symbols
 * - Synthetic/non-tradeable instruments (INAV trackers)
 */
export function shouldInclude(row: ZerodhaCSVRow): boolean {
  if (!RELEVANT_EXCHANGES.has(row.exchange)) return false;

  const instrumentType = row.instrument_type?.toUpperCase();

  // For NSE/BSE equity, only include common series
  if (
    (row.exchange === "NSE" || row.exchange === "BSE") &&
    EQUITY_SERIES.has(instrumentType)
  ) {
    // Exclude INAV (Indicative NAV) and similar synthetic/non-tradeable instruments.
    // These have previousClose=0 and produce bogus changePercent values (2000-3000%).
    // Patterns: NIFTYBEESINAV, GOLDBEES-INAV, *NAV suffix, name containing "iNAV"
    if (isSyntheticInstrument(row.tradingsymbol, row.name)) return false;

    return true;
  }

  // Include F&O instruments from NFO/BFO
  if (
    (row.exchange === "NFO" || row.exchange === "BFO") &&
    (instrumentType === "FUT" ||
      instrumentType === "CE" ||
      instrumentType === "PE")
  ) {
    return true;
  }

  // Include MCX futures and options
  if (
    row.exchange === "MCX" &&
    (instrumentType === "FUT" ||
      instrumentType === "CE" ||
      instrumentType === "PE")
  ) {
    return true;
  }

  // Include indices
  if (instrumentType === "IF") return true;

  return false;
}

/**
 * Build the Yahoo Finance symbol for an instrument row.
 */
export function buildYahooSymbol(row: ZerodhaCSVRow): string {
  const exchange = row.exchange;
  const symbol = row.tradingsymbol;
  const instrumentType = row.instrument_type?.toUpperCase();

  // Index symbols have special Yahoo mappings
  if (instrumentType === "IF") {
    // We don't auto-generate index Yahoo symbols - they use ^ prefix
    // These are handled separately in the sync orchestrator
    return "";
  }

  // F&O instruments don't have direct Yahoo symbols
  if (exchange === "NFO" || exchange === "BFO" || exchange === "MCX") {
    return "";
  }

  // Equity instruments: SYMBOL.NS or SYMBOL.BO
  const suffix = YAHOO_SUFFIX_MAP[exchange] ?? ".NS";

  // Extract base symbol (remove series suffix if present)
  const baseSymbol = symbol.replace(/-[A-Z]+$/, "");
  return `${baseSymbol}${suffix}`;
}

/**
 * Extract the base symbol from a Zerodha trading symbol.
 * For F&O, extracts the underlying (e.g., NIFTY from NIFTY24JAN25FUT).
 * For equity, returns as-is.
 */
export function extractBaseSymbol(
  tradingSymbol: string,
  exchange: string,
): string {
  if (exchange === "NSE" || exchange === "BSE") {
    return tradingSymbol;
  }

  // For F&O, the base symbol is typically the leading alphabetic part
  const match = tradingSymbol.match(/^([A-Z&]+)/);
  return match?.[1] ?? tradingSymbol;
}

/**
 * Map a parsed Zerodha CSV row into the canonical RawInstrument-like shape.
 * Returned object intentionally omits broker-specific fields beyond zerodhaToken
 * (ISIN is enriched separately, never present in the CSV).
 */
export function mapCSVRowToRaw(row: ZerodhaCSVRow): {
  symbol: string;
  exchange: string;
  name: string;
  tradingSymbol: string;
  instrumentType: string;
  isin: string | undefined;
  series: string;
  lotSize: number | undefined;
  tickSize: number | undefined;
  expiryDate: Date | undefined;
  strikePrice: number | undefined;
  optionType: string | undefined;
  segmentCode: string;
  zerodhaToken: number | undefined;
} {
  let instrumentType =
    INSTRUMENT_TYPE_MAP[row.instrument_type?.toUpperCase()] ?? "EQUITY";

  // Detect ETFs - Zerodha lists them as EQ but we want to classify separately
  if (instrumentType === "EQUITY" && isETF(row.tradingsymbol, row.name)) {
    instrumentType = "ETF";
  }

  // Same treatment for REITs / InvITs, which Zerodha also types as EQ. Checked
  // after ETF so an "…REIT ETF" style fund-of-trusts stays an ETF.
  if (instrumentType === "EQUITY") {
    const trust = classifyTrustInstrument(row.tradingsymbol, row.name);
    if (trust) instrumentType = trust;
  }

  const baseSymbol = extractBaseSymbol(row.tradingsymbol, row.exchange);

  return {
    symbol: baseSymbol,
    exchange: row.exchange,
    name: row.name || baseSymbol,
    tradingSymbol: row.tradingsymbol,
    instrumentType,
    isin: undefined, // ISIN is not in the Zerodha CSV; will be enriched separately
    series: row.instrument_type,
    lotSize: row.lot_size ? parseInt(row.lot_size, 10) : undefined,
    tickSize: row.tick_size ? parseFloat(row.tick_size) : undefined,
    expiryDate: row.expiry ? new Date(row.expiry) : undefined,
    strikePrice: row.strike ? parseFloat(row.strike) : undefined,
    optionType:
      row.instrument_type === "CE" || row.instrument_type === "PE"
        ? row.instrument_type
        : undefined,
    segmentCode: row.segment,
    zerodhaToken: row.instrument_token
      ? parseInt(row.instrument_token, 10)
      : undefined,
  };
}
