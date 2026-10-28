"use client";

import { useCallback, useEffect, useState } from "react";
import { getWatchlistsAction } from "@/lib/actions/watchlist";
import type { WatchlistData } from "@usemoney/services";
import type { WatchlistKind } from "@/components/watchlist/WatchlistPopover";
import { countWatchlistMembership } from "@/lib/watchlist/membership-logic";

/**
 * How many watchlists each visible row already belongs to (MONEY-1253).
 *
 * The screener cards rendered "+ Watch" for everything on load, including
 * stocks sitting in three lists. Nothing was stale — `memberCount` initialised
 * to 0 and was only ever set by `WatchlistPopover.onMembershipChange`, which
 * fires when the popover OPENS. Membership was simply never fetched.
 *
 * ONE fetch, shared. `getWatchlistsAction` already returns every list with its
 * `items`, so the whole page's membership is derivable from a single call —
 * and it has to be, because the alternative is a request per card. The
 * screener has already been burned by exactly that: mounting a ResearchModal
 * per card "made the screener fan out a server action per card on every
 * refetch" (StockCardCompact). This page refetches on every filter change, so
 * 20-25 cards × one call each would be the same mistake wearing a different
 * hat.
 *
 * The cache is module-scoped rather than per-hook so that N cards mounting in
 * the same tick share ONE in-flight request instead of racing N of them.
 */

type Cache = {
  data: WatchlistData[] | null;
  /** In-flight request, so concurrent mounts await the same promise. */
  inflight: Promise<WatchlistData[]> | null;
  /** Bumped on every load so subscribers re-render with fresh data. */
  version: number;
  subscribers: Set<() => void>;
};

const cache: Cache = {
  data: null,
  inflight: null,
  version: 0,
  subscribers: new Set(),
};

function notify() {
  cache.version += 1;
  for (const fn of cache.subscribers) fn();
}

async function load(force = false): Promise<WatchlistData[]> {
  if (!force && cache.data) return cache.data;
  if (!force && cache.inflight) return cache.inflight;

  const p = (async () => {
    try {
      const res = await getWatchlistsAction();
      cache.data = res.success && res.data ? res.data : [];
    } catch {
      // Membership is decoration on a working page: a failed load must leave
      // the cards usable, showing "Watch" rather than breaking the screener.
      cache.data = [];
    } finally {
      cache.inflight = null;
    }
    notify();
    return cache.data;
  })();

  cache.inflight = p;
  return p;
}

export interface WatchlistMembership {
  /** Lists containing this symbol. 0 while loading, which renders "Watch". */
  countFor: (symbol: string, exchange: string, kind: WatchlistKind) => number;
  /** True until the first load settles, for callers that want to defer. */
  isLoading: boolean;
  /** Re-read after a mutation (the popover's add/remove). */
  refresh: () => Promise<void>;
}

export function useWatchlistMembership(): WatchlistMembership {
  const [, setTick] = useState(0);
  const [isLoading, setIsLoading] = useState(cache.data === null);

  useEffect(() => {
    const rerender = () => setTick((t) => t + 1);
    cache.subscribers.add(rerender);
    let cancelled = false;
    void load().then(() => {
      if (!cancelled) setIsLoading(false);
    });
    return () => {
      cancelled = true;
      cache.subscribers.delete(rerender);
    };
  }, []);

  const countFor = useCallback(
    (symbol: string, exchange: string, kind: WatchlistKind) => {
      // The rule lives in lib/watchlist/membership-logic so the hook and its
      // tests run the SAME code, and so it cannot drift from
      // WatchlistPopover.deriveLists — a divergence would make the closed
      // trigger contradict the popover it opens.
      return countWatchlistMembership(cache.data, symbol, exchange, kind);
    },
    // cache.version is read through the module object; the subscription above
    // drives re-renders, so no dependency is needed here.
    []
  );

  const refresh = useCallback(async () => {
    await load(true);
  }, []);

  return { countFor, isLoading, refresh };
}

/** Drop the cache — call after a mutation that changes list membership. */
export function invalidateWatchlistMembership(): void {
  cache.data = null;
  cache.inflight = null;
  void load(true);
}
