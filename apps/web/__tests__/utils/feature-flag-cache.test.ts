/**
 * Feature Flag Cache Tests (client-side localStorage layer)
 *
 * De-shadowed (MONEY-620): imports the REAL client-cache functions from
 * lib/utils/feature-flag-cache.ts and drives them through a global
 * window/localStorage shim (the source reads bare `localStorage`, guarded by
 * `typeof window`). This is a separate concern from the server-side flag tests
 * in __tests__/actions/feature-flags.test.ts.
 *
 * The old shadow re-declared storage-injecting variants + a stale 8-route
 * FeatureFlagMap (incl. a "/tutor" route that no longer exists — the real map
 * has 16 routes). These tests exercise the production functions directly.
 */

import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import type { FeatureFlagMap } from "@/lib/types/feature-flags";

// ── Global window + localStorage shim ───────────────────────────────────────
// Installed BEFORE importing the source so its module-load `typeof window`
// branch sees a browser-like environment.
const store = new Map<string, string>();
const mockLocalStorage = {
  getItem: (k: string): string | null => store.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    store.set(k, v);
  },
  removeItem: (k: string): void => {
    store.delete(k);
  },
  clear: (): void => store.clear(),
};

const g = globalThis as unknown as {
  window?: unknown;
  localStorage?: unknown;
};
const hadWindow = "window" in g;
const hadLocalStorage = "localStorage" in g;
const prevWindow = g.window;
const prevLocalStorage = g.localStorage;

before(() => {
  g.window = g.window ?? {};
  g.localStorage = mockLocalStorage;
});
after(() => {
  if (hadWindow) g.window = prevWindow;
  else delete g.window;
  if (hadLocalStorage) g.localStorage = prevLocalStorage;
  else delete g.localStorage;
});

// Import AFTER the shim is referenced (tsx hoists imports, but the module's
// window-branch only sets a debug helper — harmless either way).
import {
  getCachedUserId,
  setCachedUserId,
  getCachedFeatureFlagsLocal,
  setCachedFeatureFlagsLocal,
  clearCachedFeatureFlagsLocal,
  shouldRefreshCache,
} from "@/lib/utils/feature-flag-cache";

const CACHE_KEY = "ff_cache";
const CACHE_VERSION_KEY = "ff_cache_version";
const CACHE_TIMESTAMP_KEY = "ff_cache_timestamp";
const CACHE_TTL_MS = 5 * 60 * 1000;

// The source casts JSON straight to FeatureFlagMap without key validation, so a
// partial map round-trips at runtime — fine for these unit tests.
function flags(overrides: Record<string, boolean> = {}): FeatureFlagMap {
  return {
    "/tradebook": true,
    "/holdings": false,
    ...overrides,
  } as FeatureFlagMap;
}

describe("Feature Flag Cache (client-side, real functions)", () => {
  beforeEach(() => {
    store.clear();
  });

  describe("setCachedUserId / getCachedUserId", () => {
    it("round-trips a user id", () => {
      assert.strictEqual(getCachedUserId(), null);
      setCachedUserId("user-123");
      assert.strictEqual(getCachedUserId(), "user-123");
    });
  });

  describe("setCachedFeatureFlagsLocal / getCachedFeatureFlagsLocal", () => {
    it("round-trips flags + version and stamps a timestamp", () => {
      setCachedFeatureFlagsLocal(flags({ "/holdings": true }), "v1");
      const got = getCachedFeatureFlagsLocal();
      assert.ok(got);
      assert.strictEqual(got.version, "v1");
      assert.strictEqual(got.flags["/holdings"], true);
      assert.strictEqual(typeof got.timestamp, "number");
    });

    it("returns null when nothing is cached", () => {
      assert.strictEqual(getCachedFeatureFlagsLocal(), null);
    });

    it("returns null when any of the three keys is missing", () => {
      store.set(CACHE_KEY, JSON.stringify(flags()));
      // no version / timestamp
      assert.strictEqual(getCachedFeatureFlagsLocal(), null);
    });

    it("returns null when the cache is older than the 5-minute TTL (expired)", () => {
      store.set(CACHE_KEY, JSON.stringify(flags()));
      store.set(CACHE_VERSION_KEY, "v1");
      store.set(
        CACHE_TIMESTAMP_KEY,
        String(Date.now() - (CACHE_TTL_MS + 1000))
      );
      assert.strictEqual(getCachedFeatureFlagsLocal(), null);
    });

    it("returns the cache when within the TTL window", () => {
      store.set(CACHE_KEY, JSON.stringify(flags()));
      store.set(CACHE_VERSION_KEY, "v1");
      store.set(CACHE_TIMESTAMP_KEY, String(Date.now() - 1000));
      assert.ok(getCachedFeatureFlagsLocal());
    });

    it("returns null on malformed cached JSON (does not throw)", () => {
      store.set(CACHE_KEY, "{not json");
      store.set(CACHE_VERSION_KEY, "v1");
      store.set(CACHE_TIMESTAMP_KEY, String(Date.now()));
      assert.strictEqual(getCachedFeatureFlagsLocal(), null);
    });
  });

  describe("clearCachedFeatureFlagsLocal", () => {
    it("removes all four cache keys", () => {
      setCachedFeatureFlagsLocal(flags(), "v1");
      setCachedUserId("user-1");
      clearCachedFeatureFlagsLocal();
      assert.strictEqual(getCachedFeatureFlagsLocal(), null);
      assert.strictEqual(getCachedUserId(), null);
    });
  });

  describe("shouldRefreshCache", () => {
    it("refreshes when no version is cached", () => {
      assert.strictEqual(shouldRefreshCache("v2"), true);
    });

    it("refreshes when the cached version differs from the server", () => {
      setCachedFeatureFlagsLocal(flags(), "v1");
      assert.strictEqual(shouldRefreshCache("v2"), true);
    });

    it("does NOT refresh when versions match", () => {
      setCachedFeatureFlagsLocal(flags(), "v1");
      assert.strictEqual(shouldRefreshCache("v1"), false);
    });
  });
});
