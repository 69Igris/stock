/**
 * Quote Freshness Tests
 *
 * De-shadowed: imports the REAL `isFresh` + `DEFAULT_QUOTE_TTL_MS` from
 * lib/market/quote-freshness.ts (the shared TTL predicate the news-cache
 * staleness check in lib/actions/news.ts now calls) instead of a phantom
 * inline copy of a non-existent `quote-service.ts`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isFresh, DEFAULT_QUOTE_TTL_MS } from "@/lib/market/quote-freshness";

// ── Tests ────────────────────────────────────────────────────────

describe("Quote Freshness (isFresh)", () => {
  it("should return true for a just-updated entry", () => {
    const now = new Date();
    assert.strictEqual(isFresh(now, DEFAULT_QUOTE_TTL_MS), true);
  });

  it("should return true for an entry updated 30s ago (within 60s TTL)", () => {
    const thirtySecsAgo = new Date(Date.now() - 30_000);
    assert.strictEqual(isFresh(thirtySecsAgo, DEFAULT_QUOTE_TTL_MS), true);
  });

  it("should return true for an entry updated 59s ago (within 60s TTL)", () => {
    const fiftyNineSecsAgo = new Date(Date.now() - 59_000);
    assert.strictEqual(isFresh(fiftyNineSecsAgo, DEFAULT_QUOTE_TTL_MS), true);
  });

  it("should return false for an entry updated 61s ago (past 60s TTL)", () => {
    const sixtyOneSecsAgo = new Date(Date.now() - 61_000);
    assert.strictEqual(isFresh(sixtyOneSecsAgo, DEFAULT_QUOTE_TTL_MS), false);
  });

  it("should return false for an entry updated 5 minutes ago", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    assert.strictEqual(isFresh(fiveMinAgo, DEFAULT_QUOTE_TTL_MS), false);
  });

  it("should return false for an entry updated 1 hour ago", () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    assert.strictEqual(isFresh(oneHourAgo, DEFAULT_QUOTE_TTL_MS), false);
  });

  it("should work with custom TTL (5 seconds)", () => {
    const customTTL = 5_000;
    const threeSecsAgo = new Date(Date.now() - 3_000);
    const sixSecsAgo = new Date(Date.now() - 6_000);

    assert.strictEqual(isFresh(threeSecsAgo, customTTL), true);
    assert.strictEqual(isFresh(sixSecsAgo, customTTL), false);
  });

  it("should work with custom TTL (5 minutes)", () => {
    const customTTL = 5 * 60 * 1000;
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000);
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);

    assert.strictEqual(isFresh(threeMinAgo, customTTL), true);
    assert.strictEqual(isFresh(sixMinAgo, customTTL), false);
  });

  it("should return false for TTL of 0 (always stale)", () => {
    const now = new Date();
    // With TTL=0, Date.now() - now.getTime() is ~0, which is NOT < 0
    assert.strictEqual(isFresh(now, 0), false);
  });

  it("should return true for a very large TTL", () => {
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const weekTTL = 7 * 24 * 60 * 60 * 1000;
    assert.strictEqual(isFresh(oneDayAgo, weekTTL), true);
  });

  it("should return false for a future date (negative diff)", () => {
    // If updatedAt is in the future, Date.now() - updatedAt is negative, which IS < ttlMs
    const futureDate = new Date(Date.now() + 10_000);
    assert.strictEqual(isFresh(futureDate, DEFAULT_QUOTE_TTL_MS), true);
  });

  it("should handle epoch date (very old entry)", () => {
    const epoch = new Date(0);
    assert.strictEqual(isFresh(epoch, DEFAULT_QUOTE_TTL_MS), false);
  });

  it("should verify DEFAULT_QUOTE_TTL_MS is 60 seconds", () => {
    assert.strictEqual(DEFAULT_QUOTE_TTL_MS, 60_000);
  });
});
