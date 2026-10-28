/**
 * Fetch Company Profile - Yahoo quoteSummary (assetProfile + summaryProfile),
 * with a DB-first `StockProfile` fallback (MONEY-1060 RC3/RC4).
 *
 * Yahoo stays the primary source; when it is unreachable/empty we fall back to
 * the synced `StockProfile` row via `getOrFetchProfile` (DB-first,
 * stale-on-error — never throws). When Yahoo THREW and the DB row is ALSO empty
 * we return `success:false` with `metadata.sourceError` so the synthesizer can
 * tell "source down" from a genuine gap instead of a silent empty-success.
 */

import {
  yahooFetchQuoteSummary,
  withExchangeFallback,
} from "@usemoney/core/market-data";
import type { ResearchToolDef, ToolOutput } from "./types";
import type { CompanyProfile } from "../types";

/**
 * Map a `StockProfile` DB row (as returned by `getOrFetchProfile`) onto
 * `CompanyProfile`. Returns null when the row is null/absent or has no usable
 * name/sector/description, so an empty row never masquerades as a real fallback.
 */
export function dbRowToCompanyProfile(
  symbol: string,
  row: Record<string, unknown> | null | undefined,
): CompanyProfile | null {
  if (!row) return null;
  const name =
    typeof row.name === "string" && row.name.trim() ? row.name : undefined;
  const sector =
    typeof row.sector === "string" && row.sector.trim()
      ? row.sector
      : undefined;
  const description =
    typeof row.description === "string" && row.description.trim()
      ? row.description
      : undefined;
  // A row carrying none of these is not worth serving as a "profile".
  if (!name && !sector && !description) return null;

  return {
    symbol,
    name: name ?? symbol,
    sector: sector ?? "Unknown",
    industry:
      typeof row.industry === "string" && row.industry.trim()
        ? row.industry
        : "Unknown",
    description: description ?? "",
    website: typeof row.website === "string" ? row.website : undefined,
    employees: typeof row.employees === "number" ? row.employees : undefined,
    marketCap: typeof row.marketCap === "number" ? row.marketCap : undefined,
  };
}

/**
 * Yahoo quoteSummary seam — matches `yahooFetchQuoteSummary`'s shape including
 * its `onError` observer (MONEY-1060). Injectable so tests can exercise the
 * REAL swallow-path wiring: production `fetchQuoteSummary` NEVER throws (it
 * catches internally and returns null), so the observer is the only outage
 * signal — fakes should return null + call onError rather than throw.
 */
export type ProfileSummaryFetcher = (
  symbol: string,
  modules: string[],
  opts?: { onError?: (error: unknown, context?: string) => void },
) => Promise<Record<string, unknown> | null>;

/**
 * Live profile: Yahoo quoteSummary. Returns the mapped profile, or null when
 * Yahoo is reachable but empty. Throws the captured Yahoo error (whether
 * thrown OR reported via the onError observer — the production path, since
 * both `fetchQuoteSummary` and `withExchangeFallback` swallow) when no data
 * came back, so the caller can record `metadata.sourceError`. Exported with an
 * injectable seam so the wiring is testable against the SAME code `execute`
 * runs.
 */
export async function fetchLiveProfile(
  symbol: string,
  summaryFetch: ProfileSummaryFetcher = yahooFetchQuoteSummary,
): Promise<{ data: CompanyProfile } | null> {
  let yahooError: unknown;
  const capture = (e: unknown): void => {
    yahooError = yahooError ?? e;
  };
  const data = await withExchangeFallback(
    symbol,
    (s) =>
      summaryFetch(s, ["assetProfile", "summaryProfile", "price"], {
        onError: capture,
      }),
    { onError: capture },
  );

  if (!data) {
    // Empty BECAUSE a live source errored is an outage, not a genuine gap —
    // surface it so resolveCompanyProfile records metadata.sourceError.
    if (yahooError) throw yahooError;
    return null;
  }

  const assetProfile = data.assetProfile as Record<string, unknown> | undefined;
  const price = data.price as Record<string, unknown> | undefined;

  const profile: CompanyProfile = {
    symbol,
    name: (price?.longName as string) || (price?.shortName as string) || symbol,
    sector: (assetProfile?.sector as string) || "Unknown",
    industry: (assetProfile?.industry as string) || "Unknown",
    description: (assetProfile?.longBusinessSummary as string) || "",
    website: assetProfile?.website as string | undefined,
    employees: assetProfile?.fullTimeEmployees as number | undefined,
    marketCap: (price?.marketCap as Record<string, unknown>)?.raw as
      | number
      | undefined,
  };

  return { data: profile };
}

/**
 * Live-primary, DB-fallback resolution (MONEY-1060 RC3/RC4). Exported so the
 * fallback ordering/flagging is unit-testable against the SAME code `execute`
 * runs — inject a fake live fetch + `getOrFetchProfile` in tests.
 */
export async function resolveCompanyProfile(
  symbol: string,
  liveFetch: () => Promise<{ data: CompanyProfile } | null>,
  dbFetch: () => Promise<Record<string, unknown> | null>,
): Promise<ToolOutput> {
  let sourceError: string | undefined;
  try {
    const live = await liveFetch();
    if (live) return { success: true, data: live.data };
  } catch (err) {
    sourceError = err instanceof Error ? err.message : String(err);
  }

  // DB fallback: synced StockProfile (stale-on-error). getOrFetchProfile never
  // throws, but guard defensively so a DB blip can't mask the live sourceError.
  let dbRow: Record<string, unknown> | null = null;
  try {
    dbRow = await dbFetch();
  } catch {
    // ignore — treated as an empty DB fallback below
  }
  const dbProfile = dbRowToCompanyProfile(symbol, dbRow);
  if (dbProfile) {
    return {
      success: true,
      data: dbProfile,
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
    error: `Failed to fetch profile for ${symbol}${sourceError ? `: ${sourceError}` : ""}`,
    ...(sourceError ? { metadata: { sourceError } } : {}),
  };
}

export const fetchCompanyProfileTool: ResearchToolDef = {
  name: "fetch_company_profile",
  description:
    "Fetch company profile including sector, industry, description, and key info",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Yahoo Finance symbol (e.g., RELIANCE.NS)",
      required: true,
    },
  },
  cacheTTL: 86400, // 24h
  execute: async (params): Promise<ToolOutput> => {
    const symbol = params.symbol as string;
    if (!symbol) return { success: false, error: "symbol is required" };

    return resolveCompanyProfile(
      symbol,
      () => fetchLiveProfile(symbol),
      // Lazy import INSIDE the dbFetch thunk (MONEY-1060 fix 9, mirroring
      // fetch-peer-companies' fromDb): db-store imports @usemoney/database at
      // module top, which instantiates PrismaClient at module scope — loading
      // it BEFORE the live fetch made a Prisma-broken env kill the whole tool
      // where pre-PR live-only succeeded. resolveCompanyProfile try/catches
      // this thunk, so a Prisma module-load throw degrades to live-only.
      async () => {
        const { getOrFetchProfile } = await import("../data-sources/db-store");
        return getOrFetchProfile(symbol);
      },
    );
  },
};
