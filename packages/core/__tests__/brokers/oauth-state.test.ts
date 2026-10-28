/**
 * OAuth CSRF state — packages/core/src/brokers/oauth-state.ts.
 *
 * Adapted (W0-α) from apps/web/__tests__/security/oauth-state-source.test.ts +
 * oauth-state-ttl.test.ts. The web suite injected a fake `@/lib/redis` via the
 * CJS `require.cache` module-swap trick — unavailable in this ESM package. This
 * suite instead drives the REAL source through the `__setRedisClientGetterForTests`
 * seam the migrated module exposes, so generate/verify/reauth all run against a
 * fake redis (no network, no leaked handles).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  OAUTH_STATE_TTL_SECONDS,
  generateOAuthState,
  verifyOAuthState,
  storeReauthIntent,
  consumeReauthIntent,
  __peekOAuthStateForTests,
  __setRedisClientGetterForTests,
  type ReauthIntent,
} from "../../src/brokers/oauth-state";

// ── Fake redis (mirrors the ioredis surface oauth-state uses) ───────────────

interface StubRedis {
  set: (...args: unknown[]) => Promise<"OK" | null>;
  get: (key: string) => Promise<string | null>;
  del: (key: string) => Promise<number>;
  exists: (key: string) => Promise<number>;
  _calls: { set: unknown[][]; get: string[]; del: string[]; exists: string[] };
  _store: Map<string, string>;
  _failNext: boolean;
}

function makeStubRedis(): StubRedis {
  const stub: StubRedis = {
    _calls: { set: [], get: [], del: [], exists: [] },
    _store: new Map(),
    _failNext: false,
    async set(...args) {
      stub._calls.set.push(args);
      if (stub._failNext) {
        stub._failNext = false;
        throw new Error("simulated redis SET failure");
      }
      const [key, value] = args as [string, string];
      stub._store.set(key, value);
      return "OK";
    },
    async get(key) {
      stub._calls.get.push(key);
      if (stub._failNext) {
        stub._failNext = false;
        throw new Error("simulated redis GET failure");
      }
      return stub._store.get(key) ?? null;
    },
    async del(key) {
      stub._calls.del.push(key);
      if (stub._failNext) {
        stub._failNext = false;
        throw new Error("simulated redis DEL failure");
      }
      const had = stub._store.delete(key);
      return had ? 1 : 0;
    },
    async exists(key) {
      stub._calls.exists.push(key);
      return stub._store.has(key) ? 1 : 0;
    },
  };
  return stub;
}

/** Point the source's redis getter at `stub` (or null to simulate Redis down). */
function useRedis(stub: StubRedis | null): void {
  __setRedisClientGetterForTests(
    (() => stub) as unknown as Parameters<
      typeof __setRedisClientGetterForTests
    >[0],
  );
}

let savedStrict: string | undefined;

beforeEach(() => {
  savedStrict = process.env.OAUTH_STATE_STRICT;
  delete process.env.OAUTH_STATE_STRICT;
});

afterEach(() => {
  __setRedisClientGetterForTests(null);
  if (savedStrict === undefined) delete process.env.OAUTH_STATE_STRICT;
  else process.env.OAUTH_STATE_STRICT = savedStrict;
});

// ── generate ────────────────────────────────────────────────────────────────

describe("generateOAuthState (Redis-on)", () => {
  it("calls Redis SET with EX+NX and returns a 64-hex state", async () => {
    const stub = makeStubRedis();
    useRedis(stub);
    const state = await generateOAuthState("alice", "ZERODHA");
    assert.equal(typeof state, "string");
    assert.equal(state!.length, 64);
    assert.equal(stub._calls.set.length, 1);
    const [key, value, ex, ttl, nx] = stub._calls.set[0]!;
    assert.match(key as string, /^oauth:state:alice:ZERODHA:[a-f0-9]{64}$/);
    assert.equal(value, "1");
    assert.equal(ex, "EX");
    assert.equal(ttl, OAUTH_STATE_TTL_SECONDS);
    assert.equal(nx, "NX");
  });

  it("returns null on empty userId (never touches Redis)", async () => {
    const stub = makeStubRedis();
    useRedis(stub);
    assert.equal(await generateOAuthState("", "ZERODHA"), null);
    assert.equal(stub._calls.set.length, 0);
  });

  it("returns null when Redis is unavailable", async () => {
    useRedis(null);
    assert.equal(await generateOAuthState("alice", "ZERODHA"), null);
  });

  it("catches a Redis SET error and returns null", async () => {
    const stub = makeStubRedis();
    stub._failNext = true;
    useRedis(stub);
    assert.equal(await generateOAuthState("alice", "ZERODHA"), null);
  });
});

// ── verify ────────────────────────────────────────────────────────────────

describe("verifyOAuthState (Redis-on)", () => {
  it("returns true on first verify, false on replay (single-use)", async () => {
    const stub = makeStubRedis();
    useRedis(stub);
    const state = await generateOAuthState("alice", "ZERODHA");
    assert.equal(await verifyOAuthState("alice", "ZERODHA", state), true);
    assert.equal(await verifyOAuthState("alice", "ZERODHA", state), false);
  });

  it("returns false on missing/empty state or empty userId", async () => {
    const stub = makeStubRedis();
    useRedis(stub);
    assert.equal(await verifyOAuthState("alice", "ZERODHA", ""), false);
    assert.equal(await verifyOAuthState("alice", "ZERODHA", undefined), false);
    assert.equal(await verifyOAuthState("", "ZERODHA", "x"), false);
  });

  it("returns false for a foreign user's state (cross-isolation)", async () => {
    const stub = makeStubRedis();
    useRedis(stub);
    const aliceState = await generateOAuthState("alice", "ZERODHA");
    assert.equal(await verifyOAuthState("bob", "ZERODHA", aliceState), false);
  });

  it("returns false for an expired/removed key (TTL semantics live in Redis)", async () => {
    const stub = makeStubRedis();
    useRedis(stub);
    const state = await generateOAuthState("alice", "ZERODHA");
    // Simulate Redis TTL expiry by dropping the key from the store.
    stub._store.clear();
    assert.equal(await verifyOAuthState("alice", "ZERODHA", state), false);
  });

  it("catches a Redis DEL error and returns false (reject-on-uncertain)", async () => {
    const stub = makeStubRedis();
    useRedis(stub);
    const state = await generateOAuthState("alice", "ZERODHA");
    stub._failNext = true;
    assert.equal(await verifyOAuthState("alice", "ZERODHA", state), false);
  });
});

describe("verifyOAuthState (Redis-down)", () => {
  // MONEY-1062 W0 regression fix — DELIBERATE expectation flip. These two cases
  // previously pinned a soft-pass (return true) on Redis-down unless
  // OAUTH_STATE_STRICT=1. That soft-pass was a LIVE login-CSRF hole once core's
  // getRedisClient() started returning null permanently (the pre-W0 web client
  // cached its singleton forever, so `!redis` was unreachable and verify was
  // effectively fail-CLOSED). verify now ALWAYS fails closed when Redis is down;
  // OAUTH_STATE_STRICT no longer changes the verify outcome.
  it("fails CLOSED when Redis is down (rejects any state — was an insecure soft-pass)", async () => {
    useRedis(null);
    assert.equal(await verifyOAuthState("alice", "ZERODHA", "x"), false);
  });

  it("still fails CLOSED when Redis is down even with OAUTH_STATE_STRICT=1 (flag now obsolete)", async () => {
    process.env.OAUTH_STATE_STRICT = "1";
    useRedis(null);
    assert.equal(await verifyOAuthState("alice", "ZERODHA", "x"), false);
  });
});

describe("OAUTH_STATE_TTL_SECONDS", () => {
  it("is exactly 600 seconds (10 minutes)", () => {
    assert.equal(OAUTH_STATE_TTL_SECONDS, 600);
  });
});

// ── __peekOAuthStateForTests ────────────────────────────────────────────────

describe("__peekOAuthStateForTests", () => {
  it("true for a present key, false for an absent one", async () => {
    const stub = makeStubRedis();
    useRedis(stub);
    const state = await generateOAuthState("alice", "ZERODHA");
    assert.equal(
      await __peekOAuthStateForTests("alice", "ZERODHA", state!),
      true,
    );
    assert.equal(
      await __peekOAuthStateForTests("alice", "ZERODHA", "forged"),
      false,
    );
  });

  it("false when Redis is unavailable", async () => {
    useRedis(null);
    assert.equal(
      await __peekOAuthStateForTests("alice", "ZERODHA", "x"),
      false,
    );
  });
});

// ── re-auth intent (MONEY-837) ──────────────────────────────────────────────

describe("re-auth intent (single-use)", () => {
  const INTENT: ReauthIntent = {
    connectionId: "conn-1",
    expectedBrokerUserId: "KP9460",
  };

  it("store writes the intent JSON under oauth:reauth:* with an EX TTL", async () => {
    const stub = makeStubRedis();
    useRedis(stub);
    await storeReauthIntent("alice", "ZERODHA", INTENT);
    assert.equal(stub._calls.set.length, 1);
    const [key, value, ex, ttl] = stub._calls.set[0]!;
    assert.equal(key, "oauth:reauth:alice:ZERODHA");
    assert.deepEqual(JSON.parse(value as string), INTENT);
    assert.equal(ex, "EX");
    assert.equal(ttl, OAUTH_STATE_TTL_SECONDS);
  });

  it("consume returns the intent then DELETES it (single-use)", async () => {
    const stub = makeStubRedis();
    useRedis(stub);
    await storeReauthIntent("alice", "ZERODHA", INTENT);
    const first = await consumeReauthIntent("alice", "ZERODHA");
    assert.deepEqual(first, INTENT);
    assert.equal(stub._calls.del.length, 1);
    const second = await consumeReauthIntent("alice", "ZERODHA");
    assert.equal(second, null);
  });

  it("consume returns null when there is no intent (a fresh connect)", async () => {
    const stub = makeStubRedis();
    useRedis(stub);
    const res = await consumeReauthIntent("bob", "UPSTOX");
    assert.equal(res, null);
    assert.equal(stub._calls.del.length, 0);
  });

  it("store is a no-op when Redis is down (best-effort, never throws)", async () => {
    useRedis(null);
    await storeReauthIntent("alice", "ZERODHA", INTENT);
    assert.equal(await consumeReauthIntent("alice", "ZERODHA"), null);
  });

  it("consume swallows a Redis error and returns null", async () => {
    const stub = makeStubRedis();
    useRedis(stub);
    await storeReauthIntent("alice", "ZERODHA", INTENT);
    stub._failNext = true; // next GET throws
    assert.equal(await consumeReauthIntent("alice", "ZERODHA"), null);
  });
});
