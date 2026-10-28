/**
 * Market Ticker Store
 *
 * Polls /api/market/indices every 60s. Data persists across
 * component mount/unmount cycles via globalThis - the ticker
 * never flashes "Loading" after the first successful fetch.
 *
 * Usage:
 *   const { indices, marketStatus } = useMarketTickerStore();
 */

import { useEffect } from "react";
import { createStore, useStore, type StoreApi } from "zustand";

// ── Types ────────────────────────────────────────────────────────

type Market = "IN" | "US" | "MCX";
type MarketPhase = "PRE" | "OPEN" | "POST" | "CLOSED";

export interface IndexQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  market: Market;
}

export type MarketStatus = Record<Market, MarketPhase>;

export interface TickerState {
  indices: IndexQuote[];
  marketStatus: MarketStatus | null;
}

// ── Constants ────────────────────────────────────────────────────

const REFRESH_INTERVAL = 60_000;

// ── Reactive store (triggers re-renders) ─────────────────────────
// Only holds data that components need to render.
// Stored on globalThis so the cache survives HMR in dev mode.

const STORE_KEY = "__sb_ticker_store__";

function getStore(): StoreApi<TickerState> {
  const g = globalThis as Record<string, unknown>;
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = createStore<TickerState>()(() => ({
      indices: [],
      marketStatus: null,
    }));
  }
  return g[STORE_KEY] as StoreApi<TickerState>;
}

// ── Non-reactive polling internals ───────────────────────────────
// Kept outside Zustand so changes to fetchInFlight, subscriberCount
// etc. don't trigger component re-renders.

const POLL_KEY = "__sb_ticker_poll__";

interface PollState {
  interval: ReturnType<typeof setInterval> | null;
  subscriberCount: number;
  fetchInFlight: boolean;
  lastFetchAt: number;
}

function getPoll(): PollState {
  const g = globalThis as Record<string, unknown>;
  if (!g[POLL_KEY]) {
    g[POLL_KEY] = {
      interval: null,
      subscriberCount: 0,
      fetchInFlight: false,
      lastFetchAt: 0,
    };
  }
  return g[POLL_KEY] as PollState;
}

// ── Fetch logic ──────────────────────────────────────────────────

async function fetchIndices() {
  const poll = getPoll();

  if (poll.fetchInFlight) return;
  poll.fetchInFlight = true;

  try {
    const res = await fetch("/api/market/indices");
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.data) {
        getStore().setState({
          indices: data.data,
          marketStatus: data.marketStatus ?? null,
        });
        poll.lastFetchAt = Date.now();
      }
    } else if (res.status === 401 || res.status === 403) {
      // Auth-blocked responses are permanent for this auth state - never
      // retry on a short interval, the next 60 s tick will pick up any
      // sign-in change. This kills the 5 s flood that filled prod logs
      // for unauthenticated visitors when the endpoint was gated.
    } else if (getStore().getState().indices.length === 0) {
      // Other transient failures (5xx / timeout) - retry once after 5 s.
      // Don't keep retrying; the 60 s poll interval will take over.
      setTimeout(fetchIndices, 5_000);
    }
  } catch {
    // Silently fail - ticker is non-critical.
    // If store is empty, retry quickly so "Loading market data..." resolves sooner.
    if (getStore().getState().indices.length === 0) {
      setTimeout(fetchIndices, 5_000);
    }
  } finally {
    poll.fetchInFlight = false;
  }
}

// ── Polling lifecycle ────────────────────────────────────────────

function startPolling() {
  const poll = getPoll();
  if (poll.interval) return;

  const isStale =
    !poll.lastFetchAt || Date.now() - poll.lastFetchAt >= REFRESH_INTERVAL;
  if (getStore().getState().indices.length === 0 || isStale) {
    fetchIndices();
  }

  poll.interval = setInterval(fetchIndices, REFRESH_INTERVAL);
}

function stopPolling() {
  const poll = getPoll();
  if (poll.subscriberCount > 0) return;
  if (poll.interval) {
    clearInterval(poll.interval);
    poll.interval = null;
  }
}

// ── React hook ───────────────────────────────────────────────────

export function useMarketTickerStore(): TickerState {
  const store = getStore();

  // Manage polling lifecycle - starts on first subscriber, stops on last unmount.
  // Data in the Zustand store persists across these cycles.
  useEffect(() => {
    const poll = getPoll();
    poll.subscriberCount++;
    startPolling();

    return () => {
      poll.subscriberCount = Math.max(0, poll.subscriberCount - 1);
      if (poll.subscriberCount === 0) stopPolling();
    };
  }, []);

  return useStore(store);
}
