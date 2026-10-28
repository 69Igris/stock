import type { IDBCacheModule, IDBCacheTTL } from "./types";

/** Bump this when the entry schema changes to auto-discard stale entries */
export const CACHE_SCHEMA_VERSION = "1";

export const IDB_CACHE_TTL: Record<IDBCacheModule, IDBCacheTTL> = {
  discover: { fresh: 30 * 60, maxStale: 2 * 60 * 60 },
  "discover-mf": { fresh: 30 * 60, maxStale: 4 * 60 * 60 },
  "discover-indices": { fresh: 10 * 60, maxStale: 60 * 60 },
  "discover-etfs": { fresh: 10 * 60, maxStale: 60 * 60 },
  dashboard: { fresh: 2 * 60, maxStale: 15 * 60 },
  trades: { fresh: 3 * 60, maxStale: 30 * 60 },
  holdings: { fresh: 2 * 60, maxStale: 15 * 60 },
  "mutual-funds": { fresh: 5 * 60, maxStale: 30 * 60 },
  positions: { fresh: 1 * 60, maxStale: 10 * 60 },
  risk: { fresh: 5 * 60, maxStale: 30 * 60 },
  tax: { fresh: 30 * 60, maxStale: 4 * 60 * 60 },
  watchlist: { fresh: 5 * 60, maxStale: 30 * 60 },
  documents: { fresh: 5 * 60, maxStale: 30 * 60 },
  // Content pages - public, changes infrequently
  "content-blog": { fresh: 30 * 60, maxStale: 4 * 60 * 60 },
  "content-glossary": { fresh: 60 * 60, maxStale: 6 * 60 * 60 },
  "content-newsletter": { fresh: 30 * 60, maxStale: 4 * 60 * 60 },
  "content-docs": { fresh: 60 * 60, maxStale: 6 * 60 * 60 },
};
