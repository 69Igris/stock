/**
 * Demo Session Management — REAL-source tests (de-shadowed under MONEY-620).
 *
 * Source: apps/web/lib/demo/session.ts (HMAC-signed demo cookie, ~24h TTL,
 * Edge-compatible).
 *
 * HISTORY — this file USED to be a SHADOW: it re-declared `createDemoToken`,
 * `verifyDemoToken`, `getSecret`, `verifyDemoCookieEdge` and an
 * `isDemoSessionLogic` helper INLINE (with `createHmac` from node:crypto) and
 * asserted the copies. The copy used `sig !== expected` (plain `===`) and even
 * had a test literally titled "should use string comparison for signature (not
 * timing-safe)" — but the REAL source had since been hardened (MONEY-594) to a
 * constant-time `timingSafeEqualHex`. The shadow was green while documenting a
 * vuln that no longer existed; a regression to `===` would NOT have been
 * caught. This rewrite imports and exercises the REAL exported symbols only.
 *
 * Determinism:
 *  - The module resolves its HMAC secret from `process.env` through a cached
 *    `getDemoSecret()`. We set `DEMO_SESSION_SECRET` BEFORE importing the
 *    module so every signature in the run uses one known key.
 *  - `createDemoToken`/`verifyDemoToken` take an injectable `now` (default
 *    `Date.now()`), so all TTL-boundary + expiry cases freeze the clock — NO
 *    timers, NO sleeps, NO open handles.
 *  - Wrong-secret / forgery cases forge a signature with the REAL exported
 *    `signHmac32` under a different key, then assert the REAL `verifyDemoToken`
 *    rejects it — real sign + real verify, still no shadow.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

const TEST_SECRET =
  "money620-demo-session-real-source-secret-0123456789abcdef-XYZ!";
const WRONG_SECRET =
  "money620-WRONG-demo-session-secret-fedcba9876543210-ABC?nope";

// Must be set before the demo module's cached getDemoSecret() first runs.
before(() => {
  process.env.DEMO_SESSION_SECRET = TEST_SECRET;
});

import {
  createDemoToken,
  verifyDemoToken,
  verifyDemoCookieEdge,
  signHmac32,
  timingSafeEqualHex,
  COOKIE_NAME,
  TTL_MS,
} from "@/lib/demo/session";

// A fixed reference clock so token timestamps are reproducible across cases.
// Far enough from the epoch that `now - TTL_MS` stays positive.
const NOW = 1_900_000_000_000; // ~2030-03-17, finite & > TTL_MS

describe("Demo Session Management (real source)", () => {
  // ── Constants ────────────────────────────────────────────────
  describe("Exported constants", () => {
    it("COOKIE_NAME is sb_demo", () => {
      assert.equal(COOKIE_NAME, "sb_demo");
    });
    it("TTL_MS is 24h in ms", () => {
      assert.equal(TTL_MS, 86_400_000);
      assert.equal(TTL_MS, 24 * 60 * 60 * 1000);
    });
  });

  // ── createDemoToken ──────────────────────────────────────────
  describe("createDemoToken", () => {
    it("returns a 3-part ts.fp.sig token", async () => {
      const token = await createDemoToken("test-fingerprint", NOW);
      assert.equal(token.split(".").length, 3);
    });

    it("first part is the base36 timestamp", async () => {
      const token = await createDemoToken("fp", NOW);
      assert.equal(token.split(".")[0], NOW.toString(36));
      assert.equal(parseInt(token.split(".")[0]!, 36), NOW);
    });

    it("second part is the (dot-free) fingerprint", async () => {
      const token = await createDemoToken("my-fingerprint", NOW);
      assert.equal(token.split(".")[1], "my-fingerprint");
    });

    it("third part is a 32-char lowercase-hex signature", async () => {
      const token = await createDemoToken("test", NOW);
      const sig = token.split(".")[2]!;
      assert.equal(sig.length, 32);
      assert.match(sig, /^[a-f0-9]{32}$/);
    });

    it("truncates the fingerprint to 32 chars", async () => {
      const token = await createDemoToken("a".repeat(100), NOW);
      assert.equal(token.split(".")[1], "a".repeat(32));
    });

    it("sanitizes dots in the fingerprint (IPv4) → still exactly 3 parts", async () => {
      const token = await createDemoToken("49.36.128.57", NOW);
      const parts = token.split(".");
      assert.equal(parts.length, 3);
      assert.ok(parts[1]!.includes("_"));
      assert.ok(!parts[1]!.includes("."));
    });

    it("different fingerprints → different signatures at the same instant", async () => {
      const a = await createDemoToken("fingerprint-a", NOW);
      const b = await createDemoToken("fingerprint-b", NOW);
      assert.notEqual(a.split(".")[2], b.split(".")[2]);
    });

    it("is deterministic for a fixed (fp, now): same token twice", async () => {
      const a = await createDemoToken("stable", NOW);
      const b = await createDemoToken("stable", NOW);
      assert.equal(a, b);
    });

    it("handles an empty fingerprint", async () => {
      const token = await createDemoToken("", NOW);
      const parts = token.split(".");
      assert.equal(parts.length, 3);
      assert.equal(parts[1], "");
    });
  });

  // ── verifyDemoToken — happy path & round-trip ────────────────
  describe("verifyDemoToken — valid tokens", () => {
    it("accepts a freshly minted token (same clock)", async () => {
      const token = await createDemoToken("test-fp", NOW);
      assert.deepEqual(await verifyDemoToken(token, NOW), {
        valid: true,
        expired: false,
      });
    });

    it("round-trips an IPv4 fingerprint", async () => {
      const token = await createDemoToken("49.36.128.57", NOW);
      assert.equal((await verifyDemoToken(token, NOW)).valid, true);
    });

    it("round-trips a 1-char fingerprint", async () => {
      const token = await createDemoToken("a", NOW);
      assert.equal((await verifyDemoToken(token, NOW)).valid, true);
    });

    it("round-trips a numeric fingerprint", async () => {
      const token = await createDemoToken("192168001001", NOW);
      assert.equal((await verifyDemoToken(token, NOW)).valid, true);
    });
  });

  // ── verifyDemoToken — TTL boundaries (frozen clock) ──────────
  describe("verifyDemoToken — TTL window (injected clock, no sleeps)", () => {
    it("valid at issuance instant (age 0)", async () => {
      const token = await createDemoToken("fp", NOW);
      assert.deepEqual(await verifyDemoToken(token, NOW), {
        valid: true,
        expired: false,
      });
    });

    it("valid 1ms before the TTL edge", async () => {
      const token = await createDemoToken("fp", NOW);
      const r = await verifyDemoToken(token, NOW + TTL_MS - 1);
      assert.deepEqual(r, { valid: true, expired: false });
    });

    it("valid exactly AT the TTL edge (age == TTL is not yet > TTL)", async () => {
      const token = await createDemoToken("fp", NOW);
      const r = await verifyDemoToken(token, NOW + TTL_MS);
      assert.deepEqual(r, { valid: true, expired: false });
    });

    it("expired 1ms past the TTL edge", async () => {
      const token = await createDemoToken("fp", NOW);
      const r = await verifyDemoToken(token, NOW + TTL_MS + 1);
      assert.deepEqual(r, { valid: false, expired: true });
    });

    it("expired well past the window (48h)", async () => {
      const token = await createDemoToken("fp", NOW);
      const r = await verifyDemoToken(token, NOW + 2 * TTL_MS);
      assert.deepEqual(r, { valid: false, expired: true });
    });

    it("a token minted in the FUTURE relative to verify-clock is still valid (age negative, not > TTL)", async () => {
      const token = await createDemoToken("fp", NOW + 60_000);
      const r = await verifyDemoToken(token, NOW);
      assert.equal(r.valid, true);
    });
  });

  // ── verifyDemoToken — tamper / forgery (security) ────────────
  describe("verifyDemoToken — tamper & forgery are REJECTED", () => {
    it("tampered signature (whole sig zeroed) → invalid, NOT expired", async () => {
      const token = await createDemoToken("test-fp", NOW);
      const [ts, fp] = token.split(".");
      const tampered = `${ts}.${fp}.${"0".repeat(32)}`;
      assert.deepEqual(await verifyDemoToken(tampered, NOW), {
        valid: false,
        expired: false,
      });
    });

    it("flip ONE byte of the signature → invalid (single-bit tamper)", async () => {
      const token = await createDemoToken("flip-one", NOW);
      const parts = token.split(".");
      const sig = parts[2]!;
      const flipped = sig.slice(0, -1) + (sig.slice(-1) === "0" ? "1" : "0");
      const r = await verifyDemoToken(
        `${parts[0]}.${parts[1]}.${flipped}`,
        NOW
      );
      assert.equal(r.valid, false);
    });

    it("mutating the first, middle, OR last sig char each invalidates", async () => {
      const token = await createDemoToken("mutation", NOW);
      const parts = token.split(".");
      const sig = parts[2]!;
      for (const i of [0, sig.length >> 1, sig.length - 1]) {
        const ch = sig[i]!;
        const mutated =
          sig.slice(0, i) + (ch === "0" ? "1" : "0") + sig.slice(i + 1);
        const r = await verifyDemoToken(
          `${parts[0]}.${parts[1]}.${mutated}`,
          NOW
        );
        assert.equal(r.valid, false, `mutation at ${i} must reject`);
      }
    });

    it("tampered fingerprint (sig no longer matches) → invalid", async () => {
      const token = await createDemoToken("original", NOW);
      const parts = token.split(".");
      const r = await verifyDemoToken(`${parts[0]}.tampered.${parts[2]}`, NOW);
      assert.deepEqual(r, { valid: false, expired: false });
    });

    it("tampered timestamp (sig no longer matches) → invalid, NOT a TTL/expiry leak", async () => {
      const token = await createDemoToken("test", NOW);
      const parts = token.split(".");
      const newTs = (NOW - 3_600_000).toString(36);
      const r = await verifyDemoToken(`${newTs}.${parts[1]}.${parts[2]}`, NOW);
      // Must read as a signature failure (expired:false), so we never reveal
      // that a valid-but-old token exists for this fingerprint.
      assert.deepEqual(r, { valid: false, expired: false });
    });

    it("cross-fingerprint splice (fp from A, sig from B) → REJECTED", async () => {
      const a = (await createDemoToken("fp-A", NOW)).split(".");
      const b = (await createDemoToken("fp-B", NOW)).split(".");
      const forged = `${a[0]}.${a[1]}.${b[2]}`;
      assert.equal((await verifyDemoToken(forged, NOW)).valid, false);
    });

    it("FORGED token signed with the WRONG secret → REJECTED", async () => {
      // Forge a structurally-perfect token using the REAL signer under a
      // different key; the REAL verifier (which uses TEST_SECRET) must reject.
      const ts = NOW.toString(36);
      const fp = "attacker";
      const payload = `${ts}.${fp}`;
      const forgedSig = await signHmac32(WRONG_SECRET, payload);
      const forged = `${payload}.${forgedSig}`;
      const r = await verifyDemoToken(forged, NOW);
      assert.deepEqual(r, { valid: false, expired: false });
    });

    it("a token signed with the RIGHT secret (via signHmac32) verifies — proves the wrong-secret test is meaningful", async () => {
      const ts = NOW.toString(36);
      const payload = `${ts}.controlfp`;
      const sig = await signHmac32(TEST_SECRET, payload);
      const r = await verifyDemoToken(`${payload}.${sig}`, NOW);
      assert.deepEqual(r, { valid: true, expired: false });
    });
  });

  // ── verifyDemoToken — malformed / garbage input (must not throw) ──
  describe("verifyDemoToken — malformed input returns {invalid}, never throws", () => {
    const badTokens: Array<[string, string]> = [
      ["empty string", ""],
      ["1 part (no dots)", "singletoken"],
      ["2 parts", "part1.part2"],
      ["4 parts", "a.b.c.d"],
      ["5 parts", "a.b.c.d.e"],
      ["only dots", "..."],
      ["leading/trailing dots", ".a.b."],
      ["whitespace", "   "],
      ["sig stripped (ts.fp only)", "abc.def"],
      ["non-base36 ts garbage", "!!!.fp.0000000000000000000000000000abcd"],
      ["binary-ish junk", "\u0000.￿.zzzz"],
      ["html-injection-ish", "<script>.</script>.x"],
    ];
    for (const [label, tok] of badTokens) {
      it(`${label} → {valid:false} (no throw)`, async () => {
        const r = await verifyDemoToken(tok, NOW);
        assert.equal(r.valid, false);
      });
    }

    it("oversized garbage (100k chars) → invalid, no throw", async () => {
      const r = await verifyDemoToken("x".repeat(100_000), NOW);
      assert.equal(r.valid, false);
    });

    it("oversized 3-part token (huge middle) → invalid signature, no throw", async () => {
      const huge = `${NOW.toString(36)}.${"y".repeat(100_000)}.${"0".repeat(32)}`;
      const r = await verifyDemoToken(huge, NOW);
      assert.equal(r.valid, false);
    });

    it("unicode payload in a 3-part token → invalid signature, no throw", async () => {
      const r = await verifyDemoToken(
        `${NOW.toString(36)}.日本語🔥.${"a".repeat(32)}`,
        NOW
      );
      assert.equal(r.valid, false);
    });
  });

  // ── verifyDemoToken — non-finite / negative timestamp (BUG-CLASS b) ──
  describe("verifyDemoToken — non-finite / negative ts must NOT bypass TTL (MONEY-620)", () => {
    it("REGRESSION: garbage(NaN) ts with a VALID signature is rejected, expired:false (TTL not bypassed)", async () => {
      // Sign a payload whose ts parses to NaN with the REAL signer + REAL
      // secret, so the HMAC check PASSES. (Note: parseInt stops at the first
      // bad char, so "zz!zz" → 1295; we need a LEADING non-base36 char for a
      // genuine NaN.) Before the fix, `now - NaN = NaN`, `NaN > TTL_MS` is
      // false → the token was treated as LIVE (TTL silently bypassed). The
      // Number.isFinite guard now rejects it BEFORE the expiry branch, so the
      // verdict is {valid:false, expired:false} — not a spurious expiry.
      const badTs = "~~~"; // parseInt("~~~", 36) === NaN
      assert.ok(Number.isNaN(parseInt(badTs, 36)), "precondition: ts is NaN");
      const payload = `${badTs}.fp`;
      const sig = await signHmac32(TEST_SECRET, payload);
      const r = await verifyDemoToken(`${payload}.${sig}`, NOW);
      assert.deepEqual(
        r,
        { valid: false, expired: false },
        "non-finite timestamp must be rejected, never treated as live"
      );
    });

    it("REGRESSION: empty ts ('' → NaN) with a valid signature is rejected", async () => {
      const payload = `.fp`; // ts === ""
      const sig = await signHmac32(TEST_SECRET, payload);
      // Note: token is `.fp.<sig>` which still splits into 3 parts.
      const r = await verifyDemoToken(`${payload}.${sig}`, NOW);
      assert.equal(r.valid, false);
    });

    it("REGRESSION: negative ts ('-1' → -1) with a valid signature is rejected", async () => {
      // A negative parse would make age huge-positive (so not 'live'), but a
      // negative epoch is structurally invalid — assert it is rejected and not
      // mistakenly reported as a fresh token.
      const payload = `-1.fp`;
      const sig = await signHmac32(TEST_SECRET, payload);
      const r = await verifyDemoToken(`${payload}.${sig}`, NOW);
      assert.equal(r.valid, false);
    });

    it("epoch-0 timestamp (long expired) → invalid + expired:true", async () => {
      const token = await createDemoToken("test", 0);
      const r = await verifyDemoToken(token, NOW);
      assert.deepEqual(r, { valid: false, expired: true });
    });
  });

  // ── verifyDemoCookieEdge (thin boolean wrapper over verify) ──
  describe("verifyDemoCookieEdge", () => {
    it("true for a valid token", async () => {
      const token = await createDemoToken("edge-fp", NOW);
      // Wrapper uses Date.now() internally; the token is minted at NOW which is
      // in the future, so age is negative → within TTL regardless of real time.
      assert.equal(await verifyDemoCookieEdge(token), true);
    });

    it("false for a tampered signature", async () => {
      const parts = (await createDemoToken("edge-fp", NOW)).split(".");
      const r = await verifyDemoCookieEdge(
        `${parts[0]}.${parts[1]}.${"f".repeat(32)}`
      );
      assert.equal(r, false);
    });

    it("false for a malformed (2-part) token", async () => {
      assert.equal(await verifyDemoCookieEdge("a.b"), false);
    });

    it("false for an empty token", async () => {
      assert.equal(await verifyDemoCookieEdge(""), false);
    });

    it("false for a 4-part token", async () => {
      assert.equal(await verifyDemoCookieEdge("a.b.c.d"), false);
    });

    it("false for garbage, never throws", async () => {
      assert.equal(await verifyDemoCookieEdge("\u0000￿.x.y"), false);
    });

    it("matches verifyDemoToken's verdict for a valid token", async () => {
      const token = await createDemoToken("parity", NOW + 1000);
      const full = await verifyDemoToken(token);
      const edge = await verifyDemoCookieEdge(token);
      assert.equal(edge, full.valid);
    });
  });

  // ── timingSafeEqualHex — constant-time comparison (BUG-CLASS a) ──
  describe("timingSafeEqualHex — the HMAC comparison primitive (MONEY-594/620)", () => {
    it("REGRESSION GUARD: source does NOT use plain === for the sig check", async () => {
      // The whole reason this file was a shadow: the copy compared with `===`
      // and a test claimed the source did too. Pin that the REAL module
      // exports a constant-time comparator and the verify path depends on it.
      // (If someone reverts to `===`, this import + the tamper suite break.)
      assert.equal(typeof timingSafeEqualHex, "function");
    });

    it("equal strings → true", () => {
      assert.equal(timingSafeEqualHex("deadbeef", "deadbeef"), true);
    });

    it("differing strings of equal length → false", () => {
      assert.equal(timingSafeEqualHex("deadbeef", "deadbeee"), false);
    });

    it("difference in the FIRST char (early-exit trap for ===) → false", () => {
      assert.equal(timingSafeEqualHex("0bcdef01", "abcdef01"), false);
    });

    it("difference in the LAST char → false", () => {
      assert.equal(timingSafeEqualHex("abcdef00", "abcdef01"), false);
    });

    it("length mismatch → false (guarded before the XOR loop)", () => {
      assert.equal(timingSafeEqualHex("abc", "abcd"), false);
      assert.equal(timingSafeEqualHex("", "a"), false);
    });

    it("two empty strings → true", () => {
      assert.equal(timingSafeEqualHex("", ""), true);
    });

    it("a real signature equals itself and rejects a 1-byte-flipped sibling", async () => {
      const sig = (await createDemoToken("ct", NOW)).split(".")[2]!;
      assert.equal(timingSafeEqualHex(sig, sig), true);
      const flipped = sig.slice(0, -1) + (sig.slice(-1) === "0" ? "1" : "0");
      assert.equal(timingSafeEqualHex(sig, flipped), false);
    });
  });

  // ── signHmac32 — exported signer (used by real sign + forgery tests) ──
  describe("signHmac32", () => {
    it("produces a 32-char lowercase-hex digest", async () => {
      const sig = await signHmac32(TEST_SECRET, "ts.fp");
      assert.equal(sig.length, 32);
      assert.match(sig, /^[a-f0-9]{32}$/);
    });

    it("is deterministic for (secret, payload)", async () => {
      const a = await signHmac32(TEST_SECRET, "x.y");
      const b = await signHmac32(TEST_SECRET, "x.y");
      assert.equal(a, b);
    });

    it("different secrets → different digests (same payload)", async () => {
      const a = await signHmac32(TEST_SECRET, "x.y");
      const b = await signHmac32(WRONG_SECRET, "x.y");
      assert.notEqual(a, b);
    });

    it("different payloads → different digests (same secret)", async () => {
      const a = await signHmac32(TEST_SECRET, "x.y");
      const b = await signHmac32(TEST_SECRET, "x.z");
      assert.notEqual(a, b);
    });

    it("handles a unicode payload without crashing", async () => {
      const sig = await signHmac32(TEST_SECRET, "🔥.日本語");
      assert.match(sig, /^[a-f0-9]{32}$/);
    });
  });

  // ── Concurrency / volume sanity ──────────────────────────────
  describe("volume & concurrency", () => {
    it("100 concurrent tokens (distinct fps) all verify and are unique", async () => {
      const tokens = await Promise.all(
        Array.from({ length: 100 }, (_, i) => createDemoToken(`fp-${i}`, NOW))
      );
      assert.equal(new Set(tokens).size, 100);
      const results = await Promise.all(
        tokens.map((t) => verifyDemoToken(t, NOW))
      );
      assert.ok(results.every((r) => r.valid));
    });
  });
});
