/**
 * Data Source Chain
 *
 * Priority-based fallback across Yahoo Finance, Tickertape, and Screener.in.
 * Each method tries sources in order and returns the first successful result.
 */

// MONEY-613/142: this was a no-op, so every source failure in the fallback
// chain was swallowed silently. Route through console (these are low-level data
// clients with no logger dependency by design) so failures are observable.
const logger = {
  debug: (...args: unknown[]) => console.debug("[data-source-chain]", ...args),
};
// MONEY-1220: the FINANCIALS and QUARTERLY value imports are gone — both
// chains now start (and end) at Screener, because the Tickertape attempt in
// front of them was a 403 from our egress every time. The TYPE imports stay:
// callers still handle rows Tickertape wrote before the switchover.
import {
  fetchTickertapePeers,
  screenStocksTickertape,
  fetchTickertapeQuote,
  fetchTickertapeShareholding,
  type TickertapeFinancials,
  type TickertapePeer,
  type ScreenerFilter,
  type ScreenerResult,
  type TickertapeQuote,
  type TickertapeShareholding,
  type TickertapeQuarterlyResult,
} from "./tickertape-client";
import {
  fetchScreenerFinancials,
  fetchScreenerQuarterlyResults,
  fetchScreenerShareholding,
  fetchScreenerPeers,
  type ScreenerFinancialData,
  type ScreenerQuarterlyResult,
  type ScreenerShareholding,
  type ScreenerPeer,
} from "./screener-client";

type FinancialDataResult =
  | { source: "tickertape"; data: TickertapeFinancials }
  | { source: "screener"; data: ScreenerFinancialData }
  | null;

/**
 * Why a chain ended with no data — MONEY-1146.
 *
 * `tryChain` collapses two very different endings into one `null`:
 *
 *   - every source answered cleanly and none had data for this symbol
 *     (BSE-only, SME/Emerge, newly listed — an ordinary, correct answer)
 *   - every source THREW: blocked, rate-limited, vendor layout changed
 *     (the feature is broken and nobody can tell)
 *
 * Callers that render a UI need to tell those apart: the first is a neutral
 * "no coverage" state, the second is an error. Returning `null` for both is
 * why the Ownership tab could have been dead for months without a signal.
 */
export interface ChainOutcome<T> {
  /** First successful result, or `null` if the chain was exhausted. */
  data: T | null;
  /** Sources that THREW, in attempt order. Empty when nothing failed. */
  errors: Array<{ source: string; message: string }>;
  /** Sources that answered cleanly with no data. */
  emptyCount: number;
}

/**
 * Try each source in order and report HOW the chain ended, not just what it
 * produced.
 *
 * Separate from {@link tryChain} on purpose: nine other call sites want the
 * plain `T | null` and have no use for the diagnosis, so widening the shared
 * helper's return would churn every one of them for no gain.
 */
export async function tryChainDetailed<T>(
  attempts: Array<{ name: string; fn: () => Promise<T | null> }>,
): Promise<ChainOutcome<T>> {
  const errors: ChainOutcome<T>["errors"] = [];
  let emptyCount = 0;

  for (const { name, fn } of attempts) {
    try {
      const result = await fn();
      if (result !== null) {
        logger.debug({ source: name }, "Data source chain: success");
        return { data: result, errors, emptyCount };
      }
      // A clean answer that simply had nothing. NOT a failure — every client
      // in this chain returns `null` for an empty response as well as for an
      // error (e.g. tickertape-client: `if (!resp?.data?.length) return null`).
      emptyCount++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ source: name, message });
      logger.debug({ source: name, error }, "Data source chain: source failed");
    }
  }

  // All sources exhausted with no result — this is the real signal (an outage
  // vs a single expected fallback), so surface it instead of returning null
  // silently (MONEY-613). MONEY-1146: say WHICH ending this was, because
  // "every source threw" and "no source covers this symbol" need different
  // responses and used to log identically.
  if (attempts.length > 0) {
    const names = attempts.map((a) => a.name).join(", ");
    if (errors.length > 0) {
      console.warn(
        `[data-source-chain] all ${attempts.length} source(s) FAILED (${names}) — ` +
          `${errors.map((e) => `${e.source}: ${e.message}`).join("; ")}`,
      );
    } else {
      console.warn(
        `[data-source-chain] all ${attempts.length} source(s) returned NO DATA ` +
          `(${names}) — no coverage for this symbol, not an error`,
      );
    }
  }

  return { data: null, errors, emptyCount };
}

/**
 * Try each function in order, return the first successful result.
 *
 * Thin wrapper over {@link tryChainDetailed} — same behaviour, diagnosis
 * discarded. Kept so the existing call sites are unchanged.
 */
async function tryChain<T>(
  attempts: Array<{ name: string; fn: () => Promise<T | null> }>,
): Promise<T | null> {
  return (await tryChainDetailed(attempts)).data;
}

/**
 * Fetch financial statements — MONEY-1220.
 *
 * Priority was Tickertape → Screener. Tickertape is GONE from this chain: it
 * returns 403 to our Cloud Run egress, so on the request path it bought nothing
 * but a doomed round trip before Screener ran anyway. Removing it makes the
 * fallback the FIRST attempt instead of the second.
 *
 * This is the best-effort EXTERNAL read. The authoritative path is
 * `getOrFetchFinancials`, which serves our own `StockFinancials` — filled
 * nightly by `xbrl-projection` from archived NSE filings. Nothing here
 * persists: a request-time write from the weakest source in
 * FINANCIALS_AUTHORITY could occupy a period the projection then has to
 * displace, on a table whose unique key carries no `source`.
 */
export async function fetchFinancialsChain(
  symbol: string,
): Promise<FinancialDataResult> {
  return (await fetchFinancialsChainDetailed(symbol)).result;
}

/**
 * As {@link fetchFinancialsChain}, but reporting HOW the chain ended.
 *
 * MONEY-1274. `tryChainDetailed` was added by MONEY-1146 precisely to separate
 * "every source threw" from "no source covers this symbol", and had NO caller
 * outside its own module — its own note says the nine existing call sites
 * wanted the plain `T | null`, so the diagnosis was computed and dropped on
 * every request.
 *
 * The cost of dropping it is a claim about a COMPANY. The statement tools ended
 * with `No income statement data found for ${symbol}`, which the synthesizer
 * puts in front of the model verbatim — so a Screener 403 and a genuinely
 * uncovered SME both render as "this company has no income statement". One is
 * an outage, the other is a fact, and the report asserted the fact either way.
 */
export async function fetchFinancialsChainDetailed(symbol: string): Promise<{
  result: FinancialDataResult;
  outcome: ChainOutcome<ScreenerFinancialData>;
}> {
  const outcome = await tryChainDetailed<ScreenerFinancialData>([
    {
      name: "screener",
      fn: () => fetchScreenerFinancials(symbol),
    },
  ]);

  return {
    result: outcome.data ? { source: "screener", data: outcome.data } : null,
    outcome,
  };
}

/**
 * Fetch peer companies with fallback.
 * Priority: Tickertape
 */
export async function fetchPeersChain(
  symbol: string,
): Promise<TickertapePeer[] | null> {
  return tryChain([
    {
      name: "tickertape",
      fn: () => fetchTickertapePeers(symbol),
    },
  ]);
}

/**
 * Run stock screener with fallback.
 * Priority: Tickertape (150+ filters)
 */
export async function screenStocksChain(
  filters: ScreenerFilter,
  limit?: number,
): Promise<ScreenerResult[]> {
  const result = await tryChain([
    {
      name: "tickertape",
      fn: async () => {
        const results = await screenStocksTickertape(filters, limit);
        return results.length > 0 ? results : null;
      },
    },
  ]);
  return result ?? [];
}

/**
 * Fetch quick quote with fallback.
 * Primary: Yahoo Finance (called externally), Fallback: Tickertape
 */
export async function fetchQuoteChain(
  symbol: string,
): Promise<TickertapeQuote | null> {
  return tryChain([
    {
      name: "tickertape",
      fn: () => fetchTickertapeQuote(symbol),
    },
  ]);
}

/**
 * Fetch quarterly results with fallback chain.
 * Priority: Tickertape → Screener.in
 */
export async function fetchQuarterlyResultsChain(
  symbol: string,
): Promise<TickertapeQuarterlyResult[] | ScreenerQuarterlyResult[] | null> {
  // The type argument is EXPLICIT — MONEY-1205. `tryChain<T>` infers `T` from
  // the first attempt, so this used to resolve to `TickertapeQuarterlyResult[]`
  // and the Screener attempt only conformed because the two interfaces were
  // character-for-character identical. They no longer are: the Tickertape one
  // now describes the interim endpoint's ACTUAL keys (`displayPeriod`,
  // `qIncTrev`, …) instead of the five invented ones it shared with Screener.
  // Naming the union — which this function already declares as its return type
  // — is what the inference was standing in for.
  // MONEY-1220 — the `tickertape` attempt is REMOVED, not demoted. It returned
  // 403 from Cloud Run on every call, so it was never a source here: it was a
  // doomed round trip in front of the one that answered. Same removal as
  // `fetchFinancialsChain` above, and it matters more on this path because
  // QUARTERLY is the tab that was empty platform-wide.
  //
  // The union return type is kept as-is deliberately. Callers still handle both
  // shapes, and rows Tickertape wrote before the switchover are still in the
  // table — narrowing the type would be a claim about STORED data, which this
  // change does not touch.
  return tryChain<TickertapeQuarterlyResult[] | ScreenerQuarterlyResult[]>([
    {
      name: "screener",
      fn: () => fetchScreenerQuarterlyResults(symbol),
    },
  ]);
}

/**
 * Fetch shareholding pattern with fallback chain.
 * Priority: Tickertape → Screener.in
 */
export async function fetchShareholdingChain(
  symbol: string,
): Promise<TickertapeShareholding[] | ScreenerShareholding[] | null> {
  return (await fetchShareholdingChainDetailed(symbol)).data;
}

/**
 * Shareholding chain that reports HOW it ended — MONEY-1146.
 *
 * The Ownership tab is the reason this exists. `fetchShareholdingChain`
 * returns `null` both when no source covers the symbol and when every source
 * threw, so the tab rendered one empty panel for "nothing to show" and for
 * "the scrape is blocked". There was no log line separating them, which is how
 * the feature could have been broken for months without anyone noticing.
 *
 * With the outcome, a caller can render a neutral empty state for
 * `data === null && errors.length === 0` and a real error for
 * `data === null && errors.length > 0`.
 */
export async function fetchShareholdingChainDetailed(
  symbol: string,
): Promise<ChainOutcome<TickertapeShareholding[] | ScreenerShareholding[]>> {
  return tryChainDetailed([
    {
      name: "tickertape",
      fn: () => fetchTickertapeShareholding(symbol),
    },
    {
      name: "screener",
      fn: () => fetchScreenerShareholding(symbol),
    },
  ]);
}

/**
 * Fetch peer companies with fallback chain.
 * Priority: Tickertape → Screener.in
 */
export async function fetchPeersWithScreenerFallback(
  symbol: string,
): Promise<TickertapePeer[] | ScreenerPeer[] | null> {
  const ttResult = await tryChain([
    {
      name: "tickertape",
      fn: () => fetchTickertapePeers(symbol),
    },
  ]);
  if (ttResult) return ttResult;

  return tryChain([
    {
      name: "screener",
      fn: () => fetchScreenerPeers(symbol),
    },
  ]);
}
