/**
 * Market Ticker Store Tests
 *
 * Tests for the Zustand-based market ticker store including:
 * - globalThis store singleton lifecycle
 * - Polling lifecycle (start/stop/subscriber counting)
 * - Fetch deduplication (fetchInFlight guard)
 * - Data persistence across subscriber cycles
 * - Stale data detection
 *
 * Source: apps/web/lib/stores/market-ticker.ts
 *
 * Note: We inline the pure logic here since the source imports
 * React hooks and Zustand, which require a browser/jsdom environment.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ── Types (mirrored from source) ─────────────────────────────────

type Market = "IN" | "US" | "MCX";
type MarketPhase = "PRE" | "OPEN" | "POST" | "CLOSED";

interface IndexQuote {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePercent: number;
  market: Market;
}

type MarketStatus = Record<Market, MarketPhase>;

interface TickerState {
  indices: IndexQuote[];
  marketStatus: MarketStatus | null;
}

// ── Inlined Store Logic ──────────────────────────────────────────
// Simplified versions of the globalThis patterns used in the source.
// We can't use Zustand directly in node:test, so we test the patterns.

const STORE_KEY = "__sb_ticker_store_test__";
const POLL_KEY = "__sb_ticker_poll_test__";

interface PollState {
  interval: ReturnType<typeof setInterval> | null;
  subscriberCount: number;
  fetchInFlight: boolean;
  lastFetchAt: number;
}

function getStore(): {
  state: TickerState;
  setState: (s: Partial<TickerState>) => void;
  getState: () => TickerState;
} {
  const g = globalThis as Record<string, unknown>;
  if (!g[STORE_KEY]) {
    const state: TickerState = { indices: [], marketStatus: null };
    g[STORE_KEY] = {
      state,
      setState: (partial: Partial<TickerState>) => {
        Object.assign(state, partial);
      },
      getState: () => state,
    };
  }
  return g[STORE_KEY] as ReturnType<typeof getStore>;
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

const REFRESH_INTERVAL = 60_000;

// ── Tests ────────────────────────────────────────────────────────

describe("Market Ticker Store", () => {
  beforeEach(() => {
    // Clean globalThis singletons before each test
    delete (globalThis as Record<string, unknown>)[STORE_KEY];
    delete (globalThis as Record<string, unknown>)[POLL_KEY];
  });

  afterEach(() => {
    // Ensure intervals are cleaned up
    const poll = getPoll();
    if (poll.interval) {
      clearInterval(poll.interval);
      poll.interval = null;
    }
    delete (globalThis as Record<string, unknown>)[STORE_KEY];
    delete (globalThis as Record<string, unknown>)[POLL_KEY];
  });

  describe("Store singleton (globalThis)", () => {
    it("should create store with empty initial state", () => {
      const store = getStore();
      assert.deepStrictEqual(store.getState().indices, []);
      assert.strictEqual(store.getState().marketStatus, null);
    });

    it("should return same instance on repeated calls", () => {
      const s1 = getStore();
      const s2 = getStore();
      assert.strictEqual(s1, s2);
    });

    it("should persist state across getStore calls", () => {
      const store = getStore();
      const mockIndices: IndexQuote[] = [
        {
          symbol: "^NSEI",
          name: "NIFTY 50",
          price: 22500,
          change: 150,
          changePercent: 0.67,
          market: "IN",
        },
      ];
      store.setState({ indices: mockIndices });

      const store2 = getStore();
      assert.strictEqual(store2.getState().indices.length, 1);
      assert.strictEqual(store2.getState().indices[0].symbol, "^NSEI");
    });

    it("should support partial state updates", () => {
      const store = getStore();
      const status: MarketStatus = { IN: "OPEN", US: "CLOSED", MCX: "OPEN" };
      store.setState({ marketStatus: status });

      assert.deepStrictEqual(store.getState().marketStatus, status);
      // indices should remain unchanged
      assert.deepStrictEqual(store.getState().indices, []);
    });
  });

  describe("Poll singleton (globalThis)", () => {
    it("should create poll state with zero defaults", () => {
      const poll = getPoll();
      assert.strictEqual(poll.subscriberCount, 0);
      assert.strictEqual(poll.fetchInFlight, false);
      assert.strictEqual(poll.lastFetchAt, 0);
      assert.strictEqual(poll.interval, null);
    });

    it("should return same instance on repeated calls", () => {
      const p1 = getPoll();
      const p2 = getPoll();
      assert.strictEqual(p1, p2);
    });

    it("should persist mutations across calls", () => {
      const poll = getPoll();
      poll.subscriberCount = 3;
      poll.lastFetchAt = Date.now();

      const poll2 = getPoll();
      assert.strictEqual(poll2.subscriberCount, 3);
      assert.ok(poll2.lastFetchAt > 0);
    });
  });

  describe("Subscriber counting", () => {
    it("should increment on subscribe", () => {
      const poll = getPoll();
      poll.subscriberCount++;
      poll.subscriberCount++;
      assert.strictEqual(poll.subscriberCount, 2);
    });

    it("should decrement on unsubscribe", () => {
      const poll = getPoll();
      poll.subscriberCount = 3;
      poll.subscriberCount = Math.max(0, poll.subscriberCount - 1);
      assert.strictEqual(poll.subscriberCount, 2);
    });

    it("should never go below zero", () => {
      const poll = getPoll();
      poll.subscriberCount = 0;
      poll.subscriberCount = Math.max(0, poll.subscriberCount - 1);
      assert.strictEqual(poll.subscriberCount, 0);
    });

    it("should track multiple subscribe/unsubscribe cycles", () => {
      const poll = getPoll();

      // 3 subscribers mount
      poll.subscriberCount++;
      poll.subscriberCount++;
      poll.subscriberCount++;
      assert.strictEqual(poll.subscriberCount, 3);

      // 2 unmount
      poll.subscriberCount = Math.max(0, poll.subscriberCount - 1);
      poll.subscriberCount = Math.max(0, poll.subscriberCount - 1);
      assert.strictEqual(poll.subscriberCount, 1);

      // Last one unmounts
      poll.subscriberCount = Math.max(0, poll.subscriberCount - 1);
      assert.strictEqual(poll.subscriberCount, 0);
    });
  });

  describe("Fetch deduplication (fetchInFlight)", () => {
    it("should guard against concurrent fetches", async () => {
      const poll = getPoll();
      let fetchCount = 0;

      async function fetchIndices() {
        if (poll.fetchInFlight) return;
        poll.fetchInFlight = true;
        try {
          fetchCount++;
          await new Promise((r) => setTimeout(r, 20));
        } finally {
          poll.fetchInFlight = false;
        }
      }

      // Launch 3 concurrent fetches
      await Promise.all([fetchIndices(), fetchIndices(), fetchIndices()]);

      assert.strictEqual(fetchCount, 1, "Only one fetch should execute");
      assert.strictEqual(poll.fetchInFlight, false, "Flag should be cleared");
    });

    it("should allow new fetch after previous completes", async () => {
      const poll = getPoll();
      let fetchCount = 0;

      async function fetchIndices() {
        if (poll.fetchInFlight) return;
        poll.fetchInFlight = true;
        try {
          fetchCount++;
        } finally {
          poll.fetchInFlight = false;
        }
      }

      await fetchIndices();
      await fetchIndices();
      assert.strictEqual(fetchCount, 2);
    });

    it("should clear fetchInFlight on error", async () => {
      const poll = getPoll();

      async function fetchIndices() {
        if (poll.fetchInFlight) return;
        poll.fetchInFlight = true;
        try {
          throw new Error("network error");
        } catch {
          // Silently fail - ticker is non-critical
        } finally {
          poll.fetchInFlight = false;
        }
      }

      await fetchIndices();
      assert.strictEqual(poll.fetchInFlight, false);
    });
  });

  describe("Stale data detection", () => {
    it("should detect stale when lastFetchAt is 0 (never fetched)", () => {
      const poll = getPoll();
      const isStale =
        !poll.lastFetchAt || Date.now() - poll.lastFetchAt >= REFRESH_INTERVAL;
      assert.strictEqual(isStale, true);
    });

    it("should detect stale when last fetch exceeds refresh interval", () => {
      const poll = getPoll();
      poll.lastFetchAt = Date.now() - 61_000; // 61s ago
      const isStale =
        !poll.lastFetchAt || Date.now() - poll.lastFetchAt >= REFRESH_INTERVAL;
      assert.strictEqual(isStale, true);
    });

    it("should detect fresh when last fetch is within interval", () => {
      const poll = getPoll();
      poll.lastFetchAt = Date.now() - 30_000; // 30s ago
      const isStale =
        !poll.lastFetchAt || Date.now() - poll.lastFetchAt >= REFRESH_INTERVAL;
      assert.strictEqual(isStale, false);
    });
  });

  describe("Polling lifecycle", () => {
    it("should start interval and track it", () => {
      const poll = getPoll();
      assert.strictEqual(poll.interval, null);

      // Simulate startPolling
      poll.interval = setInterval(() => {}, 60_000);
      assert.ok(poll.interval !== null);
    });

    it("should not start second interval if one exists", () => {
      const poll = getPoll();
      poll.interval = setInterval(() => {}, 60_000);
      const firstInterval = poll.interval;

      // startPolling guard: if (poll.interval) return;
      if (!poll.interval) {
        poll.interval = setInterval(() => {}, 60_000);
      }

      assert.strictEqual(poll.interval, firstInterval);
    });

    it("should clear interval on stopPolling when no subscribers", () => {
      const poll = getPoll();
      poll.interval = setInterval(() => {}, 60_000);
      poll.subscriberCount = 0;

      // stopPolling logic
      if (poll.subscriberCount === 0 && poll.interval) {
        clearInterval(poll.interval);
        poll.interval = null;
      }

      assert.strictEqual(poll.interval, null);
    });

    it("should NOT clear interval when subscribers remain", () => {
      const poll = getPoll();
      poll.interval = setInterval(() => {}, 60_000);
      poll.subscriberCount = 2;

      // stopPolling guard: if (poll.subscriberCount > 0) return;
      if (poll.subscriberCount === 0 && poll.interval) {
        clearInterval(poll.interval);
        poll.interval = null;
      }

      assert.ok(poll.interval !== null);
    });
  });

  describe("Data persistence across navigation", () => {
    it("should keep data when subscribers go to 0 and back", () => {
      const store = getStore();
      const poll = getPoll();

      // Simulate data loaded
      store.setState({
        indices: [
          {
            symbol: "^NSEI",
            name: "NIFTY 50",
            price: 22500,
            change: 150,
            changePercent: 0.67,
            market: "IN",
          },
        ],
        marketStatus: { IN: "OPEN", US: "CLOSED", MCX: "OPEN" },
      });

      // All subscribers unmount (page navigation)
      poll.subscriberCount = 0;
      if (poll.interval) {
        clearInterval(poll.interval);
        poll.interval = null;
      }

      // New subscriber mounts (navigated back)
      poll.subscriberCount++;
      const state = store.getState();

      // Data should still be there - no "Loading" flash
      assert.strictEqual(state.indices.length, 1);
      assert.strictEqual(state.indices[0].symbol, "^NSEI");
      assert.ok(state.marketStatus);
    });

    it("should detect indices.length === 0 as needing initial fetch", () => {
      const store = getStore();
      assert.strictEqual(store.getState().indices.length, 0);

      // startPolling logic: if (indices.length === 0 || isStale) fetchIndices();
      const needsFetch = store.getState().indices.length === 0;
      assert.strictEqual(needsFetch, true);
    });

    it("should NOT need initial fetch when data exists and fresh", () => {
      const store = getStore();
      const poll = getPoll();

      store.setState({
        indices: [
          {
            symbol: "^NSEI",
            name: "NIFTY 50",
            price: 22500,
            change: 150,
            changePercent: 0.67,
            market: "IN",
          },
        ],
      });
      poll.lastFetchAt = Date.now(); // Just fetched

      const isStale =
        !poll.lastFetchAt || Date.now() - poll.lastFetchAt >= REFRESH_INTERVAL;
      const needsFetch = store.getState().indices.length === 0 || isStale;
      assert.strictEqual(needsFetch, false);
    });
  });
});
