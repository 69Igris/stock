/**
 * Intraday Hub - Pure Function Tests (MONEY-123 Part B)
 *
 * Tests for the pure helpers and ref-counting logic in
 * apps/web/lib/market/intraday-hub.ts.
 *
 * The full module imports the Zerodha WebSocket client and Prisma so
 * we can't import it directly in a Node test runner. Instead we
 * inline the small pure helpers and recreate the ref-counting state
 * machine in isolation. The integration tests (real WS + real DB)
 * are exercised by smoke tests against `/api/market/udf/stream`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ============== INLINED FROM intraday-hub.ts ==============

// SOURCE: intraday-hub.ts → aggregatorKey
function aggregatorKey(symbolKey: string, interval: string): string {
  return `${symbolKey.toUpperCase()}::${interval}`;
}

// Recreates the ref-counting state machine from intraday-hub.ts in
// isolation. The real hub also wires up the Zerodha WS - that's
// orthogonal to the refcount logic and is exercised by smoke tests.
interface MockTokenEntry {
  token: number;
  symbolKey: string;
  refCount: number;
  lastVolume: number;
}
interface MockAggEntry {
  // We don't instantiate a real TickAggregator here; we just track
  // the ref count and a destroyed flag.
  refCount: number;
  destroyed: boolean;
}
interface MockHub {
  tokens: Map<number, MockTokenEntry>;
  aggregators: Map<string, MockAggEntry>;
  symbolToToken: Map<string, number>;
  tokenToAggregatorKeys: Map<number, Set<string>>;
  /** Calls recorded for assertions */
  wsSubscribed: number[];
  wsUnsubscribed: number[];
}

function makeHub(): MockHub {
  return {
    tokens: new Map(),
    aggregators: new Map(),
    symbolToToken: new Map(),
    tokenToAggregatorKeys: new Map(),
    wsSubscribed: [],
    wsUnsubscribed: [],
  };
}

/**
 * Mirrors the subscribe() body in intraday-hub.ts. Returns the
 * unsubscribe function which mirrors the cleanup body.
 */
function mockSubscribe(
  hub: MockHub,
  args: { symbolKey: string; interval: string; token: number },
): () => void {
  const { symbolKey, interval, token } = args;

  // Token registration.
  let tokenEntry = hub.tokens.get(token);
  if (!tokenEntry) {
    tokenEntry = {
      token,
      symbolKey,
      refCount: 0,
      lastVolume: 0,
    };
    hub.tokens.set(token, tokenEntry);
    hub.symbolToToken.set(symbolKey.toUpperCase(), token);
    hub.wsSubscribed.push(token);
  }
  tokenEntry.refCount++;

  // Aggregator registration.
  const aggKey = aggregatorKey(symbolKey, interval);
  let aggEntry = hub.aggregators.get(aggKey);
  if (!aggEntry) {
    aggEntry = { refCount: 0, destroyed: false };
    hub.aggregators.set(aggKey, aggEntry);
    const existing = hub.tokenToAggregatorKeys.get(token) ?? new Set();
    existing.add(aggKey);
    hub.tokenToAggregatorKeys.set(token, existing);
  }
  aggEntry.refCount++;

  return () => {
    // Aggregator cleanup
    const a = hub.aggregators.get(aggKey);
    if (a) {
      a.refCount--;
      if (a.refCount <= 0) {
        a.destroyed = true;
        hub.aggregators.delete(aggKey);
        const aggKeys = hub.tokenToAggregatorKeys.get(token);
        aggKeys?.delete(aggKey);
        if (aggKeys && aggKeys.size === 0) {
          hub.tokenToAggregatorKeys.delete(token);
        }
      }
    }

    // Token cleanup
    const t = hub.tokens.get(token);
    if (t) {
      t.refCount--;
      if (t.refCount <= 0) {
        hub.tokens.delete(token);
        hub.symbolToToken.delete(symbolKey.toUpperCase());
        hub.wsUnsubscribed.push(token);
      }
    }
  };
}

// ============== aggregatorKey ==============

describe("aggregatorKey", () => {
  it("uppercases the symbol portion only", () => {
    assert.equal(aggregatorKey("nse:tcs", "5m"), "NSE:TCS::5m");
  });

  it("treats different intervals as distinct keys for the same symbol", () => {
    const a = aggregatorKey("NSE:TCS", "5m");
    const b = aggregatorKey("NSE:TCS", "15m");
    assert.notEqual(a, b);
  });

  it("treats different exchanges as distinct keys for the same symbol", () => {
    const a = aggregatorKey("NSE:TCS", "5m");
    const b = aggregatorKey("BSE:TCS", "5m");
    assert.notEqual(a, b);
  });

  it("uses :: as a delimiter so single colons in symbol can't collide", () => {
    // The hub stores symbolKey as "EXCHANGE:SYMBOL", so the symbol
    // segment of the cache key contains a colon by design. Using ::
    // as the symbol/interval separator avoids ambiguity.
    const key = aggregatorKey("NSE:TCS", "5m");
    assert.match(key, /::/);
    assert.equal(key.split("::").length, 2);
  });
});

// ============== Ref counting - single client ==============

describe("hub ref-counting - single client lifecycle", () => {
  it("subscribe creates token + aggregator and emits WS subscribe", () => {
    const hub = makeHub();
    mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });

    assert.equal(hub.tokens.size, 1);
    assert.equal(hub.aggregators.size, 1);
    assert.deepEqual(hub.wsSubscribed, [2953217]);
    assert.deepEqual(hub.wsUnsubscribed, []);
  });

  it("unsubscribe tears down both refs and emits WS unsubscribe", () => {
    const hub = makeHub();
    const off = mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });

    off();

    assert.equal(hub.tokens.size, 0);
    assert.equal(hub.aggregators.size, 0);
    assert.equal(hub.tokenToAggregatorKeys.size, 0);
    assert.deepEqual(hub.wsUnsubscribed, [2953217]);
  });
});

// ============== Ref counting - multiple clients, same (symbol, interval) ==============

describe("hub ref-counting - multiple clients on same key", () => {
  it("two clients on the same symbol+interval share aggregator and token", () => {
    const hub = makeHub();
    mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });
    mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });

    assert.equal(hub.tokens.size, 1);
    assert.equal(hub.tokens.get(2953217)!.refCount, 2);
    assert.equal(hub.aggregators.size, 1);
    assert.equal(hub.aggregators.get("NSE:TCS::5m")!.refCount, 2);
    // WS subscribe was called only once
    assert.equal(hub.wsSubscribed.length, 1);
  });

  it("first unsub does NOT close the WS subscription", () => {
    const hub = makeHub();
    const off1 = mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });
    mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });

    off1();

    assert.equal(hub.tokens.size, 1);
    assert.equal(hub.aggregators.size, 1);
    assert.deepEqual(hub.wsUnsubscribed, []);
  });

  it("last unsub closes the WS subscription and destroys aggregator", () => {
    const hub = makeHub();
    const off1 = mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });
    const off2 = mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });

    off1();
    off2();

    assert.equal(hub.tokens.size, 0);
    assert.equal(hub.aggregators.size, 0);
    assert.deepEqual(hub.wsUnsubscribed, [2953217]);
  });
});

// ============== Ref counting - same symbol, different intervals ==============

describe("hub ref-counting - same symbol, different intervals", () => {
  it("two intervals on the same symbol share the token but not the aggregator", () => {
    const hub = makeHub();
    mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });
    mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "15m",
      token: 2953217,
    });

    assert.equal(hub.tokens.size, 1);
    assert.equal(hub.tokens.get(2953217)!.refCount, 2);
    assert.equal(hub.aggregators.size, 2);
    assert.equal(hub.tokenToAggregatorKeys.get(2953217)!.size, 2);
  });

  it("unsubscribing one interval keeps the WS open for the other", () => {
    const hub = makeHub();
    const off5 = mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });
    mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "15m",
      token: 2953217,
    });

    off5();

    assert.equal(hub.tokens.size, 1);
    assert.equal(hub.tokens.get(2953217)!.refCount, 1);
    assert.equal(hub.aggregators.size, 1);
    assert.equal(hub.tokenToAggregatorKeys.get(2953217)!.size, 1);
    assert.deepEqual(hub.wsUnsubscribed, []);
  });
});

// ============== Ref counting - multiple symbols ==============

describe("hub ref-counting - multiple symbols", () => {
  it("subscribes WS to each token independently", () => {
    const hub = makeHub();
    mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });
    mockSubscribe(hub, {
      symbolKey: "NSE:RELIANCE",
      interval: "5m",
      token: 738561,
    });

    assert.equal(hub.tokens.size, 2);
    assert.equal(hub.aggregators.size, 2);
    assert.deepEqual(hub.wsSubscribed.sort(), [738561, 2953217].sort());
  });

  it("unsubscribing one symbol doesn't affect the other", () => {
    const hub = makeHub();
    const offTcs = mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });
    mockSubscribe(hub, {
      symbolKey: "NSE:RELIANCE",
      interval: "5m",
      token: 738561,
    });

    offTcs();

    assert.equal(hub.tokens.size, 1);
    assert.ok(hub.tokens.has(738561));
    assert.ok(!hub.tokens.has(2953217));
    assert.deepEqual(hub.wsUnsubscribed, [2953217]);
  });
});

// ============== Edge cases ==============

describe("hub ref-counting - edge cases", () => {
  it("calling unsubscribe twice is idempotent on the second call", () => {
    const hub = makeHub();
    const off = mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });

    off();
    // Second call should not throw and should not double-decrement
    // (the entry is already gone, so it's a no-op).
    assert.doesNotThrow(() => off());
    assert.equal(hub.tokens.size, 0);
  });

  it("subscribing to a brand-new symbol after a full teardown re-emits WS subscribe", () => {
    const hub = makeHub();
    const off = mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });
    off();

    // Re-subscribe
    mockSubscribe(hub, {
      symbolKey: "NSE:TCS",
      interval: "5m",
      token: 2953217,
    });

    assert.equal(hub.tokens.size, 1);
    // wsSubscribed contains BOTH entries (one for each subscribe)
    assert.equal(hub.wsSubscribed.length, 2);
  });
});
