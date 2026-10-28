/**
 * Demo-session secret derivation — MONEY-590 (SEC-2), de-shadowed under
 * MONEY-620.
 *
 * Exercises the REAL exported `deriveDemoSecret()` from lib/demo/session.ts —
 * NOT an inline mirror. `getDemoSecret()` (the cached production resolver)
 * calls this same function with `process.env`, so prod and test run identical
 * derivation code. The invariant under test: the demo HMAC secret is NEVER the
 * raw ENCRYPTION_KEY — it is either an explicit DEMO_SESSION_SECRET or a
 * one-way, domain-separated HMAC derivation of it.
 *
 * Pure: `deriveDemoSecret` takes the env object as an argument, so these tests
 * never read or mutate `process.env`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveDemoSecret } from "@/lib/demo/session";

describe("deriveDemoSecret (MONEY-590 SEC-2 — real export)", () => {
  const ROOT = "0123456789abcdef0123456789abcdef"; // stand-in ENCRYPTION_KEY

  it("uses an explicit DEMO_SESSION_SECRET verbatim", async () => {
    const s = await deriveDemoSecret({
      DEMO_SESSION_SECRET: "explicit-demo-secret",
      ENCRYPTION_KEY: ROOT,
    });
    assert.equal(s, "explicit-demo-secret");
  });

  it("INVARIANT: derived secret is NEVER the raw ENCRYPTION_KEY", async () => {
    const s = await deriveDemoSecret({ ENCRYPTION_KEY: ROOT });
    assert.notEqual(s, ROOT, "demo secret must not equal the encryption key");
  });

  it("derivation is deterministic (same root -> same secret), HMAC-SHA256 hex", async () => {
    const a = await deriveDemoSecret({ ENCRYPTION_KEY: ROOT });
    const b = await deriveDemoSecret({ ENCRYPTION_KEY: ROOT });
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/, "HMAC-SHA256 → 64 lowercase-hex chars");
  });

  it("different root key -> different derived secret (avalanche)", async () => {
    const a = await deriveDemoSecret({ ENCRYPTION_KEY: ROOT });
    const b = await deriveDemoSecret({ ENCRYPTION_KEY: ROOT + "x" });
    assert.notEqual(a, b);
  });

  it("explicit secret takes precedence over derivation", async () => {
    const explicit = await deriveDemoSecret({
      DEMO_SESSION_SECRET: "x",
      ENCRYPTION_KEY: ROOT,
    });
    const derived = await deriveDemoSecret({ ENCRYPTION_KEY: ROOT });
    assert.notEqual(explicit, derived);
  });

  it("throws when neither secret is configured", async () => {
    await assert.rejects(
      () => deriveDemoSecret({}),
      /Neither DEMO_SESSION_SECRET/
    );
  });

  // ── Negative / edge (MONEY-620) ──────────────────────────────

  it("empty-string DEMO_SESSION_SECRET is treated as unset → falls back to derivation", async () => {
    // "" is falsy, so the explicit branch is skipped and we derive from root.
    const s = await deriveDemoSecret({
      DEMO_SESSION_SECRET: "",
      ENCRYPTION_KEY: ROOT,
    });
    assert.match(s, /^[0-9a-f]{64}$/);
    assert.notEqual(s, ROOT);
  });

  it("empty-string ENCRYPTION_KEY with no explicit secret → throws", async () => {
    await assert.rejects(
      () => deriveDemoSecret({ DEMO_SESSION_SECRET: "", ENCRYPTION_KEY: "" }),
      /Neither DEMO_SESSION_SECRET/
    );
  });

  it("unicode root key derives a clean hex secret (no encoding crash)", async () => {
    const s = await deriveDemoSecret({ ENCRYPTION_KEY: "🔐-clé-密钥-" });
    assert.match(s, /^[0-9a-f]{64}$/);
  });

  it("a one-char difference in the root avalanches the whole derived secret", async () => {
    const a = await deriveDemoSecret({ ENCRYPTION_KEY: "a".repeat(32) });
    const b = await deriveDemoSecret({ ENCRYPTION_KEY: "a".repeat(31) + "b" });
    assert.notEqual(a, b);
    // HMAC avalanche: the two 64-hex outputs should differ in many positions.
    let diff = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
    assert.ok(diff > 8, `expected strong avalanche, only ${diff} chars differ`);
  });
});
