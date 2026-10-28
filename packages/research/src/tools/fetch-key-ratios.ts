/**
 * Fetch Key Financial Ratios - Yahoo quoteSummary → Tickertape/Screener chain,
 * with a DB-first `StockRatios` fallback (MONEY-1060 RC3/RC4).
 *
 * The live chain (Yahoo → Tickertape/Screener) is tried first so a healthy fetch
 * keeps its richer shape + analyst metadata. When every live source is
 * unreachable/empty we fall back to the synced `StockRatios` row via
 * `getOrFetchRatios` (DB-first, stale-on-error — never throws), exactly like the
 * income/balance/cash-flow tools already do with `getDbFirstStatements`. When
 * the live source THREW and the DB row is ALSO empty we return `success:false`
 * with `metadata.sourceError` so the synthesizer can tell "source down" from a
 * genuine data gap instead of reading a silent empty-success.
 */

import {
  yahooFetchQuoteSummary,
  withExchangeFallback,
} from "@usemoney/core/market-data";
import { fetchFinancialsChain } from "../data-sources/data-source-chain";
import type { ResearchToolDef, ToolOutput } from "./types";
import type { KeyRatios } from "../types";

function extractRaw(obj: unknown): number | undefined {
  if (typeof obj === "number") return obj;
  if (typeof obj === "object" && obj !== null && "raw" in obj) {
    return (obj as Record<string, unknown>).raw as number;
  }
  return undefined;
}

/** The `KeyRatios` fields a synced `StockRatios` row can populate 1:1. */
const DB_KEY_RATIO_FIELDS: readonly (keyof KeyRatios)[] = [
  "pe",
  "pb",
  "evToEbitda",
  "roe",
  "roa",
  "debtToEquity",
  "currentRatio",
  "dividendYield",
  "beta",
  "operatingMargin",
  "netMargin",
  "revenueGrowth",
  "earningsGrowth",
];

/**
 * Map a `StockRatios` DB row (as returned by `getOrFetchRatios`) onto `KeyRatios`.
 * Returns null when the row is null/absent or carries no finite ratio figure —
 * so an empty row never masquerades as a real fallback.
 */
export function dbRowToKeyRatios(
  row: Record<string, unknown> | null | undefined,
): KeyRatios | null {
  if (!row) return null;
  const out: KeyRatios = {};
  let hasFigure = false;
  for (const field of DB_KEY_RATIO_FIELDS) {
    const value = row[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      out[field] = value;
      hasFigure = true;
    }
  }
  return hasFigure ? out : null;
}

/**
 * Yahoo quoteSummary seam — matches `yahooFetchQuoteSummary`'s shape including
 * its `onError` observer (MONEY-1060). Injectable so tests can exercise the
 * REAL swallow-path wiring: production `fetchQuoteSummary` NEVER throws (it
 * catches internally and returns null), so the observer is the only outage
 * signal — fakes should return null + call onError rather than throw.
 */
export type QuoteSummaryFetcher = (
  symbol: string,
  modules: string[],
  opts?: { onError?: (error: unknown, context?: string) => void },
) => Promise<Record<string, unknown> | null>;

/** Tickertape/Screener chain seam — structural shape of `fetchFinancialsChain`. */
export type FinancialsChainFetcher = (
  symbol: string,
) => Promise<{ source: string; data: unknown } | null>;

/**
 * Live ratios: Yahoo quoteSummary → Tickertape/Screener chain. Returns the mapped
 * ratios + metadata, or null when the sources are reachable but empty. Throws
 * the captured Yahoo error (whether thrown OR reported via the onError
 * observer — the production path, since both `fetchQuoteSummary` and
 * `withExchangeFallback` swallow) when the chain ALSO came up empty, so the
 * caller can record it as `metadata.sourceError`. Exported with injectable
 * seams so the wiring is testable against the SAME code `execute` runs.
 */
export async function fetchLiveRatios(
  symbol: string,
  summaryFetch: QuoteSummaryFetcher = yahooFetchQuoteSummary,
  chainFetch: FinancialsChainFetcher = fetchFinancialsChain,
): Promise<{ data: unknown; metadata?: Record<string, unknown> } | null> {
  let yahooError: unknown;
  const capture = (e: unknown): void => {
    yahooError = yahooError ?? e;
  };
  try {
    const data = await withExchangeFallback(
      symbol,
      (s) =>
        summaryFetch(s, ["defaultKeyStatistics", "financialData"], {
          onError: capture,
        }),
      { onError: capture },
    );

    if (data) {
      const stats = data.defaultKeyStatistics as
        | Record<string, unknown>
        | undefined;
      const fin = data.financialData as Record<string, unknown> | undefined;

      const ratios: KeyRatios = {
        pe: extractRaw(stats?.forwardPE) || extractRaw(stats?.trailingPE),
        pb: extractRaw(stats?.priceToBook),
        evToEbitda: extractRaw(stats?.enterpriseToEbitda),
        roe: extractRaw(fin?.returnOnEquity),
        roa: extractRaw(fin?.returnOnAssets),
        debtToEquity: extractRaw(fin?.debtToEquity),
        currentRatio: extractRaw(fin?.currentRatio),
        dividendYield: extractRaw(stats?.dividendYield),
        beta: extractRaw(stats?.beta),
        operatingMargin: extractRaw(fin?.operatingMargins),
        netMargin: extractRaw(fin?.profitMargins),
        revenueGrowth: extractRaw(fin?.revenueGrowth),
        earningsGrowth: extractRaw(fin?.earningsGrowth),
      };

      return {
        data: ratios,
        metadata: {
          currentPrice: extractRaw(fin?.currentPrice),
          targetPrice: extractRaw(fin?.targetMeanPrice),
          recommendation: fin?.recommendationKey,
        },
      };
    }
  } catch (err) {
    capture(err);
  }

  // Yahoo empty or errored → Tickertape → Screener chain (never throws itself).
  const chainResult = await chainFetch(symbol);
  if (chainResult) {
    return {
      data: chainResult.data,
      metadata: { source: chainResult.source, fallback: true },
    };
  }

  // Chain also empty. Propagate the captured Yahoo error (if any) so it
  // surfaces as metadata.sourceError once the DB fallback is exhausted.
  if (yahooError) throw yahooError;
  return null;
}

/**
 * Live-primary, DB-fallback resolution (MONEY-1060 RC3/RC4). Exported so the
 * fallback ordering/flagging is unit-testable against the SAME code `execute`
 * runs — inject a fake live fetch + `getOrFetchRatios` in tests.
 */
export async function resolveKeyRatios(
  symbol: string,
  liveFetch: () => Promise<{
    data: unknown;
    metadata?: Record<string, unknown>;
  } | null>,
  dbFetch: () => Promise<Record<string, unknown> | null>,
): Promise<ToolOutput> {
  let sourceError: string | undefined;
  try {
    const live = await liveFetch();
    if (live) {
      return { success: true, data: live.data, metadata: live.metadata };
    }
  } catch (err) {
    sourceError = err instanceof Error ? err.message : String(err);
  }

  // DB fallback: synced StockRatios (stale-on-error). getOrFetchRatios never
  // throws, but guard defensively so a DB blip can't mask the live sourceError.
  let dbRow: Record<string, unknown> | null = null;
  try {
    dbRow = await dbFetch();
  } catch {
    // ignore — treated as an empty DB fallback below
  }
  const dbRatios = dbRowToKeyRatios(dbRow);
  if (dbRatios) {
    return {
      success: true,
      data: dbRatios,
      metadata: {
        source: (dbRow?.source as string) ?? "DB",
        fallback: true,
        dbFirst: true,
        ...(sourceError ? { sourceError } : {}),
      },
    };
  }

  return {
    success: false,
    error: `No ratios found for ${symbol}${sourceError ? `: ${sourceError}` : ""}`,
    ...(sourceError ? { metadata: { sourceError } } : {}),
  };
}

export const fetchKeyRatiosTool: ResearchToolDef = {
  name: "fetch_key_ratios",
  description:
    "Fetch key financial ratios: PE, PB, ROE, ROA, EV/EBITDA, margins, growth rates",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Yahoo Finance symbol",
      required: true,
    },
  },
  cacheTTL: 21600, // 6h
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    if (!symbol) return { success: false, error: "symbol is required" };

    return resolveKeyRatios(
      symbol,
      () => fetchLiveRatios(symbol),
      // Lazy import INSIDE the dbFetch thunk (MONEY-1060 fix 9, mirroring
      // fetch-peer-companies' fromDb): db-store imports @usemoney/database at
      // module top, which instantiates PrismaClient at module scope — loading
      // it BEFORE the live fetch made a Prisma-broken env kill the whole tool
      // where pre-PR live-only succeeded. resolveKeyRatios try/catches this
      // thunk, so a Prisma module-load throw degrades to live-only.
      async () => {
        const { getOrFetchRatios } = await import("../data-sources/db-store");
        return getOrFetchRatios(symbol);
      },
    );
  },
};
