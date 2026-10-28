/**
 * Fetch Peer Companies - NSE → Tickertape → Screener.in → DB fallback chain.
 *
 * NSE's corporate-peer-comparison endpoint blocks bot/IP traffic frequently
 * (the public API rate-limits aggressively). Tickertape's /stocks/peers/{sid}
 * is usually next, but its response can also be empty for less-covered
 * symbols. Screener.in is the last-resort scrape; it parses the company
 * page and picks peers from the comparison table.
 *
 * RELIANCE (the most-traded stock in India) was returning empty in
 * production because both NSE and Tickertape failed in tandem - adding
 * Screener as a third tier means we always return something for the
 * Nifty 50.
 *
 * MONEY-1060 (RC3/RC4): when EVERY live source is unreachable/empty we now fall
 * back to the synced `StockPeers` row via `getOrFetchPeers` (DB-first,
 * stale-on-error). A provider that THROWS (source down) — vs one that returns
 * `[]` (reachable-but-empty) — is recorded so a total miss reports
 * `metadata.sourceError`, letting the synthesizer tell "source down" from a
 * genuine gap instead of a silent empty result.
 */

import { getNseClient } from "../data-sources/nse-client";
import { toNseSymbol } from "../data-sources/symbol-resolver";
import { fetchTickertapePeers } from "../data-sources/tickertape-client";
import { fetchScreenerPeers } from "../data-sources/screener-client";
import type { NsePeerComparisonResponse } from "../data-sources/nse-types";
import type { ResearchToolDef, ToolOutput } from "./types";
import type { NsePeerData } from "../types";

async function fromNse(symbol: string): Promise<NsePeerData[] | null> {
  // No internal try/catch: a thrown NSE error (the common IP-block case)
  // propagates to runPeerFallbackChain, which records it as a sourceError and
  // moves on to the next provider (MONEY-1060).
  const client = getNseClient();
  const raw = await client.getPeerComparison(symbol);
  if (!raw) return null;
  const response = raw as NsePeerComparisonResponse;
  const peers: NsePeerData[] = (response.data || []).map((p) => ({
    symbol: p.symbol,
    companyName: p.companyName,
    pe: p["P/E"] || 0,
    pb: p["P/B"] || 0,
    marketCap: p.marketCap || 0,
    sectorPe: p.sectorPe,
  }));
  return peers.length > 0 ? peers : null;
}

async function fromTickertape(symbol: string): Promise<NsePeerData[] | null> {
  const peers = await fetchTickertapePeers(symbol);
  if (!peers || peers.length === 0) return null;
  return peers.map((p) => ({
    symbol: p.ticker,
    companyName: p.name,
    pe: typeof p.pe === "number" ? p.pe : 0,
    pb: typeof p.pb === "number" ? p.pb : 0,
    marketCap: typeof p.marketCap === "number" ? p.marketCap : 0,
    sectorPe: undefined,
  }));
}

async function fromScreener(symbol: string): Promise<NsePeerData[] | null> {
  const peers = await fetchScreenerPeers(symbol);
  if (!peers || peers.length === 0) return null;
  return peers.map((p) => ({
    symbol: p.symbol,
    companyName: p.name,
    pe: typeof p.pe === "number" ? p.pe : 0,
    // Screener exposes ROE/ROCE on the peer row but not P/B; leave 0
    // so downstream UIs can decide whether to render the column.
    pb: 0,
    marketCap: typeof p.marketCap === "number" ? p.marketCap : 0,
    sectorPe: undefined,
  }));
}

/**
 * Map peer rows persisted on `StockPeers` (Tickertape shape: `{ ticker, name,
 * pe, pb, marketCap }`) onto `NsePeerData`. Exported so the DB-fallback mapping
 * is unit-testable without a database. Returns null when there is nothing usable.
 */
export function mapDbPeers(
  rows: Array<Record<string, unknown>> | null | undefined,
): NsePeerData[] | null {
  if (!rows || rows.length === 0) return null;
  const mapped = rows
    .map((p) => {
      const symbolRaw = p.ticker ?? p.symbol;
      const nameRaw = p.name ?? p.companyName;
      return {
        symbol: typeof symbolRaw === "string" ? symbolRaw : "",
        companyName: typeof nameRaw === "string" ? nameRaw : "",
        pe: typeof p.pe === "number" ? p.pe : 0,
        pb: typeof p.pb === "number" ? p.pb : 0,
        marketCap: typeof p.marketCap === "number" ? p.marketCap : 0,
        sectorPe: typeof p.sectorPe === "number" ? p.sectorPe : undefined,
      };
    })
    .filter((p) => p.symbol.length > 0);
  return mapped.length > 0 ? mapped : null;
}

async function fromDb(symbol: string): Promise<NsePeerData[] | null> {
  // Lazy import: db-store loads Prisma at module top, which can't be loaded
  // under the plain node test runner — keep it out of the module graph.
  const { getOrFetchPeers } = await import("../data-sources/db-store");
  const peers = await getOrFetchPeers(symbol);
  return mapDbPeers(peers);
}

export type PeerSource = "nse" | "tickertape" | "screener" | "db";

export interface PeerChainProvider {
  source: PeerSource;
  fetch: () => Promise<NsePeerData[] | null>;
}

export interface PeerChainResult {
  success: boolean;
  data?: NsePeerData[];
  error?: string;
  metadata: { source?: PeerSource; fallback?: boolean; sourceError?: string };
}

/**
 * Walk the peer providers in order and take the FIRST one that returns a
 * non-empty array. `fallback` is true when a provider other than the first
 * succeeds. A provider returning `[]` (HTTP 200 with an empty `peers` array —
 * the exact failure mode that bit RELIANCE in prod) is treated as a miss, not
 * a success, so the chain continues.
 *
 * A provider that THROWS (source unreachable/timeout) is caught, recorded, and
 * skipped so the chain keeps trying later tiers; if the chain ultimately fails,
 * the collected errors surface as `metadata.sourceError` (MONEY-1060 RC4) so
 * "source down" is distinguishable from a genuine "no peers" gap.
 *
 * Extracted (MONEY-620) so the fallback ordering/flagging is unit-testable
 * against the SAME code the tool runs — `execute` below calls this directly.
 */
export async function runPeerFallbackChain(
  providers: PeerChainProvider[],
  symbol: string,
): Promise<PeerChainResult> {
  const sourceErrors: string[] = [];
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]!;
    try {
      const data = await provider.fetch();
      if (data && data.length > 0) {
        return {
          success: true,
          data,
          metadata: { source: provider.source, fallback: i > 0 },
        };
      }
    } catch (err) {
      sourceErrors.push(
        `${provider.source}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return {
    success: false,
    error: `No peer data found for ${symbol} (NSE, Tickertape, Screener, DB all returned empty)`,
    metadata:
      sourceErrors.length > 0 ? { sourceError: sourceErrors.join("; ") } : {},
  };
}

export const fetchPeerCompaniesTool: ResearchToolDef = {
  name: "fetch_peer_companies",
  description:
    "Fetch peer companies with comparative metrics (NSE → Tickertape → Screener → DB)",
  category: "data",
  parameters: {
    symbol: {
      type: "string",
      description: "Stock symbol (e.g., RELIANCE or RELIANCE.NS)",
      required: true,
    },
  },
  cacheTTL: 86400, // 24h
  execute: async (params): Promise<ToolOutput> => {
    const rawSymbol = params.symbol as string;
    const nseSymbol = toNseSymbol(rawSymbol);
    if (!nseSymbol) return { success: false, error: "symbol is required" };

    // NSE first (richer data, sector P/E) → Tickertape → Screener.in scrape →
    // synced StockPeers (DB-first, stale-on-error) as the offline-safe fallback.
    const result = await runPeerFallbackChain(
      [
        { source: "nse", fetch: () => fromNse(nseSymbol) },
        { source: "tickertape", fetch: () => fromTickertape(rawSymbol) },
        { source: "screener", fetch: () => fromScreener(rawSymbol) },
        { source: "db", fetch: () => fromDb(rawSymbol) },
      ],
      nseSymbol,
    );

    if (result.success) {
      return { success: true, data: result.data, metadata: result.metadata };
    }
    return {
      success: false,
      error: result.error,
      ...(result.metadata.sourceError
        ? { metadata: { sourceError: result.metadata.sourceError } }
        : {}),
    };
  },
};
