/**
 * Broker MF-diagnostics pure logic (MONEY-1062 W2-B).
 *
 * Side-effect-free helpers extracted from the diagnose/populate MF-ISIN server
 * actions in apps/web/lib/actions/broker-connection.ts. The actions stay thin
 * (demo-guard + user resolve + scoped prisma read/write); the counting, fund-name
 * normalisation, fuzzy similarity, and the symbol→ISIN / normalised-name→ISIN
 * lookup construction live here so they can be unit-tested without Prisma and so
 * a single source of truth backs both the action and its regression tests.
 *
 * Behaviour is ported VERBATIM from the previous inline action code.
 *
 * Source: apps/web/lib/actions/broker-connection.ts (diagnoseMFPairingAction,
 * populateMFISINAction, normalizeMFName, fundNameSimilarity).
 */

// ── Types ───────────────────────────────────────────────────────────────────

/** The minimal MF-trade projection the diagnostics helpers read. */
export interface MFTradeLite {
  symbol: string;
  tradingSymbol?: string | null;
  isin?: string | null;
}

export interface MFPairingDiagnosis {
  totalMFTrades: number;
  tradesWithIsin: number;
  tradesWithoutIsin: number;
  uniqueSymbols: number;
  uniqueIsins: number;
  /** Capped at the first 10 distinct symbols (matches the action's contract). */
  symbolsWithoutIsin: string[];
  suggestedFix: string;
}

/** Exact (symbol/tradingSymbol → ISIN) and fuzzy (normalised name → ISIN) maps. */
export interface IsinMaps {
  symbolToIsin: Map<string, string>;
  normalizedToIsin: Map<string, string>;
}

// ── Diagnosis ────────────────────────────────────────────────────────────────

/**
 * Summarise the ISIN health of a user's MF trades and suggest the next fix step.
 * Pure — the caller supplies the already-fetched MF trades.
 */
export function diagnoseMFPairing(trades: MFTradeLite[]): MFPairingDiagnosis {
  const tradesWithIsin = trades.filter((t) => t.isin);
  const tradesWithoutIsin = trades.filter((t) => !t.isin);

  const uniqueSymbols = new Set(trades.map((t) => t.symbol));
  const uniqueIsins = new Set(tradesWithIsin.map((t) => t.isin));
  const symbolsWithoutIsin = Array.from(
    new Set(tradesWithoutIsin.map((t) => t.symbol)),
  );

  // Determine suggested fix (verbatim from the action).
  let suggestedFix = "";
  if (tradesWithoutIsin.length === 0) {
    suggestedFix =
      "All MF trades have ISIN. Try running re-pairing by calling triggerRepairingAction().";
  } else if (
    tradesWithIsin.length > 0 &&
    symbolsWithoutIsin.some((s) =>
      tradesWithIsin.some(
        (t) => t.symbol === s || t.tradingSymbol === s || t.isin === s,
      ),
    )
  ) {
    suggestedFix =
      "Some trades can be fixed by running populateMFISINAction() which will match symbols with known ISINs.";
  } else {
    suggestedFix =
      "MF trades are missing ISIN. Re-import the CSV file ensuring the ISIN column is present, or manually update the trades with correct ISIN values.";
  }

  return {
    totalMFTrades: trades.length,
    tradesWithIsin: tradesWithIsin.length,
    tradesWithoutIsin: tradesWithoutIsin.length,
    uniqueSymbols: uniqueSymbols.size,
    uniqueIsins: uniqueIsins.size,
    symbolsWithoutIsin: symbolsWithoutIsin.slice(0, 10),
    suggestedFix,
  };
}

// ── Fund-name normalisation + similarity ──────────────────────────────────────

/**
 * Normalize a mutual fund name for fuzzy matching.
 * Removes common suffixes, special characters, and extra spaces.
 */
export function normalizeMFName(name: string): string {
  return (
    name
      .toUpperCase()
      // Remove common MF suffixes and keywords
      .replace(
        /\s+(ETF|FUND|SCHEME|GROWTH|DIVIDEND|DIRECT|REGULAR|PLAN|OPTION)$/gi,
        "",
      )
      .replace(
        /\s+(ETF|FUND|SCHEME|GROWTH|DIVIDEND|DIRECT|REGULAR|PLAN|OPTION)\s+/gi,
        " ",
      )
      // Remove special characters
      .replace(/[+\-().,]/g, "")
      // Normalize whitespace
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Calculate similarity between two normalized fund names (0-1).
 * Simple word-based Jaccard similarity.
 */
export function fundNameSimilarity(name1: string, name2: string): number {
  const wordsArr1 = name1.split(" ").filter((w) => w.length > 2);
  const wordsArr2 = name2.split(" ").filter((w) => w.length > 2);
  const words1 = new Set(wordsArr1);
  const words2 = new Set(wordsArr2);

  if (words1.size === 0 || words2.size === 0) return 0;

  const intersection = wordsArr1.filter((w) => words2.has(w));
  const union = new Set(wordsArr1.concat(wordsArr2));

  return intersection.length / union.size;
}

// ── ISIN lookup construction + matching ───────────────────────────────────────

/**
 * Build the exact + fuzzy ISIN lookups from the reference MF trades that already
 * carry an ISIN. `symbolToIsin` keys on UPPER-CASED symbol AND tradingSymbol;
 * `normalizedToIsin` keys on the normalised fund name.
 */
export function buildIsinMap(tradesWithIsin: MFTradeLite[]): IsinMaps {
  const symbolToIsin = new Map<string, string>();
  const normalizedToIsin = new Map<string, string>();
  for (const t of tradesWithIsin) {
    if (!t.isin) continue;
    symbolToIsin.set(t.symbol.toUpperCase(), t.isin);
    if (t.tradingSymbol) {
      symbolToIsin.set(t.tradingSymbol.toUpperCase(), t.isin);
    }
    normalizedToIsin.set(normalizeMFName(t.symbol), t.isin);
  }
  return { symbolToIsin, normalizedToIsin };
}

/**
 * Resolve an ISIN for a no-ISIN trade using the reference maps: exact
 * symbol/tradingSymbol match first, then exact-normalised, then a fuzzy
 * (Jaccard ≥ 0.8) fallback. Returns null when nothing matches.
 */
export function matchIsinForTrade(
  trade: MFTradeLite,
  maps: IsinMaps,
): string | null {
  // Exact symbol / tradingSymbol match.
  const exact =
    maps.symbolToIsin.get(trade.symbol.toUpperCase()) ??
    (trade.tradingSymbol
      ? maps.symbolToIsin.get(trade.tradingSymbol.toUpperCase())
      : undefined);
  if (exact) return exact;

  // Exact normalised-name match, then fuzzy.
  const normalizedName = normalizeMFName(trade.symbol);
  const exactNormalized = maps.normalizedToIsin.get(normalizedName);
  if (exactNormalized) return exactNormalized;

  let bestSimilarity = 0;
  let matchedIsin: string | null = null;
  for (const [refName, isin] of maps.normalizedToIsin.entries()) {
    const similarity = fundNameSimilarity(normalizedName, refName);
    // Require at least 80% similarity for a fuzzy match.
    if (similarity > bestSimilarity && similarity >= 0.8) {
      bestSimilarity = similarity;
      matchedIsin = isin;
    }
  }
  return matchedIsin;
}
