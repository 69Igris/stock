/**
 * Symbol Resolver
 *
 * Maps UseMoney internal symbols to Yahoo Finance and NSE formats.
 * Handles edge cases like NIFTY50, bank names, etc.
 *
 * resolveSymbol()       - sync, defaults to .NS (fast, no DB)
 *
 * MONEY-980 — `resolveSymbolFromDb()` USED TO LIVE HERE and is deleted, not
 * moved. It had ZERO callers: the definition, its own doc block and one barrel
 * re-export were every reference in the repo, and a doc rewrite had just given
 * it a `market` field nobody reads and prose reasoning about "its callers".
 *
 * It is not left behind as a convenience either, because its contract was the
 * hazard: a bare symbol resolved across BOTH collections with no venue and no
 * market, which is exactly the shape that lets an active US ticker answer a
 * question a caller asked about India. Anything that needs a DB resolution
 * calls `resolveInstrument` and STATES its market — which is one import, not a
 * wrapper, and cannot be adopted by accident.
 */

// Known exchange suffixes for Yahoo Finance
const YAHOO_SUFFIXES: Record<string, string> = {
  NSE: ".NS",
  BSE: ".BO",
  NASDAQ: "",
  NYSE: "",
  AMEX: "",
};

// Common symbol corrections for Yahoo Finance
const SYMBOL_CORRECTIONS: Record<string, string> = {
  NIFTY: "^NSEI",
  NIFTY50: "^NSEI",
  SENSEX: "^BSESN",
  BANKNIFTY: "^NSEBANK",
  NIFTYBANK: "^NSEBANK",
  NIFTYIT: "^CNXIT",
  "M&M": "M%26M",
  M_M: "M%26M",
  "L&T": "LT",
};

/**
 * Resolve a user-provided symbol to Yahoo Finance format
 *
 * @param symbol - User symbol (e.g., "RELIANCE", "RELIANCE.NS", "TCS")
 * @param exchange - Exchange hint (default: "NSE")
 * @returns Yahoo Finance symbol (e.g., "RELIANCE.NS")
 */
export function resolveSymbol(symbol: string, exchange = "NSE"): string {
  const upper = symbol.toUpperCase().trim();

  // Check corrections first
  const corrected = SYMBOL_CORRECTIONS[upper];
  if (corrected) return corrected;

  // Already has exchange suffix
  if (upper.endsWith(".NS") || upper.endsWith(".BO")) {
    return upper;
  }

  // Index symbols
  if (upper.startsWith("^")) {
    return upper;
  }

  // Add exchange suffix (US exchanges have empty string suffix)
  const exchangeKey = exchange.toUpperCase();
  const suffix =
    exchangeKey in YAHOO_SUFFIXES ? YAHOO_SUFFIXES[exchangeKey]! : ".NS";
  return `${upper}${suffix}`;
}

/**
 * Extract the base symbol (without exchange suffix) for NSE API.
 *
 * Tolerates a missing symbol and returns "" rather than throwing.
 *
 * That matters because FOUR tools call this BEFORE their own falsy guard —
 * `fetch-news.ts`, `fetch-corporate-actions.ts`,
 * `fetch-exchange-announcements.ts`, `fetch-shareholder-meetings.ts` all do
 * `toNseSymbol(params.symbol as string)` and only then check `if (!symbol)`.
 * With an undefined symbol this threw
 * `TypeError: Cannot read properties of undefined (reading 'replace')`, which
 * the executor caught into `task.error` and the sanitizer then passed VERBATIM
 * to the user (it is under 150 chars and contains none of the words the
 * scrubber looks for) — a raw internal error on a FAILED run with the user's
 * credit spent.
 *
 * Guarding the four call sites individually was the wrong fix: the next tool to
 * copy that idiom reintroduces it. Returning "" here means every one of those
 * `if (!symbol)` guards now does what its author intended.
 */
export function toNseSymbol(symbol: string | null | undefined): string {
  if (typeof symbol !== "string") return "";
  // TRIM FIRST. The suffix strip is `$`-anchored, so trailing whitespace stops
  // it matching: "RELIANCE.NS " used to come back as "RELIANCE.NS" — a WRONG
  // symbol, and non-empty, so every caller's `if (!symbol)` guard sailed past
  // it and the wrong value reached the fetch. This is reachable from LLM output,
  // which the planner passes through verbatim.
  return symbol
    .trim()
    .replace(/\.(NS|BO)$/i, "")
    .replace(/%26/g, "&")
    .toUpperCase()
    .trim();
}

/**
 * Extract symbols from a user query
 * Looks for known stock name patterns and uppercase words
 */
export function extractSymbolsFromQuery(query: string): string[] {
  const symbols: string[] = [];

  // Match explicit stock mentions with .NS or .BO suffix
  const explicitRegex = /\b([A-Z][A-Z0-9&]+)\.(NS|BO)\b/g;
  let match: RegExpExecArray | null;
  while ((match = explicitRegex.exec(query.toUpperCase())) !== null) {
    symbols.push(`${match[1]}.${match[2]}`);
  }

  if (symbols.length > 0) return symbols;

  // Match uppercase words that look like stock symbols (2-15 chars)
  const symbolRegex = /\b([A-Z][A-Z0-9&]{1,14})\b/g;
  const upperQuery = query.toUpperCase();
  const stopWords = new Set([
    "THE",
    "AND",
    "FOR",
    "WITH",
    "FROM",
    "ABOUT",
    "INTO",
    "WHAT",
    "HOW",
    "WHY",
    "WHEN",
    "WHERE",
    "WHO",
    "WHICH",
    "SHOULD",
    "COULD",
    "WOULD",
    "WILL",
    "CAN",
    "MAY",
    "HAS",
    "HAVE",
    "HAD",
    "WAS",
    "WERE",
    "ARE",
    "BUY",
    "SELL",
    "HOLD",
    "STOCK",
    "SHARE",
    "STOCKS",
    "SHARES",
    "COMPANY",
    "SECTOR",
    "MARKET",
    "PRICE",
    "VALUE",
    "FUND",
    "FUNDS",
    "INVEST",
    "INVESTING",
    "INVESTMENT",
    "ANALYZE",
    "ANALYSE",
    "ANALYSIS",
    "RESEARCH",
    "COMPARE",
    "COMPARISON",
    "PORTFOLIO",
    "GOOD",
    "BAD",
    "BEST",
    "WORST",
    "ALL",
    "ANY",
    "NOT",
    "YES",
    "GIVE",
    "SHOW",
    "LIST",
    "GET",
    "TELL",
    "KNOW",
    "FIND",
    "NSE",
    "BSE",
    "NIFTY",
    "SENSEX",
    "PE",
    "PB",
    "ROE",
    "ROCE",
    "EPS",
    "DCF",
    "EBITDA",
    "CAGR",
    "SIP",
    "MF",
    "IPO",
    "FII",
    "DII",
    "SEBI",
    // Words from [Mentioned: ...] prefix and descriptions
    "MENTIONED",
    "INDUSTRIES",
    "INDIAN",
    "CORP",
    "CORPORATION",
    "LIMITED",
    "LTD",
    "PRIVATE",
    "PVT",
    "PUBLIC",
    // Common prepositions and conjunctions
    "ON",
    "IN",
    "AT",
    "TO",
    "OF",
    "BY",
    "IS",
    "IT",
    "AN",
    "AS",
    "OR",
    "IF",
    "MY",
    "ME",
    "DO",
    "SO",
    "UP",
    "VS",
    "VERSUS",
    // Common action words in queries
    "RERUN",
    "REDO",
    "RETRY",
    "START",
    "RUN",
    "COMPREHENSIVE",
    "DETAILED",
    "QUICK",
    "DEEP",
    "DIVE",
    "ABOVE",
    "BELOW",
    "THIS",
    "THAT",
    "THESE",
    "THOSE",
    "ALSO",
    "JUST",
    "PLEASE",
    "DETAILS",
    "INFORMATION",
    "INFO",
    "LOOK",
    "CHECK",
    "FUTURE",
    "OUTLOOK",
    "PROSPECTS",
    "GROWTH",
    "POTENTIAL",
    "ABOUT",
    "LIKE",
    "MORE",
    "SOME",
    "OVER",
    "MUCH",
    "VERY",
    "BEEN",
    "DOES",
    "DID",
    "ITS",
    "OUR",
    "HIS",
    "HER",
    "THEIR",
    "THEM",
    "THAN",
    "THEN",
    "ONLY",
    "SAME",
    "EACH",
    "BOTH",
    "SUCH",
    "NEED",
    "WANT",
    "MAKE",
    "MADE",
    "TAKE",
    "LONG",
    "TERM",
    "SHORT",
  ]);

  while ((match = symbolRegex.exec(upperQuery)) !== null) {
    const word = match[1] ?? "";
    if (word.length >= 2 && !stopWords.has(word)) {
      symbols.push(word);
    }
  }

  return Array.from(new Set(symbols));
}
