/**
 * Market Autocomplete — pure logic (no server-only deps).
 *
 * Extracted from `app/api/market/autocomplete/route.ts` so the query-param
 * parsing, the empty-query gate, the Atlas/contains/empty/error response
 * shapes, the contains-result mapping, and the source selection can be
 * unit-tested against the REAL exported symbols instead of inline copies.
 *
 * The route handler owns auth + HTTP + the Atlas/Prisma fan-out and imports
 * everything here. This module imports nothing server-only (no Clerk / Prisma /
 * Atlas), so the tests stay pure and exit cleanly.
 *
 * @see apps/web/__tests__/api/market-autocomplete.test.ts
 */

import { withFormerlyHint } from "@usemoney/core/market-data";

export interface AutocompleteResult {
  symbol: string;
  name: string;
  type: string;
  exchange: string;
}

export interface AutocompleteResponse {
  success: boolean;
  results: AutocompleteResult[];
  count?: number;
  source: string;
}

/** A row as returned by `searchInstruments` (contains-based fallback). */
export interface ContainsSearchResult {
  symbol: string;
  name: string;
  instrumentType: string;
  exchange: string;
  /** MONEY-1177 — former tickers, present when the row came from the DB. */
  previousSymbols?: string[];
}

/** Default page size when `limit` is absent / unparseable. */
export const DEFAULT_LIMIT = 8;
/** Hard upper bound on the autocomplete page size. */
export const MAX_LIMIT = 20;

/**
 * Parse the `q` query parameter, normalising a missing value to "".
 * Mirrors: `searchParams.get("q") || ""`.
 */
export function parseQuery(q: string | null): string {
  return q || "";
}

/**
 * Parse the `limit` query parameter: default 8, capped at 20.
 * Mirrors: `Math.min(parseInt(searchParams.get("limit") || "8", 10), 20)`.
 * A non-numeric value (`parseInt` → NaN) falls back to the default.
 */
export function parseLimit(limitStr: string | null): number {
  const parsed = parseInt(limitStr || String(DEFAULT_LIMIT), 10);
  if (Number.isNaN(parsed)) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

/**
 * Parse the `types` query parameter into a filter list, or undefined when no
 * non-empty type remains.
 * Mirrors: `searchParams.get("types")?.split(",").filter(Boolean) ?? undefined`.
 */
export function parseTypes(typesStr: string | null): string[] | undefined {
  if (!typesStr) return undefined;
  const parts = typesStr.split(",").filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

/**
 * Whether the query is too short to search (returns the empty response).
 * Mirrors: `!query || query.length < 1`.
 */
export function isQueryEmpty(query: string | null): boolean {
  return !query || query.length < 1;
}

/** The response returned for an empty/too-short query. */
export function formatEmptyResponse(): AutocompleteResponse {
  return {
    success: true,
    results: [],
    source: "empty",
  };
}

/** The response wrapping Atlas Search hits. */
export function formatAtlasResponse(
  results: AutocompleteResult[]
): AutocompleteResponse {
  return {
    success: true,
    results,
    count: results.length,
    source: "atlas",
  };
}

/** The response wrapping contains-based fallback hits. */
export function formatContainsResponse(
  results: AutocompleteResult[]
): AutocompleteResponse {
  return {
    success: true,
    results,
    count: results.length,
    source: "contains",
  };
}

/** The error envelope (`{ error }`). */
export function formatErrorResponse(message: string): { error: string } {
  return { error: message };
}

/**
 * Map a contains-search row to the lightweight autocomplete shape, renaming
 * `instrumentType` → `type`.
 */
export function mapContainsResult(
  r: ContainsSearchResult,
  query = ""
): AutocompleteResult {
  return {
    symbol: r.symbol,
    // MONEY-1177: when the hit came from a former ticker, say so. A user who
    // searched ZOMATO and got "Eternal Limited" back has no way to tell a
    // rename from a wrong result.
    name: withFormerlyHint(r.name, r.previousSymbols, query),
    type: r.instrumentType,
    exchange: r.exchange,
  };
}

/**
 * Map every contains-search row to the autocomplete shape.
 */
export function mapContainsResults(
  rows: ContainsSearchResult[],
  query = ""
): AutocompleteResult[] {
  return rows.map((r) => mapContainsResult(r, query));
}

/**
 * Should the route run the `contains` fallback after asking Atlas?
 *
 * MONEY-1205 — YES on an EMPTY array, not just on `null`. The route used to
 * treat "Atlas answered" as "Atlas found it", so an Atlas hit list of length 0
 * was served as a final, authoritative empty dropdown and the Prisma path — the
 * one the screener uses, which finds these rows fine — was never consulted.
 * That is how a four-token query ("Tata Consultancy Services Limited") returned
 * nothing at all from every `PfSymbolPicker` while the same string matched a
 * row that plainly exists. `null` means "Atlas is unavailable"; `[]` means
 * "Atlas has no answer" — both are reasons to ask the other backend, and only
 * one of them was handled.
 *
 * The cost is one extra Prisma query on a miss (bounded by `take: limit`, and
 * only on the queries that would otherwise return nothing), against an
 * autocomplete that currently answers a whole class of real queries with an
 * empty list.
 */
export function shouldFallbackToContains(
  atlasResults: AutocompleteResult[] | null
): boolean {
  return atlasResults === null || atlasResults.length === 0;
}

/**
 * Pick the response source: Atlas when its lookup returned rows, contains when
 * Atlas returned null (unavailable) OR an empty list (no answer) — in both of
 * those cases the route runs the `contains` fallback, so "contains" is what
 * actually produced the payload. See {@link shouldFallbackToContains}.
 */
export function selectSource(
  atlasResults: AutocompleteResult[] | null
): "atlas" | "contains" {
  return shouldFallbackToContains(atlasResults) ? "contains" : "atlas";
}
