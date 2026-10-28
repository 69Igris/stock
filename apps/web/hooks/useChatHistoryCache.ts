/**
 * Client-Side Chat History Cache
 *
 * Three-tier read path:
 *   1. IndexedDB (instant) - survives navigation, refresh, tab close
 *   2. Stale-while-revalidate against server action (Redis-backed)
 *   3. Fresh fetch on cache miss
 *
 * Refresh signals (via BroadcastChannel - cross-tab + same-tab):
 *   - `chat-created`  → clear IDB + refetch (new chat in any tab)
 *   - `chat-mutated`  → clear IDB + refetch (archive/delete/rename)
 *   - `chat-opened`   → background revalidate (no UI clear, no lag)
 *
 * Pagination (MONEY-392):
 *   - First page is `PAGE_SIZE` (25) chats. IDB caches the first page only.
 *   - `loadMore()` fetches additional pages directly from the server (skip
 *     based on current length) and appends; not cached in IDB. `hasMore`
 *     is derived from `totalCount` vs `chats.length`.
 */

import { useState, useCallback, useRef, useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import {
  listChatHistoriesAction,
  type ChatHistoryRecord,
} from "@/lib/actions/chat-history";
import {
  idbGet,
  idbSet,
  idbClearForUser,
  buildKey,
} from "@/lib/chat-history/idb-cache";
import { SIDE_CHAT_PAGE_PATHS } from "@/lib/chat-history/side-chat-scopes";
import { subscribeChatHistoryEvents } from "@/lib/chat-history/event-bus";
import { useIsDemoMode } from "@/lib/hooks/useIsDemoMode";

const FRESH_TTL_MS = 30_000; // 30 seconds - within this window, no network
const PAGE_SIZE = 25;

interface UseChatHistoryCacheOptions {
  isArchived: boolean;
  searchQuery: string;
}

interface UseChatHistoryCacheReturn {
  chats: ChatHistoryRecord[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  fetch: () => Promise<void>;
  loadMore: () => Promise<void>;
  invalidate: () => void;
  setChats: React.Dispatch<React.SetStateAction<ChatHistoryRecord[]>>;
}

export function useChatHistoryCache({
  isArchived,
  searchQuery,
}: UseChatHistoryCacheOptions): UseChatHistoryCacheReturn {
  const { user } = useUser();
  // Demo mode: no Clerk user, but `tradebook_demo_mode` localStorage flag
  // is set by the demo-start flow. Server action `listChatHistoriesAction`
  // already routes to `demoChatHistories` via `isDemoSession()` (HMAC
  // cookie), so we just need a non-null id here to unblock the fetch and
  // the IDB cacheKey. Pattern matches `useIDBCache`. The hook keeps SSR/
  // first-paint in sync — initial render returns `false`, deferred read
  // flips to `true` post-mount.
  // MONEY-1137: `{ user }` gates the stale-localStorage signal. The `??` below
  // already masked the bug (a real id wins), but the ungated call still had to
  // go — see the note on `UseIsDemoModeOptions.user`.
  const demoMode = useIsDemoMode({ user });
  const userId = user?.id ?? (demoMode ? "demo" : null);

  const [chats, setChats] = useState<ChatHistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const revalidatingRef = useRef(false);
  // Track current pagination depth so `loadMore` knows where to skip from.
  // Use the actual chats length as the source of truth - `setChats` updates
  // are batched but the underlying state is what we always page off of.
  const chatsLengthRef = useRef(0);

  useEffect(() => {
    chatsLengthRef.current = chats.length;
  }, [chats.length]);

  const cacheKey = userId ? buildKey(userId, isArchived, searchQuery) : null;

  const fetchFromServer = useCallback(async () => {
    if (!userId || !cacheKey) return;
    try {
      const result = await listChatHistoriesAction({
        excludePagePaths: SIDE_CHAT_PAGE_PATHS,
        isArchived,
        sortBy: "lastMessage",
        order: "desc",
        skip: 0,
        limit: PAGE_SIZE,
        searchQuery: searchQuery || undefined,
      });
      if (result.success && result.data) {
        const newData = result.data.chats;
        await idbSet(cacheKey, userId, newData, result.data.totalCount);
        setChats(newData);
        setTotalCount(result.data.totalCount);
      }
    } catch {
      // Silently fail - stale data is better than nothing
    } finally {
      setLoading(false);
      revalidatingRef.current = false;
    }
  }, [isArchived, searchQuery, userId, cacheKey]);

  const fetch = useCallback(async () => {
    if (!cacheKey) {
      // No user yet - wait for Clerk to hydrate
      setLoading(true);
      return;
    }

    const entry = await idbGet(cacheKey);

    if (entry) {
      setChats(entry.data);
      setTotalCount(entry.totalCount ?? entry.data.length);
      setLoading(false);

      const age = Date.now() - entry.timestamp;
      if (age >= FRESH_TTL_MS && !revalidatingRef.current) {
        revalidatingRef.current = true;
        fetchFromServer();
      }
      return;
    }

    // No cache - fetch from server
    setLoading(true);
    await fetchFromServer();
  }, [cacheKey, fetchFromServer]);

  // Use a ref for the in-flight flag so loadMore can be guarded without
  // re-creating its identity on every state change (which was causing the
  // IntersectionObserver effect to re-mount in a loop).
  const loadingMoreRef = useRef(false);

  const loadMore = useCallback(async () => {
    if (!userId) return;
    if (loadingMoreRef.current) return;
    const currentLen = chatsLengthRef.current;
    if (totalCount > 0 && currentLen >= totalCount) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await listChatHistoriesAction({
        excludePagePaths: SIDE_CHAT_PAGE_PATHS,
        isArchived,
        sortBy: "lastMessage",
        order: "desc",
        skip: currentLen,
        limit: PAGE_SIZE,
        searchQuery: searchQuery || undefined,
      });
      if (result.success && result.data) {
        const fetched = result.data.chats;
        // Defensive de-dupe by id - race conditions across event-bus
        // refetches can otherwise inject duplicates.
        let appendedCount = 0;
        setChats((prev) => {
          const seenIds = new Set(prev.map((c) => c.id));
          const next = [...prev];
          for (const c of fetched) {
            if (!seenIds.has(c.id)) {
              seenIds.add(c.id);
              next.push(c);
              appendedCount++;
            }
          }
          return next;
        });
        // No progress = server is empty for this skip; lock hasMore to
        // false by pinning totalCount to the current length. Prevents
        // the IntersectionObserver from looping when an empty page is
        // returned mid-list.
        if (appendedCount === 0) {
          setTotalCount(currentLen);
        } else {
          // Server may report a fresher totalCount (e.g. new chats
          // created between the first page and now). Pick max of the
          // server count and what we now hold so hasMore stays right.
          setTotalCount(
            Math.max(result.data.totalCount, currentLen + appendedCount)
          );
        }
      } else {
        // Action failed - don't retry on the next observer fire by
        // pinning totalCount to current length. User can refresh to
        // try again.
        setTotalCount(currentLen);
      }
    } catch {
      // Same - pin to current length so the observer stops firing.
      setTotalCount(chatsLengthRef.current);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [userId, totalCount, isArchived, searchQuery]);

  const invalidate = useCallback(() => {
    if (!userId) return;
    // Clear all cache entries for this user (active + archived + all queries)
    // so the next read is authoritative.
    void idbClearForUser(userId);
    // MONEY-650 (B4): stale-while-revalidate — do NOT blank `chats` to [] here.
    // Clearing made the sidebar flash its empty "No conversations yet" state on
    // every new-chat / mutation: when a research run creates a chat it bumps
    // `currentChatId`, whose effect calls invalidate(), which wiped the list to
    // [] until the refetch returned. Keep the current list visible and let
    // fetchFromServer() swap in fresh data in place (same approach as the
    // `chat-opened` background revalidate). Guarded so overlapping invalidate
    // signals (currentChatId effect + chat-created event) coalesce into one
    // fetch instead of stacking.
    if (!revalidatingRef.current) {
      revalidatingRef.current = true;
      void fetchFromServer();
    }
  }, [userId, fetchFromServer]);

  // Auto-fetch when dependencies change (incl. user becoming available)
  useEffect(() => {
    void fetch();
  }, [fetch]);

  // Cross-tab + same-tab event bus
  useEffect(() => {
    const unsub = subscribeChatHistoryEvents((event) => {
      if (event.type === "chat-created" || event.type === "chat-mutated") {
        invalidate();
      } else if (event.type === "chat-opened") {
        // Background revalidate without clearing - UI keeps showing what
        // it has; we update silently if the server returns different data.
        if (!revalidatingRef.current) {
          revalidatingRef.current = true;
          fetchFromServer();
        }
      }
    });
    return unsub;
  }, [invalidate, fetchFromServer]);

  const hasMore = totalCount > 0 && chats.length < totalCount;

  return {
    chats,
    loading,
    loadingMore,
    hasMore,
    fetch,
    loadMore,
    invalidate,
    setChats,
  };
}
