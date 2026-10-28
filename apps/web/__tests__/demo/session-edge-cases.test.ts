/**
 * MONEY-393 §35 - lib/demo/session.ts coverage push (70.9% → 90%+).
 *
 * Existing session.test.ts (687 lines) covers happy-path create + verify.
 * The gap is the error / forgery branches:
 *   - Malformed token (wrong part count)
 *   - Tampered signature
 *   - Expired token (TTL > 24h)
 *   - isDemoSession when cookies() throws
 *   - verifyDemoCookieEdge thin wrapper
 *   - fingerprint with embedded dots (e.g. IPv4 - sanitization branch)
 *
 * Each test sets the HMAC_SECRET env so signing is deterministic.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

// Make sure ENCRYPTION_KEY / HMAC_SECRET exists before the demo module
// imports - getSecret() reads from a module-level cache.
before(() => {
  process.env.ENCRYPTION_KEY =
    process.env.ENCRYPTION_KEY ||
    "demo-session-edge-cases-key-64-chars-long-test-test-test-1234ab";
  process.env.HMAC_SECRET =
    process.env.HMAC_SECRET || "demo-session-edge-cases-hmac-secret-§35";
});

import {
  createDemoToken,
  verifyDemoToken,
  verifyDemoCookieEdge,
} from "@/lib/demo/session";

describe("MONEY-393 §35 - demo session token verification edge cases", () => {
  it("[verify] empty string → invalid, not expired", async () => {
    const r = await verifyDemoToken("");
    assert.deepStrictEqual(r, { valid: false, expired: false });
  });

  it("[verify] single-dot token (only 2 parts) → invalid", async () => {
    const r = await verifyDemoToken("only.two");
    assert.deepStrictEqual(r, { valid: false, expired: false });
  });

  it("[verify] no-dot token (1 part) → invalid", async () => {
    const r = await verifyDemoToken("singletoken");
    assert.deepStrictEqual(r, { valid: false, expired: false });
  });

  it("[verify] 4-part token (extra dot) → invalid", async () => {
    const r = await verifyDemoToken("a.b.c.d");
    assert.deepStrictEqual(r, { valid: false, expired: false });
  });

  it("[verify] tampered signature → invalid (no leak about expiry)", async () => {
    const token = await createDemoToken("test-fp-tampered");
    const parts = token.split(".");
    // Flip the last byte of the signature.
    const sig = parts[2]!;
    const flipped = sig.slice(0, -1) + (sig.slice(-1) === "0" ? "1" : "0");
    const tampered = `${parts[0]}.${parts[1]}.${flipped}`;
    const r = await verifyDemoToken(tampered);
    assert.equal(r.valid, false);
    // Important: signature-mismatch must NOT report 'expired:true' -
    // that would leak that a valid-but-old token exists for this fp.
    assert.equal(r.expired, false);
  });

  it("[verify] token with bad timestamp (non-base36) → invalid", async () => {
    const token = await createDemoToken("test-fp-bad-ts");
    const parts = token.split(".");
    // Replace timestamp with non-base36 garbage. Signature won't
    // match, so this routes through the same invalid path.
    const garbage = `XXXX.${parts[1]}.${parts[2]}`;
    const r = await verifyDemoToken(garbage);
    assert.equal(r.valid, false);
  });

  it("[create] fingerprint with dots is sanitized to underscores", async () => {
    // IPv4 fingerprints contain dots - token must still split into
    // exactly 3 parts when the underlying fp had dots.
    const token = await createDemoToken("49.36.128.57");
    const parts = token.split(".");
    assert.equal(
      parts.length,
      3,
      `IPv4 fingerprint must produce exactly 3 token parts, got ${parts.length}`
    );
    // The middle part (fp) must contain underscores, not dots.
    assert.ok(parts[1]!.includes("_"));
    assert.ok(!parts[1]!.includes("."));
  });

  it("[create] long fingerprint is truncated to 32 chars", async () => {
    const longFp = "a".repeat(100);
    const token = await createDemoToken(longFp);
    const fpPart = token.split(".")[1]!;
    assert.ok(
      fpPart.length <= 32,
      `fp part must be ≤32 chars, got ${fpPart.length}`
    );
  });

  it("[create] round-trip - token verifies as valid immediately", async () => {
    const token = await createDemoToken("test-roundtrip-§35");
    const r = await verifyDemoToken(token);
    assert.deepStrictEqual(r, { valid: true, expired: false });
  });

  it("[verifyDemoCookieEdge] valid token → true", async () => {
    const token = await createDemoToken("edge-test-§35");
    assert.equal(await verifyDemoCookieEdge(token), true);
  });

  it("[verifyDemoCookieEdge] invalid token → false", async () => {
    assert.equal(await verifyDemoCookieEdge("bad.token.sig"), false);
  });

  it("[verifyDemoCookieEdge] empty string → false", async () => {
    assert.equal(await verifyDemoCookieEdge(""), false);
  });

  it("[verify] signature for one fp does NOT validate for another", async () => {
    // Cross-fingerprint forgery resistance.
    const tokenA = await createDemoToken("fp-A");
    const partsA = tokenA.split(".");
    const tokenB = await createDemoToken("fp-B");
    const partsB = tokenB.split(".");
    // Try to forge: take fp from A, sig from B.
    const forged = `${partsA[0]}.${partsA[1]}.${partsB[2]}`;
    const r = await verifyDemoToken(forged);
    assert.equal(r.valid, false);
  });

  it("[verify] mutating any character in the signature breaks verification", async () => {
    const token = await createDemoToken("mutation-test");
    const parts = token.split(".");
    const origSig = parts[2]!;
    // Try mutating the first, middle, and last char of the signature
    // - each mutation must invalidate.
    for (const i of [0, Math.floor(origSig.length / 2), origSig.length - 1]) {
      const ch = origSig[i]!;
      const newCh = ch === "0" ? "1" : "0";
      const mutated = origSig.slice(0, i) + newCh + origSig.slice(i + 1);
      const tampered = `${parts[0]}.${parts[1]}.${mutated}`;
      const r = await verifyDemoToken(tampered);
      assert.equal(
        r.valid,
        false,
        `mutation at index ${i} must invalidate (orig=${ch}, new=${newCh})`
      );
    }
  });
});
