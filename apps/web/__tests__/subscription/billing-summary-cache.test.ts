/**
 * Billing summary cache (settings instant paint) — MONEY-764 round 2.
 *
 * The /settings billing hero used to wait a full `getSubscriptionAction`
 * round trip before leaving FREE/"—". The cache persists the last summary
 * per Clerk user id; the settings client hydrates from it on mount and the
 * always-run refetch overwrites both state and cache. These tests pin the
 * safety properties that make the instant paint acceptable:
 *
 *   - keyed by userId: another account's summary NEVER hydrates (shared
 *     browser / sign-out+sign-in) — a mismatch reads as a miss;
 *   - junk tolerance: non-JSON, wrong shapes, and storage throws all read
 *     as a miss (and writes degrade silently) — paint-only, never throws;
 *   - SSR guard: every call is a no-op without `window`.
 *
 * Source: apps/web/lib/subscription/billing-summary-cache.ts
 */
import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

// ── Global window + localStorage shim (before importing the module) ────────
let storageThrows = false;
const store = new Map<string, string>();
const mockLocalStorage = {
  getItem: (k: string): string | null => {
    if (storageThrows) throw new Error("storage disabled");
    return store.get(k) ?? null;
  },
  setItem: (k: string, v: string): void => {
    if (storageThrows) throw new Error("quota exceeded");
    store.set(k, v);
  },
  removeItem: (k: string): void => {
    if (storageThrows) throw new Error("storage disabled");
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
g.window = g.window ?? {};
g.localStorage = mockLocalStorage;

after(() => {
  if (hadWindow) g.window = prevWindow;
  else delete g.window;
  if (hadLocalStorage) g.localStorage = prevLocalStorage;
  else delete g.localStorage;
});

import {
  getCachedBillingSummary,
  setCachedBillingSummary,
  clearCachedBillingSummary,
} from "@/lib/subscription/billing-summary-cache";

const KEY = "um_billing_v1";

interface SummaryLike {
  planId: string;
  status: string;
  nextBillingDate?: string | null;
}

const summary: SummaryLike = {
  planId: "PREMIUM",
  status: "ACTIVE",
  nextBillingDate: "2027-05-23T00:00:00.000Z",
};

describe("billing-summary-cache", () => {
  beforeEach(() => {
    storageThrows = false;
    store.clear();
  });

  it("set → get roundtrips for the same user", () => {
    setCachedBillingSummary("user_1", summary);
    assert.deepEqual(getCachedBillingSummary<SummaryLike>("user_1"), summary);
  });

  it("a different userId reads as a miss (no cross-account paint)", () => {
    setCachedBillingSummary("user_1", summary);
    assert.equal(getCachedBillingSummary<SummaryLike>("user_2"), null);
  });

  it("an empty userId never reads or writes", () => {
    setCachedBillingSummary("", summary);
    assert.equal(store.has(KEY), false);
    setCachedBillingSummary("user_1", summary);
    assert.equal(getCachedBillingSummary<SummaryLike>(""), null);
  });

  it("non-JSON storage content reads as a miss", () => {
    store.set(KEY, "not-json{{{");
    assert.equal(getCachedBillingSummary<SummaryLike>("user_1"), null);
  });

  it("wrong-shape payloads read as a miss", () => {
    store.set(KEY, JSON.stringify({ userId: "user_1", data: { foo: 1 } }));
    assert.equal(getCachedBillingSummary<SummaryLike>("user_1"), null);
    store.set(KEY, JSON.stringify({ userId: "user_1", data: null }));
    assert.equal(getCachedBillingSummary<SummaryLike>("user_1"), null);
  });

  it("refuses to persist junk (shape-guarded write)", () => {
    setCachedBillingSummary("user_1", { foo: 1 } as unknown as SummaryLike);
    assert.equal(store.has(KEY), false);
  });

  it("storage throws degrade silently (get → null, set/clear no-throw)", () => {
    storageThrows = true;
    assert.equal(getCachedBillingSummary<SummaryLike>("user_1"), null);
    assert.doesNotThrow(() => setCachedBillingSummary("user_1", summary));
    assert.doesNotThrow(() => clearCachedBillingSummary());
  });

  it("clear removes the persisted summary", () => {
    setCachedBillingSummary("user_1", summary);
    clearCachedBillingSummary();
    assert.equal(getCachedBillingSummary<SummaryLike>("user_1"), null);
    assert.equal(store.has(KEY), false);
  });

  it("a newer write for another user evicts the previous user's summary", () => {
    setCachedBillingSummary("user_1", summary);
    setCachedBillingSummary("user_2", { ...summary, planId: "PRO" });
    assert.equal(getCachedBillingSummary<SummaryLike>("user_1"), null);
    assert.equal(getCachedBillingSummary<SummaryLike>("user_2")?.planId, "PRO");
  });

  it("is a no-op without window (SSR guard)", () => {
    const win = g.window;
    delete g.window;
    try {
      assert.equal(getCachedBillingSummary<SummaryLike>("user_1"), null);
      assert.doesNotThrow(() => setCachedBillingSummary("user_1", summary));
      assert.equal(store.has(KEY), false);
      assert.doesNotThrow(() => clearCachedBillingSummary());
    } finally {
      g.window = win;
    }
  });
});
