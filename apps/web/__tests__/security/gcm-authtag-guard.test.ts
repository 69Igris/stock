/**
 * AES-256-GCM truncated-auth-tag guard — MONEY-592 (security audit).
 *
 * De-shadowed (MONEY-620): previously this file inlined a mirror of the guarded
 * decrypt path. It now exercises the REAL `SecureEncryption` from
 * `@usemoney/security/encryption` (constructed with a test key, no env
 * needed) so the 16-byte auth-tag invariant is verified on production code, not
 * a copy. Node's GCM otherwise accepts truncated tags (down to 4 bytes),
 * collapsing forgery resistance from 2^-128 toward ~2^-32.
 *
 * Note: the real `decrypt` wraps any inner failure (including the
 * "Invalid auth tag length" guard) as "Failed to decrypt data", so the
 * assertions match that user-facing message — a truncated/empty/tampered tag
 * must throw; a full 16-byte tag must round-trip.
 *
 * Source: @usemoney/security/encryption (SecureEncryption)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";

import { SecureEncryption } from "@usemoney/security/encryption";

// 64-hex test key → exercises the `key.length === 64` Buffer.from(hex) branch.
const TEST_KEY = crypto.randomBytes(32).toString("hex");
const enc = new SecureEncryption(TEST_KEY);

describe("AES-GCM truncated-auth-tag guard (MONEY-592)", () => {
  it("round-trips with a full 16-byte tag", () => {
    const { encrypted, iv, authTag } = enc.encrypt({ token: "secret" });
    assert.equal(Buffer.from(authTag, "hex").length, 16);
    assert.deepEqual(enc.decrypt(encrypted, iv, authTag), {
      token: "secret",
    });
  });

  it("REJECTS a truncated tag (4 bytes) before it reaches GCM", () => {
    const { encrypted, iv, authTag } = enc.encrypt({ token: "secret" });
    const truncated = authTag.slice(0, 8); // 4 bytes
    assert.equal(Buffer.from(truncated, "hex").length, 4);
    assert.throws(
      () => enc.decrypt(encrypted, iv, truncated),
      /failed to decrypt/i
    );
  });

  it("rejects an 8-byte tag", () => {
    const { encrypted, iv, authTag } = enc.encrypt({ token: "secret" });
    assert.throws(
      () => enc.decrypt(encrypted, iv, authTag.slice(0, 16)),
      /failed to decrypt/i
    );
  });

  it("rejects an empty tag", () => {
    const { encrypted, iv } = enc.encrypt({ token: "secret" });
    assert.throws(() => enc.decrypt(encrypted, iv, ""), /failed to decrypt/i);
  });

  it("still rejects a tampered FULL-length tag (GCM integrity intact)", () => {
    const { encrypted, iv, authTag } = enc.encrypt({ token: "secret" });
    const flipped =
      authTag.slice(0, -2) + (authTag.slice(-2) === "00" ? "01" : "00");
    // 16 bytes, passes the length guard, but fails GCM verification.
    assert.equal(Buffer.from(flipped, "hex").length, 16);
    assert.throws(() => enc.decrypt(encrypted, iv, flipped));
  });

  it("a 16-byte tag with a tampered ciphertext also fails GCM", () => {
    const { encrypted, iv, authTag } = enc.encrypt({ token: "secret" });
    // Flip the last hex nibble of the ciphertext — auth tag is valid length but
    // no longer authenticates the modified ciphertext.
    const tampered =
      encrypted.slice(0, -1) + (encrypted.slice(-1) === "0" ? "1" : "0");
    assert.throws(() => enc.decrypt(tampered, iv, authTag));
  });
});
