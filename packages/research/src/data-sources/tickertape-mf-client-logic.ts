/**
 * Tickertape mutual-fund client — pure response mappers (no network).
 *
 * Extracted from `tickertape-mf-client.ts` so the JSON → typed shaping for the
 * overview / holdings / peers endpoints and the search-result SID resolution
 * can be unit-tested by importing the REAL symbol. The live fetchers (which do
 * `ky` I/O + `cacheWrap`) import and call these.
 */

import type { MfOverview, MfHolding, MfPeer } from "./tickertape-mf-types";

/**
 * Pick the SID of the first mutual-fund match in a Tickertape `/search`
 * response, or `null` when there is no match.
 */
export function resolveSidFromSearch(
  resp:
    | {
        data?: { mutualfunds?: Array<{ sid: string; name: string }> };
      }
    | null
    | undefined,
): string | null {
  const match = resp?.data?.mutualfunds?.[0];
  return match ? match.sid : null;
}

/**
 * Map the raw `/mutual-funds/overview/:sid` payload into `MfOverview`, or
 * `null` for a falsy response. `resp.data` is preferred over the top-level
 * object; missing optional fields become `null`.
 */
export function mapMfOverview(
  sid: string,
  schemeCode: string,
  resp: Record<string, unknown> | null | undefined,
): MfOverview | null {
  if (!resp) return null;

  const data = (resp.data || resp) as Record<string, unknown>;
  const returns = (data.returns || {}) as Record<string, number>;

  return {
    sid,
    name: (data.name as string) || schemeCode,
    category: (data.category as string) || "",
    subCategory: (data.subCategory as string) || "",
    aum: (data.aum as number) || null,
    expenseRatio: (data.expenseRatio as number) || null,
    nav: (data.nav as number) || null,
    navDate: (data.navDate as string) || null,
    returns: {
      oneMonth: returns["1m"],
      threeMonth: returns["3m"],
      sixMonth: returns["6m"],
      oneYear: returns["1y"],
      threeYear: returns["3y"],
      fiveYear: returns["5y"],
    },
    riskRating: (data.riskRating as string) || null,
    exitLoad: (data.exitLoad as string) || null,
    minInvestment: (data.minInvestment as number) || null,
    rawData: data,
  };
}

/**
 * Map the raw `/mutual-funds/holdings/:sid` payload into `MfHolding[]`, or
 * `null` for a falsy response. Falls back from `resp.data` to `resp.holdings`.
 */
export function mapMfHoldings(
  resp: Record<string, unknown> | null | undefined,
): MfHolding[] | null {
  if (!resp) return null;

  const holdingsRaw = (resp.data || resp.holdings || []) as Array<
    Record<string, unknown>
  >;

  return holdingsRaw.map((h) => ({
    name: (h.name as string) || "",
    symbol: (h.ticker as string) || null,
    sector: (h.sector as string) || null,
    weight: (h.weight as number) || 0,
    value: (h.value as number) || null,
  }));
}

/**
 * Map the raw `/mutual-funds/peers/:sid` payload into `MfPeer[]`, or `null`
 * for a falsy response. Falls back from `resp.data` to `resp.peers`.
 */
export function mapMfPeers(
  resp: Record<string, unknown> | null | undefined,
): MfPeer[] | null {
  if (!resp) return null;

  const peersRaw = (resp.data || resp.peers || []) as Array<
    Record<string, unknown>
  >;

  return peersRaw.map((p) => ({
    sid: (p.sid as string) || "",
    name: (p.name as string) || "",
    category: (p.category as string) || "",
    returns1Y: (p.returns1Y as number) || null,
    returns3Y: (p.returns3Y as number) || null,
    aum: (p.aum as number) || null,
    expenseRatio: (p.expenseRatio as number) || null,
  }));
}
