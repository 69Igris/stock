/** Module identifiers for IDB cache - each maps to a TTL config */
export type IDBCacheModule =
  | "discover"
  | "discover-mf"
  | "discover-indices"
  | "discover-etfs"
  | "dashboard"
  | "trades"
  | "holdings"
  | "mutual-funds"
  | "positions"
  | "risk"
  | "tax"
  | "watchlist"
  | "documents"
  | "content-blog"
  | "content-glossary"
  | "content-newsletter"
  | "content-docs";

/** TTL configuration per module (seconds) */
export interface IDBCacheTTL {
  /** Data is considered fresh within this window - no server call made */
  fresh: number;
  /** Data older than maxStale is discarded, triggers blocking fetch */
  maxStale: number;
}

/** Shape of a single entry stored in IndexedDB */
export interface IDBCacheEntry<T = unknown> {
  /** Composite key: `{module}:{identifier}:{filterHash}` */
  key: string;
  data: T;
  timestamp: number;
  ttl: number;
  module: IDBCacheModule;
  version: string;
}

/** Options passed to the useIDBCache hook */
export interface IDBCacheOptions<T> {
  module: IDBCacheModule;
  identifier: string;
  filters?: Record<string, unknown>;
  fetcher: () => Promise<T>;
  initialData?: T | null;
  skip?: boolean;
}

/** Return value of the useIDBCache hook */
export interface IDBCacheResult<T> {
  data: T | null;
  isLoading: boolean;
  isRevalidating: boolean;
  isStale: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
  invalidate: () => Promise<void>;
}
