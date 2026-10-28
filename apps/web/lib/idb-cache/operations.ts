import { getDB, STORE_NAME, isIDBAvailable } from "./db";
import { CACHE_SCHEMA_VERSION, IDB_CACHE_TTL } from "./config";
import type { IDBCacheEntry, IDBCacheModule } from "./types";

/** Build composite cache key */
export function buildCacheKey(
  module: string,
  identifier: string,
  filters?: Record<string, unknown>
): string {
  const filterHash = filters ? stableHash(filters) : "";
  return filterHash
    ? `${module}:${identifier}:${filterHash}`
    : `${module}:${identifier}`;
}

/** Deterministic JSON hash of filter object */
function stableHash(obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj)
    .sort()
    .reduce(
      (acc, k) => {
        const v = obj[k];
        if (v !== undefined && v !== null && v !== "") acc[k] = v;
        return acc;
      },
      {} as Record<string, unknown>
    );
  if (Object.keys(sorted).length === 0) return "";
  // Simple string hash - no crypto needed
  const str = JSON.stringify(sorted);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Read a cache entry. Returns null if missing, expired beyond maxStale, or wrong version. */
export async function getCacheEntry<T>(
  userId: string,
  key: string,
  module: IDBCacheModule
): Promise<IDBCacheEntry<T> | null> {
  if (!isIDBAvailable()) return null;
  try {
    const db = await getDB(userId);
    const entry = (await db.get(STORE_NAME, key)) as
      | IDBCacheEntry<T>
      | undefined;
    if (!entry) return null;

    // Version mismatch - discard
    if (entry.version !== CACHE_SCHEMA_VERSION) {
      await db.delete(STORE_NAME, key);
      return null;
    }

    // Beyond maxStale - discard
    const ttlConfig = IDB_CACHE_TTL[module];
    const age = (Date.now() - entry.timestamp) / 1000;
    if (age > ttlConfig.maxStale) {
      await db.delete(STORE_NAME, key);
      return null;
    }

    return entry;
  } catch {
    return null;
  }
}

/** Write a cache entry. */
export async function setCacheEntry<T>(
  userId: string,
  key: string,
  module: IDBCacheModule,
  data: T
): Promise<void> {
  if (!isIDBAvailable()) return;
  try {
    const db = await getDB(userId);
    const ttlConfig = IDB_CACHE_TTL[module];
    const entry: IDBCacheEntry<T> = {
      key,
      data,
      timestamp: Date.now(),
      ttl: ttlConfig.fresh,
      module,
      version: CACHE_SCHEMA_VERSION,
    };
    await db.put(STORE_NAME, entry as IDBCacheEntry);
  } catch {
    // Silently fail - IDB write errors are non-critical
  }
}

/** Delete a specific cache entry. */
export async function deleteCacheEntry(
  userId: string,
  key: string
): Promise<void> {
  if (!isIDBAvailable()) return;
  try {
    const db = await getDB(userId);
    await db.delete(STORE_NAME, key);
  } catch {
    // ignore
  }
}

/** Delete all entries for a given module (bulk invalidation). */
export async function clearModule(
  userId: string,
  module: IDBCacheModule
): Promise<void> {
  if (!isIDBAvailable()) return;
  try {
    const db = await getDB(userId);
    const tx = db.transaction(STORE_NAME, "readwrite");
    const index = tx.store.index("by-module");
    let cursor = await index.openCursor(IDBKeyRange.only(module));
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  } catch {
    // ignore
  }
}

/** Remove entries past their maxStale age (garbage collection). */
export async function gcExpiredEntries(userId: string): Promise<number> {
  if (!isIDBAvailable()) return 0;
  try {
    const db = await getDB(userId);
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.store;
    let cursor = await store.openCursor();
    let removed = 0;

    while (cursor) {
      const entry = cursor.value as IDBCacheEntry;
      // Version mismatch or expired
      if (entry.version !== CACHE_SCHEMA_VERSION) {
        await cursor.delete();
        removed++;
      } else {
        const ttlConfig = IDB_CACHE_TTL[entry.module];
        if (ttlConfig) {
          const age = (Date.now() - entry.timestamp) / 1000;
          if (age > ttlConfig.maxStale) {
            await cursor.delete();
            removed++;
          }
        }
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return removed;
  } catch {
    return 0;
  }
}
