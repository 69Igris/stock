"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useUser } from "@clerk/nextjs";
import {
  buildCacheKey,
  getCacheEntry,
  setCacheEntry,
  deleteCacheEntry,
  isIDBAvailable,
  IDB_CACHE_TTL,
} from "@/lib/idb-cache";
import type {
  IDBCacheOptions,
  IDBCacheResult,
  IDBCacheModule,
} from "@/lib/idb-cache";
import { withFetchRetry } from "@/lib/utils/retry";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

/**
 * In-flight dedup map - keyed by module+identifier.
 * Prevents duplicate server calls when multiple components mount simultaneously.
 */
const inflightRequests = new Map<string, Promise<unknown>>();

/** Check whether an entry's timestamp is within the "fresh" window */
function isFresh(timestamp: number, module: IDBCacheModule): boolean {
  const age = (Date.now() - timestamp) / 1000;
  return age <= IDB_CACHE_TTL[module].fresh;
}

/**
 * SWR hook backed by IndexedDB (L0 cache).
 *
 * - Within fresh TTL: serve from IDB, no server call
 * - Between fresh & maxStale: serve stale instantly, revalidate in background
 * - Beyond maxStale: blocking fetch (same as current behaviour)
 * - IDB unavailable: graceful fallback to direct fetch
 */
export function useIDBCache<T>(options: IDBCacheOptions<T>): IDBCacheResult<T> {
  const { module, identifier, filters, fetcher, initialData, skip } = options;
  const { user } = useUser();
  const userId = user?.id;
  // Hydration-safe demo detection (initial render = false, post-mount = real).
  // MONEY-1137: `{ user }` gates the stale-localStorage signal. The `userId ||`
  // below already masked the bug here (a real id wins), but leaving the hook
  // ungated meant this file kept modelling the unsafe call as normal.
  const demoMode = useIsDemoMode({ user });
  const effectiveUserId = userId || (demoMode ? "demo" : undefined);

  const [data, setData] = useState<T | null>(initialData ?? null);
  const [isLoading, setIsLoading] = useState(!initialData);
  const [isRevalidating, setIsRevalidating] = useState(false);
  const [isStale, setIsStale] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Stable refs so callbacks don't re-trigger effects
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const cacheKey = buildCacheKey(module, identifier, filters);
  const dedupeKey = `${module}:${identifier}`;

  /** Core fetch-and-cache logic */
  const fetchFromServer = useCallback(
    async (uid: string, key: string): Promise<T> => {
      // Dedup in-flight requests
      const existing = inflightRequests.get(dedupeKey);
      if (existing) return existing as Promise<T>;

      // Wrap fetcher with retry so transient browser network errors
      // (TypeError: Failed to fetch) don't surface as unhandled rejections.
      const promise = withFetchRetry(() => fetcherRef.current()).then(
        async (freshData) => {
          // Write to IDB for future navigations
          await setCacheEntry(uid, key, module, freshData);
          return freshData;
        }
      );

      inflightRequests.set(dedupeKey, promise);
      try {
        return await promise;
      } finally {
        inflightRequests.delete(dedupeKey);
      }
    },
    [module, dedupeKey]
  );

  /** Main effect: load from IDB → decide fresh/stale/miss → maybe revalidate */
  useEffect(() => {
    if (skip || !effectiveUserId) {
      // Don't leave isLoading=true when we can't fetch
      if (!initialData) setIsLoading(false);
      return;
    }

    let cancelled = false;

    async function run() {
      const uid = effectiveUserId as string;
      const key = buildCacheKey(module, identifier, filtersRef.current);

      // 1. Try IDB
      if (isIDBAvailable()) {
        const cached = await getCacheEntry<T>(uid, key, module);

        if (cached) {
          if (!cancelled) {
            setData(cached.data);
            setError(null);
          }

          if (isFresh(cached.timestamp, module)) {
            // Fresh - done
            if (!cancelled) {
              setIsLoading(false);
              setIsStale(false);
            }
            return;
          }

          // Stale but still within maxStale - serve stale, revalidate in background
          if (!cancelled) {
            setIsLoading(false);
            setIsStale(true);
            setIsRevalidating(true);
          }

          try {
            const freshData = await fetchFromServer(uid, key);
            if (!cancelled) {
              setData(freshData);
              setIsStale(false);
              setError(null);
            }
          } catch (err) {
            // Keep stale data, swallow error
            if (!cancelled)
              setError(err instanceof Error ? err : new Error(String(err)));
          } finally {
            if (!cancelled) setIsRevalidating(false);
          }
          return;
        }
      }

      // 2. Cache miss - blocking fetch
      if (!cancelled) setIsLoading(true);
      try {
        const freshData = await fetchFromServer(
          uid,
          buildCacheKey(module, identifier, filtersRef.current)
        );
        if (!cancelled) {
          setData(freshData);
          setIsStale(false);
          setError(null);
        }
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    // If we have initialData from SSR, adopt it and skip the mount fetch.
    //
    // MONEY-1126: this whole branch used to be gated on `isIDBAvailable()`, so
    // a browser without IndexedDB (private/incognito modes, some in-app
    // webviews, storage-partitioned iframes) fell straight through to `run()`
    // and re-fetched data the server had ALREADY shipped in the HTML — the
    // exact round trip the SSR warm-load exists to remove, silently un-done for
    // the users on the worst connections. Persisting to IDB is a best-effort
    // side effect of having the data; it is not a precondition for using it.
    if (initialData) {
      if (isIDBAvailable()) {
        const key = buildCacheKey(module, identifier, filtersRef.current);
        setCacheEntry(effectiveUserId, key, module, initialData).catch(
          () => {}
        );
      }

      setData(initialData);
      setIsLoading(false);
      return;
    }

    run();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveUserId, cacheKey, module, identifier, skip, fetchFromServer]);

  /** Manual refresh - bypasses cache completely */
  const refresh = useCallback(async () => {
    if (!effectiveUserId) return;
    const key = buildCacheKey(module, identifier, filtersRef.current);
    setIsRevalidating(true);
    setError(null);
    try {
      const freshData = await fetcherRef.current();
      await setCacheEntry(effectiveUserId, key, module, freshData);
      setData(freshData);
      setIsStale(false);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsRevalidating(false);
    }
  }, [effectiveUserId, module, identifier]);

  /** Delete specific cache entry */
  const invalidate = useCallback(async () => {
    if (!effectiveUserId) return;
    const key = buildCacheKey(module, identifier, filtersRef.current);
    await deleteCacheEntry(effectiveUserId, key);
  }, [effectiveUserId, module, identifier]);

  return {
    data,
    isLoading,
    isRevalidating,
    isStale,
    error,
    refresh,
    invalidate,
  };
}
