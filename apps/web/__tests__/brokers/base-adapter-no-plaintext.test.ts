/**
 * Broker credential read — no-plaintext-fallback contract (MONEY-589 SEC-1).
 *
 * base-adapter.ts getCredentials() pulls prisma + encryption, so it can't be
 * imported under node --test. Inline-copy the decision: an encrypted row is
 * decrypted; a row with ONLY legacy plaintext fields (no encryptedCreds) must
 * return null — the plaintext fallback was removed because it falsified the
 * "all broker credentials encrypted at rest" commitment.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

interface Conn {
  encryptedCreds?: string | null;
  iv?: string | null;
  authTag?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
  apiKey?: string | null;
  apiSecret?: string | null;
}

// Mirror of getCredentials() AFTER the SEC-1 fix. `decrypt` is injected.
function readCredentials(
  conn: Conn | null,
  decrypt: (c: string, iv: string, tag: string) => unknown
): unknown {
  if (!conn) return null;
  if (conn.encryptedCreds && conn.iv && conn.authTag) {
    try {
      return decrypt(conn.encryptedCreds, conn.iv, conn.authTag);
    } catch {
      return null;
    }
  }
  // MONEY-589: legacy plaintext fields are NEVER returned.
  return null;
}

const decryptOk = () => ({ accessToken: "decrypted-token" });
const decryptThrow = () => {
  throw new Error("bad key");
};

describe("getCredentials no-plaintext-fallback (MONEY-589 SEC-1)", () => {
  it("decrypts an encrypted row", () => {
    const c = { encryptedCreds: "ct", iv: "iv", authTag: "tag" };
    assert.deepEqual(readCredentials(c, decryptOk), {
      accessToken: "decrypted-token",
    });
  });

  it("INVARIANT: legacy plaintext-only row returns null (never the token)", () => {
    const c = {
      accessToken: "PLAINTEXT-SECRET",
      apiKey: "PLAINTEXT-KEY",
      apiSecret: "PLAINTEXT-SECRET-2",
    };
    assert.equal(readCredentials(c, decryptOk), null);
  });

  it("never leaks any legacy field", () => {
    const c = { refreshToken: "PLAINTEXT-REFRESH" };
    const out = readCredentials(c, decryptOk);
    assert.equal(out, null);
    assert.ok(
      !JSON.stringify(out ?? "").includes("PLAINTEXT"),
      "no plaintext credential in the result"
    );
  });

  it("returns null on decrypt failure (no plaintext fallback after)", () => {
    const c = {
      encryptedCreds: "ct",
      iv: "iv",
      authTag: "tag",
      accessToken: "PLAINTEXT-FALLBACK",
    };
    assert.equal(readCredentials(c, decryptThrow), null);
  });

  it("returns null for a missing connection", () => {
    assert.equal(readCredentials(null, decryptOk), null);
  });
});
