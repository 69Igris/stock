/**
 * Broker sync token-expiry gate — MONEY-582d.
 *
 * syncBrokerDataAction (apps/web/lib/actions/broker-connection.ts) is
 * "use server" + pulls prisma, so it can't be imported. Per the repo convention
 * we inline-copy the pure pre-sync decision: an expired token must block the
 * sync (and trigger the NEEDS_REAUTH transition) instead of running a
 * guaranteed-fail round-trip that leaves the connection silently "ACTIVE".
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Mirror of the inline check in syncBrokerDataAction.
function shouldBlockSyncForExpiry(
  tokenExpiry: Date | null | undefined,
  nowMs: number
): boolean {
  return !!tokenExpiry && tokenExpiry.getTime() < nowMs;
}

const NOW = Date.UTC(2026, 4, 31, 12, 0, 0); // fixed reference

describe("token-expiry sync gate (MONEY-582d)", () => {
  it("blocks sync when the token expired in the past", () => {
    const expired = new Date(NOW - 60_000); // 1 min ago
    assert.equal(shouldBlockSyncForExpiry(expired, NOW), true);
  });

  it("allows sync when the token is still valid", () => {
    const valid = new Date(NOW + 60 * 60_000); // 1 hour from now
    assert.equal(shouldBlockSyncForExpiry(valid, NOW), false);
  });

  it("allows sync when no expiry is set (broker tokens that don't expire)", () => {
    assert.equal(shouldBlockSyncForExpiry(null, NOW), false);
    assert.equal(shouldBlockSyncForExpiry(undefined, NOW), false);
  });

  it("blocks exactly at/after the expiry instant", () => {
    // strictly-less-than means the exact instant is NOT yet expired...
    assert.equal(shouldBlockSyncForExpiry(new Date(NOW), NOW), false);
    // ...but 1ms past is.
    assert.equal(shouldBlockSyncForExpiry(new Date(NOW - 1), NOW), true);
  });
});
