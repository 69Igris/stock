/**
 * Staleness Configuration for Persistent Market Data
 *
 * Defines how long each data type stays fresh before requiring re-fetch.
 * Used by the DB-first data access layer (db-store.ts).
 */

export interface StalenessConfig {
  /** Maximum age in milliseconds before data is considered stale */
  maxAgeMs: number;
  /** Human-readable label */
  label: string;
}

/** Staleness thresholds by data type */
export const STALENESS: Record<string, StalenessConfig> = {
  financials_annual: {
    maxAgeMs: 90 * 24 * 60 * 60 * 1000, // 90 days
    label: "Annual financials",
  },
  financials_quarterly: {
    maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    label: "Quarterly financials",
  },
  ratios: {
    maxAgeMs: 24 * 60 * 60 * 1000, // 24 hours
    label: "Key ratios",
  },
  peers: {
    maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    label: "Peer comparison",
  },
  shareholding: {
    maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    label: "Shareholding pattern",
  },
  news: {
    maxAgeMs: 30 * 60 * 1000, // 30 minutes
    label: "News articles",
  },
  profile: {
    maxAgeMs: 90 * 24 * 60 * 60 * 1000, // 90 days
    label: "Company profile",
  },
  // Stock document staleness (per doc type)
  stock_documents: {
    maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days default
    label: "Stock documents (filings/reports)",
  },
  stock_docs_financial: {
    maxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days - quarterly data changes often
    label: "Financial statement documents",
  },
  stock_docs_quarterly: {
    maxAgeMs: 30 * 24 * 60 * 60 * 1000, // 30 days
    label: "Quarterly result filings",
  },
  stock_docs_annual: {
    maxAgeMs: 90 * 24 * 60 * 60 * 1000, // 90 days
    label: "Annual report filings",
  },
};

// A SECOND `SyncTier` lived here — `"hot" | "warm" | "cold"` with a
// `SYNC_TIERS` config table — and it was DELETED by MONEY-1238.
//
// It contradicted the live definition in `sync-tiers.ts`, which is TWO tiers
// (`"hot" | "warm"`) and is what `events-sync.ts` actually runs on. Nothing
// in production ever imported this one; it was not even exported through the
// market-data barrel. Its ONLY importer was a test asserting it had three
// tiers — which lent a dead table the appearance of being enforced, and would
// have sent anyone reading it to the wrong tiering scheme.
//
// `STALENESS` and `isStale` above are LIVE (imported by
// `packages/research/src/data-sources/{db-store,stock-document-fetcher}.ts`)
// and stay.

/**
 * Check if data fetched at `fetchedAt` is stale based on threshold key
 */
export function isStale(
  fetchedAt: Date | null | undefined,
  thresholdKey: string,
): boolean {
  if (!fetchedAt) return true;
  const config = STALENESS[thresholdKey];
  if (!config) return true;
  return Date.now() - fetchedAt.getTime() > config.maxAgeMs;
}
